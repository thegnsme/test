/**
 * ezvidapi.com — Multi-provider HLS via REST API
 *
 * Rewritten to use the undocumented REST API at api.ezvidapi.com.
 * Fetches direct HLS streams with multiple quality variants + subtitles.
 *
 * API endpoints:
 *   Movie:  GET /movie/{provider}/{tmdbId}
 *   TV:     GET /tv/{provider}/{tmdbId}?season={s}&episode={e}
 *   List:   GET /list — returns available providers
 *
 * Working providers: vidrock (2 quality + 15 subs), vidlink (3 quality)
 *
 * The API returns a stream_url (proxied M3U8 master playlist).
 * Fetching it gives a proper HLS manifest with #EXT-X-STREAM-INF variants.
 */

var { httpGet, httpPost, safeJsonParse, makeFail } = require("./_shared");

var SOURCE_NAME = "ezvidapi";
var API_BASE = "https://api.ezvidapi.com";
var EMBED_BASE = "https://ezvidapi.com";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

/**
 * Parse M3U8 content and extract ALL quality variant streams.
 * Returns [{url, quality, headers}] or empty array.
 */
function m3u8ToQualities(content, baseUrl) {
	if (!content || content.indexOf("#EXTM3U") === -1) return [];

	var lines = content.split("\n");
	var results = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var height = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl = resolveUrl(urlPart, baseUrl);
					var quality = qualityLabel(height);
					results.push({
						url: fullUrl,
						quality: quality,
						height: height,
					});
				}
			}
		}
	}

	results.sort(function (a, b) {
		return b.height - a.height;
	});
	return results;
}

function qualityLabel(h) {
	if (h >= 2160) return "2160p";
	if (h >= 1440) return "1440p";
	if (h >= 1080) return "1080p";
	if (h >= 720) return "720p";
	if (h >= 480) return "480p";
	if (h >= 360) return "360p";
	return h ? h + "p" : "Auto";
}

function resolveUrl(url, baseUrl) {
	if (!url) return "";
	if (url.indexOf("http") === 0 || url.indexOf("https") === 0) return url;
	if (url.indexOf("//") === 0) return "https:" + url;
	if (!baseUrl) return url;
	// Absolute path — resolve against origin
	if (url.indexOf("/") === 0) {
		var m = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (m ? m[1] : "https://api.ezvidapi.com") + url;
	}
	// Relative path — resolve against directory
	return baseUrl.replace(/\/[^/]*$/, "/") + url;
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		var allStreams = [];
		var triedProviders = [];

		// ── Helper: try a single provider ──
		async function tryOneProvider(provider) {
			try {
				var apiUrl =
					type === "tv"
						? API_BASE +
							"/tv/" +
							provider +
							"/" +
							tmdbId +
							"?season=" +
							season +
							"&episode=" +
							episode
						: API_BASE + "/movie/" + provider + "/" + tmdbId;

				var apiResp = await httpGet(apiUrl, {
					"User-Agent": UA,
					Accept: "application/json",
					Referer: EMBED_BASE + "/",
				});

				if (!apiResp || apiResp.length < 10) return [];

				var data = safeJsonParse(apiResp);
				if (!data) return [];
				if (data.client_side === true) return [];

				var streamUrl = data.stream_url;
				if (!streamUrl) return [];

				// Fetch M3U8 master playlist
				var m3u8Content = await httpGet(streamUrl, {
					"User-Agent": UA,
					Accept: "*/*",
					Referer: EMBED_BASE + "/",
				});

				if (!m3u8Content || m3u8Content.length < 20) return [];

				// Parse all quality variants
				var providerStreams = [];
				var variants = m3u8ToQualities(m3u8Content, streamUrl);

				if (variants.length > 0) {
					// Build subtitle list from API response
					var subList = [];
					var subs = data.subtitles;
					if (Array.isArray(subs) && subs.length > 0) {
						for (var si = 0; si < subs.length; si++) {
							var s = subs[si];
							if (s && s.url) {
								subList.push({
									url: s.url,
									label: s.label || "VTT",
									lang: s.language || "en",
								});
							}
						}
					}

					for (var vi = 0; vi < variants.length; vi++) {
						var stream = {
							url: variants[vi].url,
							quality: variants[vi].quality,
							headers: {
								"User-Agent": UA,
								Referer: EMBED_BASE + "/",
							},
						};
						if (subList.length > 0) {
							stream.subtitles = subList;
						}
						providerStreams.push(stream);
					}
				} else {
					// No quality variants — use URL directly
					providerStreams.push({
						url: streamUrl,
						quality: "Auto",
						headers: { "User-Agent": UA, Referer: EMBED_BASE + "/" },
					});
				}

				return providerStreams;
			} catch (e) {
				return [];
			}
		}

		// Fetch both providers in parallel via Promise.allSettled
		var providerResults = await Promise.allSettled([
			tryOneProvider("vidrock"),
			tryOneProvider("vidlink"),
		]);

		for (var pi = 0; pi < providerResults.length; pi++) {
			var pr = providerResults[pi];
			if (pr.status !== "fulfilled") continue;
			var providerStreams = pr.value;
			if (!providerStreams || providerStreams.length === 0) continue;
			for (var psi = 0; psi < providerStreams.length; psi++) {
				// Avoid duplicate URLs across providers
				var isDup = false;
				for (var ai = 0; ai < allStreams.length; ai++) {
					if (allStreams[ai].url === providerStreams[psi].url) {
						isDup = true;
						break;
					}
				}
				if (!isDup) {
					allStreams.push(providerStreams[psi]);
				}
			}
		}

		if (allStreams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: allStreams,
				latency_ms: Date.now() - start,
			};
		}

		// ── Fallback: return embed URL ──
		var fallbackUrl =
			type === "tv"
				? EMBED_BASE + "/embed/tv/" + tmdbId + "/" + season + "/" + episode
				: EMBED_BASE + "/embed/movie/" + tmdbId;

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: fallbackUrl,
					quality: "Auto",
					headers: { "User-Agent": UA, Referer: EMBED_BASE + "/" },
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
