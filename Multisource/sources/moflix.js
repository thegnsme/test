// file: sources/moflix.js
//
// Moflix-Stream source — REST API returning direct M3U8 HLS streams.
// Based on streamflix-reborn MoflixExtractor.kt.
//
// Movie API: GET /api/v1/titles/{base64("tmdb|movie|" + tmdbId)}?loader=titlePage
// TV API:    1. GET /api/v1/titles/{base64("tmdb|series|" + tmdbId)}?loader=titlePage → extract mediaId
//            2. GET /api/v1/titles/{mediaId}/seasons/{s}/episodes/{e}?loader=episodePage
// Playback:  GET /api/v1/{playback_resolve_url} → returns JSON { src }
//
// The primary stream is a direct HLS master playlist. Embed mirrors
// (vidara, veev, gupload) require JS rendering and are not extractable
// in QuickJS, so we focus on the direct stream only.

var SOURCE_NAME = "moflix";
var MAIN_URL = "https://moflix-stream.xyz";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

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

// ─── Base64 helpers (QuickJS-safe) ─────────────────────────────────────
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
		var a = bytes[i];
		var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
		var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
		result += B64.charAt(a >> 2);
		result += B64.charAt(((a & 3) << 4) | (b >> 4));
		if (i + 1 < bytes.length) {
			result += B64.charAt(((b & 15) << 2) | (c >> 6));
		} else {
			result += "=";
		}
		if (i + 2 < bytes.length) {
			result += B64.charAt(c & 63);
		} else {
			result += "=";
		}
	}
	return result;
}

// ─── HTTP helpers (QuickJS globalThis.http_get) ────────────────────────
async function httpGet(url, headers) {
	try {
		var raw = await globalThis.http_get(url, headers || {}, 30000);
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

// ─── M3U8 Master Playlist Parser ───────────────────────────────────────
// Parses a master playlist (#EXTM3U) and returns an array of variant streams.
// Each variant: { url, quality (string), height (number) }

function parseMasterPlaylist(playlistContent, baseUrl) {
	if (!playlistContent || playlistContent.indexOf("#EXTM3U") === -1) {
		return null;
	}

	var lines = playlistContent.split("\n");
	var variants = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];

		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			// Extract resolution from the STREAM-INF line
			var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
			var width = resMatch ? parseInt(resMatch[1], 10) : 0;
			var height = resMatch ? parseInt(resMatch[2], 10) : 0;

			// Extract bandwidth
			var bwMatch = line.match(/BANDWIDTH=(\d+)/i);
			var bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

			// Look for variant URL on the next non-empty, non-comment line
			for (var j = i + 1; j < lines.length; j++) {
				var urlPart = lines[j].trim();
				if (urlPart === "" || urlPart.indexOf("#") === 0) continue;

				var fullUrl;
				if (urlPart.indexOf("http") === 0) {
					fullUrl = urlPart;
				} else if (urlPart.indexOf("//") === 0) {
					fullUrl = "https:" + urlPart;
				} else {
					// Resolve relative URL against the base master playlist URL
					var baseStr = baseUrl;
					// Remove query string from base for relative resolution
					if (baseStr.indexOf("?") !== -1)
						baseStr = baseStr.substring(0, baseStr.indexOf("?"));
					if (urlPart.indexOf("/") === 0) {
						var originMatch = baseStr.match(/^(https?:\/\/[^/]+)/);
						fullUrl = (originMatch ? originMatch[1] : "") + urlPart;
					} else {
						fullUrl = baseStr.replace(/\/[^/]*$/, "/") + urlPart;
					}
				}

				var quality =
					height >= 2160
						? "2160p"
						: height >= 1440
							? "1440p"
							: height >= 1080
								? "1080p"
								: height >= 720
									? "720p"
									: height >= 480
										? "480p"
										: height >= 360
											? "360p"
											: height
												? height + "p"
												: "Auto";

				// Append bandwidth to quality for disambiguation
				if (bandwidth > 0 && quality !== "Auto") {
					quality += " (" + (bandwidth / 1000).toFixed(0) + "k)";
				}

				variants.push({
					url: fullUrl,
					quality: quality,
					height: height,
					bandwidth: bandwidth,
				});
				break;
			}
		}
	}

	// Also extract audio track info (EXT-X-MEDIA TYPE=AUDIO)
	var audioTracks = [];
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
			var nameMatch = line.match(/NAME="([^"]*)"/);
			var langMatch = line.match(/LANGUAGE="([^"]*)"/);
			var uriMatch = line.match(/URI="([^"]*)"/);
			var isDefault = line.indexOf("DEFAULT=YES") !== -1;
			if (uriMatch && nameMatch) {
				var audioUrl;
				var audioUri = uriMatch[1];
				if (audioUri.indexOf("http") === 0) {
					audioUrl = audioUri;
				} else {
					var baseStr3 = baseUrl;
					if (baseStr3.indexOf("?") !== -1)
						baseStr3 = baseStr3.substring(0, baseStr3.indexOf("?"));
					if (audioUri.indexOf("/") === 0) {
						var originMatch3 = baseStr3.match(/^(https?:\/\/[^/]+)/);
						audioUrl = (originMatch3 ? originMatch3[1] : "") + audioUri;
					} else {
						audioUrl = baseStr3.replace(/\/[^/]*$/, "/") + audioUri;
					}
				}
				audioTracks.push({
					name: nameMatch[1],
					language: langMatch ? langMatch[1] : "",
					url: audioUrl,
					isDefault: isDefault,
				});
			}
		}
	}

	if (variants.length === 0 && audioTracks.length > 0) {
		// Some playlists only have audio but no video variants — still return them
		return { variants: null, audioTracks: audioTracks, isAudioOnly: true };
	}

	if (variants.length === 0) return null;

	variants.sort(function (a, b) {
		return b.height - a.height;
	});

	return {
		variants: variants,
		audioTracks: audioTracks.length > 0 ? audioTracks : null,
	};
}

// ─── Main scrape function ──────────────────────────────────────────────
async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) return makeFail(SOURCE_NAME, "no tmdbId", start);

	try {
		var isMovie = type !== "tv" && type !== "series";
		var encodedId;
		var url;

		if (isMovie) {
			encodedId = b64encode("tmdb|movie|" + tmdbId);
			url = MAIN_URL + "/api/v1/titles/" + encodedId + "?loader=titlePage";
		} else {
			encodedId = b64encode("tmdb|series|" + tmdbId);
			url = MAIN_URL + "/api/v1/titles/" + encodedId + "?loader=titlePage";
		}

		var data = await fetchJSON(url);
		if (!data)
			return makeFail(
				SOURCE_NAME,
				"no JSON response from titles endpoint",
				start,
			);

		var videos = [];
		var mediaId = null;

		// Extract videos and mediaId from different possible response shapes
		if (data.videos) videos = data.videos;
		if (data.title) {
			if (data.title.id) mediaId = data.title.id;
			if (data.title.videos) videos = data.title.videos;
		}

		// For TV, fetch the episode endpoint using the mediaId
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
			return makeFail(SOURCE_NAME, "no videos found in response", start);
		}

		var streams = [];

		for (var i = 0; i < videos.length; i++) {
			var v = videos[i];
			var src = v.src || "";
			var resolveUrl = v.playback_resolve_url || "";
			var quality = v.quality || "";
			var streamType = v.type || "";
			var isPremium = v.premium_locked === true;

			if (isPremium) continue;
			if (!src && !resolveUrl) continue;

			var finalSrc = "";

			if (resolveUrl) {
				// Call the playback resolution endpoint
				var resolveEndpoint = MAIN_URL + "/api/v1/" + resolveUrl;
				var resolvedData = await fetchJSON(resolveEndpoint);
				if (resolvedData && resolvedData.src) {
					finalSrc = resolvedData.src;
				}
			} else if (src) {
				finalSrc = src;
			}

			if (!finalSrc) continue;

			// ── Direct M3U8 stream (type = "stream") ──
			if (
				finalSrc.indexOf(".m3u8") !== -1 ||
				finalSrc.indexOf(".m3u?") !== -1
			) {
				// Fetch the master playlist to extract all quality variants
				var playlistContent = await httpGet(finalSrc, {
					"User-Agent": UA,
					Referer: MAIN_URL + "/",
					Accept: "*/*",
				});

				if (playlistContent && playlistContent.indexOf("#EXTM3U") !== -1) {
					var parsed = parseMasterPlaylist(playlistContent, finalSrc);

					if (parsed && parsed.variants && parsed.variants.length > 0) {
						// Add each variant from the master playlist
						for (var vi = 0; vi < parsed.variants.length; vi++) {
							var variant = parsed.variants[vi];
							streams.push({
								url: variant.url,
								quality: variant.quality,
								headers: {
									"User-Agent": UA,
									Referer: MAIN_URL + "/",
								},
							});
						}
					} else if (parsed && parsed.isAudioOnly) {
						// Audio-only playlist — add audio tracks
						for (var ai = 0; ai < parsed.audioTracks.length; ai++) {
							var at = parsed.audioTracks[ai];
							streams.push({
								url: at.url,
								quality:
									"Audio - " +
									at.name +
									(at.language ? " [" + at.language + "]" : ""),
								headers: {
									"User-Agent": UA,
									Referer: MAIN_URL + "/",
								},
							});
						}
					} else {
						// Master playlist parsing produced nothing usable — pass the original URL
						var q = quality || extractQuality(finalSrc) || "Auto";
						streams.push({
							url: finalSrc,
							quality: q,
							headers: {
								"User-Agent": UA,
								Referer: MAIN_URL + "/",
							},
						});
					}
				} else {
					// Not a valid M3U8 playlist or couldn't fetch — use the original URL with quality hint
					var q2 = quality || extractQuality(finalSrc) || "Auto";
					streams.push({
						url: finalSrc,
						quality: q2,
						headers: {
							"User-Agent": UA,
							Referer: MAIN_URL + "/",
						},
					});
				}
			}
			// ── Skip embed URLs — they require JS rendering in browser ──
			// Embed types (vidara.to, veev.to, gupload, etc.) can't be extracted in QuickJS.
			// We log them but don't add to streams since they won't resolve.
			else if (streamType === "embed") {
				// Try a quick scrape for any M3U8 in the embed page
				try {
					var embedHtml = await httpGet(finalSrc, {
						"User-Agent": UA,
						Referer: MAIN_URL + "/",
						Accept: "text/html,application/xhtml+xml",
					});
					if (embedHtml && embedHtml.length > 100) {
						var m3u8Regex = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g;
						var m3u8Match = embedHtml.match(m3u8Regex);
						if (m3u8Match && m3u8Match.length > 0) {
							var sourceUrl = m3u8Match[0];
							// Try to parse this as a variant playlist too
							var subPlaylist = await httpGet(sourceUrl, {
								"User-Agent": UA,
								Referer: finalSrc,
								Accept: "*/*",
							});
							if (subPlaylist && subPlaylist.indexOf("#EXTM3U") !== -1) {
								var subParsed = parseMasterPlaylist(subPlaylist, sourceUrl);
								if (
									subParsed &&
									subParsed.variants &&
									subParsed.variants.length > 0
								) {
									for (var svi = 0; svi < subParsed.variants.length; svi++) {
										var sv = subParsed.variants[svi];
										streams.push({
											url: sv.url,
											quality: sv.quality + " (mirror)",
											headers: {
												"User-Agent": UA,
												Referer: finalSrc,
											},
										});
									}
								} else {
									var q3 = quality || extractQuality(sourceUrl) || "Auto";
									streams.push({
										url: sourceUrl,
										quality: q3 + " (mirror)",
										headers: {
											"User-Agent": UA,
											Referer: finalSrc,
										},
									});
								}
							} else {
								var q4 = quality || extractQuality(sourceUrl) || "Auto";
								streams.push({
									url: sourceUrl,
									quality: q4 + " (mirror)",
									headers: {
										"User-Agent": UA,
										Referer: finalSrc,
									},
								});
							}
						}
					}
				} catch (e) {
					// Embed extraction failed — skip silently
				}
			}
			// ── MP4 direct URL ──
			else if (finalSrc.indexOf(".mp4") !== -1) {
				var q5 = quality || extractQuality(finalSrc) || "Auto";
				streams.push({
					url: finalSrc,
					quality: q5,
					headers: {
						"User-Agent": UA,
						Referer: MAIN_URL + "/",
					},
				});
			}
			// ── Playback endpoint URL ──
			else if (finalSrc.indexOf("/playback") !== -1) {
				var pbData = await fetchJSON(finalSrc);
				if (pbData && pbData.src) {
					var q6 = quality || extractQuality(pbData.src) || "Auto";
					streams.push({
						url: pbData.src,
						quality: q6,
						headers: {
							"User-Agent": UA,
							Referer: MAIN_URL + "/",
						},
					});
				}
			}
		}

		if (streams.length === 0) {
			return makeFail(SOURCE_NAME, "no playable streams resolved", start);
		}

		// Deduplicate by URL (keep first occurrence)
		var seen = {};
		var unique = [];
		for (var si = 0; si < streams.length; si++) {
			if (!seen[streams[si].url]) {
				seen[streams[si].url] = true;
				unique.push(streams[si]);
			}
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: unique,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return makeFail(SOURCE_NAME, e && e.message ? e.message : String(e), start);
	}

	function fail(msg) {
		return makeFail(SOURCE_NAME, msg, start);
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
