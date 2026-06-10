/**
 * =============================================================================
 *  SOURCE: vidlink.pro — HLS Direct (quality variants + subtitles)
 *  =============================================================================
 *  CHAIN:
 *    1. enc-dec.app/api/enc-vidlink?text={tmdbId}  →  encrypted ID
 *    2. vidlink.pro/api/b/{type}/{encId}?multiLang=0  →  stream data
 *    3. Fetch master playlist → parse quality variants
 *
 *  RETURNS: Direct M3U8 URLs with quality variants and multi-language VTT subtitles.
 * =============================================================================
 */

var { httpGet } = require("./_shared");
var SOURCE_NAME = "vidlink.pro";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var QUALITY_MAP = {
	360: "360p",
	480: "480p",
	720: "720p",
	1080: "1080p",
	2160: "4K",
};

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
		// ── Step 1: Encrypt TMDB ID ───────────────────────────────────────────
		var encResp;
		try {
			encResp = await httpGet(
				ENC_API + "?text=" + encodeURIComponent(String(tmdbId)),
				{
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

		// ── Step 2: Call vidlink.pro API ──────────────────────────────────────
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
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
						lang: c.language || c.label || "unknown",
						type: subUrl.indexOf(".vtt") !== -1 ? "vtt" : c.type || "srt",
					});
				}
			}
		}

		// ── Step 3: Fetch master playlist for quality variants ────────────────
		var m3u8Data;
		try {
			m3u8Data = await httpGet(playlistUrl, {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				Referer: "https://vidlink.pro/",
			});
		} catch (e) {
			// Playlist fetch failed — return main URL as fallback
			return {
				source: SOURCE_NAME,
				embedUrl: embedUrl,
				status: "working",
				streams: [
					{
						url: playlistUrl,
						type: "hls",
						quality: "",
						resolution: "",
						headers: { Referer: "https://vidlink.pro/" },
					},
				],
				subtitles: captions.length > 0 ? captions : undefined,
				latency_ms: Date.now() - start,
			};
		}

		// ── Parse M3U8 ────────────────────────────────────────────────────────
		var streams = [];
		if (
			m3u8Data &&
			typeof m3u8Data === "string" &&
			m3u8Data.indexOf("#EXTM3U") === 0
		) {
			if (m3u8Data.indexOf("#EXT-X-STREAM-INF:") !== -1) {
				// Master playlist — parse quality variants
				var lines = m3u8Data.split("\n");
				for (var li = 0; li < lines.length; li++) {
					if (lines[li].indexOf("#EXT-X-STREAM-INF:") === -1) continue;

					var bwMatch = lines[li].match(/BANDWIDTH=(\d+)/);
					var resMatch = lines[li].match(/RESOLUTION=(\d+x\d+)/);
					var nextLine = (lines[li + 1] || "").trim();

					if (nextLine && nextLine.indexOf("#") !== 0) {
						var streamUrl = nextLine;
						if (streamUrl.indexOf("http") !== 0) {
							var baseUrl = playlistUrl;
							var lastSlash = baseUrl.lastIndexOf("/");
							if (lastSlash !== -1)
								streamUrl = baseUrl.substring(0, lastSlash + 1) + streamUrl;
						}

						var res = resMatch ? resMatch[1] : "";
						var height = res ? res.split("x")[1] : "";
						var quality = QUALITY_MAP[height] || (height ? height + "p" : "");

						streams.push({
							url: streamUrl,
							type: "hls",
							quality: quality,
							resolution: res,
							bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : undefined,
							headers: { Referer: "https://vidlink.pro/" },
						});
						li++;
					}
				}
			}

			// If no variants parsed or not a master playlist, add the URL as-is
			if (streams.length === 0) {
				streams.push({
					url: playlistUrl,
					type: "hls",
					quality: "",
					resolution: "",
					headers: { Referer: "https://vidlink.pro/" },
				});
			}
		} else {
			streams.push({
				url: playlistUrl,
				type: "hls",
				quality: "",
				resolution: "",
				headers: { Referer: "https://vidlink.pro/" },
			});
		}

		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: streams.length > 0 ? "working" : "no_streams",
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
