/**
 * =============================================================================
 *  Subtitle Provider — SubDL Integration (Production)
 * =============================================================================
 *
 * Fetches subtitles from SubDL API using TMDB → IMDB mapping for accurate
 * content matching (movie, TV series, anime).
 *
 * ARCHITECTURE:
 *   This module is NOT a stream source. It enriches streams WITH subtitles.
 *   It is required()'d directly by plugin.js — not registered as a source.
 *
 *   Subtitles are attached using the format the player expects:
 *     { url: string, label: string, lang: string }
 *   where label is a human-readable language name like "English" or "English (SDH)".
 *
 * WHY SUBDL ONLY:
 *   SubSource (subsource.net) download URLs require API key headers that the
 *   Skystream player cannot send when fetching subtitle files on mobile.
 *   SubDL download URLs (dl.subdl.com) work without additional headers.
 *
 * SUBTITLE API KEY:
 *   Hardcoded as required by SkyStream plugin packaging (no env vars available
 *   in the QuickJS runtime).
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

var SUBDL_TIMEOUT = 12000;
var TMDB_TIMEOUT = 8000;

// ═════════════════════════════════════════════════════════════════════════
//  LANGUAGE NAME MAP — for clean label display in player picker
// ═════════════════════════════════════════════════════════════════════════

var LANGUAGE_NAMES = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	pt: "Portuguese",
	pb: "Portuguese (BR)",
	it: "Italian",
	ru: "Russian",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese",
	ar: "Arabic",
	nl: "Dutch",
	pl: "Polish",
	tr: "Turkish",
	sv: "Swedish",
	da: "Danish",
	fi: "Finnish",
	no: "Norwegian",
	he: "Hebrew",
	hi: "Hindi",
	th: "Thai",
	vi: "Vietnamese",
	id: "Indonesian",
	ro: "Romanian",
	cs: "Czech",
	hu: "Hungarian",
	el: "Greek",
	bg: "Bulgarian",
	hr: "Croatian",
	sr: "Serbian",
	uk: "Ukrainian",
	fa: "Persian",
	ms: "Malay",
	et: "Estonian",
	lv: "Latvian",
	lt: "Lithuanian",
	sk: "Slovak",
	sl: "Slovenian",
	bn: "Bengali",
	tl: "Tagalog",
	bs: "Bosnian",
	mk: "Macedonian",
	sq: "Albanian",
	ka: "Georgian",
	is: "Icelandic",
	ca: "Catalan",
	eu: "Basque",
	gl: "Galician",
	cy: "Welsh",
	sw: "Swahili",
	ml: "Malayalam",
	ta: "Tamil",
	te: "Telugu",
	ur: "Urdu",
	pa: "Punjabi",
	ne: "Nepali",
	si: "Sinhala",
	km: "Khmer",
	lo: "Lao",
	my: "Burmese",
	mn: "Mongolian",
	af: "Afrikaans",
	ku: "Kurdish",
};

/**
 * Resolve language code to human-readable name.
 * Falls back to the code itself if unknown.
 */
function languageName(code) {
	if (!code) return "Unknown";
	var lower = String(code).toLowerCase().trim();
	return LANGUAGE_NAMES[lower] || lower.toUpperCase();
}

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
//  TMDB → IMDB MAPPING (cached)
// ═════════════════════════════════════════════════════════════════════════

var _imdbCache = {};

/**
 * Resolve TMDB ID to IMDB ID (ttXXXX format).
 * Uses global tmdbGet if available, otherwise fetchTmdbMeta from _shared.
 */
async function tmdbToImdb(tmdbId, type) {
	var key = String(tmdbId) + ":" + type;
	if (_imdbCache[key] !== undefined) return _imdbCache[key];

	try {
		if (typeof tmdbGet === "function") {
			var data = await tmdbGet(type + "/" + tmdbId, {
				append_to_response: "external_ids",
			});
			if (data && data.external_ids && data.external_ids.imdb_id) {
				var imdb = data.external_ids.imdb_id;
				_imdbCache[key] = imdb;
				return imdb;
			}
			if (data && data.imdb_id) {
				_imdbCache[key] = data.imdb_id;
				return data.imdb_id;
			}
		}

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
//  SUBDL LANGUAGE CODE NORMALIZATION
// ═════════════════════════════════════════════════════════════════════════

var SUBDL_LANG_MAP = {
	BR_PT: "pb",
};

function normalizeSubdlLang(code) {
	if (!code) return "en";
	var c = String(code).toUpperCase().trim();
	if (SUBDL_LANG_MAP[c]) return SUBDL_LANG_MAP[c];
	if (/^[A-Z]{2}$/.test(c)) return c.toLowerCase();

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
//  SUBDL API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch subtitles from SubDL API using IMDB ID.
 * Returns clean subtitle objects with human-readable labels.
 *
 * @param {string} imdbId - "tt0137523"
 * @param {string} type - "movie" or "tv"
 * @param {number} season
 * @param {number} episode
 * @returns {Promise<Array<{url, label, lang}>>}
 */
async function fetchSubdlSubtitles(imdbId, type, season, episode) {
	try {
		var params = [];
		params.push("api_key=" + encodeURIComponent(SUBDL_API_KEY));
		params.push("imdb_id=" + encodeURIComponent(imdbId));
		params.push("type=" + encodeURIComponent(type === "tv" ? "tv" : "movie"));
		params.push("subs_per_page=50");
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

		// Collect ALL subtitles first, then deduplicate by language
		var allResults = [];
		for (var i = 0; i < subtitles.length; i++) {
			var sub = subtitles[i];
			if (!sub) continue;

			var lang = normalizeSubdlLang(sub.lang || sub.language || "en");
			var isHi = sub.hi === true;
			var displayLang = languageName(lang);

			// Build label: "English" or "English (SDH)"
			var label = displayLang;
			if (isHi) {
				label = displayLang + " (SDH)";
			}

			// Check unpacked files
			if (sub.unpack_files && Array.isArray(sub.unpack_files)) {
				for (var fi = 0; fi < sub.unpack_files.length; fi++) {
					var uf = sub.unpack_files[fi];
					if (uf && uf.url) {
						var fileUrl =
							uf.url.indexOf("http") === 0 ? uf.url : SUBDL_DL_BASE + uf.url;
						allResults.push({
							url: fileUrl,
							label: label,
							lang: lang,
							hi: isHi,
							format: uf.format || "srt",
							score: isHi ? 10 : 5,
							// We prefer higher score: SDH > non-SDH, larger files > smaller
							size: uf.size || 0,
							rank: isHi ? 2 : 1,
						});
					}
				}
			}
		}

		// Deduplicate by language: keep the best subtitle per language
		// Best = SDH preferred, then larger file size
		var bestPerLanguage = {};
		for (var ri = 0; ri < allResults.length; ri++) {
			var item = allResults[ri];
			var existing = bestPerLanguage[item.lang];
			if (!existing) {
				bestPerLanguage[item.lang] = item;
			} else {
				// Prefer: higher rank (SDH > non-SDH), then larger size
				if (
					item.rank > existing.rank ||
					(item.rank === existing.rank && item.size > existing.size)
				) {
					bestPerLanguage[item.lang] = item;
				}
			}
		}

		// Convert to clean output format
		var results = [];
		for (var langCode in bestPerLanguage) {
			if (bestPerLanguage.hasOwnProperty(langCode)) {
				var best = bestPerLanguage[langCode];
				results.push({
					url: best.url,
					label: best.label,
					lang: best.lang,
				});
			}
		}

		log(
			"SubDL: " +
				results.length +
				" language(s) (" +
				allResults.length +
				" total files) for " +
				imdbId,
		);
		return results;
	} catch (e) {
		warn("SubDL error: " + (e && e.message));
		return [];
	}
}

// ═════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch subtitles from SubDL for a given piece of content.
 *
 * Uses TMDB → IMDB mapping to ensure accurate subtitle matching.
 * Results are deduplicated by language (best subtitle per language).
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

		// Step 2: Query SubDL
		var subdlSubs = await fetchSubdlSubtitles(
			imdbId,
			contentType,
			seasonNum,
			episodeNum,
		);

		log(
			"  → " +
				subdlSubs.length +
				" subtitles in " +
				(Date.now() - start) +
				"ms",
		);
		return subdlSubs;
	} catch (e) {
		warn("fetchSubtitles error: " + (e && e.message));
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
	if (!streams || !Array.isArray(streams)) return streams;
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
