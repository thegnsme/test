/**
 * Test script for lordflix, videasy_to, and vidsrc_xyz sources.
 * Run: node sources/test_sources.js [tmdbId] [type] [season] [episode]
 *
 * Examples:
 *   Movie:  node sources/test_sources.js 550 movie
 *   TV:     node sources/test_sources.js 1399 tv 1 1
 */
"use strict";

var tmdbId = parseInt(process.argv[2], 10) || 550; // Fight Club
var type = process.argv[3] || "movie";
var season = parseInt(process.argv[4], 10) || 1;
var episode = parseInt(process.argv[5], 10) || 1;

var params = { tmdbId: tmdbId, type: type, season: season, episode: episode };

console.log("\n============================================");
console.log(
	" Testing with: tmdbId=" +
		tmdbId +
		" type=" +
		type +
		(type === "tv" ? " S" + season + "E" + episode : ""),
);
console.log("============================================\n");

// ── Lordflix ──
async function testLordflix() {
	console.log("═══ lordflix ═══");
	try {
		var src = require("./lordflix");
		var start = Date.now();
		var result = await src.scrapeStreams(params);
		var ms = Date.now() - start;
		console.log("  Status:", result.status);
		console.log("  Error:", result.error || "(none)");
		console.log("  Streams:", (result.streams || []).length);
		console.log("  Latency:", ms + "ms");
		for (var i = 0; i < (result.streams || []).length && i < 20; i++) {
			var s = result.streams[i];
			console.log(
				"    [" +
					(i + 1) +
					"] " +
					(s.quality || "?") +
					"  url=" +
					(s.url || "").substring(0, 80) +
					"...",
			);
		}
		if ((result.streams || []).length > 20) {
			console.log(
				"    ... and " + ((result.streams || []).length - 20) + " more",
			);
		}
	} catch (e) {
		console.log("  CRASHED:", e.message);
	}
	console.log("");
}

// ── videasy.to ──
async function testVideasy() {
	console.log("═══ videasy.to ═══");
	try {
		var src = require("./videasy_to");
		var start = Date.now();
		var result = await src.scrapeStreams(params);
		var ms = Date.now() - start;
		console.log("  Status:", result.status);
		console.log("  Error:", result.error || "(none)");
		console.log("  Streams:", (result.streams || []).length);
		console.log("  Latency:", ms + "ms");
		for (var i = 0; i < (result.streams || []).length && i < 10; i++) {
			var s = result.streams[i];
			console.log(
				"    [" +
					(i + 1) +
					"] " +
					(s.quality || "?") +
					"  url=" +
					(s.url || "").substring(0, 80) +
					"...",
			);
		}
	} catch (e) {
		console.log("  CRASHED:", e.message);
	}
	console.log("");
}

// ── vidsrc.xyz ──
async function testVidsrc() {
	console.log("═══ vidsrc.xyz ═══");
	try {
		var src = require("./vidsrc_xyz");
		var start = Date.now();
		var result = await src.scrapeStreams(params);
		var ms = Date.now() - start;
		console.log("  Status:", result.status);
		console.log("  Error:", result.error || "(none)");
		console.log("  Streams:", (result.streams || []).length);
		console.log("  Latency:", ms + "ms");
		for (var i = 0; i < (result.streams || []).length && i < 10; i++) {
			var s = result.streams[i];
			console.log(
				"    [" +
					(i + 1) +
					"] " +
					(s.quality || "?") +
					"  url=" +
					(s.url || "").substring(0, 80) +
					"...",
			);
		}
	} catch (e) {
		console.log("  CRASHED:", e.message);
	}
	console.log("");
}

// ── Run all ──
async function main() {
	await testLordflix();
	await testVideasy();
	await testVidsrc();
	console.log("=== All tests complete ===");
}

main().catch(function (e) {
	console.error("Fatal:", e.message);
});
