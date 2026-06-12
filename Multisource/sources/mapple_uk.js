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
function qualityLabel(h) {
  if (h >= 2160) return "2160p";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  return h ? h + "p" : "Auto";
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
function parseM3U8AllQualities(m3u8Content, baseUrl) {
  if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) return [];
  var lines = m3u8Content.split("\n");
  var results = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
      var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
      var height = resMatch ? parseInt(resMatch[1], 10) : 0;
      if (i + 1 < lines.length) {
        var urlPart = lines[i + 1].trim();
        if (urlPart && urlPart.indexOf("#") !== 0) {
          var fullUrl =
            urlPart.indexOf("http") === 0
              ? urlPart
              : resolveRelativeUrl(baseUrl, urlPart);
          results.push({
            url: fullUrl,
            quality: qualityLabel(height),
            height: height,
          });
        }
      }
    }
  }
  results.sort(function (a, b) {
    return b.height - a.height;
  });
  return results;
}
function m3u8ToStreams(m3u8Content, baseUrl, extraHeaders) {
  var variants = parseM3U8AllQualities(m3u8Content, baseUrl);
  if (variants.length > 0) {
    var streams = [];
    for (var vi = 0; vi < variants.length; vi++) {
      var v = variants[vi];
      var stream = {
        url: v.url,
        quality: v.quality,
        headers: copyHeaders(extraHeaders),
      };
      if (baseUrl && (!stream.headers.Referer || stream.headers.Referer === ""))
        stream.headers.Referer = baseUrl;
      streams.push(stream);
    }
    return streams;
  }
  if (m3u8Content && m3u8Content.indexOf("#EXTM3U") !== -1)
    return [{ url: baseUrl, quality: "Auto", headers: extraHeaders || {} }];
  return [];
}
async function fetchM3U8AndParse(playlistUrl, reqHeaders, streamHeaders) {
  try {
    var resp = await httpGetRaw(playlistUrl, reqHeaders || {});
    if (!resp.body || resp.body.length < 20) return [];
    return m3u8ToStreams(resp.body, playlistUrl, streamHeaders || reqHeaders);
  } catch (e) {
    return [];
  }
}

var SOURCE_NAME = "mapple.uk";

var BASE_URL = "https://mapple.uk";

var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function httpGetRaw(url, reqHeaders) {
  var resp = await globalThis.http_get(url, reqHeaders || {});
  return {
    body: resp.body || "",
    headers: resp.headers || {},
    status: resp.status || resp.statusCode || 0,
  };
}

async function httpPostRaw(url, reqHeaders, body) {
  var resp = await globalThis.http_post(url, reqHeaders || {}, body || "");
  return {
    body: resp.body || "",
    headers: resp.headers || {},
    status: resp.status || resp.statusCode || 0,
  };
}

function buildWatchUrl(tmdbId, type, season, episode) {
  if (type === "tv" && season != null && episode != null) {
    return BASE_URL + "/watch/tv/" + tmdbId + "-" + season + "-" + episode;
  }
  return BASE_URL + "/watch/movie/" + tmdbId;
}

async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = String(params.tmdbId);
  var type = params.type || "movie";
  var season = params.season;
  var episode = params.episode;
  try {
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
    var tokenMatch = pageResp.body.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
    var requestToken = tokenMatch ? tokenMatch[1] : null;
    if (!requestToken) {
      return makeFail(
        SOURCE_NAME,
        "__REQUEST_TOKEN__ not found in watch page",
        start,
      );
    }
    var cookie = "";
    if (pageResp.headers && pageResp.headers["set-cookie"]) {
      var rawCookies = pageResp.headers["set-cookie"];
      if (Array.isArray(rawCookies)) {
        cookie = rawCookies.join("; ");
      } else {
        cookie = String(rawCookies);
      }
    }
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
    var encryptedUrl = encData.url;
    if (encryptedUrl.indexOf("http") !== 0) {
      encryptedUrl = BASE_URL + encryptedUrl;
    }
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
    if (streams.length > 0) {
      return {
        source: SOURCE_NAME,
        status: "working",
        streams: streams,
        latency_ms: Date.now() - start,
      };
    }
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

module.exports = {
  name: SOURCE_NAME,
  scrapeStreams: scrapeStreams,
};
