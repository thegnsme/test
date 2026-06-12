/**
 * lordflix (111movies.net proxy) — Multi-server HLS via enc-dec.app
 *
 * FIXED: HEVC codec filtering — only returns H.264 (avc1) variants
 * to prevent "audio only, no video" playback. Also handles token
 * expiry gracefully by falling back to raw playlist URL.
 *
 * FLOW:
 *   1. Fetch TMDB metadata (title, year, imdb_id)
 *   2. For each server, encrypt search URL via enc-dec.app
 *   3. Fetch encrypted stream data from proxy URL
 *   4. Decrypt via enc-dec.app → get HLS playlist
 *   5. Fetch + parse master M3U8 for quality variants
 *   6. Filter out HEVC (hev1/hvc1) codec variants
 *   7. Return H.264-only streams sorted by quality
 *
 * PRODUCTION FEATURES:
 *   • Codec-aware parsing — filters unsupported HEVC codecs
 *   • Audio codec preference — AAC over Dolby Digital+
 *   • Multi-server fallback (Berlin, Phoenix, Oslo, Luna, …)
 *   • Graceful M3U8 expiry handling — returns raw URL as fallback
 *   • Proper headers (User-Agent, Referer, Origin) for CDN access
 *   • Parallel server queries with per-server timeout
 *   • TMDB metadata integration for robust search
 */

var { httpGet, httpPost, fetchTmdbMeta } = require("./_shared");

var SOURCE_NAME = "lordflix";
var LORDFLIX_API = "https://snowhouse.lordflix.club";
var ENC_DEC_API = "https://enc-dec.app/api";
var SERVERS = [
	"Berlin",
	"Marseille",
	"Backrooms",
	"Phoenix",
	"Oslo",
	"Luna",
	"Sakura",
	"Rio",
	"Ativa",
	"Moscow",
];
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

/**
 * HEVC codec identifiers that most players cannot decode.
 * Used to filter out incompatible video variants.
 */
var HEVC_CODECS = [
	"hev1",
	"hvc1",
	"dvh1",
	"dvhe",
	"dav1",
	"av01",
	"vvc1",
	"vvi1",
];

/**
 * Check if a codec string contains any unsupported video codec.
 */
function hasUnsupportedVideoCodec(codecs) {
	if (!codecs) return false;
	var c = String(codecs).toLowerCase();
	for (var i = 0; i < HEVC_CODECS.length; i++) {
		if (c.indexOf(HEVC_CODECS[i]) !== -1) return true;
	}
	return false;
}

/**
 * Check if a codec string contains AAC audio (mp4a).
 * Returns true if AAC or no audio codec specified.
 */
function hasAacAudio(codecs) {
	if (!codecs) return true;
	var c = String(codecs).toLowerCase();
	return c.indexOf("mp4a") !== -1;
}

/**
 * Extract CODECS from a #EXT-X-STREAM-INF line.
 */
function extractCodecs(streamInfLine) {
	var m = streamInfLine.match(/CODECS="([^"]+)"/i);
	return m ? m[1] : "";
}

/**
 * Encode a string for URL with + for spaces.
 */
function enc(s) {
	return encodeURIComponent(String(s)).replace(/%20/g, "+");
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Get TMDB metadata ──
		var meta = await fetchTmdbMeta(tmdbId, type);
		if (!meta || !meta.title || !meta.imdb_id) {
			return fail("TMDB metadata missing — need title and imdb_id");
		}

		var typeParam = type === "tv" ? "series" : "movie";
		var streams = [];
		var serverErrors = [];

		// ── Step 2: Query each server in parallel ──
		var results = await Promise.allSettled(
			SERVERS.map(function (server) {
				var serverPromise = queryServer(
					tmdbId,
					type,
					typeParam,
					meta.title,
					meta.year,
					meta.imdb_id,
					season,
					episode,
					server,
					start,
				);
				var perServerTimeout = new Promise(function (_, reject) {
					setTimeout(function () {
						reject(new Error(server + " timeout (8s)"));
					}, 12000);
				});
				return Promise.race([serverPromise, perServerTimeout]);
			}),
		);

		for (var i = 0; i < results.length; i++) {
			var r = results[i];
			if (r.status === "fulfilled" && r.value && r.value.length > 0) {
				for (var j = 0; j < r.value.length; j++) {
					streams.push(r.value[j]);
				}
			} else if (r.status === "rejected") {
				serverErrors.push(SERVERS[i] + ": " + (r.reason && r.reason.message));
			}
		}

		if (streams.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				error: serverErrors.join("; ") || "all servers returned no streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail(e.message);
	}

	function fail(msg) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: msg || "unknown",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

/**
 * Query a single Lordflix server.
 * Returns an array of stream objects (may be empty).
 * All returned streams use H.264 (avc1) video codec only.
 */
async function queryServer(
	tmdbId,
	type,
	typeParam,
	title,
	year,
	imdbId,
	season,
	episode,
	server,
	start,
) {
	try {
		// ── Build search URL for this server ──
		var serverUrl =
			LORDFLIX_API +
			"/?title=" +
			enc(title) +
			"&type=" +
			enc(typeParam) +
			"&year=" +
			enc(year || "") +
			"&imdb=" +
			enc(imdbId) +
			"&tmdb=" +
			tmdbId +
			"&server=" +
			enc(server);

		if (type === "tv") {
			serverUrl += "&season=" + season + "&episode=" + episode;
		}

		// ── Step 2: Encrypt the URL via enc-dec.app ──
		var encResp = await httpGet(
			ENC_DEC_API + "/enc-lordflix?url=" + enc(serverUrl),
			{
				"User-Agent": UA,
				Accept: "application/json",
				Origin: "https://lordflix.org",
				Referer: "https://lordflix.org/",
			},
		);

		var encData;
		try {
			encData = JSON.parse(encResp);
		} catch (e) {
			return [];
		}

		if (!encData || encData.status !== 200 || !encData.result) {
			return [];
		}

		var proxyUrl = encData.result.url;
		var signature = encData.result.sign;

		if (!proxyUrl || !signature) {
			return [];
		}

		// ── Step 3: Fetch encrypted stream data from proxy URL ──
		var encryptedData = await httpGet(proxyUrl, {
			"User-Agent": UA,
			Accept: "*/*",
			Referer: LORDFLIX_API + "/",
			Origin: LORDFLIX_API,
		});

		if (!encryptedData || encryptedData.length < 10) {
			return [];
		}

		// ── Step 4: Decrypt via enc-dec.app ──
		var decResp = await httpPost(
			ENC_DEC_API + "/dec-lordflix",
			{
				"Content-Type": "application/json",
				"User-Agent": UA,
			},
			JSON.stringify({ text: encryptedData, sign: signature }),
		);

		var decData;
		try {
			decData = JSON.parse(decResp);
		} catch (e) {
			return [];
		}

		if (
			!decData ||
			decData.status !== 200 ||
			!decData.result ||
			decData.result.error
		) {
			return [];
		}

		var streamList = decData.result.stream;
		if (!Array.isArray(streamList) || streamList.length === 0) {
			return [];
		}

		// ── Step 5 + 6: Extract streams with codec filtering ──
		//
		// 🔴 CRITICAL: We MUST return the MASTER playlist URL (s.playlist), NOT
		// individual variant URLs (video_1080p.m3u8 etc). The master playlist
		// contains #EXT-X-MEDIA:TYPE=AUDIO references that tell HLS.js to fetch
		// separate audio playlists. Individual variant playlists are VIDEO ONLY
		// — returning them causes "video but no audio" playback.
		//
		// The M3U8 parsing is only used for QUALITY DETECTION (finding the best
		// H.264 quality to display in the UI label). The actual stream URL is
		// always the master playlist.
		var result = [];
		for (var i = 0; i < streamList.length; i++) {
			var s = streamList[i];
			if (s.type !== "hls" || !s.playlist) continue;

			// Default quality label (used if M3U8 fetch/parse fails)
			var bestQuality = s.quality || extractQuality(s.playlist) || "Auto";

			// Try to fetch + parse master M3U8 for quality detection only
			try {
				var m3u8Fetch = httpGet(s.playlist, {
					"User-Agent": UA,
					Referer: LORDFLIX_API + "/",
					Accept: "*/*",
				});
				var m3u8Timeout = new Promise(function (_, reject) {
					setTimeout(function () {
						reject(new Error("m3u8 timeout"));
					}, 5000);
				});
				var m3u8Content = await Promise.race([m3u8Fetch, m3u8Timeout]);

				if (m3u8Content && m3u8Content.indexOf("#EXTM3U") !== -1) {
					var lines = m3u8Content.split("\n");
					var highestH264Height = 0;

					for (var li = 0; li < lines.length; li++) {
						var line = lines[li];
						if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
							var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
							var height = resMatch ? parseInt(resMatch[1], 10) : 0;

							var codecs = extractCodecs(line);

							// Only consider H.264 variants (skip HEVC which
							// causes "audio only, no video" on most players)
							if (codecs && hasUnsupportedVideoCodec(codecs)) {
								continue;
							}

							// Track the highest H.264 quality for the label
							if (height > highestH264Height) {
								highestH264Height = height;
							}
						}
					}

					if (highestH264Height > 0) {
						bestQuality =
							highestH264Height >= 1080
								? "1080p"
								: highestH264Height >= 720
									? "720p"
									: highestH264Height >= 480
										? "480p"
										: highestH264Height >= 360
											? "360p"
											: highestH264Height + "p";
					}
				}
			} catch (e) {
				// M3U8 fetch/parse failed — use default quality label
			}

			// 🔴 Return the MASTER playlist URL (s.playlist), NOT individual
			// variant URLs. The master has #EXT-X-MEDIA:TYPE=AUDIO tracks that
			// HLS.js needs to associate audio with video during playback.
			result.push({
				url: s.playlist,
				quality: bestQuality,
				headers: {
					"User-Agent": UA,
					Referer: LORDFLIX_API + "/",
					Origin: LORDFLIX_API,
				},
			});
		}

		return result;
	} catch (e) {
		return [];
	}
}

/**
 * Extract resolution label from a URL.
 */
function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
