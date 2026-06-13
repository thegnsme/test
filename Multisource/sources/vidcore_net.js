function makeFail(src, msg, start) {
  return {
    source: src,
    status: "error",
    error: msg || "unknown",
    streams: [],
    latency_ms: Date.now() - (start || Date.now()),
  };
}

function httpGet(url, headers) {
  return globalThis.http_get(url, headers || {});
}

function scrubHttpResp(raw) {
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
  return "";
}

function resolveUrl(url, base) {
  if (!url) return "";
  if (url.indexOf("http") === 0 || url.indexOf("https") === 0) return url;
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.indexOf("/") === 0) {
    var m = (base || "https://vidcore.net").match(/^(https?:\/\/[^/]+)/);
    return (m ? m[1] : "https://vidcore.net") + url;
  }
  return (base || "https://vidcore.net").replace(/\/[^/]*$/, "/") + url;
}

var SOURCE_NAME = "vidcore.net";
var EMBED_BASE = "https://vidcore.net";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function scrapeStreams(opts) {
  var start = Date.now();
  var tmdbId = opts.tmdbId;
  var type = opts.type === "tv" || opts.type === "series" ? "tv" : "movie";
  var season = parseInt(opts.season, 10) || 1;
  var episode = parseInt(opts.episode, 10) || 1;

  if (!tmdbId) {
    return makeFail(SOURCE_NAME, "no tmdbId provided", start);
  }

  try {
    var embedUrl;
    if (type === "tv") {
      embedUrl = EMBED_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode;
    } else {
      embedUrl = EMBED_BASE + "/movie/" + tmdbId;
    }

    var sep = embedUrl.indexOf("?") === -1 ? "?" : "&";
    embedUrl += sep + "autoPlay=true";

    var embedHtml = await httpGet(embedUrl, {
      "User-Agent": UA,
      Referer: EMBED_BASE + "/",
      Accept: "text/html,application/xhtml+xml",
    });
    embedHtml = scrubHttpResp(embedHtml);

    var streams = [];

    streams.push({
      url: embedUrl,
      quality: "Auto",
      headers: {
        "User-Agent": UA,
        Referer: EMBED_BASE + "/",
      },
    });

    if (embedHtml && embedHtml.length > 100) {
      var dataSrcMatch = embedHtml.match(
        /iframe[^>]*data-src=["']([^"']+)["']/i,
      );
      if (dataSrcMatch && dataSrcMatch[1]) {
        var dataSrc = resolveUrl(dataSrcMatch[1], embedUrl);
        streams.push({
          url: dataSrc,
          quality: "Auto",
          headers: {
            "User-Agent": UA,
            Referer: embedUrl,
          },
        });
      }

      var iframeSrcMatch = embedHtml.match(
        /<iframe[^>]*\ssrc=["']([^"']+)["']/i,
      );
      if (iframeSrcMatch && iframeSrcMatch[1]) {
        var iframeSrc = resolveUrl(iframeSrcMatch[1], embedUrl);
        if (iframeSrc !== embedUrl && iframeSrc.indexOf(EMBED_BASE) !== -1) {
          streams.push({
            url: iframeSrc,
            quality: "Auto",
            headers: {
              "User-Agent": UA,
              Referer: embedUrl,
            },
          });
        }
      }

      var m3u8Match = embedHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
      if (m3u8Match && m3u8Match[0]) {
        streams.push({
          url: m3u8Match[0],
          quality: "Auto",
          headers: {
            "User-Agent": UA,
            Referer: embedUrl,
            Origin: EMBED_BASE,
          },
        });
      }
    }

    if (streams.length > 0) {
      return {
        source: SOURCE_NAME,
        status: "working",
        streams: streams,
        latency_ms: Date.now() - start,
      };
    }

    return makeFail(SOURCE_NAME, "no streams found", start);
  } catch (e) {
    var fallbackUrl =
      (type === "tv"
        ? EMBED_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode
        : EMBED_BASE + "/movie/" + tmdbId) + "?autoPlay=true";

    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: fallbackUrl,
          quality: "Auto",
          headers: {
            "User-Agent": UA,
            Referer: EMBED_BASE + "/",
          },
        },
      ],
      latency_ms: Date.now() - start,
    };
  }
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
