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

	// ═══════════════════════════════════════════════════════════════════════════
	// Channel Cache — shared between getHome, search, and load
	// ═══════════════════════════════════════════════════════════════════════════

	var CHANNEL_CACHE = null;
	var CACHE_EXPIRY = 0;
	var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	function getCachedChannels() {
		if (CHANNEL_CACHE && Date.now() < CACHE_EXPIRY) {
			return CHANNEL_CACHE;
		}
		return null;
	}

	function setCachedChannels(channels) {
		CHANNEL_CACHE = channels;
		CACHE_EXPIRY = Date.now() + CACHE_TTL_MS;
	}

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

	const FETCH_TIMEOUT_MS = 8000;
	const FETCH_TIMEOUT_MS_STREAM = 15000;

	async function fetchText(url, headers, timeoutMs) {
		if (!url || typeof url !== "string") {
			throw new Error("Invalid URL for fetchText");
		}
		timeoutMs = typeof timeoutMs === "number" ? timeoutMs : FETCH_TIMEOUT_MS;
		try {
			if (typeof http_get === "function") {
				return http_get(url, headers || {});
			}
			if (typeof fetch === "function") {
				var controller = new AbortController();
				var timer = setTimeout(function () {
					controller.abort();
				}, timeoutMs);
				try {
					var response = await fetch(url, {
						headers: headers || {},
						signal: controller.signal,
					});
					return {
						status: response.status,
						body: await response.text(),
					};
				} finally {
					clearTimeout(timer);
				}
			}
			throw new Error("GET requests are not supported in this runtime");
		} catch (error) {
			console.error("Failed to fetch text from " + url + ": " + error.message);
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
	// HLS Master Playlist Parser (Quality Selection)
	// ═══════════════════════════════════════════════════════════════════════════

	function parseHlsAttributes(line) {
		const attributes = {};
		const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
		let match;
		while ((match = regex.exec(String(line || ""))) !== null) {
			const key = clean(match[1]).toUpperCase();
			const value = clean(match[2]).replace(/^"|"$/g, "");
			if (key) attributes[key] = value;
		}
		return attributes;
	}

	function resolveVariantUrl(baseUrl, variantPath) {
		const target = clean(variantPath);
		if (!target) return "";
		try {
			const resolved = new URL(target, baseUrl);
			const base = new URL(baseUrl);
			if (!resolved.search && !target.includes("?") && base.search) {
				resolved.search = base.search;
			}
			return resolved.toString();
		} catch (_) {
			return target;
		}
	}

	function parseVariantQuality(attributes) {
		if (!attributes || typeof attributes !== "object") return 0;
		const resolution = clean(attributes.RESOLUTION);
		const resolutionMatch = /(\d+)\s*x\s*(\d+)/i.exec(resolution);
		if (resolutionMatch) return parseInt(resolutionMatch[2], 10) || 0;

		const bandwidth = parseInt(
			attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH || "0",
			10,
		);
		if (!bandwidth || bandwidth < 1) return 0;
		if (bandwidth >= 20000000) return 2160;
		if (bandwidth >= 10000000) return 1080;
		if (bandwidth >= 6000000) return 720;
		if (bandwidth >= 3000000) return 480;
		if (bandwidth >= 1500000) return 360;
		if (bandwidth >= 800000) return 240;
		if (bandwidth >= 400000) return 144;
		return 0;
	}

	function parseHlsMasterPlaylist(manifestText, manifestUrl) {
		const variants = [];
		const lines = String(manifestText || "").split(/\r?\n/);
		let pendingAttributes = null;

		lines.forEach(function (rawLine) {
			const line = rawLine.trim();
			if (!line) return;
			if (line.startsWith("#EXT-X-STREAM-INF:")) {
				pendingAttributes = parseHlsAttributes(
					line.slice("#EXT-X-STREAM-INF:".length),
				);
				return;
			}
			if (line.startsWith("#")) return;
			if (pendingAttributes) {
				const resolved = resolveVariantUrl(manifestUrl, line);
				if (resolved) {
					variants.push({
						url: resolved,
						attributes: pendingAttributes,
					});
				}
				pendingAttributes = null;
			}
		});

		return variants;
	}

	function shouldExpandHlsVariants(url) {
		const value = clean(url).toLowerCase();
		if (!value || /\.mpd(?:$|[?#])/i.test(value)) return false;
		return (
			/\.m3u8(?:$|[?#])/i.test(value) ||
			value.includes("/hls/") ||
			value.includes("m3u8")
		);
	}

	function isDashManifest(url) {
		return clean(url).toLowerCase().includes(".mpd");
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// DASH MPD Manifest Parser (Quality Selection)
	// ═══════════════════════════════════════════════════════════════════════════

	function parseMpdRepresentationQuality(representation) {
		if (!representation || typeof representation !== "object") return 0;
		const resolution = representation.height;
		if (resolution && resolution > 0) {
			if (resolution >= 4320) return 4320;
			if (resolution >= 2160) return 2160;
			if (resolution >= 1080) return 1080;
			if (resolution >= 720) return 720;
			if (resolution >= 480) return 480;
			if (resolution >= 360) return 360;
			if (resolution >= 240) return 240;
			if (resolution >= 144) return 144;
		}
		const bandwidth = representation.bandwidth;
		if (bandwidth && bandwidth > 0) {
			if (bandwidth >= 20000000) return 2160;
			if (bandwidth >= 10000000) return 1080;
			if (bandwidth >= 6000000) return 720;
			if (bandwidth >= 3000000) return 480;
			if (bandwidth >= 1500000) return 360;
			if (bandwidth >= 800000) return 240;
			if (bandwidth >= 400000) return 144;
		}
		return 0;
	}

	function buildMpdVariantPlaybackUrl(representation, baseUrl) {
		if (!representation || typeof representation !== "object") return "";
		const segBase = representation.id
			? "RepresentationID=" + representation.id
			: "";
		const quality = representation.bandwidth
			? "quality=" + representation.bandwidth
			: "";
		let playbackUrl = baseUrl;
		if (segBase)
			playbackUrl += (playbackUrl.indexOf("?") >= 0 ? "&" : "?") + segBase;
		if (quality)
			playbackUrl += (playbackUrl.indexOf("?") >= 0 ? "&" : "?") + quality;
		return playbackUrl;
	}

	function parseMpdMasterPlaylist(manifestText, manifestUrl) {
		const adaptationSets = [];
		const lines = String(manifestText || "").split(/\r?\n/);
		let currentAdaptationSet = null;
		let currentRepresentation = null;

		lines.forEach(function (rawLine) {
			const line = rawLine.trim();
			if (!line) return;

			if (line.indexOf("<AdaptationSet") >= 0) {
				currentAdaptationSet = {
					mimeType: null,
					codecs: null,
					contentType: null,
					representations: [],
				};
				const mimeTypeMatch = line.match(/mimeType="([^"]*)"/);
				if (mimeTypeMatch) currentAdaptationSet.mimeType = mimeTypeMatch[1];
				const codecsMatch = line.match(/codecs="([^"]*)"/);
				if (codecsMatch) currentAdaptationSet.codecs = codecsMatch[1];
				const contentTypeMatch = line.match(/contentType="([^"]*)"/i);
				if (contentTypeMatch)
					currentAdaptationSet.contentType = contentTypeMatch[1].toLowerCase();
			} else if (line.indexOf("<Representation") >= 0) {
				currentRepresentation = {
					id: null,
					bandwidth: null,
					width: null,
					height: null,
					codecs: null,
					mimeType: null,
				};
				const idMatch = line.match(/id="?([^"\s]+)"?/);
				if (idMatch) currentRepresentation.id = idMatch[1];
				const bwMatch = line.match(/bandwidth="?(\d+)?"?/);
				if (bwMatch)
					currentRepresentation.bandwidth = bwMatch[1]
						? parseInt(bwMatch[1])
						: null;
				const wMatch = line.match(/width="?(\d+)?"?/);
				if (wMatch)
					currentRepresentation.width = wMatch[1] ? parseInt(wMatch[1]) : null;
				const hMatch = line.match(/height="?(\d+)?"?/);
				if (hMatch)
					currentRepresentation.height = hMatch[1] ? parseInt(hMatch[1]) : null;
				const codecsMatch2 = line.match(/codecs="([^"]*)"/);
				if (codecsMatch2) currentRepresentation.codecs = codecsMatch2[1];
				const mimeTypeMatch2 = line.match(/mimeType="([^"]*)"/);
				if (mimeTypeMatch2) currentRepresentation.mimeType = mimeTypeMatch2[1];
				if (currentAdaptationSet) {
					currentAdaptationSet.representations.push(currentRepresentation);
				}
			} else if (line.indexOf("</Representation>") >= 0) {
				currentRepresentation = null;
			} else if (line.indexOf("</AdaptationSet>") >= 0) {
				if (
					currentAdaptationSet &&
					currentAdaptationSet.representations.length > 0
				) {
					adaptationSets.push(currentAdaptationSet);
				}
				currentAdaptationSet = null;
			}
		});

		// Separate video and audio AdaptationSets
		var videoReps = [];
		var audioReps = [];
		for (var asi = 0; asi < adaptationSets.length; asi++) {
			var as = adaptationSets[asi];
			var isAudio =
				as.contentType === "audio" ||
				(as.mimeType && as.mimeType.indexOf("audio") >= 0);
			var isVideo =
				!isAudio &&
				(as.contentType === "video" ||
					(as.mimeType && as.mimeType.indexOf("video") >= 0) ||
					(!as.mimeType &&
						as.representations.some(function (r) {
							return r.height;
						})));
			if (isAudio) {
				for (var ai = 0; ai < as.representations.length; ai++)
					audioReps.push(as.representations[ai]);
			} else if (isVideo) {
				for (var vi = 0; vi < as.representations.length; vi++)
					videoReps.push(as.representations[vi]);
			} else {
				// Unknown type — treat as video
				for (var xi = 0; xi < as.representations.length; xi++)
					videoReps.push(as.representations[xi]);
			}
		}

		// Build quality variants for video (single RepresentationID each)
		var result = [];
		for (var vi = 0; vi < videoReps.length; vi++) {
			var rep = videoReps[vi];
			var quality = parseMpdRepresentationQuality(rep);
			var url = buildMpdVariantPlaybackUrl(rep, manifestUrl);
			if (url) {
				result.push({ url: url, quality: quality });
			}
		}

		// Also include standalone audio-only streams for language selection
		for (var ai = 0; ai < audioReps.length; ai++) {
			var audioRep = audioReps[ai];
			var audioUrl = buildMpdVariantPlaybackUrl(audioRep, manifestUrl);
			if (audioUrl) {
				var dup = false;
				for (var ri = 0; ri < result.length; ri++) {
					if (result[ri].url === audioUrl) dup = true;
				}
				if (!dup) {
					result.push({ url: audioUrl, quality: 0, isAudio: true });
				}
			}
		}

		result.sort(function (a, b) {
			return b.quality - a.quality;
		});
		return result;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// DRM Helpers
	// ═══════════════════════════════════════════════════════════════════════════

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
	 * Fetch channels from a stream URL.
	 * Handles: M3U, CloudPlayChannel JSON (m3u8_url/mpd_url), CloudPlayStream JSON (recursive).
	 * Uses okhttp headers for all CloudPlay API calls — same as Kotlin does.
	 */
	async function fetchChannels(url, fallbackLogo, depth) {
		depth = typeof depth === "number" ? depth : 0;
		if (depth > 3) return []; // prevent infinite recursion

		const channels = [];
		const request = splitUrlAndHeaders(url);

		var response;
		try {
			response = await fetchText(request.url, API_HEADERS, FETCH_TIMEOUT_MS);
		} catch (_) {
			return channels;
		}

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
				if (jsonChannels[0].url) {
					// Fetch all sub-channels concurrently
					var results = await Promise.allSettled(
						jsonChannels.map(function (stream) {
							return fetchChannels(
								stream.url,
								stream.logo || fallbackLogo,
								depth + 1,
							);
						}),
					);
					results.forEach(function (r) {
						if (r.status === "fulfilled" && Array.isArray(r.value)) {
							channels.push.apply(channels, r.value);
						}
					});
					return channels;
				}
			}
		} catch (_) {}

		return channels;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Core SkyStream API Functions
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Internal: fetch all channels from all categories with concurrency and caching
	 * Returns { categories: { "Category": [channels...] }, allChannels: [flat...] }
	 */
	async function fetchAllChannels() {
		var cached = getCachedChannels();
		if (cached) return cached;

		var streams;
		try {
			streams = await fetchCloudPlayStreams();
		} catch (_) {
			return { categories: {}, allChannels: [] };
		}

		var results = await Promise.allSettled(
			streams.map(function (stream) {
				return fetchChannels(stream.url, stream.logo).then(function (channels) {
					return {
						name: stream.name || "Unknown",
						channels: channels,
					};
				});
			}),
		);

		var categories = {};
		var allChannels = [];
		var categoryOrder = [];

		results.forEach(function (r) {
			if (r.status === "fulfilled") {
				var entry = r.value;
				if (entry.channels && entry.channels.length > 0) {
					categories[entry.name] = entry.channels;
					categoryOrder.push(entry.name);
					allChannels.push.apply(allChannels, entry.channels);
				}
			}
		});

		var result = {
			categories: categories,
			allChannels: allChannels,
			categoryOrder: categoryOrder,
		};

		setCachedChannels(result);
		return result;
	}

	async function getHome(cb) {
		try {
			var full = await fetchAllChannels();
			var data = {};

			full.categoryOrder.forEach(function (name) {
				data[name] = full.categories[name].map(function (ch) {
					return new MultimediaItem({
						title: ch.title,
						posterUrl: ch.poster,
						type: "livestream",
						description: ch.group || name,
						url: JSON.stringify({
							kind: "channel",
							channel: ch,
							category: name,
						}),
					});
				});
			});

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

			var full = await fetchAllChannels();
			var results = full.allChannels.filter(function (ch) {
				var title = clean(ch.title).toLowerCase();
				var group = clean(ch.group).toLowerCase();
				return title.indexOf(q) >= 0 || group.indexOf(q) >= 0;
			});

			var items = results.map(function (ch) {
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

	// ═══════════════════════════════════════════════════════════════════════════
	// DRM Resolution for DASH
	// ═══════════════════════════════════════════════════════════════════════════

	async function resolveDrmInfo(ch, streamUrl, headers) {
		var keyHex = normalizeDrmHex(ch.keyHex);
		var kidHex = normalizeDrmHex(ch.kidHex);

		if (!keyHex || !kidHex) {
			var parsedKeys = parseKeyIdFromLicenseUrl(ch.licenseUrl);
			if (parsedKeys) {
				keyHex = parsedKeys.keyHex;
				kidHex = parsedKeys.kidHex;
			}
		}

		if (keyHex && kidHex) {
			return { drmKey: keyHex, drmKid: kidHex };
		}

		if (ch.licenseUrl) {
			var resolved = await resolveClearKey(streamUrl, ch.licenseUrl, headers);
			if (resolved) {
				return {
					drmKey: resolved.drmKey,
					drmKid: resolved.drmKid,
					licenseUrl: resolved.licenseUrl,
				};
			}
			return { licenseUrl: ch.licenseUrl };
		}

		return null;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// loadStreams — Quality Selection for HLS & DASH
	// ═══════════════════════════════════════════════════════════════════════════

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

			// ── DASH: fetch MPD, expand variants, inject DRM ──
			if (isDashManifest(streamUrl)) {
				const drmInfo = await resolveDrmInfo(ch, streamUrl, headers);
				const streams = await expandDashVariants(
					sourceLabel,
					streamUrl,
					headers,
					drmInfo,
				);
				return cb({ success: true, data: streams });
			}

			// ── HLS: fetch master, expand variants ──
			if (shouldExpandHlsVariants(streamUrl)) {
				const streams = await expandHlsVariants(
					sourceLabel,
					streamUrl,
					headers,
				);
				return cb({ success: true, data: streams });
			}

			// ── Direct URL: single stream ──
			const r = new StreamResult({
				url: streamUrl,
				source: sourceLabel,
				headers: headers,
			});

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
	// HLS Variant Expansion
	// ═══════════════════════════════════════════════════════════════════════════

	function buildHlsVariantSource(baseSource, attributes, fallbackIndex) {
		const quality = parseVariantQuality(attributes);
		if (quality > 0) {
			return { quality: quality, source: baseSource + " " + quality + "p" };
		}

		const bandwidth = parseInt(
			attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH || "0",
			10,
		);
		if (bandwidth > 0) {
			return {
				quality: 0,
				source:
					baseSource + " " + Math.max(1, Math.round(bandwidth / 1000)) + "kbps",
			};
		}

		return {
			quality: 0,
			source: baseSource + " Variant " + (fallbackIndex + 1),
		};
	}

	async function expandHlsVariants(sourceLabel, masterUrl, headers) {
		try {
			var response = await fetchText(masterUrl, headers);
			if (
				extractResponseStatus(response) < 200 ||
				extractResponseStatus(response) >= 300
			) {
				return [
					new StreamResult({
						url: masterUrl,
						source: sourceLabel,
						headers: headers,
					}),
				];
			}

			var manifestText = clean(extractResponseBody(response));
			if (
				!manifestText.startsWith("#EXTM3U") ||
				manifestText.indexOf("#EXT-X-STREAM-INF") === -1
			) {
				return [
					new StreamResult({
						url: masterUrl,
						source: sourceLabel,
						headers: headers,
					}),
				];
			}

			var variants = parseHlsMasterPlaylist(manifestText, masterUrl);
			if (!Array.isArray(variants) || variants.length === 0) {
				return [
					new StreamResult({
						url: masterUrl,
						source: sourceLabel,
						headers: headers,
					}),
				];
			}

			var seen = {};
			var streams = [];

			variants.forEach(function (variant, index) {
				if (!variant || !variant.url || seen[variant.url]) return;
				seen[variant.url] = true;

				var variantInfo = buildHlsVariantSource(
					sourceLabel,
					variant.attributes || {},
					index,
				);

				var r = new StreamResult({
					url: variant.url,
					source: variantInfo.source,
					headers: headers,
				});

				if (variantInfo.quality > 0) {
					r.quality = variantInfo.quality;
				}

				streams.push(r);
			});

			if (streams.length === 0) {
				return [
					new StreamResult({
						url: masterUrl,
						source: sourceLabel,
						headers: headers,
					}),
				];
			}

			return streams;
		} catch (error) {
			console.error("[CloudPlay] HLS expand error:", error.message);
			return [
				new StreamResult({
					url: masterUrl,
					source: sourceLabel,
					headers: headers,
				}),
			];
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// DASH Variant Expansion
	// ═══════════════════════════════════════════════════════════════════════════

	async function expandDashVariants(sourceLabel, mpdUrl, headers, drmInfo) {
		try {
			var response = await fetchText(mpdUrl, headers);
			if (
				extractResponseStatus(response) < 200 ||
				extractResponseStatus(response) >= 300
			) {
				var r = new StreamResult({
					url: mpdUrl,
					source: sourceLabel,
					headers: headers,
				});
				if (drmInfo) applyDrmToStream(r, drmInfo);
				return [r];
			}

			var manifestText = extractResponseBody(response);
			var variants = parseMpdMasterPlaylist(manifestText, mpdUrl);
			if (!Array.isArray(variants) || variants.length === 0) {
				var r = new StreamResult({
					url: mpdUrl,
					source: sourceLabel,
					headers: headers,
				});
				if (drmInfo) applyDrmToStream(r, drmInfo);
				return [r];
			}

			var seen = {};
			var streams = [];

			// Always include the base MPD URL as the primary/default stream
			// (full manifest with all audio+video AdaptationSets, no filtering)
			var baseStream = new StreamResult({
				url: mpdUrl,
				source: sourceLabel,
				headers: headers,
			});
			if (drmInfo) applyDrmToStream(baseStream, drmInfo);
			seen[mpdUrl] = true;
			streams.push(baseStream);

			// Add quality variants on top
			variants.forEach(function (variant) {
				if (!variant.url || seen[variant.url]) return;
				seen[variant.url] = true;

				var r;
				if (variant.isAudio) {
					r = new StreamResult({
						url: variant.url,
						source: sourceLabel + " Audio",
						headers: headers,
					});
				} else {
					var qualityLabel =
						variant.quality > 0 ? " " + variant.quality + "p" : "";
					r = new StreamResult({
						url: variant.url,
						source: sourceLabel + qualityLabel,
						headers: headers,
					});
					if (variant.quality > 0) {
						r.quality = variant.quality;
					}
				}

				if (drmInfo) applyDrmToStream(r, drmInfo);
				streams.push(r);
			});

			if (streams.length === 0) {
				var r = new StreamResult({
					url: mpdUrl,
					source: sourceLabel,
					headers: headers,
				});
				if (drmInfo) applyDrmToStream(r, drmInfo);
				return [r];
			}

			return streams;
		} catch (error) {
			console.error("[CloudPlay] DASH expand error:", error.message);
			var r = new StreamResult({
				url: mpdUrl,
				source: sourceLabel,
				headers: headers,
			});
			if (drmInfo) applyDrmToStream(r, drmInfo);
			return [r];
		}
	}

	function applyDrmToStream(r, drmInfo) {
		if (!drmInfo) return;
		if (drmInfo.drmKey && drmInfo.drmKid) {
			r.drmKey = drmInfo.drmKey;
			r.drmKid = drmInfo.drmKid;
			r.drmType = "clearkey";
		}
		if (drmInfo.licenseUrl) {
			r.licenseUrl = drmInfo.licenseUrl;
			r.drmLicenseUrl = drmInfo.licenseUrl;
			if (!r.drmType) r.drmType = "widevine";
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
