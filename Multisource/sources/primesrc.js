// file: sources/primesrc.js
//
// PrimeSrc Source — primesrc.me
//
// API: GET /api/v1/s?tmdb={id}&type=movie|tv → returns JSON server list
// Each server has { name, key } — we construct the final embed URL directly
// using known host patterns, then try to extract M3U8 from embed pages.
//
// Supported embed hosts: Streamtape, Voe, Dood, Filemoon, Streamwish,
// Mixdrop, Filelions, Luluvdoo, Vidmoly

var SOURCE_NAME = "primesrc";
var BASE_URL = "https://primesrc.me";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Known embed host URL patterns — construct URL directly from server key
var EMBED_HOSTS = {
	streamtape: { domain: "streamtape.com", path: "/e/%s/" },
	voe: { domain: "voe.sx", path: "/e/%s" },
	dood: { domain: "dood.la", path: "/e/%s" },
	doodstream: { domain: "doodstream.com", path: "/e/%s" },
	filemoon: { domain: "filemoon.sx", path: "/e/%s" },
	streamwish: { domain: "streamwish.to", path: "/e/%s" },
	mixdrop: { domain: "mixdrop.co", path: "/e/%s" },
	filelions: { domain: "filelions.to", path: "/e/%s" },
	luluvdoo: { domain: "luluvdoo.com", path: "/e/%s" },
	vidmoly: { domain: "vidmoly.to", path: "/embed/%s" },
};

function getEmbedUrl(serverName, key) {
	var lookup = (serverName || "").toLowerCase().trim();
	// Try direct match first
	var host = EMBED_HOSTS[lookup];
	if (host)
		return (
			"https://" +
			host.domain +
			host.path.replace("%s", encodeURIComponent(key))
		);

	// Check if the name contains any known host keyword
	for (var known in EMBED_HOSTS) {
		if (lookup.indexOf(known) !== -1) {
			host = EMBED_HOSTS[known];
			return (
				"https://" +
				host.domain +
				host.path.replace("%s", encodeURIComponent(key))
			);
		}
	}

	return null;
}

async function httpGet(url, headers) {
	try {
		// Do NOT pass 3rd argument — globalThis.http_get takes (url, headers) only
		var raw = await globalThis.http_get(url, headers || {});
		if (typeof raw === "string") return raw;
		if (raw && raw.body) {
			if (typeof raw.body === "string") return raw.body;
			if (typeof raw.body === "object") return JSON.stringify(raw.body);
		}
	} catch (e) {}
	return "";
}

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
}

// Try to extract M3U8 from HTML of an embed page
function extractM3U8FromHtml(html) {
	if (!html) return null;
	// Direct M3U8 URL
	var m = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
	if (m) return m[0];
	// source/file/src in JavaScript
	var m2 = html.match(
		/(?:source|file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
	);
	if (m2) return m2[1].indexOf("http") === 0 ? m2[1] : "https:" + m2[1];
	return null;
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = parseInt(params.tmdbId, 10);
	if (!tmdbId || tmdbId < 1) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: "invalid tmdbId",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}

	try {
		// Fetch server list from API
		var apiUrl = BASE_URL + "/api/v1/s?tmdb=" + tmdbId;
		if (params.type === "tv" || params.type === "series") {
			apiUrl +=
				"&type=tv&season=" +
				(params.season || 1) +
				"&episode=" +
				(params.episode || 1);
		} else {
			apiUrl += "&type=movie";
		}

		var raw = await httpGet(apiUrl, {
			"User-Agent": UA,
			Referer: BASE_URL,
			Accept: "application/json, text/plain, */*",
		});
		if (!raw) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "empty API response",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var data = safeJsonParse(raw);
		if (!data || !data.servers || !Array.isArray(data.servers)) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "invalid API response",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var streams = [];
		var seenUrls = {};

		for (var si = 0; si < data.servers.length; si++) {
			var server = data.servers[si];
			var name = server.name || "";
			var key = server.key || "";
			if (!name || !key) continue;

			// Construct embed URL directly from known host patterns
			var embedUrl = getEmbedUrl(name, key);
			if (!embedUrl) {
				// Unknown host — try API link resolution as fallback
				try {
					var linkUrl = BASE_URL + "/api/v1/l?key=" + encodeURIComponent(key);
					var linkRaw = await httpGet(linkUrl, {
						"User-Agent": UA,
						Referer: BASE_URL,
					});
					var linkData = safeJsonParse(linkRaw);
					if (linkData && linkData.link) embedUrl = linkData.link;
				} catch (e) {}
				if (!embedUrl) continue;
			}

			// Deduplicate by embed URL
			if (seenUrls[embedUrl]) continue;
			seenUrls[embedUrl] = true;

			// Try to extract M3U8 from the embed page
			try {
				var embedHtml = await httpGet(embedUrl, {
					"User-Agent": UA,
					Referer: embedUrl,
					Accept: "text/html,application/xhtml+xml",
				});

				if (embedHtml) {
					var m3u8Url = extractM3U8FromHtml(embedHtml);
					if (m3u8Url && !seenUrls[m3u8Url]) {
						seenUrls[m3u8Url] = true;
						var q = extractQuality(m3u8Url) || "Auto";
						streams.push({
							url: m3u8Url,
							quality: q,
							headers: {
								"User-Agent": UA,
								Referer: embedUrl,
							},
						});
					}
				}
				// If extraction failed, try fetching the API link resolution
				else if (!embedHtml || embedHtml.length < 50) {
					// Try the API link endpoint
					var linkUrl = BASE_URL + "/api/v1/l?key=" + encodeURIComponent(key);
					var linkRaw = await httpGet(linkUrl, {
						"User-Agent": UA,
						Referer: BASE_URL,
					});
					var linkData = safeJsonParse(linkRaw);
					if (linkData && linkData.link && !seenUrls[linkData.link]) {
						seenUrls[linkData.link] = true;
						// Check if it's already M3U8
						if (linkData.link.indexOf(".m3u8") > 0) {
							var q2 = extractQuality(linkData.link) || "Auto";
							streams.push({
								url: linkData.link,
								quality: q2,
								headers: { "User-Agent": UA, Referer: BASE_URL },
							});
						}
					}
				}
			} catch (e) {
				// Skip failed servers
			}
		}

		if (streams.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "no playable streams",
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
		return {
			source: SOURCE_NAME,
			status: "error",
			error: e && e.message ? e.message : String(e),
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
