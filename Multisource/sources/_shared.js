/**
 * =============================================================================
 *  SHARED HELPERS for MultiSource plugin sources (Production)
 * =============================================================================
 *
 *  Provides HTTP wrappers with retry, response caching, TMDB metadata helper,
 *  and quality detection utilities. Designed for both SkyStream QuickJS runtime
 *  and skystream-cli test environment.
 *
 *  PRODUCTION FEATURES:
 *    • httpGet/httpPost with configurable retry + exponential backoff
 *    • Simple response cache to avoid re-fetching in same session
 *    • fetchTmdbMeta with caching (reduces TMDB API calls)
 *          — Uses rotating TMDB API keys (same set as plugin.js) to avoid rate limits
 *    • Safe JSON parsing with fallback
 *    • URL quality detection helper (shared across sources)
 *    • M3U8 parsing helper (shared across sources that scrape HLS)
 *
 *  Usage:
 *      var { httpGet, httpPost, fetchTmdbMeta, safeJsonParse,
 *            extractQualityFromUrl, parseM3U8Best } = require("./_shared");
 *      var html = await httpGet("https://example.com");
 *      var meta = await fetchTmdbMeta(550, "movie");
 * =============================================================================
 */

// ═══ Rotating TMDB API keys (same set as plugin.js for load balancing) ═══
var TMDB_KEYS = [
	"68e094699525b18a70bab2f86b1fa706",
	"af3a53eb387d57fc935e9128468b1899",
	"0142a22c560ce3efb1cfd6f3b2faab77",
];
var _tmdbIdx = 0;
function tmdbKey() {
	return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
}

var TMDB_BASE = "https://api.themoviedb.org/3";

// ── Response cache (bounded LRU, per-session) ──
var _respCache = {};
var _respCacheKeys = [];
var _respCacheMax = 200;

var _metaCache = {};
var _metaCacheKeys = [];
var _metaCacheMax = 100;

function _cacheEvict(cache, keys, max) {
	while (keys.length >= max) {
		var oldKey = keys.shift();
		delete cache[oldKey];
	}
}

function _cachePut(cache, keys, max, key, val) {
	if (!cache[key]) {
		keys.push(key);
		_cacheEvict(cache, keys, max);
	}
	cache[key] = val;
}

// ── Defaults ──
var MAX_RETRIES = 1;
var RETRY_BASE_MS = 800;
var DEFAULT_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// =========================================================================
//  HTTP GET — with retry and caching
// =========================================================================

/**
 * Normalized HTTP GET with optional retry.
 * Resolves with the response body as a string.
 *
 * @param {string} url
 * @param {object} headers
 * @param {number} retries - Number of retry attempts (default: 1)
 * @returns {Promise<string>} response body
 */
async function httpGet(url, headers, retries) {
	var cacheKey = url + "|" + JSON.stringify(headers || {});
	if (_respCache[cacheKey] !== undefined) return _respCache[cacheKey];

	retries = retries !== undefined ? retries : MAX_RETRIES;
	var attempt = 0;
	var lastErr;

	while (attempt <= retries) {
		attempt++;
		try {
			var raw = await http_get(url, headers || {});
			var body = normalizeBody(raw);
			if (body !== "") {
				_cachePut(_respCache, _respCacheKeys, _respCacheMax, cacheKey, body);
				return body;
			}
		} catch (e) {
			lastErr = e;
		}
		if (attempt <= retries) {
			// Exponential backoff with jitter
			var delay =
				RETRY_BASE_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
			await sleep(delay);
		}
	}

	if (lastErr) throw lastErr;
	return "";
}

/**
 * Normalized HTTP POST with optional retry.
 *
 * @param {string} url
 * @param {object} headers
 * @param {string} body
 * @param {number} retries
 * @returns {Promise<string>} response body
 */
async function httpPost(url, headers, body, retries) {
	retries = retries !== undefined ? retries : MAX_RETRIES;
	var attempt = 0;
	var lastErr;

	while (attempt <= retries) {
		attempt++;
		try {
			var raw = await http_post(url, headers || {}, body || "");
			var result = normalizeBody(raw);
			if (result !== "") return result;
		} catch (e) {
			lastErr = e;
		}
		if (attempt <= retries) {
			var delay =
				RETRY_BASE_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
			await sleep(delay);
		}
	}

	if (lastErr) throw lastErr;
	return "";
}

// =========================================================================
//  INTERNAL HELPERS
// =========================================================================

function normalizeBody(raw) {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw.body === "string") return raw.body;
	if (raw && typeof raw.body === "object") return JSON.stringify(raw.body);
	var s = String(raw || "");
	return s === "undefined" ? "" : s;
}

function sleep(ms) {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

// =========================================================================
//  TMDB METADATA FETCHER (with caching + rotating keys)
// =========================================================================

/**
 * Fetch metadata from TMDB needed by some sources (title, year, imdb_id).
 * Results are cached in-memory to avoid redundant API calls.
 * Uses rotating API keys to distribute rate-limit load.
 *
 * @param {number|string} tmdbId - TMDB ID
 * @param {string} type - 'movie' or 'tv'
 * @returns {Promise<object>} { title, year, imdb_id } or null on failure
 */
async function fetchTmdbMeta(tmdbId, type) {
	var key = String(tmdbId) + ":" + (type || "movie");
	if (_metaCache[key] !== undefined) return _metaCache[key];

	try {
		var endpoint = type === "tv" ? "/tv/" : "/movie/";
		var url =
			TMDB_BASE +
			endpoint +
			String(tmdbId) +
			"?api_key=" +
			tmdbKey() +
			"&append_to_response=external_ids";
		var resp = await httpGet(url, {
			"User-Agent": DEFAULT_UA,
			Accept: "application/json",
		});
		var data = safeJsonParse(resp);
		if (!data) {
			_cachePut(_metaCache, _metaCacheKeys, _metaCacheMax, key, null);
			return null;
		}

		var title = data.title || data.name || "";
		var date = data.release_date || data.first_air_date || "";
		var year = date ? date.split("-")[0] : "";
		var imdbId =
			data.external_ids && data.external_ids.imdb_id
				? data.external_ids.imdb_id
				: data.imdb_id || "";

		var result = { title: title, year: year, imdb_id: imdbId };
		_cachePut(_metaCache, _metaCacheKeys, _metaCacheMax, key, result);
		return result;
	} catch (e) {
		return null;
	}
}

// =========================================================================
//  SAFE JSON PARSE
// =========================================================================

/**
 * Safely parse JSON string, returning null on failure instead of throwing.
 */
function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

// =========================================================================
//  QUALITY DETECTION (from URL)
// =========================================================================

/**
 * Extract quality label from a URL string.
 * Matches patterns like: 1080p, 720p, 4K, quality=1080, /1080/, _1080p_
 * Returns empty string if no quality hint found.
 */
function extractQualityFromUrl(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p|240p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	if (/\b2k\b/i.test(u)) return "2K";
	m = u.match(/[?&](?:quality|q|res)=(\d+)/i);
	if (m) {
		var n = parseInt(m[1], 10);
		if (n >= 2160) return "2160p";
		if (n >= 1440) return "1440p";
		if (n >= 1080) return "1080p";
		if (n >= 720) return "720p";
		if (n >= 480) return "480p";
		if (n >= 360) return "360p";
		return m[1] + "p";
	}
	return "";
}

// =========================================================================
//  M3U8 PARSING HELPERS
// =========================================================================

/**
 * Parse a master M3U8 playlist and ALL quality variants.
 * Returns array of { url, quality } sorted by quality descending.
 * Returns empty array if no variants found.
 *
 * This is the primary parser for multi-quality extraction.
 */
function parseM3U8AllQualities(m3u8Content, baseUrl) {
	if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
		return [];
	}

	var lines = m3u8Content.split("\n");
	var results = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var height = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl =
						urlPart.indexOf("http") === 0
							? urlPart
							: resolveRelativeUrl(baseUrl, urlPart);
					results.push({
						url: fullUrl,
						quality: height ? qualityLabel(height) : "Auto",
						height: height,
					});
				}
			}
		}
	}

	// Sort by height descending (highest quality first)
	results.sort(function (a, b) {
		return b.height - a.height;
	});

	return results;
}

/**
 * Parse a master M3U8 playlist and return the highest-quality variant.
 * Returns { url, quality } or null if no variants found.
 * Kept for backward compatibility — prefer parseM3U8AllQualities.
 *
 * @param {string} m3u8Content - Raw M3U8 playlist content
 * @param {string} baseUrl - Base URL for resolving relative paths
 * @returns {object|null} { url, quality } or null
 */
function parseM3U8Best(m3u8Content, baseUrl) {
	var all = parseM3U8AllQualities(m3u8Content, baseUrl);
	if (all.length > 0) {
		return { url: all[0].url, quality: all[0].quality };
	}
	return null;
}

/**
 * Convert M3U8 content to array of ALL quality streams.
 * Returns [{ url, quality, headers }] or empty array.
 *
 * This is the primary converter — returns ALL quality variants
 * from a master playlist instead of just the highest.
 */
function m3u8ToStreams(m3u8Content, baseUrl, extraHeaders) {
	var variants = parseM3U8AllQualities(m3u8Content, baseUrl);
	if (variants.length > 0) {
		var streams = [];
		for (var vi = 0; vi < variants.length; vi++) {
			var v = variants[vi];
			var stream = {
				url: v.url,
				quality: v.quality,
				headers: copyHeaders(extraHeaders),
			};
			if (
				baseUrl &&
				(!stream.headers.Referer || stream.headers.Referer === "")
			) {
				stream.headers.Referer = baseUrl;
			}
			streams.push(stream);
		}
		return streams;
	}

	// If no variants but valid M3U8, return original URL as fallback
	if (m3u8Content && m3u8Content.indexOf("#EXTM3U") !== -1) {
		var fallback = {
			url: baseUrl,
			quality: "Auto",
			headers: extraHeaders || {},
		};
		return [fallback];
	}

	return [];
}

/**
 * Shallow-copy headers object, skip nulls/undefined.
 */
function copyHeaders(obj) {
	if (!obj || typeof obj !== "object") return {};
	var out = {};
	for (var k in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, k)) {
			if (obj[k] != null) out[k] = obj[k];
		}
	}
	return out;
}

/**
 * Subtitles parser: extract subtitle tracks from M3U8 master playlist.
 * Returns array of { url, label, lang }.
 * Resolves relative subtitle URLs against baseUrl if provided.
 */
function extractSubtitlesFromM3U8(m3u8Content, baseUrl) {
	var subs = [];
	if (!m3u8Content) return subs;
	var lines = String(m3u8Content).split("\n");
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
			var urlMatch = line.match(/URI="([^"]+)"/);
			var langMatch = line.match(/LANGUAGE="([^"]+)"/);
			var nameMatch = line.match(/NAME="([^"]+)"/);
			if (urlMatch && urlMatch[1]) {
				var subUrl = urlMatch[1];
				if (baseUrl && subUrl.indexOf("http") !== 0) {
					subUrl = resolveRelativeUrl(baseUrl, subUrl);
				}
				subs.push({
					url: subUrl,
					label: (nameMatch && nameMatch[1]) || "VTT",
					lang: (langMatch && langMatch[1]) || "en",
				});
			}
		}
	}
	return subs;
}

function qualityLabel(height) {
	if (height >= 2160) return "2160p";
	if (height >= 1440) return "1440p";
	if (height >= 1080) return "1080p";
	if (height >= 720) return "720p";
	if (height >= 480) return "480p";
	if (height >= 360) return "360p";
	return height ? height + "p" : "Auto";
}

function resolveRelativeUrl(baseUrl, relativePath) {
	if (!baseUrl) return relativePath;
	if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
	// Absolute path (starts with /) — resolve against origin
	if (relativePath.indexOf("/") === 0) {
		var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (originMatch ? originMatch[1] : "") + relativePath;
	}
	// Relative path — resolve against directory of base URL
	return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}

// =========================================================================
//  EXTRACT JSON VALUE FROM HTML SCRIPT
// =========================================================================

/**
 * Extract a JSON-like value from HTML/script content using regex.
 * Matches patterns like:  key: 'value'  or  key: "value"
 *
 * @param {string} html - HTML or script content
 * @param {string} key - Key to search for
 * @returns {string} Extracted value or empty string
 */
function extractJsValue(html, key) {
	if (!html || !key) return "";
	var re = new RegExp(
		key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
			"\\s*[:=]\\s*['\"]([^'\"]+)['\"]",
		"i",
	);
	var m = html.match(re);
	return m ? m[1] : "";
}

// =========================================================================
//  QUALITY RANKING (for sorting streams by quality)
// =========================================================================

function qualityRank(q) {
	var qs = String(q || "").toLowerCase();
	if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
	if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
	if (qs.indexOf("1080") !== -1) return 5;
	if (qs.indexOf("720") !== -1) return 4;
	if (qs.indexOf("480") !== -1) return 3;
	if (qs.indexOf("360") !== -1) return 2;
	if (qs.indexOf("240") !== -1) return 1;
	return 3;
}

// =========================================================================
//  M3U8 FETCH + PARSE HELPER
// =========================================================================

/**
 * Fetch a M3U8 URL, parse all quality variants, return streams array.
 * One-liner for sources that have a master playlist URL.
 *
 * @param {string} playlistUrl - URL of the master M3U8
 * @param {object} reqHeaders - headers for fetching the playlist
 * @param {object} streamHeaders - headers to attach to each stream
 * @returns {Array} Array of stream objects [{url, quality, headers}]
 */
async function fetchM3U8AndParse(playlistUrl, reqHeaders, streamHeaders) {
	try {
		var resp = await httpGet(playlistUrl, reqHeaders || {});
		if (!resp || resp.length < 20) return [];
		var streams = m3u8ToStreams(resp, playlistUrl, streamHeaders || reqHeaders);
		return streams;
	} catch (e) {
		return [];
	}
}

// =========================================================================
//  EXPORTS
// =========================================================================

module.exports = {
	httpGet: httpGet,
	httpPost: httpPost,
	fetchTmdbMeta: fetchTmdbMeta,
	safeJsonParse: safeJsonParse,
	extractQualityFromUrl: extractQualityFromUrl,
	parseM3U8Best: parseM3U8Best,
	parseM3U8AllQualities: parseM3U8AllQualities,
	m3u8ToStreams: m3u8ToStreams,
	extractJsValue: extractJsValue,
	qualityLabel: qualityLabel,
	qualityRank: qualityRank,
	resolveRelativeUrl: resolveRelativeUrl,
	extractSubtitlesFromM3U8: extractSubtitlesFromM3U8,
	fetchM3U8AndParse: fetchM3U8AndParse,
	copyHeaders: copyHeaders,
};
