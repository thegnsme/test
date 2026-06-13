"use strict";

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

function makeFail(src, msg, start) {
	return {
		source: src,
		status: "error",
		error: msg || "unknown",
		streams: [],
		latency_ms: Date.now() - (start || Date.now()),
	};
}

function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	return "";
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

function resolveRelativeUrl(baseUrl, relativePath) {
	if (!baseUrl) return relativePath;
	if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
	if (relativePath.indexOf("/") === 0) {
		var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (originMatch ? originMatch[1] : "") + relativePath;
	}
	return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}

function strToUtf8Bytes(s) {
	var out = [];
	for (var i = 0; i < s.length; i++) {
		var c = s.charCodeAt(i);
		if (c < 128) {
			out.push(c);
		} else if (c < 2048) {
			out.push(192 | (c >> 6));
			out.push(128 | (c & 63));
		} else {
			out.push(224 | (c >> 12));
			out.push(128 | ((c >> 6) & 63));
			out.push(128 | (c & 63));
		}
	}
	return out;
}

function utf8BytesToStr(bytes) {
	var out = "";
	for (var i = 0; i < bytes.length; i++) {
		out += String.fromCharCode(bytes[i]);
	}
	return out;
}

var B64CHARS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64encode(bytes) {
	var out = "";
	for (var i = 0; i < bytes.length; i += 3) {
		var b0 = bytes[i],
			b1 = bytes[i + 1] || 0,
			b2 = bytes[i + 2] || 0;
		out += B64CHARS[b0 >> 2];
		out += B64CHARS[((b0 << 4) | (b1 >> 4)) & 63];
		out += i + 1 < bytes.length ? B64CHARS[((b1 << 2) | (b2 >> 6)) & 63] : "=";
		out += i + 2 < bytes.length ? B64CHARS[b2 & 63] : "=";
	}
	return out;
}

function b64decode(s) {
	var map = {};
	for (var i = 0; i < 64; i++) map[B64CHARS[i]] = i;
	s = s.replace(/[^A-Za-z0-9+/=]/g, "");
	var out = [];
	for (var i = 0; i < s.length; i += 4) {
		var c0 = map[s[i]] || 0,
			c1 = map[s[i + 1]] || 0,
			c2 = map[s[i + 2]],
			c3 = map[s[i + 3]];
		out.push((c0 << 2) | (c1 >> 4));
		if (s[i + 2] && s[i + 2] !== "=" && c2 !== undefined)
			out.push(((c1 << 4) | (c2 >> 2)) & 255);
		if (s[i + 3] && s[i + 3] !== "=" && c3 !== undefined)
			out.push(((c2 << 6) | c3) & 255);
	}
	return out;
}

var RC4_KEY1 = "8Qy3mlM2kod80XIK";
var RC4_KEY2 = "BgKVSrzpH2Enosgm";
var RC4_KEY_DECRYPT = "9jXDYBZUcTcTZveM";

function rc4Transform(keyBytes, dataBytes) {
	var s = new Array(256);
	for (var i = 0; i < 256; i++) s[i] = i;
	var j = 0;
	for (var i = 0; i < 256; i++) {
		j = (j + s[i] + keyBytes[i % keyBytes.length]) % 256;
		var tmp = s[i];
		s[i] = s[j];
		s[j] = tmp;
	}
	var k = 0;
	var result = new Array(dataBytes.length);
	for (var n = 0; n < dataBytes.length; n++) {
		j = (j + 1) % 256;
		k = (k + s[j]) % 256;
		var tmp = s[j];
		s[j] = s[k];
		s[k] = tmp;
		result[n] = dataBytes[n] ^ s[(s[j] + s[k]) % 256];
	}
	return result;
}

function rc4Slug(data, keyStr) {
	var keyBytes = strToUtf8Bytes(keyStr);
	var dataBytes = strToUtf8Bytes(String(data));
	var enc = rc4Transform(keyBytes, dataBytes);
	return b64encode(enc)
		.replace(/[+=]/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function vrfDecrypt(vrfB64url) {
	try {
		var raw = vrfB64url.replace(/-/g, "+").replace(/_/g, "/");
		var data = b64decode(raw);
		var keyBytes = strToUtf8Bytes(RC4_KEY_DECRYPT);
		var dec = rc4Transform(keyBytes, data);
		var str = utf8BytesToStr(dec);
		try {
			str = decodeURIComponent(str);
		} catch (e) {}
		return safeJsonParse(str);
	} catch (e) {
		return null;
	}
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

function copyHeaders(obj) {
	if (!obj || typeof obj !== "object") return {};
	var out = {};
	for (var k in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, k))
			if (obj[k] != null) out[k] = obj[k];
	}
	return out;
}

var SOURCE_NAME = "vidsrc";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Current hardcoded domains — more reliable than domain discovery
var DOMAINS = [
	"vidsrcme.ru",
	"vidsrcme.su",
	"vidsrc-me.ru",
	"vidsrc-me.su",
	"vidsrc-embed.ru",
	"vidsrc-embed.su",
	"vsrc.su",
];

/**
 * Try mediainfo API on a given domain (the fastest path to M3U8).
 */
async function tryMediainfoApi(domain, tmdbId) {
	try {
		var vidId = String(tmdbId);
		var slug = rc4Slug(vidId, RC4_KEY1);
		var h = rc4Slug(vidId, RC4_KEY2);
		var mediainfoUrl =
			"https://" +
			domain +
			"/mediainfo/" +
			slug +
			"?tmdb=1&autostart=true&ads=0&h=" +
			h;
		var resp = await httpGet(mediainfoUrl, {
			"User-Agent": UA,
			Accept: "application/json,text/plain,*/*",
			Referer: "https://" + domain + "/",
		});
		if (!resp || resp.indexOf("{") !== 0) return null;
		var parsed = safeJsonParse(resp);
		if (!parsed || !parsed.result) return null;
		var decrypted = vrfDecrypt(parsed.result);
		if (
			decrypted &&
			decrypted.sources &&
			decrypted.sources.length > 0 &&
			decrypted.sources[0].file
		) {
			return decrypted.sources[0].file;
		}
	} catch (e) {}
	return null;
}

/**
 * Fetch an M3U8 master playlist and expand into quality variants.
 */
async function expandM3U8Variants(m3u8Url, referer) {
	try {
		var content = await httpGet(m3u8Url, {
			"User-Agent": UA,
			Accept: "*/*",
			Referer: referer || "https://vidsrcme.ru/",
		});
		if (!content || content.indexOf("#EXTM3U") === -1) {
			return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
		}
		if (content.indexOf("#EXT-X-STREAM-INF:") === -1) {
			return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
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
								: resolveRelativeUrl(m3u8Url, urlPart);
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
					if (subUrl.indexOf("http") !== 0)
						subUrl = resolveRelativeUrl(m3u8Url, subUrl);
					subs.push({
						url: subUrl,
						label: (subNameMatch && subNameMatch[1]) || "Subtitle",
						lang: (subLangMatch && subLangMatch[1]) || "en",
					});
				}
			}
		}
		if (variants.length === 0) {
			return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
		}
		variants.sort(function (a, b) {
			return b.height - a.height;
		});
		var result = [];
		for (var vi = 0; vi < variants.length; vi++) {
			var obj = {
				url: variants[vi].url,
				quality: variants[vi].quality,
				headers: {
					"User-Agent": UA,
					Referer: referer || "https://vidsrcme.ru/",
				},
			};
			if (subs.length > 0) obj.subtitles = subs;
			result.push(obj);
		}
		return result;
	} catch (e) {
		return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
	}
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) {
		return makeFail(SOURCE_NAME, "no tmdbId provided", start);
	}

	try {
		var allDomains = DOMAINS.slice();
		var tried = {};
		var errors = [];
		var foundM3u8 = null;
		var foundDomain = null;

		// Try ALL domains in parallel through mediainfo API (fast path)
		var miPromises = [];
		for (var di = 0; di < allDomains.length; di++) {
			(function (d) {
				miPromises.push(
					tryMediainfoApi(d, tmdbId).then(function (m3u8) {
						if (m3u8 && !foundM3u8) {
							foundM3u8 = m3u8;
							foundDomain = d;
						}
						return { domain: d, m3u8: m3u8 };
					}),
				);
			})(allDomains[di]);
		}

		// Wait for all mediainfo attempts to complete or first success
		await Promise.all(miPromises);

		if (foundM3u8 && foundDomain) {
			var referer = "https://" + foundDomain + "/";
			var qualityStreams = await expandM3U8Variants(foundM3u8, referer);
			var streams = [];
			for (var qi = 0; qi < qualityStreams.length; qi++) {
				streams.push(qualityStreams[qi]);
			}
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: streams,
				latency_ms: Date.now() - start,
			};
		}

		// ─── Fallback: try embed page extraction ───
		// Try each domain's embed page but ONLY for M3U8 URLs, never return the embed URL
		for (var di2 = 0; di2 < allDomains.length; di2++) {
			var domain = allDomains[di2];
			if (tried[domain]) continue;
			tried[domain] = true;

			try {
				var embedUrl =
					type === "tv" && season && episode
						? "https://" +
							domain +
							"/embed/tv/" +
							tmdbId +
							"/" +
							season +
							"-" +
							episode
						: "https://" + domain + "/embed/movie/" + tmdbId;

				var html = await httpGet(embedUrl, {
					"User-Agent": UA,
					Accept: "text/html,application/xhtml+xml",
					Referer: "https://" + domain + "/",
				});

				if (!html || html.length < 50) {
					errors.push(domain + ": empty");
					continue;
				}

				// Look for direct M3U8 in HTML
				var m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
				var m3u8Match;
				var m3u8Urls = [];
				while ((m3u8Match = m3u8Regex.exec(html)) !== null) {
					var u = m3u8Match[0].trim();
					if (u.length > 20 && m3u8Urls.indexOf(u) === -1) {
						m3u8Urls.push(u);
					}
				}

				if (m3u8Urls.length > 0) {
					var streams = [];
					var seenU = {};
					for (var mi = 0; mi < m3u8Urls.length; mi++) {
						if (seenU[m3u8Urls[mi]]) continue;
						seenU[m3u8Urls[mi]] = true;
						var expanded = await expandM3U8Variants(m3u8Urls[mi], embedUrl);
						for (var ei = 0; ei < expanded.length; ei++) {
							streams.push(expanded[ei]);
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

				errors.push(domain + ": no M3U8 in embed page");
			} catch (e) {
				errors.push(domain + ": " + (e.message || "error"));
			}
		}

		return {
			source: SOURCE_NAME,
			status: "no_streams",
			error: errors.join("; "),
			streams: [],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return makeFail(SOURCE_NAME, e.message, start);
	}
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
