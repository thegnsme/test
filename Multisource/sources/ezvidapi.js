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
async function httpPost(url, headers, body) {
	var raw = await globalThis.http_post(url, headers || {}, body || "");
	if (typeof raw === "string") return raw;
	if (raw && raw.body) {
		if (typeof raw.body === "string") return raw.body;
		if (typeof raw.body === "object") return JSON.stringify(raw.body);
	}
	return "";
}

var SOURCE_NAME = "ezvidapi";

var API_BASE = "https://api.ezvidapi.com";

var EMBED_BASE = "https://ezvidapi.com";

var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

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
	if (url.indexOf("/") === 0) {
		var m = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (m ? m[1] : "https://api.ezvidapi.com") + url;
	}
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
				var m3u8Content = await httpGet(streamUrl, {
					"User-Agent": UA,
					Accept: "*/*",
					Referer: EMBED_BASE + "/",
				});
				if (!m3u8Content || m3u8Content.length < 20) return [];
				var providerStreams = [];
				var variants = m3u8ToQualities(m3u8Content, streamUrl);
				if (variants.length > 0) {
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
					providerStreams.push({
						url: streamUrl,
						quality: extractQuality(streamUrl) || "Auto",
						headers: {
							"User-Agent": UA,
							Referer: EMBED_BASE + "/",
						},
					});
				}
				return providerStreams;
			} catch (e) {
				return [];
			}
		}
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
		return {
			source: SOURCE_NAME,
			status: "no_streams",
			error: "no working provider streams",
			streams: [],
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
