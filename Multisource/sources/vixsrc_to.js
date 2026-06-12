/**
 * vixsrc.to — HLS via clean API + token-based playlist
 *
 * Flow:
 *   1. GET /api/movie|tv/{tmdbId}  →  { src: "/embed/...?token=...&expires=..." }
 *   2. GET embed page HTML          →  extract token, expires, playlist URL via regex
 *   3. Append token params to playlist URL
 *   4. Return master HLS playlist URL
 *
 * Quality is auto-detected from the master playlist's highest RESOLUTION.
 */

var { httpGet, makeFail } = require("./_shared");

var SOURCE_NAME = "vixsrc.to";
var BASE_URL = "https://vixsrc.to";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
var HEADERS = {
	"User-Agent": UA,
	Referer: BASE_URL + "/",
	Origin: BASE_URL,
	Accept: "application/json, text/javascript, */*; q=0.01",
};

/**
 * Extract resolution from a URL or quality string.
 */
function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	// Try to extract from a RESOLUTION pattern like 1920x1080
	var r = u.match(/RESOLUTION=\d+x(\d+)/i);
	if (r) {
		var h = parseInt(r[1], 10);
		if (h >= 2160) return "2160p";
		if (h >= 1440) return "1440p";
		if (h >= 1080) return "1080p";
		if (h >= 720) return "720p";
		if (h >= 480) return "480p";
		if (h >= 360) return "360p";
	}
	return "";
}

/**
 * Attempt to find the highest-resolution stream in an M3U8 master playlist.
 * Returns { url, quality } for the best variant, or null.
 */
function findBestVariant(m3u8Content, baseUrl) {
	var lines = String(m3u8Content || "").split("\n");
	var best = null;
	var bestHeight = 0;

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var height = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl =
						urlPart.indexOf("http") === 0 ? urlPart : baseUrl + "/" + urlPart;
					if (height > bestHeight) {
						bestHeight = height;
						best = {
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
													: height + "p",
						};
					}
				}
			}
		}
	}

	return best;
}

/**
 * Extract subtitle tracks from an M3U8 master playlist.
 */
function extractSubtitles(m3u8Content) {
	var subs = [];
	var lines = String(m3u8Content || "").split("\n");
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
			var urlMatch = line.match(/URI="([^"]+)"/);
			var langMatch = line.match(/LANGUAGE="([^"]+)"/);
			var nameMatch = line.match(/NAME="([^"]+)"/);
			if (urlMatch && urlMatch[1]) {
				subs.push({
					url: urlMatch[1],
					label: (nameMatch && nameMatch[1]) || "VTT",
					lang: (langMatch && langMatch[1]) || "en",
				});
			}
		}
	}
	return subs;
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type; // "movie" or "tv"
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Call vixsrc API ──
		var apiUrl;
		if (type === "tv") {
			apiUrl = BASE_URL + "/api/tv/" + tmdbId + "/" + season + "/" + episode;
		} else {
			apiUrl = BASE_URL + "/api/movie/" + tmdbId;
		}

		var apiResp = await httpGet(apiUrl, HEADERS);
		var apiData;
		try {
			apiData = JSON.parse(apiResp);
		} catch (e) {
			return fail("invalid API JSON: " + e.message);
		}

		if (!apiData || !apiData.src) {
			return fail("no src in API response");
		}

		// ── Step 2: Fetch embed page ──
		var embedUrl = BASE_URL + apiData.src;
		var embedHtml = await httpGet(embedUrl, {
			"User-Agent": UA,
			Referer: BASE_URL + "/",
			Accept: "text/html,application/xhtml+xml,*/*",
		});

		if (!embedHtml || embedHtml.length < 100) {
			return fail("embed page too short or empty");
		}

		// ── Step 3: Extract token, expires, playlist URL via regex ──
		var tokenMatch = embedHtml.match(/token["']\s*:\s*["']([^"']+)/);
		var expiresMatch = embedHtml.match(/expires["']\s*:\s*["']([^"']+)/);
		var playlistMatch = embedHtml.match(/url\s*:\s*["']([^"']+)/);

		var token = tokenMatch ? tokenMatch[1] : "";
		var expires = expiresMatch ? expiresMatch[1] : "";
		var playlist = playlistMatch ? playlistMatch[1] : "";

		if (!token || !expires || !playlist) {
			return fail("could not extract token/expires/playlist from embed");
		}

		// ── Step 4: Build master playlist URL ──
		var sep = playlist.indexOf("?") !== -1 ? "&" : "?";
		var masterUrl =
			playlist +
			sep +
			"token=" +
			encodeURIComponent(token) +
			"&expires=" +
			encodeURIComponent(expires) +
			"&h=1";

		// ── Step 5: Fetch the master playlist to extract ALL quality variants ──
		var playlistResp = await httpGet(masterUrl, {
			"User-Agent": UA,
			Referer: embedUrl,
			Accept: "*/*",
		});

		var streams = [];
		var subtitles = [];

		if (
			playlistResp &&
			playlistResp.length > 0 &&
			playlistResp.indexOf("#EXTM3U") !== -1
		) {
			// Parse ALL quality variants from the master playlist
			var lines = playlistResp.split("\n");
			for (var li = 0; li < lines.length; li++) {
				var line = lines[li];
				if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
					var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
					var height = resMatch ? parseInt(resMatch[1], 10) : 0;
					if (li + 1 < lines.length) {
						var urlPart = lines[li + 1].trim();
						if (urlPart && urlPart.indexOf("#") !== 0) {
							var fullUrl =
								urlPart.indexOf("http") === 0
									? urlPart
									: masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1) +
										urlPart;
							var qLabel =
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
							streams.push({
								url: fullUrl,
								quality: qLabel,
								headers: {
									"User-Agent": UA,
									Referer: embedUrl,
								},
							});
						}
					}
				}
				if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
					var urlMatch = line.match(/URI="([^"]+)"/);
					var langMatch = line.match(/LANGUAGE="([^"]+)"/);
					var nameMatch = line.match(/NAME="([^"]+)"/);
					if (urlMatch && urlMatch[1]) {
						subtitles.push({
							url: urlMatch[1],
							label: (nameMatch && nameMatch[1]) || "VTT",
							lang: (langMatch && langMatch[1]) || "en",
						});
					}
				}
			}
		}

		if (streams.length === 0) {
			// No variants found — return the master URL as single stream
			streams.push({
				url: masterUrl,
				quality: extractQuality(masterUrl) || "Auto",
				headers: {
					"User-Agent": UA,
					Referer: embedUrl,
				},
			});
		}

		// Attach subtitles to all streams
		var subArg = subtitles.length > 0 ? subtitles : undefined;
		for (var si = 0; si < streams.length; si++) {
			if (subArg) streams[si].subtitles = subArg;
		}

		// Sort by quality descending
		var QUAL_ORDER = {
			"2160p": 7,
			"1440p": 6,
			"1080p": 5,
			"720p": 4,
			"480p": 3,
			"360p": 2,
			"240p": 1,
		};
		streams.sort(function (a, b) {
			return (QUAL_ORDER[b.quality] || 0) - (QUAL_ORDER[a.quality] || 0);
		});

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

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
