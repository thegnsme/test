/**
 * =============================================================================
 *  MultiSource — SkyStream Plugin Dispatcher
 *  =============================================================================
 *
 *  ARCHITECTURE:
 *    plugin.js is a PURE DISPATCHER. All scraping logic lives in sources/*.js
 *    and is loaded via sources/index.js barrel. To add/edit/remove a source,
 *    only touch files in sources/ — never plugin.js.
 *
 *  HOW TO USE:
 *    1. Deploy via `skystream deploy` (bundles everything via esbuild)
 *    2. Or zip plugin.js + plugin.json into a .sky file manually
 *
 *  URL SCHEME:
 *    Movie:  nuvio://movie/{tmdbId}
 *    TV:     nuvio://tv/{tmdbId}/{season}/{episode}
 *
 *  FUNCTIONS:
 *    getHome(cb)      — TMDB trending/popular/airing dashboard
 *    search(q, cb)    — TMDB multi-search
 *    load(url, cb)    — TMDB details + episodes
 *    loadStreams(url, cb) — Calls ALL sources/*.js in parallel
 * =============================================================================
 */
(function () {
	"use strict";

	// =========================================================================
	//  CONSTANTS
	//  =========================================================================

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
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
	var HDR = {
		"User-Agent": UA,
		Accept: "application/json,text/plain,*/*",
	};

	// =========================================================================
	//  LOGGING
	//  =========================================================================

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

	// =========================================================================
	//  HTTP WRAPPER (Promise-based with timeout)
	//  =========================================================================

	function httpGet(url, headers, ms) {
		ms = ms || 12000;
		return new Promise(function (resolve) {
			var done = false;
			var t = setTimeout(function () {
				if (!done) {
					done = true;
					resolve({ status: 0, body: "", error: new Error("timeout") });
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

	// =========================================================================
	//  TMDB LAYER
	//  =========================================================================

	var _tmdbIdx = 0;
	function tmdbKey() {
		return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
	}

	function tmdbGet(endpoint, params) {
		var q = "api_key=" + tmdbKey();
		if (params)
			for (var k in params)
				if (params[k] != null)
					q +=
						"&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
		var url = TMDB_BASE + "/" + endpoint + "?" + q;
		return httpGet(url, HDR).then(function (r) {
			if (r.status >= 200 && r.status < 300 && r.body) {
				try {
					return JSON.parse(r.body);
				} catch (e) {}
			}
			return null;
		});
	}

	function img(size, p) {
		return p ? TMDB_IMG + "/" + (size || IMG_POST) + p : "";
	}

	function tmdbItem(r, fallback) {
		try {
			var title = r.title || r.name || r.original_title || r.original_name;
			if (!title) return null;
			var mt = r.media_type || fallback || "movie";
			if (mt === "tv") mt = "series";
			var poster = r.poster_path
				? img(IMG_POST, r.poster_path)
				: r.backdrop_path
					? img(IMG_BACK, r.backdrop_path)
					: "";
			var yr = (r.release_date || r.first_air_date || "").split("-")[0];
			var item = {
				title: title,
				url: "nuvio://" + (mt === "series" ? "tv" : "movie") + "/" + r.id,
				posterUrl: poster,
				bannerUrl: r.backdrop_path ? img(IMG_BACK, r.backdrop_path) : poster,
				type: mt,
			};
			var y = parseInt(yr, 10);
			if (y && y > 1900 && y < 2200) item.year = y;
			if (r.vote_average) item.score = parseFloat(r.vote_average);
			return item;
		} catch (e) {
			return null;
		}
	}

	// =========================================================================
	//  LOAD SOURCES — imports from sources/index.js barrel
	//  =========================================================================
	//  The barrel exports { aggregateAll, extractStreamResults, listSources }.
	//  During skystream deploy, esbuild resolves and inlines these imports.
	//  =========================================================================

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
			extractStreamResults: function () {
				return [];
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

	// ╔════════════════════════════════════════════════════════════════════════╗
	// ║  CORE FUNCTION: getHome(cb, page)                                    ║
	// ╚════════════════════════════════════════════════════════════════════════╝

	var HOME_CATS = [
		{ n: "Trending Now", ep: "trending/all/week", t: null, m: true },
		{ n: "Trending Movies", ep: "trending/movie/week", t: "movie", m: false },
		{ n: "Trending Series", ep: "trending/tv/week", t: "series", m: false },
		{ n: "Airing Today", ep: "tv/airing_today", t: "series", m: false },
		{ n: "Top Rated Movies", ep: "movie/top_rated", t: "movie", m: false },
		{ n: "Top Rated Series", ep: "tv/top_rated", t: "series", m: false },
	];

	function fetchCat(cat) {
		return tmdbGet(cat.ep, { page: 1 }).then(function (d) {
			if (!d || !d.results) return { items: [] };
			var seen = {},
				out = [];
			for (var i = 0; i < d.results.length; i++) {
				var item = tmdbItem(d.results[i], cat.t);
				if (item && !seen[item.url]) {
					seen[item.url] = true;
					out.push(item);
					if (out.length >= 20) break;
				}
			}
			return { items: out };
		});
	}

	function getHome(cb, page) {
		log("getHome(page=" + (page || 1) + ")");
		var results = {},
			pending = HOME_CATS.length,
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
				cb({ success: true, data: results, page: parseInt(page) || 1 });
			}
		}

		setTimeout(finish, 10000);
		HOME_CATS.forEach(function (cat) {
			fetchCat(cat)
				.then(function (r) {
					if (r && r.items && r.items.length) results[cat.n] = r.items;
				})
				.catch(function () {})
				.then(function () {
					if (--pending === 0) finish();
				});
		});
	}

	// ╔════════════════════════════════════════════════════════════════════════╗
	// ║  CORE FUNCTION: search(query, cb)                                    ║
	// ╚════════════════════════════════════════════════════════════════════════╝

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
				var item = tmdbItem(r, fb);
				if (item) out.push(item);
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

	// ╔════════════════════════════════════════════════════════════════════════╗
	// ║  CORE FUNCTION: load(url, cb)                                        ║
	// ╚════════════════════════════════════════════════════════════════════════╝

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

	function fallbackItem(parsed, id) {
		var isTv = parsed.api === "tv";
		return {
			title: "Content",
			url: "nuvio://" + parsed.api + "/" + id,
			posterUrl: "",
			type: isTv ? "series" : "movie",
			episodes: [
				{
					name: isTv ? "Season 1 Episode 1" : "Play",
					url: isTv ? "nuvio://tv/" + id + "/1/1" : "nuvio://movie/" + id,
					season: 1,
					episode: 1,
				},
			],
		};
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
			var loadBudget = apiType === "tv" ? 35000 : 15000;
			var t = setTimeout(function () {
				safe({ success: true, data: fallbackItem(parsed, id) });
			}, loadBudget);

			tmdbGet(apiType + "/" + id, {
				append_to_response: "credits,videos,external_ids",
			})
				.then(function (data) {
					if (!data)
						return safe({ success: true, data: fallbackItem(parsed, id) });

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
					var poster = data.poster_path
						? img(IMG_POST, data.poster_path)
						: data.backdrop_path
							? img(IMG_BACK, data.backdrop_path)
							: "";
					var banner = data.backdrop_path
						? img(IMG_BACK, data.backdrop_path)
						: poster;

					var cast;
					if (data.credits && data.credits.cast && data.credits.cast.length)
						cast = data.credits.cast.slice(0, 20).map(function (c) {
							return {
								name: c.name || "Unknown",
								role: c.character || "",
								image: c.profile_path ? img(IMG_PROF, c.profile_path) : "",
							};
						});

					var trailers;
					if (data.videos && data.videos.results)
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
								return {
									url: "https://www.youtube.com/watch?v=" + v.key,
									name: v.name || v.type || "Trailer",
								};
							});

					var genres = data.genres
						? data.genres.map(function (g) {
								return g.name;
							})
						: undefined;
					var desc = (data.overview || "")
						.replace(/<[^>]*>/g, "")
						.trim()
						.substring(0, 500);

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
								{
									name: isSeries ? "Season 1 Episode 1" : "Play",
									url: isSeries
										? "nuvio://tv/" + id + "/1/1"
										: "nuvio://movie/" + id,
									season: 1,
									episode: 1,
									posterUrl: poster,
								},
							];
						safe({
							success: true,
							data: {
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
							},
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
												allEps.push({
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
												});
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
				.catch(function () {
					safe({ success: true, data: fallbackItem(parsed, id) });
				});
		} catch (e) {
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: e.message || String(e),
			});
		}
	}

	// ╔════════════════════════════════════════════════════════════════════════╗
	// ║  CORE FUNCTION: loadStreams(url, cb)                                 ║
	// ╚════════════════════════════════════════════════════════════════════════╝
	//  Calls ALL sources in parallel, aggregates streams, passes through
	//  each stream object with only: url, source, quality, headers, subtitles.
	//  No StreamResult constructor — plain objects only.
	//  =========================================================================

	function loadStreams(url, cb) {
		log("loadStreams(" + url + ")");
		var parsed = parseRef(url);
		if (!parsed || !parsed.id) {
			warn("loadStreams: cannot parse URL '" + url + "'");
			return cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: "Cannot parse: " + url,
			});
		}

		var param = {
			tmdbId: parseInt(parsed.id, 10),
			type: parsed.api,
			season: parsed.s || 1,
			episode: parsed.e || 1,
		};

		log(
			"  → aggregating " +
				SOURCES.sourceCount +
				" sources for " +
				param.type +
				" " +
				param.tmdbId,
		);

		SOURCES.aggregateAll(param.tmdbId, param.type, param.season, param.episode)
			.then(function (aggregated) {
				if (!aggregated || !aggregated.sources) {
					return cb({ success: true, data: [] });
				}

				var all = [];
				for (var i = 0; i < aggregated.sources.length; i++) {
					var src = aggregated.sources[i];
					if (src.status !== "working" || !src.streams) continue;
					for (var j = 0; j < src.streams.length; j++) {
						var s = src.streams[j];
						// Build minimal stream object — only fields the player needs
						var obj = {
							url: s.url,
							source: src.source,
							quality: s.quality || "",
						};
						// Only add headers if they exist and aren't empty
						if (
							s.headers &&
							typeof s.headers === "object" &&
							Object.keys(s.headers).length > 0
						) {
							obj.headers = s.headers;
						}
						// Only add subtitles if provided by the source
						if (s.subtitles && s.subtitles.length > 0) {
							obj.subtitles = s.subtitles;
						}
						all.push(obj);
					}
				}

				log(
					"  → " +
						all.length +
						" streams from " +
						aggregated.workingSources +
						"/" +
						aggregated.totalSources +
						" sources (" +
						aggregated.elapsed_ms +
						"ms)",
				);
				cb({ success: true, data: all });
			})
			.catch(function (e) {
				warn("loadStreams: aggregator error: " + (e && e.message));
				cb({ success: true, data: [] });
			});
	}

	// =========================================================================
	//  EXPORTS
	//  =========================================================================

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
