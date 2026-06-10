/**
 * =============================================================================
 *  SOURCES BARREL — MultiSource Plugin
 *  =============================================================================
 *  This is the ONLY file that knows about all sources.
 *  plugin.js imports from here — never touches individual sources.
 *
 *  TO ADD A NEW SOURCE:
 *    1. Add a file in this directory (e.g., `mynewsource.js`)
 *    2. Every source must export: { name, scrapeStreams }
 *    3. Import it below and add to SOURCES array.
 *    4. Done — No changes needed in plugin.js!
 *
 *  TO REMOVE A SOURCE:
 *    Delete its import and remove from SOURCES array.
 *
 *  SOURCE CONTRACT:
 *    scrapeStreams({ tmdbId, type, season, episode })
 *      → { source, embedUrl, status, streams[], subtitles?, latency_ms }
 *      subtitles[]: { url, label, lang }  (label = "VTT", "SRT", etc.)
 * =============================================================================
 */

"use strict";

// ── Import all sources ──────────────────────────────────────────────────────
// Each source must export: { name: string, scrapeStreams: function }

var vidlinkPro = require("./vidlink_pro");
var videasyTo = require("./videasy_to");
var testStream = require("./test_stream");

// ── Source registry — add/remove sources here ───────────────────────────────
// lordflix_org.js is kept as a stub (requires browser JS execution — incompatible).
// Other disabled embed stubs: smashystream.js, vidsrc_icu.js, vidsrc_to.js, videasy_net.js

var SOURCES = [vidlinkPro, videasyTo, testStream];

// ── Constants ───────────────────────────────────────────────────────────────

var SOURCE_TIMEOUT = 30000; // 30s per source
var STATUS_ORDER = {
	working: 0,
	no_streams: 1,
	embed: 2,
	unavailable: 3,
	error: 4,
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * List all registered source names.
 */
function listSources() {
	var names = [];
	for (var i = 0; i < SOURCES.length; i++) {
		names.push(SOURCES[i].name);
	}
	return names;
}

/**
 * Number of registered sources.
 */
var sourceCount = SOURCES.length;

/**
 * Run all sources in parallel and aggregate results.
 *
 * @param {number} tmdbId  - TMDB ID
 * @param {string} type    - 'movie' or 'tv'
 * @param {number} season  - Season (for TV)
 * @param {number} episode - Episode (for TV)
 * @returns {Promise} Aggregated result object
 */
async function aggregateAll(tmdbId, type, season, episode) {
	var start = Date.now();
	var params = {
		tmdbId: parseInt(tmdbId, 10) || 0,
		type: type === "tv" ? "tv" : "movie",
		season: parseInt(season, 10) || 1,
		episode: parseInt(episode, 10) || 1,
	};

	// Run all sources in parallel with individual timeout
	var results = await Promise.allSettled(
		SOURCES.map(function (src) {
			var timeoutPromise = new Promise(function (_, reject) {
				setTimeout(function () {
					reject(new Error("timeout after " + SOURCE_TIMEOUT + "ms"));
				}, SOURCE_TIMEOUT);
			});

			return Promise.race([
				Promise.resolve()
					.then(function () {
						return src.scrapeStreams(params);
					})
					.catch(function (err) {
						return {
							source: src.name,
							status: "error",
							error: err.message,
							streams: [],
							latency_ms: Date.now() - start,
						};
					}),
				timeoutPromise,
			]).catch(function (err) {
				return {
					source: src.name,
					status: "error",
					error: err.message || "timeout",
					streams: [],
					latency_ms: Date.now() - start,
				};
			});
		}),
	);

	// Normalise results
	var sourcesOut = [];
	for (var i = 0; i < results.length; i++) {
		var r = results[i];
		if (r.status === "fulfilled") {
			var val = r.value;
			if (!val.source) val.source = SOURCES[i].name;
			sourcesOut.push(val);
		} else {
			sourcesOut.push({
				source: SOURCES[i].name,
				status: "error",
				error: (r.reason && r.reason.message) || "unknown",
				streams: [],
				latency_ms: Date.now() - start,
			});
		}
	}

	// Count working sources
	var working = 0;
	for (var w = 0; w < sourcesOut.length; w++) {
		if (
			sourcesOut[w].status === "working" &&
			sourcesOut[w].streams &&
			sourcesOut[w].streams.length > 0
		) {
			working++;
		}
	}

	// Collect unique stream URLs
	var allUrls = [];
	for (var u = 0; u < sourcesOut.length; u++) {
		var srcStreams = sourcesOut[u].streams || [];
		for (var v = 0; v < srcStreams.length; v++) {
			allUrls.push(srcStreams[v].url);
		}
	}
	var uniqUrls = new Set(allUrls);

	// Collect unique subtitles
	var allSubs = [];
	for (var si = 0; si < sourcesOut.length; si++) {
		var srcSubs = sourcesOut[si].subtitles || [];
		for (var sj = 0; sj < srcSubs.length; sj++) {
			if (srcSubs[sj]) allSubs.push(srcSubs[sj]);
		}
	}
	var seenSub = new Set();
	var uniqSubs = [];
	for (var sk = 0; sk < allSubs.length; sk++) {
		var sub = allSubs[sk];
		var key = (sub.url || "") + (sub.lang || "");
		if (!seenSub.has(key)) {
			seenSub.add(key);
			uniqSubs.push(sub);
		}
	}

	// Sort: working first, then no_streams, embed, unavailable, error
	sourcesOut.sort(function (a, b) {
		return (STATUS_ORDER[a.status] || 99) - (STATUS_ORDER[b.status] || 99);
	});

	return {
		success: true,
		tmdbId: parseInt(tmdbId, 10),
		type: type,
		workingSources: working,
		totalSources: SOURCES.length,
		totalStreams: uniqUrls.size,
		elapsed_ms: Date.now() - start,
		sources: sourcesOut,
		subtitles: uniqSubs.length > 0 ? uniqSubs : undefined,
	};
}

/**
 * Extract StreamResult-like objects from aggregated response.
 */
function extractStreamResults(aggregated) {
	if (!aggregated || !aggregated.sources) return [];
	var results = [];
	for (var i = 0; i < aggregated.sources.length; i++) {
		var src = aggregated.sources[i];
		if (src.status !== "working" || !src.streams) continue;
		for (var j = 0; j < src.streams.length; j++) {
			var st = src.streams[j];
			results.push({
				url: st.url,
				source: src.source + (st.quality ? " [" + st.quality + "]" : ""),
				quality: st.quality || "",
				headers: st.headers || {},
			});
		}
	}
	return results;
}

module.exports = {
	aggregateAll: aggregateAll,
	extractStreamResults: extractStreamResults,
	listSources: listSources,
	sourceCount: sourceCount,
};
