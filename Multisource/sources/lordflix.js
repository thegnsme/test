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
function resolveRelativeUrl(baseUrl, relativePath) {
  if (!baseUrl) return relativePath;
  if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
  if (relativePath.indexOf("/") === 0) {
    var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
    return (originMatch ? originMatch[1] : "") + relativePath;
  }
  return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}
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
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
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

var SOURCE_NAME = "lordflix";

var LORDFLIX_API = "https://snowhouse.lordflix.club";

var ENC_DEC_API = "https://enc-dec.app/api";

var SERVERS = [
  "Berlin",
  "Marseille",
  "Backrooms",
  "Phoenix",
  "Oslo",
  "Luna",
  "Sakura",
  "Rio",
  "Ativa",
  "Moscow",
];

var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error((label || "request") + " timeout"));
      }, ms);
    }),
  ]);
}

function extractCodecs(streamInfLine) {
  var m = streamInfLine.match(/CODECS="([^"]+)"/i);
  return m ? m[1] : "";
}

function enc(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, "+");
}

async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = params.tmdbId;
  var type = params.type;
  var season = params.season;
  var episode = params.episode;
  try {
    var meta = await fetchTmdbMeta(tmdbId, type);
    if (!meta || !meta.title || !meta.imdb_id) {
      return fail("TMDB metadata missing — need title and imdb_id");
    }
    var typeParam = type === "tv" ? "series" : "movie";
    var streams = [];
    var serverErrors = [];
    var results = await Promise.allSettled(
      SERVERS.map(function (server) {
        var serverPromise = queryServer(
          tmdbId,
          type,
          typeParam,
          meta.title,
          meta.year,
          meta.imdb_id,
          season,
          episode,
          server,
          start,
        );
        var perServerTimeout = new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error(server + " timeout (12s)"));
          }, 12e3);
        });
        return Promise.race([serverPromise, perServerTimeout]);
      }),
    );
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.status === "fulfilled" && r.value && r.value.length > 0) {
        for (var j = 0; j < r.value.length; j++) {
          streams.push(r.value[j]);
        }
      } else if (r.status === "rejected") {
        serverErrors.push(SERVERS[i] + ": " + (r.reason && r.reason.message));
      }
    }
    if (streams.length === 0) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
        error: serverErrors.join("; ") || "all servers returned no streams",
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

async function queryServer(
  tmdbId,
  type,
  typeParam,
  title,
  year,
  imdbId,
  season,
  episode,
  server,
  start,
) {
  try {
    var serverUrl =
      LORDFLIX_API +
      "/?title=" +
      enc(title) +
      "&type=" +
      enc(typeParam) +
      "&year=" +
      enc(year || "") +
      "&imdb=" +
      enc(imdbId) +
      "&tmdb=" +
      tmdbId +
      "&server=" +
      enc(server);
    if (type === "tv") {
      serverUrl += "&season=" + season + "&episode=" + episode;
    }
    var encResp = await withTimeout(
      httpGet(ENC_DEC_API + "/enc-lordflix?url=" + enc(serverUrl), {
        "User-Agent": UA,
        Accept: "application/json",
        Origin: "https://lordflix.org",
        Referer: "https://lordflix.org/",
      }),
      8e3,
      server + " encrypt",
    );
    var encData;
    try {
      encData = JSON.parse(encResp);
    } catch (e) {
      return [];
    }
    if (!encData || encData.status !== 200 || !encData.result) {
      return [];
    }
    var proxyUrl = encData.result.url;
    var signature = encData.result.sign;
    if (!proxyUrl || !signature) {
      return [];
    }
    var encryptedData = await withTimeout(
      httpGet(proxyUrl, {
        "User-Agent": UA,
        Accept: "*/*",
        Referer: LORDFLIX_API + "/",
        Origin: LORDFLIX_API,
      }),
      8e3,
      server + " proxy",
    );
    if (!encryptedData || encryptedData.length < 10) {
      return [];
    }
    var decResp = await withTimeout(
      httpPost(
        ENC_DEC_API + "/dec-lordflix",
        {
          "Content-Type": "application/json",
          "User-Agent": UA,
        },
        JSON.stringify({
          text: encryptedData,
          sign: signature,
        }),
      ),
      8e3,
      server + " decrypt",
    );
    var decData;
    try {
      decData = JSON.parse(decResp);
    } catch (e) {
      return [];
    }
    if (
      !decData ||
      decData.status !== 200 ||
      !decData.result ||
      decData.result.error
    ) {
      return [];
    }
    var streamList = decData.result.stream;
    if (!Array.isArray(streamList) || streamList.length === 0) {
      return [];
    }
    var result = [];
    for (var i = 0; i < streamList.length; i++) {
      var s = streamList[i];
      if (s.type !== "hls" || !s.playlist) continue;
      var streamHeaders = {
        "User-Agent": UA,
        Referer: LORDFLIX_API + "/",
        Origin: LORDFLIX_API,
        Accept: "*/*",
      };
      var variantEntries = [];
      var audioEntry = null;
      try {
        var m3u8Fetch = httpGet(s.playlist, {
          "User-Agent": UA,
          Referer: LORDFLIX_API + "/",
          Accept: "*/*",
        });
        var m3u8Timeout = new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("m3u8 timeout"));
          }, 8e3);
        });
        var m3u8Content = await Promise.race([m3u8Fetch, m3u8Timeout]);
        if (m3u8Content && m3u8Content.indexOf("#EXTM3U") !== -1) {
          var lines = m3u8Content.split("\n");
          var hasStreamInf = false;
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            if (line.indexOf("#EXT-X-STREAM-INF:") !== -1) {
              hasStreamInf = true;
              var resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
              var height = resMatch ? parseInt(resMatch[1], 10) : 0;
              var codecs = extractCodecs(line);
              var codecLabel = "";
              if (codecs) {
                var c = String(codecs).toLowerCase();
                if (c.indexOf("hev1") !== -1 || c.indexOf("hvc1") !== -1)
                  codecLabel = "HEVC";
                else if (c.indexOf("dvh1") !== -1 || c.indexOf("dvhe") !== -1)
                  codecLabel = "DV";
                else if (c.indexOf("av01") !== -1 || c.indexOf("dav1") !== -1)
                  codecLabel = "AV1";
                else if (c.indexOf("avc1") !== -1) codecLabel = "H.264";
                else codecLabel = codecs;
              }
              if (li + 1 < lines.length) {
                var urlPart = lines[li + 1].trim();
                if (urlPart && urlPart.indexOf("#") !== 0) {
                  var fullUrl =
                    urlPart.indexOf("http") === 0
                      ? urlPart
                      : resolveRelativeUrl(s.playlist, urlPart);
                  variantEntries.push({
                    url: fullUrl,
                    quality:
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
                                    : "Auto",
                    codecLabel: codecLabel,
                    height: height,
                  });
                }
              }
            }
            if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
              var auUrlMatch = line.match(/URI="([^"]+)"/);
              if (auUrlMatch && auUrlMatch[1]) {
                var audioUrl = auUrlMatch[1];
                if (audioUrl.indexOf("http") !== 0) {
                  audioUrl = resolveRelativeUrl(s.playlist, audioUrl);
                }
                var auLangMatch = line.match(/LANGUAGE="([^"]+)"/);
                var auNameMatch = line.match(/NAME="([^"]+)"/);
                audioEntry = {
                  url: audioUrl,
                  label:
                    auNameMatch && auNameMatch[1] ? auNameMatch[1] : "Audio",
                  lang: auLangMatch && auLangMatch[1] ? auLangMatch[1] : "en",
                };
              }
            }
          }
          if (!hasStreamInf && !audioEntry) {
            var q = s.quality || extractQuality(s.playlist) || "Auto";
            result.push({
              url: s.playlist,
              quality: q,
              headers: streamHeaders,
            });
            continue;
          }
        }
      } catch (e) {}
      if (variantEntries.length > 0) {
        variantEntries.sort(function (a, b) {
          return b.height - a.height;
        });
        for (var vi = 0; vi < variantEntries.length; vi++) {
          var ve = variantEntries[vi];
          var label = ve.quality;
          if (ve.codecLabel) label += " [" + ve.codecLabel + "]";
          result.push({
            url: s.playlist + "#" + ve.quality + "-" + Date.now(),
            quality: label,
            headers: streamHeaders,
          });
        }
        result.push({
          url: s.playlist,
          quality: extractQuality(s.playlist) || "Auto",
          headers: streamHeaders,
        });
      } else {
        result.push({
          url: s.playlist,
          quality: s.quality || extractQuality(s.playlist) || "Auto",
          headers: streamHeaders,
        });
      }
    }
    return result;
  } catch (e) {
    return [];
  }
}

function extractQuality(url) {
  var u = String(url || "");
  var m = u.match(/(2160p|1440p|1080p|720p|480p|360p)/i);
  if (m) return m[1].toLowerCase();
  if (/\b4k\b/i.test(u)) return "4K";
  return "";
}

module.exports = {
  name: SOURCE_NAME,
  scrapeStreams: scrapeStreams,
};
