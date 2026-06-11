/**
 * =============================================================================
 *  Subtitle Provider — SubDL + SubSource Integration (Production)
 * =============================================================================
 *
 * Fetches subtitles from SubDL and SubSource APIs using TMDB → IMDB mapping
 * for accurate content matching (movie, TV series, anime).
 *
 * ARCHITECTURE:
 *   This module is NOT a stream source. It enriches streams WITH subtitles.
 *   It exports:
 *     fetchSubtitles(tmdbId, type, season, episode)
 *       → Promise<Array<{ url, label, lang }>>
 *
 *   plugin.js calls this after aggregating streams, attaching subtitles
 *   to streams that lack them (or augmenting all streams).
 *
 * SUBTITLE API KEYS (configurable via plugin.json settings or env vars):
 *   • SubDL:     subdl_2UBZXxejmmdfmlH4ZMyfDhpLDaSGCMIb3TelEAjjbMk
 *   • SubSource:  sk_296c674d051b9c4cc6d3ad148bd8a624986c0d6e3279f4ff6aa6acd907c3d703
 *
 * USAGE:
 *   var { fetchSubtitles } = require("./subtitles_provider");
 *   var subs = await fetchSubtitles(550, "movie", 1, 1);
 *   // subs = [ { url: "...", label: "English", lang: "en" }, ... ]
 * =============================================================================
 */

"use strict";

var { httpGet, safeJsonParse, fetchTmdbMeta } = require("./_shared");

// ═════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═════════════════════════════════════════════════════════════════════════

var TAG = "SubProvider";

var SUBDL_API_BASE = "https://api.subdl.com/api/v1";
var SUBDL_DL_BASE = "https://dl.subdl.com";
var SUBDL_API_KEY = "subdl_2UBZXxejmmdfmlH4ZMyfDhpLDaSGCMIb3TelEAjjbMk";

var SUBSOURCE_API_BASE = "https://api.subsource.net/api/v1";
var SUBSOURCE_API_KEY =
	"sk_296c674d051b9c4cc6d3ad148bd8a624986c0d6e3279f4ff6aa6acd907c3d703";

var SUBDL_TIMEOUT = 10000;
var SUBSOURCE_TIMEOUT = 10000;
var TMDB_TIMEOUT = 8000;

// SubSource language mapping (API name → iso code)
var SUBSOURCE_LANG_MAP = {
	english: "en",
	spanish: "es",
	spanish_latin_america: "es",
	french: "fr",
	german: "de",
	portuguese: "pt",
	brazilian_portuguese: "pb",
	italian: "it",
	russian: "ru",
	japanese: "ja",
	korean: "ko",
	chinese: "zh",
	chinese_simplified: "zh",
	chinese_traditional: "zh",
	arabic: "ar",
	dutch: "nl",
	polish: "pl",
	turkish: "tr",
	swedish: "sv",
	danish: "da",
	finnish: "fi",
	norwegian: "no",
	hebrew: "he",
	hindi: "hi",
	thai: "th",
	vietnamese: "vi",
	indonesian: "id",
	romanian: "ro",
	czech: "cs",
	hungarian: "hu",
	greek: "el",
	bulgarian: "bg",
	croatian: "hr",
	serbian: "sr",
	ukrainian: "uk",
	farsi_persian: "fa",
	malay: "ms",
	estonian: "et",
	latvian: "lv",
	lithuanian: "lt",
	slovak: "sk",
	slovenian: "sl",
	bengali: "bn",
	tagalog: "tl",
	bosnian: "bs",
	macedonian: "mk",
	albanian: "sq",
	georgian: "ka",
	icelandic: "is",
	catalan: "ca",
	basque: "eu",
	galician: "gl",
	welsh: "cy",
	swahili: "sw",
	malayalam: "ml",
	tamil: "ta",
	telugu: "te",
	urdu: "ur",
	punjabi: "pa",
	nepali: "ne",
	sinhala: "si",
	khmer: "km",
	lao: "lo",
	burmese: "my",
	mongolian: "mn",
	afrikaans: "af",
	kurdish: "ku",
};

// SubDL language mapping (2-letter code → iso 639-1)
var SUBDL_LANG_OVERRIDES = {
	BR_PT: "pb",
};

// ═════════════════════════════════════════════════════════════════════════
//  LOGGING
// ═════════════════════════════════════════════════════════════════════════

function log() {
	try {
		console.log.apply(
			console,
			["[" + TAG + "]"].concat([].slice.call(arguments)),
		);
	} catch (e) {}
}
function warn() {
	try {
		console.warn.apply(
			console,
			["[" + TAG + "]"].concat([].slice.call(arguments)),
		);
	} catch (e) {}
}

// ═════════════════════════════════════════════════════════════════════════
//  TMDB → IMDB MAPPING
// ═════════════════════════════════════════════════════════════════════════

var _imdbCache = {};

/**
 * Resolve TMDB ID to IMDB ID (ttXXXX format).
 * Uses the plugin.js cache layer if available (global tmdbGet),
 * otherwise fetches directly from TMDB API.
 *
 * @param {number} tmdbId
 * @param {string} type - "movie" or "tv"
 * @returns {Promise<string|null>} imdb_id (e.g. "tt1375666") or null
 */
async function tmdbToImdb(tmdbId, type) {
	var key = String(tmdbId) + ":" + type;
	if (_imdbCache[key] !== undefined) return _imdbCache[key];

	try {
		// Use global tmdbGet if available (from plugin.js context)
		if (typeof tmdbGet === "function") {
			var data = await tmdbGet(type + "/" + tmdbId, {
				append_to_response: "external_ids",
			});
			if (data && data.external_ids && data.external_ids.imdb_id) {
				var imdb = data.external_ids.imdb_id;
				_imdbCache[key] = imdb;
				return imdb;
			}
			// Also check data.imdb_id directly
			if (data && data.imdb_id) {
				_imdbCache[key] = data.imdb_id;
				return data.imdb_id;
			}
		}

		// Fallback: use fetchTmdbMeta from _shared.js
		var meta = await fetchTmdbMeta(tmdbId, type);
		if (meta && meta.imdb_id) {
			_imdbCache[key] = meta.imdb_id;
			return meta.imdb_id;
		}

		return null;
	} catch (e) {
		warn("tmdbToImdb(" + tmdbId + "," + type + ") error: " + e.message);
		return null;
	}
}

// ═════════════════════════════════════════════════════════════════════════
//  SUBDL API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch subtitles from SubDL API using IMDB ID.
 *
 * @param {string} imdbId - "tt1375666"
 * @param {string} type - "movie" or "tv"
 * @param {number} season
 * @param {number} episode
 * @returns {Promise<Array<{url,label,lang}>>}
 */
async function fetchSubdlSubtitles(imdbId, type, season, episode) {
	try {
		var params = [];
		params.push("api_key=" + encodeURIComponent(SUBDL_API_KEY));
		params.push("imdb_id=" + encodeURIComponent(imdbId));
		params.push("type=" + encodeURIComponent(type === "tv" ? "tv" : "movie"));
		params.push("subs_per_page=30");
		params.push("languages=EN");
		params.push("unpack=1");

		if (type === "tv") {
			params.push("season_number=" + (parseInt(season, 10) || 1));
			params.push("episode_number=" + (parseInt(episode, 10) || 1));
		}

		var url = SUBDL_API_BASE + "/subtitles?" + params.join("&");

		log("SubDL search: " + url.replace(SUBDL_API_KEY, "***"));

		var resp = await httpGet(url, {
			Accept: "application/json",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		});

		var data = safeJsonParse(resp);
		if (!data || data.status !== true) {
			log("SubDL: no results or error");
			return [];
		}

		var subtitles = data.subtitles;
		if (!Array.isArray(subtitles) || subtitles.length === 0) {
			return [];
		}

		var results = [];
		for (var i = 0; i < subtitles.length; i++) {
			var sub = subtitles[i];
			if (!sub || !sub.url) continue;

			var lang = normalizeSubdlLang(sub.lang || sub.language || "en");
			var name = sub.release_name || sub.name || "";
			var fileUrl = "";

			// If unpack=1, use unpack_files URLs directly
			if (sub.unpack_files && Array.isArray(sub.unpack_files)) {
				for (var fi = 0; fi < sub.unpack_files.length; fi++) {
					var uf = sub.unpack_files[fi];
					if (uf && uf.url) {
						var fullUrl =
							uf.url.indexOf("http") === 0 ? uf.url : SUBDL_DL_BASE + uf.url;
						results.push({
							url: fullUrl,
							label: name || "SubDL " + lang,
							lang: lang,
						});
					}
				}
			} else {
				// Build download URL from sub.url: /subtitle/123-456.zip
				fileUrl =
					sub.url.indexOf("http") === 0 ? sub.url : SUBDL_DL_BASE + sub.url;
				results.push({
					url: fileUrl,
					label: name || "SubDL " + lang,
					lang: lang,
				});
			}

			// Limit to avoid excessive results
			if (results.length >= 20) break;
		}

		log("SubDL: " + results.length + " subtitle(s) for " + imdbId);
		return results;
	} catch (e) {
		warn("SubDL error: " + (e && e.message));
		return [];
	}
}

/**
 * Normalize SubDL language codes to ISO 639-1.
 */
function normalizeSubdlLang(code) {
	if (!code) return "en";
	var c = String(code).toUpperCase().trim();

	// Direct overrides
	if (SUBDL_LANG_OVERRIDES[c]) return SUBDL_LANG_OVERRIDES[c];

	// If it's already 2-letter ISO code
	if (/^[A-Z]{2}$/.test(c)) return c.toLowerCase();

	// Map language names to codes
	var nameMap = {
		ENGLISH: "en",
		SPANISH: "es",
		FRENCH: "fr",
		GERMAN: "de",
		PORTUGUESE: "pt",
		ITALIAN: "it",
		RUSSIAN: "ru",
		JAPANESE: "ja",
		KOREAN: "ko",
		CHINESE: "zh",
		ARABIC: "ar",
		DUTCH: "nl",
		POLISH: "pl",
		TURKISH: "tr",
		SWEDISH: "sv",
		DANISH: "da",
		FINNISH: "fi",
		NORWEGIAN: "no",
		HEBREW: "he",
		HINDI: "hi",
		THAI: "th",
		VIETNAMESE: "vi",
		INDONESIAN: "id",
		ROMANIAN: "ro",
		CZECH: "cs",
		HUNGARIAN: "hu",
		GREEK: "el",
		BULGARIAN: "bg",
		CROATIAN: "hr",
		SERBIAN: "sr",
		UKRAINIAN: "uk",
		FARSI_PERSIAN: "fa",
		FARSI: "fa",
		PERSIAN: "fa",
		MALAY: "ms",
	};

	return nameMap[c] || (c.length === 2 ? c.toLowerCase() : "en");
}

// ═════════════════════════════════════════════════════════════════════════
//  SUBSOURCE API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Auth headers for SubSource API.
 */
function subsourceHeaders() {
	return {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		Accept: "application/json, text/plain, */*",
		Referer: "https://subsource.net/",
		Origin: "https://subsource.net",
		"X-API-Key": SUBSOURCE_API_KEY,
		"api-key": SUBSOURCE_API_KEY,
	};
}

/**
 * Step 1: Resolve IMDB ID → SubSource internal movieId.
 *
 * @param {string} imdbId
 * @returns {Promise<string|null>}
 */
async function subsourceGetMovieId(imdbId) {
	try {
		var url =
			SUBSOURCE_API_BASE +
			"/movies/search?searchType=imdb&imdb=" +
			encodeURIComponent(imdbId);

		var resp = await httpGet(url, subsourceHeaders());
		var data = safeJsonParse(resp);

		if (!data) return null;

		// Response can be an array directly or { data: [...] }
		var movies = Array.isArray(data)
			? data
			: Array.isArray(data.data)
				? data.data
				: [];

		if (movies.length > 0 && movies[0].id) {
			return String(movies[0].id);
		}

		return null;
	} catch (e) {
		warn("SubSource getMovieId error: " + (e && e.message));
		return null;
	}
}

/**
 * Step 2: Fetch subtitles for a given SubSource movieId.
 *
 * @param {string} movieId
 * @returns {Promise<Array<{url,label,lang}>>}
 */
async function subsourceFetchSubtitles(movieId) {
	try {
		// Fetch subtitles — limit to popular English subs by default
		var url =
			SUBSOURCE_API_BASE +
			"/subtitles?movieId=" +
			encodeURIComponent(movieId) +
			"&sort=popular&limit=50&language=english";

		var resp = await httpGet(url, subsourceHeaders());
		var data = safeJsonParse(resp);

		if (!data) return [];

		// Various response shapes
		var subsList = null;
		if (Array.isArray(data)) subsList = data;
		else if (data.subtitles) subsList = data.subtitles;
		else if (data.data && Array.isArray(data.data)) subsList = data.data;
		else if (data.data && data.data.subtitles) subsList = data.data.subtitles;

		if (!Array.isArray(subsList) || subsList.length === 0) {
			return [];
		}

		var results = [];
		for (var i = 0; i < subsList.length && results.length < 30; i++) {
			var sub = subsList[i];
			if (!sub) continue;

			var subtitleId = sub.subtitleId || sub.id || sub.subtitle_id || sub._id;
			if (!subtitleId) continue;

			var lang = normalizeSubsourceLang(sub.language || sub.lang || "en");
			var name = "";
			if (sub.releaseInfo && Array.isArray(sub.releaseInfo)) {
				name = sub.releaseInfo.join(" / ");
			}
			name =
				name ||
				sub.name ||
				sub.release_name ||
				sub.file_name ||
				"SubSource " + lang;

			// Build download URL
			var dlUrl =
				SUBSOURCE_API_BASE +
				"/subtitles/" +
				encodeURIComponent(String(subtitleId)) +
				"/download";

			results.push({
				url: dlUrl,
				label: name,
				lang: lang,
			});
		}

		log("SubSource: " + results.length + " subtitle(s) for movieId=" + movieId);
		return results;
	} catch (e) {
		warn("SubSource fetchSubtitles error: " + (e && e.message));
		return [];
	}
}

/**
 * Normalize SubSource language codes to ISO 639-1.
 */
function normalizeSubsourceLang(lang) {
	if (!lang) return "en";
	var lower = String(lang).toLowerCase().trim();

	// Direct map lookup
	if (SUBSOURCE_LANG_MAP[lower]) return SUBSOURCE_LANG_MAP[lower];

	// Already 2-letter code
	if (/^[a-z]{2}$/.test(lower)) return lower;

	return "en";
}

// ═════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch subtitles from both SubDL and SubSource for a given piece of content.
 *
 * Uses TMDB → IMDB mapping to ensure accurate subtitle matching.
 * Results are deduplicated by URL.
 *
 * @param {number} tmdbId - TMDB content ID
 * @param {string} type - "movie" or "tv"
 * @param {number} [season=1]
 * @param {number} [episode=1]
 * @returns {Promise<Array<{url: string, label: string, lang: string}>>}
 */
async function fetchSubtitles(tmdbId, type, season, episode) {
	var start = Date.now();
	var tmdbIdNum = parseInt(tmdbId, 10) || 0;
	var contentType = type === "tv" ? "tv" : "movie";
	var seasonNum = Math.max(1, parseInt(season, 10) || 1);
	var episodeNum = Math.max(1, parseInt(episode, 10) || 1);

	log(
		"fetchSubtitles(" +
			contentType +
			" tmdb:" +
			tmdbIdNum +
			") S" +
			seasonNum +
			"E" +
			episodeNum,
	);

	try {
		// Step 1: Resolve TMDB → IMDB ID
		var imdbId = await tmdbToImdb(tmdbIdNum, contentType);
		if (!imdbId) {
			log("fetchSubtitles: cannot resolve TMDB → IMDB for " + tmdbIdNum);
			return [];
		}

		log("  TMDB " + tmdbIdNum + " → IMDB " + imdbId);

		// Step 2: Query both providers in parallel with a safety timeout
		var results = await Promise.allSettled([
			fetchSubdlSubtitles(imdbId, contentType, seasonNum, episodeNum),
			subsourceFetchViaMovieId(imdbId, contentType, seasonNum, episodeNum),
		]);

		// Step 3: Merge and deduplicate
		var seen = {};
		var all = [];

		for (var ri = 0; ri < results.length; ri++) {
			var r = results[ri];
			if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
			for (var si = 0; si < r.value.length; si++) {
				var sub = r.value[si];
				if (!sub || !sub.url) continue;
				// Deduplicate by URL
				if (seen[sub.url]) continue;
				seen[sub.url] = true;
				all.push(sub);
			}
		}

		log(
			"  → " +
				all.length +
				" unique subtitles in " +
				(Date.now() - start) +
				"ms",
		);
		return all;
	} catch (e) {
		warn("fetchSubtitles error: " + (e && e.message));
		return [];
	}
}

/**
 * Wrapper: get SubSource movieId then fetch subtitles.
 */
async function subsourceFetchViaMovieId(imdbId, type, season, episode) {
	try {
		var movieId = await subsourceGetMovieId(imdbId);
		if (!movieId) return [];
		return await subsourceFetchSubtitles(movieId);
	} catch (e) {
		return [];
	}
}

/**
 * Enrich an array of stream objects with subtitles.
 * Adds subtitles to streams that lack them.
 *
 * @param {Array} streams - Array of stream objects
 * @param {Array} subtitles - Array of {url, label, lang}
 * @returns {Array} Streams with subtitles attached
 */
function attachSubtitlesToStreams(streams, subtitles) {
	// Guard: streams must be a non-null array
	if (!streams || !Array.isArray(streams)) return streams;
	// If no external subtitles, leave streams completely unchanged
	if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
		return streams;
	}

	for (var i = 0; i < streams.length; i++) {
		var s = streams[i];
		if (!s) continue;

		// If stream already has subtitles, append new ones (dedup by URL)
		var existing = s.subtitles;
		if (existing && existing.length > 0) {
			var existingUrls = {};
			for (var ei = 0; ei < existing.length; ei++) {
				if (existing[ei] && existing[ei].url)
					existingUrls[existing[ei].url] = true;
			}
			var toAdd = [];
			for (var si = 0; si < subtitles.length; si++) {
				if (
					subtitles[si] &&
					subtitles[si].url &&
					!existingUrls[subtitles[si].url]
				) {
					toAdd.push(subtitles[si]);
				}
			}
			if (toAdd.length > 0) {
				s.subtitles = existing.concat(toAdd);
			}
		} else {
			// Stream has no subtitles — attach all
			s.subtitles = subtitles;
		}
	}
	return streams;
}

module.exports = {
	fetchSubtitles: fetchSubtitles,
	attachSubtitlesToStreams: attachSubtitlesToStreams,
	tmdbToImdb: tmdbToImdb,
};
