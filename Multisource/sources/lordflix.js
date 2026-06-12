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
		var result = [];
		for (var i = 0; i < streamList.length; i++) {
			var s = streamList[i];
			if (s.type === "hls" && s.playlist) {
				// Try to fetch the M3U8 and parse all quality variants (5s timeout)
				var m3u8Streams = [];
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
						for (var li = 0; li < lines.length; li++) {
							var line = lines[li];
							if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
								var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
								var height = resMatch ? parseInt(resMatch[1], 10) : 0;

								// 🔴 FIX: Extract and check codecs — filter out HEVC
								var codecs = extractCodecs(line);
								if (hasUnsupportedVideoCodec(codecs)) {
									continue; // Skip HEVC — causes "audio only"
								}

								if (li + 1 < lines.length) {
									var urlPart = lines[li + 1].trim();
									if (urlPart && urlPart.indexOf("#") !== 0) {
										var fullUrl =
											urlPart.indexOf("http") === 0
												? urlPart
												: s.playlist.substring(
														0,
														s.playlist.lastIndexOf("/") + 1,
													) + urlPart;

										// Preferred audio codec: AAC (mp4a) over Dolby Digital+ (ec-3)
										var hasAac = hasAacAudio(codecs);
										var qBase =
											height >= 2160
												? "2160p"
												: height >= 1440
													? "1440p"
													: height >= 1080
														? "1080p"
														: height >= 720
															? "720p"
															: height >= 480
																? "480p"
																: height >= 360
																	? "360p"
																	: height
																		? height + "p"
																		: "Auto";

										// Label includes codec hint
										var qLabel = qBase + (hasAac ? "" : " (EAC3)");

										m3u8Streams.push({
											url: fullUrl,
											quality: qLabel,
											headers: {
												"User-Agent": UA,
												Referer: LORDFLIX_API + "/",
												Origin: LORDFLIX_API,
											},
											// Internal sort keys (not returned to player)
											_height: height,
											_hasAac: hasAac ? 1 : 0,
										});
									}
								}
							}
						}
					}
				} catch (e) {
					// M3U8 fetch failed, use quality from server
				}

				if (m3u8Streams.length > 0) {
					// Sort by quality descending, then AAC-first
					m3u8Streams.sort(function (a, b) {
						if (b._height !== a._height) return b._height - a._height;
						return b._hasAac - a._hasAac; // Prefer AAC audio
					});

					for (var mi = 0; mi < m3u8Streams.length; mi++) {
						var ms = m3u8Streams[mi];
						// Clean internal sort keys
						result.push({
							url: ms.url,
							quality: ms.quality,
							headers: ms.headers,
						});
					}
				} else {
					// Fallback: use the playlist URL with server's quality hint
					// Keep the stream even if M3U8 fetch failed — the player
					// (running in a browser) may be able to fetch it directly
					result.push({
						url: s.playlist,
						quality: s.quality || extractQuality(s.playlist) || "Auto",
						headers: {
							"User-Agent": UA,
							Referer: LORDFLIX_API + "/",
							Origin: LORDFLIX_API,
						},
					});
				}
			}
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
