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
 * PRODUCTION FEATURES:
 *   • Source health tracking — sources with 3+ consecutive failures are
 *     temporarily skipped, preventing wasted requests on dead endpoints
 *   • Adaptive timeouts — TV content gets 45s, movies get 30s
 *   • Error classification — distinguishes timeout, network, and parse errors
 *   • Per-source latency tracking (logged at debug level)
 *   • All running via Promise.allSettled — one failing source never blocks others
 *   • manifest.baseUrl support for dynamic domain resolution
 *
 * That's it. plugin.js and _shared.js never need changes.
 */
"use strict";

// =========================================================================
//  SOURCE REGISTRY — Add new sources as ONE line each
// =========================================================================

var SOURCES_REGISTRY = {
	"vidlink.pro": require("./vidlink_pro"),
	"videasy.to": require("./videasy_to"),
	"vixsrc.to": require("./vixsrc_to"),
	lordflix: require("./lordflix"),
	"vidsrc.xyz": require("./vidsrc_xyz"),
	ezvidapi: require("./ezvidapi"),
	"apiplayer.ru": require("./apiplayer_ru"),
	// ═══ anyembed.xyz — API-based multi-quality HLS with subtitles ════
	"anyembed.xyz": require("./anyembed_xyz"),
	// ═════════════════════════════════════════════════════════════════════
	// ═══ REMOVED: broken sources ═══════════════════════════════════════
	// 2embed.cc      — site blocks requests ("embed page empty")
	// superembed.stream — same backend as multiembed.mov, both blocked
	// multiembed.mov    — directstream.php returns empty, page blocked
	// embedmaster.com   — embeds require Cloudflare Turnstile, can't play directly
	// mappletv.uk       — API returns valid M3U8 but all variants serve a
	//                     7-second tutorial/promo video, not real content
	// ═══════════════════════════════════════════════════════════════════
	// ── Add new sources above this line ──
};

// =========================================================================
//  CONFIGURATION
// =========================================================================

var SOURCE_TIMEOUT = 60000; // max time per source (TV needs longer)
var MOVIE_TIMEOUT = 35000; // shorter timeout for movies
var HEALTH_THRESHOLD = 3; // consecutive failures before source is skipped
var HEALTH_RESET_AFTER = 300000; // 5 min cooldown for unhealthy sources

// Per-source timeout overrides (for known slow sources)
var SOURCE_TIMEOUT_OVERRIDES = {
	lordflix: 45000, // 10 parallel servers, each makes 4 requests
	"anyembed.xyz": 30000, // API auth + provider fallback chain
	ezvidapi: 20000, // API-based multi-provider with M3U8 fetch
};

// =========================================================================
//  SOURCE HEALTH TRACKING
// =========================================================================

var _health = {};

function initHealth(name) {
	if (!_health[name]) {
		_health[name] = { failures: 0, lastFailure: 0, totalCalls: 0, totalMs: 0 };
	}
}

function recordSuccess(name, ms) {
	initHealth(name);
	_health[name].failures = 0;
	_health[name].totalCalls++;
	_health[name].totalMs += ms;
}

function recordFailure(name) {
	initHealth(name);
	_health[name].failures++;
	_health[name].lastFailure = Date.now();
	_health[name].totalCalls++;
}

function isHealthy(name) {
	initHealth(name);
	var h = _health[name];
	// If source has failed consecutively >= threshold, check cooldown
	if (h.failures >= HEALTH_THRESHOLD) {
		// Check if enough time has passed to retry
		if (Date.now() - h.lastFailure < HEALTH_RESET_AFTER) {
			return false;
		}
		// Reset failure count after cooldown
		h.failures = 0;
	}
	return true;
}

function getHealthReport() {
	var report = {};
	for (var name in _health) {
		var h = _health[name];
		report[name] = {
			healthy: h.failures < HEALTH_THRESHOLD,
			failures: h.failures,
			totalCalls: h.totalCalls,
			avgMs: h.totalCalls > 0 ? Math.round(h.totalMs / h.totalCalls) : 0,
		};
	}
	return report;
}

// =========================================================================
//  ERROR CLASSIFICATION
// =========================================================================

function classifyError(err) {
	if (!err) return "unknown";
	var msg = String(err.message || err).toLowerCase();
	if (msg.indexOf("timeout") !== -1) return "timeout";
	if (msg.indexOf("econnrefused") !== -1) return "connection_refused";
	if (msg.indexOf("enotfound") !== -1 || msg.indexOf("dns") !== -1)
		return "dns_error";
	if (msg.indexOf("etimedout") !== -1) return "connection_timeout";
	if (msg.indexOf("parse") !== -1 || msg.indexOf("json") !== -1)
		return "parse_error";
	if (msg.indexOf("429") !== -1 || msg.indexOf("rate limit") !== -1)
		return "rate_limited";
	if (msg.indexOf("403") !== -1 || msg.indexOf("forbidden") !== -1)
		return "forbidden";
	if (msg.indexOf("404") !== -1 || msg.indexOf("not found") !== -1)
		return "not_found";
	return "unknown";
}

// =========================================================================
//  PUBLIC API
// =========================================================================

function listSources() {
	return Object.keys(SOURCES_REGISTRY);
}

var sourceCount = Object.keys(SOURCES_REGISTRY).length;

/**
 * Aggregate streams from ALL registered sources.
 */
async function aggregateAll(tmdbId, type, season, episode) {
	var start = Date.now();
	var params = {
		tmdbId: parseInt(tmdbId, 10) || 0,
		type: type === "tv" ? "tv" : "movie",
		season: parseInt(season, 10) || 1,
		episode: parseInt(episode, 10) || 1,
	};

	// Adaptive timeout: TV has longer budget
	var defaultTimeout = type === "tv" ? SOURCE_TIMEOUT : MOVIE_TIMEOUT;

	var names = Object.keys(SOURCES_REGISTRY);
	var sourceTasks = [];

	for (var si = 0; si < names.length; si++) {
		var name = names[si];
		var src = SOURCES_REGISTRY[name];

		// Skip unhealthy sources (unless first run)
		if (!isHealthy(name)) {
			console.log(
				"[MultiSource:Health] Skipping " +
					name +
					" (" +
					_health[name].failures +
					" consecutive failures)",
			);
			sourceTasks.push(
				Promise.resolve({
					source: name,
					status: "unhealthy",
					error:
						"temporarily disabled after " +
						_health[name].failures +
						" failures",
					streams: [],
					latency_ms: 0,
				}),
			);
			continue;
		}

		// Per-source timeout override (if configured)
		var srcTimeout = SOURCE_TIMEOUT_OVERRIDES[name] || defaultTimeout;

		var task = (function (srcName, srcModule, srcTimeout) {
			var srcStart = Date.now();
			var timeoutPromise = new Promise(function (_, reject) {
				setTimeout(function () {
					reject(new Error("timeout after " + srcTimeout + "ms"));
				}, srcTimeout);
			});

			return Promise.race([
				Promise.resolve()
					.then(function () {
						return srcModule.scrapeStreams(params);
					})
					.then(function (result) {
						var ms = Date.now() - srcStart;
						if (
							result &&
							result.status === "working" &&
							result.streams &&
							result.streams.length > 0
						) {
							recordSuccess(srcName, ms);
							console.log(
								"[MultiSource:Source] " +
									srcName +
									" ✓ " +
									result.streams.length +
									" streams (" +
									ms +
									"ms)",
							);
						} else {
							recordFailure(srcName);
							var errMsg = (result && result.error) || "no streams";
							console.log(
								"[MultiSource:Source] " +
									srcName +
									" ✗ " +
									errMsg +
									" (" +
									ms +
									"ms)",
							);
						}
						if (!result || typeof result !== "object") {
							return {
								source: srcName,
								status: "error",
								error: "invalid return value",
								streams: [],
								latency_ms: ms,
							};
						}
						if (!result.source) result.source = srcName;
						result.latency_ms = ms;
						return result;
					})
					.catch(function (err) {
						var ms = Date.now() - srcStart;
						recordFailure(srcName);
						var category = classifyError(err);
						console.log(
							"[MultiSource:Error] " +
								srcName +
								" failed: " +
								(err.message || err) +
								" (" +
								category +
								", " +
								ms +
								"ms)",
						);
						return {
							source: srcName,
							status: "error",
							error: err.message || String(err),
							errorCategory: category,
							streams: [],
							latency_ms: ms,
						};
					}),
				timeoutPromise,
			]).catch(function (err) {
				var ms = Date.now() - srcStart;
				recordFailure(srcName);
				console.log(
					"[MultiSource:Error] " +
						srcName +
						" rejected by timeout: " +
						(err.message || err),
				);
				return {
					source: srcName,
					status: "error",
					error: err.message || "timeout",
					errorCategory: "timeout",
					streams: [],
					latency_ms: ms,
				};
			});
		})(name, src, srcTimeout);

		sourceTasks.push(task);
	}

	var results = await Promise.allSettled(sourceTasks);

	// ── Process results ──
	var sourcesOut = [];
	for (var i = 0; i < results.length; i++) {
		var r = results[i];
		if (r.status === "fulfilled") {
			sourcesOut.push(r.value);
		} else {
			// Promise.allSettled should never reject, but handle defensively
			sourcesOut.push({
				source: names[i] || "unknown",
				status: "error",
				error: (r.reason && r.reason.message) || "unknown failure",
				streams: [],
				latency_ms: Date.now() - start,
			});
		}
	}

	// ── Compute stats ──
	var working = 0;
	for (var w = 0; w < sourcesOut.length; w++) {
		if (
			sourcesOut[w].status === "working" &&
			sourcesOut[w].streams &&
			sourcesOut[w].streams.length > 0
		)
			working++;
	}

	// ── Deduplicate URLs across sources ──
	var allUrls = [];
	for (var u = 0; u < sourcesOut.length; u++) {
		var srcStreams = sourcesOut[u].streams || [];
		for (var v = 0; v < srcStreams.length; v++) allUrls.push(srcStreams[v].url);
	}
	var uniqueUrls = {};
	for (var ui = 0; ui < allUrls.length; ui++) {
		uniqueUrls[allUrls[ui]] = true;
	}

	// ── Sort: working sources first, then by status ──
	var STATUS_ORDER = {
		working: 0,
		embed: 1,
		no_streams: 2,
		unavailable: 3,
		unhealthy: 4,
		error: 5,
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
		totalStreams: Object.keys(uniqueUrls).length,
		elapsed_ms: Date.now() - start,
		sources: sourcesOut,
		health: getHealthReport(),
	};
}

module.exports = {
	aggregateAll: aggregateAll,
	listSources: listSources,
	sourceCount: sourceCount,
	getHealthReport: getHealthReport,
};
