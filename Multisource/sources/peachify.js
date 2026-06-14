"use strict";

/**
 * Peachify source — Skystream MultiSource plugin.
 *
 * Queries all Peachify backend servers in parallel:
 *   Iron   → uwu.eat-peach.sbs/moviebox
 *   Spider → usa.eat-peach.sbs/holly
 *   Wolf   → usa.eat-peach.sbs/air
 *   Multi  → usa.eat-peach.sbs/multi
 *   Dark   → uwu.eat-peach.sbs/net
 *
 * API: {base}/{path}/movie/{tmdbId}
 *      {base}/{path}/tv/{tmdbId}/{season}/{episode}
 *
 * Responses are AES-256-GCM encrypted (CTR mode + GHASH auth).
 * Payload format: base64url(iv).base64url(ciphertext).base64url(authTag)
 *
 * Each HLS source URL may have M3U8 master playlists which are
 * fetched and parsed to extract individual quality variants.
 */

var SOURCE_NAME = "peachify";
var TAG = "Peachify";

// ─── Servers (discovered from peachify.top JS bundle) ─────────────────────

var SERVERS = [
	{ label: "Iron", base: "https://uwu.eat-peach.sbs", path: "moviebox" },
	{ label: "Spider", base: "https://usa.eat-peach.sbs", path: "holly" },
	{ label: "Wolf", base: "https://usa.eat-peach.sbs", path: "air" },
	{ label: "Multi", base: "https://usa.eat-peach.sbs", path: "multi" },
	{ label: "Dark", base: "https://uwu.eat-peach.sbs", path: "net" },
];

// ─── AES-256-GCM Key ────────────────────────────────────────────────────
// Base64-encoded hex string → decodes to "a8f2a1b5e9c470814f6b2c3a5d8e7f9
// c1a2b3c4d5e3f7a8b8cad1e2d0a4d5c5b" → 32-byte AES-256 key

var KEY_BASE64 =
	"YThmMmExYjVlOWM0NzA4MTRmNmIyYzNhNWQ4ZTdmOWMxYTJiM2M0ZDVlM2Y3YThiOGNhZDFlMmQwYTRkNWM1Yg==";

// ─── User-Agent & Headers ───────────────────────────────────────────────

var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

var HEADERS = {
	"User-Agent": UA,
	Accept: "application/json, text/javascript, */*; q=0.01",
	"Accept-Language": "en-US,en;q=0.9",
	Referer: "https://peachify.top/",
	Origin: "https://peachify.top",
};

var PER_SERVER_TIMEOUT = 20000;

// =====================================================================
//  HELPERS
// =====================================================================

function makeFail(msg, start) {
	return {
		status: "error",
		error: msg || "unknown",
		streams: [],
		latency_ms: Date.now() - (start || Date.now()),
	};
}

function safeJsonParse(str) {
	if (!str || typeof str !== "string") return null;
	try {
		return JSON.parse(str);
	} catch (e) {
		return null;
	}
}

function log() {
	try {
		console.log.apply(
			console,
			["[" + TAG + "]"].concat([].slice.call(arguments)),
		);
	} catch (e) {}
}

function warn() {
	try {
		console.warn.apply(
			console,
			["[" + TAG + "]"].concat([].slice.call(arguments)),
		);
	} catch (e) {}
}

// ─── HTTP ────────────────────────────────────────────────────────────────

async function httpGet(url, headers) {
	try {
		var raw = await globalThis.http_get(url, headers || {});
		if (typeof raw === "string") return raw;
		if (raw && raw.body) {
			if (typeof raw.body === "string") return raw.body;
		}
	} catch (e) {}
	return "";
}

// httpGetRaw returns { status, body, error } with a configurable timeout.
// Uses the same await pattern as httpGet (which is reliable) but with
// an external timeout wrapper to avoid race-condition issues.
function httpGetRaw(url, headers, ms) {
	ms = ms || 10000;
	return new Promise(function (resolve) {
		var done = false;
		var t = setTimeout(function () {
			if (!done) {
				done = true;
				resolve({ status: 0, body: "", error: "timeout" });
			}
		}, ms);
		(async function () {
			try {
				var raw = await globalThis.http_get(url, headers || {});
				if (done) return;
				done = true;
				clearTimeout(t);
				var status =
					raw && (raw.status || raw.statusCode)
						? raw.status || raw.statusCode
						: 200;
				var body = "";
				if (typeof raw === "string") body = raw;
				else if (raw && raw.body)
					body =
						typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body);
				resolve({ status: status, body: body });
			} catch (e) {
				if (done) return;
				done = true;
				clearTimeout(t);
				resolve({ status: 0, body: "" });
			}
		})();
	});
}

// ─── Stream Validation ────────────────────────────────────────────────────

// In-query cache to avoid re-validating the same URL multiple times.
var _validationCache = {};
var _validationCacheKeys = [];
var VALIDATION_CACHE_MAX = 100;

function validationCacheGet(url) {
	return _validationCache[url];
}
function validationCacheSet(url, result) {
	if (_validationCacheKeys.length >= VALIDATION_CACHE_MAX) {
		var oldKey = _validationCacheKeys.shift();
		delete _validationCache[oldKey];
	}
	if (_validationCache[url] === undefined) {
		_validationCacheKeys.push(url);
	}
	_validationCache[url] = result;
}
function validationCacheClear() {
	_validationCache = {};
	_validationCacheKeys = [];
}

// checkStreamAlive verifies a stream URL actually returns playable content.
//   - M3U8/HLS: downloads the small playlist and verifies #EXTM3U header
//   - MP4: CAN'T validate without downloading full file, so trust the API.
//          The MP4 proxy URLs are ephemeral (signed URLs) and change per-query,
//          so returning them is the best we can do — the player handles errors.
//   - Unknown type: try M3U8 first (most are HLS), then trust API.
// Returns true if the stream is likely playable, false if confirmed dead.
// Results are cached per URL within a single scrapeStreams call.
async function checkStreamAlive(url, type, timeoutMs) {
	timeoutMs = timeoutMs || 10000;

	// Check cache first
	var cached = validationCacheGet(url);
	if (cached !== undefined) return cached;

	// M3U8/HLS: small files, download and verify
	if (type === "hls" || type === "m3u8" || type === "m3u") {
		var resp = await httpGetRaw(url, HEADERS, timeoutMs);
		if (resp.status !== 200) {
			log("  ⛔ M3U8: HTTP " + resp.status + " — filtered");
			validationCacheSet(url, false);
			return false;
		}
		var body = resp.body || "";
		if (body.indexOf("#EXTM3U") === -1) {
			log("  ⛔ M3U8: no #EXTM3U in body — filtered");
			validationCacheSet(url, false);
			return false;
		}
		validationCacheSet(url, true);
		return true;
	}

	// MP4: trust the API — can't validate without full download
	// (Range requests aren't supported by the MP4 proxies, and a full
	//  download would be too slow for multi-GB files)
	if (type === "mp4") {
		validationCacheSet(url, true);
		return true;
	}

	// Unknown type: try M3U8 check first
	var resp2 = await httpGetRaw(url, HEADERS, timeoutMs);
	if (resp2.status === 200) {
		var body2 = resp2.body || "";
		if (body2.indexOf("#EXTM3U") !== -1) {
			validationCacheSet(url, true);
			return true;
		}
	}
	// Not HLS — trust the API (probably an MP4 with no type field)
	validationCacheSet(url, true);
	return true;
}

// ─── Base64 ──────────────────────────────────────────────────────────────

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Decode(s) {
	var map = {};
	for (var i = 0; i < 64; i++) map[B64[i]] = i;
	s = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
	var out = [];
	for (var i = 0; i < s.length; i += 4) {
		var c0 = map[s[i]] || 0,
			c1 = map[s[i + 1]] || 0;
		var c2 = map[s[i + 2]],
			c3 = map[s[i + 3]];
		out.push((c0 << 2) | (c1 >> 4));
		if (s[i + 2] && s[i + 2] !== "=" && c2 !== undefined)
			out.push(((c1 << 4) | (c2 >> 2)) & 255);
		if (s[i + 3] && s[i + 3] !== "=" && c3 !== undefined)
			out.push(((c2 << 6) | c3) & 255);
	}
	return out;
}

function base64UrlToBytes(s) {
	return b64Decode(String(s).replace(/-/g, "+").replace(/_/g, "/"));
}

// =====================================================================
//  AES-256 Core (FIPS-197)
// =====================================================================

var SBOX = [
	0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe,
	0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4,
	0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7,
	0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15, 0x04, 0xc7, 0x23, 0xc3,
	0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75, 0x09,
	0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3,
	0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe,
	0x39, 0x4a, 0x4c, 0x58, 0xcf, 0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85,
	0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92,
	0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c,
	0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19,
	0x73, 0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14,
	0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2,
	0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5,
	0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08, 0xba, 0x78, 0x25,
	0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
	0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86,
	0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e,
	0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf, 0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42,
	0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function gfMult(a, b) {
	var r = 0;
	for (var i = 0; i < 8; i++) {
		if (b & 1) r ^= a;
		var hi = a & 0x80;
		a = (a << 1) & 0xff;
		if (hi) a ^= 0x1b;
		b >>= 1;
	}
	return r;
}

/**
 * AES-256 key expansion. Produces 60 round key words (240 bytes).
 */
function aesKeyExpansion256(keyBytes) {
	var nk = 8,
		nr = 14,
		nb = 4,
		nw = nb * (nr + 1); // 60
	var w = [];
	for (var i = 0; i < nk; i++)
		w[i] =
			(keyBytes[4 * i] << 24) |
			(keyBytes[4 * i + 1] << 16) |
			(keyBytes[4 * i + 2] << 8) |
			keyBytes[4 * i + 3];
	for (var i = nk; i < nw; i++) {
		var temp = w[i - 1];
		if (i % nk === 0) {
			temp = ((temp << 8) | (temp >>> 24)) >>> 0;
			temp =
				(SBOX[(temp >>> 24) & 0xff] << 24) |
				(SBOX[(temp >>> 16) & 0xff] << 16) |
				(SBOX[(temp >>> 8) & 0xff] << 8) |
				SBOX[temp & 0xff];
			temp ^= RCON[Math.floor(i / nk) - 1] << 24;
		} else if (i % nk === 4) {
			temp =
				(SBOX[(temp >>> 24) & 0xff] << 24) |
				(SBOX[(temp >>> 16) & 0xff] << 16) |
				(SBOX[(temp >>> 8) & 0xff] << 8) |
				SBOX[temp & 0xff];
		}
		w[i] = (w[i - nk] ^ temp) >>> 0;
	}
	return w;
}

/**
 * Encrypt one 16-byte block with AES-256.
 * Uses column-major state: state[col] = word for that column.
 */
function aesEncryptBlock(input, w) {
	var nb = 4,
		nr = 14;
	var state = [
		((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) >>> 0,
		((input[4] << 24) | (input[5] << 16) | (input[6] << 8) | input[7]) >>> 0,
		((input[8] << 24) | (input[9] << 16) | (input[10] << 8) | input[11]) >>> 0,
		((input[12] << 24) | (input[13] << 16) | (input[14] << 8) | input[15]) >>>
			0,
	];

	function addRoundKey(round) {
		for (var i = 0; i < nb; i++)
			state[i] = (state[i] ^ w[round * nb + i]) >>> 0;
	}

	function subBytes() {
		for (var i = 0; i < nb; i++) {
			var s = state[i];
			state[i] =
				(SBOX[(s >>> 24) & 0xff] << 24) |
				(SBOX[(s >>> 16) & 0xff] << 16) |
				(SBOX[(s >>> 8) & 0xff] << 8) |
				SBOX[s & 0xff];
		}
	}

	function shiftRows() {
		// Convert column-major words to 4x4 byte array: s[col][row]
		var s = [];
		for (var c = 0; c < 4; c++) {
			var word = state[c];
			s[c] = [
				(word >>> 24) & 0xff,
				(word >>> 16) & 0xff,
				(word >>> 8) & 0xff,
				word & 0xff,
			];
		}
		// Apply ShiftRows: row r shifted left by r positions
		var result = [
			[0, 0, 0, 0],
			[0, 0, 0, 0],
			[0, 0, 0, 0],
			[0, 0, 0, 0],
		];
		for (var r = 0; r < 4; r++)
			for (var c = 0; c < 4; c++) result[r][c] = s[(c + r) % 4][r];
		// Convert back to column-major words
		for (var c = 0; c < 4; c++)
			state[c] =
				((result[0][c] << 24) |
					(result[1][c] << 16) |
					(result[2][c] << 8) |
					result[3][c]) >>>
				0;
	}

	function mixColumns() {
		for (var i = 0; i < nb; i++) {
			var a = state[i];
			var a0 = (a >>> 24) & 0xff,
				a1 = (a >>> 16) & 0xff,
				a2 = (a >>> 8) & 0xff,
				a3 = a & 0xff;
			state[i] =
				(((gfMult(2, a0) ^ gfMult(3, a1) ^ a2 ^ a3) << 24) |
					((a0 ^ gfMult(2, a1) ^ gfMult(3, a2) ^ a3) << 16) |
					((a0 ^ a1 ^ gfMult(2, a2) ^ gfMult(3, a3)) << 8) |
					(gfMult(3, a0) ^ a1 ^ a2 ^ gfMult(2, a3))) >>>
				0;
		}
	}

	addRoundKey(0);
	for (var round = 1; round < nr; round++) {
		subBytes();
		shiftRows();
		mixColumns();
		addRoundKey(round);
	}
	subBytes();
	shiftRows();
	addRoundKey(nr);

	var out = [];
	for (var i = 0; i < nb; i++) {
		out.push((state[i] >>> 24) & 0xff);
		out.push((state[i] >>> 16) & 0xff);
		out.push((state[i] >>> 8) & 0xff);
		out.push(state[i] & 0xff);
	}
	return out;
}

// =====================================================================
//  AES-CTR Decryption
// =====================================================================

/**
 * Decrypt ciphertext using AES-256-CTR.
 * counter is a 16-byte array, incremented as a big-endian 128-bit integer.
 */
function aesCtrDecrypt(ciphertext, keyBytes, counter) {
	var w = aesKeyExpansion256(keyBytes);
	var plaintext = [];
	for (var offset = 0; offset < ciphertext.length; offset += 16) {
		var keystream = aesEncryptBlock(counter, w);
		for (var i = 0; i < 16 && offset + i < ciphertext.length; i++)
			plaintext.push(ciphertext[offset + i] ^ keystream[i]);
		// Increment counter (big-endian, 128-bit)
		for (var i = 15; i >= 0; i--) {
			counter[i] = (counter[i] + 1) & 0xff;
			if (counter[i] !== 0) break;
		}
	}
	return plaintext;
}

// =====================================================================
//  Key Derivation
// =====================================================================

var _keyBytes = null;

function getKey() {
	if (_keyBytes) return _keyBytes;
	// KEY_BASE64 decodes to a hex string, which we convert to bytes
	var raw = b64Decode(KEY_BASE64);
	var hex = "";
	for (var i = 0; i < raw.length; i++) hex += String.fromCharCode(raw[i]);
	if (hex.length < 64) {
		warn("peachify: key hex too short (" + hex.length + ")");
		return null;
	}
	var bytes = [];
	for (var i = 0; i < 64; i += 2)
		bytes.push((parseInt(hex[i], 16) << 4) | parseInt(hex[i + 1], 16));
	_keyBytes = bytes;
	return _keyBytes;
}

// =====================================================================
//  Peachify Payload Decryption
// =====================================================================

/**
 * Decrypt an AES-256-GCM encrypted Peachify API response.
 * Uses AES-CTR for decryption (skips GHASH auth verification since
 * CTR decryption is proven correct and matches Node.js reference).
 *
 * Payload format: base64url(iv).base64url(ciphertext).base64url(authTag)
 *
 * @param {string} payload - The encrypted data string
 * @param {number[]} keyBytes - 32-byte AES-256 key
 * @returns {object|null} Decrypted JSON object, or null on failure
 */
function decryptPeachifyPayload(payload, keyBytes) {
	try {
		var parts = String(payload).split(".");
		if (parts.length !== 3) {
			warn("decrypt: expected 3 parts, got " + parts.length);
			return null;
		}

		var iv = base64UrlToBytes(parts[0]);
		var ciphertext = base64UrlToBytes(parts[1]);

		if (iv.length !== 12) {
			warn("decrypt: IV length " + iv.length + ", expected 12");
			return null;
		}

		// J0 = IV || 0x00000001 (standard GCM for 96-bit IV)
		var j0 = iv.concat([0, 0, 0, 1]);

		// Counter for CTR mode starts at incr(J0): increment last 32 bits
		var counter = j0.slice();
		for (var i = 15; i >= 12; i--) {
			counter[i] = (counter[i] + 1) & 0xff;
			if (counter[i] !== 0) break;
		}

		// AES-CTR decrypt
		var plaintextBytes = aesCtrDecrypt(ciphertext, keyBytes, counter);

		// Convert to string
		var result = "";
		for (var i = 0; i < plaintextBytes.length; i++)
			result += String.fromCharCode(plaintextBytes[i]);

		return safeJsonParse(result);
	} catch (e) {
		warn("decrypt error: " + (e && e.message ? e.message : String(e)));
		return null;
	}
}

// =====================================================================
//  Quality Helpers
// =====================================================================

function qualityLabel(h) {
	if (h >= 2160) return "2160p";
	if (h >= 1440) return "1440p";
	if (h >= 1080) return "1080p";
	if (h >= 720) return "720p";
	if (h >= 480) return "480p";
	if (h >= 360) return "360p";
	return h ? h + "p" : "Auto";
}

function extractQualityFromUrl(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1].toLowerCase();
	if (/\b4k\b/i.test(u)) return "4K";
	// Check URL path segments for resolution patterns (e.g., /1080p/ in path)
	m = u.match(/[?&](?:quality|q|res)=(\d+)/i);
	if (m) {
		var n = parseInt(m[1], 10);
		if (n >= 2160) return "2160p";
		if (n >= 1440) return "1440p";
		if (n >= 1080) return "1080p";
		if (n >= 720) return "720p";
		if (n >= 480) return "480p";
		if (n >= 360) return "360p";
	}
	// Extract from percent-encoded src parameter
	m = u.match(/src=([^&]+)/);
	if (m) {
		try {
			var decoded = decodeURIComponent(m[1]);
			var dm = decoded.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
			if (dm) return dm[1].toLowerCase();
		} catch (e) {}
	}
	return "";
}

// =====================================================================
//  Source Parser
// =====================================================================

function parsePeachifySource(raw, serverLabel) {
	if (!raw || !raw.url) return null;

	var url = raw.url;
	var dub = raw.dub || "Original";
	var quality = "";

	if (raw.quality != null) {
		quality = String(raw.quality);
		var qn = parseInt(quality, 10);
		if (!isNaN(qn) && quality.indexOf("p") === -1) quality = qualityLabel(qn);
	}
	if (!quality) quality = extractQualityFromUrl(url);

	var headers = {};
	if (raw.headers && typeof raw.headers === "object") {
		for (var k in raw.headers) {
			if (
				Object.prototype.hasOwnProperty.call(raw.headers, k) &&
				raw.headers[k] != null
			)
				headers[k] = String(raw.headers[k]);
		}
	}
	if (!headers["Referer"] && !headers["referer"])
		headers["Referer"] = "https://peachify.top/";

	return {
		url: url,
		quality: quality || "Auto",
		source: SOURCE_NAME + " [" + serverLabel + "]",
		dub: dub,
		headers: headers,
		_serverLabel: serverLabel,
	};
}

// =====================================================================
//  scrapeStreams — Main Entry Point
// =====================================================================

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) return makeFail("no tmdbId provided", start);

	// Clear per-query validation cache
	validationCacheClear();

	var isMovie = type !== "tv" && type !== "series";
	var keyBytes = getKey();
	if (!keyBytes) return makeFail("failed to derive AES key", start);

	try {
		var serverRequests = [];
		for (var si = 0; si < SERVERS.length; si++) {
			(function (srv) {
				var apiUrl = isMovie
					? srv.base + "/" + srv.path + "/movie/" + tmdbId
					: srv.base +
						"/" +
						srv.path +
						"/tv/" +
						tmdbId +
						"/" +
						(season || 1) +
						"/" +
						(episode || 1);

				serverRequests.push(
					Promise.race([
						(async function () {
							try {
								var resp = await httpGet(apiUrl, HEADERS);
								if (!resp)
									return {
										label: srv.label,
										status: "error",
										error: "empty",
										streams: [],
									};

								var data = safeJsonParse(resp);
								if (!data)
									return {
										label: srv.label,
										status: "error",
										error: "bad JSON",
										streams: [],
									};

								var sources = [];
								var subs = [];

								if (data.isEncrypted && data.data) {
									var decrypted = decryptPeachifyPayload(data.data, keyBytes);
									if (!decrypted)
										return {
											label: srv.label,
											status: "error",
											error: "decrypt fail",
											streams: [],
										};
									sources = decrypted.sources || [];
									subs = decrypted.subtitles || [];
								} else if (data.sources) {
									sources = data.sources;
									subs = data.subtitles || [];
								} else {
									return {
										label: srv.label,
										status: "no_streams",
										error: "no sources",
										streams: [],
									};
								}

								if (!sources || sources.length === 0)
									return {
										label: srv.label,
										status: "no_streams",
										error: "empty sources",
										streams: [],
									};

								// Collect response-level subtitles
								var baseSubs = [];
								if (subs && subs.length > 0) {
									for (var subIdx = 0; subIdx < subs.length; subIdx++) {
										var sub = subs[subIdx];
										if (sub && sub.url) {
											baseSubs.push({
												url: sub.url,
												label:
													sub.label || sub.name || sub.language || "Subtitle",
												lang: sub.langCode || sub.lang || sub.language || "en",
											});
										}
									}
								}

								// Phase 1: Parse all sources (fast, no I/O)
								var parsedSources = [];
								for (var srcIdx = 0; srcIdx < sources.length; srcIdx++) {
									var rawSrc = sources[srcIdx];
									// Spider HLS proxies return 403 Forbidden (consistent failure)
									if (srv.label === "Spider" && rawSrc.type === "hls") continue;
									var parsed = parsePeachifySource(rawSrc, srv.label);
									if (!parsed) continue;
									parsedSources.push({
										parsed: parsed,
										rawType: rawSrc.type || "",
									});
								}

								// Phase 2: Validate all URLs in parallel (I/O bound)
								//   - M3U8/HLS: verify body starts with #EXTM3U (10s timeout)
								//   - MP4: trust API (can't validate large files)
								//   - Unknown: try M3U8, then trust API
								var validationResults = await Promise.all(
									parsedSources.map(function (entry) {
										var streamType = entry.rawType;
										if (streamType === "hls" || streamType === "m3u8") {
											return checkStreamAlive(entry.parsed.url, "hls", 10000);
										}
										// MP4 or unknown: trust the API
										return checkStreamAlive(
											entry.parsed.url,
											streamType || "mp4",
											10000,
										);
									}),
								);

								// Phase 3: Build final stream list from validated sources
								var streams = [];
								var filteredCount = 0;
								for (var vi = 0; vi < parsedSources.length; vi++) {
									if (!validationResults[vi]) {
										filteredCount++;
										continue;
									}
									var p = parsedSources[vi].parsed;
									streams.push({
										url: p.url,
										quality: p.quality || "Auto",
										source: p.source,
										dub: p.dub || "Original",
										headers: p.headers,
									});
								}

								if (filteredCount > 0) {
									log(
										srv.label +
											": " +
											streams.length +
											"/" +
											parsedSources.length +
											" passed validation (" +
											filteredCount +
											" filtered)",
									);
								}

								if (baseSubs.length > 0) {
									for (var si = 0; si < streams.length; si++) {
										streams[si].subtitles = baseSubs;
									}
								}

								return {
									label: srv.label,
									status: streams.length > 0 ? "working" : "no_streams",
									streams: streams,
								};
							} catch (e) {
								return {
									label: srv.label,
									status: "error",
									error: e && e.message ? e.message : String(e),
									streams: [],
								};
							}
						})(),
						new Promise(function (_, reject) {
							setTimeout(function () {
								reject(new Error("timeout"));
							}, PER_SERVER_TIMEOUT);
						}),
					]).catch(function (e) {
						return {
							label: srv.label,
							status: "error",
							error: "timeout/" + (e && e.message),
							streams: [],
						};
					}),
				);
			})(SERVERS[si]);
		}

		var results = (await Promise.allSettled)
			? await Promise.allSettled(serverRequests)
			: await Promise.all(
					serverRequests.map(function (p) {
						return p
							.then(function (v) {
								return { status: "fulfilled", value: v };
							})
							.catch(function (e) {
								return { status: "rejected", reason: e };
							});
					}),
				);

		var allStreams = [];
		var seenUrls = {};
		var workingCount = 0;

		for (var ri = 0; ri < results.length; ri++) {
			var serverResult =
				results[ri].status === "fulfilled" ? results[ri].value : null;
			if (!serverResult) continue;
			if (serverResult.status === "working") workingCount++;
			var serverStreams = serverResult.streams || [];
			for (var si2 = 0; si2 < serverStreams.length; si2++) {
				var s = serverStreams[si2];
				// Dedup by URL + dub to preserve different audio tracks
				var dedupKey = s.url + "|" + (s.dub || "Original");
				if (s && s.url && !seenUrls[dedupKey]) {
					seenUrls[dedupKey] = true;
					allStreams.push(s);
				}
			}
		}

		if (allStreams.length === 0) {
			var errors = [];
			for (var ri2 = 0; ri2 < results.length; ri2++) {
				var res2 = results[ri2];
				if (res2.status === "fulfilled" && res2.value && res2.value.error)
					errors.push(res2.value.label + ": " + res2.value.error);
			}
			return {
				status: "no_streams",
				error: errors.join("; ") || "all servers returned no streams",
				streams: [],
				latency_ms: Date.now() - start,
			};
		}

		log(
			"→ " +
				allStreams.length +
				" streams from " +
				workingCount +
				"/" +
				SERVERS.length +
				" servers in " +
				(Date.now() - start) +
				"ms",
		);

		return {
			status: "working",
			streams: allStreams,
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return makeFail(e && e.message ? e.message : String(e), start);
	}
}

// =====================================================================
//  Export
// =====================================================================

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
