/**
 * =============================================================================
 *  SHARED HELPERS for MultiSource plugin sources
 *  =============================================================================
 *  Provides a normalized `httpGet(url, headers)` that works in both:
 *    - Real SkyStream QuickJS runtime (http_get returns string)
 *    - skystream-cli test environment  (http_get returns { body, status })
 *
 *  Usage in any source file:
 *      var { httpGet } = require("./_shared");
 *      var html = await httpGet("https://example.com", { ... });
 * =============================================================================
 */

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
		// http_get may return a string (real runtime) or { body, status } (test CLI)
		if (typeof raw === "string") return raw;
		if (raw && typeof raw.body === "string") return raw.body;
		if (raw && typeof raw.body === "object") return JSON.stringify(raw.body);
		// Last resort: convert whatever we got to string
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

module.exports = {
	httpGet: httpGet,
	httpPost: httpPost,
};
