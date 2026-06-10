/**
 * SOURCES BARREL — loads all sources, runs them in parallel, aggregates results.
 * Each source returns streams that already have quality, headers, and subtitles.
 */
"use strict";

var vidlinkPro = require("./vidlink_pro");
var videasyTo = require("./videasy_to");
var testStream = require("./test_stream");

var SOURCES = [vidlinkPro, videasyTo, testStream];
var SOURCE_TIMEOUT = 30000;

function listSources() {
	var names = [];
	for (var i = 0; i < SOURCES.length; i++) names.push(SOURCES[i].name);
	return names;
}

var sourceCount = SOURCES.length;

async function aggregateAll(tmdbId, type, season, episode) {
	var start = Date.now();
	var params = {
		tmdbId: parseInt(tmdbId, 10) || 0,
		type: type === "tv" ? "tv" : "movie",
		season: parseInt(season, 10) || 1,
		episode: parseInt(episode, 10) || 1,
	};

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
		)
			working++;
	}

	// Collect unique stream URLs
	var allUrls = [];
	for (var u = 0; u < sourcesOut.length; u++) {
		var srcStreams = sourcesOut[u].streams || [];
		for (var v = 0; v < srcStreams.length; v++) allUrls.push(srcStreams[v].url);
	}
	var uniqUrls = new Set(allUrls);

	// Sort: working first
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
		totalSources: SOURCES.length,
		totalStreams: uniqUrls.size,
		elapsed_ms: Date.now() - start,
		sources: sourcesOut,
	};
}

module.exports = {
	aggregateAll: aggregateAll,
	listSources: listSources,
	sourceCount: sourceCount,
};
