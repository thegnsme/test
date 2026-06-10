/**
 * =============================================================================
 *  SOURCE: vidsrc.icu — DISABLED
 *  =============================================================================
 *  Domain vidsrc.icu is no longer resolving (DNS dead as of 2026).
 *  This source is kept as a stub for historical reference only.
 *  It is NOT imported by index.js.
 * =============================================================================
 */

var SOURCE_NAME = "vidsrc.icu";

async function scrapeStreams(params) {
	return {
		source: SOURCE_NAME,
		status: "unavailable",
		error: "vidsrc.icu domain is no longer resolving",
		streams: [],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
