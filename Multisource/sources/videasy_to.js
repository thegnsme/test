/**
 * videasy.to — HLS via encrypted API
 *
 * Decrypts via enc-dec.app, returns 3 quality variants (1080p/720p/480p).
 * Each stream carries its own subtitles.
 */
var { httpGet, httpPost } = require("./_shared");
var SOURCE_NAME = "videasy.to";
var VIDEO_API = "https://api.videasy.to/cdn/sources-with-title";
var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// Step 1: Call videasy API
		var apiUrl =
			VIDEO_API +
			"?title=&mediaType=" +
			type +
			"&year=&tmdbId=" +
			String(tmdbId) +
			"&imdbId=" +
			(type === "tv" ? "&season=" + season + "&episode=" + episode : "");

		var encryptedText = String(
			await httpGet(apiUrl, {
				"User-Agent": UA,
				Referer: "https://videasy.to/",
				Origin: "https://videasy.to",
			}),
		).trim();

		if (!encryptedText || encryptedText.length < 10) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		// Step 2: Decrypt
		var decryptData = JSON.parse(
			await httpPost(
				DECRYPT_API,
				{
					"Content-Type": "application/json",
					"User-Agent": UA,
				},
				JSON.stringify({ text: encryptedText, id: String(tmdbId) }),
			),
		);

		if (!decryptData || decryptData.status !== 200 || !decryptData.result) {
			return fail("decryption failed");
		}

		var result = decryptData.result;
		var rawSources = result.sources || [];

		// Build subtitles (shared across all quality variants)
		var subs = [];
		var rawSubs = result.subtitles || [];
		var seen = {};
		for (var j = 0; j < rawSubs.length; j++) {
			var sub = rawSubs[j];
			if (sub && sub.url && !seen[sub.url]) {
				seen[sub.url] = true;
				subs.push({
					url: sub.url,
					label: "VTT",
					lang: sub.language || sub.lang || "en",
				});
			}
		}

		// Build streams — each stream carries its own subtitles
		var streams = [];
		for (var i = 0; i < rawSources.length; i++) {
			var s = rawSources[i];
			if (s && s.url) {
				streams.push({
					url: s.url,
					quality: s.quality || "",
					headers: { "User-Agent": UA, Referer: "https://videasy.to/" },
					subtitles: subs.length > 0 ? subs : undefined,
				});
			}
		}

		return {
			source: SOURCE_NAME,
			status: streams.length > 0 ? "working" : "no_streams",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail(e.message);
	}

	function fail(msg) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: msg || "unknown",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
