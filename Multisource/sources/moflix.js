// file: sources/moflix.js
//
// Moflix-Stream source — REST API returning direct M3U8 HLS streams.
// Based on streamflix-reborn MoflixExtractor.kt.
//
// Movie API: GET /api/v1/titles/{base64("tmdb|movie|" + tmdbId)}?loader=titlePage
//             → returns JSON with .title.videos[].src = M3U8 master playlist URL
// TV API:    1. GET /api/v1/titles/{base64("tmdb|series|" + tmdbId)}?loader=titlePage
//            2. GET /api/v1/titles/{mediaId}/seasons/{s}/episodes/{e}?loader=episodePage
// Playback:  GET /api/v1/{playback_resolve_url} → returns JSON { src }
//
// NOTE: The API requires a valid Referer header (moflix-stream.xyz).
// Embed mirrors (vidara, veev, gupload) require JS rendering and are
// skipped — we only return the direct HLS master stream.

var SOURCE_NAME = "moflix";
var MAIN_URL = "https://moflix-stream.xyz";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

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

async function httpGet(url, headers) {
	try {
		// NOTE: Do NOT pass a 3rd argument — globalThis.http_get takes (url, headers) only
		var raw = await globalThis.http_get(url, headers || {});
		if (typeof raw === "string") return raw;
		if (raw && raw.body) {
			if (typeof raw.body === "string") return raw.body;
			if (typeof raw.body === "object") return JSON.stringify(raw.body);
		}
	} catch (e) {}
	return "";
}

async function fetchJSON(url) {
	var resp = await httpGet(url, {
		"User-Agent": UA,
		Referer: MAIN_URL + "/",
		Accept: "application/json, text/plain, */*",
	});
	if (!resp) return null;
	try {
		return JSON.parse(resp);
	} catch (e) {
		return null;
	}
}

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: "no tmdbId",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}

	try {
		var isMovie = type !== "tv" && type !== "series";
		var encodedId = isMovie
			? b64encode("tmdb|movie|" + tmdbId)
			: b64encode("tmdb|series|" + tmdbId);
		var url = MAIN_URL + "/api/v1/titles/" + encodedId + "?loader=titlePage";

		var data = await fetchJSON(url);
		if (!data) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "no JSON from titles endpoint",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var videos = [];
		var mediaId = null;

		if (data.videos) videos = data.videos;
		if (data.title) {
			if (data.title.id) mediaId = data.title.id;
			if (data.title.videos) videos = data.title.videos;
		}

		// TV: fetch the episode endpoint using mediaId from the titles response
		if (!isMovie && mediaId && season && episode) {
			var epUrl =
				MAIN_URL +
				"/api/v1/titles/" +
				mediaId +
				"/seasons/" +
				season +
				"/episodes/" +
				episode +
				"?loader=episodePage";
			var epData = await fetchJSON(epUrl);
			if (epData) {
				if (epData.videos) videos = epData.videos;
				if (epData.episode && epData.episode.videos)
					videos = epData.episode.videos;
			}
		}

		if (!videos || videos.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "no videos in response",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		var streams = [];
		var seenUrls = {};

		for (var i = 0; i < videos.length; i++) {
			var v = videos[i];
			var src = v.src || "";
			var resolveUrl = v.playback_resolve_url || "";
			var quality = v.quality || "";
			var streamType = v.type || "";

			if (v.premium_locked === true) continue;
			if (!src && !resolveUrl) continue;

			var finalSrc = "";

			if (resolveUrl) {
				var resolvedData = await fetchJSON(MAIN_URL + "/api/v1/" + resolveUrl);
				if (resolvedData && resolvedData.src) finalSrc = resolvedData.src;
			} else if (src) {
				finalSrc = src;
			}

			if (!finalSrc || seenUrls[finalSrc]) continue;
			seenUrls[finalSrc] = true;

			// Only return the direct M3U8 stream — embed mirrors require JS rendering
			if (
				finalSrc.indexOf(".m3u8") !== -1 ||
				finalSrc.indexOf(".m3u?") !== -1
			) {
				var q = quality || "Auto";
				streams.push({
					url: finalSrc,
					quality: q,
					headers: { "User-Agent": UA, Referer: MAIN_URL + "/" },
				});
			} else if (finalSrc.indexOf(".mp4") !== -1) {
				streams.push({
					url: finalSrc,
					quality: quality || "Auto",
					headers: { "User-Agent": UA, Referer: MAIN_URL + "/" },
				});
			}
			// Skip embed URLs — they require browser JS execution
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
