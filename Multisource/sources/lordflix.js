/**
 * lordflix.js — SkyStream MultiSource Plugin
 *
 * Fetches HLS streams from LordFlix (lordflix.org) via the enc-dec.app
 * encryption/decryption proxy service.
 *
 * ARCHITECTURE:
 *   1. Fetch TMDB metadata (IMDB ID, title, year)
 *   2. Encrypt the watch URL via enc-dec.app/api/enc-lordflix
 *      → Returns an obfuscated proxy URL + verification signature
 *   3. Fetch the proxy URL (returns JS anti-bot challenge — this IS
 *      the encrypted payload; see anti-bot analyst findings)
 *   4. Decrypt via enc-dec.app/api/dec-lordflix with the signature
 *      → Returns structured JSON with source URLs + subtitle tracks
 *   5. Fetch each source M3U8 master playlist, parse into quality variants
 *   6. Return StreamResult objects with proper URLs, headers, subtitles
 *
 * KEY INSIGHT (anti-bot analyst, 2026-06-14):
 *   The proxy URL returns a JavaScript anti-bot challenge (__atag v4.2.1).
 *   This is EXPECTED — the challenge text IS the encrypted payload.
 *   The enc-dec.app/dec-lordflix API has server-side logic that already
 *   handles the challenge and extracts the actual stream data.
 *   No browser JS execution is needed in the QuickJS runtime.
 *
 * RESPONSE SCHEMA (from endpoints-movie research, updated 2026-05-09):
 *   dec-lordflix returns:
 *     { status: 200, result: {
 *         sources: [{ url: "...m3u8", server: "Berlin", type: "hls", quality: "1080p" }],
 *         tracks:  [{ file: "...vtt", label: "English", kind: "captions" }]
 *       }
 *     }
 *
 * @module lordflix
 */

"use strict";

// ─── Constants ──────────────────────────────────────────────────────────

var SOURCE_NAME = "lordflix";

var ENC_DEC_API = "https://enc-dec.app/api";
var LORDFLIX_ORIGIN = "https://lordflix.org";
var LORDFLIX_API = "https://snowhouse.lordflix.club";
var SERVERS_ENDPOINT = LORDFLIX_API + "/servers";

var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

var HDR_JSON = {
	"User-Agent": UA,
	Accept: "application/json",
	Origin: LORDFLIX_ORIGIN,
	Referer: LORDFLIX_ORIGIN + "/",
};

var HDR_ALL = {
	"User-Agent": UA,
	Accept: "*/*",
	Origin: LORDFLIX_ORIGIN,
	Referer: LORDFLIX_ORIGIN + "/",
};

var TMDB_KEYS = [
	"68e094699525b18a70bab2f86b1fa706",
	"af3a53eb387d57fc935e9128468b1899",
	"0142a22c560ce3efb1cfd6f3b2faab77",
];

var DEFAULT_SERVERS = [
	"Berlin",
	"Orion",
	"Phoenix",
	"Aqua",
	"Oslo",
	"Luna",
	"Sakura",
	"Rio",
	"Ativa",
	"Moscow",
];

// ─── Timeouts (milliseconds) ────────────────────────────────────────────

var TIMEOUT = {
	TMDB_META: 8000,
	ENCRYPT: 10000,
	PROXY_FETCH: 12000,
	DECRYPT: 10000,
	M3U8_FETCH: 10000,
	SERVER_LIST: 5000,
	PER_SERVER_TOTAL: 25000,
};

// ─── Server Health ────────────────────────────────────────────────────

var SERVER_HEALTH = {
	FAILURE_THRESHOLD: 3,
	COOLDOWN_WINDOW: 60000, // 60s window to count failures
	COOLDOWN_DURATION: 300000, // 5 min cooldown after threshold
	MAX_SERVERS_PER_REQUEST: 5,
};

// ─── Caching ────────────────────────────────────────────────────────────

var _tmdbMetaCache = {};
var _encryptCache = {};
var _serversCache = null;
var _serversCacheTime = 0;
var _serverHealth = {};

var CACHE_TTL = {
	TMDB_META: 300000, // 5 min
	ENCRYPT: 600000, // 10 min
	SERVERS: 300000, // 5 min
};

// ─── Logging ────────────────────────────────────────────────────────────

var TAG = "[" + SOURCE_NAME + "]";

function logInfo(msg, data) {
	try {
		console.log(TAG, msg, data !== undefined ? data : "");
	} catch (_) {}
}

function logWarn(msg, data) {
	try {
		console.warn(TAG, msg, data !== undefined ? data : "");
	} catch (_) {}
}

function logError(msg, data) {
	try {
		console.error(TAG, msg, data !== undefined ? data : "");
	} catch (_) {}
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (_) {
		return null;
	}
}

async function httpGet(url, headers) {
	try {
		var raw = await globalThis.http_get(url, headers || {});
		if (typeof raw === "string") return raw;
		if (raw && raw.body) {
			if (typeof raw.body === "string") return raw.body;
			if (typeof raw.body === "object") return JSON.stringify(raw.body);
		}
	} catch (_) {}
	return "";
}

async function httpPost(url, headers, body) {
	try {
		var raw = await globalThis.http_post(url, headers || {}, body || "");
		if (typeof raw === "string") return raw;
		if (raw && raw.body) {
			if (typeof raw.body === "string") return raw.body;
			if (typeof raw.body === "object") return JSON.stringify(raw.body);
		}
	} catch (_) {}
	return "";
}

/**
 * Race a promise against a timeout.
 * Returns the promise result or rejects with TimeoutError.
 */
function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise(function (_, reject) {
			setTimeout(function () {
				reject(new Error((label || "request") + " timeout (" + ms + "ms)"));
			}, ms);
		}),
	]);
}

/**
 * Encode URI component with + for spaces (matching the original source).
 */
function enc(s) {
	return encodeURIComponent(String(s)).replace(/%20/g, "+");
}

// ─── TMDB Metadata ──────────────────────────────────────────────────────

var _tmdbIdx = 0;

function tmdbKey() {
	return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
}

/**
 * Fetch title, year, IMDB ID from TMDB.
 * Results are cached for CACHE_TTL.TMDB_META.
 */
async function fetchTmdbMeta(tmdbId, type) {
	var key = String(tmdbId) + ":" + (type || "movie");
	if (_tmdbMetaCache[key] !== undefined) {
		var cached = _tmdbMetaCache[key];
		if (cached._expires > Date.now()) return cached;
	}

	try {
		var endpoint = type === "tv" ? "/tv/" : "/movie/";
		var url =
			"https://api.themoviedb.org/3" +
			endpoint +
			String(tmdbId) +
			"?api_key=" +
			tmdbKey() +
			"&append_to_response=external_ids&language=en";

		var resp = await httpGet(url, {
			"User-Agent": UA,
			Accept: "application/json",
		});

		var data = safeJsonParse(resp);
		if (!data) return null;

		var title = data.title || data.name || "";
		var date = data.release_date || data.first_air_date || "";
		var year = date ? date.split("-")[0] : "";
		var imdbId =
			(data.external_ids && data.external_ids.imdb_id) || data.imdb_id || "";

		var result = {
			title: title,
			year: year,
			imdb_id: imdbId,
			_expires: Date.now() + CACHE_TTL.TMDB_META,
		};

		_tmdbMetaCache[key] = result;
		return result;
	} catch (e) {
		logWarn("TMDB meta failed for " + tmdbId, e && e.message);
		return null;
	}
}

// ─── Server Management ──────────────────────────────────────────────────

/**
 * Fetch available servers from the LordFlix API.
 * Falls back to DEFAULT_SERVERS if the request fails.
 */
async function fetchServers() {
	if (_serversCache && _serversCacheTime + CACHE_TTL.SERVERS > Date.now()) {
		return _serversCache;
	}

	try {
		var resp = await withTimeout(
			httpGet(SERVERS_ENDPOINT, HDR_JSON),
			TIMEOUT.SERVER_LIST,
			"servers list",
		);
		var data = safeJsonParse(resp);
		if (Array.isArray(data)) {
			_serversCache = data;
			_serversCacheTime = Date.now();
			logInfo("Fetched " + data.length + " servers");
			return data;
		}
	} catch (e) {
		logWarn("Could not fetch server list, using defaults", e && e.message);
	}

	_serversCache = DEFAULT_SERVERS;
	_serversCacheTime = Date.now();
	return DEFAULT_SERVERS;
}

/**
 * Check if a server is healthy (not in cooldown).
 */
function isServerAvailable(name) {
	var state = _serverHealth[name];
	if (!state) return true;
	if (state.cooldownUntil > Date.now()) return false;
	// Reset after cooldown
	state.failures = 0;
	return true;
}

/**
 * Record a server failure. After FAILURE_THRESHOLD consecutive failures
 * within COOLDOWN_WINDOW, the server enters cooldown for COOLDOWN_DURATION.
 */
function recordServerFailure(name) {
	var now = Date.now();
	var state = _serverHealth[name];
	if (!state) {
		_serverHealth[name] = {
			failures: 1,
			firstFailure: now,
			cooldownUntil: 0,
		};
		return;
	}

	// Reset counter if outside the window
	if (now - state.firstFailure > SERVER_HEALTH.COOLDOWN_WINDOW) {
		state.failures = 1;
		state.firstFailure = now;
	} else {
		state.failures++;
	}

	if (state.failures >= SERVER_HEALTH.FAILURE_THRESHOLD) {
		state.cooldownUntil = now + SERVER_HEALTH.COOLDOWN_DURATION;
		logWarn(
			"Server '" +
				name +
				"' in cooldown for " +
				SERVER_HEALTH.COOLDOWN_DURATION +
				"ms",
		);
	}
}

/**
 * Record a successful server response.
 */
function recordServerSuccess(name) {
	var state = _serverHealth[name];
	if (state) {
		state.failures = 0;
		state.cooldownUntil = 0;
	}
}

// ─── Resolve Relative URLs ──────────────────────────────────────────────

function resolveRelativeUrl(baseUrl, relativePath) {
	if (!baseUrl || !relativePath) return relativePath || baseUrl;
	if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
	if (relativePath.indexOf("/") === 0) {
		var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
		return (originMatch ? originMatch[1] : "") + relativePath;
	}
	// Relative to the directory of baseUrl
	var idx = baseUrl.lastIndexOf("/");
	if (idx === -1) return baseUrl + "/" + relativePath;
	return baseUrl.substring(0, idx + 1) + relativePath;
}

// ─── M3U8 Parser ────────────────────────────────────────────────────────

/**
 * Extract codecs from an EXT-X-STREAM-INF line.
 */
function extractCodecs(streamInfLine) {
	var m = streamInfLine.match(/CODECS="([^"]+)"/i);
	return m ? m[1] : "";
}

/**
 * Convert a codec string to a short readable label.
 */
function codecLabel(codecs) {
	if (!codecs) return "";
	var c = String(codecs).toLowerCase();
	if (c.indexOf("hev1") !== -1 || c.indexOf("hvc1") !== -1) return "HEVC";
	if (c.indexOf("dvh1") !== -1 || c.indexOf("dvhe") !== -1) return "DV";
	if (c.indexOf("av01") !== -1 || c.indexOf("dav1") !== -1) return "AV1";
	if (c.indexOf("avc1") !== -1) return "H.264";
	if (c.indexOf("mp4a") !== -1) return "AAC";
	return codecs;
}

/**
 * Convert resolution height to a quality label string.
 */
function qualityLabel(height) {
	if (height >= 2160) return "2160p";
	if (height >= 1440) return "1440p";
	if (height >= 1080) return "1080p";
	if (height >= 720) return "720p";
	if (height >= 480) return "480p";
	if (height >= 360) return "360p";
	return height ? height + "p" : "Auto";
}

/**
 * Attempt to extract quality from a URL string.
 */
function extractQuality(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	if (/\b1080\b/i.test(u)) return "1080p";
	if (/\b720\b/i.test(u)) return "720p";
	return "";
}

/**
 * Fetch an M3U8 playlist and parse it into quality variants with metadata.
 *
 * Always returns a consistent object:
 *   { variants: [...], audioTracks: [...], subtitleTracks: [...] }
 *
 * `variants` is always an array. If the content is a media playlist (no
 * STREAM-INF tags) or not parseable, variants contains a single entry
 * with the original URL.
 *
 * Variants are sorted by height descending (highest quality first).
 *
 * @param {string} playlistUrl
 * @param {string} referer
 * @returns {Promise<{variants:Array, audioTracks:Array, subtitleTracks:Array}>}
 */
async function parseM3U8Master(playlistUrl, referer) {
	var defaultVariant = function () {
		return [
			{
				url: playlistUrl,
				quality: extractQuality(playlistUrl) || "Auto",
				height: 0,
				codecLabel: "",
			},
		];
	};

	var content = await withTimeout(
		httpGet(playlistUrl, {
			"User-Agent": UA,
			Accept: "*/*",
			Referer: referer || LORDFLIX_ORIGIN + "/",
			Origin: LORDFLIX_ORIGIN,
		}),
		TIMEOUT.M3U8_FETCH,
		"m3u8 fetch",
	);

	// Not an M3U8 or empty — return the original URL as-is
	if (!content || content.indexOf("#EXTM3U") === -1) {
		return {
			variants: defaultVariant(),
			audioTracks: [],
			subtitleTracks: [],
		};
	}

	// Media playlist (no STREAM-INF tags) — return as single stream
	if (content.indexOf("#EXT-X-STREAM-INF:") === -1) {
		return {
			variants: defaultVariant(),
			audioTracks: [],
			subtitleTracks: [],
		};
	}

	// Parse master playlist variants
	var lines = content.split("\n");
	var variants = [];
	var audioTracks = [];
	var subtitleTracks = [];

	for (var li = 0; li < lines.length; li++) {
		var line = lines[li];

		// Parse #EXT-X-STREAM-INF
		if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
			var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
			var height = resMatch ? parseInt(resMatch[1], 10) : 0;
			var codecs = extractCodecs(line);

			// Next non-empty, non-comment line is the URL
			for (var ni = li + 1; ni < lines.length; ni++) {
				var urlPart = lines[ni].trim();
				if (urlPart && urlPart.indexOf("#") !== 0) {
					var fullUrl =
						urlPart.indexOf("http") === 0
							? urlPart
							: resolveRelativeUrl(playlistUrl, urlPart);
					variants.push({
						url: fullUrl,
						quality: qualityLabel(height),
						height: height,
						codecLabel: codecLabel(codecs),
					});
					break;
				}
			}
		}

		// Parse #EXT-X-MEDIA:TYPE=AUDIO
		if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
			var auUri = (line.match(/URI="([^"]+)"/) || [])[1];
			if (auUri) {
				audioTracks.push({
					url:
						auUri.indexOf("http") === 0
							? auUri
							: resolveRelativeUrl(playlistUrl, auUri),
					language: (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || "en",
					name: (line.match(/NAME="([^"]+)"/) || [])[1] || "Audio",
					default: line.indexOf("DEFAULT=YES") !== -1,
				});
			}
		}

		// Parse #EXT-X-MEDIA:TYPE=SUBTITLES
		if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
			var subUri = (line.match(/URI="([^"]+)"/) || [])[1];
			if (subUri) {
				subtitleTracks.push({
					url:
						subUri.indexOf("http") === 0
							? subUri
							: resolveRelativeUrl(playlistUrl, subUri),
					language: (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || "en",
					label: (line.match(/NAME="([^"]+)"/) || [])[1] || "Subtitles",
					default: line.indexOf("DEFAULT=YES") !== -1,
				});
			}
		}
	}

	// Sort by height descending (highest quality first)
	variants.sort(function (a, b) {
		return b.height - a.height;
	});

	// If we found variants, use them; otherwise return the original URL
	return {
		variants: variants.length > 0 ? variants : defaultVariant(),
		audioTracks: audioTracks,
		subtitleTracks: subtitleTracks,
	};
}

// ─── Quality Ranking ────────────────────────────────────────────────────

function qualityRank(q) {
	var qs = String(q || "").toLowerCase();
	if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
	if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
	if (qs.indexOf("1080") !== -1) return 5;
	if (qs.indexOf("720") !== -1) return 4;
	if (qs.indexOf("480") !== -1) return 3;
	if (qs.indexOf("360") !== -1) return 2;
	if (qs.indexOf("240") !== -1) return 1;
	return 3;
}

// ─── Stream URL Validation ──────────────────────────────────────────────

/**
 * Basic validation that a URL is likely playable.
 */
function isValidStreamUrl(url) {
	if (!url || typeof url !== "string") return false;
	if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0)
		return false;
	// Must be at least 15 chars and contain a domain
	var hostMatch = url.match(/^https?:\/\/([^/]+)/);
	if (!hostMatch || hostMatch[1].length < 3) return false;
	var host = hostMatch[1].toLowerCase();
	// Reject private/reserved IP ranges
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.indexOf("169.254.") === 0 ||
		host.indexOf("10.") === 0 ||
		host.indexOf("172.16.") === 0 ||
		host.indexOf("192.168.") === 0
	)
		return false;
	return true;
}

// ─── Main Scraper ───────────────────────────────────────────────────────

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
			error: "no tmdbId provided",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}

	try {
		// ── Step 1: Fetch TMDB metadata ──
		var meta = await fetchTmdbMeta(tmdbId, type);
		if (!meta || !meta.title || !meta.imdb_id) {
			return {
				source: SOURCE_NAME,
				status: "error",
				error: "TMDB metadata missing — need title and imdb_id",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		logInfo(
			"Resolving " +
				(type === "tv" ? "TV" : "Movie") +
				" " +
				tmdbId +
				' ("' +
				meta.title +
				'", ' +
				meta.imdb_id +
				")",
		);

		// ── Step 2: Fetch available servers ──
		var servers = await fetchServers();

		// ── Step 3: Try each server ──
		var allStreams = [];
		var serverErrors = [];
		var typeParam = type === "tv" ? "series" : "movie";
		var serversAttempted = 0;

		for (var si = 0; si < servers.length; si++) {
			var serverEntry = servers[si];
			var server =
				typeof serverEntry === "string"
					? serverEntry
					: serverEntry && serverEntry.name
						? serverEntry.name
						: String(serverEntry);
			if (!server) continue;

			// Skip servers in cooldown
			if (!isServerAvailable(server)) continue;

			serversAttempted++;
			if (serversAttempted > SERVER_HEALTH.MAX_SERVERS_PER_REQUEST) break;

			try {
				var serverResult = await queryServer(
					tmdbId,
					type,
					typeParam,
					meta.title,
					meta.year,
					meta.imdb_id,
					season,
					episode,
					server,
				);
				if (serverResult && serverResult.length > 0) {
					for (var sj = 0; sj < serverResult.length; sj++) {
						allStreams.push(serverResult[sj]);
					}
					recordServerSuccess(server);
					logInfo(
						"Server '" +
							server +
							"' returned " +
							serverResult.length +
							" streams",
					);
				}
			} catch (e) {
				recordServerFailure(server);
				serverErrors.push(
					server + ": " + (e && e.message ? e.message : String(e)),
				);
				logWarn("Server '" + server + "' failed", e && e.message);
			}
		}

		// ── Step 4: Deduplicate streams by URL ──
		var seenUrls = {};
		var deduped = [];
		for (var sdi = 0; sdi < allStreams.length; sdi++) {
			var stream = allStreams[sdi];
			if (!stream.url || seenUrls[stream.url]) continue;
			// Validate the stream URL
			if (!isValidStreamUrl(stream.url)) continue;
			seenUrls[stream.url] = true;
			deduped.push(stream);
		}

		// Sort by quality (highest first)
		deduped.sort(function (a, b) {
			var qa = qualityRank(a.quality);
			var qb = qualityRank(b.quality);
			if (qb !== qa) return qb - qa;
			return (a.server || "").localeCompare(b.server || "");
		});

		if (deduped.length === 0) {
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				error: serverErrors.join("; ") || "all servers returned no streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		logInfo(
			"Returning " +
				deduped.length +
				" streams in " +
				(Date.now() - start) +
				"ms",
		);

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: deduped,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		logError("scrapeStreams failed", e && e.message);
		return {
			source: SOURCE_NAME,
			status: "error",
			error: e && e.message ? e.message : String(e),
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

// ─── Server Query ───────────────────────────────────────────────────────

/**
 * Query a single LordFlix server for stream sources.
 *
 * Flow:
 *   1. Build the watch URL with metadata
 *   2. Encrypt via enc-dec.app/api/enc-lordflix → { url, sign }
 *   3. Fetch the proxy URL → encrypted payload (JS challenge)
 *   4. Decrypt via enc-dec.app/api/dec-lordflix → { sources, tracks }
 *   5. Parse sources → fetch M3U8 master → extract quality variants
 *   6. Return StreamResult objects
 *
 * @param {number} tmdbId
 * @param {string} type - "movie" or "tv"
 * @param {string} typeParam - "movie" or "series"
 * @param {string} title
 * @param {string} year
 * @param {string} imdbId
 * @param {number} season
 * @param {number} episode
 * @param {string} server - Server name (e.g. "Berlin")
 * @returns {Promise<Array>} Array of stream objects
 */
async function queryServer(
	tmdbId,
	type,
	typeParam,
	title,
	year,
	imdbId,
	season,
	episode,
	server,
) {
	// ── Build the watch URL ──
	var watchUrl =
		LORDFLIX_API +
		"/?title=" +
		enc(title) +
		"&type=" +
		enc(typeParam) +
		"&year=" +
		enc(year || "") +
		"&imdb=" +
		enc(imdbId) +
		"&tmdb=" +
		tmdbId +
		"&server=" +
		enc(server);
	if (type === "tv") {
		watchUrl += "&season=" + (season || 1) + "&episode=" + (episode || 1);
	}

	// ── Step 2: Encrypt the watch URL ──
	var encryptCacheKey =
		"enc:" +
		server +
		":" +
		tmdbId +
		":" +
		(type === "tv" ? season + "-" + episode : "");
	var encResult = _encryptCache[encryptCacheKey];
	if (!encResult || encResult._expires < Date.now()) {
		var encResp = await withTimeout(
			httpGet(ENC_DEC_API + "/enc-lordflix?url=" + enc(watchUrl), HDR_JSON),
			TIMEOUT.ENCRYPT,
			server + " encrypt",
		);

		var encData = safeJsonParse(encResp);
		if (
			!encData ||
			encData.status !== 200 ||
			!encData.result ||
			!encData.result.url ||
			!encData.result.sign
		) {
			logWarn(
				"Encrypt failed for " + server,
				encResp && encResp.substring(0, 200),
			);
			throw new Error("encrypt returned invalid response");
		}

		encResult = {
			proxyUrl: encData.result.url,
			sign: encData.result.sign,
			_expires: Date.now() + CACHE_TTL.ENCRYPT,
		};
		_encryptCache[encryptCacheKey] = encResult;
	}

	// ── Step 3: Fetch the proxy URL (returns encrypted payload) ──
	// NOTE: This returns the JS anti-bot challenge body.
	// This is EXPECTED behavior — the challenge text IS the encrypted data.
	var encryptedPayload = await withTimeout(
		httpGet(encResult.proxyUrl, HDR_ALL),
		TIMEOUT.PROXY_FETCH,
		server + " proxy fetch",
	);

	if (!encryptedPayload || encryptedPayload.length < 20) {
		throw new Error(
			"proxy returned empty response (" +
				(encryptedPayload || "").length +
				" bytes)",
		);
	}

	// ── Step 4: Decrypt via enc-dec.app ──
	var decResp = await withTimeout(
		httpPost(
			ENC_DEC_API + "/dec-lordflix",
			{
				"Content-Type": "application/json",
				"User-Agent": UA,
				Accept: "application/json",
			},
			JSON.stringify({
				text: encryptedPayload,
				sign: encResult.sign,
			}),
		),
		TIMEOUT.DECRYPT,
		server + " decrypt",
	);

	var decData = safeJsonParse(decResp);
	if (!decData) {
		throw new Error("decrypt returned unparseable response");
	}

	// Check for API-level errors
	if (decData.status && decData.status !== 200) {
		throw new Error("decrypt returned status " + decData.status);
	}

	// The sources may be in result.sources (new format) or result.stream (legacy format)
	var sourceList = null;
	var subTracks = [];

	if (decData.result) {
		// New format: result.sources[]
		if (decData.result.sources && Array.isArray(decData.result.sources)) {
			sourceList = decData.result.sources;
		}
		// Legacy format: result.stream[]
		if (
			!sourceList &&
			decData.result.stream &&
			Array.isArray(decData.result.stream)
		) {
			sourceList = decData.result.stream;
		}
		// Subtitle tracks
		if (decData.result.tracks && Array.isArray(decData.result.tracks)) {
			subTracks = decData.result.tracks;
		}
	}

	if (!sourceList || sourceList.length === 0) {
		throw new Error("no sources in decrypted response");
	}

	// ── Step 5: Parse sources into stream objects ──
	var streams = [];
	var baseReferer = LORDFLIX_ORIGIN + "/";

	for (var si = 0; si < sourceList.length; si++) {
		var src = sourceList[si];
		var srcUrl = src.url || src.playlist || "";

		// Skip non-HLS sources or empty URLs
		if (!srcUrl) continue;
		if (src.type && src.type !== "hls") continue;

		var streamHeaders = {
			"User-Agent": UA,
			Referer: baseReferer,
			Origin: LORDFLIX_ORIGIN,
		};

		try {
			// Fetch and parse M3U8 master playlist
			var parseResult = await parseM3U8Master(srcUrl, baseReferer);

			// parseResult is always { variants, audioTracks, subtitleTracks }
			var variants = parseResult.variants;
			var hasAudioTracks =
				parseResult.audioTracks && parseResult.audioTracks.length > 0;

			for (var vi = 0; vi < variants.length; vi++) {
				var v = variants[vi];
				// Label format: "Server [Quality]" — e.g. "Orion [1080p]"
				var label = server + " [" + v.quality + "]";

				var streamObj = {
					url: v.url,
					quality: label,
					headers: copyHeaders(streamHeaders),
					server: server,
				};

				// Attach subtitle tracks from M3U8
				if (
					parseResult.subtitleTracks &&
					parseResult.subtitleTracks.length > 0
				) {
					streamObj.subtitles = mapSubtitles(parseResult.subtitleTracks);
				}

				// Attach subtitle tracks from API response
				if (subTracks.length > 0) {
					var apiSubs = mapApiSubtitles(subTracks);
					if (streamObj.subtitles) {
						// Merge (deduplicate by URL)
						var existingUrls = {};
						for (var esi = 0; esi < streamObj.subtitles.length; esi++) {
							existingUrls[streamObj.subtitles[esi].url] = true;
						}
						for (var asi = 0; asi < apiSubs.length; asi++) {
							if (!existingUrls[apiSubs[asi].url]) {
								streamObj.subtitles.push(apiSubs[asi]);
							}
						}
					} else {
						streamObj.subtitles = apiSubs;
					}
				}

				streams.push(streamObj);
			}

			// ── Include the original source URL as a stream entry. ──
			//    This gives the player's HLS stack the full master
			//    playlist context — including audio group references
			//    (AUDIO="..."), alternative audio tracks, codec
			//    metadata, etc. Individual variant URLs are useful
			//    for quality selection but lose master-level context.
			//    Skip if srcUrl matches a variant URL (shouldn't
			//    happen with proper relative URL resolution).
			var hasSrcUrl = false;
			for (var si_ = 0; si_ < streams.length; si_++) {
				if (streams[si_].url === srcUrl) {
					hasSrcUrl = true;
					break;
				}
			}
			if (!hasSrcUrl) {
				streams.push({
					url: srcUrl,
					quality: server + " [Master]",
					headers: copyHeaders(streamHeaders),
					server: server,
				});
			}
		} catch (m3u8Err) {
			// If M3U8 parsing fails, try to use the source URL directly
			logWarn("M3U8 parse failed for " + server, m3u8Err && m3u8Err.message);
			var q = src.quality || extractQuality(srcUrl) || "Auto";
			streams.push({
				url: srcUrl,
				quality: server + " [" + q + "]",
				headers: copyHeaders(streamHeaders),
				server: server,
			});
		}
	}

	return streams;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function copyHeaders(obj) {
	if (!obj || typeof obj !== "object") return {};
	var out = {};
	for (var k in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null)
			out[k] = obj[k];
	}
	return out;
}

/**
 * Map M3U8 #EXT-X-MEDIA:TYPE=SUBTITLES entries to subtitle objects.
 */
function mapSubtitles(m3u8Subs) {
	var subs = [];
	for (var i = 0; i < m3u8Subs.length; i++) {
		var s = m3u8Subs[i];
		subs.push({
			url: s.url,
			label: s.label || s.name || "Subtitles",
			lang: s.language || "en",
		});
	}
	return subs;
}

/**
 * Map enc-dec.app API subtitle tracks to subtitle objects.
 */
function mapApiSubtitles(tracks) {
	var subs = [];
	for (var i = 0; i < tracks.length; i++) {
		var t = tracks[i];
		var subUrl = t.file || t.url || t.src || "";
		if (!subUrl) continue;
		subs.push({
			url: subUrl,
			label: t.label || t.language || t.lang || "Subtitles",
			lang: t.language || t.lang || "en",
		});
	}
	return subs;
}

// ─── Export ─────────────────────────────────────────────────────────────

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
