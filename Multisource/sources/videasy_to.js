/**
 * videasy.to — HLS via encrypted API (Production)
 *
 * Decrypts via enc-dec.app, returns quality variants (1080p/720p/480p).
 * Each stream carries its own deep-cloned subtitles with proper labels.
 *
 * FIXED:
 *   • TMDB metadata integration — gets IMDB ID, title, year for API
 *   • Proper API URL construction with all available parameters
 *   • Subtitle deep-cloning per stream (no shared array references)
 *   • Origin header added for CDN access
 *   • Cleaner error handling
 *
 * FLOW:
 *   1. Fetch TMDB metadata (title, year, imdb_id)
 *   2. POST encrypted payload from videasy API (with TMDB metadata)
 *   3. Decrypt via enc-dec.app
 *   4. Parse response: sources[] with per-variant quality + subtitles[]
 *   5. Deep-clone subtitles per stream to avoid shared references
 *   6. Return streams quality-sorted descending
 *
 * ⚠ NOTE: The CDN (server.digitalsun.app) uses Cloudflare. Streams
 *   may not play from third-party contexts where Cloudflare clearance
 *   is unavailable. The scraper returns valid URLs — playback depends
 *   on the player's browser having Cloudflare clearance for the CDN.
 */

var { httpGet, httpPost, safeJsonParse, fetchTmdbMeta } = require("./_shared");

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

/**
 * Deep-clone an array of subtitle objects.
 * Each stream gets its OWN copy to prevent cross-stream corruption.
 */
function cloneSubtitles(subs) {
	if (!subs || !subs.length) return [];
	var cloned = [];
	for (var i = 0; i < subs.length; i++) {
		var s = subs[i];
		if (!s) continue;
		cloned.push({
			url: s.url,
			label: s.label || s.name || "VTT",
			lang: s.lang || "",
		});
	}
	return cloned;
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
		// ── Step 0: Fetch TMDB metadata for better API query ──
		var meta = await fetchTmdbMeta(params.tmdbId, params.type);
		var title = meta && meta.title ? encodeURIComponent(meta.title) : "";
		var year = meta && meta.year ? encodeURIComponent(meta.year) : "";
		var imdbId = meta && meta.imdb_id ? encodeURIComponent(meta.imdb_id) : "";

		// ── Step 1: Fetch encrypted payload from videasy API ──
		var apiUrl = VIDEO_API + "?title=" + title + "&mediaType=" + params.type;

		// Only include year/imdbId/tmdbId if we have them (avoid empty params)
		if (year) apiUrl += "&year=" + year;
		if (imdbId) apiUrl += "&imdbId=" + imdbId;
		apiUrl += "&tmdbId=" + String(params.tmdbId);

		if (params.type === "tv") {
			apiUrl +=
				"&season=" + (params.season || 1) + "&episode=" + (params.episode || 1);
		}

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

		// Build subtitles list (deduplicated by URL + language, deep-cloned per stream)
		var subs = [];
		var rawSubs = result.subtitles || [];
		var seenSubs = {};
		for (var j = 0; j < rawSubs.length; j++) {
			var sub = rawSubs[j];
			if (!sub || !sub.url) continue;
			var subLang = sub.language || sub.lang || "";
			var subLabel = sub.label || sub.name || subLang || "Unknown";
			// Deduplicate by URL to avoid identical subtitle tracks
			if (seenSubs[sub.url]) continue;
			seenSubs[sub.url] = true;
			subs.push({
				url: sub.url,
				label: subLabel,
				lang: subLang,
			});
		}
		// Cap at a reasonable number to avoid overwhelming the player
		if (subs.length > 30) {
			subs = subs.slice(0, 30);
		}

		// ── Step 4: Build streams with per-stream deep-cloned subtitles ──
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
					Origin: "https://videasy.to",
				},
				// 🔴 FIX: Deep-clone subtitles per stream — never share arrays
				subtitles: subs.length > 0 ? cloneSubtitles(subs) : undefined,
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
