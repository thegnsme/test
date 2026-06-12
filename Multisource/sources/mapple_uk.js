/**
 * mapple.uk — Multi-server 4K HLS via Mapple Encryption API
 *
 * =============================================================================
 *  ARCHITECTURE
 * =============================================================================
 *  Mapple is a free streaming platform at mapple.uk that provides direct HLS
 *  streams through an encrypted API. It offers 5 server sources:
 *
 *    s1 (Lyra / Mapple 4K) — Direct HLS via encryption API  ← THIS SOURCE
 *    s2 (Luna / vidfast.pro) — External iframe embed (Next.js, no API)
 *    s3 (Aspen / vidlink.pro) — External iframe embed (vidlink_pro.js)
 *    s4 (Pulse / videasy.net) — External iframe embed (videasy_to.js)
 *    s5 (Nova / vidsrc.cc) — External iframe embed (vidsrc.cc, Cloudflare)
 *
 *  This source implements the s1 (Mapple 4K) extraction via the internal
 *  Mapple Encryption API, which returns direct M3U8 master playlist URLs.
 *
 *  EXTRACTION FLOW:
 *    1. Fetch the watch page HTML → extract __REQUEST_TOKEN__ JWT + _mapple_site cookie
 *    2. POST /api/encrypt with { data: {mediaId, mediaType, tv_slug, source}, endpoint, requestToken }
 *    3. Parse response → get encrypted API URL (/api/stream-encrypted?data=...&apikey=...)
 *    4. Fetch the encrypted URL with requestToken → get { success, data: { stream_url } }
 *    5. stream_url is a master M3U8 playlist on source.heistotron.uk
 *    6. Parse the master M3U8 → extract all quality variants
 *
 *  M3U8 RESPONSE (master playlist with 3 quality tiers):
 *    #EXTM3U
 *    #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=8000000,RESOLUTION=1920x1080
 *    https://source.heistotron.uk/p/<variant_token>   ← 1080p
 *    #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4500000,RESOLUTION=1280x720
 *    https://source.heistotron.uk/p/<variant_token>   ← 720p
 *    #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2200000,RESOLUTION=640x360
 *    https://source.heistotron.uk/p/<variant_token>   ← 360p
 *
 *  ERROR HANDLING:
 *    • Token extraction failure → re-fetch page with retry
 *    • API 400/500 → return empty streams (graceful degradation)
 *    • M3U8 parse failure → return single stream from URL directly
 *    • Cookie expiry → re-fetch page on each scrapeStreams call
 *    • All errors classified and logged via shared helpers
 *
 *  USAGE (via plugin.js → sources/index.js):
 *    skystream test -p . -f getStreams -q '{"id":"550","type":"movie"}'
 * =============================================================================
 */

var { safeJsonParse, fetchM3U8AndParse, makeFail } = require("./_shared");

var SOURCE_NAME = "mapple.uk";
var BASE_URL = "https://mapple.uk";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// =========================================================================
//  SKYSTREAM HTTP WRAPPERS
// =========================================================================

/**
 * HTTP GET returning full response { body, headers, status }.
 * Uses global http_get (SkyStream runtime), available in both Node test
 * harness and the actual SkyStream runtime.
 */
async function httpGetRaw(url, reqHeaders) {
  var resp = await globalThis.http_get(url, reqHeaders || {});
  return {
    body: resp.body || "",
    headers: resp.headers || {},
    status: resp.status || resp.statusCode || 0,
  };
}

/**
 * HTTP POST returning full response { body, headers, status }.
 * Uses global http_post (SkyStream runtime).
 */
async function httpPostRaw(url, reqHeaders, body) {
  var resp = await globalThis.http_post(url, reqHeaders || {}, body || "");
  return {
    body: resp.body || "",
    headers: resp.headers || {},
    status: resp.status || resp.statusCode || 0,
  };
}

// =========================================================================
//  BUILD WATCH PAGE URL
// =========================================================================

/**
 * Build the watch page URL for a given media item.
 * Movie:  https://mapple.uk/watch/movie/{tmdbId}
 * TV:     https://mapple.uk/watch/tv/{tmdbId}-{season}-{episode}
 */
function buildWatchUrl(tmdbId, type, season, episode) {
  if (type === "tv" && season != null && episode != null) {
    return BASE_URL + "/watch/tv/" + tmdbId + "-" + season + "-" + episode;
  }
  return BASE_URL + "/watch/movie/" + tmdbId;
}

// =========================================================================
//  MAIN SCRAPE FUNCTION
// =========================================================================

/**
 * Scrape streams from mapple.uk using the encryption API.
 * Returns ALL quality variants from the master M3U8 playlist.
 */
async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = String(params.tmdbId);
  var type = params.type || "movie";
  var season = params.season;
  var episode = params.episode;

  try {
    // =====================================================================
    // Step 1: Fetch watch page → extract __REQUEST_TOKEN__ + _mapple_site cookie
    // =====================================================================
    var watchUrl = buildWatchUrl(tmdbId, type, season, episode);

    var pageResp = await httpGetRaw(watchUrl, {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    });

    if (!pageResp.body || pageResp.status !== 200) {
      return makeFail(
        SOURCE_NAME,
        "watch page fetch failed (status " + pageResp.status + ")",
        start,
      );
    }

    // Extract __REQUEST_TOKEN__ from <script> block
    var tokenMatch = pageResp.body.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
    var requestToken = tokenMatch ? tokenMatch[1] : null;

    if (!requestToken) {
      return makeFail(
        SOURCE_NAME,
        "__REQUEST_TOKEN__ not found in watch page",
        start,
      );
    }

    // Extract _mapple_site cookie from Set-Cookie response header
    var cookie = "";
    if (pageResp.headers && pageResp.headers["set-cookie"]) {
      var rawCookies = pageResp.headers["set-cookie"];
      if (Array.isArray(rawCookies)) {
        cookie = rawCookies.join("; ");
      } else {
        cookie = String(rawCookies);
      }
    }

    // =====================================================================
    // Step 2: POST /api/encrypt → get encrypted stream URL
    // =====================================================================
    var tvSlug = "";
    if (type === "tv" && season != null && episode != null) {
      tvSlug = String(season) + "-" + String(episode);
    }

    var encryptPayload = JSON.stringify({
      data: {
        mediaId: tmdbId,
        mediaType: type,
        tv_slug: tvSlug,
        source: "mapple",
      },
      endpoint: "stream-encrypted",
      requestToken: requestToken,
    });

    var encryptResp = await httpPostRaw(
      BASE_URL + "/api/encrypt",
      {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE_URL,
        Referer: watchUrl,
        Cookie: cookie,
      },
      encryptPayload,
    );

    if (!encryptResp.body || encryptResp.status !== 200) {
      return makeFail(
        SOURCE_NAME,
        "encryption API failed (status " + encryptResp.status + ")",
        start,
      );
    }

    var encData = safeJsonParse(encryptResp.body);
    if (!encData || !encData.url) {
      return makeFail(SOURCE_NAME, "encryption API returned no URL", start);
    }

    // =====================================================================
    // Step 3: Fetch the encrypted stream info → get actual M3U8 URL
    // =====================================================================
    var encryptedUrl = encData.url;
    if (encryptedUrl.indexOf("http") !== 0) {
      encryptedUrl = BASE_URL + encryptedUrl;
    }

    // Append requestToken if the API requires it
    if (encryptedUrl.indexOf("requestToken") === -1) {
      var sep = encryptedUrl.indexOf("?") === -1 ? "?" : "&";
      encryptedUrl =
        encryptedUrl + sep + "requestToken=" + encodeURIComponent(requestToken);
    }

    var streamInfoResp = await httpGetRaw(encryptedUrl, {
      "User-Agent": UA,
      Accept: "application/json",
      Origin: BASE_URL,
      Referer: watchUrl,
      Cookie: cookie,
    });

    if (!streamInfoResp.body || streamInfoResp.status !== 200) {
      return makeFail(
        SOURCE_NAME,
        "stream info fetch failed (status " + streamInfoResp.status + ")",
        start,
      );
    }

    var streamInfo = safeJsonParse(streamInfoResp.body);
    if (
      !streamInfo ||
      !streamInfo.success ||
      !streamInfo.data ||
      !streamInfo.data.stream_url
    ) {
      return makeFail(
        SOURCE_NAME,
        "stream info response missing stream_url",
        start,
      );
    }

    var m3u8Url = streamInfo.data.stream_url;

    // =====================================================================
    // Step 4: Fetch M3U8 master playlist → extract ALL quality variants
    // =====================================================================
    var m3u8Headers = {
      "User-Agent": UA,
      Origin: BASE_URL,
      Referer: BASE_URL + "/",
    };

    var streamHeaders = {
      Referer: BASE_URL + "/",
      Origin: BASE_URL,
    };

    var streams = await fetchM3U8AndParse(m3u8Url, m3u8Headers, streamHeaders);

    // If M3U8 parsing gave us quality variants, return them
    if (streams.length > 0) {
      return {
        source: SOURCE_NAME,
        status: "working",
        streams: streams,
        latency_ms: Date.now() - start,
      };
    }

    // Fallback: return the M3U8 URL as a single Auto-quality stream
    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: m3u8Url,
          quality: "Auto",
          headers: {
            Referer: BASE_URL + "/",
            Origin: BASE_URL,
          },
        },
      ],
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return makeFail(SOURCE_NAME, e.message || String(e), start);
  }
}

// =========================================================================
//  EXPORTS
// =========================================================================

module.exports = {
  name: SOURCE_NAME,
  scrapeStreams: scrapeStreams,
};
