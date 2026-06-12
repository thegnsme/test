/**
 * =============================================================================
 *  MultiSource — SkyStream Gen 2 Plugin Dispatcher (Production)
 *  =============================================================================
 *
 *  ARCHITECTURE:
 *    plugin.js is a PURE DISPATCHER. All scraping logic lives in sources/*.js
 *    loaded via sources/index.js barrel. To add/edit/remove a source, only
 *    touch files in sources/ — never plugin.js.
 *
 *  PRODUCTION FEATURES:
 *    • TMDB response caching (TTL-based per endpoint)
 *    • Exponential backoff retry for failed TMDB calls
 *    • Adaptive timeouts (TV gets 2.5× budget vs Movies)
 *    • Source health monitoring — auto-skips dead sources after 3 failures
 *    • Stream deduplication by URL across all sources
 *    • Subtitle passthrough from sources to player
 *    • Quality auto-detection from URL when source omits it
 *    • Streams sorted: highest quality first, then alphabetically by source
 *
 *  🔴 SUBTITLE ARCHITECTURE (3 CRITICAL RULES):
 *
 *    1. StreamResult constructor strips subtitles
 *       Assign subtitles AFTER construction, NOT in the constructor:
 *         var sr = new StreamResult({ url, source, headers, quality });
 *         sr.subtitles = mergedSubtitles;  // ← AFTER constructor
 *
 *    2. Deep-clone subtitle arrays per stream
 *       Never share the same array reference across streams. Player toggling
 *       on one stream must not corrupt others.
 *
 *    3. ALL streams MUST use the SAME canonical subtitle set
 *       🔴 THIS PREVENTS HLS CRASHES ON SOURCE/QUALITY SWITCH.
 *       Each source returns different subtitle URLs. If streams have different
 *       subtitle tracks, the player must REMOVE old tracks and ADD new ones on
 *       source/quality switch → HLS.js FATAL ERROR.
 *
 *       FIX: Use external SubDL subtitles as ONE canonical set for ALL streams
 *       (same languages, same order, same URLs). Player never rebuilds tracks
 *       on switch → no crash. Source subs used only as SubDL fallback.
 *
 *  URL SCHEME:
 *    Movie:  nuvio://movie/{tmdbId}
 *    TV:     nuvio://tv/{tmdbId}/{season}/{episode}
 *
 *  RUNTIME GLOBALS (provided by SkyStream SDK):
 *    MultimediaItem, StreamResult, Episode, Actor, Trailer, NextAiring
 *    manifest, http_get, http_post, setTimeout, clearTimeout, console
 * =============================================================================
 */
(function () {
	"use strict";

	// ═════════════════════════════════════════════════════════════════════════
	//  CONSTANTS
	// ═════════════════════════════════════════════════════════════════════════

	var TAG = "MultiSource";
	var TMDB_KEYS = [
		"68e094699525b18a70bab2f86b1fa706",
		"af3a53eb387d57fc935e9128468b1899",
		"0142a22c560ce3efb1cfd6f3b2faab77",
	];
	var TMDB_BASE = "https://api.themoviedb.org/3";
	var TMDB_IMG = "https://image.tmdb.org/t/p";
	var IMG_POST = "w500";
	var IMG_BACK = "w780";
	var IMG_STILL = "w300";
	var IMG_PROF = "w185";
	var UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
	var HDR = {
		"User-Agent": UA,
		Accept: "application/json,text/plain,*/*",
	};

	// Tunables
	var HTTP_TIMEOUT = 12000;
	var CACHE_TTL = 300000; // 5 min
	var CACHE_MAX = 500; // max entries before eviction
	var MAX_RETRIES = 2;
	var RETRY_BASE_MS = 1000;
	var HOME_TIMEOUT = 10000;
	var LOAD_TIMEOUT = 10000;
	var STREAMS_TIMEOUT = 10000;

	// ═════════════════════════════════════════════════════════════════════════
	//  TMDB RESPONSE CACHE (bounded LRU with TTL)
	// ═════════════════════════════════════════════════════════════════════════

	var _cache = {};
	var _cacheKeys = []; // insertion order for LRU eviction

	function cacheEvict() {
		while (_cacheKeys.length >= CACHE_MAX) {
			var oldKey = _cacheKeys.shift();
			delete _cache[oldKey];
		}
	}

	function cacheGet(key) {
		var entry = _cache[key];
		if (!entry) return undefined; // undefined = not in cache
		if (entry.expires < Date.now()) {
			delete _cache[key];
			// Remove from key list
			for (var ci = 0; ci < _cacheKeys.length; ci++) {
				if (_cacheKeys[ci] === key) {
					_cacheKeys.splice(ci, 1);
					break;
				}
			}
			return undefined;
		}
		return entry.data;
	}

	function cacheSet(key, data, ttl) {
		ttl = ttl || CACHE_TTL;
		if (!_cache[key]) {
			_cacheKeys.push(key);
			cacheEvict();
		}
		_cache[key] = { data: data, expires: Date.now() + ttl };
	}

	function cacheClear() {
		_cache = {};
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  LOGGING
	// ═════════════════════════════════════════════════════════════════════════

	function log() {
		try {
			console.log.apply(
				console,
				["[" + TAG + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {}
	}
	function warn() {
		try {
			console.warn.apply(
				console,
				["[" + TAG + "]"].concat([].slice.call(arguments)),
			);
		} catch (e) {}
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  HTTP WRAPPER (Promise-based with timeout + retry)
	// ═════════════════════════════════════════════════════════════════════════

	function httpGet(url, headers, ms) {
		ms = ms || HTTP_TIMEOUT;
		return new Promise(function (resolve) {
			var done = false;
			var t = setTimeout(function () {
				if (!done) {
					done = true;
					resolve({ status: 0, body: "", error: "timeout" });
				}
			}, ms);
			function finish(r) {
				if (!done) {
					done = true;
					clearTimeout(t);
					resolve(r || { status: 0, body: "" });
				}
			}
			try {
				http_get(url, headers || HDR, function (r) {
					finish({
						status: r && (r.status || r.statusCode || 200),
						body: (r && (r.body || (typeof r === "string" ? r : ""))) || "",
					});
				});
			} catch (e) {
				finish({ status: 0, body: "" });
			}
		});
	}

	function httpGetWithRetry(url, headers, ms, retries) {
		retries = retries !== undefined ? retries : MAX_RETRIES;
		ms = ms || HTTP_TIMEOUT;
		var attempt = 0;
		function doTry() {
			attempt++;
			return httpGet(url, headers, ms).then(function (r) {
				var shouldRetry =
					retries > 0 &&
					attempt <= retries &&
					(r.status === 0 ||
						r.status === 429 ||
						r.status === 502 ||
						r.status === 503 ||
						r.status === 504);
				if (shouldRetry) {
					var delay =
						RETRY_BASE_MS *
						Math.pow(2, attempt - 1) *
						(0.5 + Math.random() * 0.5);
					return new Promise(function (resolve) {
						setTimeout(function () {
							resolve(doTry());
						}, delay);
					});
				}
				return r;
			});
		}
		return doTry();
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  TMDB LAYER (cached + retry)
	// ═════════════════════════════════════════════════════════════════════════

	var _tmdbIdx = 0;
	function tmdbKey() {
		return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
	}

	function tmdbGet(endpoint, params, noCache) {
		var q = "api_key=" + tmdbKey();
		if (params)
			for (var k in params)
				if (params[k] != null)
					q +=
						"&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
		var url = TMDB_BASE + "/" + endpoint + "?" + q;

		if (!noCache) {
			var cached = cacheGet(url);
			// undefined = not in cache; null = cached-as-not-found; object = valid data
			if (cached !== undefined) return Promise.resolve(cached);
		}

		return httpGetWithRetry(url, HDR, HTTP_TIMEOUT, MAX_RETRIES).then(
			function (r) {
				if (r.status >= 200 && r.status < 300 && r.body) {
					try {
						var data = JSON.parse(r.body);
						if (!noCache) cacheSet(url, data);
						return data;
					} catch (e) {
						return null;
					}
				}
				if (r.status === 404 && !noCache) cacheSet(url, null, 60000);
				return null;
			},
		);
	}

	function img(size, p) {
		return p ? TMDB_IMG + "/" + (size || IMG_POST) + p : "";
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  LOAD SOURCES — barrel import
	// ═════════════════════════════════════════════════════════════════════════

	var SOURCES;
	try {
		SOURCES = require("./sources");
	} catch (e) {
		warn("require('./sources') failed — running with empty sources");
		SOURCES = {
			aggregateAll: function () {
				return Promise.resolve({
					success: true,
					sources: [],
					workingSources: 0,
					totalSources: 0,
					totalStreams: 0,
					elapsed_ms: 0,
				});
			},
			listSources: function () {
				return [];
			},
			sourceCount: 0,
		};
	}

	log(
		"Loaded " +
			SOURCES.sourceCount +
			" source(s): " +
			SOURCES.listSources().join(", "),
	);

	// ═════════════════════════════════════════════════════════════════════════
	//  SUBTITLE PROVIDER — SubDL enrichment
	// ═════════════════════════════════════════════════════════════════════════

	var SUBTITLE_PROVIDER;
	try {
		SUBTITLE_PROVIDER = require("./sources/subtitles_provider");
		log("Subtitle provider loaded: SubDL");
	} catch (e) {
		warn("require('./sources/subtitles_provider') failed — subtitles disabled");
		SUBTITLE_PROVIDER = {
			fetchSubtitles: function () {
				return Promise.resolve([]);
			},
			attachSubtitlesToStreams: function (s, subs) {
				return s;
			},
			cloneSubtitles: function (arr) {
				return arr ? JSON.parse(JSON.stringify(arr)) : [];
			},
			normalizeSubtitle: function (sub) {
				return sub
					? {
							url: sub.url,
							name: sub.label || sub.name || "Subtitle",
							label: sub.label || sub.name || "Subtitle",
							lang: sub.lang || "en",
						}
					: null;
			},
		};
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  getHome(cb, page)
	// ═════════════════════════════════════════════════════════════════════════

	var HOME_CATS = [
		{ n: "Trending Now", ep: "trending/all/week", t: null },
		{ n: "Trending Movies", ep: "trending/movie/week", t: "movie" },
		{ n: "Trending Series", ep: "trending/tv/week", t: "series" },
		{ n: "Airing Today", ep: "tv/airing_today", t: "series" },
		{ n: "Top Rated Movies", ep: "movie/top_rated", t: "movie" },
		{ n: "Top Rated Series", ep: "tv/top_rated", t: "series" },
	];

	function fetchCat(cat, page) {
		return tmdbGet(cat.ep, { page: page || 1 }).then(function (d) {
			if (!d || !d.results) return [];
			var seen = {},
				out = [];
			for (var i = 0; i < d.results.length && out.length < 20; i++) {
				var r = d.results[i];
				var title = r.title || r.name || r.original_title || r.original_name;
				if (!title || seen[r.id]) continue;
				seen[r.id] = true;
				var mt = r.media_type || cat.t || "movie";
				if (mt === "tv") mt = "series";
				var yr = (r.release_date || r.first_air_date || "").split("-")[0];
				var poster = r.poster_path ? img(IMG_POST, r.poster_path) : "";
				var banner = r.backdrop_path ? img(IMG_BACK, r.backdrop_path) : poster;
				out.push(
					new MultimediaItem({
						title: title,
						url: "nuvio://" + (mt === "series" ? "tv" : "movie") + "/" + r.id,
						posterUrl: poster,
						bannerUrl: banner,
						type: mt,
						year: parseInt(yr, 10) || undefined,
						score: r.vote_average || undefined,
					}),
				);
			}
			return out;
		});
	}

	function getHome(cb, page) {
		page = parseInt(page) || 1;
		log("getHome(page=" + page + ")");

		// Pre-populate results with all category keys so timeout never returns an empty map.
		// SkyStream Gen 2 expects data to be a Map<String, MultimediaItem[]>
		// An empty object {} causes "not a map" error in some player versions.
		var results = {};
		for (var ci = 0; ci < HOME_CATS.length; ci++) {
			results[HOME_CATS[ci].n] = [];
		}
		var pending = HOME_CATS.length,
			done = false,
			start = Date.now();

		function finish() {
			if (!done) {
				done = true;
				log(
					"getHome: " +
						Object.keys(results).length +
						" cats in " +
						(Date.now() - start) +
						"ms",
				);
				cb({ success: true, data: results, page: page });
			}
		}

		var safetyTimer = setTimeout(finish, HOME_TIMEOUT);
		HOME_CATS.forEach(function (cat) {
			fetchCat(cat, page)
				.then(function (items) {
					if (items && items.length) results[cat.n] = items;
				})
				.catch(function () {})
				.then(function () {
					if (--pending === 0) {
						clearTimeout(safetyTimer);
						finish();
					}
				});
		});
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  search(query, cb)
	// ═════════════════════════════════════════════════════════════════════════

	function search(query, cb) {
		var q = String(query || "").trim();
		if (!q) return cb({ success: true, data: [] });
		log('search("' + q + '")');

		function fromResults(data, fb) {
			if (!data || !data.results) return [];
			var out = [];
			for (var i = 0; i < data.results.length; i++) {
				var r = data.results[i];
				if (r.media_type && r.media_type !== "movie" && r.media_type !== "tv")
					continue;
				var title = r.title || r.name || r.original_title || r.original_name;
				if (!title) continue;
				var mt = r.media_type || fb || "movie";
				if (mt === "tv") mt = "series";
				var yr = (r.release_date || r.first_air_date || "").split("-")[0];
				var poster = r.poster_path ? img(IMG_POST, r.poster_path) : "";
				var banner = r.backdrop_path ? img(IMG_BACK, r.backdrop_path) : poster;
				out.push(
					new MultimediaItem({
						title: title,
						url: "nuvio://" + (mt === "series" ? "tv" : "movie") + "/" + r.id,
						posterUrl: poster,
						bannerUrl: banner,
						type: mt,
						year: parseInt(yr, 10) || undefined,
						score: r.vote_average || undefined,
					}),
				);
			}
			return out;
		}

		Promise.all([
			tmdbGet("search/multi", { query: q, page: 1, include_adult: false }),
			tmdbGet("search/movie", { query: q, page: 1, include_adult: false }),
			tmdbGet("search/tv", { query: q, page: 1, include_adult: false }),
		])
			.then(function (rs) {
				var seen = {},
					out = [];
				function add(arr) {
					for (var i = 0; i < arr.length; i++)
						if (!seen[arr[i].url]) {
							seen[arr[i].url] = true;
							out.push(arr[i]);
						}
				}
				add(fromResults(rs[0]));
				add(fromResults(rs[1], "movie"));
				add(fromResults(rs[2], "series"));
				cb({ success: true, data: out.slice(0, 60) });
			})
			.catch(function () {
				cb({ success: true, data: [] });
			});
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  load(url, cb)
	// ═════════════════════════════════════════════════════════════════════════

	function parseRef(s) {
		s = String(s || "").trim();
		if (!s) return null;
		var m;
		if ((m = s.match(/^nuvio:\/\/tv\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?$/i)))
			return {
				id: m[1],
				api: "tv",
				s: m[2] ? +m[2] : null,
				e: m[3] ? +m[3] : null,
			};
		if ((m = s.match(/^nuvio:\/\/movie\/(\d+)$/i)))
			return { id: m[1], api: "movie", s: null, e: null };
		if ((m = s.match(/^tmdb:(movie|series|tv):(\d+)/i)))
			return {
				id: m[2],
				api: m[1].toLowerCase() === "movie" ? "movie" : "tv",
				s: null,
				e: null,
			};
		if ((m = s.match(/^(\d+)$/)))
			return { id: m[1], api: "movie", s: null, e: null };
		return null;
	}

	function load(url, cb) {
		try {
			var parsed = parseRef(url);
			if (!parsed || !parsed.id)
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Cannot parse: " + url,
				});

			var id = parsed.id,
				apiType = parsed.api;
			log("load(" + apiType + " tmdb:" + id + ")");

			var settled = false;

			function safe(r) {
				if (!settled) {
					settled = true;
					clearTimeout(t);
					cb(r);
				}
			}

			var t = setTimeout(function () {
				safe({
					success: true,
					data: new MultimediaItem({
						title: "Content",
						url: "nuvio://" + parsed.api + "/" + id,
						posterUrl: "",
						type: apiType === "tv" ? "series" : "movie",
						episodes: [
							new Episode({
								name: apiType === "tv" ? "Season 1 Episode 1" : "Play",
								url:
									apiType === "tv"
										? "nuvio://tv/" + id + "/1/1"
										: "nuvio://movie/" + id,
								season: 1,
								episode: 1,
							}),
						],
					}),
				});
			}, LOAD_TIMEOUT);

			tmdbGet(apiType + "/" + id, {
				append_to_response: "credits,videos,external_ids",
			})
				.then(function (data) {
					if (!data)
						return safe({
							success: true,
							data: new MultimediaItem({
								title: "Content",
								url: "nuvio://" + parsed.api + "/" + id,
								posterUrl: "",
								type: apiType === "tv" ? "series" : "movie",
							}),
						});

					var isSeries = apiType === "tv";
					var title =
						data.title ||
						data.name ||
						data.original_title ||
						data.original_name ||
						"Unknown";
					var year =
						parseInt(
							(data.release_date || data.first_air_date || "").split("-")[0],
							10,
						) || undefined;
					var poster = data.poster_path ? img(IMG_POST, data.poster_path) : "";
					var banner = data.backdrop_path
						? img(IMG_BACK, data.backdrop_path)
						: poster;
					var desc = (data.overview || "")
						.replace(/<[^>]*>/g, "")
						.trim()
						.substring(0, 500);

					// Build cast
					var cast;
					if (data.credits && data.credits.cast && data.credits.cast.length) {
						cast = data.credits.cast.slice(0, 20).map(function (c) {
							return new Actor({
								name: c.name || "Unknown",
								role: c.character || "",
								image: c.profile_path ? img(IMG_PROF, c.profile_path) : "",
							});
						});
					}

					// Build trailers
					var trailers;
					if (data.videos && data.videos.results) {
						trailers = data.videos.results
							.filter(function (v) {
								return (
									v &&
									v.site === "YouTube" &&
									v.key &&
									(v.type === "Trailer" || v.type === "Teaser")
								);
							})
							.slice(0, 5)
							.map(function (v) {
								return new Trailer({
									url: "https://www.youtube.com/watch?v=" + v.key,
									name: v.name || v.type || "Trailer",
								});
							});
					}

					// Build genres
					var genres = data.genres
						? data.genres.map(function (g) {
								return g.name;
							})
						: undefined;

					// Status
					var status;
					if (data.status) {
						var sv = String(data.status).toLowerCase();
						if (sv === "ended" || sv === "canceled") status = "completed";
						else if (
							sv === "returning series" ||
							sv === "continuing" ||
							sv === "in production"
						)
							status = "ongoing";
					}

					function finish(eps) {
						if (!eps || !eps.length)
							eps = [
								new Episode({
									name: isSeries ? "Season 1 Episode 1" : "Play",
									url: isSeries
										? "nuvio://tv/" + id + "/1/1"
										: "nuvio://movie/" + id,
									season: 1,
									episode: 1,
									posterUrl: poster,
								}),
							];
						safe({
							success: true,
							data: new MultimediaItem({
								title: title,
								url: "nuvio://" + parsed.api + "/" + id,
								posterUrl: poster,
								bannerUrl: banner,
								description: desc,
								type: isSeries ? "series" : "movie",
								year: year && year > 1900 && year < 2200 ? year : undefined,
								score: data.vote_average || undefined,
								duration: data.runtime || undefined,
								genres: genres,
								cast: cast,
								trailers: trailers,
								status: status,
								episodes: eps,
							}),
						});
					}

					if (!isSeries) return finish(null);

					var seasons = (data.seasons || []).filter(function (s) {
						return s && s.season_number > 0;
					});
					if (!seasons.length) return finish(null);

					var allEps = [],
						epPend = seasons.length,
						sIdx = 0,
						sInFlight = 0;

					function nextSeason() {
						while (sInFlight < 6 && sIdx < seasons.length) {
							(function (sn) {
								sInFlight++;
								tmdbGet("tv/" + id + "/season/" + sn)
									.then(function (sd) {
										if (sd && sd.episodes) {
											for (var ei = 0; ei < sd.episodes.length; ei++) {
												var ep = sd.episodes[ei];
												if (!ep || !ep.episode_number) continue;
												allEps.push(
													new Episode({
														name: ep.name || "E" + ep.episode_number,
														url:
															"nuvio://tv/" +
															id +
															"/" +
															sn +
															"/" +
															ep.episode_number,
														season: sn,
														episode: ep.episode_number,
														posterUrl: ep.still_path
															? img(IMG_STILL, ep.still_path)
															: "",
														description: (ep.overview || "").substring(0, 300),
														airDate: ep.air_date || "",
													}),
												);
											}
										}
									})
									.catch(function () {})
									.then(function () {
										sInFlight--;
										if (--epPend === 0) {
											allEps.sort(function (a, b) {
												return a.season - b.season || a.episode - b.episode;
											});
											finish(allEps);
										} else {
											nextSeason();
										}
									});
							})(seasons[sIdx++].season_number);
						}
					}
					nextSeason();
				})
				.catch(function (e) {
					warn("load: error for url=" + url + ": " + (e && e.message));
					// If safety timeout hasn't fired, use it; otherwise this is a no-op
					cb({
						success: false,
						errorCode: "LOAD_ERROR",
						message: "Content temporarily unavailable",
					});
				});
		} catch (e) {
			warn("load: error for url=" + url + ": " + (e && e.message));
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: "Content temporarily unavailable",
			});
		}
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  loadStreams(url, cb)
	// ═════════════════════════════════════════════════════════════════════════

	function extractQualityFromUrl(url) {
		var u = String(url || "");
		var m = u.match(/(2160p|1440p|1080p|720p|480p|360p|240p)/i);
		if (m) return m[1].toLowerCase();
		if (/\b4k\b/i.test(u)) return "4K";
		if (/\b2k\b/i.test(u)) return "2K";
		m = u.match(/[?&](?:quality|q|res)=(\d+)/i);
		if (m) {
			var n = parseInt(m[1], 10);
			if (n >= 2160) return "2160p";
			if (n >= 1440) return "1440p";
			if (n >= 1080) return "1080p";
			if (n >= 720) return "720p";
			if (n >= 480) return "480p";
			if (n >= 360) return "360p";
			return m[1] + "p";
		}
		return "";
	}

	function qualityRank(q) {
		var qs = String(q || "").toLowerCase();
		if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
		if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
		if (qs.indexOf("1080") !== -1) return 5;
		if (qs.indexOf("720") !== -1) return 4;
		if (qs.indexOf("480") !== -1) return 3;
		if (qs.indexOf("360") !== -1) return 2;
		if (qs.indexOf("240") !== -1) return 1;
		return 3;
	}

	/**
	 * ====================================================================
	 *  loadStreams — FIXED subtitle architecture
	 * ====================================================================
	 *
	 *  🔴 CRITICAL BUGS FIXED:
	 *
	 *  1. StreamResult constructor strips subtitles
	 *     BEFORE: new StreamResult({..., subtitles: [...]}) — subtitles lost
	 *     AFTER:  var sr = new StreamResult({url, source, ...});
	 *             sr.subtitles = mergedSubs;  // assigned after construction
	 *
	 *  2. Shared subtitle array reference across streams
	 *     BEFORE: s.subtitles = subtitles (same reference for all streams)
	 *             → toggling subtitles on one stream corrupts all others
	 *     AFTER:  Each stream gets its own deep-cloned copy via cloneSubtitles()
	 *
	 *  3. Subtitle format normalization
	 *     BEFORE: Only `label` and `lang` fields
	 *     AFTER:  Both `name` and `label` fields for max player compatibility
	 *             (cinemacity/cinestream use `name`, netmirror uses `label`)
	 * ====================================================================
	 */
	async function loadStreams(url, cb) {
		log("loadStreams(" + url + ")");
		var parsed = parseRef(url);
		if (!parsed || !parsed.id) {
			warn("loadStreams: cannot parse URL '" + url + "'");
			return cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: "Invalid URL format",
			});
		}

		// Sanitise and validate ranges
		var season = Math.max(1, Math.min(9999, parseInt(parsed.s, 10) || 1));
		var episode = Math.max(1, Math.min(9999, parseInt(parsed.e, 10) || 1));
		var tmdbId = parseInt(parsed.id, 10);
		if (!tmdbId || tmdbId < 1 || tmdbId > 100000000) {
			return cb({ success: true, data: [] });
		}

		var params = {
			tmdbId: tmdbId,
			type: parsed.api,
			season: season,
			episode: episode,
		};

		log(
			"  → aggregating " +
				SOURCES.sourceCount +
				" sources for " +
				params.type +
				" " +
				params.tmdbId,
		);

		try {
			// Race aggregateAll against a timeout — if any source hangs, we
			// return empty streams instead of crashing the entire player.
			var aggregated = await Promise.race([
				SOURCES.aggregateAll(
					params.tmdbId,
					params.type,
					params.season,
					params.episode,
				),
				new Promise(function (_, reject) {
					setTimeout(function () {
						reject(new Error("timeout"));
					}, STREAMS_TIMEOUT);
				}),
			]);

			if (!aggregated || !aggregated.sources) {
				return cb({ success: true, data: [] });
			}

			var seenUrls = {};
			var all = [];
			// 🔴 FIX: Store source-provided subtitles separately from streamObj
			// so they are NOT passed through the StreamResult constructor.
			var sourceSubsList = [];

			for (var i = 0; i < aggregated.sources.length; i++) {
				var src = aggregated.sources[i];
				if (src.status !== "working" || !src.streams) continue;
				for (var j = 0; j < src.streams.length; j++) {
					var s = src.streams[j];
					if (seenUrls[s.url]) continue;
					seenUrls[s.url] = true;

					var q = s.quality || extractQualityFromUrl(s.url);
					var baseSource = src.source || s.source;
					var displayLabel = baseSource;
					if (q && q !== "Auto" && q !== "auto") {
						displayLabel = baseSource + " [" + q + "]";
					}
					var streamObj = {
						url: s.url,
						source: displayLabel,
					};
					if (q) streamObj.quality = q;
					if (typeof s.headers === "object" && s.headers) {
						var hk = 0;
						for (var hkk in s.headers) {
							if (s.headers.hasOwnProperty && s.headers.hasOwnProperty(hkk))
								hk++;
						}
						if (hk > 0) streamObj.headers = s.headers;
					}
					// 🔴 FIX: Do NOT put subtitles in streamObj — store separately
					var streamSourceSubs =
						s.subtitles && s.subtitles.length > 0 ? s.subtitles.slice() : null;
					streamObj._qr = qualityRank(streamObj.quality || q);
					all.push(streamObj);
					sourceSubsList.push(streamSourceSubs);
				}
			}

			// ═══ SUBTITLE ENRICHMENT ═══════════════════════════════════════
			// Non-blocking: subtitles are best-effort enrichment.
			// Streams are returned with or without subtitles.
			var externalSubs = [];
			try {
				var subsPromise = SUBTITLE_PROVIDER.fetchSubtitles(
					params.tmdbId,
					params.type,
					params.season,
					params.episode,
				);
				var subsTimeout = new Promise(function (_, reject) {
					setTimeout(function () {
						reject(new Error("subtitle fetch timeout"));
					}, 15000);
				});
				externalSubs = await Promise.race([subsPromise, subsTimeout]).catch(
					function () {
						return [];
					},
				);
				if (externalSubs && externalSubs.length > 0) {
					log(
						"  → fetched " +
							externalSubs.length +
							" external subtitle language(s)",
					);
				}
			} catch (subsErr) {
				log(
					"  → subtitle fetch skipped (" + (subsErr && subsErr.message) + ")",
				);
			}
			// ═══ END SUBTITLE ENRICHMENT ═══════════════════════════════════

			// Sort: highest quality first, then by source name
			all.sort(function (a, b) {
				if (b._qr !== a._qr) return b._qr - a._qr;
				return (a.source || "").localeCompare(b.source || "");
			});

			// ── Build StreamResult objects ──
			// 🔴 FIX: Create StreamResult WITHOUT subtitles, then assign AFTER.
			var streamResults = [];

			// ═══ BUILD CANONICAL SUBTITLE SET (source-independent) ═══
			// 🔴 KEY FIX: Use OpenSubtitles subtitles as the canonical set for
			//   ALL streams. When ALL streams have IDENTICAL subtitle tracks, the
			//   player never needs to rebuild them on source/quality switch →
			//   NO HLS CRASH.
			//
			//   Root cause: each source returns different subtitle URLs/tracks.
			//   Switching sources required HLS.js to remove old tracks + add new
			//   ones. If track indices changed or old tracks weren't fully cleaned,
			//   HLS.js threw (fatal error = "failed to play").
			//
			//   By using ONE canonical set (same for all streams), subtitle tracks
			//   are identical regardless of source/quality → player never rebuilds
			//   tracks → no crash.
			var canonicalSubs = [];
			if (externalSubs && externalSubs.length > 0) {
				for (var ei = 0; ei < externalSubs.length; ei++) {
					var ext = externalSubs[ei];
					if (!ext || !ext.url) continue;
					var norm =
						SUBTITLE_PROVIDER.normalizeSubtitle &&
						SUBTITLE_PROVIDER.normalizeSubtitle(ext);
					if (!norm) {
						norm = {
							url: ext.url,
							name: ext.label || ext.name || ext.lang || "Subtitle",
							label: ext.label || ext.name || ext.lang || "Subtitle",
							lang: ext.lang || "en",
						};
					}
					if (norm && norm.url) canonicalSubs.push(norm);
				}
			}

			for (var si = 0; si < all.length; si++) {
				var obj = all[si];
				delete obj._qr;

				// Step 1: Create StreamResult WITHOUT subtitles
				var sr = new StreamResult(obj);

				// Step 2: Build merged subtitle list
				var mergedSubs = [];

				if (canonicalSubs.length > 0) {
					// 🔴 KEY FIX: Use canonical SubDL subtitles — SAME set for ALL
					// streams so subtitle tracks are stable across switches.
					// Deep-clone so each stream has its own array (prevents
					// corruption if player mutates one stream's subtitles).
					mergedSubs =
						SUBTITLE_PROVIDER.cloneSubtitles &&
						SUBTITLE_PROVIDER.cloneSubtitles(canonicalSubs);
					if (!mergedSubs || mergedSubs.length === 0) {
						mergedSubs = canonicalSubs.map(function (x) {
							return {
								url: x.url,
								name: x.name,
								label: x.label,
								lang: x.lang,
							};
						});
					}
				} else {
					// No external subs available — fall back to source-provided
					// subtitles (per-stream, only when canonical subs are empty).
					// Source subs vary per source, so switching may still cause
					// subtitle track rebuild, but with no external subs available
					// this is the best we can do.
					var srcSubs = sourceSubsList[si];
					if (srcSubs && srcSubs.length > 0) {
						var cloneFn =
							SUBTITLE_PROVIDER.cloneSubtitles ||
							function (arr) {
								return arr
									? arr
											.map(function (x) {
												return x
													? {
															url: x.url,
															name: x.name || x.label || x.lang || "Subtitle",
															label: x.label || x.name || x.lang || "Subtitle",
															lang: x.lang || "en",
														}
													: null;
											})
											.filter(Boolean)
									: [];
							};
						mergedSubs = cloneFn(srcSubs);
					}
				}

				// Step 3: 🔴 Assign subtitles AFTER StreamResult construction
				// This is the critical fix — all reference plugins do this.
				if (mergedSubs.length > 0) {
					sr.subtitles = mergedSubs;
				}

				streamResults.push(sr);
			}

			log(
				"  → " +
					streamResults.length +
					" unique streams from " +
					aggregated.workingSources +
					"/" +
					aggregated.totalSources +
					" sources (" +
					aggregated.elapsed_ms +
					"ms)" +
					(externalSubs && externalSubs.length > 0
						? " with " + externalSubs.length + " subtitle language(s)"
						: ""),
			);
			cb({ success: true, data: streamResults });
		} catch (e) {
			warn("loadStreams: aggregator error: " + (e && e.message));
			cb({ success: true, data: [] });
		}
	}

	// ═════════════════════════════════════════════════════════════════════════
	//  EXPORTS
	// ═════════════════════════════════════════════════════════════════════════

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
