"use strict";
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
function resolveRelativeUrl(baseUrl, relativePath) {
  if (!baseUrl) return relativePath;
  if (relativePath.indexOf("//") === 0) return "https:" + relativePath;
  if (relativePath.indexOf("/") === 0) {
    var originMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
    return (originMatch ? originMatch[1] : "") + relativePath;
  }
  return baseUrl.replace(/\/[^/]*$/, "/") + relativePath;
}
function strToUtf8Bytes(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 128) {
      out.push(c);
    } else if (c < 2048) {
      out.push(192 | (c >> 6));
      out.push(128 | (c & 63));
    } else {
      out.push(224 | (c >> 12));
      out.push(128 | ((c >> 6) & 63));
      out.push(128 | (c & 63));
    }
  }
  return out;
}
function utf8BytesToStr(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}
var B64CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64encode(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i],
      b1 = bytes[i + 1] || 0,
      b2 = bytes[i + 2] || 0;
    out += B64CHARS[b0 >> 2];
    out += B64CHARS[((b0 << 4) | (b1 >> 4)) & 63];
    out += i + 1 < bytes.length ? B64CHARS[((b1 << 2) | (b2 >> 6)) & 63] : "=";
    out += i + 2 < bytes.length ? B64CHARS[b2 & 63] : "=";
  }
  return out;
}
function b64decode(s) {
  var map = {};
  for (var i = 0; i < 64; i++) map[B64CHARS[i]] = i;
  s = s.replace(/[^A-Za-z0-9+/=]/g, "");
  var out = [];
  for (var i = 0; i < s.length; i += 4) {
    var c0 = map[s[i]] || 0,
      c1 = map[s[i + 1]] || 0,
      c2 = map[s[i + 2]],
      c3 = map[s[i + 3]];
    out.push((c0 << 2) | (c1 >> 4));
    if (s[i + 2] && s[i + 2] !== "=" && c2 !== undefined)
      out.push(((c1 << 4) | (c2 >> 2)) & 255);
    if (s[i + 3] && s[i + 3] !== "=" && c3 !== undefined)
      out.push(((c2 << 6) | c3) & 255);
  }
  return out;
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
var SOURCE_NAME = "vidsrc";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
var HARDCODED_DOMAINS = [
  "vidsrcme.ru",
  "vidsrcme.su",
  "vidsrc-me.ru",
  "vidsrc-me.su",
  "vidsrc-embed.ru",
  "vidsrc-embed.su",
  "vsrc.su",
  "vsembed.ru",
  "vsembed.su",
];
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
async function fetchLiveDomains() {
  try {
    var html = await withTimeout(
      httpGet("https://vidsrc.domains/", { "User-Agent": UA }),
      8e3,
      "domains fetch",
    );
    if (!html) return null;
    var domains = [];
    var regex = /https:\/\/([a-zA-Z0-9.-]+)/g;
    var m;
    while ((m = regex.exec(html)) !== null) {
      var d = m[1];
      if (
        d.indexOf("vidsrc") !== -1 &&
        d !== "vidsrc.domains" &&
        d !== "vidsrc.community" &&
        domains.indexOf(d) === -1
      ) {
        domains.push(d);
      }
    }
    return domains.length > 0 ? domains : null;
  } catch (e) {
    return null;
  }
}
function buildEmbedUrl(domain, type, imdbId, tmdbId, season, episode) {
  var id = imdbId || String(tmdbId);
  if (type === "tv" && season && episode) {
    return (
      "https://" + domain + "/embed/tv/" + id + "/" + season + "-" + episode
    );
  }
  return "https://" + domain + "/embed/movie/" + id;
}
function extractServerHashes(html) {
  var servers = [];
  var regex =
    /<div\s+class="server"[^>]*data-hash="([^"]+)"[^>]*>([\s\S]*?)<\/div>/gi;
  var m;
  while ((m = regex.exec(html)) !== null) {
    var hash = m[1];
    var name = m[2] ? m[2].trim() : "";
    if (hash) servers.push({ hash: hash, name: name });
  }
  return servers.length > 0 ? servers : null;
}
function extractIframeSrc(html) {
  var m = html.match(/<iframe[^>]*src\s*=\s*["']([^"']+)["']/i);
  return m && m[1] ? m[1] : null;
}
var RC4_KEY1 = "8Qy3mlM2kod80XIK";
var RC4_KEY2 = "BgKVSrzpH2Enosgm";
var RC4_KEY_DECRYPT = "9jXDYBZUcTcTZveM";
function rc4Transform(keyBytes, dataBytes) {
  var s = new Array(256);
  for (var i = 0; i < 256; i++) s[i] = i;
  var j = 0;
  for (var i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) % 256;
    var tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  var k = 0;
  var result = new Array(dataBytes.length);
  for (var n = 0; n < dataBytes.length; n++) {
    j = (j + 1) % 256;
    k = (k + s[j]) % 256;
    var tmp = s[j];
    s[j] = s[k];
    s[k] = tmp;
    result[n] = dataBytes[n] ^ s[(s[j] + s[k]) % 256];
  }
  return result;
}
function rc4Slug(data, keyStr) {
  var keyBytes = strToUtf8Bytes(keyStr);
  var dataBytes = strToUtf8Bytes(String(data));
  var enc = rc4Transform(keyBytes, dataBytes);
  return b64encode(enc).replace(/[+=]/g, "");
}
function vrfDecrypt(vrfB64url) {
  try {
    var raw = vrfB64url.replace(/-/g, "+").replace(/_/g, "/");
    var data = b64decode(raw);
    var keyBytes = strToUtf8Bytes(RC4_KEY_DECRYPT);
    var dec = rc4Transform(keyBytes, data);
    var str = utf8BytesToStr(dec);
    try {
      str = decodeURIComponent(str);
    } catch (e) {}
    return safeJsonParse(str);
  } catch (e) {
    return null;
  }
}
async function tryMediainfoApi(domain, imdbId, tmdbId, type, season, episode) {
  try {
    var vidId = String(tmdbId);
    var slug = rc4Slug(vidId, RC4_KEY1);
    var h = rc4Slug(vidId, RC4_KEY2);
    var mediainfoUrl =
      "https://" +
      domain +
      "/mediainfo/" +
      slug +
      "?tmdb=1&autostart=true&ads=0&h=" +
      h;
    var resp = await withTimeout(
      httpGet(mediainfoUrl, {
        "User-Agent": UA,
        Accept: "application/json,text/plain,*/*",
        Referer: "https://" + domain + "/",
      }),
      10e3,
      domain + " mediainfo",
    );
    if (!resp || resp.indexOf("{") !== 0) return null;
    var parsed = safeJsonParse(resp);
    if (!parsed || !parsed.result) return null;
    var decrypted = vrfDecrypt(parsed.result);
    if (
      decrypted &&
      decrypted.sources &&
      decrypted.sources.length > 0 &&
      decrypted.sources[0].file
    ) {
      return decrypted.sources[0].file;
    }
  } catch (e) {}
  return null;
}
async function tryRcpExtraction(html, embedUrl) {
  try {
    var servers = extractServerHashes(html);
    if (!servers || servers.length === 0) return null;
    for (var si = 0; si < servers.length; si++) {
      var hash = servers[si].hash;
      try {
        var rcpUrl = "https://cloudorchestranova.com/rcp/" + hash;
        var resp = await withTimeout(
          httpGet(rcpUrl, {
            "User-Agent": UA,
            Accept: "text/html,*/*",
            Referer: embedUrl,
          }),
          8e3,
          "rcp",
        );
        if (resp && resp.indexOf("m3u8") !== -1) {
          var m3u8Match = resp.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
          if (m3u8Match) return m3u8Match[0];
        }
        if (resp && resp.indexOf("/prorcp/") !== -1) {
          var prorcpPart = resp.match(/\/prorcp\/([^"'\s]+)/);
          if (prorcpPart) {
            var prorcpUrl =
              "https://cloudorchestranova.com/prorcp/" + prorcpPart[1];
            var prorcpResp = await withTimeout(
              httpGet(prorcpUrl, {
                "User-Agent": UA,
                Accept: "*/*",
                Referer: rcpUrl,
              }),
              8e3,
              "prorcp",
            );
            var m3u8Match = prorcpResp
              ? prorcpResp.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i)
              : null;
            if (m3u8Match) return m3u8Match[0];
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}
function parseM3U8Master(content, baseUrl) {
  var streams = [];
  var lines = content.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
      var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      var height = resMatch ? parseInt(resMatch[2], 10) : 0;
      var codecMatch = line.match(/CODECS="([^"]+)"/i);
      var codecs = codecMatch ? codecMatch[1] : "";
      var quality =
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
      var codecLabel = "";
      if (codecs) {
        var c = codecs.toLowerCase();
        if (c.indexOf("hev1") !== -1 || c.indexOf("hvc1") !== -1)
          codecLabel = "HEVC";
        else if (c.indexOf("avc1") !== -1) codecLabel = "H.264";
        else if (c.indexOf("av01") !== -1) codecLabel = "AV1";
      }
      if (i + 1 < lines.length) {
        var urlPart = lines[i + 1].trim();
        if (urlPart && urlPart.indexOf("#") !== 0) {
          var fullUrl =
            urlPart.indexOf("http") === 0
              ? urlPart
              : resolveRelativeUrl(baseUrl, urlPart);
          streams.push({
            url: fullUrl,
            quality: quality,
            codecLabel: codecLabel,
            height: height,
          });
        }
      }
    }
  }
  streams.sort(function (a, b) {
    return b.height - a.height;
  });
  return streams;
}
async function fetchM3u8WithQualities(m3u8Url, referer) {
  try {
    var content = await withTimeout(
      httpGet(m3u8Url, {
        "User-Agent": UA,
        Accept: "*/*",
        Referer: referer,
      }),
      10e3,
      "m3u8 fetch",
    );
    if (!content || content.indexOf("#EXTM3U") === -1) {
      return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
    }
    if (content.indexOf("#EXT-X-STREAM-INF:") !== -1) {
      var parsed = await parseM3U8Master(content, m3u8Url);
      if (parsed.length > 0) return parsed;
    }
    return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
  } catch (e) {
    return [{ url: m3u8Url, quality: extractQuality(m3u8Url) || "Auto" }];
  }
}
async function scrapeStreams(params) {
  var start = Date.now();
  var tmdbId = params.tmdbId,
    type = params.type,
    season = params.season,
    episode = params.episode;
  try {
    var meta = await fetchTmdbMeta(tmdbId, type);
    if (!meta || !meta.title)
      return makeFail(SOURCE_NAME, "TMDB metadata missing", start);
    var imdbId = meta.imdb_id || "";
    var domainsToTry = null;
    try {
      var live = await fetchLiveDomains();
      if (live && live.length > 0) domainsToTry = live;
    } catch (e) {}
    if (!domainsToTry || domainsToTry.length === 0)
      domainsToTry = HARDCODED_DOMAINS;
    var streams = [],
      errors = [],
      tried = {};
    var foundDomain = null,
      foundM3u8 = null,
      foundHtml = null;
    var MAX_BATCH = Math.min(domainsToTry.length, 3);
    for (
      var batchStart = 0;
      batchStart < domainsToTry.length && !foundM3u8;
      batchStart += MAX_BATCH
    ) {
      var batch = [];
      for (
        var bi = batchStart;
        bi < batchStart + MAX_BATCH && bi < domainsToTry.length;
        bi++
      ) {
        (function (d) {
          batch.push(
            (async function () {
              if (tried[d] || foundM3u8) return null;
              tried[d] = true;
              var eUrl = buildEmbedUrl(
                d,
                type,
                imdbId,
                tmdbId,
                season,
                episode,
              );
              var html = null;
              try {
                html = await withTimeout(
                  httpGet(eUrl, {
                    "User-Agent": UA,
                    Accept: "text/html,application/xhtml+xml",
                    Referer: "https://" + d + "/",
                  }),
                  6e3,
                  d + " embed",
                );
                if (
                  !html ||
                  (html.indexOf("DOCTYPE") === -1 &&
                    html.indexOf("<html") === -1 &&
                    html.indexOf("<iframe") === -1 &&
                    html.indexOf("player_iframe") === -1)
                ) {
                  errors.push(d + ": invalid");
                  return null;
                }
              } catch (e) {
                errors.push(d + ": " + (e.message || "fail"));
                return null;
              }
              var m3u8 = null;
              try {
                m3u8 = await withTimeout(
                  tryMediainfoApi(d, imdbId, tmdbId, type, season, episode),
                  6e3,
                  d + " mi",
                );
              } catch (e) {}
              if (!m3u8) {
                try {
                  m3u8 = await withTimeout(
                    tryRcpExtraction(html, eUrl),
                    5e3,
                    d + " rcp",
                  );
                } catch (e) {}
              }
              if (m3u8) {
                foundM3u8 = m3u8;
                foundDomain = d;
                foundHtml = html;
              }
              return { domain: d, html: html, m3u8: m3u8, embedUrl: eUrl };
            })(),
          );
        })(domainsToTry[bi]);
      }
      var batchResults = await Promise.all(
        batch.map(function (p) {
          return p
            .then(function (r) {
              return r;
            })
            .catch(function () {
              return null;
            });
        }),
      );
      for (var ri = 0; ri < batchResults.length; ri++) {
        if (foundM3u8) break;
        if (batchResults[ri] && batchResults[ri].m3u8) {
          foundM3u8 = batchResults[ri].m3u8;
          foundDomain = batchResults[ri].domain;
          foundHtml = batchResults[ri].html;
          break;
        }
      }
    }
    if (foundM3u8 && foundDomain) {
      var eUrl = buildEmbedUrl(
        foundDomain,
        type,
        imdbId,
        tmdbId,
        season,
        episode,
      );
      var qualityStreams = await fetchM3u8WithQualities(foundM3u8, eUrl);
      for (var qi = 0; qi < qualityStreams.length; qi++) {
        var label = qualityStreams[qi].quality;
        if (qualityStreams[qi].codecLabel)
          label += " [" + qualityStreams[qi].codecLabel + "]";
        streams.push({
          url: qualityStreams[qi].url,
          quality: label,
          headers: { "User-Agent": UA, Referer: eUrl },
        });
      }
      if (foundHtml) {
        var iframe = extractIframeSrc(foundHtml);
        if (iframe) {
          var streamUrl =
            iframe.indexOf("http") === 0
              ? iframe
              : resolveRelativeUrl(eUrl, iframe);
          streams.push({
            url: streamUrl,
            quality: extractQuality(streamUrl) || "Auto",
            headers: { "User-Agent": UA, Referer: eUrl },
          });
        }
      }
      streams.push({
        url: eUrl,
        quality: extractQuality(eUrl) || "Auto",
        headers: { "User-Agent": UA, Referer: "https://" + foundDomain + "/" },
      });
    }
    if (streams.length === 0) {
      for (var di = 0; di < domainsToTry.length; di++) {
        var domain = domainsToTry[di];
        if (tried[domain]) continue;
        tried[domain] = true;
        var eUrl = buildEmbedUrl(domain, type, imdbId, tmdbId, season, episode);
        try {
          var html = await withTimeout(
            httpGet(eUrl, {
              "User-Agent": UA,
              Accept: "text/html,application/xhtml+xml",
              Referer: "https://" + domain + "/",
            }),
            6e3,
            domain + " embed",
          );
          if (
            html &&
            (html.indexOf("DOCTYPE") !== -1 ||
              html.indexOf("<html") !== -1 ||
              html.indexOf("<iframe") !== -1 ||
              html.indexOf("player_iframe") !== -1)
          ) {
            var iframe = extractIframeSrc(html);
            if (iframe) {
              var streamUrl =
                iframe.indexOf("http") === 0
                  ? iframe
                  : resolveRelativeUrl(eUrl, iframe);
              streams.push({
                url: streamUrl,
                quality: extractQuality(streamUrl) || "Auto",
                headers: { "User-Agent": UA, Referer: eUrl },
              });
            }
            streams.push({
              url: eUrl,
              quality: extractQuality(eUrl) || "Auto",
              headers: {
                "User-Agent": UA,
                Referer: "https://" + domain + "/",
              },
            });
            break;
          }
        } catch (e) {
          errors.push(domain + ": " + (e.message || "fail"));
        }
      }
    }
    if (streams.length === 0) {
      return {
        source: SOURCE_NAME,
        status: "no_streams",
        error: errors.join("; ") || "all domains failed",
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
    return makeFail(SOURCE_NAME, e.message, start);
  }
}
module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
