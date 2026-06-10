/**
 * SOURCES BARREL — Add/remove sources here, nothing else to touch.
 *
 * TO ADD A SOURCE:
 *   1. Create file.js that exports { name, scrapeStreams }
 *   2. Add ONE line below:   sourceName: require("./file")
 *      (The key is what shows in the stream list)
 *
 * TO REMOVE A SOURCE:
 *   1. Delete the file
 *   2. Delete its ONE line below
 *
 * That's it. plugin.js and _shared.js never need changes.
 */
"use strict";

var SOURCES_REGISTRY = {
	"vidlink.pro": require("./vidlink_pro"),
	"videasy.to": require("./videasy_to"),
	// ── Add new sources above this line ──
};

var SOURCE_TIMEOUT = 30000;

function listSources() {
	return Object.keys(SOURCES_REGISTRY);
}

var sourceCount = Object.keys(SOURCES_REGISTRY).length;

async function aggregateAll(tmdbId, type, season, episode) {
	var start = Date.now();
	var params = {
		tmdbId: parseInt(tmdbId, 10) || 0,
		type: type === "tv" ? "tv" : "movie",
		season: parseInt(season, 10) || 1,
		episode: parseInt(episode, 10) || 1,
	};

	var names = Object.keys(SOURCES_REGISTRY);
	var results = await Promise.allSettled(
		names.map(function (name) {
			var src = SOURCES_REGISTRY[name];
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
							source: name,
							status: "error",
							error: err.message,
							streams: [],
							latency_ms: Date.now() - start,
						};
					}),
				timeoutPromise,
			]).catch(function (err) {
				return {
					source: name,
					status: "error",
					error: err.message || "timeout",
					streams: [],
					latency_ms: Date.now() - start,
				};
			});
		}),
	);

	var sourcesOut = [];
	for (var i = 0; i < results.length; i++) {
		var r = results[i];
		if (r.status === "fulfilled") {
			var val = r.value;
			if (!val.source) val.source = names[i];
			sourcesOut.push(val);
		} else {
			sourcesOut.push({
				source: names[i],
				status: "error",
				error: (r.reason && r.reason.message) || "unknown",
				streams: [],
				latency_ms: Date.now() - start,
			});
		}
	}

	var working = 0;
	for (var w = 0; w < sourcesOut.length; w++) {
		if (
			sourcesOut[w].status === "working" &&
			sourcesOut[w].streams &&
			sourcesOut[w].streams.length > 0
		)
			working++;
	}

	var allUrls = [];
	for (var u = 0; u < sourcesOut.length; u++) {
		var srcStreams = sourcesOut[u].streams || [];
		for (var v = 0; v < srcStreams.length; v++) allUrls.push(srcStreams[v].url);
	}

	var STATUS_ORDER = {
		working: 0,
		no_streams: 1,
		embed: 2,
		unavailable: 3,
		error: 4,
	};
	sourcesOut.sort(function (a, b) {
		return (STATUS_ORDER[a.status] || 99) - (STATUS_ORDER[b.status] || 99);
	});

	return {
		success: true,
		tmdbId: parseInt(tmdbId, 10),
		type: type,
		workingSources: working,
		totalSources: names.length,
		totalStreams: new Set(allUrls).size,
		elapsed_ms: Date.now() - start,
		sources: sourcesOut,
	};
}

module.exports = {
	aggregateAll: aggregateAll,
	listSources: listSources,
	sourceCount: sourceCount,
};
