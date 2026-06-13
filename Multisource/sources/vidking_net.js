/**
 * VidKing Source for Skystream MultiSource Plugin
 *
 * Extracts DDL, M3U8 HLS streams, and direct video links from vidking.net
 *
 * Architecture:
 *   vidking.net is a React SPA video player that uses the same backend
 *   infrastructure as videasy.to (api.videasy.to). It supports 4 server
 *   backends: Oxygen, Hydrogen, Lithium, Helium.
 *
 * Flow:
 *   1. Fetch TMDB metadata (title, year, imdb_id)
 *   2. Call api.videasy.to with multiple server fallbacks
 *   3. Decrypt response using enc-dec.app
 *   4. Parse decrypted streams into StreamResult objects
 *   5. Extract M3U8 multi-quality variants when available
 *   6. Fallback: return embed URL as playable stream
 *
 * @module sources/vidking_net
 */

"use strict";

// ─── Helper Functions ───────────────────────────────────────────────────────

function safeJsonParse(str) {
  if (!str || typeof str !== "string") return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
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

function qualityRank(q) {
  var qs = String(q || "").toLowerCase();
  if (qs.indexOf("2160") !== -1 || qs === "4k") return 7;
  if (qs.indexOf("1440") !== -1 || qs === "2k") return 6;
  if (qs.indexOf("1080") !== -1) return 5;
  if (qs.indexOf("720") !== -1) return 4;
  if (qs.indexOf("480") !== -1) return 3;
  if (qs.indexOf("360") !== -1) return 2;
  if (qs.indexOf("240") !== -1) return 1;
  return 0;
}

function isValidStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.indexOf("https://") !== 0 && url.indexOf("http://") !== 0)
    return false;
  var hostMatch = url.match(/^https?:\/\/([^/]+)/);
  if (!hostMatch) return false;
  var host = hostMatch[1].toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.indexOf("169.254.") === 0 ||
    host.indexOf("10.") === 0 ||
    host.indexOf("172.16.") === 0 ||
    host.indexOf("192.168.") === 0
  ) {
    return false;
  }
  return true;
}

function resolveRelativeUrl(baseUrl, relativePath) {
  if (!baseUrl) return relativePath;
  if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
  if (relativePath.indexOf("/") === 0) {
    var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
    return (originMatch ? originMatch[1] : "") + relativePath;
  }
  return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}

function copyHeaders(obj) {
  if (!obj || typeof obj !== "object") return {};
  var out = {};
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k))
      if (obj[k] != null) out[k] = obj[k];
  }
  return out;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

var REQUEST_TIMEOUT = 15000;
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function httpGet(url, headers) {
  var raw = await globalThis.http_get(url, headers || {});
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
  return "";
}

async function httpPost(url, headers, body) {
  var raw = await globalThis.http_post(url, headers || {}, body || "");
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
  return "";
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error((label || "request") + " timeout after " + ms + "ms"));
      }, ms);
    }),
  ]);
}

// ─── Subtitle Parsing from M3U8 ─────────────────────────────────────────────

function extractSubtitlesFromM3U8(m3u8Content, playlistUrl) {
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

// ─── TMDB Metadata ──────────────────────────────────────────────────────────

var TMDB_KEYS = [
  "68e094699525b18a70bab2f86b1fa706",
  "af3a53eb387d57fc935e9128468b1899",
  "0142a22c560ce3efb1cfd6f3b2faab77",
];
var _tmdbIdx = 0;
function tmdbKey() {
  return TMDB_KEYS[_tmdbIdx++ % TMDB_KEYS.length];
}

var _metaCache = {};
async function fetchTmdbMeta(tmdbId, type) {
  var key = String(tmdbId) + ":" + (type || "movie");
  if (_metaCache[key] !== undefined) return _metaCache[key];
  try {
    var endpoint = type === "tv" ? "/tv/" : "/movie/";
    var url =
      "https://api.themoviedb.org/3" +
      endpoint +
      String(tmdbId) +
      "?api_key=" +
      tmdbKey() +
      "&append_to_response=external_ids";
    var resp = await httpGet(url, {
      "User-Agent": UA,
      Accept: "application/json",
    });
    var data = safeJsonParse(resp);
    if (!data) {
      _metaCache[key] = null;
      return null;
    }
    var title = data.title || data.name || "";
    var date = data.release_date || data.first_air_date || "";
    var year = date ? date.split("-")[0] : "";
    var imdbId =
      data.external_ids && data.external_ids.imdb_id
        ? data.external_ids.imdb_id
        : data.imdb_id || "";
    var result = { title: title, year: year, imdb_id: imdbId };
    _metaCache[key] = result;
    return result;
  } catch (e) {
    return null;
  }
}

// ─── Source Configuration ───────────────────────────────────────────────────

var SOURCE_NAME = "vidking.net";

var VIDKING_BASE = "https://www.vidking.net";
var VIDEO_API_BASE = "https://api.videasy.to";
var DECRYPT_API = "https://enc-dec.app/api/dec-videasy";

/**
 * Server backends supported by VidKing infrastructure.
 * Tried in order: Oxygen → Hydrogen → Lithium → Helium
 * Hydrogen is the most reliable (same as videasy.to)
 */
var SERVERS = [
  {
    name: "Oxygen",
    endpoint: "mb-flix/sources-with-title",
    isActive: true,
  },
  {
    name: "Hydrogen",
    endpoint: "cdn/sources-with-title",
    isActive: true,
  },
  {
    name: "Lithium",
    endpoint: "downloader2/sources-with-title",
    isActive: true,
  },
  {
    name: "Helium",
    endpoint: "1movies/sources-with-title",
    isActive: true,
  },
];

var SERVER_NAMES = SERVERS.map(function (s) {
  return s.name;
});

var HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Origin: VIDKING_BASE,
  Referer: VIDKING_BASE + "/",
};

// ─── API Functions ──────────────────────────────────────────────────────────

/**
 * Build the API URL for a given server and content parameters.
 */
function buildApiUrl(serverEndpoint, params) {
  var url = VIDEO_API_BASE + "/" + serverEndpoint;

  var queryParts = [];
  queryParts.push("title=" + encodeURIComponent(params.title || ""));
  queryParts.push("mediaType=" + encodeURIComponent(params.type));
  queryParts.push("year=" + encodeURIComponent(params.year || ""));
  queryParts.push("tmdbId=" + encodeURIComponent(String(params.tmdbId)));
  queryParts.push("imdbId=" + encodeURIComponent(params.imdbId || ""));
  queryParts.push("seasonId=" + encodeURIComponent(String(params.season || 1)));
  queryParts.push(
    "episodeId=" + encodeURIComponent(String(params.episode || 1)),
  );

  // Add cache-busting timestamp
  queryParts.push("_t=" + Date.now());

  return url + "?" + queryParts.join("&");
}

/**
 * Try to fetch encrypted sources from a single server.
 * @returns {{ name: string, text: string }|null} Object with server name and encrypted text, or null on failure.
 */
async function trySingleServer(server, params) {
  var apiUrl = buildApiUrl(server.endpoint, params);
  try {
    var resp = await withTimeout(
      httpGet(apiUrl, {
        "User-Agent": UA,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Origin: VIDKING_BASE,
        Referer: VIDKING_BASE + "/",
      }),
      REQUEST_TIMEOUT,
      server.name + " api",
    );
    if (!resp || resp.length < 10) return null;
    return { name: server.name, text: resp };
  } catch (e) {
    return null;
  }
}

/**
 * Fetch encrypted sources from ALL servers in parallel.
 * Returns an array of successful { name, text } objects (0 to 4).
 *
 * @param {Object} params - Content parameters with title, type, year, tmdbId, etc.
 * @returns {Promise<Array<{name:string, text:string}>>}
 */
async function tryAllServers(params) {
  var promises = [];
  for (var si = 0; si < SERVERS.length; si++) {
    var server = SERVERS[si];
    if (!server.isActive) continue;
    console.log("[VidKing] Fetching " + server.name + " server...");
    promises.push(trySingleServer(server, params));
  }

  // Fire all servers in parallel
  var settled = await Promise.allSettled(promises);

  var results = [];
  for (var ri = 0; ri < settled.length; ri++) {
    var s = settled[ri];
    if (
      s.status === "fulfilled" &&
      s.value &&
      s.value.text &&
      s.value.text.length >= 10
    ) {
      results.push(s.value);
      console.log(
        "[VidKing] " +
          s.value.name +
          " responded (" +
          s.value.text.length +
          " chars)",
      );
    }
  }

  // Log which servers failed
  var successNames = results.map(function (r) {
    return r.name;
  });
  for (var si2 = 0; si2 < SERVERS.length; si2++) {
    if (
      SERVERS[si2].isActive &&
      successNames.indexOf(SERVERS[si2].name) === -1
    ) {
      console.log("[VidKing] " + SERVERS[si2].name + " did not respond");
    }
  }

  return results;
}

/**
 * Decrypt a single API response using enc-dec.app.
 * The encrypted text from api.videasy.to uses the same format
 * as videasy.to, so enc-dec.app/api/dec-videasy can decrypt it.
 *
 * @returns {{ name: string, result: Object }|null} Object with server name and decrypted result, or null.
 */
async function decryptSingleResponse(encryptedText, tmdbId, serverName) {
  if (!encryptedText || encryptedText.length < 10) return null;
  try {
    var decryptRaw = await withTimeout(
      httpPost(
        DECRYPT_API,
        { "Content-Type": "application/json", "User-Agent": UA },
        JSON.stringify({ text: encryptedText, id: String(tmdbId) }),
      ),
      REQUEST_TIMEOUT,
      "decrypt " + (serverName || ""),
    );
    var decryptData = safeJsonParse(decryptRaw);
    if (!decryptData || decryptData.status !== 200 || !decryptData.result) {
      return null;
    }
    return { name: serverName, result: decryptData.result };
  } catch (e) {
    return null;
  }
}

/**
 * Decrypt multiple server responses in parallel.
 *
 * @param {Array<{name:string, text:string}>} serverResponses - Output from tryAllServers
 * @param {number|string} tmdbId
 * @returns {Promise<Array<{name:string, result:Object}>>} Array of successful decryptions
 */
async function decryptAllResponses(serverResponses, tmdbId) {
  if (!serverResponses || serverResponses.length === 0) return [];

  var decryptPromises = [];
  for (var i = 0; i < serverResponses.length; i++) {
    var sr = serverResponses[i];
    console.log("[VidKing] Decrypting " + sr.name + " response...");
    decryptPromises.push(decryptSingleResponse(sr.text, tmdbId, sr.name));
  }

  var decrypted = await Promise.allSettled(decryptPromises);

  var results = [];
  for (var ri = 0; ri < decrypted.length; ri++) {
    var d = decrypted[ri];
    if (d.status === "fulfilled" && d.value && d.value.result) {
      results.push(d.value);
      console.log("[VidKing] " + d.value.name + " decrypted successfully");
    }
  }

  return results;
}

/**
 * Merge streams from multiple server results into a single deduplicated array.
 * Streams from earlier servers in the list take priority on URL conflict.
 *
 * @param {Array<{name:string, result:Object}>} decryptedResults - Array of {name, result} from decryptAllResponses
 * @returns {Promise<Array>} Unified array of stream objects
 */
async function mergeServerResults(decryptedResults) {
  if (!decryptedResults || decryptedResults.length === 0) return [];

  // Build streams from each server, then merge with dedup
  var allStreams = [];
  var seenUrls = {};
  var serverContributions = {};

  for (var ri = 0; ri < decryptedResults.length; ri++) {
    var dr = decryptedResults[ri];
    if (!dr || !dr.result) continue;

    var serverName = dr.name || "Unknown";
    var rawSources = dr.result.sources || [];
    var rawSubtitles = dr.result.subtitles || [];

    if (rawSources.length === 0) continue;

    // Build streams from this server's result using the existing builder
    var serverStreams = await buildStreamsFromResult(
      { sources: rawSources, subtitles: rawSubtitles },
      { tmdbId: 0, type: "" }, // params not used by buildStreamsFromResult currently
    );

    // Tag each stream with its source server and deduplicate
    var deduped = [];
    for (var si = 0; si < serverStreams.length; si++) {
      var stream = serverStreams[si];
      if (seenUrls[stream.url]) continue;
      seenUrls[stream.url] = true;

      // Add server attribution for debugging
      stream.sourceServer = serverName;

      deduped.push(stream);
    }

    if (deduped.length > 0) {
      serverContributions[serverName] = deduped.length;
      allStreams = allStreams.concat(deduped);
    }
  }

  // Log server contribution summary
  var contribMsg = Object.keys(serverContributions)
    .map(function (sn) {
      return sn + ": " + serverContributions[sn] + " streams";
    })
    .join(", ");
  if (contribMsg) {
    console.log("[VidKing] Server contributions: " + contribMsg);
  }

  return allStreams;
}

/**
 * Extract codec label from #EXT-X-STREAM-INF line for display.
 */
function extractCodecLabel(streamInfLine) {
  var m = streamInfLine.match(/CODECS="([^"]+)"/i);
  if (!m) return "";
  var codecs = String(m[1]).toLowerCase();
  if (codecs.indexOf("hev1") !== -1 || codecs.indexOf("hvc1") !== -1)
    return "HEVC";
  if (codecs.indexOf("dvh1") !== -1 || codecs.indexOf("dvhe") !== -1)
    return "DV";
  if (codecs.indexOf("av01") !== -1 || codecs.indexOf("dav1") !== -1)
    return "AV1";
  if (codecs.indexOf("avc1") !== -1) return "H.264";
  return "";
}

/**
 * Fetch an M3U8 playlist, parse it for multi-quality variants,
 * and return expanded stream objects.
 *
 * If the playlist is a master with #EXT-X-STREAM-INF entries, returns
 * one stream per resolution variant plus the master as "Auto".
 * If it's a simple playlist, returns just the original URL.
 *
 * @param {string} playlistUrl - URL of the M3U8 playlist
 * @param {Object} streamHeaders - Headers to include in stream requests
 * @param {number} m3u8FetchTimeout - Timeout for fetching the playlist
 * @returns {Promise<Array>} Array of stream objects { url, quality, headers, subtitles? }
 */
async function expandM3U8Variants(
  playlistUrl,
  streamHeaders,
  m3u8FetchTimeout,
) {
  m3u8FetchTimeout = m3u8FetchTimeout || 10000;
  var result = [];

  try {
    var m3u8Content = await withTimeout(
      httpGet(playlistUrl, {
        "User-Agent": UA,
        Referer: VIDKING_BASE + "/",
        Accept: "*/*",
      }),
      m3u8FetchTimeout,
      "m3u8 fetch",
    );

    if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
      // Not a valid playlist—return the original URL as-is
      return null;
    }

    // Check if this is a master playlist with quality variants
    if (m3u8Content.indexOf("#EXT-X-STREAM-INF:") === -1) {
      // Simple single-quality playlist—return as-is
      return null;
    }

    var lines = m3u8Content.split("\n");
    var variantEntries = [];
    var subtitleTracks = [];
    var audioEntry = null;

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];

      // ── Parse variant quality streams ──
      if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
        var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
        var height = resMatch ? parseInt(resMatch[1], 10) : 0;
        var codecLabel = extractCodecLabel(line);

        if (li + 1 < lines.length) {
          var urlPart = lines[li + 1].trim();
          if (urlPart && urlPart.indexOf("#") !== 0) {
            var fullUrl =
              urlPart.indexOf("http") === 0
                ? urlPart
                : resolveRelativeUrl(playlistUrl, urlPart);

            var qualityTag =
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

            // Append codec label if notable
            if (codecLabel) qualityTag += " [" + codecLabel + "]";

            variantEntries.push({
              url: fullUrl,
              quality: qualityTag,
              height: height,
            });
          }
        }
      }

      // ── Parse subtitle tracks ──
      if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
        var subUrlMatch = line.match(/URI="([^"]+)"/);
        var subLangMatch = line.match(/LANGUAGE="([^"]+)"/);
        var subNameMatch = line.match(/NAME="([^"]+)"/);
        if (subUrlMatch && subUrlMatch[1]) {
          var subUrl = subUrlMatch[1];
          if (subUrl.indexOf("http") !== 0) {
            subUrl = resolveRelativeUrl(playlistUrl, subUrl);
          }
          subtitleTracks.push({
            url: subUrl,
            label: (subNameMatch && subNameMatch[1]) || "Subtitle",
            lang: (subLangMatch && subLangMatch[1]) || "en",
          });
        }
      }

      // ── Parse audio tracks ──
      if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
        var auUrlMatch = line.match(/URI="([^"]+)"/);
        var auLangMatch = line.match(/LANGUAGE="([^"]+)"/);
        var auNameMatch = line.match(/NAME="([^"]+)"/);
        if (auUrlMatch && auUrlMatch[1]) {
          var audioUrl = auUrlMatch[1];
          if (audioUrl.indexOf("http") !== 0) {
            audioUrl = resolveRelativeUrl(playlistUrl, audioUrl);
          }
          audioEntry = {
            url: audioUrl,
            label: (auNameMatch && auNameMatch[1]) || "Audio",
            lang: (auLangMatch && auLangMatch[1]) || "en",
          };
        }
      }
    }

    // Build the result: one stream per variant + the master playlist
    if (variantEntries.length > 0) {
      // Sort by quality descending (highest first)
      variantEntries.sort(function (a, b) {
        return b.height - a.height;
      });

      var ts = Date.now();

      for (var vi = 0; vi < variantEntries.length; vi++) {
        var ve = variantEntries[vi];
        var streamObj = {
          url: ve.url,
          quality: ve.quality,
          headers: copyHeaders(streamHeaders),
        };
        if (subtitleTracks.length > 0) {
          streamObj.subtitles = subtitleTracks;
        }
        result.push(streamObj);
      }

      // Also add the master playlist URL as "Auto" quality
      // (appends a timestamp suffix to differentiate it from variants)
      var masterEntry = {
        url: playlistUrl /* + "#master-" + ts */,
        quality: "Auto",
        headers: copyHeaders(streamHeaders),
      };
      if (subtitleTracks.length > 0) {
        masterEntry.subtitles = subtitleTracks;
      }
      result.push(masterEntry);

      return result;
    }
  } catch (e) {
    // M3U8 fetch/parse failed—caller will fall back to original URL
    return null;
  }

  return null;
}

/**
 * Normalize a quality string to a standard label.
 */
/**
 * Build streams from the decrypted API result with full M3U8 variant expansion.
 *
 * For each source returned by the API:
 *   - If it's an M3U8 URL, fetch the playlist and expand into all
 *     resolution variants (1080p, 720p, 480p, etc.)
 *   - If it's a direct video URL, return it as a single stream
 *   - Subtitles from the API response are attached to all streams
 *
 * @param {Object} result - Decrypted API response with sources & subtitles
 * @param {Object} params - Content parameters (tmdbId, type, etc.)
 * @returns {Promise<Array>} Array of expanded stream objects
 */
async function buildStreamsFromResult(result, params) {
  if (!result) return [];

  var rawSources = result.sources || [];
  var rawSubtitles = result.subtitles || [];
  var subs = [];

  // ── Normalize API-level subtitles ──
  var seenSubs = {};
  for (var j = 0; j < rawSubtitles.length; j++) {
    var sub = rawSubtitles[j];
    if (!sub || !sub.url) continue;
    if (seenSubs[sub.url]) continue;
    seenSubs[sub.url] = true;
    var subLabel = sub.language || sub.lang || sub.label || "Unknown";
    subs.push({
      url: sub.url,
      label: subLabel,
      lang: sub.language || sub.lang || "",
    });
  }
  if (subs.length > 30) {
    subs = subs.slice(0, 30);
  }

  // ── Phase 1: Fire all M3U8 expansions in parallel ──
  var m3u8ExpansionPromises = [];
  var playlistSources = [];

  for (var i = 0; i < rawSources.length; i++) {
    var s = rawSources[i];
    if (!s || !s.url) continue;
    if (!isValidStreamUrl(s.url)) continue;

    if (
      s.url.indexOf(".m3u8") !== -1 ||
      s.url.indexOf(".m3u") !== -1 ||
      s.url.indexOf("playlist") !== -1 ||
      s.url.indexOf("m3u8") !== -1
    ) {
      playlistSources.push(s);
    }
  }

  for (var pi = 0; pi < playlistSources.length; pi++) {
    var ps = playlistSources[pi];
    var streamHeaders = {
      "User-Agent": UA,
      Referer: VIDKING_BASE + "/",
      Origin: VIDKING_BASE,
      Accept: "*/*",
    };
    m3u8ExpansionPromises.push(
      expandM3U8Variants(ps.url, streamHeaders, 10000),
    );
  }

  var expansionResults = [];
  if (m3u8ExpansionPromises.length > 0) {
    expansionResults = await Promise.all(m3u8ExpansionPromises);
  }

  // ── Phase 2: Merge results with dedup ──
  var allStreams = [];
  var seenUrls = {};

  for (var ri = 0; ri < expansionResults.length; ri++) {
    var expanded = expansionResults[ri];
    if (!expanded || expanded.length === 0) {
      // M3U8 expansion failed — fall back to the original playlist URL
      var fallbackSrc = playlistSources[ri];
      var fallbackUrl = fallbackSrc && fallbackSrc.url;
      if (fallbackUrl && !seenUrls[fallbackUrl]) {
        seenUrls[fallbackUrl] = true;
        var streamHeaders = {
          "User-Agent": UA,
          Referer: VIDKING_BASE + "/",
          Origin: VIDKING_BASE,
          Accept: "*/*",
        };
        // Preserve API-provided quality when M3U8 expansion fails
        var fbQuality =
          fallbackSrc && fallbackSrc.quality
            ? normalizeQuality(fallbackSrc.quality)
            : extractQuality(fallbackUrl) || "Auto";
        allStreams.push({
          url: fallbackUrl,
          quality: fbQuality,
          headers: streamHeaders,
          subtitles: subs.length > 0 ? subs : undefined,
        });
      }
      continue;
    }

    for (var ei = 0; ei < expanded.length; ei++) {
      var exp = expanded[ei];
      if (seenUrls[exp.url]) continue;
      seenUrls[exp.url] = true;

      // Attach API subtitles if M3U8 doesn't have its own
      if (!exp.subtitles || exp.subtitles.length === 0) {
        if (subs.length > 0) {
          exp.subtitles = subs;
        }
      }

      allStreams.push(exp);
    }
  }

  // ── Phase 3: Non-playlist sources (direct URLs) ──
  for (var di = 0; di < rawSources.length; di++) {
    var ds = rawSources[di];
    if (!ds || !ds.url) continue;
    if (!isValidStreamUrl(ds.url)) continue;

    if (
      ds.url.indexOf(".m3u8") !== -1 ||
      ds.url.indexOf(".m3u") !== -1 ||
      ds.url.indexOf("playlist") !== -1 ||
      ds.url.indexOf("m3u8") !== -1
    ) {
      continue; // Already handled in Phase 1/2
    }

    if (seenUrls[ds.url]) continue;
    seenUrls[ds.url] = true;

    var quality = ds.quality
      ? normalizeQuality(ds.quality)
      : extractQuality(ds.url) || "Auto";

    var streamObj = {
      url: ds.url,
      quality: quality,
      headers: {
        "User-Agent": UA,
        Referer: VIDKING_BASE + "/",
        Origin: VIDKING_BASE,
        Accept: "*/*",
      },
    };

    if (subs.length > 0) {
      streamObj.subtitles = subs;
    }

    allStreams.push(streamObj);
  }

  return allStreams;
}

function normalizeQuality(q) {
  if (!q) return "";
  var qs = String(q).toLowerCase().trim();
  if (qs === "4k" || qs === "2160" || qs === "2160p") return "2160p";
  if (qs === "2k" || qs === "1440" || qs === "1440p" || qs === "qhd")
    return "1440p";
  if (qs === "hd" || qs === "1080" || qs === "1080p") return "1080p";
  if (qs === "hq" || qs === "720" || qs === "720p") return "720p";
  if (qs === "sd" || qs === "480" || qs === "480p") return "480p";
  if (qs === "360" || qs === "360p") return "360p";
  if (qs === "240" || qs === "240p") return "240p";
  return q;
}

/**
 * Try to extract direct M3U8 URLs from VidKing embed page HTML.
 * This is a secondary extraction method that works when the
 * API route fails.
 */
async function extractFromEmbedPage(tmdbId, type, season, episode) {
  try {
    var embedUrl = embedPageUrl(tmdbId, type, season, episode);

    var html = await withTimeout(
      httpGet(embedUrl, {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        Referer: VIDKING_BASE + "/",
      }),
      REQUEST_TIMEOUT,
      "embed page",
    );

    if (!html || html.length < 100) return null;

    // Look for M3U8 URLs in the page HTML
    var m3u8Urls = [];
    var m3u8Regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
    var match;
    while ((match = m3u8Regex.exec(html)) !== null) {
      var url = match[0];
      // Filter out garbage URLs
      if (url.length > 20 && url.indexOf(".m3u8") !== -1) {
        m3u8Urls.push(url);
      }
    }

    if (m3u8Urls.length > 0) {
      var streams = [];
      var embedHeaders = {
        "User-Agent": UA,
        Referer: VIDKING_BASE + "/",
        Origin: VIDKING_BASE,
      };

      // Try to expand each M3U8 URL into quality variants
      for (var i = 0; i < m3u8Urls.length; i++) {
        var expanded = await expandM3U8Variants(
          m3u8Urls[i],
          embedHeaders,
          8000,
        );
        if (expanded && expanded.length > 0) {
          for (var ei = 0; ei < expanded.length; ei++) {
            streams.push(expanded[ei]);
          }
        } else {
          streams.push({
            url: m3u8Urls[i],
            quality: extractQuality(m3u8Urls[i]) || "Auto",
            headers: embedHeaders,
          });
        }
      }

      return {
        source: SOURCE_NAME,
        status: "working",
        streams: streams,
        latency_ms: 0, // will be set by caller
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Build an embed page URL for the VidKing player.
 */
function embedPageUrl(tmdbId, type, season, episode) {
  return type === "tv"
    ? VIDKING_BASE +
        "/embed/tv/" +
        String(tmdbId) +
        "/" +
        (season || 1) +
        "/" +
        (episode || 1)
    : VIDKING_BASE + "/embed/movie/" + String(tmdbId);
}

/**
 * Shared embed-fallback helper: tries extractFromEmbedPage, then falls back
 * to a raw embed-URL stream as a last resort.
 *
 * @returns {Object|null} A source result object, or null if both fail.
 */
async function tryEmbedFallback(tmdbId, type, season, episode, start) {
  var embedResult = await extractFromEmbedPage(tmdbId, type, season, episode);
  if (embedResult) {
    embedResult.latency_ms = Date.now() - start;
    return embedResult;
  }
  // Last resort: return the embed URL itself as a playable stream
  try {
    var embedUrl = embedPageUrl(tmdbId, type, season, episode);
    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: embedUrl,
          quality: "Auto",
          headers: {
            "User-Agent": UA,
            Referer: VIDKING_BASE + "/",
          },
        },
      ],
      latency_ms: Date.now() - start,
    };
  } catch (_) {
    return null;
  }
}

// ─── Main Scrape Function ───────────────────────────────────────────────────

/**
 * Scrape streams from vidking.net for the given content.
 *
 * Architecture:
 *   1. Fetch TMDB metadata for title/year/imdb_id (cached)
 *   2. Fire ALL 4 API servers in parallel via Promise.allSettled
 *   3. Decrypt ALL successful server responses in parallel
 *   4. Merge/dedup streams from all servers with source attribution
 *   5. Expand M3U8 master playlists into multi-quality variants
 *   6. Sort by quality descending
 *   7. Fallback to embed page if all servers fail
 *
 * @param {Object} params - The parameters object
 * @param {number} params.tmdbId - TMDB ID of the content
 * @param {string} params.type - "movie" or "tv"
 * @param {number} [params.season] - Season number (for TV)
 * @param {number} [params.episode] - Episode number (for TV)
 * @returns {Object} Source result with streams
 */
async function scrapeStreams(params) {
  var start = Date.now();
  if (!params || typeof params !== "object") {
    return makeFail(SOURCE_NAME, "invalid parameters: expected object", start);
  }
  var tmdbId = params.tmdbId;
  var type = params.type;
  var season = params.season || 1;
  var episode = params.episode || 1;

  if (!tmdbId) {
    return makeFail(SOURCE_NAME, "no tmdbId provided", start);
  }

  // ── Shared fallback helper for all failure paths ──
  async function fallback(errMsg) {
    console.log("[VidKing] " + errMsg + ", trying embed fallback");
    var fb = await tryEmbedFallback(tmdbId, type, season, episode, start);
    if (fb) return fb;
    return makeFail(SOURCE_NAME, errMsg, start);
  }

  try {
    // ── Step 1: Fetch TMDB metadata ──
    var meta = await fetchTmdbMeta(tmdbId, type);
    if (!meta || !meta.title) {
      return await fallback("TMDB metadata required");
    }

    // Log metadata for debugging
    console.log(
      "[VidKing] " +
        meta.title +
        " (" +
        (meta.year || "N/A") +
        ") imdb:" +
        (meta.imdb_id || "N/A") +
        " tmdb:" +
        tmdbId +
        " " +
        type +
        (type === "tv" ? " S" + season + "E" + episode : ""),
    );

    // ── Step 2: Fetch ALL servers in PARALLEL ──
    var apiParams = {
      title: meta.title,
      type: type,
      year: meta.year,
      tmdbId: tmdbId,
      imdbId: meta.imdb_id || "",
      season: season,
      episode: episode,
    };

    var serverResponses = await tryAllServers(apiParams);

    if (serverResponses.length === 0) {
      return await fallback("all 4 API servers failed");
    }

    // ── Step 3: Decrypt ALL responses in PARALLEL ──
    var decryptedResults = await decryptAllResponses(serverResponses, tmdbId);

    if (decryptedResults.length === 0) {
      return await fallback("all server responses failed decryption");
    }

    // ── Step 4: Merge streams from ALL servers (with dedup) ──
    var streams = await mergeServerResults(decryptedResults);

    // ── Step 5: Sort by quality descending ──
    streams.sort(function (a, b) {
      return qualityRank(b.quality) - qualityRank(a.quality);
    });

    if (streams.length === 0) {
      return await fallback("no valid stream URLs from any server");
    }

    // ── Log summary ──
    var serverSummary = decryptedResults
      .map(function (d) {
        return d.name;
      })
      .join(", ");
    var totalSubs = 0;
    for (var si = 0; si < streams.length; si++) {
      if (streams[si].subtitles) totalSubs += streams[si].subtitles.length;
    }

    console.log(
      "[VidKing] ✓ " +
        streams.length +
        " streams from " +
        serverSummary +
        " (" +
        (Date.now() - start) +
        "ms)" +
        (totalSubs > 0 ? " + ~" + totalSubs + " subtitle tracks" : ""),
    );

    return {
      source: SOURCE_NAME,
      status: "working",
      streams: streams,
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    console.log(
      "[VidKing] Error: " + (e && e.message) + ", trying embed fallback",
    );
    var fb = await tryEmbedFallback(tmdbId, type, season, episode, start);
    if (fb) return fb;
    return makeFail(SOURCE_NAME, e && e.message, start);
  }
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  name: SOURCE_NAME,
  scrapeStreams: scrapeStreams,
};
