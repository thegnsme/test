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

function apiGet(url, headers, timeout) {
  return httpGet(url, Object.assign({}, API_HEADERS, headers || {}))
    .then(function (body) {
      return body;
    })
    .catch(function (e) {
      throw e;
    });
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

async function fetchStreamSources(tmdbId, type, season, episode, token) {
  var qs = "?is_tv=" + (type === "tv");
  if (type === "tv") {
    qs += "&season=" + season + "&episode=" + episode;
  }
  var authHeaders = {
    Authorization: "Bearer " + token,
  };
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

async function fetchProxiedPlaylist(streamUrl, headers) {
  if (!streamUrl)
    return {
      content: null,
      proxyUrl: null,
    };
  try {
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
    var reqHeaders = {
      "User-Agent": UA,
      Accept: "*/*",
      Origin: "https://anyembed.xyz",
      Referer: "https://anyembed.xyz/",
    };
    var body = await httpGet(proxyUrl, reqHeaders);
    if (body && body.length > 50 && body.indexOf("#EXTM3U") !== -1) {
      return {
        content: body,
        proxyUrl: proxyUrl,
      };
    }
    return {
      content: null,
      proxyUrl: null,
    };
  } catch (e) {
    return {
      content: null,
      proxyUrl: null,
    };
  }
}

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

function isProxyUrl(url) {
  return (
    typeof url === "string" && url.indexOf("api.anyembed.xyz/api/proxy") !== -1
  );
}

function streamHeaders(url, sourceHeaders) {
  var h = {
    "User-Agent": UA,
  };
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

function buildStreams(
  apiResult,
  playlistContent,
  playlistUrl,
  playlistHeaders,
) {
  var streams = [];
  var seenUrls = {};
  if (!apiResult || !apiResult.sources) return streams;
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
    var variants = parseM3U8AllQualities(playlistContent, playlistUrl);
    var playlistSubs = parseSubtitleTracks(playlistContent, playlistUrl);
    var audioTracks = extractAudioTracks(playlistContent, playlistUrl);
    if (variants.length > 0) {
      var ts = Date.now();
      for (var vi = 0; vi < variants.length; vi++) {
        var v = variants[vi];
        var vUrl = playlistUrl + "#" + v.quality + "-" + ts;
        var entry = {
          url: vUrl,
          quality: v.quality,
          headers: streamHeaders(playlistUrl, playlistHeaders),
        };
        if (playlistSubs.length > 0) {
          entry.subtitles = playlistSubs;
        } else if (apiSubtitles.length > 0) {
          entry.subtitles = apiSubtitles;
        }
        if (audioTracks.length > 0) {
          entry.audio = audioTracks;
        }
        streams.push(entry);
      }
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

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

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
    var token;
    try {
      token = await ensureSession();
    } catch (e) {
      return fail("auth: " + e.message);
    }
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
    var playlistContent = null;
    if (firstStream) {
      var plResult = await fetchProxiedPlaylist(firstStream, firstHeaders);
      playlistContent = plResult.content;
    }
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
