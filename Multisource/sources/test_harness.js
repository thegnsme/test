/**
 * SkyStream test harness — provides http_get/http_post globals for Node.js.
 * Run: node sources/test_harness.js [tmdbId] [type] [season] [episode]
 *
 * Examples:
 *   Movie:  node sources/test_harness.js 550 movie
 *   TV:     node sources/test_harness.js 1399 tv 1 1
 */
"use strict";

// ═══ SkyStream runtime globals mock ═══
var https = require("https");
var http = require("http");
var urlMod = require("url");

/**
 * http_get(url, headers)
 * SkyStream global — make HTTP GET request.
 * Returns a Promise resolving to {status, statusCode, body, headers}.
 */
globalThis.http_get = function (url, headers, callback) {
	if (typeof headers === "function") {
		callback = headers;
		headers = {};
	}
	return new Promise(function (resolve) {
		var parsed = urlMod.parse(url);
		var mod = parsed.protocol === "https:" ? https : http;
		var opts = {
			hostname: parsed.hostname,
			port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
			path: parsed.path + (parsed.hash || ""),
			method: "GET",
			headers: headers || {},
			timeout: 30000,
		};
		var req = mod.request(opts, function (res) {
			var data = "";
			res.on("data", function (chunk) {
				data += chunk;
			});
			res.on("end", function () {
				var response = {
					status: res.statusCode,
					statusCode: res.statusCode,
					body: data,
					headers: res.headers,
				};
				if (callback) callback(response);
				resolve(response);
			});
		});
		req.on("error", function (e) {
			var errResp = { status: 0, statusCode: 0, body: "", error: e.message };
			if (callback) callback(errResp);
			resolve(errResp);
		});
		req.on("timeout", function () {
			req.destroy();
			var errResp = { status: 0, statusCode: 0, body: "", error: "timeout" };
			if (callback) callback(errResp);
			resolve(errResp);
		});
		req.end();
	});
};

/**
 * http_post(url, headers, body)
 * SkyStream global — make HTTP POST request.
 * Returns a Promise resolving to {status, statusCode, body, headers}.
 */
globalThis.http_post = function (url, headers, body, callback) {
	if (typeof body === "function") {
		callback = body;
		body = "";
	}
	if (typeof headers === "function") {
		callback = headers;
		headers = {};
		body = "";
	}
	return new Promise(function (resolve) {
		var parsed = urlMod.parse(url);
		var mod = parsed.protocol === "https:" ? https : http;
		var postData = typeof body === "string" ? body : JSON.stringify(body || "");
		var opts = {
			hostname: parsed.hostname,
			port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
			path: parsed.path + (parsed.hash || ""),
			method: "POST",
			headers: Object.assign(
				{
					"Content-Type": "application/x-www-form-urlencoded",
					"Content-Length": Buffer.byteLength(postData),
				},
				headers || {},
			),
			timeout: 30000,
		};
		var req = mod.request(opts, function (res) {
			var data = "";
			res.on("data", function (chunk) {
				data += chunk;
			});
			res.on("end", function () {
				var response = {
					status: res.statusCode,
					statusCode: res.statusCode,
					body: data,
					headers: res.headers,
				};
				if (callback) callback(response);
				resolve(response);
			});
		});
		req.on("error", function (e) {
			var errResp = { status: 0, statusCode: 0, body: "", error: e.message };
			if (callback) callback(errResp);
			resolve(errResp);
		});
		req.on("timeout", function () {
			req.destroy();
			var errResp = { status: 0, statusCode: 0, body: "", error: "timeout" };
			if (callback) callback(errResp);
			resolve(errResp);
		});
		req.write(postData);
		req.end();
	});
};

// ═══ Mock MultimediaItem for sources that reference it ═══
globalThis.MultimediaItem = function (data) {
	return data || {};
};

globalThis.console = console;

// ═══ Run tests ═══
var tmdbId = parseInt(process.argv[2], 10) || 550;
var type = process.argv[3] || "movie";
var season = parseInt(process.argv[4], 10) || 1;
var episode = parseInt(process.argv[5], 10) || 1;

var params = { tmdbId: tmdbId, type: type, season: season, episode: episode };

console.log("\n╔════════════════════════════════════════════╗");
console.log("║  SkyStream Source Tester                   ║");
console.log(
	"║  tmdbId=" +
		tmdbId +
		" type=" +
		type +
		(type === "tv" ? " S" + season + "E" + episode : ""),
);
console.log("╚════════════════════════════════════════════╝\n");

var totalStart = Date.now();
var passed = 0;
var failed = 0;

async function testSource(name) {
	console.log("─── " + name + " ───");
	try {
		var src = require("./" + name);
		var start = Date.now();
		var result = await src.scrapeStreams(params);
		var ms = Date.now() - start;

		var streamCount = result && result.streams ? result.streams.length : 0;
		var isWorking = result && result.status === "working" && streamCount > 0;

		console.log("  Status:  " + ((result && result.status) || "?"));
		console.log("  Streams: " + streamCount);
		console.log("  Latency: " + ms + "ms");
		if (result && result.error) {
			console.log("  Error:   " + result.error);
		}

		if (isWorking) {
			passed++;
			// Show first 30 streams
			var maxShow = 30;
			for (var i = 0; i < streamCount && i < maxShow; i++) {
				var s = result.streams[i];
				var qual = s.quality || "?";
				var url = s.url || "";
				var truncated = url.length > 90 ? url.substring(0, 87) + "..." : url;
				console.log(
					"  [" +
						(i + 1 + "").padStart(2) +
						"] " +
						(qual + "                    ").substring(0, 22) +
						" " +
						truncated,
				);
			}
			if (streamCount > maxShow) {
				console.log("  ... and " + (streamCount - maxShow) + " more");
			}
			// Show subtitle/audio metadata on first stream
			if (streamCount > 0) {
				var first = result.streams[0];
				if (first.subtitles && first.subtitles.length > 0) {
					console.log("  Subs:    " + first.subtitles.length + " track(s)");
					for (var si = 0; si < first.subtitles.length && si < 5; si++) {
						console.log(
							"           [" +
								first.subtitles[si].lang +
								"] " +
								(first.subtitles[si].label || first.subtitles[si].name || "?"),
						);
					}
				}
				if (first.audio && first.audio.length > 0) {
					console.log("  Audio:   " + first.audio.length + " track(s)");
					for (var ai = 0; ai < first.audio.length && ai < 3; ai++) {
						console.log(
							"           [" +
								first.audio[ai].lang +
								"] " +
								(first.audio[ai].label || "?"),
						);
					}
				}
			}
		} else {
			failed++;
		}
	} catch (e) {
		console.log("  CRASHED: " + (e.message || e));
		failed++;
	}
	console.log("");
}

async function main() {
	await testSource("lordflix");
	await testSource("videasy_to");
	await testSource("vidsrc_xyz");

	var totalMs = Date.now() - totalStart;
	console.log("═══════════════════════════════════════════");
	console.log(
		"  Passed: " +
			passed +
			"  Failed: " +
			failed +
			"  Total: " +
			(passed + failed) +
			" sources",
	);
	console.log("  Elapsed: " + totalMs + "ms");
	console.log("═══════════════════════════════════════════");
}

main().catch(function (e) {
	console.error("FATAL:", e.message);
});
