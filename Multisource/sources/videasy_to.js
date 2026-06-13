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
async function httpPost(url, headers, body) {
	var raw = await globalThis.http_post(url, headers || {}, body || "");
	if (typeof raw === "string") return raw;
	if (raw && raw.body) {
		if (typeof raw.body === "string") return raw.body;
		if (typeof raw.body === "object") return JSON.stringify(raw.body);
	}
	return "";
}
var TMDB_KEYS = [
	"68e094699525b18a70bab2f86b1fa706",
	"af3a53eb387d57fc935e9128468b1899",
	"0142a22c560ce3efb1cfd6f3b2faab77",
];
var _tmdbIdx = 0;
function tmdbKey() {
	return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
}
var _metaCache = {};
async function fetchTmdbMeta(tmdbId, type) {
	var key = String(tmdbId) + ":" + (type || "movie");
	if (_metaCache[key] !== undefined) return _metaCache[key];
	try {
		var endpoint = type === "tv" ? "/tv/" : "/movie/";
		var url =
			"https://api.themoviedb.org/3" +
			endpoint +
			String(tmdbId) +
			"?api_key=" +
			tmdbKey() +
			"&append_to_response=external_ids";
		var resp = await httpGet(url, {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
			Accept: "application/json",
		});
		var data = safeJsonParse(resp);
		if (!data) {
			_metaCache[key] = null;
			return null;
		}
		var title = data.title || data.name || "";
		var date = data.release_date || data.first_air_date || "";
		var year = date ? date.split("-")[0] : "";
		var imdbId =
			data.external_ids && data.external_ids.imdb_id
				? data.external_ids.imdb_id
				: data.imdb_id || "";
		var result = { title: title, year: year, imdb_id: imdbId };
		_metaCache[key] = result;
		return result;
	} catch (e) {
		return null;
	}
}

var SOURCE_NAME = "videasy.to";

var VIDEO_API = "https://api.videasy.to/cdn/sources-with-title";

var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";

var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function normalizeQuality(q) {
	if (!q) return "";
	var qs = String(q).toLowerCase().trim();
	if (qs === "4k" || qs === "2160" || qs === "2160p") return "2160p";
	if (qs === "2k" || qs === "1440" || qs === "1440p" || qs === "qhd")
		return "1440p";
	if (qs === "hd" || qs === "1080" || qs === "1080p") return "1080p";
	if (qs === "hq" || qs === "720" || qs === "720p") return "720p";
	if (qs === "sd" || qs === "480" || qs === "480p") return "480p";
	if (qs === "360" || qs === "360p") return "360p";
	if (qs === "240" || qs === "240p") return "240p";
	return q;
}

function qualityRank(q) {
	var qs = String(q || "").toLowerCase();
	if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
	if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
	if (qs.indexOf("1080") !== -1) return 5;
	if (qs.indexOf("720") !== -1) return 4;
	if (qs.indexOf("480") !== -1) return 3;
	if (qs.indexOf("360") !== -1) return 2;
	if (qs.indexOf("240") !== -1) return 1;
	return 0;
}

function isValidStreamUrl(url) {
	if (!url || typeof url !== "string") return false;
	if (url.indexOf("https://") !== 0) return false;
	var hostMatch = url.match(/^https:\/\/([^/]+)/);
	if (!hostMatch) return false;
	var host = hostMatch[1].toLowerCase();
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.indexOf("169.254.") === 0 ||
		host.indexOf("10.") === 0 ||
		host.indexOf("172.16.") === 0 ||
		host.indexOf("192.168.") === 0
	) {
		return false;
	}
	return true;
}

async function scrapeStreams(params) {
	var start = Date.now();
	function fail(msg) {
		return makeFail(SOURCE_NAME, msg, start);
	}
	try {
		var meta = await fetchTmdbMeta(params.tmdbId, params.type);
		var title = meta && meta.title ? encodeURIComponent(meta.title) : "";
		var year = meta && meta.year ? encodeURIComponent(meta.year) : "";
		var imdbId = meta && meta.imdb_id ? encodeURIComponent(meta.imdb_id) : "";
		var apiUrl = VIDEO_API + "?title=" + title + "&mediaType=" + params.type;
		if (year) apiUrl += "&year=" + year;
		if (imdbId) apiUrl += "&imdbId=" + imdbId;
		apiUrl += "&tmdbId=" + String(params.tmdbId);
		if (params.type === "tv") {
			apiUrl +=
				"&season=" + (params.season || 1) + "&episode=" + (params.episode || 1);
		}
		var encryptedText = "";
		var apiErrors = [];
		for (var retry = 0; retry < 2; retry++) {
			try {
				var raw = await httpGet(apiUrl, {
					"User-Agent": UA,
					Referer: "https://videasy.to/",
					Origin: "https://videasy.to",
				});
				encryptedText = String(raw).trim();
				if (encryptedText && encryptedText.length >= 10) break;
			} catch (e) {
				apiErrors.push(
					"attempt " + (retry + 1) + ": " + (e.message || "error"),
				);
			}
			if (retry === 0) {
				await new Promise(function (r) {
					setTimeout(r, 1500);
				});
			}
		}
		if (!encryptedText || encryptedText.length < 10) {
			return fail("API returned no data (" + apiErrors.join("; ") + ")");
		}
		var decryptRaw = await httpPost(
			DECRYPT_API,
			{
				"Content-Type": "application/json",
				"User-Agent": UA,
			},
			JSON.stringify({
				text: encryptedText,
				id: String(params.tmdbId),
			}),
		);
		var decryptData = safeJsonParse(decryptRaw);
		if (!decryptData || decryptData.status !== 200 || !decryptData.result) {
			return fail("decryption failed");
		}
		var result = decryptData.result;
		var rawSources = result.sources || [];
		if (!rawSources || rawSources.length === 0) {
			return fail("no sources in decrypted data");
		}
		var subs = [];
		var rawSubs = result.subtitles || [];
		var seenSubs = {};
		for (var j = 0; j < rawSubs.length; j++) {
			var sub = rawSubs[j];
			if (!sub || !sub.url) continue;
			if (seenSubs[sub.url]) continue;
			seenSubs[sub.url] = true;
			var subLabel = sub.language || sub.lang || sub.label || "Unknown";
			subs.push({
				url: sub.url,
				label: subLabel,
				lang: sub.language || sub.lang || "",
			});
		}
		if (subs.length > 30) {
			subs = subs.slice(0, 30);
		}
		var streams = [];
		for (var i = 0; i < rawSources.length; i++) {
			var s = rawSources[i];
			if (!s || !s.url) continue;
			if (!isValidStreamUrl(s.url)) continue;
			streams.push({
				url: s.url,
				quality: normalizeQuality(s.quality),
				headers: {
					"User-Agent": UA,
					Referer: "https://videasy.to/",
					Origin: "https://videasy.to",
				},
				subtitles: subs.length > 0 ? subs : undefined,
			});
		}
		streams.sort(function (a, b) {
			return qualityRank(b.quality) - qualityRank(a.quality);
		});
		return {
			source: SOURCE_NAME,
			status: streams.length > 0 ? "working" : "no_streams",
			streams: streams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail("source error");
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
