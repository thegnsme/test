/**
 * 2embed.cc — Multi-server embed extraction
 *
 * Flow:
 *   1. Fetch embed page from 2embed.cc
 *   2. Parse server URLs from the page (Xps, Vesy, Vsrc, Vnest)
 *   3. Return the primary stream URL (data-src iframe)
 *   4. Each server URL is an embed that requires JS — player handles it
 *
 * Server URLs found in page:
 *   Xps:   https://streamsrcs.2embed.cc/xps?imdb={imdbId}
 *   Vesy:  https://streamsrcs.2embed.cc/vesy?tmdb={tmdbId}
 *   Vsrc:  https://streamsrcs.2embed.cc/vsrc?imdb={imdbId}
 *   Vnest: https://streamsrcs.2embed.cc/vnest?tmdb={tmdbId} (default)
 */

var { httpGet, fetchTmdbMeta } = require("./_shared");

var SOURCE_NAME = "2embed.cc";
var EMBED_BASE = "https://www.2embed.cc";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Build embed URL ──
		var embedUrl;
		if (type === "tv") {
			embedUrl =
				EMBED_BASE + "/embedtv/" + tmdbId + "&s=" + season + "&e=" + episode;
		} else {
			embedUrl = EMBED_BASE + "/embed/" + tmdbId;
		}

		// ── Step 2: Fetch embed page ──
		var embedHtml = await httpGet(embedUrl, {
			"User-Agent": UA,
			Referer: EMBED_BASE + "/",
			Accept: "text/html,application/xhtml+xml",
		});

		if (!embedHtml || embedHtml.length < 100) {
			return fail("embed page empty");
		}

		// ── Step 3: Extract stream URLs from page ──
		var streams = [];

		// Extract the default iframe data-src
		var dataSrcMatch = embedHtml.match(/iframe[^>]*data-src=["']([^"']+)["']/i);
		if (dataSrcMatch && dataSrcMatch[1]) {
			var defaultUrl = resolveUrl(dataSrcMatch[1], EMBED_BASE);
			streams.push({
				url: defaultUrl,
				quality: "Auto",
				headers: {
					"User-Agent": UA,
					Referer: embedUrl,
				},
				source: SOURCE_NAME + "[default]",
			});
		}

		// Extract all server links
		var serverRegex =
			/<a[^>]*href="javascript:void\(0\);"[^>]*onclick="go\('([^']+)'\)"><i[^>]*><\/i>\s*&nbsp;([^<]+)<\/a>/gi;
		var match;
		while ((match = serverRegex.exec(embedHtml))) {
			var serverUrl = match[1];
			var serverName = match[2].trim();
			serverUrl = resolveUrl(serverUrl, EMBED_BASE);

			// Check URL isn't already in our list
			var isDuplicate = false;
			for (var si = 0; si < streams.length; si++) {
				if (streams[si].url === serverUrl) {
					isDuplicate = true;
					break;
				}
			}
			if (!isDuplicate) {
				streams.push({
					url: serverUrl,
					quality: "Auto",
					headers: {
						"User-Agent": UA,
						Referer: embedUrl,
					},
					source: SOURCE_NAME + "[" + serverName + "]",
				});
			}
		}

		if (streams.length === 0) {
			// Fallback: try extracting any iframe src
			var srcMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
			if (srcMatch && srcMatch[1] && srcMatch[1] !== "about:blank") {
				var fallbackUrl = resolveUrl(srcMatch[1], EMBED_BASE);
				streams.push({
					url: fallbackUrl,
					quality: "Auto",
					headers: {
						"User-Agent": UA,
						Referer: embedUrl,
					},
				});
			}
		}

		if (streams.length === 0) {
			return fail("no stream URLs found in embed page");
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

function resolveUrl(url, base) {
	if (!url) return "";
	if (url.indexOf("http") === 0 || url.indexOf("https") === 0) return url;
	if (url.indexOf("//") === 0) return "https:" + url;
	return base + (url.indexOf("/") === 0 ? "" : "/") + url;
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
