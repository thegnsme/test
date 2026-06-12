/**
 * =============================================================================
 *  Subtitle Provider — OpenSubtitles v2 (Production)
 * =============================================================================
 *
 * Fetches English subtitles from the OpenSubtitles REST API v2.
 *
 * WHY OpenSubtitles v2 (not SubDL, not SubSource, not v3):
 *   • SubDL: season/episode filtering is broken — returns wrong episode subs.
 *     Download URLs also return 404 regularly. Unreliable.
 *   • SubSource (subsource.net): entire API behind Cloudflare — unusable from
 *     the SkyStream QuickJS runtime (can't execute JS challenges server-side).
 *   • OpenSubtitles v3 (api.opensubtitles.com): requires auth tokens on download
 *     URLs — the SkyStream player can't send custom headers when fetching subs.
 *   • OpenSubtitles v2 (rest.opensubtitles.org): ✅ works.
 *     — Search by IMDB ID with simple User-Agent header
 *     — Download URLs return raw SRT, no auth needed
 *     — No Cloudflare protection
 *     — Proper season/episode filtering
 *     — Rich metadata (rating, downloads, hearing-impaired flag)
 *     — Much better English coverage: 6-32 English subs per title
 *
 * ARCHITECTURE:
 *   This module is NOT a stream source. It enriches streams WITH subtitles.
 *   It is required()'d directly by plugin.js — not registered as a source.
 *
 *   🔴 CRITICAL: Subtitles MUST be assigned to stream objects AFTER the
 *   StreamResult constructor, not inside it. The StreamResult constructor
 *   may strip unknown fields including `subtitles`.
 *     CORRECT:
 *       var stream = new StreamResult({ url, source, headers, quality });
 *       stream.subtitles = cloneSubtitles(subtitles);
 *     WRONG:
 *       var stream = new StreamResult({ url, source, subtitles: subs });
 *
 *   🔴 CRITICAL: NEVER share the same subtitle array reference across
 *   multiple streams. The player may mutate one stream's subtitles (e.g.,
 *   when toggling on/off), which would corrupt all other streams. Always
 *   deep-clone the subtitle array per stream.
 *     CORRECT:
 *       stream.subtitles = cloneSubtitles(subtitles);
 *     WRONG:
 *       stream.subtitles = subtitles;  // shared reference!
 *
 * SUBTITLE FORMAT:
 *   Each subtitle object has BOTH `name` and `label` fields for maximum
 *   player compatibility:
 *     { url: string, name: string, label: string, lang: string }
 *   - `name`  = used by some players (cinemacity, cinestream pattern)
 *   - `label` = used by some players (netmirror pattern, DEVELOPER.md spec)
 *   - `lang`  = ISO language code for player subtitle sync
 *
 * USAGE:
 *   var { fetchSubtitles, normalizeSubtitle, cloneSubtitles } = require("./subtitles_provider");
 *   var subs = await fetchSubtitles(550, "movie", 1, 1);
 *   // subs = [ { url: "...srt", name: "English", label: "English", lang: "en" }, ... ]
 *   stream.subtitles = cloneSubtitles(subs);  // ← deep-cloned per stream
 * =============================================================================
 */

"use strict";

var { httpGet, safeJsonParse, fetchTmdbMeta } = require("./_shared");

// ═════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═════════════════════════════════════════════════════════════════════════

var TAG = "SubProvider";

// ═══ OpenSubtitles v2 REST API ═══
// Search: GET /search/imdbid-{imdbId}  (imdbId WITHOUT "tt" prefix)
//   Header: User-Agent: TemporaryUserAgent
//   Returns: array of subtitle objects with IDSubtitleFile for download
//
// Download: GET /en/download/filead/{IDSubtitleFile}
//   Returns: raw SRT content (no auth headers needed!)
var OS_BASE = "https://rest.opensubtitles.org";
var DL_BASE = "https://dl.opensubtitles.org";
var OS_USER_AGENT = "TemporaryUserAgent";
var OS_TIMEOUT = 10000;

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
//  SUBTITLE NORMALIZATION — ensures maximum player compatibility
// ═════════════════════════════════════════════════════════════════════════

/**
 * Normalize a single subtitle object to include BOTH `name` and `label` fields.
 *
 * Some players expect `{ url, name }` (cinemacity, cinestream pattern),
 * others expect `{ url, label, lang }` (netmirror, DEVELOPER.md spec).
 * This function ensures ALL fields are present for maximum compatibility.
 *
 * Input formats accepted:
 *   { url, name }           → adds label=name, lang="en"
 *   { url, label, lang }    → adds name=label
 *   { url, label }          → adds name=label, lang="en"
 *   { url, lang }           → adds name=languageName(lang), label=name
 *   { url }                 → adds name="Subtitle", label="Subtitle", lang="en"
 *
 * @param {object} sub - Raw subtitle object
 * @returns {object} Normalized subtitle { url, name, label, lang }
 */
function normalizeSubtitle(sub) {
	if (!sub || !sub.url) return null;

	var url = String(sub.url).trim();
	if (!url) return null;

	// Extract fields with fallbacks
	var rawName = sub.name || sub.label || sub.lang || "";
	var rawLabel = sub.label || sub.name || sub.lang || "";
	var rawLang = sub.lang || "";

	// Build name: prefer explicit name, then label, then language name from code
	var name = "";
	if (rawName) {
		name = String(rawName).trim();
	} else if (rawLang) {
		name = languageName(rawLang);
	} else {
		name = "Subtitle";
	}

	// Build label: same logic, prefer explicit
	var label = "";
	if (rawLabel) {
		label = String(rawLabel).trim();
	} else if (rawLang) {
		label = languageName(rawLang);
	} else {
		label = "Subtitle";
	}

	// Build lang: extract from existing or infer
	var lang = rawLang ? String(rawLang).toLowerCase().trim() : "en";

	return {
		url: url,
		name: name,
		label: label,
		lang: lang,
	};
}

/**
 * Deep-clone a subtitles array so each stream gets its own copy.
 * PREVENTS the critical bug where a shared array reference causes
 * subtitle corruption when the player toggles subtitles on one stream.
 *
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {Array} Deep-cloned, normalized subtitle array
 */
function cloneSubtitles(subtitles) {
	if (!Array.isArray(subtitles)) return [];
	if (subtitles.length === 0) return [];

	var cloned = [];
	for (var i = 0; i < subtitles.length; i++) {
		var normalized = normalizeSubtitle(subtitles[i]);
		if (normalized) {
			// Create a truly independent copy
			cloned.push({
				url: normalized.url,
				name: normalized.name,
				label: normalized.label,
				lang: normalized.lang,
			});
		}
	}
	return cloned;
}

// ═════════════════════════════════════════════════════════════════════════
//  TMDB → IMDB MAPPING (cached)
// ═════════════════════════════════════════════════════════════════════════

var _imdbCache = {};
var _imdbCacheKeys = [];
var _imdbCacheMax = 200;

/**
 * Resolve TMDB ID to IMDB ID (ttXXXX format).
 * Uses global tmdbGet if available, otherwise fetchTmdbMeta from _shared.
 *
 * @param {number|string} tmdbId
 * @param {string} type - "movie" or "tv"
 * @returns {Promise<string|null>} IMDB ID like "tt0137523" or null
 */
async function tmdbToImdb(tmdbId, type) {
	var key = String(tmdbId) + ":" + type;
	if (_imdbCache[key] !== undefined) return _imdbCache[key];

	try {
		// If the SkyStream runtime provides tmdbGet(), use it
		if (typeof tmdbGet === "function") {
			var data = await tmdbGet(type + "/" + tmdbId, {
				append_to_response: "external_ids",
			});
			if (data && data.external_ids && data.external_ids.imdb_id) {
				var imdb = data.external_ids.imdb_id;
				_imdbCache[key] = imdb;
				_imdbCacheKeys.push(key);
				if (_imdbCacheKeys.length > _imdbCacheMax) {
					delete _imdbCache[_imdbCacheKeys.shift()];
				}
				return imdb;
			}
			if (data && data.imdb_id) {
				_imdbCache[key] = data.imdb_id;
				_imdbCacheKeys.push(key);
				if (_imdbCacheKeys.length > _imdbCacheMax) {
					delete _imdbCache[_imdbCacheKeys.shift()];
				}
				return data.imdb_id;
			}
		}

		// Fallback: use fetchTmdbMeta from _shared.js
		var meta = await fetchTmdbMeta(tmdbId, type);
		if (meta && meta.imdb_id) {
			_imdbCache[key] = meta.imdb_id;
			_imdbCacheKeys.push(key);
			if (_imdbCacheKeys.length > _imdbCacheMax) {
				delete _imdbCache[_imdbCacheKeys.shift()];
			}
			return meta.imdb_id;
		}

		return null;
	} catch (e) {
		warn("tmdbToImdb(" + tmdbId + "," + type + ") error: " + e.message);
		return null;
	}
}

// ═════════════════════════════════════════════════════════════════════════
//  OPENSUBTITLES v2 API
// ═════════════════════════════════════════════════════════════════════════

/**
 * Search OpenSubtitles v2 REST API by IMDB ID.
 *
 * The v2 REST API (rest.opensubtitles.org) is less restricted than v3:
 *   - No API key needed
 *   - Requires a User-Agent header identifying the client application
 *   - Returns rich metadata including rating, downloads, hearing-impaired flag
 *   - Supports movies and TV episodes (with season/episode fields)
 *
 * @param {string} imdbId - IMDB ID (with or without "tt" prefix)
 * @returns {Promise<Array>} Array of subtitle result objects, or empty array
 */
async function searchOpenSubtitles(imdbId) {
	// Strip "tt" prefix — OpenSubtitles v2 expects raw numeric ID
	var searchId = String(imdbId).replace(/^tt/i, "");

	if (!searchId || !/^\d+$/.test(searchId)) {
		warn("searchOpenSubtitles: invalid imdbId '" + imdbId + "'");
		return [];
	}

	var url = OS_BASE + "/search/imdbid-" + searchId;

	try {
		var resp = await httpGet(
			url,
			{
				"User-Agent": OS_USER_AGENT,
				Accept: "application/json",
			},
			2, // retries
		);

		if (!resp || resp.length < 10) {
			return [];
		}

		var data = safeJsonParse(resp);
		if (Array.isArray(data)) {
			return data;
		}

		return [];
	} catch (e) {
		warn("searchOpenSubtitles error: " + (e && e.message));
		return [];
	}
}

/**
 * Compute a quality score for an OpenSubtitles result.
 *
 * Higher score = better subtitle recommendation.
 * Factors:
 *   - Downloads (popularity signal)
 *   - Rating (quality signal)
 *   - Penalty for "bad" flag (SubBad)
 *   - Penalty for hearing-impaired (prefer clean subs unless explicit)
 *
 * @param {object} sub - OpenSubtitles result object
 * @returns {number} Quality score (higher = better)
 */
function subtitleQualityScore(sub) {
	if (!sub) return 0;

	var downloads = parseInt(sub.SubDownloadsCnt, 10) || 0;
	var rating = parseFloat(sub.SubRating) || 0;

	// Base score: popularity × quality
	var score = downloads * (rating || 1);

	// Severe penalty for explicitly bad subtitles
	if (sub.SubBad === "1") {
		score *= 0.05;
	}

	// Moderate penalty for hearing-impaired (SDH) subs
	// Some users may prefer these, so don't eliminate entirely
	if (sub.SubHearingImpaired === "1") {
		score *= 0.3;
	}

	// Slight boost for SRT format (most compatible)
	if (sub.SubFormat && sub.SubFormat.toLowerCase() === "srt") {
		score *= 1.1;
	}

	// Slight boost for higher rating
	score *= 1 + rating / 10;

	return score;
}

/**
 * Fetch English subtitles from OpenSubtitles v2 for a given IMDB ID.
 *
 * For TV shows, filters by exact season and episode match.
 * Returns up to 3 best English subtitles, sorted by quality.
 *
 * @param {string} imdbId - "tt0137523"
 * @param {string} type - "movie" or "tv"
 * @param {number} [season=1]
 * @param {number} [episode=1]
 * @returns {Promise<Array<{url: string, name: string, label: string, lang: string}>>}
 */
async function fetchOsSubtitles(imdbId, type, season, episode) {
	try {
		var allResults = await searchOpenSubtitles(imdbId);
		if (!Array.isArray(allResults) || allResults.length === 0) {
			log("OpenSubtitles: no results for " + imdbId);
			return [];
		}

		log("OpenSubtitles: " + allResults.length + " total results for " + imdbId);

		// Step 1: Filter to English only
		var english = [];
		for (var i = 0; i < allResults.length; i++) {
			var s = allResults[i];
			if (!s) continue;

			var lang = (s.SubLanguageID || "").toLowerCase().trim();
			var iso = (s.ISO639 || "").toLowerCase().trim();

			if (lang === "eng" || iso === "en") {
				english.push(s);
			}
		}

		log("  → " + english.length + " English subtitle(s)");

		if (english.length === 0) {
			return [];
		}

		// Step 2: For TV, filter by exact season/episode
		if (type === "tv") {
			var sNum = parseInt(season, 10) || 1;
			var eNum = parseInt(episode, 10) || 1;

			var filtered = [];
			for (var ei = 0; ei < english.length; ei++) {
				var sub = english[ei];
				var subS = parseInt(sub.SeriesSeason, 10);
				var subE = parseInt(sub.SeriesEpisode, 10);

				// Must match both season AND episode exactly
				if (subS === sNum && subE === eNum) {
					filtered.push(sub);
				}
			}

			if (filtered.length === 0) {
				// Fallback: try anime convention (S0E0 in OpenSubtitles).
				// Many anime are stored with SeriesSeason=0 and SeriesEpisode=0
				// regardless of actual episode number. Accept these as a fallback.
				var animeFallback = [];
				for (var fi = 0; fi < english.length; fi++) {
					var fas = english[fi];
					var faS = parseInt(fas.SeriesSeason, 10);
					var faE = parseInt(fas.SeriesEpisode, 10);
					if ((faS === 0 || isNaN(faS)) && (faE === 0 || isNaN(faE))) {
						animeFallback.push(fas);
					}
				}

				if (animeFallback.length > 0) {
					log(
						"  → no exact S" +
							sNum +
							"E" +
							eNum +
							", but found " +
							animeFallback.length +
							" anime-style (S0E0) subs",
					);
					filtered = animeFallback;
				} else {
					log(
						"  → no English subs for S" +
							sNum +
							"E" +
							eNum +
							" (had " +
							english.length +
							" English total, none for this episode)",
					);
					return [];
				}
			}

			english = filtered;
			log("  → " + english.length + " English for S" + sNum + "E" + eNum);
		}

		// Step 3: Sort by quality score (descending)
		english.sort(function (a, b) {
			return subtitleQualityScore(b) - subtitleQualityScore(a);
		});

		// Step 4: Build subtitle objects, deduplicate by label
		var out = [];
		var seenLabels = {};

		for (var si = 0; si < english.length; si++) {
			var sub = english[si];
			var fileId = sub.IDSubtitleFile;

			if (!fileId) continue;

			// Build display label
			var label = "English";

			// Append hearing-impaired indicator
			if (sub.SubHearingImpaired === "1") {
				label += " (SDH)";
			}

			// Append uploader name for differentiation
			if (sub.UserNickName) {
				var nick = String(sub.UserNickName).trim();
				if (nick && nick.length > 0) {
					label += " [" + nick + "]";
				}
			}

			// Skip duplicate labels
			if (seenLabels[label]) continue;
			seenLabels[label] = true;

			// Construct direct SRT download URL
			// Pattern: https://dl.opensubtitles.org/en/download/filead/{IDSubtitleFile}
			// Returns raw SRT content — no auth headers needed!
			var downloadUrl = DL_BASE + "/en/download/filead/" + String(fileId);

			out.push({
				url: downloadUrl,
				name: label,
				label: label,
				lang: "en",
			});

			// Limit to at most 3 subtitle options
			if (out.length >= 3) break;
		}

		log(
			"OpenSubtitles: returning " + out.length + " English subtitle option(s)",
		);
		return out;
	} catch (e) {
		warn("fetchOsSubtitles error: " + (e && e.message));
		return [];
	}
}

// ═════════════════════════════════════════════════════════════════════════
//  ATTACH SUBTITLES TO STREAMS
// ═════════════════════════════════════════════════════════════════════════
//
//  🔴 FIX: Deep-clone subtitles for EACH stream to prevent shared-reference
//  corruption when the player toggles subtitles on/off per stream.
//
//  🔴 FIX: Normalize all subtitle objects to include both `name` and `label`
//  fields for maximum player compatibility.
// ═════════════════════════════════════════════════════════════════════════

/**
 * Enrich an array of stream objects with subtitles.
 * EACH stream gets its OWN deep-cloned copy of the subtitle array.
 *
 * @param {Array} streams - Array of stream objects (plain objects, NOT StreamResult)
 * @param {Array} subtitles - Array of {url, name, label, lang}
 * @returns {Array} The same streams array (mutated in-place)
 */
function attachSubtitlesToStreams(streams, subtitles) {
	if (!streams || !Array.isArray(streams)) return streams;
	if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
		return streams;
	}

	log(
		"attachSubtitlesToStreams: enriching " +
			streams.length +
			" stream(s) with " +
			subtitles.length +
			" subtitle(s)",
	);

	for (var i = 0; i < streams.length; i++) {
		var s = streams[i];
		if (!s) continue;

		// Normalize then deep-clone the external subtitles (never share reference)
		var externalSubs = cloneSubtitles(subtitles);

		// Check if stream already has subtitles from its source
		var existing = s.subtitles;
		if (existing && Array.isArray(existing) && existing.length > 0) {
			// Normalize existing subtitles too
			var normalizedExisting = [];
			for (var ei = 0; ei < existing.length; ei++) {
				var norm = normalizeSubtitle(existing[ei]);
				if (norm) normalizedExisting.push(norm);
			}

			// Deduplicate by URL: keep existing, add new ones not already present
			var existingUrls = {};
			for (var ei2 = 0; ei2 < normalizedExisting.length; ei2++) {
				if (normalizedExisting[ei2] && normalizedExisting[ei2].url) {
					existingUrls[normalizedExisting[ei2].url] = true;
				}
			}

			var merged = normalizedExisting.slice();
			for (var si = 0; si < externalSubs.length; si++) {
				if (
					externalSubs[si] &&
					externalSubs[si].url &&
					!existingUrls[externalSubs[si].url]
				) {
					merged.push(externalSubs[si]);
				}
			}
			s.subtitles = merged;
		} else {
			// No existing subtitles — attach deep-cloned copy
			s.subtitles = externalSubs;
		}
	}

	return streams;
}

// ═════════════════════════════════════════════════════════════════════════
//  PUBLIC API — fetchSubtitles
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch English subtitles via OpenSubtitles v2 for a given piece of content.
 *
 * Uses TMDB → IMDB mapping to search OpenSubtitles. Only returns English
 * subtitles, sorted by quality (popularity × rating).
 *
 * For TV shows, subtitles are filtered to the exact season/episode.
 * Download URLs are direct SRT links — no auth headers needed.
 *
 * @param {number} tmdbId - TMDB content ID
 * @param {string} type - "movie" or "tv"
 * @param {number} [season=1]
 * @param {number} [episode=1]
 * @returns {Promise<Array<{url: string, name: string, label: string, lang: string}>>}
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

		// Step 2: Fetch English subtitles from OpenSubtitles v2
		var subs = await fetchOsSubtitles(
			imdbId,
			contentType,
			seasonNum,
			episodeNum,
		);

		log(
			"  → " +
				subs.length +
				" English subtitle(s) in " +
				(Date.now() - start) +
				"ms",
		);
		return subs;
	} catch (e) {
		warn("fetchSubtitles error: " + (e && e.message));
		return [];
	}
}

// ═════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═════════════════════════════════════════════════════════════════════════

module.exports = {
	fetchSubtitles: fetchSubtitles,
	attachSubtitlesToStreams: attachSubtitlesToStreams,
	normalizeSubtitle: normalizeSubtitle,
	cloneSubtitles: cloneSubtitles,
	tmdbToImdb: tmdbToImdb,
};
