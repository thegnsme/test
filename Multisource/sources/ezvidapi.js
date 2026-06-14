"use strict";

/**
 * ezvidapi source — SkyStream MultiSource plugin.
 *
 * Queries all available ezvidapi.com provider endpoints in parallel:
 *   Vidsrc, Vidrock, Vidzee, Icefy, Vidlink, Vidnest, Vixsrc, Popr
 *
 * API: {base}/movie/{provider}/{tmdbId}
 *      {base}/tv/{provider}/{tmdbId}?season={s}&episode={e}
 *
 * Each provider returns a stream_url (M3U8) plus optional subtitles.
 * M3U8 master playlists are fetched and parsed for quality variants.
 */

var SOURCE_NAME = "ezvidapi";
var TAG = "EzVidAPI";

var API_BASE = "https://api.ezvidapi.com";
var EMBED_BASE = "https://ezvidapi.com";

var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

var PROVIDERS = [
	"vidsrc",
	"vidrock",
	"vidzee",
	"icefy",
	"vidlink",
	"vidnest",
	"vixsrc",
	"popr",
];

var PER_PROVIDER_TIMEOUT = 30000;

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function qualityLabel(h) {
	if (h >= 2160) return "2160p";
	if (h >= 1440) return "1440p";
	if (h >= 1080) return "1080p";
	if (h >= 720) return "720p";
	if (h >= 480) return "480p";
	if (h >= 360) return "360p";
	return h ? h + "p" : "Auto";
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

function log() {
	try {
		console.log.apply(
			console,
			["[" + TAG + "]"].concat([].slice.call(arguments)),
		);
	} catch (e) {}
}

// ─── HTTP with Timeout ────────────────────────────────────────────────────

function httpGet(url, headers, ms) {
	ms = ms || 10000;
	return new Promise(function (resolve) {
		var done = false;
		var t = setTimeout(function () {
			if (!done) {
				done = true;
				resolve("");
			}
		}, ms);
		(async function () {
			try {
				var raw = await globalThis.http_get(url, headers || {});
				if (done) return;
				done = true;
				clearTimeout(t);
				var body = "";
				if (typeof raw === "string") body = raw;
				else if (raw && raw.body)
					body =
						typeof raw.body === "string"
							? raw.body
							: typeof raw.body === "object"
								? JSON.stringify(raw.body)
								: "";
				resolve(body);
			} catch (e) {
				if (done) return;
				done = true;
				clearTimeout(t);
				resolve("");
			}
		})();
	});
}

// ─── M3U8 Parser ──────────────────────────────────────────────────────────

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

// ─── scrapeStreams ────────────────────────────────────────────────────────

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) return makeFail(SOURCE_NAME, "no tmdbId", start);

	var isMovie = type !== "tv" && type !== "series";

	try {
		var apiHeaders = {
			"User-Agent": UA,
			Accept: "application/json",
			Referer: EMBED_BASE + "/",
		};

		// ── Query all providers in parallel ──
		var providerRequests = PROVIDERS.map(function (provider) {
			return new Promise(function (resolve) {
				var done = false;
				var timer = setTimeout(function () {
					if (!done) {
						done = true;
						resolve({ provider: provider, streams: [], error: "timeout" });
					}
				}, PER_PROVIDER_TIMEOUT);

				(async function () {
					try {
						var apiUrl = isMovie
							? API_BASE + "/movie/" + provider + "/" + tmdbId
							: API_BASE +
								"/tv/" +
								provider +
								"/" +
								tmdbId +
								"?season=" +
								(season || 1) +
								"&episode=" +
								(episode || 1);

						var apiResp = await httpGet(apiUrl, apiHeaders, 18000);
						if (!apiResp || apiResp.length < 10) {
							if (!done) {
								done = true;
								clearTimeout(timer);
								resolve({
									provider: provider,
									streams: [],
									error: "empty response",
								});
							}
							return;
						}

						var data = safeJsonParse(apiResp);
						if (!data) {
							if (!done) {
								done = true;
								clearTimeout(timer);
								resolve({
									provider: provider,
									streams: [],
									error: "bad JSON",
								});
							}
							return;
						}

						if (data.client_side === true) {
							if (!done) {
								done = true;
								clearTimeout(timer);
								resolve({
									provider: provider,
									streams: [],
									error: "client_side",
								});
							}
							return;
						}

						var streamUrl = data.stream_url;
						if (!streamUrl) {
							if (!done) {
								done = true;
								clearTimeout(timer);
								resolve({
									provider: provider,
									streams: [],
									error: "no stream_url",
								});
							}
							return;
						}

						// ── Fetch M3U8 and validate ──
						var m3u8Content = await httpGet(
							streamUrl,
							{
								"User-Agent": UA,
								Accept: "*/*",
								Referer: EMBED_BASE + "/",
							},
							15000,
						);

						if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
							if (!done) {
								done = true;
								clearTimeout(timer);
								resolve({
									provider: provider,
									streams: [],
									error: "invalid M3U8",
								});
							}
							return;
						}

						// ── Parse quality variants ──
						var variants = m3u8ToQualities(m3u8Content, streamUrl);
						var providerStreams = [];

						// Collect subtitles from API response
						var subList = [];
						var subs = data.subtitles;
						if (Array.isArray(subs) && subs.length > 0) {
							for (var si = 0; si < subs.length; si++) {
								var s = subs[si];
								if (s && s.url) {
									subList.push({
										url: s.url,
										label: s.label || s.name || s.language || "VTT",
										lang: s.language || s.lang || "en",
									});
								}
							}
						}

						if (variants.length > 0) {
							for (var vi = 0; vi < variants.length; vi++) {
								var stream = {
									url: variants[vi].url,
									quality: variants[vi].quality,
									source: SOURCE_NAME + " [" + provider + "]",
									// 🚨 Only send Referer — not backend CDN headers
									headers: { Referer: EMBED_BASE + "/" },
								};
								if (subList.length > 0) {
									stream.subtitles = subList;
								}
								providerStreams.push(stream);
							}
						} else {
							// No quality variants — return the M3U8 directly
							providerStreams.push({
								url: streamUrl,
								quality: extractQuality(streamUrl) || "Auto",
								source: SOURCE_NAME + " [" + provider + "]",
								headers: { Referer: EMBED_BASE + "/" },
							});
							if (subList.length > 0) {
								providerStreams[0].subtitles = subList;
							}
						}

						if (!done) {
							done = true;
							clearTimeout(timer);
							resolve({ provider: provider, streams: providerStreams });
						}
					} catch (e) {
						if (!done) {
							done = true;
							clearTimeout(timer);
							resolve({
								provider: provider,
								streams: [],
								error: e && e.message ? e.message : String(e),
							});
						}
					}
				})();
			});
		});

		var results = (await Promise.allSettled)
			? await Promise.allSettled(providerRequests)
			: await Promise.all(
					providerRequests.map(function (p) {
						return p
							.then(function (v) {
								return { status: "fulfilled", value: v };
							})
							.catch(function (e) {
								return { status: "rejected", reason: e };
							});
					}),
				);

		// ── Aggregate streams ──
		var allStreams = [];
		var seenUrls = {};
		var workingCount = 0;

		for (var ri = 0; ri < results.length; ri++) {
			var r = results[ri];
			if (r.status !== "fulfilled" || !r.value) continue;
			var res = r.value;
			if (!res.streams || res.streams.length === 0) {
				log("  " + res.provider + ": " + (res.error || "no streams"));
				continue;
			}
			workingCount++;
			log(
				"  " +
					res.provider +
					": " +
					res.streams.length +
					" stream(s)" +
					(res.error ? " (" + res.error + ")" : ""),
			);

			for (var si = 0; si < res.streams.length; si++) {
				var s = res.streams[si];
				if (s && s.url && !seenUrls[s.url]) {
					seenUrls[s.url] = true;
					allStreams.push(s);
				}
			}
		}

		log(
			"→ " +
				allStreams.length +
				" streams from " +
				workingCount +
				"/" +
				PROVIDERS.length +
				" providers in " +
				(Date.now() - start) +
				"ms",
		);

		if (allStreams.length > 0) {
			return {
				source: SOURCE_NAME,
				status: "working",
				streams: allStreams,
				latency_ms: Date.now() - start,
			};
		}

		var errors = [];
		for (var ri2 = 0; ri2 < results.length; ri2++) {
			var r2 = results[ri2];
			if (r2.status === "fulfilled" && r2.value && r2.value.error)
				errors.push(r2.value.provider + ": " + r2.value.error);
		}

		return {
			source: SOURCE_NAME,
			status: "no_streams",
			error: errors.join("; ") || "no working providers",
			streams: [],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return makeFail(SOURCE_NAME, e && e.message ? e.message : String(e), start);
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
