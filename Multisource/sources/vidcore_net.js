"use strict";

function makeFail(src, msg, start) {
	return {
		source: src,
		status: "error",
		error: msg || "unknown",
		streams: [],
		latency_ms: Date.now() - (start || Date.now()),
	};
}

async function httpGet(url, headers) {
	var raw = await globalThis.http_get(url, headers || {});
	if (typeof raw === "string") return raw;
	if (raw && raw.body) {
		if (typeof raw.body === "string") return raw.body;
		if (typeof raw.body === "object") return JSON.stringify(raw.body);
	}
	return "";
}

function resolveUrl(url, base) {
	if (!url) return "";
	if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) return url;
	if (url.indexOf("//") === 0) return "https:" + url;
	if (url.indexOf("/") === 0) {
		var m = (base || "https://vidcore.net").match(/^(https?:\/\/[^/]+)/);
		return (m ? m[1] : "https://vidcore.net") + url;
	}
	return (base || "https://vidcore.net").replace(/\/[^/]*$/, "/") + url;
}

function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
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

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

function resolveRelativeUrl(baseUrl, relativePath) {
	if (!baseUrl) return relativePath;
	if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
	if (relativePath.indexOf("/") === 0) {
		var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (originMatch ? originMatch[1] : "") + relativePath;
	}
	return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}

function copyHeaders(obj) {
	if (!obj || typeof obj !== "object") return {};
	var out = {};
	for (var k in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, k))
			if (obj[k] != null) out[k] = obj[k];
	}
	return out;
}

var SOURCE_NAME = "vidcore.net";
var VIDCORE_BASE = "https://vidcore.net";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
var REQUEST_TIMEOUT = 10000;

/**
 * Fetch an M3U8 playlist and expand into quality variants.
 */
async function expandM3U8(playlistUrl, referer) {
	try {
		var content = await httpGet(playlistUrl, {
			"User-Agent": UA,
			Accept: "*/*",
			Referer: referer || VIDCORE_BASE + "/",
		});
		if (!content || content.indexOf("#EXTM3U") === -1) {
			return null;
		}
		// Check if master playlist with variants
		if (content.indexOf("#EXT-X-STREAM-INF:") === -1) {
			return null; // simple single-quality playlist
		}
		var lines = content.split("\n");
		var variants = [];
		var subs = [];
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
								: resolveRelativeUrl(playlistUrl, urlPart);
						variants.push({
							url: fullUrl,
							quality: qualityLabel(height),
							height: height,
						});
					}
				}
			}
			if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
				var subUrlMatch = line.match(/URI="([^"]+)"/);
				var subLangMatch = line.match(/LANGUAGE="([^"]+)"/);
				var subNameMatch = line.match(/NAME="([^"]+)"/);
				if (subUrlMatch && subUrlMatch[1]) {
					var subUrl = subUrlMatch[1];
					if (subUrl.indexOf("http") !== 0) {
						subUrl = resolveRelativeUrl(playlistUrl, subUrl);
					}
					subs.push({
						url: subUrl,
						label: (subNameMatch && subNameMatch[1]) || "Subtitle",
						lang: (subLangMatch && subLangMatch[1]) || "en",
					});
				}
			}
		}
		if (variants.length === 0) return null;
		variants.sort(function (a, b) {
			return b.height - a.height;
		});
		var result = [];
		for (var vi = 0; vi < variants.length; vi++) {
			var obj = {
				url: variants[vi].url,
				quality: variants[vi].quality,
				headers: { "User-Agent": UA, Referer: referer || VIDCORE_BASE + "/" },
			};
			if (subs.length > 0) obj.subtitles = subs;
			result.push(obj);
		}
		return result;
	} catch (e) {
		return null;
	}
}

/**
 * Parse M3U8 from inline JSON sources in the page.
 */
function extractM3U8FromScripts(html, baseUrl) {
	if (!html) return [];
	var results = [];

	// Direct M3U8 in HTML (most common)
	var directRegex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
	var match;
	while ((match = directRegex.exec(html)) !== null) {
		var url = match[0].trim();
		if (url.length > 20 && url.indexOf(".m3u8") !== -1) {
			results.push(url);
		}
	}

	// Look in JSON-like data inside script tags
	var scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
	while ((match = scriptRegex.exec(html)) !== null) {
		var scriptContent = match[1];
		try {
			// Try to find URLs in stringified JSON
			var jsonUrlRegex = /https?:\/\/[^"'\s\\,}]+\.m3u8[^"'\s\\,}]*/gi;
			var jm;
			while ((jm = jsonUrlRegex.exec(scriptContent)) !== null) {
				var u = jm[0].trim();
				if (u.length > 20 && results.indexOf(u) === -1) {
					results.push(u);
				}
			}
		} catch (e) {}
	}

	// Deduplicate
	var seen = {};
	var deduped = [];
	for (var i = 0; i < results.length; i++) {
		if (!seen[results[i]]) {
			seen[results[i]] = true;
			deduped.push(results[i]);
		}
	}
	return deduped;
}

/**
 * Try common API patterns that vidcore.net might use.
 */
async function tryApiEndpoints(tmdbId, type, season, episode) {
	var apiPatterns = [
		VIDCORE_BASE + "/api/movie/" + tmdbId,
		VIDCORE_BASE +
			"/api/tv/" +
			tmdbId +
			"/" +
			(season || 1) +
			"/" +
			(episode || 1),
		VIDCORE_BASE +
			"/api/source/" +
			(type === "tv" ? "tv" : "movie") +
			"/" +
			tmdbId,
		VIDCORE_BASE + "/source/" + (type === "tv" ? "tv" : "movie") + "/" + tmdbId,
	];

	for (var i = 0; i < apiPatterns.length; i++) {
		try {
			var resp = await httpGet(apiPatterns[i], {
				"User-Agent": UA,
				Accept: "application/json,text/plain,*/*",
				Referer: VIDCORE_BASE + "/",
			});
			if (!resp || resp.length < 10) continue;

			// Try to parse as JSON
			var data = safeJsonParse(resp);
			if (data) {
				// Check common response formats
				var urls = [];
				if (data.url) urls.push(data.url);
				if (data.stream)
					urls.push(
						typeof data.stream === "string" ? data.stream : data.stream.url,
					);
				if (data.sources && Array.isArray(data.sources)) {
					for (var si = 0; si < data.sources.length; si++) {
						if (data.sources[si].url) urls.push(data.sources[si].url);
						if (data.sources[si].file) urls.push(data.sources[si].file);
					}
				}
				if (data.playlist) urls.push(data.playlist);
				if (data.result && data.result.sources) {
					for (var ri = 0; ri < data.result.sources.length; ri++) {
						if (data.result.sources[ri].url)
							urls.push(data.result.sources[ri].url);
						if (data.result.sources[ri].file)
							urls.push(data.result.sources[ri].file);
					}
				}

				for (var ui = 0; ui < urls.length; ui++) {
					if (
						urls[ui] &&
						typeof urls[ui] === "string" &&
						(urls[ui].indexOf(".m3u8") !== -1 ||
							urls[ui].indexOf(".mp4") !== -1) &&
						(urls[ui].indexOf("https://") === 0 ||
							urls[ui].indexOf("http://") === 0)
					) {
						return urls[ui];
					}
				}

				// Fallback: if data has any valid stream URL, use it
				if (urls.length > 0) {
					for (var fi = 0; fi < urls.length; fi++) {
						if (
							urls[fi] &&
							typeof urls[fi] === "string" &&
							(urls[fi].indexOf("https://") === 0 ||
								urls[fi].indexOf("http://") === 0)
						) {
							return urls[fi];
						}
					}
				}
			}

			// Try to find M3U8 in raw text response
			var m3u8Match = resp.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
			if (m3u8Match && m3u8Match[0]) {
				return m3u8Match[0];
			}
		} catch (e) {}
	}
	return null;
}

async function scrapeStreams(params) {
	var start = Date.now();
	if (!params || !params.tmdbId) {
		return makeFail(SOURCE_NAME, "no tmdbId provided", start);
	}

	var tmdbId = params.tmdbId;
	var type = params.type === "tv" || params.type === "series" ? "tv" : "movie";
	var season = parseInt(params.season, 10) || 1;
	var episode = parseInt(params.episode, 10) || 1;

	try {
		var streams = [];
		var errors = [];

		// ─── Approach 1: Try API endpoints (fastest if available) ───
		var apiUrl = await tryApiEndpoints(tmdbId, type, season, episode);
		if (apiUrl) {
			var expanded = await expandM3U8(apiUrl, VIDCORE_BASE + "/");
			if (expanded && expanded.length > 0) {
				streams = expanded;
			} else {
				streams.push({
					url: apiUrl,
					quality: extractQuality(apiUrl) || "Auto",
					headers: { "User-Agent": UA, Referer: VIDCORE_BASE + "/" },
				});
			}
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: streams,
				latency_ms: Date.now() - start,
			};
		}

		// ─── Approach 2: Fetch embed page and extract M3U8 ───
		var embedUrl =
			type === "tv"
				? VIDCORE_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode
				: VIDCORE_BASE + "/movie/" + tmdbId;

		var embedHtml = await httpGet(embedUrl, {
			"User-Agent": UA,
			Referer: VIDCORE_BASE + "/",
			Accept: "text/html,application/xhtml+xml",
		});

		if (embedHtml && embedHtml.length > 100) {
			var m3u8Urls = extractM3U8FromScripts(embedHtml, embedUrl);

			if (m3u8Urls.length > 0) {
				// Deduplicate and expand each M3U8
				var seenUrls = {};
				for (var mi = 0; mi < m3u8Urls.length; mi++) {
					var mu = m3u8Urls[mi];
					if (seenUrls[mu]) continue;
					seenUrls[mu] = true;

					var expanded = await expandM3U8(mu, embedUrl);
					if (expanded && expanded.length > 0) {
						for (var ei = 0; ei < expanded.length; ei++) {
							streams.push(expanded[ei]);
						}
					} else {
						streams.push({
							url: mu,
							quality: extractQuality(mu) || "Auto",
							headers: { "User-Agent": UA, Referer: embedUrl },
						});
					}
				}

				if (streams.length > 0) {
					return {
						source: SOURCE_NAME,
						status: "working",
						streams: streams,
						latency_ms: Date.now() - start,
					};
				}
			}

			errors.push(
				"no M3U8 found in embed page (" + embedHtml.length + " chars)",
			);
		} else {
			errors.push("embed page empty or unreachable");
		}

		// ─── Approach 3: Try alternate domains ───
		// vidcore.net has mirror domains
		var altDomains = ["https://vcore.pro", "https://vidcore.cc"];

		for (var di = 0; di < altDomains.length && streams.length === 0; di++) {
			var altBase = altDomains[di];
			var altUrl =
				type === "tv"
					? altBase + "/tv/" + tmdbId + "/" + season + "/" + episode
					: altBase + "/movie/" + tmdbId;

			try {
				var altHtml = await httpGet(altUrl, {
					"User-Agent": UA,
					Referer: altBase + "/",
					Accept: "text/html,application/xhtml+xml",
				});

				if (altHtml && altHtml.length > 100) {
					var altM3u8Urls = extractM3U8FromScripts(altHtml, altUrl);
					var altSeen = {};
					for (var ai = 0; ai < altM3u8Urls.length; ai++) {
						var au = altM3u8Urls[ai];
						if (altSeen[au]) continue;
						altSeen[au] = true;
						var expanded = await expandM3U8(au, altUrl);
						if (expanded && expanded.length > 0) {
							for (var ei = 0; ei < expanded.length; ei++) {
								streams.push(expanded[ei]);
							}
						} else {
							streams.push({
								url: au,
								quality: extractQuality(au) || "Auto",
								headers: { "User-Agent": UA, Referer: altUrl },
							});
						}
					}
				}
			} catch (e) {
				errors.push(altBase + ": " + (e.message || "error"));
			}
		}

		if (streams.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				error: errors.join("; "),
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
		return makeFail(SOURCE_NAME, e.message, start);
	}
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
