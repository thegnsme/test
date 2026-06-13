"use strict";

/**
 * PrimeSrc Source — primesrc.me
 *
 * API-based source: queries a REST endpoint by TMDB ID to get
 * a list of available video servers, then resolves each to a
 * playable M3U8 URL.
 *
 * Flow:
 *   1. GET /api/v1/s?tmdb={id}&type=movie|tv → server list
 *   2. For each server: GET /api/v1/l?key={key} → redirect URL
 *   3. Check if URL is already M3U8; if not, fetch the page and
 *      try to extract an M3U8 from it (supports common embed hosts)
 *
 * Ported from: streamflix-reborn PrimeSrcExtractor.kt
 *
 * @module sources/primesrc
 */

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

var SOURCE_NAME = "primesrc";
var BASE_URL = "https://primesrc.me";

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function makeFail(src, msg, start) {
	return {
		source: src,
		status: "error",
		error: msg || "unknown",
		streams: [],
		latency_ms: Date.now() - (start || Date.now()),
	};
}

function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
}

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

async function httpGet(url, headers) {
	var raw = await globalThis.http_get(url, headers || {});
	if (typeof raw === "string") return raw;
	if (raw && raw.body) {
		if (typeof raw.body === "string") return raw.body;
		if (typeof raw.body === "object") return JSON.stringify(raw.body);
	}
	return "";
}

function getBaseUrl(url) {
	var m = url.match(/^(https?:\/\/[^/]+)/);
	return m ? m[1] : "";
}

// ═════════════════════════════════════════════════════════════════════════════
// Embed page M3U8 extraction (fallback for non-direct URLs)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Try to extract a direct M3U8 URL from an embed page HTML.
 * Supports common patterns:
 *   - Direct M3U8 URL in the page
 *   - source: "..." or file: "..." in JS
 *   - iframe with M3U8 src
 */
function extractM3u8FromHtml(html, pageUrl) {
	if (!html) return null;

	var patterns = [
		// Direct M3U8 URL
		/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/gi,
		// source/file: "URL" in JS
		/(?:source|file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
		// iframe src
		/<iframe[^>]*src=["']([^"']+\.m3u8[^"']*)["']/i,
	];

	// Try direct M3U8 regex first
	var dm = html.match(patterns[0]);
	if (dm && dm[0]) return dm[0];

	// Try source/file pattern
	var sm = html.match(patterns[1]);
	if (sm) return resolveUrl(pageUrl, sm[1]);

	return null;
}

function resolveUrl(base, path) {
	if (!path) return "";
	if (path.indexOf("//") === 0) return "https:" + path;
	if (path.indexOf("http") === 0) return path;
	if (path.indexOf("/") === 0) return getBaseUrl(base) + path;
	return base.replace(/\/[^/]*$/, "/") + path;
}

// ═════════════════════════════════════════════════════════════════════════════
// API interaction
// ═════════════════════════════════════════════════════════════════════════════

function buildApiUrl(tmdbId, type, season, episode) {
	var base = BASE_URL + "/api/v1/s?tmdb=" + tmdbId;
	if (type === "tv" || type === "show") {
		base += "&type=tv&season=" + (season || 1) + "&episode=" + (episode || 1);
	} else {
		base += "&type=movie";
	}
	return base;
}

/**
 * Fetch server list from PrimeSrc API.
 */
async function fetchServers(tmdbId, type, season, episode) {
	var apiUrl = buildApiUrl(tmdbId, type, season, episode);
	var raw = await httpGet(apiUrl, {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Referer: BASE_URL,
	});
	if (!raw) throw new Error("Empty API response");

	var data = safeJsonParse(raw);
	if (!data || !data.servers || !Array.isArray(data.servers)) {
		throw new Error("Invalid API response format");
	}
	return data.servers;
}

/**
 * Resolve a server key to a playable URL.
 */
async function resolveServerKey(key) {
	var url = BASE_URL + "/api/v1/l?key=" + encodeURIComponent(key);
	var raw = await httpGet(url, {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Referer: BASE_URL,
	});
	if (!raw) throw new Error("Empty link response");

	var data = safeJsonParse(raw);
	if (!data || !data.link) throw new Error("No link in response");
	return data.link;
}

/**
 * Try to get a playable M3U8 URL from a given URL.
 * If the URL already ends with .m3u8, return it directly.
 * Otherwise, fetch the page and try to extract an M3U8.
 */
async function resolveToM3u8(linkUrl) {
	// Already an M3U8 URL
	if (linkUrl.indexOf(".m3u8") > 0) return linkUrl;

	// Fetch the page and try to extract M3U8
	var html = await httpGet(linkUrl, {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Referer: getBaseUrl(linkUrl),
	});
	if (!html) return null;

	var extracted = extractM3u8FromHtml(html, linkUrl);
	return extracted;
}

// ═════════════════════════════════════════════════════════════════════════════
// scrapeStreams
// ═════════════════════════════════════════════════════════════════════════════

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = parseInt(params.tmdbId, 10);
	if (!tmdbId || tmdbId < 1) {
		return makeFail(SOURCE_NAME, "invalid tmdbId", start);
	}

	try {
		// Step 1: Get server list
		var servers = await fetchServers(
			tmdbId,
			params.type,
			params.season,
			params.episode,
		);

		if (!servers || servers.length === 0) {
			return makeFail(SOURCE_NAME, "no servers returned", start);
		}

		// Step 2: Resolve each server key to a playable URL
		var streams = [];
		var seenUrls = {};

		for (var si = 0; si < servers.length; si++) {
			var server = servers[si];
			var key = server.key;
			var name = server.name || "Server " + (si + 1);

			try {
				var linkUrl = await resolveServerKey(key);
				if (!linkUrl) continue;

				var m3u8Url = await resolveToM3u8(linkUrl);
				if (!m3u8Url || seenUrls[m3u8Url]) continue;
				seenUrls[m3u8Url] = true;

				var q = extractQuality(m3u8Url) || "Auto";
				var displayLabel = name + " (PrimeSrc)";
				if (q && q !== "Auto") displayLabel += " [" + q + "]";

				streams.push({
					url: m3u8Url,
					source: displayLabel,
					quality: q,
					headers: {
						Referer: getBaseUrl(linkUrl),
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					},
				});
			} catch (e) {
				// Skip failed servers
				continue;
			}
		}

		if (streams.length === 0) {
			return makeFail(SOURCE_NAME, "no playable streams resolved", start);
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return makeFail(SOURCE_NAME, e && e.message ? e.message : String(e), start);
	}
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
