/**
 * =============================================================================
 *  SOURCE: lordflix.org — HLS Direct via Encrypted API
 *  =============================================================================
 *  CHAIN:
 *    1. Get TMDB metadata (title, year, imdb_id) for the content
 *    2. Build snowhouse.lordflix.club URL with metadata & server
 *    3. enc-dec.app/api/enc-lordflix?url={snowhouse_url} → { url, sign }
 *    4. GET the encrypted URL → encrypted text
 *    5. POST enc-dec.app/api/dec-lordflix { text, sign } → stream data
 *
 *  SERVERS: Berlin, Nilesat, etc. (from snowhouse.lordflix.club/servers)
 *  QUALITIES: Depends on server — typically 1080p, 720p
 * =============================================================================
 */

var { httpGet, httpPost, fetchTmdbMeta } = require("./_shared");
var SOURCE_NAME = "lordflix.org";
var ENC_API = "https://enc-dec.app/api/enc-lordflix";
var DEC_API = "https://enc-dec.app/api/dec-lordflix";
var SNOWHOUSE = "https://snowhouse.lordflix.club";
var SERVERS = ["Berlin", "Rapid"];

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Get TMDB metadata (title, year, imdb_id) ────────────────
		var meta = await fetchTmdbMeta(tmdbId, type);
		if (!meta || !meta.title) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var encTitle = encodeURIComponent(meta.title);
		var lfType = type === "tv" ? "series" : "movie";
		var imdb = meta.imdb_id || "";
		var year = meta.year || "";

		// Try each server until one works
		for (var si = 0; si < SERVERS.length; si++) {
			var server = SERVERS[si];

			// ── Step 2: Build snowhouse URL ──────────────────────────────────
			var snowUrl =
				SNOWHOUSE +
				"/?title=" +
				encTitle +
				"&type=" +
				lfType +
				"&year=" +
				encodeURIComponent(year) +
				"&imdb=" +
				encodeURIComponent(imdb) +
				"&tmdb=" +
				String(tmdbId) +
				"&server=" +
				server +
				(type === "tv" ? "&season=" + season + "&episode=" + episode : "");

			// ── Step 3: Encrypt URL ──────────────────────────────────────────
			var encResp;
			try {
				encResp = await httpGet(
					ENC_API + "?url=" + encodeURIComponent(snowUrl),
					{
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Accept: "application/json",
					},
				);
			} catch (e) {
				continue;
			}

			var encData = JSON.parse(encResp);
			if (
				!encData ||
				encData.status !== 200 ||
				!encData.result ||
				!encData.result.url
			) {
				continue;
			}

			var encUrl = encData.result.url;
			var sign = encData.result.sign || "";

			// ── Step 4: Fetch encrypted stream data ──────────────────────────
			var encrypted;
			try {
				encrypted = await httpGet(encUrl, {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					Referer: "https://lordflix.org/",
					Origin: "https://lordflix.org",
				});
			} catch (e) {
				continue;
			}

			if (!encrypted || encrypted.length < 10) continue;

			// ── Step 5: Decrypt ──────────────────────────────────────────────
			var decResp;
			try {
				decResp = await httpPost(
					DEC_API,
					{
						"Content-Type": "application/json",
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
					},
					JSON.stringify({ text: encrypted, sign: sign }),
				);
			} catch (e) {
				continue;
			}

			var decData = JSON.parse(decResp);
			if (!decData || decData.status !== 200 || !decData.result) {
				continue;
			}

			// ── Build stream results ─────────────────────────────────────────
			var result = decData.result;
			var streams = [];
			var subtitles = [];

			// Check if result is an array (multiple servers/qualities)
			var rawSources = Array.isArray(result) ? result : [result];

			for (var ri = 0; ri < rawSources.length; ri++) {
				var item = rawSources[ri];
				if (item && item.url) {
					streams.push({
						url: item.url,
						type: "hls",
						quality: item.quality || item.label || "",
						resolution: "",
						headers: { Referer: "https://lordflix.org/" },
					});
				}

				// Check for subtitles
				var subs = item.tracks || item.subtitles || [];
				for (var subi = 0; subi < subs.length; subi++) {
					var sub = subs[subi];
					if (sub && sub.url) {
						subtitles.push({
							url: sub.url,
							label: "VTT",
							lang: sub.language || sub.lang || "unknown",
						});
					}
				}
			}

			if (streams.length > 0) {
				return {
					source: SOURCE_NAME + " [" + server + "]",
					embedUrl: snowUrl,
					status: "working",
					streams: streams,
					subtitles: subtitles.length > 0 ? subtitles : undefined,
					latency_ms: Date.now() - start,
				};
			}
		}

		// All servers failed
		return {
			source: SOURCE_NAME,
			status: "no_streams",
			streams: [],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return {
			source: SOURCE_NAME,
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
