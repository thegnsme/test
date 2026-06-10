/**
 * =============================================================================
 *  SOURCE: vidsrc.icu — Embed Player → M3U8/MP4
 *  =============================================================================
 *  CloudNestra-based embed player. Extracts direct video URLs from:
 *    - Direct M3U8/MP4 URLs in HTML
 *    - JavaScript player config objects (hls.js, videojs, plyr)
 *    - Iframe follow-chain
 *
 *  Multiple fallback strategies for maximum coverage.
 * =============================================================================
 */

var { httpGet } = require("./_shared");
var SOURCE_NAME = "vidsrc.icu";
var BASE = "https://vidsrc.icu";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	var embedUrl =
		type === "movie"
			? BASE + "/embed/movie/" + tmdbId
			: BASE + "/embed/tv/" + tmdbId + "/" + season + "/" + episode;

	try {
		// ── Fetch embed page HTML ─────────────────────────────────────────────
		var html;
		try {
			html = await httpGet(embedUrl, {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				Referer: BASE,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			});
		} catch (e) {
			return errorResult("fetch failed: " + e.message);
		}

		if (!html || html.length < 50) {
			return {
				source: SOURCE_NAME,
				embedUrl: embedUrl,
				status: "no_streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		// ── Extract video sources ─────────────────────────────────────────────
		var streams = [];
		var seen = {};

		function addStream(url, typeLabel, referer) {
			if (!url || seen[url]) return;
			seen[url] = true;
			streams.push({
				url: url,
				type: typeLabel,
				quality: "",
				resolution: "",
				headers: { Referer: referer || BASE },
			});
		}

		// Strategy A: Direct M3U8 URLs
		var m3u8Re = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
		var m3u8Match;
		while ((m3u8Match = m3u8Re.exec(html)) !== null)
			addStream(m3u8Match[0], "hls", BASE);

		// Strategy B: Direct MP4 URLs
		if (streams.length === 0) {
			var mp4Re = /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi;
			var mp4Match;
			while ((mp4Match = mp4Re.exec(html)) !== null)
				addStream(mp4Match[0], "mp4", BASE);
		}

		// Strategy C: Player config objects (hls.js / videojs / plyr)
		if (streams.length === 0) {
			var jsPatterns = [
				/["'](?:file|src)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
				/["'](?:file|src)["']\s*:\s*["'](\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
				/source\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
				/url\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
			];
			for (var pi = 0; pi < jsPatterns.length; pi++) {
				var pm;
				while ((pm = jsPatterns[pi].exec(html)) !== null) {
					var jsUrl = pm[1];
					if (jsUrl.indexOf("http") !== 0) jsUrl = BASE + jsUrl;
					var jsType = jsUrl.indexOf(".m3u8") !== -1 ? "hls" : "mp4";
					addStream(jsUrl, jsType, BASE);
				}
				if (streams.length > 0) break;
			}
		}

		// Strategy D: Follow iframes
		if (streams.length === 0) {
			var iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
			var iframeMatch;
			while ((iframeMatch = iframeRe.exec(html)) !== null) {
				var iframeSrc = iframeMatch[1];
				if (iframeSrc.indexOf("http") !== 0) {
					iframeSrc =
						iframeSrc.indexOf("/") === 0
							? BASE + iframeSrc
							: embedUrl + "/" + iframeSrc;
				}
				try {
					var iframeHtml = await httpGet(iframeSrc, {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
						Referer: embedUrl,
					});
					if (iframeHtml) {
						var ifM3u8 =
							iframeHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi) || [];
						for (var im = 0; im < ifM3u8.length; im++)
							addStream(ifM3u8[im], "hls", iframeSrc);
						if (streams.length === 0) {
							var ifMp4 =
								iframeHtml.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi) ||
								[];
							for (var ip = 0; ip < ifMp4.length; ip++)
								addStream(ifMp4[ip], "mp4", iframeSrc);
						}
					}
				} catch (e) {
					/* skip */
				}
				if (streams.length > 0) break;
			}
		}

		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: streams.length > 0 ? "working" : "no_streams",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return errorResult(e.message);
	}

	function errorResult(msg) {
		return {
			source: SOURCE_NAME,
			embedUrl: embedUrl,
			status: "error",
			error: msg || "unknown error",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
