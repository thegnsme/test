/**
 * apiplayer.ru — Direct HLS Proxy with Multi-Quality
 *
 * apiplayer.ru provides a streaming API that exposes HLS master playlists
 * via a proxy. No JavaScript execution required — the M3U8 URLs work directly.
 *
 * Flow:
 *   1. Fetch /embed/movie/{tmdbId} to extract window.__MPLAYER__ config
 *   2. Parse imdbId and vidsrcProxyUrl from config
 *   3. Build HLS proxy URL: /hls-proxy/master/{imdbId}
 *   4. Fetch master M3U8 playlist → extract ALL quality variants
 *   5. Return one stream per quality level (360p, 720p, 1080p)
 *
 * TV support:
 *   /hls-proxy/master/{imdbId}/{season}/{episode}
 *
 * Headers: Referer (https://apiplayer.ru/), standard browser UA
 * Rate limit: 60 req/min
 *
 * URL patterns:
 *   Embed:  https://apiplayer.ru/embed/movie/{tmdbId}
 *   HLS:    https://apiplayer.ru/hls-proxy/master/{imdbId}
 *   TV HLS: https://apiplayer.ru/hls-proxy/master/{imdbId}/{season}/{episode}
 */

var { httpGet, extractJsValue, makeFail } = require("./_shared");

var SOURCE_NAME = "apiplayer.ru";
var BASE_URL = "https://apiplayer.ru";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

/**
 * Parse window.__MPLAYER__ config from HTML.
 * Returns { imdbId, tmdbId, vidsrcProxyUrl } or null.
 */
function parseMPlayerConfig(html) {
	if (!html) return null;
	// Try to find the __MPLAYER__ JSON config
	var m = html.match(/window\.__MPLAYER__\s*=\s*({[\s\S]*?});/);
	if (!m || !m[1]) return null;
	try {
		var config = JSON.parse(m[1]);
		if (config && config.imdbId) {
			return {
				imdbId: config.imdbId,
				tmdbId: config.tmdbId,
				vidsrcProxyUrl: config.vidsrcProxyUrl || "",
			};
		}
	} catch (e) {
		// JSON parse failed
		return null;
	}
	return null;
}

/**
 * Extract all quality variants from an M3U8 master playlist.
 * Returns array of stream objects sorted by quality descending.
 */
function parseM3U8All(m3u8Content, baseUrl, headers) {
	if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
		return null;
	}
	var lines = m3u8Content.split("\n");
	var streams = [];
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var h = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl;
					if (urlPart.indexOf("http") === 0) {
						fullUrl = urlPart;
					} else if (urlPart.indexOf("//") === 0) {
						fullUrl = "https:" + urlPart;
					} else if (urlPart.indexOf("/") === 0) {
						// Absolute path — prepend origin (scheme + host)
						var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
						fullUrl =
							(originMatch ? originMatch[1] : "https://apiplayer.ru") + urlPart;
					} else {
						// Relative path — resolve against base URL directory
						fullUrl = baseUrl.replace(/\/[^/]*$/, "/") + urlPart;
					}
					var q =
						h >= 2160
							? "2160p"
							: h >= 1440
								? "1440p"
								: h >= 1080
									? "1080p"
									: h >= 720
										? "720p"
										: h >= 480
											? "480p"
											: h >= 360
												? "360p"
												: h
													? h + "p"
													: "Auto";
					streams.push({
						url: fullUrl,
						quality: q,
						headers: headers || {},
						height: h,
					});
				}
			}
		}
	}
	if (streams.length === 0) return null;
	streams.sort(function (a, b) {
		return b.height - a.height;
	});
	return streams;
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Fetch the embed page to get IMDB ID ──
		var embedUrl;
		if (type === "tv") {
			embedUrl =
				BASE_URL + "/embed/tv/" + tmdbId + "/" + season + "/" + episode;
		} else {
			embedUrl = BASE_URL + "/embed/movie/" + tmdbId;
		}

		var embedHtml = await httpGet(embedUrl, {
			"User-Agent": UA,
			Referer: BASE_URL + "/",
			Accept: "text/html,application/xhtml+xml",
		});

		if (!embedHtml || embedHtml.length < 100) {
			return fail("embed page empty or blocked");
		}

		// ── Step 2: Parse IMDB ID from config ──
		var config = parseMPlayerConfig(embedHtml);
		if (!config || !config.imdbId) {
			// Fallback: try to extract imdbId directly from HTML
			var imdbMatch = embedHtml.match(/["']imdbId["']\s*:\s*["'](tt\d+)["']/i);
			if (!imdbMatch) {
				return fail("could not extract IMDB ID from embed page");
			}
			config = { imdbId: imdbMatch[1], vidsrcProxyUrl: "" };
		}

		var imdbId = config.imdbId;

		// ── Step 3: Build the HLS proxy master URL ──
		var masterUrl;
		if (type === "tv") {
			masterUrl =
				BASE_URL + "/hls-proxy/master/" + imdbId + "/" + season + "/" + episode;
		} else {
			masterUrl = BASE_URL + "/hls-proxy/master/" + imdbId;
		}

		// ── Step 4: Fetch the master playlist ──
		var playlistContent = await httpGet(masterUrl, {
			"User-Agent": UA,
			Referer: embedUrl,
			Accept: "*/*",
		});

		if (!playlistContent || playlistContent.length < 20) {
			return fail("master playlist empty");
		}

		// ── Step 5: Parse ALL quality variants ──
		var streamHeaders = {
			"User-Agent": UA,
			Referer: BASE_URL + "/",
		};

		var qualityStreams = parseM3U8All(
			playlistContent,
			masterUrl,
			streamHeaders,
		);

		if (qualityStreams && qualityStreams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: qualityStreams,
				latency_ms: Date.now() - start,
			};
		}

		// Fallback: return the master playlist URL as-is
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: masterUrl,
					quality: "Auto",
					headers: streamHeaders,
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
