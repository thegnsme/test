"use strict";

/**
 * MultiSource aggregator.
 *
 * Loads all source modules via static require() and provides
 * a unified aggregateAll() interface for the main plugin.
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  TO ADD/REMOVE A SOURCE: add/remove one line below in      ║
 * ║  _sourceEntries. That's the ONLY place to edit.            ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

var TAG = "SourceAggregator";

// ─── Static Module Loading ────────────────────────────────────────────
// quick_js_ng only resolves require() with static string literals.
// Dynamic require("./" + name) does NOT work.
// Each source is pre-loaded here with its filename + module.

var _subtitlesProvider = require("./subtitles_provider");

var _sourceEntries = [
	["apiplayer_ru", require("./apiplayer_ru")],
	["ezvidapi", require("./ezvidapi")],
	["lordflix", require("./lordflix")],
	["mapple_uk", require("./mapple_uk")],
	["vidcore_net", require("./vidcore_net")],
	["videasy_to", require("./videasy_to")],
	["vidking_net", require("./vidking_net")],
	["vidlink_pro", require("./vidlink_pro")],
	["vidsrc", require("./vidsrc")],
	["vixsrc", require("./vixsrc")],
];

// ─── Build Module Registry ────────────────────────────────────────────

var sourceModules = {};
var sourceNames = [];

for (var ei = 0; ei < _sourceEntries.length; ei++) {
	var entry = _sourceEntries[ei];
	var filename = entry[0];
	var mod = entry[1];
	if (mod && mod.name && typeof mod.scrapeStreams === "function") {
		sourceModules[mod.name] = mod;
		sourceNames.push(mod.name);
	} else {
		console.warn("[" + TAG + "] Source '" + filename + "' invalid or missing");
	}
}

console.log(
	"[" +
		TAG +
		"] Loaded " +
		sourceNames.length +
		" source(s): " +
		sourceNames.join(", "),
);

// ─── Stream URL Validation ────────────────────────────────────────────

function isValidStreamUrl(url) {
	if (!url || typeof url !== "string") return false;
	if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0)
		return false;
	var hostMatch = url.match(/^https?:\/\/([^/]+)/);
	if (!hostMatch) return false;
	var host = hostMatch[1].toLowerCase();
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.indexOf("169.254.") === 0 ||
		host.indexOf("10.") === 0 ||
		host.indexOf("172.16.") === 0 ||
		host.indexOf("192.168.") === 0
	)
		return false;
	// Reject embed/page URLs that are NOT M3U8
	var path = url.substring(url.indexOf("/", 8) + 1);
	if (
		path.indexOf("embed/") === 0 ||
		path.indexOf("/embed/") !== -1 ||
		path.indexOf("tv/") === 0 ||
		path.indexOf("movie/") === 0
	) {
		if (url.indexOf(".m3u8") === -1 && url.indexOf(".m3u") === -1) return false;
	}
	return true;
}

// ─── Aggregation ──────────────────────────────────────────────────────

/**
 * Call all sources in parallel for given content.
 * Each source returns { source, status, streams, latency_ms }.
 * Streams with invalid URLs or embed pages are filtered out.
 */
function aggregateAll(tmdbId, type, season, episode) {
	var start = Date.now();
	var params = {
		tmdbId: tmdbId,
		type: type,
		season: season || 1,
		episode: episode || 1,
	};

	var PER_SOURCE_TIMEOUT = 35000; // 35s max per source

	var promises = [];
	for (var si = 0; si < sourceNames.length; si++) {
		var name = sourceNames[si];
		var mod = sourceModules[name];
		(function (srcName, module) {
			promises.push(
				Promise.race([
					module.scrapeStreams(params),
					new Promise(function (resolve) {
						setTimeout(function () {
							resolve({
								source: srcName,
								status: "error",
								error: "timeout (" + PER_SOURCE_TIMEOUT + "ms)",
								streams: [],
								latency_ms: PER_SOURCE_TIMEOUT,
							});
						}, PER_SOURCE_TIMEOUT);
					}),
				])
					.then(function (result) {
						if (!result) {
							return {
								source: srcName,
								status: "error",
								error: "no result",
								streams: [],
								latency_ms: Date.now() - start,
							};
						}
						// Normalize result
						if (!result.streams) result.streams = [];
						if (!Array.isArray(result.streams)) {
							result.streams = [result.streams];
						}
						result.source = result.source || srcName;

						// Validate stream URLs — reject embed pages and invalid URLs
						var valid = [];
						for (var vi = 0; vi < result.streams.length; vi++) {
							var s = result.streams[vi];
							if (s && s.url && isValidStreamUrl(s.url)) {
								valid.push(s);
							}
						}
						result.streams = valid;

						return result;
					})
					.catch(function (e) {
						return {
							source: srcName,
							status: "error",
							error: e && e.message ? e.message : String(e),
							streams: [],
							latency_ms: Date.now() - start,
						};
					}),
			);
		})(name, mod);
	}

	return Promise.all(promises).then(function (results) {
		var workingSources = 0;
		var totalStreams = 0;
		var debugLines = [];
		for (var ri = 0; ri < results.length; ri++) {
			var r = results[ri];
			if (r.status === "working") {
				workingSources++;
				totalStreams += r.streams.length;
			} else {
				debugLines.push(
					r.source +
						"=" +
						(r.status || "error") +
						(r.error ? ":" + r.error : ""),
				);
			}
		}
		if (debugLines.length > 0) {
			console.log("[" + TAG + "] Failed: " + debugLines.join(", "));
		}
		console.log(
			"[" +
				TAG +
				"] " +
				workingSources +
				"/" +
				sourceNames.length +
				" sources returned " +
				totalStreams +
				" streams in " +
				(Date.now() - start) +
				"ms",
		);
		return {
			success: true,
			sources: results,
			workingSources: workingSources,
			totalSources: sourceNames.length,
			totalStreams: totalStreams,
			elapsed_ms: Date.now() - start,
		};
	});
}

function listSources() {
	return sourceNames.slice();
}

module.exports = {
	aggregateAll: aggregateAll,
	listSources: listSources,
	sourceCount: sourceNames.length,
	getSubtitleProvider: function () {
		return _subtitlesProvider;
	},
};
