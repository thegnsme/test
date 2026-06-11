/**
 * multiembed.mov — Direct HLS/MP4 Stream via VIP API
 *
 * This source targets the VIP player endpoint of multiembed.mov (backend
 * for superembed.stream). Provides direct stream URLs with multi-quality
 * HLS support. When M3U8 URLs are found, they are fetched and parsed for
 * ALL quality variants (1080p, 720p, 480p, etc.).
 *
 * Flow:
 *   1. Build VIP URL via /directstream.php
 *   2. Fetch the VIP response
 *   3. Try multiple extraction strategies (async M3U8 parsing):
 *      a. Direct M3U8 playlist (parse all quality variants)
 *      b. Video source tag (fetch M3U8, parse all variants)
 *      c. M3U8 URL in script content (fetch and parse)
 *      d. Iframe embed URL
 *   4. Return all quality streams found
 *
 * URL patterns:
 *   Movie (TMDB): https://multiembed.mov/directstream.php?video_id={tmdbId}&tmdb=1
 *   TV (TMDB):    https://multiembed.mov/directstream.php?video_id={tmdbId}&tmdb=1&s={season}&e={episode}
 *   Check:        same + &check=1 (returns "1" if VIP available)
 */

var { httpGet, fetchM3U8AndParse } = require("./_shared");

var SOURCE_NAME = "multiembed.mov";
var EMBED_BASE = "https://multiembed.mov";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		var baseParams = "video_id=" + tmdbId + "&tmdb=1";
		if (type === "tv") {
			baseParams += "&s=" + season + "&e=" + episode;
		}

		var vipUrl = EMBED_BASE + "/directstream.php?" + baseParams;
		var checkUrl = vipUrl + "&check=1";
		var playerUrl = EMBED_BASE + "/?" + baseParams;

		// ── Step 1: Check VIP availability ──
		try {
			var checkResult = await httpGet(checkUrl, {
				"User-Agent": UA,
				Referer: EMBED_BASE + "/",
				Accept: "*/*",
			});

			if (checkResult && checkResult.indexOf("1") !== -1) {
				// VIP available — fetch the VIP player URL directly
				var vipResponse = await httpGet(vipUrl, {
					"User-Agent": UA,
					Referer: EMBED_BASE + "/",
					Accept: "*/*",
				});

				if (vipResponse && vipResponse.length > 5) {
					var vipStreams = await extractStreams(vipResponse, vipUrl);
					if (vipStreams && vipStreams.length > 0) {
						return {
							source: SOURCE_NAME + "[VIP]",
							status: "working",
							streams: vipStreams,
							latency_ms: Date.now() - start,
						};
					}
				}
			}
		} catch (e) {
			// VIP check failed — fall through to standard player
		}

		// ── Step 2: Fall back to standard embed ──
		var playerHtml = await httpGet(playerUrl, {
			"User-Agent": UA,
			Referer: EMBED_BASE + "/",
			Accept: "text/html,application/xhtml+xml",
		});

		if (!playerHtml || playerHtml.length < 50) {
			return fail("player page empty or blocked");
		}

		var playerStreams = await extractStreams(playerHtml, playerUrl);
		if (playerStreams && playerStreams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: playerStreams,
				latency_ms: Date.now() - start,
			};
		}

		// Fallback: return the VIP/player URL as an embed stream
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: vipUrl,
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
 * Extract stream URLs from embed response content.
 * ASYNC — fetches M3U8 URLs to parse ALL quality variants.
 */
async function extractStreams(html, referer) {
	if (!html) return null;

	// 1. Direct M3U8 playlist in response
	if (html.indexOf("#EXTM3U") !== -1) {
		var inlineResult = parseInlineM3U8(html, referer);
		if (inlineResult && inlineResult.length > 0) return inlineResult;
	}

	// 2. Video source tag with .m3u8 or .mp4
	var videoMatch = html.match(
		/<source[^>]+src=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
	);
	if (videoMatch && videoMatch[1]) {
		var videoUrl = resolveUrl(videoMatch[1], referer);
		var quality = "Auto";
		var qualMatch = videoMatch[0].match(/label=["']([^"']+)["']/i);
		if (qualMatch) quality = qualMatch[1];

		// If M3U8 URL, fetch and parse all quality variants
		if (videoUrl.indexOf(".m3u8") !== -1) {
			try {
				var m3u8Streams = await fetchM3U8AndParse(
					videoUrl,
					{
						"User-Agent": UA,
						Referer: referer,
					},
					{
						"User-Agent": UA,
						Referer: referer,
					},
				);
				if (m3u8Streams && m3u8Streams.length > 0) {
					return m3u8Streams;
				}
			} catch (e) {}
		}

		return [
			{
				url: videoUrl,
				quality: quality,
				headers: { "User-Agent": UA, Referer: referer },
			},
		];
	}

	// 3. M3U8 URL in script content — fetch and parse all quality variants
	var m3u8Match = html.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
	if (m3u8Match) {
		var m3u8Url = m3u8Match[1];
		try {
			var m3u8Streams = await fetchM3U8AndParse(
				m3u8Url,
				{
					"User-Agent": UA,
					Referer: referer,
				},
				{
					"User-Agent": UA,
					Referer: referer,
				},
			);
			if (m3u8Streams && m3u8Streams.length > 0) {
				return m3u8Streams;
			}
		} catch (e) {}
		return [
			{
				url: m3u8Url,
				quality: "Auto",
				headers: { "User-Agent": UA, Referer: referer },
			},
		];
	}

	// 4. MP4 URL in script content
	var mp4Match = html.match(/['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i);
	if (mp4Match) {
		return [
			{
				url: mp4Match[1],
				quality: "Auto",
				headers: { "User-Agent": UA, Referer: referer },
			},
		];
	}

	// 5. Iframe embed — return the iframe URL
	var iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
	if (iframeMatch && iframeMatch[1]) {
		var iframeUrl = resolveUrl(iframeMatch[1], referer);
		return [
			{
				url: iframeUrl,
				quality: "Auto",
				headers: { "User-Agent": UA, Referer: referer },
			},
		];
	}

	return null;
}

/**
 * Parse inline M3U8 content for all quality variants.
 */
function parseInlineM3U8(content, baseUrl) {
	if (!content || content.indexOf("#EXTM3U") === -1) return null;
	var lines = content.split("\n");
	var streams = [];
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var h = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl = resolveUrl(urlPart, baseUrl);
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
						headers: { "User-Agent": UA, Referer: baseUrl },
					});
				}
			}
		}
	}
	return streams.length > 0 ? streams : null;
}

function resolveUrl(url, baseUrl) {
	if (!url) return "";
	if (url.indexOf("http") === 0) return url;
	if (url.indexOf("//") === 0) return "https:" + url;
	if (!baseUrl) return url;
	if (url.indexOf("/") === 0) {
		var m = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (m ? m[1] : "https://multiembed.mov") + url;
	}
	return baseUrl.replace(/\/[^/]*$/, "/") + url;
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
