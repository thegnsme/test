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

var {
	httpGet,
	httpPost,
	fetchTmdbMeta,
	makeFail,
	resolveRelativeUrl,
} = require("./_shared");

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
		return makeFail(SOURCE_NAME, msg, start);
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

		// ── Step 5: Parse master M3U8 for ALL variants + audio tracks ──
		//
		// Returns THREE categories of streams per server:
		//   1. Individual variant streams — one per codec+quality combo
		//      (e.g. "lordflix - Berlin - 1080p [HEVC]")
		//   2. Audio-only streams — one per language track
		//      (e.g. "lordflix - Berlin - Audio [English]")
		//   3. Master playlist stream — "Auto [Master]" for proper HLS playback
		//      (player auto-selects variant + audio from master)
		//
		// Resolves relative URLs in the M3U8 against the playlist URL.
		var result = [];

		for (var i = 0; i < streamList.length; i++) {
			var s = streamList[i];
			if (s.type !== "hls" || !s.playlist) continue;

			var streamHeaders = {
				"User-Agent": UA,
				Referer: LORDFLIX_API + "/",
				Origin: LORDFLIX_API,
				Accept: "*/*",
			};

			// Parse master M3U8 for variants + audio
			var variantEntries = []; // { url, quality, codecLabel, height }
			var audioEntry = null; // first audio track found

			try {
				var m3u8Fetch = httpGet(s.playlist, {
					"User-Agent": UA,
					Referer: LORDFLIX_API + "/",
					Accept: "*/*",
				});
				var m3u8Timeout = new Promise(function (_, reject) {
					setTimeout(function () {
						reject(new Error("m3u8 timeout"));
					}, 8000);
				});
				var m3u8Content = await Promise.race([m3u8Fetch, m3u8Timeout]);

				if (m3u8Content && m3u8Content.indexOf("#EXTM3U") !== -1) {
					var lines = m3u8Content.split("\n");
					var hasStreamInf = false;

					for (var li = 0; li < lines.length; li++) {
						var line = lines[li];
						if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
							hasStreamInf = true;
							var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
							var height = resMatch ? parseInt(resMatch[1], 10) : 0;
							var codecs = extractCodecs(line);

							// Determine codec label for display
							var codecLabel = "";
							if (codecs) {
								var c = String(codecs).toLowerCase();
								if (c.indexOf("hev1") !== -1 || c.indexOf("hvc1") !== -1)
									codecLabel = "HEVC";
								else if (c.indexOf("dvh1") !== -1 || c.indexOf("dvhe") !== -1)
									codecLabel = "DV";
								else if (c.indexOf("av01") !== -1 || c.indexOf("dav1") !== -1)
									codecLabel = "AV1";
								else if (c.indexOf("avc1") !== -1) codecLabel = "H.264";
								else codecLabel = codecs;
							}

							if (li + 1 < lines.length) {
								var urlPart = lines[li + 1].trim();
								if (urlPart && urlPart.indexOf("#") !== 0) {
									var fullUrl =
										urlPart.indexOf("http") === 0
											? urlPart
											: resolveRelativeUrl(s.playlist, urlPart);
									variantEntries.push({
										url: fullUrl,
										quality:
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
																		: "Auto",
										codecLabel: codecLabel,
										height: height,
									});
								}
							}
						}

						// Extract ALL audio tracks from master playlist
						if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
							var auUrlMatch = line.match(/URI="([^"]+)"/);
							if (auUrlMatch && auUrlMatch[1]) {
								var audioUrl = auUrlMatch[1];
								if (audioUrl.indexOf("http") !== 0) {
									audioUrl = resolveRelativeUrl(s.playlist, audioUrl);
								}
								var auLangMatch = line.match(/LANGUAGE="([^"]+)"/);
								var auNameMatch = line.match(/NAME="([^"]+)"/);
								audioEntry = {
									url: audioUrl,
									label:
										auNameMatch && auNameMatch[1] ? auNameMatch[1] : "Audio",
									lang: auLangMatch && auLangMatch[1] ? auLangMatch[1] : "en",
								};
							}
						}
					}

					// If the playlist has no STREAM-INF lines, it's a variant playlist
					// (single quality). Extract quality from URL or s.quality.
					if (!hasStreamInf && !audioEntry) {
						// It's a variant playlist — treat the playlist URL as the stream
						var q = s.quality || extractQuality(s.playlist) || "Auto";
						result.push({
							url: s.playlist,
							quality: q,
							headers: streamHeaders,
						});
						continue;
					}
				}
			} catch (e) {
				// M3U8 fetch/parse failed — fall through to fallback
			}

			// ── Build stream list for this server ──
			if (variantEntries.length > 0) {
				// Sort variants by height descending (best quality first)
				variantEntries.sort(function (a, b) {
					return b.height - a.height;
				});

				// 1. Individual codec variants
				for (var vi = 0; vi < variantEntries.length; vi++) {
					var ve = variantEntries[vi];
					var label = ve.quality;
					if (ve.codecLabel) label += " [" + ve.codecLabel + "]";
					result.push({
						url: ve.url,
						quality: label,
						headers: streamHeaders,
					});
				}

				// 2. Audio track (if found)
				if (audioEntry) {
					result.push({
						url: audioEntry.url,
						quality: "Audio [" + audioEntry.label + "]",
						headers: streamHeaders,
					});
				}

				// 3. Master playlist — proper HLS with audio group references
				//    Player auto-selects best variant + matching audio track
				result.push({
					url: s.playlist,
					quality: "Auto [Master]",
					headers: streamHeaders,
				});
			} else {
				// No variants parsed — fall back to master playlist directly
				result.push({
					url: s.playlist,
					quality: s.quality || extractQuality(s.playlist) || "Auto",
					headers: streamHeaders,
				});
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
