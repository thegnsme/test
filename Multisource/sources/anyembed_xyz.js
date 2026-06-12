/**
 * anyembed.xyz — API-based multi-quality HLS with audio & subtitle tracks
 *
 * =============================================================================
 *  ARCHITECTURE
 * =============================================================================
 *  anyembed.xyz provides a REST API at api.anyembed.xyz that wraps multiple
 *  backend video providers. The API is Cloudflare-protected and requires a
 *  valid session (guest auth) and a specific force_provider parameter.
 *
 *  EXTRACTION FLOW:
 *    1. Fetch settings        → GET  /api/settings
 *    2. Guest auth            → POST /api/auth/guest     → { guestId, sessionId }
 *    3. Get session token     → GET  /api/v1/session     → { token }
 *    4. Stream request        → GET  /api/v1/stream/{id}?force_provider=X
 *                              → { sources: [{ streams: [{ url, quality, subs }] }] }
 *    5. Fetch HLS playlist    → GET playlist URL (proxied through anyembed)
 *                              → HLS master M3U8 with:
 *                                • 3-4 quality variants (480p, 720p, 1080p)
 *                                • 2+ audio tracks (Italian default, English)
 *                                • 7+ subtitle tracks
 *    6. Parse M3U8            → Extract ALL quality variants + audio + subs
 *
 *  PROVIDER FALLBACK CHAIN (tried in order):
 *    streamingcommunity → moviesapi → gojara → lookm → purstream
 *
 *  All stream URLs go through anyembed's proxy layer:
 *    /api/proxy?url=https://vixcloud.co/playlist/{id}?token=...&h=1
 *
 * =============================================================================
 *  API RESPONSE FORMAT (success)
 * =============================================================================
 *  {
 *    success: true,
 *    extraction_mode: "redis_cached_fast",
 *    sources: [{
 *      provider: "streamingcommunity",
 *      streams: [{
 *        format: "hls",
 *        quality: "1080p",
 *        url: "https://vixcloud.co/playlist/...?token=...",
 *        headers: { Origin: "...", Referer: "..." },
 *        subtitles: [{ label, language, url }]
 *      }]
 *    }]
 *  }
 *
 *  HLS MASTER PLAYLIST (proxied):
 *    #EXTM3U
 *    #EXT-X-MEDIA:TYPE=AUDIO,...NAME="English",LANGUAGE="eng",URI="..."
 *    #EXT-X-MEDIA:TYPE=SUBTITLES,...NAME="English",LANGUAGE="eng",URI="..."
 *    #EXT-X-STREAM-INF:RESOLUTION=854x480,AUDIO="audio",SUBTITLES="subs"
 *    https://...proxy...rendition=480p...
 *
 * =============================================================================
 *  ERROR HANDLING
 * =============================================================================
 *  • 403 security_violation: try force_provider parameter
 *  • 429 rate limited: respect retryAfter header
 *  • Provider failure: cascade to next provider in chain
 *  • Token expiry in playlist URLs: re-fetch from API
 *  • M3U8 parse failure: return single stream from API directly
 * =============================================================================
 */

var {
  httpGet,
  safeJsonParse,
  extractJsValue,
  qualityLabel,
  qualityRank,
  m3u8ToStreams,
  parseM3U8AllQualities,
  extractSubtitlesFromM3U8,
  resolveRelativeUrl,
} = require("./_shared");
var { makeFail } = require("./_shared");

var SOURCE_NAME = "anyembed.xyz";
var API_BASE = "https://api.anyembed.xyz";
var BASE_URL = "https://anyembed.xyz";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Provider fallback chain (tried until one returns valid streams)
var PROVIDERS = [
  "streamingcommunity",
  "moviesapi",
  "gojara",
  "lookm",
  "purstream",
];

// Reusable base headers for API calls
var API_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Origin: BASE_URL,
  Referer: BASE_URL + "/embed/tmdb-movie-550",
};

// =========================================================================
//  INTERNAL HTTP HELPERS (full URLs only, for SkyStream runtime)
// =========================================================================

/**
 * HTTP GET wrapper for API calls. Always uses full URLs.
 * @param {string} url - Full URL
 * @param {object} headers - Additional headers
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{status: number, body: string}>}
 */
function apiGet(url, headers, timeout) {
  return httpGet(url, Object.assign({}, API_HEADERS, headers || {}))
    .then(function (body) {
      return body;
    })
    .catch(function (e) {
      throw e;
    });
}

/**
 * HTTP POST wrapper for API calls.
 * Handles both callback-style (SkyStream legacy) and Promise-style http_post.
 * @param {string} url - Full URL
 * @param {object} headers - Additional headers
 * @param {string} body - Request body
 * @returns {Promise<string>} Response body
 */
function apiPost(url, headers, body) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error("timeout"));
    }, 15000);

    function onResult(r) {
      clearTimeout(timer);
      resolve(r && r.body ? r.body : String(r || ""));
    }

    function onError(e) {
      clearTimeout(timer);
      reject(e);
    }

    try {
      // Build full headers
      var reqHeaders = Object.assign(
        {},
        API_HEADERS,
        { "Content-Type": "application/json" },
        headers || {},
      );

      // Call http_post — some runtimes support callback (4th arg),
      // others return a Promise. We handle both.
      var result = http_post(url, reqHeaders, body || "{}", onResult);

      // If http_post returned a Promise (Promise-style runtime), use it
      if (result && typeof result.then === "function") {
        result.then(onResult).catch(onError);
      }
    } catch (e) {
      onError(e);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════
//  AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════

var _sessionToken = null;
var _sessionExpires = 0;

/**
 * Ensure we have a valid session token.
 * The API uses cookies for session tracking and a bearer token for auth.
 */
async function ensureSession() {
  if (_sessionToken && Date.now() < _sessionExpires) {
    return _sessionToken;
  }

  // Step 1: Guest auth — sets session cookies
  try {
    var guestBody = await apiPost(API_BASE + "/api/auth/guest", {}, "{}");
    var guestData = safeJsonParse(guestBody);
    if (!guestData || !guestData.success) {
      throw new Error("guest auth failed");
    }
  } catch (e) {
    throw e;
  }

  // Step 2: Get session token
  try {
    var sessBody = await apiGet(API_BASE + "/api/v1/session", {});
    var sessData = safeJsonParse(sessBody);
    if (!sessData || !sessData.success || !sessData.token) {
      throw new Error("session token fetch failed");
    }

    _sessionToken = sessData.token;
    _sessionExpires = Date.now() + (sessData.expires_in || 60) * 1000 - 5000;
    return _sessionToken;
  } catch (e) {
    _sessionToken = null;
    _sessionExpires = 0;
    throw e;
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  STREAM ENDPOINT
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch stream sources from the anyembed API.
 * Tries each provider until one returns valid streams.
 *
 * @param {number} tmdbId - TMDB content ID
 * @param {string} type - "movie" or "tv"
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {string} token - Session bearer token
 * @returns {Promise<Array>} Sources array from API
 */
async function fetchStreamSources(tmdbId, type, season, episode, token) {
  var qs = "?is_tv=" + (type === "tv");
  if (type === "tv") {
    qs += "&season=" + season + "&episode=" + episode;
  }

  var authHeaders = { Authorization: "Bearer " + token };

  // Try each provider in the fallback chain
  for (var pi = 0; pi < PROVIDERS.length; pi++) {
    var provider = PROVIDERS[pi];
    var url =
      API_BASE +
      "/api/v1/stream/" +
      tmdbId +
      qs +
      "&force_provider=" +
      provider;

    try {
      var body = await apiGet(url, authHeaders);
      var data = safeJsonParse(body);
      if (!data) continue;

      // Rate limited — wait and skip
      if (data.retryAfter) {
        await sleep(data.retryAfter * 1000);
        continue;
      }

      // Check for error states
      if (data.error || !data.success) continue;

      // Valid response with sources
      if (
        data.sources &&
        data.sources.length > 0 &&
        data.sources[0].streams &&
        data.sources[0].streams.length > 0
      ) {
        var testUrl = data.sources[0].streams[0].url;
        if (testUrl && testUrl.indexOf("http") === 0) {
          return {
            sources: data.sources,
            feedbackToken: data.feedback_token || null,
            proxyToken: data.proxy_token || null,
          };
        }
      }
    } catch (e) {
      continue;
    }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════════
//  HLS PLAYLIST FETCH & PARSE
// ═════════════════════════════════════════════════════════════════════════

/**
 * Fetch the HLS master playlist through anyembed's proxy layer.
 * The API returns raw vixcloud.co URLs, but they MUST be requested
 * through the anyembed proxy which validates the Origin header.
 *
 * @param {string} streamUrl - The playlist URL from API source (raw vixcloud URL)
 * @param {object} headers - Headers from API response (Origin, Referer)
 * @returns {Promise<{content: string|null, proxyUrl: string|null}>}
 *   Object with raw M3U8 content and the proxy URL to use as master playlist.
 */
async function fetchProxiedPlaylist(streamUrl, headers) {
  if (!streamUrl) return { content: null, proxyUrl: null };

  try {
    // Build proxy URL — this is what the browser does client-side
    var encodedUrl = encodeURIComponent(streamUrl);
    var encodedHeaders = encodeURIComponent(
      JSON.stringify({
        Origin: "https://vixcloud.co",
        Referer: "https://vixcloud.co",
      }),
    );
    var proxyUrl =
      API_BASE +
      "/api/proxy?url=" +
      encodedUrl +
      "&headers=" +
      encodedHeaders +
      "&origin=https://vixcloud.co&referer=https://vixcloud.co/";

    // IMPORTANT: The proxy validates Origin — must be anyembed domain
    var reqHeaders = {
      "User-Agent": UA,
      Accept: "*/*",
      Origin: "https://anyembed.xyz",
      Referer: "https://anyembed.xyz/",
    };

    var body = await httpGet(proxyUrl, reqHeaders);

    if (body && body.length > 50 && body.indexOf("#EXTM3U") !== -1) {
      return { content: body, proxyUrl: proxyUrl };
    }
    return { content: null, proxyUrl: null };
  } catch (e) {
    return { content: null, proxyUrl: null };
  }
}

/**
 * Parse audio tracks from HLS master playlist.
 * Extracts #EXT-X-MEDIA:TYPE=AUDIO entries.
 *
 * @param {string} m3u8Content - Raw HLS master playlist
 * @param {string} playlistUrl - Base URL for resolving relative paths
 * @returns {Array<{url: string, label: string, lang: string, default: boolean}>}
 */
function extractAudioTracks(m3u8Content, playlistUrl) {
  var tracks = [];
  if (!m3u8Content) return tracks;

  var lines = String(m3u8Content).split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
      var urlMatch = line.match(/URI="([^"]+)"/);
      var langMatch = line.match(/LANGUAGE="([^"]+)"/);
      var nameMatch = line.match(/NAME="([^"]+)"/);
      var defaultMatch = line.match(/DEFAULT=([A-Z]+)/);

      if (urlMatch && urlMatch[1]) {
        var audioUrl = urlMatch[1];
        if (audioUrl.indexOf("http") !== 0 && playlistUrl) {
          audioUrl = resolveRelativeUrl(playlistUrl, audioUrl);
        }
        tracks.push({
          url: audioUrl,
          label: (nameMatch && nameMatch[1]) || "Unknown",
          lang: (langMatch && langMatch[1]) || "en",
          default: defaultMatch && defaultMatch[1] === "YES",
        });
      }
    }
  }
  return tracks;
}

/**
 * Parse subtitle tracks from HLS master playlist.
 *
 * @param {string} m3u8Content - Raw HLS master playlist
 * @param {string} playlistUrl - Base URL for resolving relative paths
 * @returns {Array<{url: string, label: string, lang: string}>}
 */
function parseSubtitleTracks(m3u8Content, playlistUrl) {
  if (!m3u8Content) return [];

  var lines = String(m3u8Content).split("\n");
  var tracks = [];
  var seen = {};

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
      var urlMatch = line.match(/URI="([^"]+)"/);
      var langMatch = line.match(/LANGUAGE="([^"]+)"/);
      var nameMatch = line.match(/NAME="([^"]+)"/);

      if (urlMatch && urlMatch[1] && !seen[urlMatch[1]]) {
        seen[urlMatch[1]] = true;
        var subUrl = urlMatch[1];
        if (subUrl.indexOf("http") !== 0 && playlistUrl) {
          subUrl = resolveRelativeUrl(playlistUrl, subUrl);
        }
        tracks.push({
          url: subUrl,
          label: (nameMatch && nameMatch[1]) || "Subtitle",
          lang: (langMatch && langMatch[1]) || "en",
        });
      }
    }
  }
  return tracks;
}

// ═════════════════════════════════════════════════════════════════════════
//  STREAM ASSEMBLY
// ═════════════════════════════════════════════════════════════════════════

/**
 * Determine if a URL goes through anyembed's proxy layer.
 */
function isProxyUrl(url) {
  return (
    typeof url === "string" && url.indexOf("api.anyembed.xyz/api/proxy") !== -1
  );
}

/**
 * Get the correct Origin/Referer headers for a stream URL.
 * Proxy URLs (api.anyembed.xyz) → anyembed.xyz origin
 * Direct URLs (vixcloud.co) → vixcloud.co origin
 */
function streamHeaders(url, sourceHeaders) {
  var h = { "User-Agent": UA };
  if (isProxyUrl(url)) {
    h.Origin = "https://anyembed.xyz";
    h.Referer = "https://anyembed.xyz/";
  } else {
    h.Origin = (sourceHeaders && sourceHeaders.Origin) || "https://vixcloud.co";
    h.Referer =
      (sourceHeaders && sourceHeaders.Referer) || "https://vixcloud.co/";
  }
  return h;
}

/**
 * Build final stream array from API response and parsed HLS playlist.
 *
 * CRITICAL: When a master playlist is available, we return the MASTER PLAYLIST
 * URL (not individual variant URLs). The master playlist contains
 * #EXT-X-MEDIA:TYPE=AUDIO group references that let the player select the
 * correct audio track. Individual variant playlists are VIDEO ONLY — they
 * don't include audio segments and playing them results in silent video.
 *
 * @param {object} apiResult - Result from fetchStreamSources
 * @param {string} playlistContent - Raw M3U8 playlist content (or null)
 * @param {string} playlistUrl - The vixcloud master playlist URL (for player)
 * @param {object} playlistHeaders - Headers for the playlist
 * @returns {Array<{url, quality, headers, subtitles, audio}>}
 */
function buildStreams(
  apiResult,
  playlistContent,
  playlistUrl,
  playlistHeaders,
) {
  var streams = [];
  var seenUrls = {};

  if (!apiResult || !apiResult.sources) return streams;

  // Collect API-provided subtitles as fallback
  var apiSubtitles = [];
  for (var si = 0; si < apiResult.sources.length; si++) {
    var src = apiResult.sources[si];
    if (src.streams) {
      for (var sj = 0; sj < src.streams.length; sj++) {
        if (src.streams[sj].subtitles && src.streams[sj].subtitles.length > 0) {
          apiSubtitles = src.streams[sj].subtitles;
          break;
        }
      }
    }
    if (apiSubtitles.length > 0) break;
  }

  if (playlistContent && playlistContent.indexOf("#EXTM3U") !== -1) {
    // Parse quality variants, subtitle tracks, and audio tracks from M3U8.
    // Use playlistUrl (vixcloud CDN URL) as base for resolving relative URLs.
    var variants = parseM3U8AllQualities(playlistContent, playlistUrl);
    var playlistSubs = parseSubtitleTracks(playlistContent, playlistUrl);
    var audioTracks = extractAudioTracks(playlistContent, playlistUrl);

    if (variants.length > 0) {
      // ── Return ALL quality variants as individual stream entries ──
      //
      // IMPORTANT: For vixcloud-hosted playlists, individual variant playlists
      // are VIDEO ONLY — audio comes from a separate #EXT-X-MEDIA:TYPE=AUDIO
      // group. If we pass variant URLs directly, hls.js plays video with no
      // audio. Therefore, ALL variant entries point to the MASTER playlist URL.
      // hls.js uses the master playlist's bandwidth detection to auto-select
      // the optimal variant while maintaining audio context.
      //
      // To prevent plugin.js dedup (which removes duplicate URLs), each entry
      // gets a unique URL fragment (#1080p, #720p, etc.). Fragments are not
      // sent in HTTP requests, so the server returns the same master playlist.
      var ts = Date.now();
      for (var vi = 0; vi < variants.length; vi++) {
        var v = variants[vi];
        var vUrl = playlistUrl + "#" + v.quality + "-" + ts;
        var entry = {
          url: vUrl,
          quality: v.quality,
          headers: streamHeaders(playlistUrl, playlistHeaders),
        };
        // Attach subtitle tracks from playlist (WebVTT URLs from M3U8)
        if (playlistSubs.length > 0) {
          entry.subtitles = playlistSubs;
        } else if (apiSubtitles.length > 0) {
          entry.subtitles = apiSubtitles;
        }
        // Attach audio track metadata for player reference
        if (audioTracks.length > 0) {
          entry.audio = audioTracks;
        }
        streams.push(entry);
      }

      // Also add the master playlist as "Auto [Master]" for proper HLS
      // with audio group references and in-player quality switching
      var masterUrl = playlistUrl + "#master-" + ts;
      var masterEntry = {
        url: masterUrl,
        quality: "Auto [Master]",
        headers: streamHeaders(playlistUrl, playlistHeaders),
      };
      if (playlistSubs.length > 0) {
        masterEntry.subtitles = playlistSubs;
      } else if (apiSubtitles.length > 0) {
        masterEntry.subtitles = apiSubtitles;
      }
      if (audioTracks.length > 0) {
        masterEntry.audio = audioTracks;
      }
      streams.push(masterEntry);

      return streams;
    }
  }

  // Fallback: Use API-provided streams directly (no master playlist available)
  for (var si2 = 0; si2 < apiResult.sources.length; si2++) {
    var src2 = apiResult.sources[si2];
    if (!src2.streams) continue;
    for (var sj2 = 0; sj2 < src2.streams.length; sj2++) {
      var st = src2.streams[sj2];
      if (!st.url || seenUrls[st.url]) continue;
      seenUrls[st.url] = true;

      var fHeaders = streamHeaders(st.url, st.headers);

      var fSubs = st.subtitles || apiSubtitles;

      streams.push({
        url: st.url,
        quality: st.quality || "Auto",
        headers: fHeaders,
        subtitles: fSubs,
      });
    }
  }

  return streams;
}

// ═════════════════════════════════════════════════════════════════════════
//  SLEEP
// ═════════════════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// ═════════════════════════════════════════════════════════════════════════
//  MAIN SCRAPE ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════

/**
 * Scrape streams from anyembed.xyz for the given content.
 *
 * @param {object} params - Scrape parameters
 * @param {number|string} params.tmdbId - TMDB content ID
 * @param {string} params.type - Content type ("movie" or "tv")
 * @param {number} [params.season] - Season number (tv only)
 * @param {number} [params.episode] - Episode number (tv only)
 * @returns {Promise<{source: string, status: string, streams: Array, latency_ms: number}>}
 */
async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = parseInt(params.tmdbId, 10) || 0;
  var type = params.type === "tv" ? "tv" : "movie";
  var season = parseInt(params.season, 10) || 1;
  var episode = parseInt(params.episode, 10) || 1;

  if (!tmdbId || tmdbId < 1) {
    return fail("invalid tmdbId");
  }

  try {
    // ── Step 1: Authenticate ──
    var token;
    try {
      token = await ensureSession();
    } catch (e) {
      return fail("auth: " + e.message);
    }

    // ── Step 2: Fetch stream sources from API ──
    var apiResult = await fetchStreamSources(
      tmdbId,
      type,
      season,
      episode,
      token,
    );

    if (!apiResult || !apiResult.sources || apiResult.sources.length === 0) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
        streams: [],
        latency_ms: Date.now() - start,
      };
    }

    // ── Step 3: Extract first working stream URL for playlist fetch ──
    var firstStream = null;
    var firstHeaders = null;

    for (var si = 0; si < apiResult.sources.length; si++) {
      var src = apiResult.sources[si];
      if (src.streams && src.streams.length > 0) {
        for (var si2 = 0; si2 < src.streams.length; si2++) {
          var st = src.streams[si2];
          if (st.url && st.url.indexOf("http") === 0) {
            firstStream = st.url;
            firstHeaders = st.headers || {};
            break;
          }
        }
      }
      if (firstStream) break;
    }

    // ── Step 4: Fetch HLS master playlist through the proxy ──
    var playlistContent = null;
    if (firstStream) {
      var plResult = await fetchProxiedPlaylist(firstStream, firstHeaders);
      playlistContent = plResult.content;
    }

    // ── Step 5: Build final stream list ──
    // Use firstStream (the vixcloud master playlist URL with token) as the
    // stream URL. The player fetches it directly — hls.js parses the master
    // playlist and discovers all video/audio/subtitle track URLs.
    //
    // 🔴 CRITICAL: We MUST return the MASTER PLAYLIST URL, NOT individual
    //    variant URLs. The master playlist contains #EXT-X-MEDIA:TYPE=AUDIO
    //    group references that let the player select the correct audio track.
    //    Individual variant playlists are VIDEO ONLY — no audio segments.
    var streams = buildStreams(
      apiResult,
      playlistContent,
      firstStream,
      firstHeaders,
    );

    if (streams.length === 0) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
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
