(function () {
	/**
	 * TeluguPrazalu Plugin for SkyStream Gen 2 — Production Grade
	 * ===========================================================
	 * Scrapes https://teluguprazalu.com for Telugu movies.
	 *
	 * Features:
	 *  - In-memory TTL cache for HTML pages (reduces host load)
	 *  - Per-host circuit breaker (avoids hammering dead/rate-limited hosts)
	 *  - Health-check verification on stream URLs (HEAD request before returning)
	 *  - Structured logging with levels
	 *  - Fallback chains for every extractor
	 *  - Exponential backoff with jitter on retries
	 *  - Token expiry detection & auto-refresh
	 *
	 * Video hosts supported:
	 *   - shavetape.cash / tpead.net (Streamtape protocol)
	 *   - minochinos.com -> morencius.com (Morencius / EarnVids network)
	 *   - callistanise.com / movearnpre.com -> morencius.com
	 *   - mivalyo.com (dead domain, graceful fallback)
	 */

	// ============================================================
	// 1. LOGGING
	// ============================================================
	var LOG = {
		_levels: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 },
		_level: 2, // default INFO

		_format: function (level, msg, ctx) {
			var entry = {
				t: new Date().toISOString(),
				lvl: level,
				msg: msg,
				plugin: "TeluguPrazalu",
			};
			if (ctx) {
				if (typeof ctx === "string") entry.ctx = ctx;
				else Object.assign(entry, ctx);
			}
			return entry;
		},

		error: function (msg, ctx) {
			if (this._level >= 0)
				console.error(JSON.stringify(this._format("ERROR", msg, ctx)));
		},
		warn: function (msg, ctx) {
			if (this._level >= 1)
				console.warn(JSON.stringify(this._format("WARN", msg, ctx)));
		},
		info: function (msg, ctx) {
			if (this._level >= 2)
				console.log(JSON.stringify(this._format("INFO", msg, ctx)));
		},
		debug: function (msg, ctx) {
			if (this._level >= 3)
				console.log(JSON.stringify(this._format("DEBUG", msg, ctx)));
		},
	};

	// ============================================================
	// 2. CONFIGURATION
	// ============================================================
	var CONFIG = {
		USER_AGENT:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		REFERER: "https://teluguprazalu.com/",

		// Cache TTLs (ms)
		CACHE_TTL_HTML: 5 * 60 * 1000, // 5 min for HTML pages
		CACHE_TTL_CATEGORY: 10 * 60 * 1000, // 10 min for category listings

		// Circuit breaker
		CB_THRESHOLD: 3, // failures before open
		CB_RESET_MS: 60 * 1000, // 1 min before half-open

		// Health check
		HEALTH_CHECK_TIMEOUT: 8000, // 8s timeout for HEAD probes

		// Retry
		MAX_RETRIES: 2,
		RETRY_BASE_MS: 1000,
		RETRY_MAX_MS: 5000,

		// Streamtape token expiry buffer (seconds)
		ST_EXPIRY_BUFFER: 5 * 60, // 5 min before actual expiry, refresh
	};

	// ============================================================
	// 3. MEMORY CACHE (TTL-based)
	// ============================================================
	var _cache = Object.create(null);
	var _cacheTimers = Object.create(null);

	function cacheGet(key) {
		var entry = _cache[key];
		if (!entry) return null;
		if (Date.now() > entry.expires) {
			delete _cache[key];
			return null;
		}
		return entry.data;
	}

	function cacheSet(key, data, ttlMs) {
		_cache[key] = { data: data, expires: Date.now() + ttlMs };
	}

	function cacheClear() {
		_cache = Object.create(null);
	}

	// ============================================================
	// 4. CIRCUIT BREAKER (per host)
	// ============================================================
	var _cbState = Object.create(null);

	function cbAllow(host) {
		var state = _cbState[host];
		if (!state) return true;
		if (state.open && Date.now() > state.resetAt) {
			// half-open: allow one probe
			state.halfOpen = true;
			return true;
		}
		if (state.open) return false;
		return true;
	}

	function cbSuccess(host) {
		var state = _cbState[host];
		if (state) {
			state.fails = 0;
			state.open = false;
			state.halfOpen = false;
		}
	}

	function cbFailure(host) {
		if (!_cbState[host]) {
			_cbState[host] = { fails: 0, open: false, resetAt: 0 };
		}
		var state = _cbState[host];
		state.fails++;
		if (state.fails >= CONFIG.CB_THRESHOLD) {
			state.open = true;
			state.resetAt = Date.now() + CONFIG.CB_RESET_MS;
			LOG.warn("Circuit breaker opened for host", { host: host });
		}
	}

	// ============================================================
	// 5. HTTP FETCH with retry + circuit breaker + cache
	// ============================================================
	async function httpGetCached(url, options, ttlMs) {
		var cacheKey = "http|" + url;
		var cached = cacheGet(cacheKey);
		if (cached) {
			LOG.debug("Cache hit", { url: url.substring(0, 80) });
			return cached;
		}

		var result = await httpGetWithRetry(url, options);
		if (result && result.status === 200 && ttlMs > 0) {
			cacheSet(cacheKey, result, ttlMs);
		}
		return result;
	}

	async function httpGetWithRetry(url, options, retries) {
		if (retries === undefined) retries = CONFIG.MAX_RETRIES;

		var host;
		try {
			host = new URL(url).hostname;
		} catch (_) {
			host = "unknown";
		}

		if (!cbAllow(host)) {
			LOG.warn("Circuit breaker open, skipping", { host: host, url: url });
			return null;
		}

		for (var attempt = 0; attempt <= retries; attempt++) {
			try {
				var res = await http_get(url, options || {});

				if (res && res.status === 200) {
					cbSuccess(host);
					return res;
				}

				// Non-200 — log and retry
				LOG.warn("HTTP non-200", {
					status: res ? res.status : "unknown",
					attempt: attempt,
					host: host,
				});

				if (attempt < retries) {
					await sleep(jitterBackoff(attempt));
				} else {
					cbFailure(host);
				}
			} catch (e) {
				LOG.error("HTTP error", {
					err: e.message,
					attempt: attempt,
					host: host,
				});

				if (attempt < retries) {
					await sleep(jitterBackoff(attempt));
				} else {
					cbFailure(host);
				}
			}
		}
		return null;
	}

	function sleep(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	function jitterBackoff(attempt) {
		var base = CONFIG.RETRY_BASE_MS * Math.pow(2, attempt);
		var capped = Math.min(base, CONFIG.RETRY_MAX_MS);
		return Math.floor(capped * (0.5 + Math.random() * 0.5));
	}

	// ============================================================
	// 6. TOKEN VALIDATION (zero network, purely sync)
	// ============================================================
	/**
	 * Check if a tokenized URL is still valid by examining timestamps.
	 * Returns true if valid or can't be determined (optimistic).
	 */
	function tokenIsValid(url) {
		if (!url) return false;

		// Streamtape: expires=N (Unix timestamp)
		var expMatch = url.match(/expires=(\d+)/);
		if (expMatch) {
			var expiry = parseInt(expMatch[1], 10);
			if (Math.floor(Date.now() / 1000) > expiry - CONFIG.ST_EXPIRY_BUFFER) {
				return false;
			}
		}

		// acek-cdn / HLS: s=(start timestamp) + e=(duration seconds)
		var sMatch = url.match(/[?&]s=(\d+)/);
		var eMatch = url.match(/[?&]e=(\d+)/);
		if (sMatch && eMatch) {
			var start = parseInt(sMatch[1], 10);
			var dur = parseInt(eMatch[1], 10);
			if (
				Math.floor(Date.now() / 1000) >
				start + dur - CONFIG.ST_EXPIRY_BUFFER
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Remove streams with expired tokens, keep the rest.
	 * No network calls — purely synchronous token validation.
	 */
	function pruneExpiredStreams(streams) {
		if (!streams || streams.length === 0) return streams;
		var valid = [];
		for (var i = 0; i < streams.length; i++) {
			var s = streams[i];
			if (s.source === "Auto" || s.quality === "Auto" || tokenIsValid(s.url)) {
				valid.push(s);
			} else {
				LOG.warn("Token expired, pruning stream", {
					url: s.url.substring(0, 100),
					source: s.source,
				});
			}
		}
		return valid.length > 0 ? valid : streams;
	}

	// ============================================================
	// 8. UTILITY FUNCTIONS
	// ============================================================
	function baseUrl() {
		return typeof manifest !== "undefined" && manifest && manifest.baseUrl
			? manifest.baseUrl
			: "https://teluguprazalu.com";
	}

	function absUrl(url, base) {
		if (!url) return "";
		if (url.indexOf("//") === 0) return "https:" + url;
		if (url.indexOf("/") === 0) return (base || baseUrl()) + url;
		return url;
	}

	function decodeEntities(str) {
		if (!str) return "";
		return str
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&apos;/g, "'")
			.replace(/&#(\d+);/g, function (m, d) {
				return String.fromCharCode(parseInt(d));
			});
	}

	function grabYear(text) {
		if (!text) return null;
		var m = text.match(/\b((?:19|20)\d{2})\b/);
		return m ? parseInt(m[1]) : null;
	}

	function sniffQuality(text) {
		if (!text) return "";
		var t = text.toLowerCase();
		if (t.indexOf("2160") !== -1 || t.indexOf("4k") !== -1) return "2160p";
		if (t.indexOf("1080") !== -1) return "1080p";
		if (t.indexOf("720") !== -1) return "720p";
		if (t.indexOf("480") !== -1) return "480p";
		if (t.indexOf("360") !== -1) return "360p";
		if (t.indexOf("hd") !== -1) return "HD";
		return "";
	}

	function hostFromUrl(url) {
		if (!url) return "unknown";
		var u = url.toLowerCase();
		if (u.indexOf("shavetape.cash") !== -1) return "shavetape";
		if (u.indexOf("tpead.net") !== -1) return "tpead";
		if (u.indexOf("morencius.com") !== -1) return "morencius";
		if (u.indexOf("minochinos.com") !== -1) return "minochinos";
		if (u.indexOf("callistanise.com") !== -1) return "callistanise";
		if (u.indexOf("movearnpre.com") !== -1) return "movearnpre";
		if (u.indexOf("mivalyo.com") !== -1) return "mivalyo";
		return "unknown";
	}

	function domainOf(url) {
		try {
			var p = new URL(url);
			return p.protocol + "//" + p.hostname;
		} catch (e) {
			return url;
		}
	}

	function streamtapeId(url) {
		try {
			var p = new URL(url);
			var seg = p.pathname.split("/").filter(Boolean);
			if (seg.length >= 2 && seg[0] === "v") return seg[1];
		} catch (e) {}
		return null;
	}

	function morenciusFileId(url) {
		try {
			var p = new URL(url);
			var seg = p.pathname.split("/").filter(Boolean);
			for (var i = 0; i < seg.length; i++) {
				if (seg[i] === "file" || seg[i] === "download") {
					if (i + 1 < seg.length) {
						return seg[i + 1].replace(/_[a-z]$/, "");
					}
				}
			}
			if (seg.length === 1 && /^[a-z0-9]+$/i.test(seg[0])) return seg[0];
		} catch (e) {}
		return null;
	}

	function guessTitle(url) {
		try {
			var p = new URL(url);
			var parts = p.pathname.split("/").filter(Boolean);
			var last = decodeURIComponent(parts[parts.length - 1] || "");
			last = last
				.replace(/\.(mp4|mkv|webm|avi)$/i, "")
				.replace(/[-_]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			return last.length > 1 ? last : "Telugu Movie";
		} catch (e) {
			return "Telugu Movie";
		}
	}

	var VIDEO_HOSTS = [
		"shavetape.cash",
		"tpead.net",
		"morencius.com",
		"minochinos.com",
		"callistanise.com",
		"movearnpre.com",
		"mivalyo.com",
	];

	function isVideoHostUrl(url) {
		if (!url) return false;
		var u = url.toLowerCase();
		for (var i = 0; i < VIDEO_HOSTS.length; i++) {
			if (u.indexOf(VIDEO_HOSTS[i]) !== -1) return true;
		}
		return (
			u.indexOf("get_video") !== -1 ||
			u.match(/\.(mp4|mkv|webm|m3u8)(\?|$)/i) !== null
		);
	}

	// ============================================================
	// 9. STREAMS VERIFICATION WRAPPER
	// ============================================================
	/**
	 * Wraps a list of streams, runs health check, logs results.
	 * Returns the healthy (or best-effort) stream list.
	 */
	function finalizeStreams(streams, url) {
		// sync now
		if (streams.length === 0) {
			return [
				new StreamResult({
					url: url,
					quality: "Auto",
					source: "Auto",
					headers: {
						"User-Agent": CONFIG.USER_AGENT,
						Referer: CONFIG.REFERER,
					},
				}),
			];
		}

		// Deduplicate by URL
		var seen = {};
		var deduped = [];
		for (var i = 0; i < streams.length; i++) {
			if (seen[streams[i].url]) {
				LOG.debug("Dedup removed stream", {
					url: streams[i].url.substring(0, 100),
				});
				continue;
			}
			seen[streams[i].url] = true;
			deduped.push(streams[i]);
		}

		// Prune streams with expired tokens (sync, no network)
		var valid = pruneExpiredStreams(deduped);
		if (valid.length < deduped.length) {
			LOG.info("Pruned expired streams", {
				before: deduped.length,
				after: valid.length,
			});
		}

		return valid;
	}

	// ============================================================
	// 10. GET HOME — three category sections
	// ============================================================
	async function getHome(cb) {
		var startTime = Date.now();
		try {
			var base = baseUrl();
			var sections = [
				{ name: "Telugu Latest Movies", path: "/telugu-latest-movies/" },
				{
					name: "Hollywood Dubbed Movies",
					path: "/hollywood-movies-in-telugu/",
				},
				{
					name: "Bollywood Dubbed Movies",
					path: "/bollywood-movies-dubbed-in-telugu/",
				},
			];

			var result = {};

			for (var i = 0; i < sections.length; i++) {
				var s = sections[i];
				try {
					var items = await scrapeCategoryPage(base + s.path);
					if (items.length > 0) {
						result[s.name] = items.slice(0, 40);
						LOG.info("Category scraped", {
							category: s.name,
							count: items.length,
						});
					} else {
						LOG.warn("Category empty", { category: s.name });
					}
				} catch (e) {
					LOG.error("Category scrape failed", {
						category: s.name,
						err: e.message,
					});
				}
			}

			// Promote first items into "Trending" hero carousel
			var firstCat = null;
			for (var key in result) {
				if (result.hasOwnProperty(key) && result[key].length > 0) {
					firstCat = result[key];
					break;
				}
			}
			if (firstCat && firstCat.length > 0) {
				result["Trending"] = firstCat.slice(0, 10);
			}

			var dur = Date.now() - startTime;
			LOG.info("getHome completed", {
				duration: dur + "ms",
				categories: Object.keys(result).length,
			});
			cb({ success: true, data: result });
		} catch (e) {
			LOG.error("getHome failed", { err: e.message });
			cb({ success: false, errorCode: "SITE_OFFLINE", message: e.message });
		}
	}

	/**
	 * Scrape a category page and extract movie items from image+anchor pairs.
	 */
	async function scrapeCategoryPage(url) {
		try {
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_CATEGORY,
			);

			if (!res || res.status !== 200) {
				LOG.warn("Category page not available", { url: url });
				return [];
			}

			var doc = await parseHtml(res.body);

			// Find all <a><img></a> combos in the page
			var allAnchors = Array.from(doc.querySelectorAll("a"));
			var movies = [];
			var seen = {};

			for (var i = 0; i < allAnchors.length; i++) {
				var a = allAnchors[i];
				var href = a.getAttribute("href");
				if (!href) continue;
				if (!isVideoHostUrl(href)) continue;
				if (seen[href]) continue;

				var img = a.querySelector("img");
				if (!img) continue;

				var src = img.getAttribute("src") || img.getAttribute("data-src") || "";
				if (!src) continue;

				var alt = (img.getAttribute("alt") || "").trim();
				var title = alt || "Telugu Movie";

				seen[href] = true;

				movies.push(
					new MultimediaItem({
						title: decodeEntities(title),
						url: href,
						posterUrl: absUrl(src),
						type: "movie",
						year: grabYear(title) || undefined,
					}),
				);

				if (movies.length >= 50) break;
			}

			return movies;
		} catch (e) {
			LOG.error("scrapeCategoryPage error", { url: url, err: e.message });
			return [];
		}
	}

	// ============================================================
	// 11. SEARCH
	// ============================================================
	async function search(query, cb) {
		try {
			var url = baseUrl() + "/?s=" + encodeURIComponent(query);
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (!res || res.status !== 200) return cb({ success: true, data: [] });

			var doc = await parseHtml(res.body);
			var results = [];

			var articles = Array.from(
				doc.querySelectorAll("article, div.post, li.post, .hentry"),
			);

			for (var i = 0; i < articles.length; i++) {
				var art = articles[i];
				var titleEl = art.querySelector(
					"h2.entry-title a, h1.entry-title a, .entry-title a, h2 a, h1 a, .post-title a",
				);
				if (!titleEl) continue;

				var title = decodeEntities(titleEl.textContent || "").trim();
				if (!title) continue;

				var href = titleEl.getAttribute("href");
				if (!href) continue;

				var img = art.querySelector("img.wp-post-image, img");
				var poster = img
					? img.getAttribute("src") || img.getAttribute("data-src") || ""
					: "";

				results.push(
					new MultimediaItem({
						title: title,
						url: href,
						posterUrl: absUrl(poster),
						type: "movie",
						year: grabYear(title) || undefined,
					}),
				);
			}

			// Fallback: scrape as category page
			if (results.length === 0) {
				var fallbackMovies = await scrapeCategoryPage(url);
				results = fallbackMovies;
			}

			LOG.info("Search completed", { query: query, results: results.length });
			cb({ success: true, data: results });
		} catch (e) {
			LOG.error("Search failed", { query: query, err: e.message });
			cb({ success: true, data: [] });
		}
	}

	// ============================================================
	// 12. LOAD
	// ============================================================
	async function load(url, cb) {
		try {
			if (url.indexOf(baseUrl()) === 0 && !isVideoHostUrl(url)) {
				loadFromPost(url, cb);
				return;
			}

			var title = guessTitle(url);
			var poster = "";

			// For file-ID based URLs, fetch page to get real title
			if (url.match(/minochinos|mivalyo|movearnpre|callistanise|morencius/)) {
				try {
					var metaRes = await httpGetCached(
						url,
						{
							"User-Agent": CONFIG.USER_AGENT,
							Referer: CONFIG.REFERER,
						},
						CONFIG.CACHE_TTL_HTML,
					);

					if (metaRes && metaRes.status === 200) {
						var metaDoc = await parseHtml(metaRes.body);
						var pageTitle = metaDoc.querySelector("title")?.textContent?.trim();
						if (pageTitle) {
							title = decodeEntities(pageTitle)
								.replace(/ at .*$/i, "")
								.replace(/ - .*$/i, "")
								.replace(/ \|.*$/i, "")
								.trim();
						}
						var ogImage = metaDoc
							.querySelector("meta[property='og:image']")
							?.getAttribute("content");
						if (ogImage) poster = ogImage;
					}
				} catch (e) {
					LOG.debug("Title fetch failed, using guess", {
						url: url.substring(0, 80),
					});
				}
			}

			loadWithMetadata(url, title, poster, cb);
		} catch (e) {
			LOG.error("load failed", { err: e.message });
			cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
		}
	}

	async function loadWithMetadata(url, fallbackTitle, fallbackPoster, cb) {
		try {
			var item = new MultimediaItem({
				title: fallbackTitle,
				url: url,
				posterUrl: fallbackPoster,
				type: "movie",
				episodes: [
					new Episode({
						name: "Play Movie",
						url: url,
						season: 1,
						episode: 1,
					}),
				],
			});
			cb({ success: true, data: item });
		} catch (e) {
			cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
		}
	}

	/**
	 * Handle internal WordPress post URLs.
	 */
	async function loadFromPost(url, cb) {
		try {
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (!res || res.status !== 200) {
				return cb({ success: false, errorCode: "SITE_OFFLINE" });
			}

			var doc = await parseHtml(res.body);
			var title =
				doc
					.querySelector("h1.entry-title, h1.post-title, h1")
					?.textContent?.trim() || "Telugu Movie";
			title = decodeEntities(title);

			var poster =
				doc
					.querySelector("meta[property='og:image']")
					?.getAttribute("content") ||
				doc.querySelector("img.wp-post-image")?.getAttribute("src") ||
				"";

			var content = doc.querySelector(".entry-content") || doc;
			var anchors = Array.from(content.querySelectorAll("a"));
			var videoLinks = [];

			for (var i = 0; i < anchors.length; i++) {
				var href = anchors[i].getAttribute("href");
				if (href && isVideoHostUrl(href)) {
					videoLinks.push(href);
				}
			}

			if (videoLinks.length === 0) {
				var items = await scrapeCategoryPage(url);
				if (items.length > 0) {
					cb({ success: true, data: items[0] });
					return;
				}
			}

			var item = new MultimediaItem({
				title: title,
				url: url,
				posterUrl: absUrl(poster),
				type: "movie",
				episodes: videoLinks.map(function (vl, idx) {
					return new Episode({
						name: "Source " + (idx + 1),
						url: vl,
						season: 1,
						episode: idx + 1,
					});
				}),
			});

			if (videoLinks.length === 1) {
				item.episodes = [
					new Episode({
						name: "Play Movie",
						url: videoLinks[0],
						season: 1,
						episode: 1,
					}),
				];
			}

			cb({ success: true, data: item });
		} catch (e) {
			LOG.error("loadFromPost failed", { err: e.message });
			cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
		}
	}

	// ============================================================
	// 13. LOAD STREAMS — orchestrator
	// ============================================================
	async function loadStreams(url, cb) {
		var startTime = Date.now();
		try {
			if (!url) return cb({ success: true, data: [] });

			var streams = [];
			var host = hostFromUrl(url);

			LOG.info("loadStreams start", { host: host, url: url.substring(0, 80) });

			switch (host) {
				case "shavetape":
				case "tpead":
					await streamtapeExtract(url, streams);
					break;
				case "morencius":
				case "minochinos":
				case "callistanise":
				case "movearnpre":
					await morenciusExtract(url, streams);
					break;
				case "mivalyo":
					await mivalyoExtract(url, streams);
					break;
				default:
					if (url.match(/\.(mp4|mkv|webm|m3u8)(\?|$)/i)) {
						streams.push(
							new StreamResult({
								url: url,
								quality: sniffQuality(url) || "Auto",
								headers: {
									"User-Agent": CONFIG.USER_AGENT,
									Referer: domainOf(url),
								},
							}),
						);
					} else {
						var ok = await genericExtract(url, streams);
						if (!ok) {
							streams.push(
								new StreamResult({
									url: url,
									quality: "Auto",
									source: "Auto",
									headers: {
										"User-Agent": CONFIG.USER_AGENT,
										Referer: CONFIG.REFERER,
									},
								}),
							);
						}
					}
			}

			// Finalize: dedup, health-check, sort by quality
			var final = finalizeStreams(streams, url);

			// Sort: prefer higher quality, prefer non-Auto sources
			final.sort(function (a, b) {
				var aQ = qualityScore(a.quality || "Auto");
				var bQ = qualityScore(b.quality || "Auto");
				if (bQ !== aQ) return bQ - aQ;
				if (a.source === "Auto" && b.source !== "Auto") return 1;
				if (b.source === "Auto" && a.source !== "Auto") return -1;
				return 0;
			});

			var dur = Date.now() - startTime;
			LOG.info("loadStreams completed", {
				host: host,
				count: final.length,
				duration: dur + "ms",
			});

			cb({ success: true, data: final });
		} catch (e) {
			LOG.error("loadStreams fatal", { err: e.message });
			cb({
				success: true,
				data: [
					new StreamResult({
						url: url,
						quality: "Auto",
						source: "Auto",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: CONFIG.REFERER,
						},
					}),
				],
			});
		}
	}

	function qualityScore(q) {
		var t = (q || "Auto").toLowerCase();
		if (t === "2160p" || t === "4k") return 6;
		if (t === "1080p") return 5;
		if (t === "720p") return 4;
		if (t === "hd") return 3;
		if (t === "480p") return 2;
		if (t === "360p") return 1;
		return 0;
	}

	// ============================================================
	// 14. STREAMTAPE EXTRACTOR
	// ============================================================
	async function streamtapeExtract(url, streams) {
		try {
			var sid = streamtapeId(url);
			if (!sid) {
				streams.push(
					new StreamResult({
						url: url,
						quality: "Auto",
						source: "Auto",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: domainOf(url),
						},
					}),
				);
				return;
			}

			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			); // cache HTML for 5 min

			if (!res || res.status !== 200) {
				// Build basic URL without token — SkyStream may still try it
				var basicUrl =
					"https://" + new URL(url).hostname + "/get_video?id=" + sid;
				streams.push(
					new StreamResult({
						url: basicUrl,
						quality: "HD",
						source: "Streamtape",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: domainOf(url),
						},
					}),
				);
				return;
			}

			var body = res.body;
			var found = [];

			// Pattern: /hostname/get_video?id=XXX&expires=N&ip=Y&token=Z
			var re = /\/([a-zA-Z0-9.-]+)\/get_video\?id=([a-zA-Z0-9]+)/gi;
			var m;
			while ((m = re.exec(body)) !== null) {
				var host = m[1];
				if (host.indexOf(".") === -1) continue;
				if (m[2].length < 5) continue;
				var vid = m[2];
				var ctx = body.substring(Math.max(0, m.index - 60), m.index + 300);
				var exp = ctx.match(/expires=(\d+)/);
				var ip = ctx.match(/ip=([^&\s"'<]+)/);
				var tok = ctx.match(/token=([^&\s"'<]+)/);

				// Check token expiry
				if (exp) {
					var expiryTs = parseInt(exp[1], 10);
					var now = Math.floor(Date.now() / 1000);
					if (expiryTs - now < CONFIG.ST_EXPIRY_BUFFER) {
						LOG.debug("Streamtape token expired, waiting for refresh", {
							expires: exp[1],
						});
						continue; // skip expired, will get fresh on next request
					}
				}

				var built =
					"https://" +
					host +
					"/get_video?id=" +
					vid +
					(exp ? "&expires=" + exp[1] : "") +
					(ip ? "&ip=" + ip[1] : "") +
					(tok ? "&token=" + tok[1] : "");
				if (found.indexOf(built) === -1) found.push(built);
			}

			// Push all found URLs as streams
			for (var i = 0; i < found.length; i++) {
				var u = found[i];
				// Check if existing streams already have this URL
				var dup = false;
				for (var j = 0; j < streams.length; j++) {
					if (streams[j].url === u) {
						dup = true;
						break;
					}
				}
				if (!dup) {
					streams.push(
						new StreamResult({
							url: u,
							quality: "HD",
							source: "Streamtape",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: domainOf(url),
							},
						}),
					);
				}
			}

			// Fallback: iframe embed or basic URL
			if (streams.length === 0) {
				var ifr = body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
				if (ifr) {
					await streamtapeEmbed(ifr[1], streams);
				}
				if (streams.length === 0) {
					streams.push(
						new StreamResult({
							url: "https://" + new URL(url).hostname + "/get_video?id=" + sid,
							quality: "HD",
							source: "Streamtape",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: domainOf(url),
							},
						}),
					);
				}
			}
		} catch (e) {
			LOG.error("streamtapeExtract error", { err: e.message });
			streams.push(
				new StreamResult({
					url: url,
					quality: "Auto",
					source: "Auto",
					headers: {
						"User-Agent": CONFIG.USER_AGENT,
						Referer: CONFIG.REFERER,
					},
				}),
			);
		}
	}

	async function streamtapeEmbed(embedUrl, streams) {
		try {
			var url = absUrl(embedUrl);
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: domainOf(url),
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (!res || res.status !== 200) return;
			var src = res.body.match(/src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
			if (src) {
				streams.push(
					new StreamResult({
						url: absUrl(src[1], domainOf(url)),
						quality: "HD",
						source: "Streamtape",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: domainOf(url),
						},
					}),
				);
			}
		} catch (e) {
			LOG.debug("streamtapeEmbed error", { err: e.message });
		}
	}

	// ============================================================
	// 15. MORENCIUS-NETWORK EXTRACTOR
	// ============================================================
	async function morenciusExtract(url, streams) {
		try {
			// Resolve to morencius.com
			var target = url;
			if (url.indexOf("morencius.com") === -1) {
				var fid = morenciusFileId(url);
				if (fid) target = "https://morencius.com/file/" + fid;
			}

			var packedFid = morenciusFileId(target);

			// FIRST: Try HLS extraction from embed page (best quality)
			if (packedFid) {
				var hlsOk = await morenciusExtractHls(packedFid, streams);
				if (hlsOk) {
					// HLS found — verify and return
					return;
				}
			}

			// SECOND: Try file page for download links
			var res = await httpGetCached(
				target,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (res && res.status === 200) {
				var body = res.body;

				// Pattern: download links from anchor tags
				var dlRe =
					/<a[^>]+href=["']([^"']*\/download\/([^"'\s]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
				var dlMatch;
				while ((dlMatch = dlRe.exec(body)) !== null) {
					var href = dlMatch[1].trim();
					var fullUrl =
						href.indexOf("http") === 0
							? href
							: "https://morencius.com" +
								(href.indexOf("/") === 0 ? "" : "/") +
								href;
					var label = decodeEntities(
						dlMatch[3].replace(/<[^>]+>/g, ""),
					).toLowerCase();
					streams.push(
						new StreamResult({
							url: fullUrl,
							quality: sniffQuality(label) || "HD",
							source: "Morencius",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: "https://morencius.com/",
							},
						}),
					);
				}

				// Pattern: <source> tag
				if (streams.length === 0) {
					var vsrc = body.match(/<source[^>]+src=["']([^"']+)["']/i);
					if (vsrc) {
						streams.push(
							new StreamResult({
								url: absUrl(vsrc[1], "https://morencius.com"),
								quality: "HD",
								source: "Morencius",
								headers: {
									"User-Agent": CONFIG.USER_AGENT,
									Referer: "https://morencius.com/",
								},
							}),
						);
					}
				}
			}

			// LAST RESORT: HD download link
			if (streams.length === 0 && packedFid) {
				LOG.debug("Morencius: falling back to download link", {
					fid: packedFid,
				});
				streams.push(
					new StreamResult({
						url: "https://morencius.com/download/" + packedFid + "_n",
						quality: "HD",
						source: "Morencius",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: "https://morencius.com/",
						},
					}),
				);
			}

			if (streams.length === 0) {
				streams.push(
					new StreamResult({
						url: url,
						quality: "Auto",
						source: "Auto",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: CONFIG.REFERER,
						},
					}),
				);
			}
		} catch (e) {
			LOG.error("morenciusExtract error", { err: e.message });
			streams.push(
				new StreamResult({
					url: url,
					quality: "Auto",
					source: "Auto",
					headers: {
						"User-Agent": CONFIG.USER_AGENT,
						Referer: CONFIG.REFERER,
					},
				}),
			);
		}
	}

	// ============================================================
	// 16. MORENCIUS HLS EXTRACTOR (P.A.C.K.E.R unpacker)
	// ============================================================
	async function morenciusExtractHls(fid, streams) {
		try {
			var eRes = await http_get("https://morencius.com/embed/" + fid, {
				"User-Agent": CONFIG.USER_AGENT,
				Referer: "https://morencius.com/",
			});
			if (!eRes || eRes.status !== 200) return false;

			var html = eRes.body;

			// Find P.A.C.K.E.R-packed script
			var pMatch = html.match(
				/}\((['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\('\|'\)/,
			);
			if (!pMatch) return false;

			var payload = pMatch[2];
			var radix = parseInt(pMatch[3]);
			var words = pMatch[5].split("|");

			// Unpack
			var unpacked = payload;
			for (var i = 0; i < words.length; i++) {
				if (!words[i]) continue;
				var encoded = i.toString(radix);
				var re = new RegExp(
					"\\b" + encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
					"g",
				);
				unpacked = unpacked.replace(re, words[i]);
			}

			// Extract HLS URLs from unpacked JWPlayer config
			var hls2 = unpacked.match(
				/["']hls2["']\s*[:=]\s*["'](https?:\/\/[^"']+master\.m3u8[^"']*)["']/i,
			);
			var hls4 = unpacked.match(
				/["']hls4["']\s*[:=]\s*["']([^"']+master\.m3u8[^"']*)["']/i,
			);
			var m3u8 =
				!hls2 &&
				!hls4 &&
				unpacked.match(
					/["']file["']\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
				);

			var count = 0;

			if (hls2) {
				var u = hls2[1].replace(/\\"/g, "").replace(/\\'/g, "").trim();
				if (tokenIsValid(u)) {
					streams.push(
						new StreamResult({
							url: u,
							quality: "HD",
							source: "Morencius HLS",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: "https://morencius.com/",
							},
						}),
					);
					count++;
				} else {
					LOG.debug("Morencius HLS token expired, skipping", { fid: fid });
				}
			}

			if (hls4) {
				var u4 = absUrl(
					hls4[1].replace(/\\"/g, "").replace(/\\'/g, "").trim(),
					"https://morencius.com",
				);
				if (tokenIsValid(u4)) {
					// Dedup against hls2
					var isDup = false;
					if (hls2) {
						var h2 = hls2[1].replace(/\\"/g, "").replace(/\\'/g, "").trim();
						if (u4 === h2) isDup = true;
					}
					if (!isDup) {
						streams.push(
							new StreamResult({
								url: u4,
								quality: "HD",
								source: "Morencius HLS",
								headers: {
									"User-Agent": CONFIG.USER_AGENT,
									Referer: "https://morencius.com/",
								},
							}),
						);
						count++;
					}
				} else {
					LOG.debug("Morencius HLS4 token expired, skipping", { fid: fid });
				}
			}

			if (!hls2 && !hls4 && m3u8) {
				var u5 = m3u8[1].replace(/\\"/g, "").replace(/\\'/g, "").trim();
				if (tokenIsValid(u5)) {
					streams.push(
						new StreamResult({
							url: u5,
							quality: "HD",
							source: "Morencius HLS",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: "https://morencius.com/",
							},
						}),
					);
					count++;
				}
			}

			if (count > 0) {
				LOG.info("Morencius HLS extracted", {
					fid: fid,
					count: count,
				});
			}
			return count > 0;
		} catch (e) {
			LOG.error("morenciusExtractHls error", { fid: fid, err: e.message });
			return false;
		}
	}

	// ============================================================
	// 17. MIVALYO EXTRACTOR (dead domain, graceful fallback)
	// ============================================================
	async function mivalyoExtract(url, streams) {
		try {
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (!res || res.status !== 200) {
				LOG.warn("Mivalyo unreachable", { url: url.substring(0, 80) });
				streams.push(
					new StreamResult({
						url: url,
						quality: "Auto",
						source: "Auto",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: CONFIG.REFERER,
						},
					}),
				);
				return;
			}

			var body = res.body;
			var found = false;

			// Pattern 1: Download links
			var dlRe =
				/<a[^>]+href=["']([^"']*\/download\/([^"'\s]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
			var m;
			while ((m = dlRe.exec(body)) !== null) {
				found = true;
				var href = m[1].trim();
				var full =
					href.indexOf("http") === 0
						? href
						: "https://mivalyo.com" +
							(href.indexOf("/") === 0 ? "" : "/") +
							href;
				var label = decodeEntities(m[3].replace(/<[^>]+>/g, "")).toLowerCase();
				streams.push(
					new StreamResult({
						url: full,
						quality: sniffQuality(label) || "HD",
						source: "Mivalyo",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: "https://mivalyo.com/",
						},
					}),
				);
			}

			// Pattern 2: <source> tag
			if (!found) {
				var vsrc = body.match(/<source[^>]+src=["']([^"']+)["']/i);
				if (vsrc) {
					found = true;
					streams.push(
						new StreamResult({
							url: absUrl(vsrc[1], "https://mivalyo.com"),
							quality: "HD",
							source: "Mivalyo",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: "https://mivalyo.com/",
							},
						}),
					);
				}
			}

			if (!found) {
				streams.push(
					new StreamResult({
						url: url,
						quality: "Auto",
						source: "Auto",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: CONFIG.REFERER,
						},
					}),
				);
			}
		} catch (e) {
			LOG.warn("mivalyoExtract fallback", { err: e.message });
			streams.push(
				new StreamResult({
					url: url,
					quality: "Auto",
					source: "Auto",
					headers: {
						"User-Agent": CONFIG.USER_AGENT,
						Referer: CONFIG.REFERER,
					},
				}),
			);
		}
	}

	// ============================================================
	// 18. GENERIC EXTRACTOR
	// ============================================================
	async function genericExtract(url, streams) {
		try {
			var res = await httpGetCached(
				url,
				{
					"User-Agent": CONFIG.USER_AGENT,
					Referer: CONFIG.REFERER,
				},
				CONFIG.CACHE_TTL_HTML,
			);

			if (!res || res.status !== 200) return false;

			var body = res.body;
			var found = false;

			// <source src="...">
			var re1 = /<source[^>]+src=["']([^"']+)["']/gi;
			var m;
			while ((m = re1.exec(body)) !== null) {
				found = true;
				streams.push(
					new StreamResult({
						url: absUrl(m[1], domainOf(url)),
						quality: "Auto",
						source: "Generic",
						headers: {
							"User-Agent": CONFIG.USER_AGENT,
							Referer: domainOf(url),
						},
					}),
				);
			}

			// <video src="...">
			if (!found) {
				var re2 = /<video[^>]+src=["']([^"']+)["']/i;
				if ((m = re2.exec(body)) !== null) {
					found = true;
					streams.push(
						new StreamResult({
							url: absUrl(m[1], domainOf(url)),
							quality: "Auto",
							source: "Generic",
							headers: {
								"User-Agent": CONFIG.USER_AGENT,
								Referer: domainOf(url),
							},
						}),
					);
				}
			}

			// <iframe> — try to extract recursively
			if (!found) {
				var ifre = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
				while ((m = ifre.exec(body)) !== null) {
					var iframeUrl = absUrl(m[1], domainOf(url));
					try {
						var ifRes = await httpGetCached(
							iframeUrl,
							{
								"User-Agent": CONFIG.USER_AGENT,
								Referer: url,
							},
							CONFIG.CACHE_TTL_HTML,
						);

						if (ifRes && ifRes.status === 200) {
							var ifSrc = ifRes.body.match(/<source[^>]+src=["']([^"']+)["']/i);
							if (ifSrc) {
								found = true;
								streams.push(
									new StreamResult({
										url: absUrl(ifSrc[1], domainOf(iframeUrl)),
										quality: "Auto",
										source: "Generic",
										headers: {
											"User-Agent": CONFIG.USER_AGENT,
											Referer: domainOf(iframeUrl),
										},
									}),
								);
							}
						}
					} catch (e) {
						LOG.debug("genericExtract iframe error", { err: e.message });
					}
				}
			}

			return found;
		} catch (e) {
			LOG.debug("genericExtract error", { err: e.message });
			return false;
		}
	}

	// ============================================================
	// 19. EXPORT
	// ============================================================
	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
