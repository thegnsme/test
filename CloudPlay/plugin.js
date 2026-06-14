/**
 * CloudPlay SkyStream Plugin
 * Live sports and TV channels with quality selection
 *
 * Architecture:
 * - Fetches encrypted payload from CloudPlay API
 * - Decrypts using AES-CBC with precomputed SHA-256 derived key
 * - Parses M3U8/MPD/JSON channel formats
 * - Implements quality selection by parsing HLS master playlists
 */

(function () {
	"use strict";

	// ═══════════════════════════════════════════════════════════════════════════
	// Constants & Configuration
	// ═══════════════════════════════════════════════════════════════════════════

	const CLOUDPLAY_API_PATH = "/app.php";
	const CLOUDPLAY_PACKAGE = "com.cloudplay.app";

	const API_HEADERS = {
		Connection: "Keep-Alive",
		"User-Agent": "okhttp/4.12.0",
		"X-Package": CLOUDPLAY_PACKAGE,
	};

	const HEADERS = {
		accept: "*/*",
		"Cache-Control": "no-cache, no-store",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; rv:78.0) Gecko/20100101 Firefox/78.0",
	};

	// ═══════════════════════════════════════════════════════════════════════════
	// Utility Helpers
	// ═══════════════════════════════════════════════════════════════════════════

	function clean(value) {
		return String(value || "").trim();
	}

	function parseJsonSafe(text, fallback) {
		try {
			return JSON.parse(text);
		} catch (_) {
			return fallback;
		}
	}

	function extractResponseBody(response) {
		if (!response) return "";
		if (typeof response === "string") return response;
		if (response && typeof response.body === "string") return response.body;
		return "";
	}

	function extractResponseStatus(response) {
		if (!response) return 200;
		return response && typeof response.status !== "undefined"
			? response.status
			: 200;
	}

	function base64DecodeBytes(value) {
		let normalized = String(value || "")
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		while (normalized.length % 4) normalized += "=";
		try {
			if (typeof Buffer !== "undefined") {
				return new Uint8Array(Buffer.from(normalized, "base64"));
			}
		} catch (_) {}
		const decoded = typeof atob === "function" ? atob(normalized) : "";
		const bytes = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) {
			bytes[i] = decoded.charCodeAt(i) & 255;
		}
		return bytes;
	}

	function bytesToUtf8(bytes) {
		if (!bytes || !bytes.length) return "";
		if (typeof TextDecoder !== "undefined") {
			return new TextDecoder().decode(bytes);
		}
		let out = "";
		for (let i = 0; i < bytes.length; i++) {
			out += String.fromCharCode(bytes[i]);
		}
		try {
			return decodeURIComponent(escape(out));
		} catch (_) {
			return out;
		}
	}

	function stripPkcs7(bytes) {
		if (!bytes || !bytes.length) return bytes || new Uint8Array(0);
		const pad = bytes[bytes.length - 1];
		if (!pad || pad > 16 || pad > bytes.length) return bytes;
		for (let i = bytes.length - pad; i < bytes.length; i++) {
			if (bytes[i] !== pad) return bytes;
		}
		return bytes.slice(0, bytes.length - pad);
	}

	function normalizeHeaderName(key) {
		if (!key) return "";
		const lowered = clean(key).toLowerCase();
		if (lowered === "user-agent") return "User-Agent";
		if (lowered === "referer" || lowered === "referrer") return "Referer";
		if (lowered === "origin") return "Origin";
		if (lowered === "cookie") return "Cookie";
		return clean(key);
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// AES Decryption
	// ═══════════════════════════════════════════════════════════════════════════

	async function decryptAesCbc(dataB64, keyB64, ivB64) {
		try {
			if (
				globalThis.crypto &&
				typeof globalThis.crypto.decryptAES === "function"
			) {
				const decrypted = await globalThis.crypto.decryptAES(
					dataB64,
					keyB64,
					ivB64,
				);
				if (clean(decrypted)) return clean(decrypted);
			}
		} catch (_) {}

		try {
			if (globalThis.crypto && globalThis.crypto.subtle) {
				const keyBytes = base64DecodeBytes(keyB64);
				const ivBytes = base64DecodeBytes(ivB64);
				const dataBytes = base64DecodeBytes(dataB64);
				const imported = await globalThis.crypto.subtle.importKey(
					"raw",
					keyBytes,
					{ name: "AES-CBC" },
					false,
					["decrypt"],
				);
				const plain = new Uint8Array(
					await globalThis.crypto.subtle.decrypt(
						{ name: "AES-CBC", iv: ivBytes },
						imported,
						dataBytes,
					),
				);
				return clean(bytesToUtf8(stripPkcs7(plain)));
			}
		} catch (_) {}

		return "";
	}

	/**
	 * Decrypt CloudPlay payload using precomputed SHA-256 derived key
	 * Key = SHA-256("backup-update-3.3com.cloudplay.app")
	 */
	async function decryptPayload(payloadBase64, ivBase64) {
		const keyB64 = "i/qehOvBjqn9SUK1lgtmSh7Dn8hWjTYMy0mAMH8smww=";
		const decrypted = await decryptAesCbc(payloadBase64, keyB64, ivBase64);
		if (!decrypted) {
			throw new Error("Failed to decrypt CloudPlay payload");
		}
		return decrypted;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// HTTP Helpers
	// ═══════════════════════════════════════════════════════════════════════════

	async function fetchText(url, headers) {
		if (!url || typeof url !== "string") {
			throw new Error("Invalid URL for fetchText");
		}
		try {
			if (typeof http_get === "function") {
				return http_get(url, headers || {});
			}
			if (typeof fetch === "function") {
				const response = await fetch(url, { headers: headers || {} });
				return {
					status: response.status,
					body: await response.text(),
				};
			}
			throw new Error("GET requests are not supported in this runtime");
		} catch (error) {
			console.error(`Failed to fetch text from ${url}: ${error.message}`);
			throw error;
		}
	}

	function splitUrlAndHeaders(rawUrl) {
		const value = clean(rawUrl);
		const result = {
			url: value,
			headers: {},
			userAgent: "",
			cookie: "",
		};

		if (!value || !value.includes("|")) {
			return result;
		}

		const parts = value.split("|", 2);
		result.url = clean(parts[0]);
		clean(parts[1] || "")
			.split("&")
			.forEach((pair) => {
				const equalsIndex = pair.indexOf("=");
				if (equalsIndex === -1) return;
				const rawKey = clean(pair.slice(0, equalsIndex));
				if (!rawKey) return;
				let rawValue = clean(pair.slice(equalsIndex + 1));
				try {
					rawValue = decodeURIComponent(rawValue);
				} catch (_) {}
				const key = normalizeHeaderName(rawKey);
				if (!key) return;
				result.headers[key] = rawValue;
				if (key === "User-Agent") result.userAgent = rawValue;
				if (key === "Cookie") result.cookie = rawValue;
			});
		return result;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// M3U Parser
	// ═══════════════════════════════════════════════════════════════════════════

	function parseM3U(content) {
		const lines = String(content || "").split(/\r?\n/);
		const channels = [];
		let cur = null;
		let pending = {
			headers: {},
			userAgent: "",
			cookie: "",
			keyHex: "",
			kidHex: "",
			licenseUrl: "",
		};

		function resetPending() {
			pending = {
				headers: {},
				userAgent: "",
				cookie: "",
				keyHex: "",
				kidHex: "",
				licenseUrl: "",
			};
		}

		lines.forEach(function (raw) {
			const line = raw.trim();
			if (!line) return;

			if (line.startsWith("#EXTINF")) {
				let title = "Unknown",
					lastComma = -1,
					inQ = false;
				for (let i = 0; i < line.length; i++) {
					if (line[i] === '"') inQ = !inQ;
					else if (line[i] === "," && !inQ) lastComma = i;
				}

				let keyAttr = null,
					kidAttr = null;
				const attrPart = lastComma !== -1 ? line.substring(0, lastComma) : line;
				const attrRegex = /([\w-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
				let match;
				while ((match = attrRegex.exec(attrPart)) !== null) {
					const k = match[1].toLowerCase();
					const v = match[2] || match[3] || "";
					if (k === "key" || k === "drm-key") keyAttr = v;
					if (k === "keyid" || k === "drm-keyid" || k === "kid") kidAttr = v;
				}

				if (lastComma !== -1)
					title = line
						.substring(lastComma + 1)
						.trim()
						.replace(/^"|"$/g, "");
				const g = line.match(/group-title="([^"]*)"/);
				const l = line.match(/tvg-logo="([^"]*)"/);
				cur = {
					title,
					group: g ? g[1] : "Uncategorized",
					poster: l ? l[1] : "",
					headers: Object.assign({}, pending.headers),
					userAgent: pending.userAgent,
					cookie: pending.cookie,
					keyHex: pending.keyHex || keyAttr || "",
					kidHex: pending.kidHex || kidAttr || "",
					licenseUrl: pending.licenseUrl,
				};
				resetPending();
				return;
			}

			if (line.startsWith("#EXTHTTP:")) {
				const o = parseJsonSafe(line.replace(/^#EXTHTTP:/i, ""), {});
				const tgt = cur || pending;
				if (o.cookie) tgt.cookie = o.cookie;
				if (o["user-agent"]) tgt.userAgent = o["user-agent"];
				return;
			}

			if (line.startsWith("#EXTVLCOPT:")) {
				const ua = line.match(/http-user-agent=(.*)$/i);
				const rf =
					line.match(/http-referrer=(.*)$/i) ||
					line.match(/http-referer=(.*)$/i);
				const tgt = cur || pending;
				if (ua && ua[1]) tgt.userAgent = ua[1].replace(/"/g, "").trim();
				if (rf && rf[1])
					(cur ? cur.headers : pending.headers)["Referer"] = rf[1]
						.replace(/"/g, "")
						.trim();
				return;
			}

			if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
				const v = line
					.replace(/^#KODIPROP:inputstream\.adaptive\.license_key=/i, "")
					.trim();
				const tgt = cur || pending;
				if (/^https?:\/\//i.test(v)) {
					tgt.licenseUrl = v;
				} else if (v.includes(":") || v.includes(",")) {
					const sep = v.includes(":") ? ":" : ",";
					const idx = v.indexOf(sep);
					tgt.kidHex = clean(v.slice(0, idx));
					tgt.keyHex = clean(v.slice(idx + 1));
				}
				return;
			}

			if (!line.startsWith("#") && cur) {
				let url = line;
				const parts = line.split("|");
				const headers = Object.assign({}, cur.headers);

				if (parts.length > 1) {
					url = parts[0];
					parts
						.slice(1)
						.join("|")
						.split("&")
						.forEach(function (kv) {
							const i = kv.indexOf("=");
							if (i < 0) return;
							const k = kv.slice(0, i).trim();
							const v = kv.slice(i + 1).trim();
							if (!k) return;
							const lk = k.toLowerCase();
							if (lk === "referer" || lk === "referrer") headers["Referer"] = v;
							else if (lk === "origin") headers["Origin"] = v;
							else if (lk === "user-agent") headers["User-Agent"] = v;
							else if (lk === "cookie") headers["Cookie"] = v;
							else if (lk === "key") cur.keyHex = v;
							else if (lk === "keyid" || lk === "kid") cur.kidHex = v;
							else if (lk === "licenseurl") cur.licenseUrl = v;
							else headers[k] = v;
						});
				}

				channels.push({
					title: cur.title,
					group: cur.group,
					poster: cur.poster,
					url,
					headers,
					userAgent: cur.userAgent,
					cookie: cur.cookie,
					keyHex: cur.keyHex,
					kidHex: cur.kidHex,
					licenseUrl: cur.licenseUrl,
				});
				cur = null;
			}
		});
		return channels;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// DRM Helpers
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Normalize any DRM identifier to lowercase hex
	 * Accepts: hex with dashes, pure hex, or base64url
	 */
	function normalizeDrmHex(v) {
		const s = clean(v);
		if (!s || s.toLowerCase() === "null") return null;
		const hex = s.replace(/-/g, "");
		if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0)
			return hex.toLowerCase();
		return base64ToHex(s);
	}

	function base64ToHex(str) {
		if (!str) return null;
		try {
			const s = clean(str).replace(/-/g, "+").replace(/_/g, "/");
			const p = s + "=".repeat((4 - (s.length % 4)) % 4);
			const raw = atob(p);
			var hex = "";
			for (let i = 0; i < raw.length; i++) {
				var h = raw.charCodeAt(i).toString(16);
				hex += h.length === 2 ? h : "0" + h;
			}
			return hex.toLowerCase();
		} catch (_) {
			return null;
		}
	}

	function hexToBase64Url(hex) {
		if (!hex) return null;
		try {
			const normalized = clean(hex).replace(/-/g, "");
			var raw = "";
			for (let i = 0; i < normalized.length; i += 2)
				raw += String.fromCharCode(parseInt(normalized.substr(i, 2), 16));
			return btoa(raw)
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		} catch (_) {
			return null;
		}
	}

	/**
	 * Parse key/kid from a license URL like:
	 *   https://dummy.com/?keyid=KID_HEX&key=KEY_HEX
	 * Returns { keyHex, kidHex } or null
	 */
	function parseKeyIdFromLicenseUrl(licenseUrl) {
		const url = clean(licenseUrl);
		if (!url) return null;
		const kidMatch = url.match(/[?&]keyid=([^&]+)/i);
		const keyMatch = url.match(/[?&]key=([^&]+)/i);
		if (kidMatch && keyMatch) {
			const kidHex = normalizeDrmHex(decodeURIComponent(kidMatch[1]));
			const keyHex = normalizeDrmHex(decodeURIComponent(keyMatch[1]));
			if (kidHex && keyHex) return { keyHex: keyHex, kidHex: kidHex };
		}
		return null;
	}

	/**
	 * Resolve ClearKey from a license server URL
	 * 1. Fetch MPD manifest to extract cenc:default_KID
	 * 2. Call license server with the KID (base64url)
	 * 3. Return key in hex
	 */
	async function resolveClearKey(mpdUrl, licenseUrl, mpdHeaders) {
		try {
			const response = await fetchText(mpdUrl, mpdHeaders || {});
			if (
				extractResponseStatus(response) < 200 ||
				extractResponseStatus(response) >= 300
			)
				return null;

			const body = extractResponseBody(response);
			const kidMatch = body.match(/cenc:default_KID=["']([^"']+)["']/i);
			if (!kidMatch) return null;

			const kidHex = kidMatch[1].replace(/-/g, "").toLowerCase();
			const kidB64 = hexToBase64Url(kidHex);
			if (!kidB64) return null;

			const lRes = await postJson(
				licenseUrl,
				{ kids: [kidB64], type: "temporary" },
				{
					"User-Agent": "Dalvik/2.1.0 (Linux; U; Android)",
					"Content-Type": "application/json;charset=UTF-8",
				},
			);

			const lData = parseJsonSafe(extractResponseBody(lRes), {});
			const keys = Array.isArray(lData.keys) ? lData.keys : [];
			if (keys.length > 0 && keys[0].k) {
				const keyHex = base64ToHex(keys[0].k);
				if (keyHex) {
					return {
						drmKey: keyHex,
						drmKid: kidHex,
						licenseUrl: licenseUrl,
					};
				}
			}
		} catch (_) {}
		return null;
	}

	/**
	 * POST JSON helper (for license server calls)
	 */
	async function postJson(url, payload, headers) {
		if (!url || typeof url !== "string") {
			throw new Error("Invalid URL for postJson");
		}
		if (!payload || typeof payload !== "object") {
			throw new Error("Invalid payload for postJson");
		}
		const body = JSON.stringify(payload);
		try {
			if (typeof http_post === "function") {
				return http_post(url, headers || {}, body);
			}
			if (typeof fetch === "function") {
				const response = await fetch(url, {
					method: "POST",
					headers: headers || {},
					body: body,
				});
				return {
					status: response.status,
					body: await response.text(),
				};
			}
			throw new Error("POST requests are not supported in this runtime");
		} catch (error) {
			console.error("Failed to POST to " + url + ": " + error.message);
			throw error;
		}
	}

	function isDashManifest(url) {
		return clean(url).toLowerCase().includes(".mpd");
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// CloudPlay API
	// ═══════════════════════════════════════════════════════════════════════════

	async function fetchCloudPlayStreams() {
		const baseUrl = clean(manifest.baseUrl);
		const url = baseUrl + CLOUDPLAY_API_PATH;

		const response = await fetchText(url, API_HEADERS);
		if (
			extractResponseStatus(response) < 200 ||
			extractResponseStatus(response) >= 300
		) {
			throw new Error(
				"Failed to fetch CloudPlay config: HTTP " +
					extractResponseStatus(response),
			);
		}

		const body = extractResponseBody(response);
		const config = parseJsonSafe(body, null);
		if (!config || !config.payload || !config.iv) {
			throw new Error("Invalid CloudPlay config format");
		}

		const decryptedJson = await decryptPayload(config.payload, config.iv);
		const data = parseJsonSafe(decryptedJson, null);
		if (!data || !data.streams) {
			throw new Error("Invalid CloudPlay streams data");
		}

		return data.streams;
	}

	/**
	 * Fetch channels from a stream URL
	 * Handles: M3U, CloudPlayChannel JSON (m3u8_url/mpd_url), CloudPlayStream JSON (recursive)
	 */
	async function fetchChannels(url, fallbackLogo) {
		const channels = [];
		const request = splitUrlAndHeaders(url);
		const isHost = url.includes("host.cloudplay.me");
		const headers = isHost ? API_HEADERS : HEADERS;

		const response = await fetchText(request.url, headers);
		if (
			extractResponseStatus(response) < 200 ||
			extractResponseStatus(response) >= 300
		) {
			return channels;
		}

		const body = extractResponseBody(response);
		if (!body || !body.trim()) return channels;

		// Try M3U format
		if (body.trim().startsWith("#EXTM3U")) {
			const m3uChannels = parseM3U(body);
			return m3uChannels.map(function (ch) {
				return {
					title: ch.title || "Unknown",
					url: ch.url,
					poster: ch.poster || fallbackLogo || "",
					group: ch.group || "Channels",
					headers: ch.headers,
					keyHex: ch.keyHex,
					kidHex: ch.kidHex,
					licenseUrl: ch.licenseUrl,
				};
			});
		}

		// Try JSON array
		try {
			const jsonChannels = parseJsonSafe(body, null);
			if (Array.isArray(jsonChannels) && jsonChannels.length > 0) {
				// CloudPlayChannel objects (has m3u8_url or mpd_url)
				if (jsonChannels[0].m3u8_url || jsonChannels[0].mpd_url) {
					return jsonChannels
						.map(function (ch) {
							return {
								title: ch.name || "Unknown",
								url: ch.m3u8_url || ch.mpd_url || "",
								poster: ch.logo || fallbackLogo || "",
								group: ch.group || "Channels",
								headers: ch.headers || {},
								keyHex: "",
								kidHex: "",
								licenseUrl: ch.license_url || "",
							};
						})
						.filter(function (ch) {
							return ch.url;
						});
				}

				// CloudPlayStream objects (has url, needs recursive fetch)
				if (
					jsonChannels[0].url &&
					!jsonChannels[0].m3u8_url &&
					!jsonChannels[0].mpd_url
				) {
					const nestedChannels = [];
					for (const stream of jsonChannels) {
						const subChannels = await fetchChannels(
							stream.url,
							stream.logo || fallbackLogo,
						);
						nestedChannels.push(...subChannels);
					}
					return nestedChannels;
				}
			}
		} catch (_) {}

		return channels;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Core SkyStream API Functions
	// ═══════════════════════════════════════════════════════════════════════════

	async function getHome(cb) {
		try {
			const streams = await fetchCloudPlayStreams();
			const data = {};

			for (const stream of streams) {
				const categoryName = stream.name || "Unknown";
				const channels = await fetchChannels(stream.url, stream.logo);

				if (channels.length > 0) {
					data[categoryName] = channels.map(function (ch) {
						return new MultimediaItem({
							title: ch.title,
							posterUrl: ch.poster,
							type: "livestream",
							description: ch.group || categoryName,
							url: JSON.stringify({
								kind: "channel",
								channel: ch,
								category: categoryName,
							}),
						});
					});
				}
			}

			cb({ success: true, data: data });
		} catch (error) {
			console.error("[CloudPlay] getHome error:", error.message);
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: error.message,
			});
		}
	}

	async function load(url, cb) {
		try {
			const payload = parseJsonSafe(url, null);
			if (!payload) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid payload",
				});
			}

			if (payload.kind === "channel") {
				const ch = payload.channel;
				const category = payload.category || "Live TV";

				cb({
					success: true,
					data: new MultimediaItem({
						title: ch.title || "Unknown Channel",
						url: url,
						posterUrl: ch.poster || "",
						description: ch.group || category,
						type: "livestream",
						episodes: [
							new Episode({
								name: "Watch Live",
								season: 1,
								episode: 1,
								url: url,
								posterUrl: ch.poster || "",
							}),
						],
					}),
				});
			} else {
				cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Unknown payload kind",
				});
			}
		} catch (error) {
			console.error("[CloudPlay] load error:", error.message);
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: error.message,
			});
		}
	}

	async function search(query, cb) {
		try {
			const q = String(query || "").toLowerCase();
			if (!q) {
				return cb({ success: true, data: [] });
			}

			const streams = await fetchCloudPlayStreams();
			const allChannels = [];

			for (const stream of streams) {
				const channels = await fetchChannels(stream.url, stream.logo);
				allChannels.push(...channels);
			}

			const results = allChannels.filter(function (ch) {
				const title = clean(ch.title).toLowerCase();
				const group = clean(ch.group).toLowerCase();
				return title.includes(q) || group.includes(q);
			});

			const items = results.map(function (ch) {
				return new MultimediaItem({
					title: ch.title,
					posterUrl: ch.poster,
					type: "livestream",
					description: ch.group || "Live TV",
					url: JSON.stringify({
						kind: "channel",
						channel: ch,
						category: ch.group || "Live TV",
					}),
				});
			});

			cb({ success: true, data: items });
		} catch (error) {
			console.error("[CloudPlay] search error:", error.message);
			cb({ success: true, data: [] });
		}
	}

	async function loadStreams(url, cb) {
		try {
			const payload = parseJsonSafe(url, null);
			if (!payload) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Invalid stream payload",
				});
			}

			if (payload.kind !== "channel") {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Unsupported payload kind",
				});
			}

			const ch = payload.channel || {};
			const streamUrl = ch.url;
			const headers = Object.assign({}, ch.headers || {});
			if (ch.userAgent) headers["User-Agent"] = ch.userAgent;
			if (ch.cookie) headers["Cookie"] = ch.cookie;
			const sourceLabel = payload.category || ch.title || "CloudPlay";

			if (!streamUrl) {
				return cb({
					success: false,
					errorCode: "NO_STREAM",
					message: "No stream URL found",
				});
			}

			// Create a single StreamResult (the player handles quality selection from the manifest)
			const r = new StreamResult({
				url: streamUrl,
				source: sourceLabel,
				headers: headers,
			});

			// Handle DRM for DASH streams
			if (isDashManifest(streamUrl)) {
				// First try: direct key/kid from channel metadata
				var keyHex = normalizeDrmHex(ch.keyHex);
				var kidHex = normalizeDrmHex(ch.kidHex);

				// Second try: parse key/kid from license_url like "?keyid=HEX&key=HEX"
				if (!keyHex || !kidHex) {
					var parsedKeys = parseKeyIdFromLicenseUrl(ch.licenseUrl);
					if (parsedKeys) {
						keyHex = parsedKeys.keyHex;
						kidHex = parsedKeys.kidHex;
					}
				}

				if (keyHex && kidHex) {
					r.drmKey = keyHex;
					r.drmKid = kidHex;
				} else if (ch.licenseUrl) {
					// License server URL: fetch MPD to get KID, call license server
					var resolved = await resolveClearKey(
						streamUrl,
						ch.licenseUrl,
						headers,
					);
					if (resolved) {
						r.drmKey = resolved.drmKey;
						r.drmKid = resolved.drmKid;
						r.licenseUrl = resolved.licenseUrl;
					} else {
						r.licenseUrl = ch.licenseUrl;
					}
				}
			}

			cb({ success: true, data: [r] });
		} catch (error) {
			console.error("[CloudPlay] loadStreams error:", error.message);
			cb({
				success: false,
				errorCode: "STREAM_ERROR",
				message: error.message,
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Export to SkyStream Runtime
	// ═══════════════════════════════════════════════════════════════════════════

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
