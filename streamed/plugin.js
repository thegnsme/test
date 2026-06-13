(function () {
	/**
	 * SkyStream Plugin for Streamed.pk
	 * Live sports streaming — football, basketball, tennis, cricket, MMA, and more.
	 *
	 * Architecture:
	 *   - Dynamic category discovery via /api/sports
	 *   - Each sport's popular matches loaded on home
	 *   - Real-time domain resolution from strmd.link with fallback
	 *   - Embed URLs resolved via loadExtractor() for playable streams
	 *
	 * @see https://streamed.pk/docs
	 * @see https://strmd.link
	 */

	"use strict";

	// ---------------------------------------------------------------------------
	// Constants
	// ---------------------------------------------------------------------------

	/** Hardcoded fallback mirror domains (lowest priority). */
	const FALLBACK_DOMAINS = [
		"https://streami.su",
		"https://streamed.pk",
		"https://streamed.st",
	];

	/** URL that lists available Streamed mirrors in real time. */
	const STRMD_LINK_URL = "https://strmd.link/";

	/** How long (ms) to keep the domain list fresh. */
	const DOMAIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	/** Maximum matches per category in getHome. */
	const MAX_MATCHES_PER_CATEGORY = 35;

	/** Default headers for API requests. */
	const REQ_HEADERS = {
		Accept: "application/json, text/plain, */*",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
	};

	/** Headers used for poster/image requests. */
	const POSTER_HEADERS = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
		Accept: "image/webp,image/*,*/*;q=0.8",
	};

	// ---------------------------------------------------------------------------
	// Module state
	// ---------------------------------------------------------------------------

	/** Resolved base URL for the current session. */
	let _activeBaseUrl = null;

	/** Timestamp of the last domain fetch. */
	let _domainLastFetch = 0;

	/** Cached domain list from strmd.link. */
	let _cachedDomains = null;

	/** Cached sports list (id → name) refreshed per getHome call. */
	let _cachedSports = null;

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/**
	 * Safely trim a value to a non-empty string, or return fallback.
	 * @param {*} value
	 * @param {string} fallback
	 * @returns {string}
	 */
	function str(value, fallback) {
		const s = String(value || "").trim();
		return s || fallback || "";
	}

	/**
	 * Safely parse JSON, returning null on failure.
	 * @param {string} text
	 * @returns {object|array|null}
	 */
	function tryParse(text) {
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (_) {
			return null;
		}
	}

	/**
	 * Normalize a URL by trimming trailing slash.
	 * Returns null if the URL is not valid HTTP(S).
	 * @param {string} url
	 * @returns {string|null}
	 */
	function normalizeUrl(url) {
		const s = str(url);
		if (!s || !/^https?:\/\//i.test(s)) return null;
		return s.replace(/\/+$/, "");
	}

	/**
	 * Construct a poster URL from match data.
	 * Priority: match.poster proxy → team badges composite → empty.
	 * @param {object} match
	 * @param {string} baseUrl
	 * @returns {string}
	 */
	function buildPosterUrl(match, baseUrl) {
		if (!match) return "";

		// If the match has a poster proxy path, use it.
		const poster = str(match.poster);
		if (poster) {
			if (poster.startsWith("http")) return poster;
			return baseUrl + poster;
		}

		// Fall back to the home team badge if available.
		const homeBadge =
			match.teams && match.teams.home && str(match.teams.home.badge);
		if (homeBadge) {
			return (
				baseUrl + "/api/images/badge/" + encodeURIComponent(homeBadge) + ".webp"
			);
		}

		return "";
	}

	/**
	 * Format a match title for display.
	 * @param {object} match
	 * @returns {string}
	 */
	function formatTitle(match) {
		if (!match) return "Live Event";
		return str(match.title) || "Live Event";
	}

	/**
	 * Determine if a date (unix ms) is in the past.
	 * @param {number} date
	 * @returns {boolean}
	 */
	function isExpired(date) {
		return (
			typeof date === "number" && date > 1000000000000 && date < Date.now()
		);
	}

	/**
	 * Sort matches: live/upcoming first (by date ascending), then ended.
	 * @param {Array} matches
	 * @returns {Array}
	 */
	function sortMatches(matches) {
		if (!Array.isArray(matches)) return [];
		return matches.slice().sort(function (a, b) {
			var aDate = typeof a.date === "number" ? a.date : 0;
			var bDate = typeof b.date === "number" ? b.date : 0;
			var aEnded = aDate > 1000000000000 && aDate < Date.now() ? 1 : 0;
			var bEnded = bDate > 1000000000000 && bDate < Date.now() ? 1 : 0;
			if (aEnded !== bEnded) return aEnded - bEnded;
			return aDate - bDate;
		});
	}

	// ---------------------------------------------------------------------------
	// Domain resolution
	// ---------------------------------------------------------------------------

	/**
	 * Fetch available mirror domains from strmd.link.
	 * Parses the simple HTML page that lists mirrors + status.
	 * @returns {Promise<string[]>} List of base URLs (e.g. ["https://streamed.pk", ...])
	 */
	async function fetchDomainsFromStrmd() {
		try {
			var response = await http_get(STRMD_LINK_URL, REQ_HEADERS);
			var body = extractBody(response);
			if (!body) return [];

			var domains = [];
			// The page contains lines like "streamed.pk" or "streamed.pk - Online"
			var lines = body.split(/\r?\n/);
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim();
				if (!line) continue;

				// Extract the domain part (before " - " if present)
				var domain = line.split(" - ")[0].trim();
				// Filter to likely streamed domains
				if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+$/i.test(domain)) {
					var url = "https://" + domain;
					if (domains.indexOf(url) === -1) {
						domains.push(url);
					}
				}
			}
			return domains;
		} catch (_) {
			return [];
		}
	}

	/**
	 * Get the active base URL to use for API calls.
	 * Priority:
	 *   1. Cached active URL (fast path for subsequent calls)
	 *   2. manifest.baseUrl (user-configured via plugin domain selector)
	 *   3. strmd.link real-time fetch (no-wait, fire-and-forget update)
	 *   4. Fallback hardcoded domain list
	 * @returns {Promise<string>}
	 */
	async function getBaseUrl() {
		// Fast path: already resolved
		if (_activeBaseUrl) return _activeBaseUrl;

		var candidates = [];

		// Add manifest.baseUrl first
		var fromManifest = normalizeUrl(
			typeof manifest !== "undefined" && manifest.baseUrl,
		);
		if (fromManifest) candidates.push(fromManifest);

		// Add hardcoded fallback domains
		for (var f = 0; f < FALLBACK_DOMAINS.length; f++) {
			var fd = FALLBACK_DOMAINS[f];
			if (candidates.indexOf(fd) === -1) candidates.push(fd);
		}

		// Fire-and-forget strmd.link fetch (will cache for next call)
		var now = Date.now();
		if (!_cachedDomains || now - _domainLastFetch > DOMAIN_CACHE_TTL) {
			fetchDomainsFromStrmd()
				.then(function (domains) {
					if (Array.isArray(domains) && domains.length > 0) {
						_cachedDomains = domains;
						_domainLastFetch = Date.now();
					}
				})
				.catch(function () {});
		}

		// Try each candidate URL — first one that responds wins
		for (var i = 0; i < candidates.length; i++) {
			var url = candidates[i];
			try {
				var testResp = await http_get(url + "/api/sports", {
					Accept: "application/json",
					"User-Agent": REQ_HEADERS["User-Agent"],
				});
				var testBody = extractBody(testResp);
				if (testBody) {
					var parsed =
						typeof testBody === "object" ? testBody : tryParse(testBody);
					if (parsed && (Array.isArray(parsed) || typeof parsed === "object")) {
						_activeBaseUrl = url;
						return url;
					}
				}
			} catch (_) {
				// Try next candidate
			}
		}

		// Absolute fallback — don't probe, just use the first hardcoded domain
		_activeBaseUrl = FALLBACK_DOMAINS[0];
		return _activeBaseUrl;
	}

	// ---------------------------------------------------------------------------
	// API helpers
	// ---------------------------------------------------------------------------

	/**
	 * Extract body text from an HTTP response regardless of runtime format.
	 * @param {*} resp - http_get response
	 * @returns {string}
	 */
	function extractBody(resp) {
		if (!resp) return "";

		// String response
		if (typeof resp === "string") return resp;

		// Response object with body property
		if (typeof resp.body !== "undefined") {
			var b = resp.body;
			// Body might already be an object (auto-parsed JSON)
			if (typeof b === "object" && b !== null) return b;
			return String(b);
		}

		// Response object with text/data property
		if (typeof resp.text !== "undefined") return String(resp.text);
		if (typeof resp.data !== "undefined") {
			var d = resp.data;
			if (typeof d === "object" && d !== null) return d;
			return String(d);
		}

		return "";
	}

	/**
	 * Fetch JSON from the Streamed API.
	 * @param {string} path - URL path (e.g. "/api/sports")
	 * @param {object} [headers] - Optional extra headers
	 * @returns {Promise<object|array|null>}
	 */
	async function apiFetch(path, headers) {
		var baseUrl = await getBaseUrl();
		var url = baseUrl + path;

		try {
			var resp = await http_get(url, headers || REQ_HEADERS);
			var body = extractBody(resp);
			if (!body) return null;
			// If body is already an object/array (runtime auto-parsed JSON), return directly
			if (typeof body === "object") return body;
			return tryParse(body);
		} catch (e) {
			console.error(
				"[Streamed] API fetch failed: " + url + " — " + (e.message || e),
			);
			return null;
		}
	}

	/**
	 * Fetch available sports categories.
	 * @returns {Promise<Array<{id:string, name:string}>>}
	 */
	async function fetchSports() {
		if (_cachedSports) return _cachedSports;

		var data = await apiFetch("/api/sports");
		if (Array.isArray(data) && data.length > 0) {
			_cachedSports = data;
			return data;
		}

		// Fallback: return a minimal sport list based on what the API normally provides
		var fallback = [
			{ id: "football", name: "Football" },
			{ id: "basketball", name: "Basketball" },
			{ id: "tennis", name: "Tennis" },
			{ id: "cricket", name: "Cricket" },
			{ id: "fight", name: "Fight (UFC, Boxing)" },
			{ id: "american-football", name: "American Football" },
			{ id: "hockey", name: "Hockey" },
			{ id: "baseball", name: "Baseball" },
			{ id: "motor-sports", name: "Motor Sports" },
			{ id: "rugby", name: "Rugby" },
			{ id: "golf", name: "Golf" },
			{ id: "billiards", name: "Billiards" },
			{ id: "afl", name: "AFL" },
			{ id: "darts", name: "Darts" },
			{ id: "other", name: "Other" },
		];
		_cachedSports = fallback;
		return fallback;
	}

	/**
	 * Fetch matches for one or more sport categories.
	 * @param {string} sportId - Sport ID (or 'live' or 'all')
	 * @param {boolean} [popularOnly=false] - Only popular matches
	 * @returns {Promise<Array>}
	 */
	async function fetchMatches(sportId, popularOnly) {
		var path = "/api/matches/" + encodeURIComponent(sportId);
		if (popularOnly) path += "/popular";

		var data = await apiFetch(path);
		if (Array.isArray(data)) return data;
		return [];
	}

	/**
	 * Build a JSON-encoded URL payload for a match, embeddable in MultimediaItem.
	 * @param {object} match
	 * @returns {string}
	 */
	function encodeMatchPayload(match) {
		if (!match) return "";

		// Only store what load/loadStreams needs: minimal, serializable
		var payload = {
			kind: "match",
			matchId: str(match.id),
			title: formatTitle(match),
			category: str(match.category),
			poster: str(match.poster),
			date: typeof match.date === "number" ? match.date : 0,
			sources: Array.isArray(match.sources) ? match.sources : [],
			teams: match.teams
				? {
						home: match.teams.home
							? {
									name: str(match.teams.home.name),
									badge: str(match.teams.home.badge),
								}
							: null,
						away: match.teams.away
							? {
									name: str(match.teams.away.name),
									badge: str(match.teams.away.badge),
								}
							: null,
					}
				: null,
		};

		return JSON.stringify(payload);
	}

	/**
	 * Build a MultimediaItem for a match.
	 * @param {object} match
	 * @param {string} baseUrl
	 * @returns {MultimediaItem}
	 */
	function matchToItem(match, baseUrl) {
		var title = formatTitle(match);
		var poster = buildPosterUrl(match, baseUrl);
		var payload = encodeMatchPayload(match);

		return new MultimediaItem({
			title: title,
			url: payload,
			posterUrl: poster,
			type: "livestream",
			description: str(match.category) || "Live Sports",
		});
	}

	// ---------------------------------------------------------------------------
	// getHome
	// ---------------------------------------------------------------------------

	/**
	 * Return categories for the dashboard.
	 *
	 * If `manifest.providerId` is set (sub-provider mode), only that sport
	 * category is shown. Otherwise all dynamic categories from /api/sports
	 * are fetched and displayed.
	 *
	 * Additional reserved section "Trending" is populated with live/popular
	 * matches across all sports for the hero carousel.
	 *
	 * @param {function} cb - Callback: cb({ success, data })
	 */
	async function getHome(cb) {
		try {
			var baseUrl = await getBaseUrl();
			var data = {};

			// Trending: fetch live matches for the carousel
			var liveMatches = await fetchMatches("live");
			if (liveMatches.length > 0) {
				data["Trending"] = sortMatches(liveMatches)
					.slice(0, 20)
					.map(function (m) {
						return matchToItem(m, baseUrl);
					});
			}

			// Determine which sport categories to load
			var sportIds = [];
			var providerId =
				typeof manifest !== "undefined"
					? str(manifest.providerId).toLowerCase()
					: "";

			if (providerId) {
				// Sub-provider mode: only the specific sport
				sportIds.push(providerId);
			} else {
				// Root mode: all sports from /api/sports
				var sports = await fetchSports();
				for (var i = 0; i < sports.length; i++) {
					sportIds.push(sports[i].id);
				}
			}

			// Fetch matches for each sport concurrently (popular first, fallback to all)
			var sportMatches = {};
			var fetchTasks = sportIds.map(function (sid) {
				return (async function () {
					try {
						var matches = await fetchMatches(sid, true);
						if (!Array.isArray(matches) || matches.length === 0) {
							matches = await fetchMatches(sid, false);
						}
						sportMatches[sid] = Array.isArray(matches) ? matches : [];
					} catch (_) {
						sportMatches[sid] = [];
					}
				})();
			});

			// Wait for all sport fetches to complete concurrently
			await Promise.all(fetchTasks);

			// Build category → matches mapping using sport names
			var sportsMap = {};
			if (providerId) {
				sportsMap[providerId] = providerId;
			} else {
				var allSports = await fetchSports();
				for (var k = 0; k < allSports.length; k++) {
					sportsMap[allSports[k].id] = allSports[k].name;
				}
			}

			for (var sid2 in sportMatches) {
				if (!Object.prototype.hasOwnProperty.call(sportMatches, sid2)) continue;
				var matches = sportMatches[sid2];
				if (!Array.isArray(matches) || matches.length === 0) continue;

				var categoryName =
					sportsMap[sid2] || sid2.charAt(0).toUpperCase() + sid2.slice(1);
				var sorted = sortMatches(matches);
				var items = sorted.slice(0, MAX_MATCHES_PER_CATEGORY).map(function (m) {
					return matchToItem(m, baseUrl);
				});

				if (items.length > 0) {
					data[categoryName] = items;
				}
			}

			return cb({ success: true, data: data });
		} catch (e) {
			console.error("[Streamed] getHome error: " + (e.message || e));
			return cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: "Failed to load home page: " + (e.message || e),
			});
		}
	}

	// ---------------------------------------------------------------------------
	// search
	// ---------------------------------------------------------------------------

	/**
	 * Search for matches by query string.
	 * Fetches all matches and filters client-side by title / team names.
	 *
	 * @param {string} query
	 * @param {function} cb
	 */
	async function search(query, cb) {
		try {
			var q = str(query).toLowerCase();
			if (!q) {
				return cb({ success: true, data: [] });
			}

			var baseUrl = await getBaseUrl();
			var allMatches = await fetchMatches("all");

			// If /api/matches/all returned nothing, try fetching from each sport
			if (!Array.isArray(allMatches) || allMatches.length === 0) {
				allMatches = [];
				var sports = await fetchSports();
				var searchTasks = sports.map(function (s) {
					return (async function () {
						try {
							var m = await fetchMatches(s.id, false);
							if (Array.isArray(m)) {
								for (var mi = 0; mi < m.length; mi++) {
									allMatches.push(m[mi]);
								}
							}
						} catch (_) {}
					})();
				});
				await Promise.all(searchTasks);
			}

			if (!Array.isArray(allMatches) || allMatches.length === 0) {
				return cb({ success: true, data: [] });
			}

			var results = [];
			for (var i = 0; i < allMatches.length; i++) {
				var m = allMatches[i];
				if (!m) continue;

				var haystack = (
					str(m.title) +
					" " +
					str(m.category) +
					" " +
					(m.teams && m.teams.home ? str(m.teams.home.name) : "") +
					" " +
					(m.teams && m.teams.away ? str(m.teams.away.name) : "")
				).toLowerCase();

				if (haystack.indexOf(q) !== -1) {
					results.push(matchToItem(m, baseUrl));
				}
			}

			return cb({ success: true, data: results });
		} catch (e) {
			console.error("[Streamed] search error: " + (e.message || e));
			return cb({ success: true, data: [] });
		}
	}

	// ---------------------------------------------------------------------------
	// load
	// ---------------------------------------------------------------------------

	/**
	 * Load full details for a specific match.
	 * The `url` parameter is a JSON-encoded payload from the MultimediaItem.
	 *
	 * @param {string} url
	 * @param {function} cb
	 */
	async function load(url, cb) {
		try {
			var payload = tryParse(url);
			if (!payload || payload.kind !== "match") {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid match payload",
				});
			}

			var baseUrl = await getBaseUrl();
			var title = str(payload.title);
			var poster = str(payload.poster);
			var posterUrl = poster
				? poster.startsWith("http")
					? poster
					: baseUrl + poster
				: "";
			var category = str(payload.category);

			// Build a description with time info and team details
			var descriptionLines = [];
			if (payload.teams) {
				if (payload.teams.home && payload.teams.home.name) {
					descriptionLines.push("Home: " + payload.teams.home.name);
				}
				if (payload.teams.away && payload.teams.away.name) {
					descriptionLines.push("Away: " + payload.teams.away.name);
				}
			}
			if (payload.date && payload.date > 1000000000000) {
				try {
					var d = new Date(payload.date);
					descriptionLines.push("Date: " + d.toUTCString());
				} catch (_) {}
			}
			if (Array.isArray(payload.sources) && payload.sources.length > 0) {
				descriptionLines.push("Available Sources: " + payload.sources.length);
			}
			if (category) {
				descriptionLines.unshift("Category: " + category);
			}

			var description = descriptionLines.join("\n") || "Live Sports Event";

			var item = new MultimediaItem({
				title: title,
				url: url,
				posterUrl: posterUrl,
				type: "livestream",
				description: description,
				episodes: [
					new Episode({
						name: "Watch Live",
						season: 1,
						episode: 1,
						url: url,
						posterUrl: posterUrl,
					}),
				],
			});

			return cb({ success: true, data: item });
		} catch (e) {
			console.error("[Streamed] load error: " + (e.message || e));
			return cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: "Failed to load match details: " + (e.message || e),
			});
		}
	}

	// ---------------------------------------------------------------------------
	// loadStreams
	// ---------------------------------------------------------------------------

	/**
	 * Resolve a single embed URL into playable StreamResult objects.
	 *
	 * Strategy (multi-level):
	 *   1. Try loadExtractor() on the embed URL directly
	 *   2. If that fails, scrape the embed page for iframe sources and try each
	 *   3. Fall back to returning the raw embed URL (browser-embeddable)
	 *
	 * @param {object} entry - { embedUrl, language, hd, viewers, source }
	 * @param {string} baseUrl - Active Streamed base URL for Referer
	 * @returns {Promise<Array>} Array of StreamResult objects
	 */
	async function resolveEmbedUrl(entry, baseUrl) {
		if (!entry || !entry.embedUrl) return [];

		var embedUrl = entry.embedUrl;
		var results = [];
		var seenUrls = {};

		/**
		 * Try loadExtractor on a URL and convert results to StreamResults.
		 * @param {string} targetUrl
		 * @param {string} label
		 * @returns {Promise<boolean>} Whether any streams were found
		 */
		async function tryExtractor(targetUrl, label) {
			if (!targetUrl || seenUrls[targetUrl]) return false;
			seenUrls[targetUrl] = true;

			try {
				if (typeof loadExtractor !== "function") return false;

				var extractorResults = await loadExtractor(targetUrl);

				if (Array.isArray(extractorResults) && extractorResults.length > 0) {
					var found = false;
					for (var i = 0; i < extractorResults.length; i++) {
						var er = extractorResults[i];
						if (er && str(er.url)) {
							var streamLabel = label;
							if (entry.hd) streamLabel = "HD " + streamLabel;
							if (entry.language && entry.language !== "Unknown") {
								streamLabel += " [" + entry.language + "]";
							}
							if (entry.viewers > 0) {
								streamLabel += " (" + entry.viewers + " viewers)";
							}

							results.push(
								new StreamResult({
									url: er.url,
									quality: er.quality || streamLabel,
									headers: er.headers || {},
								}),
							);
							found = true;
						}
					}
					return found;
				}
			} catch (_) {
				// Extractor failed
			}
			return false;
		}

		/**
		 * Scrape an HTML page for iframe src URLs.
		 * @param {string} pageUrl
		 * @returns {Promise<string[]>}
		 */
		async function scrapeIframeSources(pageUrl) {
			try {
				var resp = await http_get(pageUrl, {
					Accept: "text/html,application/xhtml+xml,*/*",
					"User-Agent": REQ_HEADERS["User-Agent"],
					Referer: baseUrl + "/",
				});
				var html = extractBody(resp);
				if (!html || typeof html !== "string") return [];

				var found = [];
				// Extract iframe src attributes
				var regex = /<iframe[^>]*src=["']([^"']+)["']/gi;
				var match;
				while ((match = regex.exec(html)) !== null) {
					var src = match[1].trim();
					if (src && found.indexOf(src) === -1) {
						// Resolve relative URLs
						if (src.startsWith("//")) src = "https:" + src;
						else if (src.startsWith("/")) {
							var base = pageUrl.match(/^https?:\/\/[^\/]+/);
							if (base) src = base[0] + src;
						} else if (!src.startsWith("http")) {
							var base2 = pageUrl.match(/^https?:\/\/[^\/]+/);
							if (base2) src = base2[0] + "/" + src;
						}
						found.push(src);
					}
				}
				return found;
			} catch (_) {
				return [];
			}
		}

		// --- Level 1: Try loadExtractor on the embed URL directly ---
		var baseLabel = entry.hd ? "HD" : "SD";
		if (entry.viewers > 0) baseLabel += " (" + entry.viewers + " viewers)";

		var found = await tryExtractor(embedUrl, "Streamed");
		if (found) return results;

		// --- Level 2: Scrape embed page for iframe sources and try each ---
		var iframeSources = await scrapeIframeSources(embedUrl);
		for (var i2 = 0; i2 < iframeSources.length; i2++) {
			found = await tryExtractor(iframeSources[i2], "Embed");
			if (found) return results;
		}

		// --- Level 3: Try deeper iframe chain ---
		for (var i3 = 0; i3 < iframeSources.length && results.length === 0; i3++) {
			var deeperSources = await scrapeIframeSources(iframeSources[i3]);
			for (var i4 = 0; i4 < deeperSources.length; i4++) {
				found = await tryExtractor(deeperSources[i4], "Embed");
				if (found) return results;
			}
		}

		// --- Level 4: Last resort — return the embed URL itself ---
		results.push(
			new StreamResult({
				url: embedUrl,
				quality: baseLabel,
				headers: {
					Referer: baseUrl + "/",
					"User-Agent": REQ_HEADERS["User-Agent"],
				},
			}),
		);

		return results;
	}

	/**
	 * Resolve playable video links for a match.
	 *
	 * Strategy:
	 *   1. Decode the URL payload to get match sources
	 *   2. For each source, fetch /api/stream/{sourceType}/{sourceId}
	 *   3. Collect all stream objects
	 *   4. Sort by viewer count (desc), HD preferred
	 *   5. Use loadExtractor() to resolve embed URLs into playable streams
	 *   6. Multi-level fallback: iframe scraping, chain following
	 *   7. Ultimate fallback: raw embed URL
	 *
	 * @param {string} url
	 * @param {function} cb
	 */
	async function loadStreams(url, cb) {
		try {
			var payload = tryParse(url);
			if (!payload || payload.kind !== "match") {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid stream payload",
				});
			}

			var sources = payload.sources;
			if (!Array.isArray(sources) || sources.length === 0) {
				return cb({
					success: false,
					errorCode: "NO_SOURCES",
					message: "No stream sources available for this match",
				});
			}

			var baseUrl = await getBaseUrl();
			var allStreams = [];

			// --- Phase 1: Collect streams from all sources concurrently ---
			var streamFetchTasks = [];
			for (var i = 0; i < sources.length; i++) {
				var src = sources[i];
				var srcType = str(src.source);
				var srcId = str(src.id);
				if (!srcType || !srcId) continue;

				streamFetchTasks.push(
					(async function (type, id) {
						try {
							var streamPath =
								"/api/stream/" +
								encodeURIComponent(type) +
								"/" +
								encodeURIComponent(id);
							var streamData = await apiFetch(streamPath);

							if (Array.isArray(streamData)) {
								var collected = [];
								for (var j = 0; j < streamData.length; j++) {
									var s = streamData[j];
									if (s && str(s.embedUrl)) {
										collected.push({
											embedUrl: str(s.embedUrl),
											language: str(s.language) || "Unknown",
											hd: s.hd === true,
											viewers: typeof s.viewers === "number" ? s.viewers : 0,
											streamNo: typeof s.streamNo === "number" ? s.streamNo : 0,
											source: type,
										});
									}
								}
								return collected;
							}
						} catch (_) {
							// Source failed
						}
						return [];
					})(srcType, srcId),
				);
			}

			var streamResultsArrays = await Promise.all(streamFetchTasks);
			for (var si = 0; si < streamResultsArrays.length; si++) {
				var arr = streamResultsArrays[si];
				if (Array.isArray(arr)) {
					for (var sj = 0; sj < arr.length; sj++) {
						allStreams.push(arr[sj]);
					}
				}
			}

			if (allStreams.length === 0) {
				return cb({
					success: false,
					errorCode: "NO_STREAMS",
					message: "No playable streams found for this match",
				});
			}

			// --- Phase 2: Sort streams by quality (viewers desc, HD first) ---
			allStreams.sort(function (a, b) {
				// HD streams first
				if (a.hd !== b.hd) return a.hd ? -1 : 1;
				// Then by viewer count descending
				return (b.viewers || 0) - (a.viewers || 0);
			});

			// --- Phase 3: Resolve embed URLs to playable streams ---
			var seenEmbedUrls = {};
			var streamResults = [];

			for (var k = 0; k < allStreams.length; k++) {
				var entry = allStreams[k];

				// Skip duplicate embed URLs
				if (seenEmbedUrls[entry.embedUrl]) continue;
				seenEmbedUrls[entry.embedUrl] = true;

				try {
					var resolved = await resolveEmbedUrl(entry, baseUrl);
					if (Array.isArray(resolved)) {
						for (var r = 0; r < resolved.length; r++) {
							streamResults.push(resolved[r]);
						}
					}
				} catch (_) {
					// Skip failed embed URL
				}

				// Limit to a reasonable number of streams (max 5)
				if (streamResults.length >= 5) break;
			}

			if (streamResults.length === 0) {
				return cb({
					success: false,
					errorCode: "NO_STREAMS",
					message: "Could not resolve any playable streams",
				});
			}

			return cb({ success: true, data: streamResults });
		} catch (e) {
			console.error("[Streamed] loadStreams error: " + (e.message || e));
			return cb({
				success: false,
				errorCode: "STREAM_ERROR",
				message: "Failed to resolve streams: " + (e.message || e),
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Exports
	// ---------------------------------------------------------------------------

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
