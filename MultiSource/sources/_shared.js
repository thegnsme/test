/**
 * =============================================================================
 *  SHARED HELPERS for MultiSource plugin sources
 *  =============================================================================
 *  Provides HTTP wrappers and a TMDB metadata helper.
 *  Works in both SkyStream QuickJS runtime and skystream-cli test env.
 *
 *  Usage:
 *      var { httpGet, httpPost, fetchTmdbMeta } = require("./_shared");
 *      var html = await httpGet("https://example.com");
 *      var meta = await fetchTmdbMeta(550, "movie");
 * =============================================================================
 */

var TMDB_KEY = "68e094699525b18a70bab2f86b1fa706";
var TMDB_BASE = "https://api.themoviedb.org/3";

/**
 * Normalized HTTP GET.
 * Resolves with the response body as a string, regardless of whether
 * the underlying http_get returns a string or { body, status } object.
 *
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<string>} response body
 */
async function httpGet(url, headers) {
	try {
		var raw = await http_get(url, headers || {});
		if (typeof raw === "string") return raw;
		if (raw && typeof raw.body === "string") return raw.body;
		if (raw && typeof raw.body === "object") return JSON.stringify(raw.body);
		return String(raw || "");
	} catch (e) {
		throw e;
	}
}

/**
 * Normalized HTTP POST.
 * Resolves with the response body as a string.
 *
 * @param {string} url
 * @param {object} headers
 * @param {string} body
 * @returns {Promise<string>} response body
 */
async function httpPost(url, headers, body) {
	try {
		var raw = await http_post(url, headers || {}, body || "");
		if (typeof raw === "string") return raw;
		if (raw && typeof raw.body === "string") return raw.body;
		if (raw && typeof raw.body === "object") return JSON.stringify(raw.body);
		return String(raw || "");
	} catch (e) {
		throw e;
	}
}

/**
 * Fetch metadata from TMDB needed by some sources (title, year, imdb_id).
 * Uses the same key as plugin.js for consistency.
 *
 * @param {number|string} tmdbId - TMDB ID
 * @param {string} type - 'movie' or 'tv'
 * @returns {Promise<object>} { title, year, imdb_id } or null on failure
 */
async function fetchTmdbMeta(tmdbId, type) {
	try {
		var endpoint = type === "tv" ? "/tv/" : "/movie/";
		var url =
			TMDB_BASE +
			endpoint +
			String(tmdbId) +
			"?api_key=" +
			TMDB_KEY +
			"&append_to_response=external_ids";
		var resp = await httpGet(url, {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			Accept: "application/json",
		});
		var data = JSON.parse(resp);

		var title = data.title || data.name || "";
		var date = data.release_date || data.first_air_date || "";
		var year = date ? date.split("-")[0] : "";
		var imdbId =
			data.external_ids && data.external_ids.imdb_id
				? data.external_ids.imdb_id
				: data.imdb_id || "";

		return { title: title, year: year, imdb_id: imdbId };
	} catch (e) {
		return null;
	}
}

module.exports = {
	httpGet: httpGet,
	httpPost: httpPost,
	fetchTmdbMeta: fetchTmdbMeta,
};
