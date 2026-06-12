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
async function httpGet(url, headers) {
  var raw = await globalThis.http_get(url, headers || {});
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
  return "";
}

var SOURCE_NAME = "apiplayer.ru";

var BASE_URL = "https://apiplayer.ru";

var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function parseMPlayerConfig(html) {
  if (!html) return null;
  var m = html.match(/window\.__MPLAYER__\s*=\s*({[\s\S]*?});/);
  if (!m || !m[1]) return null;
  try {
    var config = JSON.parse(m[1]);
    if (config && config.imdbId) {
      return {
        imdbId: config.imdbId,
        tmdbId: config.tmdbId,
        vidsrcProxyUrl: config.vidsrcProxyUrl || "",
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

function parseM3U8All(m3u8Content, baseUrl, headers) {
  if (!m3u8Content || m3u8Content.indexOf("#EXTM3U") === -1) {
    return null;
  }
  var lines = m3u8Content.split("\n");
  var streams = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
      var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
      var h = resMatch ? parseInt(resMatch[1], 10) : 0;
      if (i + 1 < lines.length) {
        var urlPart = lines[i + 1].trim();
        if (urlPart && urlPart.indexOf("#") !== 0) {
          var fullUrl;
          if (urlPart.indexOf("http") === 0) {
            fullUrl = urlPart;
          } else if (urlPart.indexOf("//") === 0) {
            fullUrl = "https:" + urlPart;
          } else if (urlPart.indexOf("/") === 0) {
            var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
            fullUrl =
              (originMatch ? originMatch[1] : "https://apiplayer.ru") + urlPart;
          } else {
            fullUrl = baseUrl.replace(/\/[^/]*$/, "/") + urlPart;
          }
          var q =
            h >= 2160
              ? "2160p"
              : h >= 1440
                ? "1440p"
                : h >= 1080
                  ? "1080p"
                  : h >= 720
                    ? "720p"
                    : h >= 480
                      ? "480p"
                      : h >= 360
                        ? "360p"
                        : h
                          ? h + "p"
                          : "Auto";
          streams.push({
            url: fullUrl,
            quality: q,
            headers: headers || {},
            height: h,
          });
        }
      }
    }
  }
  if (streams.length === 0) return null;
  streams.sort(function (a, b) {
    return b.height - a.height;
  });
  return streams;
}

async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = params.tmdbId;
  var type = params.type;
  var season = params.season;
  var episode = params.episode;
  try {
    var embedUrl;
    if (type === "tv") {
      embedUrl =
        BASE_URL + "/embed/tv/" + tmdbId + "/" + season + "/" + episode;
    } else {
      embedUrl = BASE_URL + "/embed/movie/" + tmdbId;
    }
    var embedHtml = await httpGet(embedUrl, {
      "User-Agent": UA,
      Referer: BASE_URL + "/",
      Accept: "text/html,application/xhtml+xml",
    });
    if (!embedHtml || embedHtml.length < 100) {
      return fail("embed page empty or blocked");
    }
    var config = parseMPlayerConfig(embedHtml);
    if (!config || !config.imdbId) {
      var imdbMatch = embedHtml.match(/["']imdbId["']\s*:\s*["'](tt\d+)["']/i);
      if (!imdbMatch) {
        return fail("could not extract IMDB ID from embed page");
      }
      config = {
        imdbId: imdbMatch[1],
        vidsrcProxyUrl: "",
      };
    }
    var imdbId = config.imdbId;
    var masterUrl;
    if (type === "tv") {
      masterUrl =
        BASE_URL + "/hls-proxy/master/" + imdbId + "/" + season + "/" + episode;
    } else {
      masterUrl = BASE_URL + "/hls-proxy/master/" + imdbId;
    }
    var playlistContent = await httpGet(masterUrl, {
      "User-Agent": UA,
      Referer: embedUrl,
      Accept: "*/*",
    });
    if (!playlistContent || playlistContent.length < 20) {
      return fail("master playlist empty");
    }
    var streamHeaders = {
      "User-Agent": UA,
      Referer: BASE_URL + "/",
    };
    var qualityStreams = parseM3U8All(
      playlistContent,
      masterUrl,
      streamHeaders,
    );
    if (qualityStreams && qualityStreams.length > 0) {
      return {
        source: SOURCE_NAME,
        status: "working",
        streams: qualityStreams,
        latency_ms: Date.now() - start,
      };
    }
    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: masterUrl,
          quality: extractQuality(masterUrl) || "Auto",
          headers: streamHeaders,
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
