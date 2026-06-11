/**
 * vidsrc.xyz — Multi-server HLS extraction
 *
 * Flow:
 *   1. Try multiple URL patterns to fetch embed page from vidsrc.xyz
 *   2. Parse server list with data-hash attributes
 *   3. For each server, follow the RCP → PRORCP/SRCRCP chain
 *   4. Extract M3U8 file URL and parse for quality variants
 *   5. Return quality-sorted streams
 *
 * URL patterns tried (in order):
 *   - vidsrc.xyz/embed/movie/{tmdbId}
 *   - vidsrc.xyz/embed/movie?tmdb={tmdbId}
 *   - vidsrc.net/embed/movie?tmdb={tmdbId}
 *
 * Known problematic servers (Superembed, 2Embed) are skipped.
 */

var { httpGet } = require("./_shared");

var SOURCE_NAME = "vidsrc.xyz";
var EMBED_PATTERNS = [
	{
		base: "https://vidsrc.to/embed",
		movie: "/movie/{id}",
		tv: "/tv/{id}/{s}-{e}",
	},
	{
		base: "https://vsembed.ru/embed",
		movie: "/movie/{id}",
		tv: "/tv/{id}/{s}-{e}",
	},
	{
		base: "https://vidsrc.fyi/embed",
		movie: "/movie/{id}",
		tv: "/tv/{id}/{s}-{e}",
	},
	{
		base: "https://vidsrc.xyz/embed",
		movie: "/movie/{id}",
		tv: "/tv/{id}/{s}-{e}",
	},
];
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Servers known to cause issues (embed-only, no direct HLS)
var SKIP_SERVERS = { superembed: true, "2embed": true };

/**
 * Extract a JSON-like value from HTML/script content using regex.
 * Matches patterns like:  key: 'value'  or  key: "value"
 */
function extractJsValue(html, key) {
	if (!html || !key) return "";
	var re = new RegExp(
		key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
			"\\s*[:=]\\s*['\"]([^'\"]+)['\"]",
		"i",
	);
	var m = html.match(re);
	return m ? m[1] : "";
}

/**
 * Parse a master M3U8 playlist and return ALL quality variants.
 * Returns array of { url, quality } sorted by quality descending.
 */
function extractAllFromM3U8(m3u8Content, baseUrl) {
	if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
		return [];
	}

	var lines = m3u8Content.split("\n");
	var results = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var height = resMatch ? parseInt(resMatch[1], 10) : 0;
			if (i + 1 < lines.length) {
				var urlPart = lines[i + 1].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl =
						urlPart.indexOf("http") === 0
							? urlPart
							: baseUrl.replace(/\/[^/]*$/, "/") + urlPart;
					results.push({
						url: fullUrl,
						quality: qualityLabel(height),
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

function qualityLabel(height) {
	if (height >= 2160) return "2160p";
	if (height >= 1440) return "1440p";
	if (height >= 1080) return "1080p";
	if (height >= 720) return "720p";
	if (height >= 480) return "480p";
	if (height >= 360) return "360p";
	return height ? height + "p" : "Auto";
}

/**
 * Resolve iframe src from an embed page to determine base domain.
 */
function resolveBaseDomain(embedHtml) {
	var iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
	if (iframeMatch && iframeMatch[1]) {
		var src = iframeMatch[1];
		if (src.indexOf("//") === 0) src = "https:" + src;
		var originMatch = src.match(/^(https?:\/\/[^/]+)/);
		if (originMatch) return originMatch[1];
	}
	return "https://cloudorchestranova.com";
}

/**
 * Process a PRORCP endpoint and return M3U8 streams.
 */
async function processProrcp(prorcpId, baseDom, referer) {
	try {
		var prorcpUrl = baseDom + "/prorcp/" + prorcpId;
		var scriptContent = await httpGet(prorcpUrl, {
			"User-Agent": UA,
			Referer: referer,
			Accept: "*/*",
		});

		if (!scriptContent || scriptContent.length < 10) return [];

		var fileUrl = extractJsValue(scriptContent, "file");
		if (!fileUrl) {
			var m = scriptContent.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
			if (m) fileUrl = m[1];
		}
		if (!fileUrl) return [];

		return await fetchAndParsePlaylist(fileUrl, prorcpUrl);
	} catch (e) {
		return [];
	}
}

/**
 * Process a SRCRCP endpoint and return M3U8 streams.
 */
async function processSrcrcp(srcrcpPath, baseDom, referer) {
	try {
		var srcrcpUrl = baseDom + srcrcpPath;
		var scriptContent = await httpGet(srcrcpUrl, {
			"User-Agent": UA,
			Referer: referer,
			Accept: "*/*",
		});

		if (!scriptContent || scriptContent.length < 10) return [];

		// Direct M3U8 playlist
		if (scriptContent.indexOf("#EXTM3U") !== -1) {
			return parseAndReturn(scriptContent, srcrcpUrl);
		}

		var fileUrl = extractJsValue(scriptContent, "file");
		if (!fileUrl) {
			var m = scriptContent.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
			if (m) fileUrl = m[1];
		}
		if (!fileUrl) return [];

		if (fileUrl.indexOf("http") !== 0) {
			if (fileUrl.indexOf("//") === 0) {
				fileUrl = "https:" + fileUrl;
			} else {
				fileUrl = srcrcpUrl.replace(/\/[^/]*$/, "/") + fileUrl;
			}
		}

		return await fetchAndParsePlaylist(fileUrl, srcrcpUrl);
	} catch (e) {
		return [];
	}
}

/**
 * Fetch an M3U8 URL and parse it for quality streams.
 */
async function fetchAndParsePlaylist(playlistUrl, referer) {
	try {
		var playlistContent = await httpGet(playlistUrl, {
			"User-Agent": UA,
			Referer: referer,
			Accept: "*/*",
		});
		if (!playlistContent || playlistContent.length < 20) return [];
		return parseAndReturn(playlistContent, playlistUrl);
	} catch (e) {
		return [];
	}
}

/**
 * Parse M3U8 content and return ALL quality stream objects.
 */
function parseAndReturn(content, baseUrl) {
	var variants = extractAllFromM3U8(content, baseUrl);
	if (variants.length > 0) {
		var streams = [];
		for (var vi = 0; vi < variants.length; vi++) {
			streams.push({
				url: variants[vi].url,
				quality: variants[vi].quality,
				headers: { "User-Agent": UA, Referer: baseUrl },
			});
		}
		return streams;
	}

	if (content && content.indexOf("#EXTM3U") !== -1) {
		return [
			{
				url: baseUrl,
				quality: "Auto",
				headers: { "User-Agent": UA, Referer: baseUrl },
			},
		];
	}

	return [];
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// ── Step 1: Try URL patterns in order ──
		var embedHtml = null;
		var embedUrl = null;

		for (var pi = 0; pi < EMBED_PATTERNS.length; pi++) {
			var pattern = EMBED_PATTERNS[pi];
			var url;
			if (type === "tv") {
				url =
					pattern.base +
					pattern.tv
						.replace("{id}", tmdbId)
						.replace("{s}", season)
						.replace("{e}", episode);
			} else {
				url = pattern.base + pattern.movie.replace("{id}", tmdbId);
			}

			try {
				var response = await httpGet(url, {
					"User-Agent": UA,
					Referer: pattern.base + "/",
					Accept: "text/html,application/xhtml+xml",
				});

				if (response && response.length >= 200) {
					embedHtml = response;
					embedUrl = url;
					break;
				}
			} catch (e) {
				continue;
			}
		}

		if (!embedHtml || embedHtml.length < 200) {
			// All patterns failed — return first URL as embed stream
			var fallbackUrl =
				EMBED_PATTERNS[0].base +
				(type === "tv"
					? EMBED_PATTERNS[0].tv
							.replace("{id}", tmdbId)
							.replace("{s}", season)
							.replace("{e}", episode)
					: EMBED_PATTERNS[0].movie.replace("{id}", tmdbId));
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: [
					{
						url: fallbackUrl,
						quality: "Auto",
						headers: {
							"User-Agent": UA,
							Referer: EMBED_PATTERNS[0].base + "/",
						},
					},
				],
				latency_ms: Date.now() - start,
			};
		}

		// ── Step 2: Determine base domain from iframe ──
		var baseDom = resolveBaseDomain(embedHtml);

		// ── Step 3: Parse server list ──
		var serverRegex =
			/<li[^>]*class="[^"]*\bserver\b[^"]*"[^>]*data-hash="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
		var servers = [];
		var match;
		while ((match = serverRegex.exec(embedHtml))) {
			var hash = match[1];
			var name = match[2].replace(/<[^>]+>/g, "").trim();
			if (hash) {
				servers.push({ name: name, hash: hash });
			}
		}

		if (servers.length === 0) {
			// No server list — new domains (vidsrc.to → vsembed.ru) use Turnstile.
			// Return the embed URL as a fallback; the player's browser resolves it.
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: [
					{
						url: embedUrl,
						quality: "Auto",
						headers: {
							"User-Agent": UA,
							Referer: EMBED_PATTERNS[0].base + "/",
						},
					},
				],
				latency_ms: Date.now() - start,
			};
		}

		// ── Step 4: Process each server in sequence ──
		var allStreams = [];
		for (var s = 0; s < servers.length; s++) {
			var server = servers[s];

			// Skip known problematic servers
			var serverKey = server.name.toLowerCase().replace(/[^a-z0-9]/g, "");
			if (SKIP_SERVERS[serverKey]) continue;

			try {
				var rcpUrl = baseDom + "/rcp/" + server.hash;
				var rcpHtml = await httpGet(rcpUrl, {
					"User-Agent": UA,
					Referer: embedUrl,
					"Sec-Fetch-Dest": "iframe",
				});

				if (!rcpHtml || rcpHtml.length < 10) continue;

				var srcMatch = rcpHtml.match(/src\s*:\s*['"](\/[^'"]+)['"]/);
				if (!srcMatch || !srcMatch[1]) continue;

				var srcPath = srcMatch[1];
				var serverStreams = [];

				if (srcPath.indexOf("/prorcp/") === 0) {
					var prorcpId = srcPath.replace("/prorcp/", "");
					serverStreams = await processProrcp(prorcpId, baseDom, rcpUrl);
				} else if (srcPath.indexOf("/srcrcp/") === 0) {
					serverStreams = await processSrcrcp(srcPath, baseDom, rcpUrl);
				}

				for (var i = 0; i < serverStreams.length; i++) {
					serverStreams[i].source = SOURCE_NAME + "[" + server.name + "]";
				}

				allStreams = allStreams.concat(serverStreams);
				if (allStreams.length > 0) break;
			} catch (e) {
				continue;
			}
		}

		if (allStreams.length === 0) {
			// Fallback: return the embed URL as an embed stream
			// The player's browser may render it and resolve streams
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: [
					{
						url: embedUrl,
						quality: "Auto",
						headers: {
							"User-Agent": UA,
							Referer: EMBED_PATTERNS[0].base + "/",
						},
					},
				],
				latency_ms: Date.now() - start,
			};
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: allStreams,
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

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
