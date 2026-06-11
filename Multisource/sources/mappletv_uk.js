/**
 * mappletv.uk — Multi-Quality HLS via mapple.uk API
 *
 * Mapple TV provides a working API endpoint for HLS streams:
 *   GET /api/stream?mediaId={tmdbId}&mediaType=movie|tv
 *
 * The response contains a stream_url pointing to an HLS master playlist
 * with multiple quality variants (1080p, 720p, 360p).
 *
 * Flow:
 *   1. Fetch mapple.uk/watch page to get session cookie
 *   2. Call mapple.uk/api/stream endpoint for the stream URL
 *   3. Fetch the M3U8 master playlist
 *   4. Parse ALL quality variants
 *   5. Return one stream per quality level
 *
 * URL patterns:
 *   Watch: https://mapple.uk/watch/movie/{tmdbId}
 *   API:   https://mapple.uk/api/stream?mediaId={tmdbId}&mediaType=movie
 *
 * Fallback: Mapple watch URL as embed stream.
 */

var { httpGet, fetchM3U8AndParse } = require("./_shared");

var SOURCE_NAME = "mappletv.uk";
var MAPPLE_BASE = "https://mapple.uk";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Strategy A: Use mapple.uk/api/stream endpoint ──
		var apiStreams = await tryApiStream(tmdbId, type, season, episode, start);
		if (apiStreams && apiStreams.status === "working") {
			return apiStreams;
		}

		// ── Strategy B: Fallback to embed URL ──
		return embedFallback(tmdbId, type, season, episode, start);
	} catch (e) {
		return embedFallback(tmdbId, type, season, episode, start);
	}
}

/**
 * Try the mapple.uk API endpoint for multi-quality HLS.
 */
async function tryApiStream(tmdbId, type, season, episode, start) {
	try {
		// First, warm up the session by fetching the watch page
		var watchUrl;
		if (type === "tv") {
			watchUrl =
				MAPPLE_BASE + "/watch/tv/" + tmdbId + "-" + season + "-" + episode;
		} else {
			watchUrl = MAPPLE_BASE + "/watch/movie/" + tmdbId;
		}

		// Fetch the watch page to set session cookie (HttpOnly cookie auto-set by browser)
		var pageHtml;
		try {
			pageHtml = await httpGet(watchUrl, {
				"User-Agent": UA,
				Referer: MAPPLE_BASE + "/",
				Accept: "text/html,application/xhtml+xml",
			});
		} catch (e) {
			pageHtml = null;
		}

		if (!pageHtml || pageHtml.length < 50) {
			return null;
		}

		// ── Call the API endpoint ──
		var apiUrl;
		if (type === "tv") {
			apiUrl =
				MAPPLE_BASE +
				"/api/stream?mediaId=" +
				tmdbId +
				"&mediaType=tv&season=" +
				season +
				"&episode=" +
				episode;
		} else {
			apiUrl =
				MAPPLE_BASE + "/api/stream?mediaId=" + tmdbId + "&mediaType=movie";
		}

		var apiResp = await httpGet(apiUrl, {
			"User-Agent": UA,
			Referer: watchUrl,
			Accept: "application/json",
			Origin: MAPPLE_BASE,
		});

		if (!apiResp || apiResp.length < 10) {
			return null;
		}

		var apiData;
		try {
			apiData = JSON.parse(apiResp);
		} catch (e) {
			return null;
		}

		if (
			!apiData ||
			!apiData.success ||
			!apiData.data ||
			!apiData.data.stream_url
		) {
			return null;
		}

		var streamUrl = apiData.data.stream_url;

		// ── Fetch the stream URL and parse ALL quality variants ──
		var streamHeaders = {
			"User-Agent": UA,
			Referer: MAPPLE_BASE + "/",
		};

		var m3u8Streams = await fetchM3U8AndParse(
			streamUrl,
			streamHeaders,
			streamHeaders,
		);

		if (m3u8Streams && m3u8Streams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: m3u8Streams,
				latency_ms: Date.now() - start,
			};
		}

		// Return the stream URL as-is
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: streamUrl,
					quality: "Auto",
					headers: streamHeaders,
				},
			],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return null;
	}
}

/**
 * Fallback: Return the Mapple watch URL as an embed stream.
 */
async function embedFallback(tmdbId, type, season, episode, start) {
	try {
		var watchUrl;
		if (type === "tv") {
			watchUrl =
				MAPPLE_BASE + "/watch/tv/" + tmdbId + "-" + season + "-" + episode;
		} else {
			watchUrl = MAPPLE_BASE + "/watch/movie/" + tmdbId;
		}

		try {
			var resp = await httpGet(watchUrl, {
				"User-Agent": UA,
				Referer: MAPPLE_BASE + "/",
				Accept: "text/html,application/xhtml+xml",
			});
			if (!resp || resp.length < 10) {
				watchUrl =
					"https://mappletv.uk/embed/" +
					(type === "tv"
						? "tv/" + tmdbId + "/" + season + "/" + episode
						: "movie/" + tmdbId);
			}
		} catch (e) {
			watchUrl =
				"https://mappletv.uk/embed/" +
				(type === "tv"
					? "tv/" + tmdbId + "/" + season + "/" + episode
					: "movie/" + tmdbId);
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: watchUrl,
					quality: "Auto",
					headers: { "User-Agent": UA, Referer: MAPPLE_BASE + "/" },
				},
			],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: e.message || "embed fallback failed",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
