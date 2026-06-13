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

function qualityLabel(h) {
	if (h >= 2160) return "2160p";
	if (h >= 1440) return "1440p";
	if (h >= 1080) return "1080p";
	if (h >= 720) return "720p";
	if (h >= 480) return "480p";
	if (h >= 360) return "360p";
	return h ? h + "p" : "Auto";
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

function copyHeaders(obj) {
	if (!obj || typeof obj !== "object") return {};
	var out = {};
	for (var k in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, k))
			if (obj[k] != null) out[k] = obj[k];
	}
	return out;
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

var SOURCE_NAME = "vidking.net";
var VIDKING_BASE = "https://www.vidking.net";
var VIDEO_API_BASE = "https://api.videasy.to";
var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
var REQ_TIMEOUT = 10000;
var TOTAL_TIMEOUT = 45000;

// Servers to try — using only fastest endpoints
var SERVERS = [
	{ name: "Hydrogen", endpoint: "cdn/sources-with-title", isActive: true },
	{ name: "Oxygen", endpoint: "mb-flix/sources-with-title", isActive: true },
	{
		name: "Lithium",
		endpoint: "downloader2/sources-with-title",
		isActive: true,
	},
	{ name: "Helium", endpoint: "1movies/sources-with-title", isActive: true },
];

// ─── TMDB Meta (cached, fast, uses same pattern as other sources) ───

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
		var url =
			"https://api.themoviedb.org/3/" +
			(type === "tv" ? "tv" : "movie") +
			"/" +
			String(tmdbId) +
			"?api_key=" +
			tmdbKey() +
			"&append_to_response=external_ids";
		var resp = await httpGet(url, {
			"User-Agent": UA,
			Accept: "application/json",
		});
		var data = safeJsonParse(resp);
		if (!data) {
			_metaCache[key] = null;
			return null;
		}
		var result = {
			title: data.title || data.name || "",
			year:
				(data.release_date || data.first_air_date || "").split("-")[0] || "",
			imdb_id:
				(data.external_ids && data.external_ids.imdb_id) || data.imdb_id || "",
		};
		_metaCache[key] = result;
		return result;
	} catch (e) {
		return null;
	}
}

// ─── M3U8 Expansion ───

function extractCodecLabel(streamInfLine) {
	var m = streamInfLine.match(/CODECS="([^"]+)"/i);
	if (!m) return "";
	var c = String(m[1]).toLowerCase();
	if (c.indexOf("hev1") !== -1 || c.indexOf("hvc1") !== -1) return "HEVC";
	if (c.indexOf("dvh1") !== -1 || c.indexOf("dvhe") !== -1) return "DV";
	if (c.indexOf("av01") !== -1 || c.indexOf("dav1") !== -1) return "AV1";
	if (c.indexOf("avc1") !== -1) return "H.264";
	return "";
}

async function expandM3U8Variants(playlistUrl, streamHeaders) {
	try {
		var content = await httpGet(playlistUrl, {
			"User-Agent": UA,
			Referer: VIDKING_BASE + "/",
			Accept: "*/*",
		});
		if (!content || content.indexOf("#EXTM3U") === -1) return null;
		if (content.indexOf("#EXT-X-STREAM-INF:") === -1) return null;

		var lines = content.split("\n");
		var variants = [];
		var subtitleTracks = [];

		for (var li = 0; li < lines.length; li++) {
			var line = lines[li];
			if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
				var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
				var height = resMatch ? parseInt(resMatch[1], 10) : 0;
				var codecLabel = extractCodecLabel(line);
				if (li + 1 < lines.length) {
					var urlPart = lines[li + 1].trim();
					if (urlPart && urlPart.indexOf("#") !== 0) {
						var fullUrl =
							urlPart.indexOf("http") === 0
								? urlPart
								: resolveRelativeUrl(playlistUrl, urlPart);
						var qualityTag = qualityLabel(height);
						if (codecLabel) qualityTag += " [" + codecLabel + "]";
						variants.push({
							url: fullUrl,
							quality: qualityTag,
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
						subUrl = resolveRelativeUrl(playlistUrl, subUrl);
					subtitleTracks.push({
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
			var ve = variants[vi];
			var streamObj = {
				url: ve.url,
				quality: ve.quality,
				headers: copyHeaders(streamHeaders),
			};
			if (subtitleTracks.length > 0) streamObj.subtitles = subtitleTracks;
			result.push(streamObj);
		}
		// Add master as Auto
		var masterObj = {
			url: playlistUrl,
			quality: "Auto",
			headers: copyHeaders(streamHeaders),
		};
		if (subtitleTracks.length > 0) masterObj.subtitles = subtitleTracks;
		result.push(masterObj);
		return result;
	} catch (e) {
		return null;
	}
}

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

// ─── Single Server API Call ───

function buildApiUrl(serverEndpoint, params) {
	var url = VIDEO_API_BASE + "/" + serverEndpoint + "?";
	url += "title=" + encodeURIComponent(params.title || "");
	url += "&mediaType=" + encodeURIComponent(params.type);
	url += "&year=" + encodeURIComponent(params.year || "");
	url += "&tmdbId=" + encodeURIComponent(String(params.tmdbId));
	url += "&imdbId=" + encodeURIComponent(params.imdbId || "");
	url += "&seasonId=" + encodeURIComponent(String(params.season || 1));
	url += "&episodeId=" + encodeURIComponent(String(params.episode || 1));
	url += "&_t=" + Date.now();
	return url;
}

async function tryOneServer(server, params) {
	var apiUrl = buildApiUrl(server.endpoint, params);
	try {
		var resp = await httpGet(apiUrl, {
			"User-Agent": UA,
			"Cache-Control": "no-cache",
			Pragma: "no-cache",
			Origin: VIDKING_BASE,
			Referer: VIDKING_BASE + "/",
		});
		if (!resp || resp.length < 10) return null;
		return { name: server.name, text: resp };
	} catch (e) {
		return null;
	}
}

async function tryAllServersInParallel(params) {
	var promises = [];
	for (var si = 0; si < SERVERS.length; si++) {
		if (!SERVERS[si].isActive) continue;
		promises.push(tryOneServer(SERVERS[si], params));
	}
	if (promises.length === 0) return [];

	// Wait for ALL to settle, collect first 2 valid results
	var results = await Promise.all(
		promises.map(function (p) {
			return p
				.then(function (v) {
					return v;
				})
				.catch(function () {
					return null;
				});
		}),
	);

	var valid = [];
	for (var ri = 0; ri < results.length; ri++) {
		if (results[ri] && results[ri].text && results[ri].text.length >= 10) {
			valid.push(results[ri]);
			if (valid.length >= 2) break;
		}
	}
	return valid;
}

// ─── Decryption ───

async function decryptOne(encryptedText, tmdbId, serverName) {
	if (!encryptedText || encryptedText.length < 10) return null;
	try {
		var raw = await httpPost(
			DECRYPT_API,
			{ "Content-Type": "application/json", "User-Agent": UA },
			JSON.stringify({ text: encryptedText, id: String(tmdbId) }),
		);
		var data = safeJsonParse(raw);
		if (!data || data.status !== 200 || !data.result) return null;
		return { name: serverName, result: data.result };
	} catch (e) {
		return null;
	}
}

async function decryptAllInParallel(serverResponses, tmdbId) {
	if (!serverResponses || serverResponses.length === 0) return [];
	var promises = [];
	for (var i = 0; i < serverResponses.length; i++) {
		promises.push(
			decryptOne(serverResponses[i].text, tmdbId, serverResponses[i].name),
		);
	}
	var results = await Promise.all(
		promises.map(function (p) {
			return p
				.then(function (v) {
					return v;
				})
				.catch(function () {
					return null;
				});
		}),
	);
	var valid = [];
	for (var ri = 0; ri < results.length; ri++) {
		if (results[ri] && results[ri].result) {
			valid.push(results[ri]);
		}
	}
	return valid;
}

// ─── Build Streams From Decrypted Result ───

async function buildStreamsFromResult(result) {
	if (!result) return [];
	var rawSources = result.sources || [];
	var rawSubtitles = result.subtitles || [];
	var subs = [];
	var seenSubs = {};
	for (var j = 0; j < rawSubtitles.length; j++) {
		var sub = rawSubtitles[j];
		if (!sub || !sub.url || seenSubs[sub.url]) continue;
		seenSubs[sub.url] = true;
		subs.push({
			url: sub.url,
			label: sub.language || sub.lang || sub.label || "Unknown",
			lang: sub.language || sub.lang || "",
		});
	}
	if (subs.length > 30) subs = subs.slice(0, 30);

	// Expand M3U8 playlists in parallel
	var expandPromises = [];
	var playlistSources = [];
	var directSources = [];

	for (var i = 0; i < rawSources.length; i++) {
		var s = rawSources[i];
		if (!s || !s.url) continue;
		if (s.url.indexOf(".m3u8") !== -1 || s.url.indexOf("playlist") !== -1) {
			playlistSources.push(s);
		} else {
			directSources.push(s);
		}
	}

	for (var pi = 0; pi < playlistSources.length; pi++) {
		var ps = playlistSources[pi];
		var hdrs = {
			"User-Agent": UA,
			Referer: VIDKING_BASE + "/",
			Origin: VIDKING_BASE,
			Accept: "*/*",
		};
		expandPromises.push(expandM3U8Variants(ps.url, hdrs));
	}

	var expansionResults = [];
	if (expandPromises.length > 0) {
		expansionResults = await Promise.all(
			expandPromises.map(function (p) {
				return p
					.then(function (v) {
						return v;
					})
					.catch(function () {
						return null;
					});
			}),
		);
	}

	var allStreams = [];
	var seenUrls = {};

	// Add expanded M3U8 results
	for (var ri = 0; ri < expansionResults.length; ri++) {
		var expanded = expansionResults[ri];
		var origSrc = playlistSources[ri];
		if (!expanded || expanded.length === 0) {
			// Fallback: original playlist URL
			if (origSrc && origSrc.url && !seenUrls[origSrc.url]) {
				seenUrls[origSrc.url] = true;
				var fbQuality =
					normalizeQuality(origSrc.quality) ||
					extractQuality(origSrc.url) ||
					"Auto";
				allStreams.push({
					url: origSrc.url,
					quality: fbQuality,
					headers: {
						"User-Agent": UA,
						Referer: VIDKING_BASE + "/",
						Origin: VIDKING_BASE,
						Accept: "*/*",
					},
					subtitles: subs.length > 0 ? subs : undefined,
				});
			}
			continue;
		}
		for (var ei = 0; ei < expanded.length; ei++) {
			var exp = expanded[ei];
			if (seenUrls[exp.url]) continue;
			seenUrls[exp.url] = true;
			if (!exp.subtitles || exp.subtitles.length === 0) {
				if (subs.length > 0) exp.subtitles = subs;
			}
			allStreams.push(exp);
		}
	}

	// Add direct sources
	for (var di = 0; di < directSources.length; di++) {
		var ds = directSources[di];
		if (!ds || !ds.url || seenUrls[ds.url]) continue;
		seenUrls[ds.url] = true;
		var quality =
			normalizeQuality(ds.quality) || extractQuality(ds.url) || "Auto";
		var streamObj = {
			url: ds.url,
			quality: quality,
			headers: {
				"User-Agent": UA,
				Referer: VIDKING_BASE + "/",
				Origin: VIDKING_BASE,
				Accept: "*/*",
			},
		};
		if (subs.length > 0) streamObj.subtitles = subs;
		allStreams.push(streamObj);
	}

	return allStreams;
}

async function mergeServerResults(decryptedResults) {
	if (!decryptedResults || decryptedResults.length === 0) return [];

	// Merge streams from each server with dedup
	var allStreams = [];
	var seenUrls = {};

	for (var ri = 0; ri < decryptedResults.length; ri++) {
		var dr = decryptedResults[ri];
		if (!dr || !dr.result) continue;
		var streams = await buildStreamsFromResult(dr.result);
		for (var si = 0; si < streams.length; si++) {
			var stream = streams[si];
			if (seenUrls[stream.url]) continue;
			seenUrls[stream.url] = true;
			allStreams.push(stream);
		}
	}

	return allStreams;
}

// ─── Embed Page Extraction ───

async function extractM3U8FromEmbedPage(tmdbId, type, season, episode) {
	try {
		var embedUrl =
			type === "tv"
				? VIDKING_BASE +
					"/embed/tv/" +
					tmdbId +
					"/" +
					(season || 1) +
					"/" +
					(episode || 1)
				: VIDKING_BASE + "/embed/movie/" + tmdbId;

		var html = await httpGet(embedUrl, {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml",
			Referer: VIDKING_BASE + "/",
		});

		if (!html || html.length < 100) return null;

		// Search for M3U8 in HTML
		var m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
		var match;
		var m3u8Urls = [];
		while ((match = m3u8Regex.exec(html)) !== null) {
			var url = match[0].trim();
			if (url.length > 20 && m3u8Urls.indexOf(url) === -1) {
				m3u8Urls.push(url);
			}
		}

		if (m3u8Urls.length === 0) return null;

		var streams = [];
		var seen = {};
		for (var i = 0; i < m3u8Urls.length; i++) {
			var mu = m3u8Urls[i];
			if (seen[mu]) continue;
			seen[mu] = true;
			var expanded = await expandM3U8Variants(mu, {
				"User-Agent": UA,
				Referer: VIDKING_BASE + "/",
				Origin: VIDKING_BASE,
			});
			if (expanded && expanded.length > 0) {
				for (var ei = 0; ei < expanded.length; ei++) {
					streams.push(expanded[ei]);
				}
			} else {
				streams.push({
					url: mu,
					quality: extractQuality(mu) || "Auto",
					headers: {
						"User-Agent": UA,
						Referer: VIDKING_BASE + "/",
						Origin: VIDKING_BASE,
					},
				});
			}
		}

		return streams.length > 0 ? streams : null;
	} catch (e) {
		return null;
	}
}

// ─── Main Scrape ───

async function scrapeStreamsInner(tmdbId, type, season, episode, start) {
	// Approach A: Embed page extraction (starts immediately)
	var embedPromise = extractM3U8FromEmbedPage(tmdbId, type, season, episode);

	// Approach B: Full API pipeline (needs TMDB metadata)
	var apiPromise = (async function () {
		try {
			var meta = await fetchTmdbMeta(tmdbId, type);
			var apiParams = {
				title: (meta && meta.title) || "",
				type: type,
				year: (meta && meta.year) || "",
				tmdbId: tmdbId,
				imdbId: (meta && meta.imdb_id) || "",
				season: season || 1,
				episode: episode || 1,
			};

			var serverResponses = await tryAllServersInParallel(apiParams);
			if (serverResponses.length === 0) return null;

			var decryptedResults = await decryptAllInParallel(
				serverResponses,
				tmdbId,
			);
			if (decryptedResults.length === 0) return null;

			var streams = await mergeServerResults(decryptedResults);
			if (streams.length === 0) return null;

			return {
				source: SOURCE_NAME,
				status: "working",
				streams: streams,
				latency_ms: Date.now() - start,
			};
		} catch (e) {
			return null;
		}
	})();

	// Race both approaches
	var embedResult = await embedPromise;
	if (embedResult && embedResult.length > 0) {
		return {
			source: SOURCE_NAME,
			status: "working",
			streams: embedResult,
			latency_ms: Date.now() - start,
		};
	}

	// Embed failed, try API
	var apiResult = await apiPromise;
	if (apiResult && apiResult.streams && apiResult.streams.length > 0) {
		return apiResult;
	}

	return null;
}

async function scrapeStreams(params) {
	var start = Date.now();
	if (!params || !params.tmdbId) {
		return makeFail(SOURCE_NAME, "no tmdbId provided", start);
	}
	var tmdbId = params.tmdbId;
	var type = params.type || "movie";
	var season = params.season || 1;
	var episode = params.episode || 1;

	try {
		var result = await Promise.race([
			new Promise(function (_, reject) {
				setTimeout(function () {
					reject(new Error("total timeout"));
				}, TOTAL_TIMEOUT);
			}),
			scrapeStreamsInner(tmdbId, type, season, episode, start),
		]);

		if (result && result.streams && result.streams.length > 0) {
			result.latency_ms = Date.now() - start;
			return result;
		}

		return {
			source: SOURCE_NAME,
			status: "no_streams",
			error: "all approaches failed (" + (Date.now() - start) + "ms)",
			streams: [],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return {
			source: SOURCE_NAME,
			status: "no_streams",
			error: "timeout (" + (Date.now() - start) + "ms)",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
