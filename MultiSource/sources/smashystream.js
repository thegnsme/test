/**
 * =============================================================================
 *  SOURCE: embed.smashystream.com — DISABLED
 *  =============================================================================
 *  Domain embed.smashystream.com is no longer resolving (DNS dead as of 2026).
 *  This source is kept as a stub for historical reference only.
 *  It is NOT imported by index.js.
 * =============================================================================
 */

var SOURCE_NAME = "smashystream.com";

async function scrapeStreams(params) {
	return {
		source: SOURCE_NAME,
		status: "unavailable",
		error: "embed.smashystream.com domain is no longer resolving",
		streams: [],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
