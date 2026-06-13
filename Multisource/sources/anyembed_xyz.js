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
async function httpGet(url, headers) {
  var raw = await globalThis.http_get(url, headers || {});
  if (typeof raw === "string") return raw;
  if (raw && raw.body) {
    if (typeof raw.body === "string") return raw.body;
    if (typeof raw.body === "object") return JSON.stringify(raw.body);
  }
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

function extractAudioTracks(m3u8Content) {
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
        tracks.push({
          url: urlMatch[1],
          label: (nameMatch && nameMatch[1]) || "Unknown",
          lang: (langMatch && langMatch[1]) || "en",
          default: defaultMatch && defaultMatch[1] === "YES",
        });
      }
    }
  }
  return tracks;
}

function parseSubtitleTracks(m3u8Content) {
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
        tracks.push({
          url: urlMatch[1],
          label: (nameMatch && nameMatch[1]) || "Subtitle",
          lang: (langMatch && langMatch[1]) || "en",
        });
      }
    }
  }
  return tracks;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

var SOURCE_NAME = "anyembed.xyz";
var API_BASE = "https://api.anyembed.xyz";
var BASE_URL = "https://anyembed.xyz";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
var PROVIDERS = [
  "streamingcommunity",
  "moviesapi",
  "gojara",
  "lookm",
  "purstream",
];

var API_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Origin: BASE_URL,
  Referer: BASE_URL + "/embed/tmdb-movie-550",
};

function apiGet(url, headers) {
  return httpGet(url, Object.assign({}, API_HEADERS, headers || {}));
}

function apiPost(url, headers, body) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error("timeout"));
    }, 15e3);
    function onResult(r) {
      clearTimeout(timer);
      resolve(r && r.body ? r.body : String(r || ""));
    }
    function onError(e) {
      clearTimeout(timer);
      reject(e);
    }
    try {
      var reqHeaders = Object.assign(
        {},
        API_HEADERS,
        {
          "Content-Type": "application/json",
        },
        headers || {},
      );
      var result = http_post(url, reqHeaders, body || "{}", onResult);
      if (result && typeof result.then === "function") {
        result.then(onResult).catch(onError);
      }
    } catch (e) {
      onError(e);
    }
  });
}

var _sessionToken = null;
var _sessionExpires = 0;

async function ensureSession() {
  if (_sessionToken && Date.now() < _sessionExpires) {
    return _sessionToken;
  }
  try {
    var guestBody = await apiPost(API_BASE + "/api/auth/guest", {}, "{}");
    var guestData = safeJsonParse(guestBody);
    if (!guestData || !guestData.success) {
      throw new Error("guest auth failed");
    }
  } catch (e) {
    throw e;
  }
  try {
    var sessBody = await apiGet(API_BASE + "/api/v1/session", {});
    var sessData = safeJsonParse(sessBody);
    if (!sessData || !sessData.success || !sessData.token) {
      throw new Error("session token fetch failed");
    }
    _sessionToken = sessData.token;
    _sessionExpires = Date.now() + (sessData.expires_in || 60) * 1e3 - 5e3;
    return _sessionToken;
  } catch (e) {
    _sessionToken = null;
    _sessionExpires = 0;
    throw e;
  }
}

function isMasterUrl(url) {
  return url.indexOf("master.m3u8") !== -1 || url.indexOf("/playlist/") !== -1;
}

async function tryFetchM3U8(url, headers) {
  try {
    var raw = await httpGet(url, headers || {});
    if (raw && raw.indexOf("#EXTM3U") !== -1) return raw;
  } catch (e) {}
  return null;
}

async function fetchAllProviderSources(tmdbId, type, season, episode, token) {
  var qs = "?is_tv=" + (type === "tv");
  if (type === "tv") {
    qs += "&season=" + season + "&episode=" + episode;
  }
  var authHeaders = {
    Authorization: "Bearer " + token,
  };
  var allSources = [];
  var mergedSubs = [];
  var seenSubUrls = {};

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
      if (data.retryAfter) {
        await sleep(data.retryAfter * 1e3);
        continue;
      }
      if (data.error || !data.success) continue;
      if (data.sources && data.sources.length > 0) {
        for (var si = 0; si < data.sources.length; si++) {
          var src = data.sources[si];
          if (!src.streams || src.streams.length === 0) continue;
          var enriched = {
            provider: provider,
            name: src.name || provider,
            streams: [],
          };
          for (var sj = 0; sj < src.streams.length; sj++) {
            var st = src.streams[sj];
            if (!st.url || st.url.indexOf("http") !== 0) continue;
            if (st.subtitles && st.subtitles.length > 0) {
              for (var sk = 0; sk < st.subtitles.length; sk++) {
                var sub = st.subtitles[sk];
                var subKey = sub.url || sub.label || sub.lang;
                if (sub.url && !seenSubUrls[sub.url]) {
                  seenSubUrls[sub.url] = true;
                  mergedSubs.push(sub);
                } else if (!sub.url && !seenSubUrls[subKey]) {
                  seenSubUrls[subKey] = true;
                  mergedSubs.push(sub);
                }
              }
            }
            enriched.streams.push({
              url: st.url,
              quality: st.quality || extractQuality(st.url) || "",
              headers: st.headers || {},
            });
          }
          if (enriched.streams.length > 0) {
            allSources.push(enriched);
          }
        }
      }
    } catch (e) {}
  }

  return { sources: allSources, subtitles: mergedSubs };
}

async function buildStreams(sourcesData, mergedSubtitles) {
  var streams = [];
  var seenUrls = {};
  var ts = Date.now();

  for (var si = 0; si < sourcesData.length; si++) {
    var src = sourcesData[si];
    for (var sj = 0; sj < src.streams.length; sj++) {
      var st = src.streams[sj];
      if (!st.url || seenUrls[st.url]) continue;
      seenUrls[st.url] = true;

      var entry = {
        url: st.url,
        source: SOURCE_NAME,
        quality: st.quality || "Auto",
        headers: {
          "User-Agent": UA,
        },
      };
      if (st.headers) {
        entry.headers.Referer =
          st.headers.Referer || st.headers.referer || entry.headers.Referer;
        entry.headers.Origin =
          st.headers.Origin || st.headers.origin || entry.headers.Origin;
        if (st.headers["user-agent"] || st.headers["User-Agent"]) {
          entry.headers["User-Agent"] =
            st.headers["user-agent"] || st.headers["User-Agent"];
        }
      }
      if (mergedSubtitles.length > 0) {
        entry.subtitles = mergedSubtitles;
      }
      entry._provider = src.provider;
      streams.push(entry);
    }
  }

  var masterStreams = [];

  for (var si2 = 0; si2 < streams.length; si2++) {
    var st2 = streams[si2];
    if (isMasterUrl(st2.url)) {
      var masterContent = null;
      try {
        masterContent = await tryFetchM3U8(st2.url, st2.headers);
      } catch (e) {}

      if (masterContent && masterContent.indexOf("#EXT-X-STREAM-INF") !== -1) {
        var variants = parseM3U8AllQualities(masterContent, st2.url);
        var audioTracks = extractAudioTracks(masterContent);
        var subsFromMaster = parseSubtitleTracks(masterContent);

        if (variants.length > 0) {
          var fromMaster = [];
          for (var vi = 0; vi < variants.length; vi++) {
            var v = variants[vi];
            var vUrl = st2.url + "#" + v.quality + "-" + ts;
            var ve = {
              url: vUrl,
              source: SOURCE_NAME,
              quality: v.quality,
              headers: st2.headers,
              subtitles:
                subsFromMaster.length > 0
                  ? subsFromMaster
                  : mergedSubtitles.length > 0
                    ? mergedSubtitles
                    : undefined,
            };
            if (audioTracks.length > 0) {
              ve.audio = audioTracks;
            }
            fromMaster.push(ve);
          }
          masterStreams = masterStreams.concat(fromMaster);
          continue;
        }
      }
    }
    masterStreams.push(st2);
  }

  if (masterStreams.length > 0) {
    var deduped = [];
    var dedupSeen = {};
    for (var di = 0; di < masterStreams.length; di++) {
      var ds = masterStreams[di];
      var key = ds.quality + "|" + ds.url.split("#")[0];
      if (dedupSeen[key]) continue;
      dedupSeen[key] = true;
      deduped.push(ds);
    }
    return deduped;
  }

  return streams;
}

async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = parseInt(params.tmdbId, 10) || 0;
  var type = params.type === "tv" ? "tv" : "movie";
  var season = parseInt(params.season, 10) || 1;
  var episode = parseInt(params.episode, 10) || 1;
  if (!tmdbId || tmdbId < 1) {
    return makeFail(SOURCE_NAME, "invalid tmdbId", start);
  }
  try {
    var token;
    try {
      token = await ensureSession();
    } catch (e) {
      return makeFail(SOURCE_NAME, "auth: " + e.message, start);
    }
    var apiData = await fetchAllProviderSources(
      tmdbId,
      type,
      season,
      episode,
      token,
    );
    if (!apiData || !apiData.sources || apiData.sources.length === 0) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
        streams: [],
        latency_ms: Date.now() - start,
      };
    }

    var streams = await buildStreams(apiData.sources, apiData.subtitles);

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
    return makeFail(SOURCE_NAME, e.message || String(e), start);
  }
}

module.exports = {
  name: SOURCE_NAME,
  scrapeStreams: scrapeStreams,
};
