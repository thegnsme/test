function makeFail(src, msg, start) {
  return {
    source: src,
    status: "error",
    error: msg || "unknown",
    streams: [],
    latency_ms: Date.now() - (start || Date.now()),
  };
}
function safeJsonParse(str) {
  if (!str || typeof str !== "string") return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}
function withTimeout(promise, ms, label) {
  var timer = null;
  var timeoutPromise = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      reject(new Error(label + " timeout after " + ms + "ms"));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).then(function (r) {
    clearTimeout(timer);
    return r;
  });
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

var SOURCE_NAME = "vixsrc";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var MAIN_URL = "https://vixsrc.to";

function getApiUrl(tmdbId, type, season, episode) {
  if (type === "movie") {
    return MAIN_URL + "/api/movie/" + tmdbId + "?lang=en";
  }
  return (
    MAIN_URL +
    "/api/tv/" +
    tmdbId +
    "/" +
    (season || 1) +
    "/" +
    (episode || 1) +
    "?lang=en"
  );
}

function extractScriptVars(html) {
  var videoId = null;
  var token = null;
  var expires = null;
  var canPlayFHD = false;
  var streams = [];
  var m;

  m = html.match(/window\.video\s*=\s*\{[^}]*id\s*[:=]\s*'([^']+)'/);
  if (m && m[1]) videoId = m[1];

  m = html.match(/window\.canPlayFHD\s*=\s*true/);
  if (m) canPlayFHD = true;

  m = html.match(
    /window\.masterPlaylist\s*=\s*\{[^}]*params\s*:\s*\{[^}]*'token'\s*:\s*'([^']+)'/,
  );
  if (m && m[1]) token = m[1];

  m = html.match(
    /window\.masterPlaylist\s*=\s*\{[^}]*params\s*:\s*\{[^}]*'expires'\s*:\s*'([^']+)'/,
  );
  if (m && m[1]) expires = m[1];

  var sm = html.match(/window\.streams\s*=\s*(\[[^\]]+\])/);
  if (sm && sm[1]) {
    try {
      var parsed = JSON.parse(sm[1]);
      if (Array.isArray(parsed)) streams = parsed;
    } catch (e) {}
  }

  return {
    videoId: videoId,
    token: token,
    expires: expires,
    canPlayFHD: canPlayFHD,
    streams: streams,
  };
}

function parseMasterPlaylist(text, baseReferer) {
  var qualities = [];
  var subtitles = [];
  var audioTracks = [];
  var lines = text.split("\n");

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (line.indexOf("#EXT-X-STREAM-INF") !== -1) {
      var next = i + 1 < lines.length ? lines[i + 1] : "";
      var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      var bwMatch = line.match(/BANDWIDTH=(\d+)/);
      var url = next && next.indexOf("#") !== 0 ? next : "";
      var h = resMatch && resMatch[2] ? parseInt(resMatch[2], 10) : 0;
      var label = "";
      if (h >= 2160) label = "2160p";
      else if (h >= 1440) label = "1440p";
      else if (h >= 1080) label = "1080p";
      else if (h >= 720) label = "720p";
      else if (h >= 480) label = "480p";
      else if (h >= 360) label = "360p";
      else label = h + "p";

      if (url) {
        qualities.push({
          url: url,
          height: h,
          bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
          label: label,
        });
      }
    }

    if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") !== -1) {
      var langMatch = line.match(/LANGUAGE="([^"]+)"/);
      var nameMatch = line.match(/NAME="([^"]+)"/);
      var uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch && uriMatch[1]) {
        subtitles.push({
          url: uriMatch[1],
          lang: langMatch && langMatch[1] ? langMatch[1] : "Unknown",
          label: nameMatch && nameMatch[1] ? nameMatch[1] : "Unknown",
        });
      }
    }

    if (line.indexOf("#EXT-X-MEDIA:TYPE=AUDIO") !== -1) {
      var langMatch = line.match(/LANGUAGE="([^"]+)"/);
      var nameMatch = line.match(/NAME="([^"]+)"/);
      if (nameMatch && nameMatch[1]) {
        audioTracks.push({
          lang: langMatch && langMatch[1] ? langMatch[1] : "",
          label: nameMatch[1],
        });
      }
    }
  }

  var maxLabel = "Auto";
  for (var qi = 0; qi < qualities.length; qi++) {
    if (qualities[qi].height >= 2160) maxLabel = "2160p";
    else if (
      qualities[qi].height >= 1080 &&
      maxLabel !== "2160p" &&
      maxLabel !== "1440p"
    )
      maxLabel = "1080p";
    else if (qualities[qi].height >= 720 && maxLabel === "Auto")
      maxLabel = "720p";
    else if (qualities[qi].height >= 480 && maxLabel === "Auto")
      maxLabel = "480p";
  }

  return {
    qualities: qualities,
    subtitles: subtitles,
    audioTracks: audioTracks,
    maxLabel: maxLabel,
  };
}

async function fetchApi(apiUrl, retries) {
  retries = retries || 2;
  var lastErr = null;
  for (var attempt = 0; attempt < retries; attempt++) {
    try {
      var headers = {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        Referer: MAIN_URL + "/",
      };
      var raw = await withTimeout(
        httpGet(apiUrl, headers),
        10000,
        "vixsrc api",
      );
      var body = scrubHttpResp(raw);
      var data = safeJsonParse(body);
      if (data && data.src) {
        return data;
      }
      lastErr = "invalid api response: " + body.substring(0, 200);
    } catch (e) {
      lastErr = e.message || String(e);
      if (attempt < retries - 1) {
        await new Promise(function (r) {
          return setTimeout(r, 500 * (attempt + 1));
        });
      }
    }
  }
  throw new Error(lastErr || "api failed");
}

async function fetchEmbed(embedUrl) {
  var headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
    "X-Requested-With": "XMLHttpRequest",
    Referer: MAIN_URL + "/",
  };
  var raw = await withTimeout(
    httpGet(embedUrl, headers),
    15000,
    "vixsrc embed",
  );
  var body = scrubHttpResp(raw);
  if (
    body &&
    body.indexOf("window.video") !== -1 &&
    body.indexOf("An Error Occurred: Gone") === -1
  ) {
    return body;
  }
  if (body && body.indexOf("An Error Occurred: Gone") !== -1) {
    throw new Error("embed 410");
  }
  throw new Error(
    "embed invalid: " + (body ? body.substring(0, 120) : "empty"),
  );
}

async function fetchPlaylist(playlistUrl, referer, retries) {
  retries = retries || 2;
  var lastErr = null;
  for (var attempt = 0; attempt < retries; attempt++) {
    try {
      var headers = {
        "User-Agent": UA,
        Referer: referer,
      };
      var raw = await withTimeout(
        httpGet(playlistUrl, headers),
        15000,
        "vixsrc playlist",
      );
      var body = scrubHttpResp(raw);
      if (body && body.indexOf("#EXTM3U") !== -1) {
        return body;
      }
      lastErr = "invalid playlist: " + body.substring(0, 200);
    } catch (e) {
      lastErr = e.message || String(e);
      if (attempt < retries - 1) {
        await new Promise(function (r) {
          return setTimeout(r, 500 * (attempt + 1));
        });
      }
    }
  }
  throw new Error(lastErr || "playlist failed");
}

async function scrapeStreams(opts) {
  var start = Date.now();
  var tmdbId = opts.tmdbId;
  var type = opts.type || "movie";
  var season = opts.season;
  var episode = opts.episode;

  if (!tmdbId) {
    return makeFail(SOURCE_NAME, "no tmdbId provided", start);
  }

  try {
    var apiUrl = getApiUrl(tmdbId, type, season, episode);
    var apiData = await fetchApi(apiUrl, 3);

    var embedPath = apiData.src;
    if (embedPath.indexOf("/") !== 0) embedPath = "/" + embedPath;
    var embedUrl = MAIN_URL + embedPath;

    var embedHtml = "";
    try {
      embedHtml = await fetchEmbed(embedUrl);
    } catch (e1) {
      var retryData = await fetchApi(apiUrl, 3);
      var retryPath = retryData.src;
      if (retryPath.indexOf("/") !== 0) retryPath = "/" + retryPath;
      embedUrl = MAIN_URL + retryPath;
      embedHtml = await fetchEmbed(embedUrl);
    }

    var config = extractScriptVars(embedHtml);
    if (!config || !config.videoId || !config.token || !config.expires) {
      return makeFail(
        SOURCE_NAME,
        "failed to extract video config from embed page",
        start,
      );
    }

    var qsParams =
      "token=" +
      encodeURIComponent(config.token) +
      "&expires=" +
      encodeURIComponent(config.expires);
    if (config.canPlayFHD) qsParams += "&h=1";
    qsParams += "&lang=en";

    var playlistUrl = MAIN_URL + "/playlist/" + config.videoId + "?" + qsParams;

    var playlistText = await fetchPlaylist(playlistUrl, embedUrl, 2);
    var parsed = parseMasterPlaylist(playlistText, embedUrl);

    var streams = [];

    if (parsed.qualities.length > 0) {
      for (var qi = 0; qi < parsed.qualities.length; qi++) {
        var q = parsed.qualities[qi];
        var qUrl = q.url;
        if (qUrl.indexOf("http") !== 0) {
          if (qUrl.indexOf("/") === 0) {
            var slash3 = playlistUrl.indexOf("/", 8);
            qUrl = playlistUrl.substring(0, slash3) + qUrl;
          } else {
            var lastSlash = playlistUrl.lastIndexOf("/");
            qUrl = playlistUrl.substring(0, lastSlash + 1) + qUrl;
          }
        }
        streams.push({
          url: qUrl,
          source: SOURCE_NAME + " [" + q.label + "]",
          headers: {
            "User-Agent": UA,
            Referer: embedUrl,
          },
        });
      }
    }

    if (streams.length === 0) {
      var autoLabel = parsed.maxLabel || "Auto";
      streams.push({
        url: playlistUrl,
        source: SOURCE_NAME + " [" + autoLabel + "]",
        headers: {
          "User-Agent": UA,
          Referer: embedUrl,
        },
      });
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

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
