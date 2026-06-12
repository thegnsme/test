function makeFail(src, msg, start) {
  return {
    source: src,
    status: "error",
    error: msg || "unknown",
    streams: [],
    latency_ms: Date.now() - (start || Date.now()),
  };
}
async function httpGet(url, headers) {
  var raw = await globalThis.http_get(url, headers || {});
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
  return "";
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
    var body = await httpGet(playlistUrl, reqHeaders || {});
    if (!body || body.length < 20) return [];
    return m3u8ToStreams(body, playlistUrl, streamHeaders || reqHeaders);
  } catch (e) {
    return [];
  }
}

var SOURCE_NAME = "vidlink.pro";

var ENC_API = "https://enc-dec.app/api/enc-vidlink";

var VIDLINK_API = "https://vidlink.pro/api/b";

var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = params.tmdbId;
  var type = params.type;
  var season = params.season;
  var episode = params.episode;
  try {
    var encResp = JSON.parse(
      await httpGet(ENC_API + "?text=" + encodeURIComponent(String(tmdbId)), {
        "User-Agent": UA,
        Accept: "application/json",
      }),
    );
    if (!encResp || encResp.status !== 200 || !encResp.result) {
      return fail("encryption failed");
    }
    var encId = encResp.result;
    var apiUrl =
      type === "movie"
        ? VIDLINK_API + "/movie/" + encId + "?multiLang=0"
        : VIDLINK_API +
          "/tv/" +
          encId +
          "/" +
          season +
          "/" +
          episode +
          "?multiLang=0";
    var streamData = JSON.parse(
      await httpGet(apiUrl, {
        "User-Agent": UA,
        Referer: "https://vidlink.pro/",
        Accept: "application/json",
      }),
    );
    if (!streamData || !streamData.stream || !streamData.stream.playlist) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
        streams: [],
        latency_ms: Date.now() - start,
      };
    }
    var playlistUrl = streamData.stream.playlist;
    var subs = [];
    if (streamData.stream.captions) {
      for (var i = 0; i < streamData.stream.captions.length; i++) {
        var c = streamData.stream.captions[i];
        var u = c.url || c.id || "";
        if (u) {
          subs.push({
            url: u,
            label:
              u.indexOf(".vtt") !== -1
                ? "VTT"
                : (c.type || "SRT").toUpperCase(),
            lang: c.language || c.label || "en",
          });
        }
      }
    }
    var streamHeaders = {
      "User-Agent": UA,
      Referer: "https://vidlink.pro/",
    };
    var m3u8Streams = await fetchM3U8AndParse(
      playlistUrl,
      streamHeaders,
      streamHeaders,
    );
    if (m3u8Streams && m3u8Streams.length > 0) {
      for (var si = 0; si < m3u8Streams.length; si++) {
        if (subs.length > 0) {
          m3u8Streams[si].subtitles = subs;
        }
      }
      return {
        source: SOURCE_NAME,
        status: "working",
        streams: m3u8Streams,
        latency_ms: Date.now() - start,
      };
    }
    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: playlistUrl,
          headers: streamHeaders,
          subtitles: subs.length > 0 ? subs : undefined,
        },
      ],
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
