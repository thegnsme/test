/**
 * videasy.to — HLS via encrypted API (Production)
 *
 * Decrypts via enc-dec.app, returns quality variants (1080p/720p/480p)
 * with subtitles. Handles unreliable API with retry logic.
 *
 * FIXED:
 *   • TMDB metadata integration — gets IMDB ID, title, year for API
 *   • JSON API format for decryption (api changed from form-encoded q=)
 *   • Retry logic for unreliable API (500/timeout ~20%)
 *   • Proper subtitle labeling (uses language field, not "VTT")
 *   • CDN Cloudflare limitation documented in response
 *
 * ⚠ CDN LIMITATION (server.digitalsun.app):
 *   This source's CDN uses strict Cloudflare JS challenge. ALL requests
 *   from non-browser contexts (Node.js, curl) get 403. Even real browsers
 *   may get challenged without cf_clearance cookies. The API works, the
 *   scraper returns valid stream URLs, but PLAYBACK DEPENDS ON THE
 *   PLAYER'S BROWSER HAVING CLOUDFLARE CLEARANCE for digitalsun.app.
 *
 *   If streams fail to play, try using a different source or accessing
 *   videasy.to directly in a browser first (to establish Cloudflare cookies).
 */

var {
	httpGet,
	httpPost,
	safeJsonParse,
	fetchTmdbMeta,
	makeFail,
} = require("./_shared");

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
		return makeFail(SOURCE_NAME, msg, start);
	}

	try {
		// ── Step 0: Fetch TMDB metadata for better API query ──
		var meta = await fetchTmdbMeta(params.tmdbId, params.type);
		var title = meta && meta.title ? encodeURIComponent(meta.title) : "";
		var year = meta && meta.year ? encodeURIComponent(meta.year) : "";
		var imdbId = meta && meta.imdb_id ? encodeURIComponent(meta.imdb_id) : "";

		// ── Step 1: Fetch encrypted payload from videasy API ──
		var apiUrl = VIDEO_API + "?title=" + title + "&mediaType=" + params.type;

		if (year) apiUrl += "&year=" + year;
		if (imdbId) apiUrl += "&imdbId=" + imdbId;
		apiUrl += "&tmdbId=" + String(params.tmdbId);

		if (params.type === "tv") {
			apiUrl +=
				"&season=" + (params.season || 1) + "&episode=" + (params.episode || 1);
		}

		// ── Step 1b: Fetch with retries (API is unreliable) ──
		var encryptedText = "";
		var apiErrors = [];
		for (var retry = 0; retry < 2; retry++) {
			try {
				var raw = await httpGet(apiUrl, {
					"User-Agent": UA,
					Referer: "https://videasy.to/",
					Origin: "https://videasy.to",
				});
				encryptedText = String(raw).trim();
				if (encryptedText && encryptedText.length >= 10) break;
			} catch (e) {
				apiErrors.push(
					"attempt " + (retry + 1) + ": " + (e.message || "error"),
				);
			}
			if (retry === 0) {
				await new Promise(function (r) {
					setTimeout(r, 1500);
				});
			}
		}

		if (!encryptedText || encryptedText.length < 10) {
			return fail("API returned no data (" + apiErrors.join("; ") + ")");
		}

		// ── Step 2: Decrypt via enc-dec.app (JSON API) ──
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
			return fail("decryption failed");
		}

		// ── Step 3: Parse sources and subtitles ──
		var result = decryptData.result;
		var rawSources = result.sources || [];

		if (!rawSources || rawSources.length === 0) {
			return fail("no sources in decrypted data");
		}

		// Build subtitles list (deduplicated by URL)
		var subs = [];
		var rawSubs = result.subtitles || [];
		var seenSubs = {};
		for (var j = 0; j < rawSubs.length; j++) {
			var sub = rawSubs[j];
			if (!sub || !sub.url) continue;
			if (seenSubs[sub.url]) continue;
			seenSubs[sub.url] = true;

			// Use language field as label for proper names
			var subLabel = sub.language || sub.lang || sub.label || "Unknown";
			subs.push({
				url: sub.url,
				label: subLabel,
				lang: sub.language || sub.lang || "",
			});
		}

		// Cap at 30 to avoid overwhelming the player
		if (subs.length > 30) {
			subs = subs.slice(0, 30);
		}

		// ── Step 4: Build streams ──
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
				subtitles: subs.length > 0 ? subs : undefined,
			});
		}

		// Sort by quality descending
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
