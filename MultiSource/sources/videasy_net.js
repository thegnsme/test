/**
 * =============================================================================
 *  SOURCE: videasy.net — RENAMED to videasy.to
 *  =============================================================================
 *  The old api.videasy.net stopped responding (404 Easypanel error).
 *  The source has been migrated to videasy_to.js which uses api.videasy.to.
 *
 *  This stub is kept for historical reference only.
 *  It is NOT imported by index.js.
 * =============================================================================
 */

var SOURCE_NAME = "videasy.net";

async function scrapeStreams(params) {
	return {
		source: SOURCE_NAME,
		status: "unavailable",
		error:
			"api.videasy.net is dead (404). Migrated to videasy.to — use that source instead.",
		streams: [],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
