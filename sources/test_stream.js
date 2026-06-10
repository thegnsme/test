/**
 * =============================================================================
 *  SOURCE: test-stream — MINIMAL HLS diagnostic
 *  =============================================================================
 *  Returns a SINGLE stream with ONLY url and no extra fields.
 *  Matches the official SkyStream plugin example as closely as possible.
 *
 *  If even this fails to play, the issue is NOT about CDNs, Cloudflare,
 *  or URL format — it's a fundamental player or plugin configuration issue.
 * =============================================================================
 */

var SOURCE_NAME = "test-stream";
var TEST_URL = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

async function scrapeStreams(params) {
	return {
		source: SOURCE_NAME,
		status: "working",
		streams: [
			{
				url: TEST_URL,
			},
		],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
