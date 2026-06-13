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
					const quality = parseVariantQuality(pendingAttributes);
					variants.push({
						url: resolved,
						quality: quality,
					});
				}
				pendingAttributes = null;
			}
		});

		variants.sort(function (a, b) {
			return b.quality - a.quality;
		});
		return variants;
	}

	function isHlsMasterPlaylist(url) {
		const lower = clean(url).toLowerCase();
		return (
			lower.includes(".m3u8") &&
			!lower.includes("segment") &&
			!lower.includes(".ts")
		);
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

			const ch = payload.channel;
			const streamUrl = ch.url;
			const headers = Object.assign({}, ch.headers || {});

			if (!streamUrl) {
				return cb({
					success: false,
					errorCode: "NO_STREAM",
					message: "No stream URL found",
				});
			}

			const streams = [];

			// Handle DASH (MPD) streams
			if (isDashManifest(streamUrl)) {
				const streamResult = new StreamResult({
					url: streamUrl,
					source: ch.title || "CloudPlay",
					headers: headers,
				});
				streamResult.quality = 0;

				if (ch.keyHex && ch.kidHex) {
					streamResult.drmKey = ch.keyHex;
					streamResult.drmKid = ch.kidHex;
				} else if (ch.licenseUrl) {
					streamResult.licenseUrl = ch.licenseUrl;
				}

				streams.push(streamResult);
				return cb({ success: true, data: streams });
			}

			// Handle HLS streams
			if (isHlsMasterPlaylist(streamUrl)) {
				try {
					const response = await fetchText(streamUrl, headers);
					const manifestText = extractResponseBody(response);

					if (manifestText && manifestText.includes("#EXT-X-STREAM-INF:")) {
						const variants = parseHlsMasterPlaylist(manifestText, streamUrl);

						if (variants.length > 0) {
							for (const variant of variants) {
								const stream = new StreamResult({
									url: variant.url,
									source: ch.title || "CloudPlay",
									headers: headers,
								});
								if (variant.quality > 0) {
									stream.quality = variant.quality;
								}
								streams.push(stream);
							}

							return cb({ success: true, data: streams });
						}
					}
				} catch (parseError) {
					console.warn(
						"[CloudPlay] Failed to parse HLS master playlist:",
						parseError.message,
					);
				}

				const fallbackStream = new StreamResult({
					url: streamUrl,
					source: ch.title || "CloudPlay",
					headers: headers,
				});
				fallbackStream.quality = 0;
				streams.push(fallbackStream);

				return cb({ success: true, data: streams });
			}

			// Handle direct video URLs (MP4, etc.)
			const directStream = new StreamResult({
				url: streamUrl,
				source: ch.title || "CloudPlay",
				headers: headers,
			});
			directStream.quality = 0;
			streams.push(directStream);

			cb({ success: true, data: streams });
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
