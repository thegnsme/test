/**
 * =============================================================================
 *  SOURCE: videasy.to — HLS Direct via Encrypted API
 *  =============================================================================
 *  CHAIN:
 *    1. api.videasy.to/cdn/sources-with-title?tmdbId={id}&mediaType={type}
 *       → encrypted string (includes title, year, poster metadata)
 *    2. enc-dec.app/api/dec-videasy POST { text, id }
 *       → { sources: [{quality, url, ...}], subtitles: [...] }
 *
 *  QUALITIES: 1080p, 720p, 480p (varies by content)
 *  SUBTITLES: Multi-language VTT
 * =============================================================================
 */

var { httpGet, httpPost } = require("./_shared");
var SOURCE_NAME = "videasy.to";
var VIDEO_API = "https://api.videasy.to/cdn/sources-with-title";
var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	var embedUrl =
		"https://videasy.to/" +
		(type === "movie" ? "movie" : "show") +
		"/" +
		tmdbId +
		(type === "tv" ? "/season/" + season + "/episode/" + episode : "");

	try {
		// ── Step 1: Call videasy API to get encrypted data ────────────────────
		var apiUrl =
			VIDEO_API +
			"?title=&mediaType=" +
			type +
			"&year=&tmdbId=" +
			String(tmdbId) +
			"&imdbId=" +
			(type === "tv" ? "&season=" + season + "&episode=" + episode : "");

		var apiResp;
		try {
			apiResp = await httpGet(apiUrl, {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				Referer: "https://videasy.to/",
				Origin: "https://videasy.to",
			});
		} catch (e) {
			return errorResult("API request failed: " + e.message);
		}

		var encryptedText =
			apiResp && typeof apiResp === "string"
				? apiResp.trim()
				: String(apiResp || "");
		if (!encryptedText || encryptedText.length < 10) {
			return {
				source: SOURCE_NAME,
				embedUrl: embedUrl,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		// ── Step 2: Decrypt via enc-dec.app ───────────────────────────────────
		var decryptResp;
		try {
			decryptResp = await httpPost(
				DECRYPT_API,
				{
					"Content-Type": "application/json",
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
				JSON.stringify({ text: encryptedText, id: String(tmdbId) }),
			);
		} catch (e) {
			return errorResult("decryption request failed: " + e.message);
		}

		var decryptData = JSON.parse(decryptResp);
		if (!decryptData || decryptData.status !== 200 || !decryptData.result) {
			return errorResult("decryption failed: invalid response");
		}

		var result = decryptData.result;
		var rawSources = result.sources || [];

		// Build streams
		var streams = [];
		for (var i = 0; i < rawSources.length; i++) {
			var s = rawSources[i];
			if (s && s.url) {
				streams.push({
					url: s.url,
					type: "hls",
					quality: s.quality || "",
					resolution: s.quality ? qToRes(s.quality) : "",
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
						Referer: "https://videasy.to/",
					},
				});
			}
		}

		// Build subtitles — API returns: { url, lang, language }
		var rawSubtitles = result.subtitles || [];
		var subtitles = [];
		var seenSub = {};
		for (var j = 0; j < rawSubtitles.length; j++) {
			var sub = rawSubtitles[j];
			if (sub && sub.url && !seenSub[sub.url]) {
				seenSub[sub.url] = true;
				subtitles.push({
					url: sub.url,
					label: "VTT",
					lang: sub.language || sub.lang || "unknown",
				});
			}
		}

		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: streams.length > 0 ? "working" : "no_streams",
			streams: streams,
			subtitles: subtitles.length > 0 ? subtitles : undefined,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return errorResult(e.message);
	}

	function errorResult(msg) {
		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "error",
			error: msg || "unknown error",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

// Quality label to resolution helper
var QUALITY_RES = {
	"4K": "3840x2160",
	"2160p": "3840x2160",
	"1080p": "1920x1080",
	"720p": "1280x720",
	"480p": "854x480",
	"360p": "640x360",
};

function qToRes(q) {
	return QUALITY_RES[q] || "";
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
