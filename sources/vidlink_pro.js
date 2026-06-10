/**
 * =============================================================================
 *  SOURCE: vidlink.pro — HLS Direct (master playlist + subtitles)
 *  =============================================================================
 *  CHAIN:
 *    1. enc-dec.app/api/enc-vidlink?text={tmdbId}  →  encrypted ID
 *    2. vidlink.pro/api/b/{type}/{encId}?multiLang=0  →  stream data with
 *       master playlist URL + captions
 *    3. Returns the master playlist URL directly (player handles variant selection)
 *
 *  KEY DECISION:
 *    We return the master playlist URL instead of parsing it into quality
 *    variants. This eliminates M3U8 parsing complexity and URL resolution bugs.
 *    The player's HLS parser (ExoPlayer/AVPlayer) handles variant selection
 *    natively and is more robust at resolving relative segment URLs with
 *    complex query parameters.
 *
 *  QUALITIES: Player-selected from master playlist (typically 1080p, 720p, 360p)
 *  SUBTITLES: Multi-language VTT from vidlink API captions
 * =============================================================================
 */

var { httpGet } = require("./_shared");
var SOURCE_NAME = "vidlink.pro";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	var embedUrl =
		"https://vidlink.pro/" +
		type +
		"/" +
		tmdbId +
		(type === "tv" ? "/" + season + "/" + episode : "");

	try {
		// ── Step 1: Encrypt TMDB ID via enc-dec.app ──────────────────────────
		var encResp;
		try {
			encResp = await httpGet(
				ENC_API + "?text=" + encodeURIComponent(String(tmdbId)),
				{
					"User-Agent": BROWSER_UA,
					Accept: "application/json",
				},
			);
		} catch (e) {
			return errorResult("encryption request failed: " + e.message);
		}

		var encData = JSON.parse(encResp);
		if (!encData || encData.status !== 200 || !encData.result) {
			return errorResult("encryption failed: invalid response");
		}

		var encId = encData.result;

		// ── Step 2: Call vidlink.pro API to get stream data ──────────────────
		var apiUrl =
			type === "movie"
				? VIDLINK_API + "/movie/" + encId + "?multiLang=0"
				: VIDLINK_API +
					"/tv/" +
					encId +
					"/" +
					season +
					"/" +
					episode +
					"?multiLang=0";

		var streamResp;
		try {
			streamResp = await httpGet(apiUrl, {
				"User-Agent": BROWSER_UA,
				Referer: "https://vidlink.pro/",
				Accept: "application/json",
			});
		} catch (e) {
			return errorResult("stream API failed: " + e.message);
		}

		var streamData = JSON.parse(streamResp);
		if (!streamData || !streamData.stream || !streamData.stream.playlist) {
			return {
				source: SOURCE_NAME,
				embedUrl: embedUrl,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var playlistUrl = streamData.stream.playlist;

		// ── Extract subtitles / captions ──────────────────────────────────────
		var captions = [];
		if (streamData.stream.captions) {
			for (var ci = 0; ci < streamData.stream.captions.length; ci++) {
				var c = streamData.stream.captions[ci];
				var subUrl = c.url || c.id || "";
				if (subUrl) {
					captions.push({
						url: subUrl,
						label:
							subUrl.indexOf(".vtt") !== -1
								? "VTT"
								: (c.type || "SRT").toUpperCase(),
						lang: c.language || c.label || "unknown",
					});
				}
			}
		}

		// ── Return master playlist directly (no variant parsing) ─────────────
		// The player's HLS engine handles variant selection from the master
		// playlist more reliably than our custom M3U8 parser.
		var streams = [
			{
				url: playlistUrl,
				type: "hls",
				quality: "", // Let player auto-select
				resolution: "",
				headers: {
					"User-Agent": BROWSER_UA,
					Referer: "https://vidlink.pro/",
				},
			},
		];

		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "working",
			streams: streams,
			subtitles: captions.length > 0 ? captions : undefined,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return errorResult(e.message);
	}

	function errorResult(msg) {
		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "error",
			error: msg || "unknown error",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
