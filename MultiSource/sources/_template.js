/**
 * =============================================================================
 *  SOURCE TEMPLATE — Create new sources from this template
 *  =============================================================================
 *
 *  INSTRUCTIONS:
 *    1. Copy this file → rename to your source name (e.g., `myprovider.js`)
 *    2. Update SOURCE_NAME and BASE constants
 *    3. Implement scrapeStreams() with your scraping logic
 *    4. Add to `sources/index.js`:
 *         var mySource = require("./myprovider");
 *         // ... add mySource to the SOURCES array
 *    5. Done! No changes to plugin.js needed.
 *
 *  HTTP HELPER (use this instead of raw http_get for cross-runtime compat):
 *    - const { httpGet } = require("./_shared");
 *    - httpGet(url, headers)          → Promise<string>
 *
 *  BUILT-IN APIs (available in SkyStream QuickJS runtime):
 *    - parseHtml(html)               → DOM Document
 *    - JSON.parse / JSON.stringify
 *    - nativeRegex(text, pattern, group, caseSensitive)
 *    - nativeMd5(input)
 *    - atob(str) / btoa(str)
 *
 *  EXPORT CONTRACT:
 *    module.exports = {
 *      name: "source-name",     // Display name in stream source labels
 *      scrapeStreams: function,  // Async function that returns SourceResult
 *    };
 *
 *  SCRAPESTREAMS PARAM:
 *    { tmdbId: number, type: "movie"|"tv", season: number, episode: number }
 *
 *  RETURN: SourceResult object
 *    {
 *      source: string,       // SOURCE_NAME
 *      embedUrl: string,     // The page that was scraped
 *      status: string,       // "working" | "no_streams" | "error"
 *      streams: Array<{
 *        url: string,        // Direct M3U8 or MP4 URL
 *        type: "hls"|"mp4",
 *        quality: string,    // e.g. "1080p", "4K"
 *        resolution: string, // e.g. "1920x1080"
 *        headers?: object,
 *      }>,
 *      subtitles?: Array<{ url, label, lang }>,
 *      error?: string,
 *      latency_ms: number,
 *    }
 * =============================================================================
 */

var { httpGet } = require("./_shared");
var SOURCE_NAME = "my-source";
var BASE = "https://example.com";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	var embedUrl =
		BASE +
		"/" +
		type +
		"/" +
		tmdbId +
		(type === "tv" ? "/" + season + "/" + episode : "");

	try {
		// ── Fetch the page / API ─────────────────────────────────────────────
		//
		//   var html = await http_get(embedUrl, {
		//     "User-Agent": "Mozilla/5.0...",
		//     "Referer": BASE,
		//   });
		//
		//   var data = JSON.parse(html);

		// ── Extract streams from response ─────────────────────────────────────
		//   Common regex patterns for finding stream URLs:
		//
		//   M3U8:  /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi
		//   MP4:   /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi
		//   JS:    /["'](?:file|src)["']\s*:\s*["']([^"']+)["']/gi

		// ── Return result ────────────────────────────────────────────────────
		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "no_streams",
			streams: [],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "error",
			error: e.message || "unknown error",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
