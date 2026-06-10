/**
 * test-stream — diagnostic source
 * Returns the official SkyStream test M3U8 with quality label.
 * No headers, no subtitles — pure minimal stream object.
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
				quality: "Test",
			},
		],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
