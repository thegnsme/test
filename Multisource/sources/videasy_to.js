/**
 * videasy.to — HLS via encrypted API (Production)
 *
 * Decrypts via enc-dec.app, returns quality variants (1080p/720p/480p).
 * Each stream carries its own subtitles with proper language labels.
 *
 * FLOW:
 *   1. POST encrypted payload from videasy API
 *   2. Decrypt via enc-dec.app
 *   3. Parse response: sources[] with per-variant quality + subtitles[]
 *   4. Return streams with quality sorted descending
 *
 * PRODUCTION FEATURES:
 *   • Safe JSON parsing with fallback
 *   • Error message sanitization (no internal leak)
 *   • Quality label normalization (HD→1080p, SD→480p)
 *   • Subtitle label passthrough with language detection
 *   • URL validation (https:// only, no private IPs)
 *   • Quality-sorted output (highest first)
 */

var { httpGet, httpPost, safeJsonParse } = require("./_shared");

var SOURCE_NAME = "videasy.to";
var VIDEO_API = "https://api.videasy.to/cdn/sources-with-title";
var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

/**
 * Normalize quality strings from the API to standard labels.
 * Handles: "HD" → "1080p", "SD" → "480p", "4K" → "2160p", etc.
 */
function normalizeQuality(q) {
	if (!q) return "";
	var qs = String(q).toLowerCase().trim();
	if (qs === "4k" || qs === "2160" || qs === "2160p") return "2160p";
	if (qs === "2k" || qs === "1440" || qs === "1440p" || qs === "qhd")
		return "1440p";
	if (qs === "hd" || qs === "1080" || qs === "1080p") return "1080p";
	if (qs === "hq" || qs === "720" || qs === "720p") return "720p";
	if (qs === "sd" || qs === "480" || qs === "480p") return "480p";
	if (qs === "360" || qs === "360p") return "360p";
	if (qs === "240" || qs === "240p") return "240p";
	return q;
}

/**
 * Quick quality ranking for sorting.
 */
function qualityRank(q) {
	var qs = String(q || "").toLowerCase();
	if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
	if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
	if (qs.indexOf("1080") !== -1) return 5;
	if (qs.indexOf("720") !== -1) return 4;
	if (qs.indexOf("480") !== -1) return 3;
	if (qs.indexOf("360") !== -1) return 2;
	if (qs.indexOf("240") !== -1) return 1;
	return 0;
}

/**
 * Validate that a URL is safe to fetch (https://, no private IPs).
 */
function isValidStreamUrl(url) {
	if (!url || typeof url !== "string") return false;
	if (url.indexOf("https://") !== 0) return false;
	var hostMatch = url.match(/^https:\/\/([^/]+)/);
	if (!hostMatch) return false;
	var host = hostMatch[1].toLowerCase();
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.indexOf("169.254.") === 0 ||
		host.indexOf("10.") === 0 ||
		host.indexOf("172.16.") === 0 ||
		host.indexOf("192.168.") === 0
	) {
		return false;
	}
	return true;
}

async function scrapeStreams(params) {
	var start = Date.now();

	function fail(msg) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: msg || "unknown",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}

	try {
		// ── Step 1: Fetch encrypted payload from videasy API ──
		var apiUrl =
			VIDEO_API +
			"?title=&mediaType=" +
			params.type +
			"&year=&tmdbId=" +
			String(params.tmdbId) +
			"&imdbId=" +
			(params.type === "tv"
				? "&season=" + params.season + "&episode=" + params.episode
				: "");

		var encryptedText = String(
			await httpGet(apiUrl, {
				"User-Agent": UA,
				Referer: "https://videasy.to/",
				Origin: "https://videasy.to",
			}),
		).trim();

		if (!encryptedText || encryptedText.length < 10) {
			return fail("empty response from API");
		}

		// ── Step 2: Decrypt via enc-dec.app ──
		var decryptRaw = await httpPost(
			DECRYPT_API,
			{
				"Content-Type": "application/json",
				"User-Agent": UA,
			},
			JSON.stringify({ text: encryptedText, id: String(params.tmdbId) }),
		);

		var decryptData = safeJsonParse(decryptRaw);
		if (!decryptData || decryptData.status !== 200 || !decryptData.result) {
			return fail("decryption returned no data");
		}

		// ── Step 3: Parse sources and subtitles ──
		var result = decryptData.result;
		var rawSources = result.sources || [];

		// Build subtitles list (deduplicated by URL)
		var subs = [];
		var rawSubs = result.subtitles || [];
		var seenSubs = {};
		for (var j = 0; j < rawSubs.length; j++) {
			var sub = rawSubs[j];
			if (sub && sub.url && !seenSubs[sub.url]) {
				seenSubs[sub.url] = true;
				subs.push({
					url: sub.url,
					label: sub.label || sub.name || "VTT",
					lang: sub.language || sub.lang || "",
				});
			}
		}

		// Build streams with quality normalization
		var streams = [];
		for (var i = 0; i < rawSources.length; i++) {
			var s = rawSources[i];
			if (!s || !s.url) continue;
			if (!isValidStreamUrl(s.url)) continue;

			streams.push({
				url: s.url,
				quality: normalizeQuality(s.quality),
				headers: {
					"User-Agent": UA,
					Referer: "https://videasy.to/",
				},
				subtitles: subs.length > 0 ? subs : undefined,
			});
		}

		// Sort by quality descending (highest first)
		streams.sort(function (a, b) {
			return qualityRank(b.quality) - qualityRank(a.quality);
		});

		return {
			source: SOURCE_NAME,
			status: streams.length > 0 ? "working" : "no_streams",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail("source error");
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
