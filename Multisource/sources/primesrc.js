// file: sources/primesrc.js
//
// PrimeSrc — primesrc.me
//
// Supplies server keys via /api/v1/s?tmdb=... which point to embed hosts
// (Streamtape, Voe, Dood, etc.). On this QuickJS implementation embed
// pages require browser JavaScript — most never expose raw M3U8 URLs.
//
// We try a limited number of servers with a short per-request timeout.
// If /api/v1/l is accessible it may return a direct link; otherwise the
// source fails fast (~6 s total) instead of blocking the aggregator.

var SOURCE_NAME = "primesrc";
var BASE_URL = "https://primesrc.me";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

var MAX_SERVERS = 5; // try at most this many servers
var PER_PAGE_TIMEOUT = 4000; // ms per embed-fetch attempt
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(str) {
	var bytes = [];
	for (var i = 0; i < str.length; i++) {
		var c = str.charCodeAt(i);
		if (c < 128) {
			bytes.push(c);
		} else if (c < 2048) {
			bytes.push(192 | (c >> 6));
			bytes.push(128 | (c & 63));
		} else {
			bytes.push(224 | (c >> 12));
			bytes.push(128 | ((c >> 6) & 63));
			bytes.push(128 | (c & 63));
		}
	}
	var result = "";
	for (var i = 0; i < bytes.length; i += 3) {
		var a = bytes[i],
			b = i + 1 < bytes.length ? bytes[i + 1] : 0,
			c = i + 2 < bytes.length ? bytes[i + 2] : 0;
		result += B64.charAt(a >> 2);
		result += B64.charAt(((a & 3) << 4) | (b >> 4));
		if (i + 1 < bytes.length) result += B64.charAt(((b & 15) << 2) | (c >> 6));
		else result += "=";
		if (i + 2 < bytes.length) result += B64.charAt(c & 63);
		else result += "=";
	}
	return result;
}

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

// Per-request timeout wrapper
function httpGetWithTimeout(url, headers, ms) {
	var timeoutMs = ms || PER_PAGE_TIMEOUT;
	return new Promise(function (resolve) {
		var settled = false;
		var timer = setTimeout(function () {
			if (!settled) {
				settled = true;
				resolve("");
			}
		}, timeoutMs);
		globalThis
			.http_get(url, headers || {})
			.then(function (raw) {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					if (typeof raw === "string") resolve(raw);
					else if (raw && raw.body) {
						if (typeof raw.body === "string") resolve(raw.body);
						else if (typeof raw.body === "object")
							resolve(JSON.stringify(raw.body));
						else resolve("");
					} else resolve("");
				}
			})
			.catch(function () {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve("");
				}
			});
	});
}

function extractM3U8FromHtml(html) {
	if (!html || html.length < 50) return null;
	// Cloudflare challenge or JS-heavy page — skip
	if (html.indexOf("Just a moment") !== -1) return null;
	if (html.indexOf("challenges.cloudflare.com") !== -1) return null;
	if (html.indexOf("window.sk = true") !== -1) return null; // popunder ads
	if (
		html.indexOf("_0x") !== -1 &&
		html.indexOf("function") !== -1 &&
		html.length > 5000
	)
		return null; // obfuscated JS

	var m = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
	if (m) return m[0];
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

		var raw = await httpGetWithTimeout(
			apiUrl,
			{
				"User-Agent": UA,
				Referer: BASE_URL,
				Accept: "application/json, text/plain, */*",
			},
			10000,
		);

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
		var serversTried = 0;

		for (
			var si = 0;
			si < data.servers.length && serversTried < MAX_SERVERS;
			si++
		) {
			var server = data.servers[si];
			var name = server.name || "";
			var key = server.key || "";
			if (!name || !key) continue;

			serversTried++;

			// Construct embed URL using known host patterns
			var embedUrl = constructEmbedUrl(name, key);
			if (!embedUrl) {
				// Try API link resolution
				try {
					var linkRaw = await httpGetWithTimeout(
						BASE_URL + "/api/v1/l?key=" + encodeURIComponent(key),
						{ "User-Agent": UA, Referer: BASE_URL },
						4000,
					);
					var linkData = safeJsonParse(linkRaw);
					if (linkData && linkData.link) embedUrl = linkData.link;
				} catch (e) {}
				if (!embedUrl) continue;
			}

			if (seenUrls[embedUrl]) continue;
			seenUrls[embedUrl] = true;

			// Fetch the embed page with timeout
			var embedHtml = await httpGetWithTimeout(
				embedUrl,
				{
					"User-Agent": UA,
					Referer: embedUrl,
					Accept: "text/html,application/xhtml+xml",
				},
				PER_PAGE_TIMEOUT,
			);

			if (!embedHtml || embedHtml.length < 50) continue;

			var m3u8Url = extractM3U8FromHtml(embedHtml);
			if (m3u8Url && !seenUrls[m3u8Url]) {
				seenUrls[m3u8Url] = true;
				streams.push({
					url: m3u8Url,
					quality: extractQuality(m3u8Url) || "Auto",
					headers: { "User-Agent": UA, Referer: embedUrl },
				});
				break; // got a stream, stop trying
			}
		}

		if (streams.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				error: "no playable streams from " + serversTried + " servers",
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

function constructEmbedUrl(serverName, key) {
	var lookup = (serverName || "").toLowerCase().trim();
	var hosts = {
		streamtape: "streamtape.com/e/" + encodeURIComponent(key) + "/",
		voe: "voe.sx/e/" + encodeURIComponent(key),
		dood: "dood.la/e/" + encodeURIComponent(key),
		doodstream: "doodstream.com/e/" + encodeURIComponent(key),
		filemoon: "filemoon.sx/e/" + encodeURIComponent(key),
		streamwish: "streamwish.to/e/" + encodeURIComponent(key),
		mixdrop: "mixdrop.co/e/" + encodeURIComponent(key),
		filelions: "filelions.to/e/" + encodeURIComponent(key),
		luluvdoo: "luluvdoo.com/e/" + encodeURIComponent(key),
		vidmoly: "vidmoly.to/embed/" + encodeURIComponent(key),
	};

	if (hosts[lookup]) return "https://" + hosts[lookup];
	for (var known in hosts) {
		if (lookup.indexOf(known) !== -1) return "https://" + hosts[known];
	}
	return null;
}

function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
