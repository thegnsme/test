/**
 * vidlink.pro — HLS master playlist + subtitles
 *
 * Returns the master playlist URL directly. Player handles variant selection.
 * Each stream object carries its own subtitles.
 */
var {
	httpGet,
	fetchM3U8AndParse,
	copyHeaders,
	makeFail,
} = require("./_shared");
var SOURCE_NAME = "vidlink.pro";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_API = "https://vidlink.pro/api/b";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// Step 1: Encrypt TMDB ID
		var encResp = JSON.parse(
			await httpGet(ENC_API + "?text=" + encodeURIComponent(String(tmdbId)), {
				"User-Agent": UA,
				Accept: "application/json",
			}),
		);
		if (!encResp || encResp.status !== 200 || !encResp.result) {
			return fail("encryption failed");
		}
		var encId = encResp.result;

		// Step 2: Call vidlink API
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

		var streamData = JSON.parse(
			await httpGet(apiUrl, {
				"User-Agent": UA,
				Referer: "https://vidlink.pro/",
				Accept: "application/json",
			}),
		);

		if (!streamData || !streamData.stream || !streamData.stream.playlist) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var playlistUrl = streamData.stream.playlist;

		// Build subtitles
		var subs = [];
		if (streamData.stream.captions) {
			for (var i = 0; i < streamData.stream.captions.length; i++) {
				var c = streamData.stream.captions[i];
				var u = c.url || c.id || "";
				if (u) {
					subs.push({
						url: u,
						label:
							u.indexOf(".vtt") !== -1
								? "VTT"
								: (c.type || "SRT").toUpperCase(),
						lang: c.language || c.label || "en",
					});
				}
			}
		}

		var streamHeaders = {
			"User-Agent": UA,
			Referer: "https://vidlink.pro/",
		};

		// Step 3: Fetch the master playlist and parse ALL quality variants
		var m3u8Streams = await fetchM3U8AndParse(
			playlistUrl,
			streamHeaders,
			streamHeaders,
		);

		// If M3U8 parsing returned results, use those (multi-quality)
		if (m3u8Streams && m3u8Streams.length > 0) {
			// Attach subtitles to each stream
			for (var si = 0; si < m3u8Streams.length; si++) {
				if (subs.length > 0) {
					m3u8Streams[si].subtitles = subs;
				}
			}
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: m3u8Streams,
				latency_ms: Date.now() - start,
			};
		}

		// Fallback: return the playlist URL as-is
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: playlistUrl,
					headers: streamHeaders,
					subtitles: subs.length > 0 ? subs : undefined,
				},
			],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail(e.message);
	}

	function fail(msg) {
		return makeFail(SOURCE_NAME, msg, start);
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
