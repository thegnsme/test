/**
 * superembed.stream — Free Movie Streaming API via multiembed.mov
 *
 * SuperEmbed provides embed URLs that resolve to HLS/MP4 streams.
 * This source fetches the embed player page and extracts stream URLs.
 * When M3U8 URLs are found, they are fetched and parsed for ALL
 * quality variants (1080p, 720p, 480p, etc.).
 *
 * URL patterns:
 *   Movie (TMDB): https://multiembed.mov/?video_id={tmdbId}&tmdb=1
 *   TV (TMDB):    https://multiembed.mov/?video_id={tmdbId}&tmdb=1&s={season}&e={episode}
 *   VIP:          https://multiembed.mov/directstream.php?video_id={tmdbId}&tmdb=1
 *
 * Extraction strategies (in order):
 *   1. Check for direct M3U8 playlist in response
 *   2. Look for video source tags (if M3U8, fetch and parse all variants)
 *   3. Find M3U8 URLs in script content (fetch and parse all variants)
 *   4. Extract iframe src
 *   5. Return the player URL itself as an embed stream
 */

var { httpGet, fetchM3U8AndParse } = require("./_shared");

var SOURCE_NAME = "superembed.stream";
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
		// ── Step 1: Build player URL ──
		var playerUrl = EMBED_BASE + "/?video_id=" + tmdbId + "&tmdb=1";
		if (type === "tv") {
			playerUrl += "&s=" + season + "&e=" + episode;
		}

		// ── Step 2: Try VIP player first ──
		var vipUrl =
			EMBED_BASE + "/directstream.php?video_id=" + tmdbId + "&tmdb=1";
		if (type === "tv") {
			vipUrl += "&s=" + season + "&e=" + episode;
		}

		try {
			var vipResponse = await httpGet(vipUrl, {
				"User-Agent": UA,
				Referer: EMBED_BASE + "/",
				Accept: "*/*",
			});

			if (vipResponse && vipResponse.length > 5) {
				var vipStreams = await extractFromHtml(vipResponse, vipUrl);
				if (vipStreams && vipStreams.length > 0) {
					return {
						source: SOURCE_NAME + "[VIP]",
						status: "working",
						streams: vipStreams,
						latency_ms: Date.now() - start,
					};
				}
			}
		} catch (e) {
			// VIP unavailable
		}

		// ── Step 3: Fetch standard embed page ──
		var playerHtml = await httpGet(playerUrl, {
			"User-Agent": UA,
			Referer: EMBED_BASE + "/",
			Accept: "text/html,application/xhtml+xml",
		});

		if (!playerHtml || playerHtml.length < 50) {
			return fail("player page empty or blocked");
		}

		// ── Step 4: Try to extract streams from HTML ──
		var streams = await extractFromHtml(playerHtml, playerUrl);
		if (streams && streams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: streams,
				latency_ms: Date.now() - start,
			};
		}

		// ── Step 5: Return the player URL as an embed stream ──
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: playerUrl,
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
 * Extract stream URLs from HTML content.
 * Now ASYNC — fetches M3U8 URLs to parse ALL quality variants.
 */
async function extractFromHtml(html, referer) {
	if (!html) return null;

	// 1. Direct M3U8 playlist in response
	if (html.indexOf("#EXTM3U") !== -1) {
		var m3u8Result = await fetchM3U8AndParse(
			html,
			{
				"User-Agent": UA,
				Referer: referer,
			},
			null,
		);
		// fetchM3U8AndParse expects a URL, but we have the content
		// Handle inline M3U8 content specially
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

	// 3. M3U8 URL in scripts — fetch and parse all quality variants
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

	// 4. MP4 URL in scripts
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

	// 5. Iframe src
	var iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
	if (iframeMatch && iframeMatch[1] && iframeMatch[1] !== "about:blank") {
		return [
			{
				url: resolveUrl(iframeMatch[1], referer),
				quality: "Auto",
				headers: { "User-Agent": UA, Referer: referer },
			},
		];
	}

	return null;
}

/**
 * Parse inline M3U8 content (when HTML itself is an M3U8).
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
