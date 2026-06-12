/**
 * vidsrc.xyz — Multi-domain HLS extraction with auto domain discovery
 *
 * =============================================================================
 *  ARCHITECTURE
 * =============================================================================
 *  VidSrc operates multiple .ru and .su domains that change frequently due to
 *  legal pressure. This scraper automatically fetches the live domain list
 *  from vidsrc.domains before attempting extraction.
 *
 *  EXTRACTION FLOW:
 *    1. Fetch live domain list from vidsrc.domains (or use fallback list)
 *    2. For each live domain, fetch the embed page
 *    3. Try to extract M3U8 directly from the page
 *    4. If blocked by Turnstile/Cloudflare, return embed URL as fallback
 *    5. Return quality-sorted streams or embed fallback
 *
 *  ⚠ LIMITATION: New .ru/.su domains use Cloudflare Turnstile CAPTCHA.
 *    Node.js scrapers CANNOT bypass Turnstile without a headless browser.
 *    When Turnstile is detected, the scraper returns the embed URL so the
 *    player's browser can render it in an iframe (which can solve Turnstile
 *    via normal browser interaction).
 *
 *  KNOWN WORKING DOMAINS (as of June 2026):
 *    vidsrcme.ru, vidsrcme.su, vidsrc-me.ru, vidsrc-me.su,
 *    vidsrc-embed.ru, vidsrc-embed.su, vsrc.su
 * =============================================================================
 */

var {
	httpGet,
	makeFail,
	parseM3U8AllQualities,
	m3u8ToStreams,
	qualityLabel,
	resolveRelativeUrl,
} = require("./_shared");

var SOURCE_NAME = "vidsrc.xyz";
var DOMAINS_URL = "https://vidsrc.domains/";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Fallback domain list (used if vidsrc.domains is unreachable)
var FALLBACK_DOMAINS = [
	{ domain: "vidsrcme.ru", live: true },
	{ domain: "vidsrcme.su", live: true },
	{ domain: "vidsrc-me.ru", live: true },
	{ domain: "vidsrc-me.su", live: true },
	{ domain: "vidsrc-embed.ru", live: true },
	{ domain: "vidsrc-embed.su", live: true },
	{ domain: "vsrc.su", live: true },
];

// =============================================================================
//  DOMAIN DISCOVERY
// =============================================================================

/**
 * Fetch the live domain list from vidsrc.domains.
 * Parses the HTML to find domains marked as "Live" in the NEW DOMAINS section.
 * Falls back to FALLBACK_DOMAINS if the fetch fails.
 *
 * @returns {Promise<Array<{domain: string, live: boolean}>>}
 */
async function fetchDomains() {
	try {
		var html = await httpGet(DOMAINS_URL, {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml",
		});

		if (!html || html.length < 500) {
			return FALLBACK_DOMAINS.slice();
		}

		var text = String(html);
		var domains = [];

		// Find the NEW DOMAINS section
		var newSectionMatch = text.match(
			/<h3>NEW DOMAINS:<\/h3>([\s\S]*?)(?:<h3>|$)/i,
		);
		var section = newSectionMatch ? newSectionMatch[1] : text;

		// Extract all <a> tags with href pointing to domains
		var linkRegex = /<a\s+href="https:\/\/([^"\s]+)">([^<]*)<\/a>/gi;
		var match;
		while ((match = linkRegex.exec(section))) {
			var href = match[1];
			var linkText = match[0];
			// Only include if it has "Live" status
			if (
				linkText.indexOf('class="live-text">Live<') !== -1 ||
				linkText.indexOf("Live") !== -1
			) {
				domains.push({ domain: href, live: true });
			}
		}

		// If the new section approach failed, try the whole page
		if (domains.length === 0) {
			linkRegex.lastIndex = 0;
			while ((match = linkRegex.exec(text))) {
				var href2 = match[1];
				var linkText2 = match[0];
				if (
					linkText2.indexOf('class="live-text">Live<') !== -1 ||
					linkText2.indexOf("Live") !== -1
				) {
					domains.push({ domain: href2, live: true });
				}
			}
		}

		return domains.length > 0 ? domains : FALLBACK_DOMAINS.slice();
	} catch (e) {
		return FALLBACK_DOMAINS.slice();
	}
}

// =============================================================================
//  URL BUILDING
// =============================================================================

/**
 * Build the embed URL for a given domain and content.
 */
function buildEmbedUrl(domain, params) {
	var type = params.type === "tv" ? "tv" : "movie";
	var tmdbId = params.tmdbId;
	var url = "https://" + domain + "/embed/" + type + "/" + tmdbId;

	if (type === "tv") {
		var season = params.season || 1;
		var episode = params.episode || 1;
		url += "/" + season + "-" + episode;
	}

	return url;
}

// =============================================================================
//  EXTRACTION — TRY TO GET M3U8 FROM EMBED PAGE
// =============================================================================

/**
 * Try to extract an M3U8 URL from an embed page.
 * Checks for file: variable, direct .m3u8 URLs, or source tags.
 *
 * @param {string} html - Embed page HTML
 * @param {string} embedUrl - Original embed URL (for Referer)
 * @returns {Promise<Array<{url: string, quality: string}>>}
 */
function extractDirectM3u8(html, embedUrl) {
	var results = [];

	if (!html || html.length < 100) return results;

	// Try to find a direct .m3u8 URL in the page
	var m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
	var match;
	while ((match = m3u8Regex.exec(html))) {
		var url = match[0];
		results.push({
			url: url,
			quality: "Auto",
		});
	}

	// Try file: variable pattern
	var fileMatch = html.match(
		/file['"]?\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
	);
	if (fileMatch && fileMatch[1]) {
		// Add as highest priority
		var fileUrl = fileMatch[1];
		if (fileUrl.indexOf("http") !== 0) {
			// Resolve relative URL
			var base = embedUrl.replace(/\/[^/]*$/, "/");
			if (fileUrl.indexOf("//") === 0) {
				fileUrl = "https:" + fileUrl;
			} else if (fileUrl.indexOf("/") === 0) {
				var originMatch = embedUrl.match(/^(https?:\/\/[^/]+)/);
				if (originMatch) fileUrl = originMatch[1] + fileUrl;
			} else {
				fileUrl = base + fileUrl;
			}
		}
		results.unshift({ url: fileUrl, quality: "Auto" });
	}

	return results;
}

/**
 * Check if the embed page has Turnstile or Cloudflare protection.
 */
function hasTurnstile(html) {
	if (!html) return false;
	return (
		html.indexOf("cf-turnstile") !== -1 ||
		html.indexOf("turnstile") !== -1 ||
		html.indexOf("cf-challenge") !== -1 ||
		html.indexOf("challenges.cloudflare.com") !== -1
	);
}

/**
 * Check if the page has the old-style RCP/PRORCP chain.
 */
function hasRcpChain(html) {
	if (!html) return false;
	return html.indexOf("/rcp/") !== -1;
}

// =============================================================================
//  OLD-STYLE RCP CHAIN (for domains that still support it)
// =============================================================================

/**
 * Try the old RCP → PRORCP/SRCRCP chain for M3U8 extraction.
 * This is the legacy extraction method that worked before Turnstile was added.
 */
async function tryRcpChain(embedHtml, embedUrl) {
	try {
		// Find the base domain from iframe or direct link
		var baseDom = "https://cloudorchestranova.com";
		var iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
		var rcpUrl = "";
		if (iframeMatch && iframeMatch[1]) {
			var src = iframeMatch[1];
			if (src.indexOf("//") === 0) src = "https:" + src;
			var originMatch = src.match(/^(https?:\/\/[^/]+)/);
			if (originMatch) baseDom = originMatch[1];
			rcpUrl = src;
		} else {
			// Try to find RCP URL directly in the page
			var rcpMatch = embedHtml.match(/https?:\/\/[^"'\s]+\/rcp\/[^"'\s]+/i);
			if (rcpMatch) rcpUrl = rcpMatch[0];
		}

		if (!rcpUrl) return [];

		// Fetch RCP page
		var rcpHtml = await httpGet(rcpUrl, {
			"User-Agent": UA,
			Referer: embedUrl,
			Accept: "*/*",
		});

		if (!rcpHtml || rcpHtml.length < 50) return [];

		// Check for Turnstile in RCP
		if (hasTurnstile(rcpHtml)) return [];

		// Extract src path for PRORCP/SRCRCP
		var srcMatch = rcpHtml.match(/src\s*:\s*['"](\/[^'"]+)['"]/);
		if (!srcMatch || !srcMatch[1]) return [];

		var srcPath = srcMatch[1];

		if (srcPath.indexOf("/prorcp/") === 0) {
			return await processProrcp(baseDom + srcPath, rcpUrl);
		} else if (srcPath.indexOf("/srcrcp/") === 0) {
			return await processSrcrcp(srcPath, baseDom, rcpUrl);
		}

		return [];
	} catch (e) {
		return [];
	}
}

/**
 * Process a PRORCP endpoint and return M3U8 streams.
 * Fetches the resolved M3U8 URL and parses it for ALL quality variants.
 */
async function processProrcp(prorcpUrl, refererUrl) {
	try {
		var scriptContent = await httpGet(prorcpUrl, {
			"User-Agent": UA,
			Referer: refererUrl,
			Accept: "*/*",
		});

		if (!scriptContent || scriptContent.length < 50) return [];

		// Check for Turnstile
		if (hasTurnstile(scriptContent)) return [];

		// Extract file URL
		var fileMatch = scriptContent.match(/file['"]?\s*[:=]\s*['"]([^'"]+)['"]/i);
		var fileUrl = "";
		if (fileMatch && fileMatch[1]) {
			fileUrl = fileMatch[1];
		} else {
			var m3u8Match = scriptContent.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/i);
			if (m3u8Match) fileUrl = m3u8Match[0];
		}

		if (!fileUrl) return [];

		// Resolve relative URLs
		if (fileUrl.indexOf("http") !== 0) {
			var base = prorcpUrl.replace(/\/[^/]*$/, "/");
			if (fileUrl.indexOf("//") === 0) {
				fileUrl = "https:" + fileUrl;
			} else if (fileUrl.indexOf("/") === 0) {
				var originMatch = prorcpUrl.match(/^(https?:\/\/[^/]+)/);
				if (originMatch) fileUrl = originMatch[1] + fileUrl;
			} else {
				fileUrl = base + fileUrl;
			}
		}

		// Fetch and parse the resolved M3U8 URL for ALL quality variants
		return await fetchM3U8AndParseAllVariants(fileUrl, {
			"User-Agent": UA,
			Referer: prorcpUrl,
		});
	} catch (e) {
		return [];
	}
}

/**
 * Process a SRCRCP endpoint and return M3U8 streams.
 * Fetches the resolved M3U8 URL and parses it for ALL quality variants.
 * Also adds the master playlist as "Auto [Master]" option.
 */
async function processSrcrcp(srcrcpPath, baseDom, refererUrl) {
	try {
		var srcrcpUrl = baseDom + srcrcpPath;
		var scriptContent = await httpGet(srcrcpUrl, {
			"User-Agent": UA,
			Referer: refererUrl,
			Accept: "*/*",
		});

		if (!scriptContent || scriptContent.length < 50) return [];

		// Check for Turnstile
		if (hasTurnstile(scriptContent)) return [];

		// Direct M3U8 content embedded in script response.
		// The M3U8 contains variant URLs (CDN). No separate master URL exists —
		// the variants are the real stream endpoints and should work directly.
		if (scriptContent.indexOf("#EXTM3U") !== -1) {
			var variants = parseM3u8Variants(scriptContent, srcrcpUrl);
			if (variants.length > 0) {
				return variants;
			}
			// Valid M3U8 but no STREAM-INF → variant playlist (single quality)
			return [
				{
					url: srcrcpUrl,
					quality: extractQualityFromUrl(srcrcpUrl) || "Auto",
					headers: {
						"User-Agent": UA,
						Referer: srcrcpUrl,
					},
				},
			];
		}

		// Extract file URL from script
		var fileMatch = scriptContent.match(/file['"]?\s*[:=]\s*['"]([^'"]+)['"]/i);
		var fileUrl = "";
		if (fileMatch && fileMatch[1]) {
			fileUrl = fileMatch[1];
		} else {
			var m3u8Match = scriptContent.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/i);
			if (m3u8Match) fileUrl = m3u8Match[0];
		}

		if (!fileUrl) return [];

		// Resolve relative URLs
		if (fileUrl.indexOf("http") !== 0) {
			var base = srcrcpUrl.replace(/\/[^/]*$/, "/");
			if (fileUrl.indexOf("//") === 0) {
				fileUrl = "https:" + fileUrl;
			} else if (fileUrl.indexOf("/") === 0) {
				var originMatch = srcrcpUrl.match(/^(https?:\/\/[^/]+)/);
				if (originMatch) fileUrl = originMatch[1] + fileUrl;
			} else {
				fileUrl = base + fileUrl;
			}
		}

		// Fetch and parse the resolved M3U8 URL for ALL quality variants
		return await fetchM3U8AndParseAllVariants(fileUrl, {
			"User-Agent": UA,
			Referer: srcrcpUrl,
		});
	} catch (e) {
		return [];
	}
}

/**
 * Parse M3U8 content and return quality variants.
 * Uses shared _shared.js parser for consistency.
 */
function parseM3u8Variants(content, baseUrl) {
	// Use the shared parser, then enrich with headers
	var variants = parseM3U8AllQualities(content, baseUrl);
	if (variants.length === 0) return [];

	var results = [];
	for (var vi = 0; vi < variants.length; vi++) {
		var v = variants[vi];
		results.push({
			url: v.url,
			quality: v.quality,
			height: v.height,
			headers: {
				"User-Agent": UA,
				Referer: baseUrl,
			},
		});
	}

	results.sort(function (a, b) {
		return (b.height || 0) - (a.height || 0);
	});

	return results;
}

/**
 * Fetch a M3U8 URL, parse it, and return ALL quality variants as streams
 * plus a master playlist entry. Falls back to returning the URL as-is
 * if M3U8 parsing fails or the content is a variant playlist.
 *
 * @param {string} url - The M3U8 URL
 * @param {object} headers - Headers to use for fetching
 * @returns {Promise<Array<{url, quality, headers}>>}
 */
async function fetchM3U8AndParseAllVariants(url, headers) {
	if (!url) return [];

	try {
		var m3u8Content = await httpGet(url, headers || {});
		if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
			// Not valid M3U8 — return URL as single Auto stream
			return [{ url: url, quality: "Auto", headers: headers || {} }];
		}

		// Try to parse as master playlist with STREAM-INF variants
		var variants = parseM3U8AllQualities(m3u8Content, url);
		if (variants.length > 0) {
			// Master playlist — return ALL individual variant streams
			// Each with its own variant URL AND audio group reference
			// (vixcloud/etc variants are video-only, but vidsrc variants
			//  typically have muxed audio so direct URLs work)
			var streams = [];
			for (var vi = 0; vi < variants.length; vi++) {
				streams.push({
					url: variants[vi].url,
					quality: variants[vi].quality,
					headers: headers || {},
				});
			}
			// Also add master playlist as "Auto [Master]" for proper HLS
			streams.push({
				url: url,
				quality: "Auto [Master]",
				headers: headers || {},
			});
			return streams;
		}

		// It's a variant playlist (single quality) — extract quality from URL
		var q = extractQualityFromUrl(url) || "Auto";
		return [{ url: url, quality: q, headers: headers || {} }];
	} catch (e) {
		// Fetch failed — return URL as-is
		return [{ url: url, quality: "Auto", headers: headers || {} }];
	}
}

/**
 * Extract resolution label from a URL string.
 */
function extractQualityFromUrl(url) {
	var u = String(url || "");
	var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
	if (m) return m[1];
	if (/\b4k\b/i.test(u)) return "2160p";
	return "";
}

// =============================================================================
//  MAIN ENTRY POINT
// =============================================================================

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	if (!tmdbId) {
		return fail("missing tmdbId");
	}

	try {
		// ── Step 1: Discover live domains ──
		var domains = await fetchDomains();
		if (domains.length === 0) {
			return fail("no domains available");
		}

		// ── Step 2: Try each domain ──
		var streams = [];
		var tried = [];
		var turnstileBlocked = [];

		for (var di = 0; di < domains.length; di++) {
			var domain = domains[di].domain;
			var embedUrl = buildEmbedUrl(domain, {
				tmdbId: tmdbId,
				type: type,
				season: season,
				episode: episode,
			});
			tried.push(domain);

			try {
				var embedHtml = await httpGet(embedUrl, {
					"User-Agent": UA,
					Referer: "https://" + domain + "/",
					Accept: "text/html,application/xhtml+xml",
				});

				if (!embedHtml || embedHtml.length < 200) continue;

				// Check for Turnstile
				if (hasTurnstile(embedHtml)) {
					turnstileBlocked.push(domain);
					// Skip — embed URLs can't be played by the player.
					// Try next domain in case it doesn't have Turnstile.
					continue;
				}

				// Strategy 1: Direct M3U8 extraction — fetch and parse for variants
				var directStreams = extractDirectM3u8(embedHtml, embedUrl);
				if (directStreams.length > 0) {
					for (var si = 0; si < directStreams.length; si++) {
						var parsed = await fetchM3U8AndParseAllVariants(
							directStreams[si].url,
							{
								"User-Agent": UA,
								Referer: embedUrl,
							},
						);
						for (var pi = 0; pi < parsed.length; pi++) {
							streams.push(parsed[pi]);
						}
					}
					// Success — no need to try more domains
					break;
				}

				// Strategy 2: RCP chain (old-style extraction)
				if (hasRcpChain(embedHtml)) {
					var rcpStreams = await tryRcpChain(embedHtml, embedUrl);
					if (rcpStreams.length > 0) {
						for (var ri = 0; ri < rcpStreams.length; ri++) {
							streams.push(rcpStreams[ri]);
						}
						break;
					}
				}

				// No extraction method worked for this domain
			} catch (e) {
				// Domain failed, try next one
				continue;
			}
		}

		if (streams.length === 0) {
			var errMsg =
				turnstileBlocked.length === domains.length
					? "all domains blocked by Turnstile — cannot extract M3U8"
					: "all domains failed (" + tried.join(", ") + ")";
			return {
				source: SOURCE_NAME,
				status: "no_streams",
				error: errMsg,
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
		return fail(e.message);
	}

	function fail(msg) {
		return makeFail(SOURCE_NAME, msg, start);
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
