"use strict";

function safeJsonParse(str) {
  if (!str || typeof str !== "string") return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
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

var _subCache = {};

var _subCacheKeys = [];

var _subCacheMax = 100;

var TAG = "SubProvider";

var OS_BASE = "https://rest.opensubtitles.org";

var DL_BASE = "https://dl.opensubtitles.org";

var OS_USER_AGENT = "TemporaryUserAgent";

var OS_TIMEOUT = 1e4;

var LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  pb: "Portuguese (BR)",
  it: "Italian",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ar: "Arabic",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  he: "Hebrew",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ro: "Romanian",
  cs: "Czech",
  hu: "Hungarian",
  el: "Greek",
  bg: "Bulgarian",
  hr: "Croatian",
  sr: "Serbian",
  uk: "Ukrainian",
  fa: "Persian",
  ms: "Malay",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  sk: "Slovak",
  sl: "Slovenian",
  bn: "Bengali",
  tl: "Tagalog",
  bs: "Bosnian",
  mk: "Macedonian",
  sq: "Albanian",
  ka: "Georgian",
  is: "Icelandic",
  ca: "Catalan",
  eu: "Basque",
  gl: "Galician",
  cy: "Welsh",
  sw: "Swahili",
  ml: "Malayalam",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
  pa: "Punjabi",
  ne: "Nepali",
  si: "Sinhala",
  km: "Khmer",
  lo: "Lao",
  my: "Burmese",
  mn: "Mongolian",
  af: "Afrikaans",
  ku: "Kurdish",
};

function languageName(code) {
  if (!code) return "Unknown";
  var lower = String(code).toLowerCase().trim();
  return LANGUAGE_NAMES[lower] || lower.toUpperCase();
}

function log() {
  try {
    console.log.apply(
      console,
      ["[" + TAG + "]"].concat([].slice.call(arguments)),
    );
  } catch (e) {}
}

function warn() {
  try {
    console.warn.apply(
      console,
      ["[" + TAG + "]"].concat([].slice.call(arguments)),
    );
  } catch (e) {}
}

function normalizeSubtitle(sub) {
  if (!sub || !sub.url) return null;
  var url = String(sub.url).trim();
  if (!url) return null;
  var rawName = sub.name || sub.label || sub.lang || "";
  var rawLabel = sub.label || sub.name || sub.lang || "";
  var rawLang = sub.lang || "";
  var name = "";
  if (rawName) {
    name = String(rawName).trim();
  } else if (rawLang) {
    name = languageName(rawLang);
  } else {
    name = "Subtitle";
  }
  var label = "";
  if (rawLabel) {
    label = String(rawLabel).trim();
  } else if (rawLang) {
    label = languageName(rawLang);
  } else {
    label = "Subtitle";
  }
  var lang = rawLang ? String(rawLang).toLowerCase().trim() : "en";
  return {
    url: url,
    name: name,
    label: label,
    lang: lang,
  };
}

function cloneSubtitles(subtitles) {
  if (!Array.isArray(subtitles)) return [];
  if (subtitles.length === 0) return [];
  var cloned = [];
  for (var i = 0; i < subtitles.length; i++) {
    var normalized = normalizeSubtitle(subtitles[i]);
    if (normalized) {
      cloned.push({
        url: normalized.url,
        name: normalized.name,
        label: normalized.label,
        lang: normalized.lang,
      });
    }
  }
  return cloned;
}

var _imdbCache = {};

var _imdbCacheKeys = [];

var _imdbCacheMax = 200;

async function tmdbToImdb(tmdbId, type) {
  var key = String(tmdbId) + ":" + type;
  if (_imdbCache[key] !== undefined) return _imdbCache[key];
  try {
    if (typeof tmdbGet === "function") {
      var data = await tmdbGet(type + "/" + tmdbId, {
        append_to_response: "external_ids",
      });
      if (data && data.external_ids && data.external_ids.imdb_id) {
        var imdb = data.external_ids.imdb_id;
        _imdbCache[key] = imdb;
        _imdbCacheKeys.push(key);
        if (_imdbCacheKeys.length > _imdbCacheMax) {
          delete _imdbCache[_imdbCacheKeys.shift()];
        }
        return imdb;
      }
      if (data && data.imdb_id) {
        _imdbCache[key] = data.imdb_id;
        _imdbCacheKeys.push(key);
        if (_imdbCacheKeys.length > _imdbCacheMax) {
          delete _imdbCache[_imdbCacheKeys.shift()];
        }
        return data.imdb_id;
      }
    }
    var meta = await fetchTmdbMeta(tmdbId, type);
    if (meta && meta.imdb_id) {
      _imdbCache[key] = meta.imdb_id;
      _imdbCacheKeys.push(key);
      if (_imdbCacheKeys.length > _imdbCacheMax) {
        delete _imdbCache[_imdbCacheKeys.shift()];
      }
      return meta.imdb_id;
    }
    return null;
  } catch (e) {
    warn("tmdbToImdb(" + tmdbId + "," + type + ") error: " + e.message);
    return null;
  }
}

async function searchOpenSubtitles(imdbId) {
  var searchId = String(imdbId).replace(/^tt/i, "");
  if (!searchId || !/^\d+$/.test(searchId)) {
    warn("searchOpenSubtitles: invalid imdbId '" + imdbId + "'");
    return [];
  }
  var url = OS_BASE + "/search/imdbid-" + searchId;
  try {
    var resp = await httpGet(
      url,
      {
        "User-Agent": OS_USER_AGENT,
        Accept: "application/json",
      },
      2,
    );
    if (!resp || resp.length < 10) {
      return [];
    }
    var data = safeJsonParse(resp);
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  } catch (e) {
    warn("searchOpenSubtitles error: " + (e && e.message));
    return [];
  }
}

function subtitleQualityScore(sub) {
  if (!sub) return 0;
  var downloads = parseInt(sub.SubDownloadsCnt, 10) || 0;
  var rating = parseFloat(sub.SubRating) || 0;
  var score = downloads * (rating || 1);
  if (sub.SubBad === "1") {
    score *= 0.05;
  }
  if (sub.SubHearingImpaired === "1") {
    score *= 0.3;
  }
  if (sub.SubFormat && sub.SubFormat.toLowerCase() === "srt") {
    score *= 1.1;
  }
  score *= 1 + rating / 10;
  return score;
}

async function fetchOsSubtitles(imdbId, type, season, episode) {
  try {
    var allResults = await searchOpenSubtitles(imdbId);
    if (!Array.isArray(allResults) || allResults.length === 0) {
      log("OpenSubtitles: no results for " + imdbId);
      return [];
    }
    log("OpenSubtitles: " + allResults.length + " total results for " + imdbId);
    var english = [];
    for (var i = 0; i < allResults.length; i++) {
      var s = allResults[i];
      if (!s) continue;
      var lang = (s.SubLanguageID || "").toLowerCase().trim();
      var iso = (s.ISO639 || "").toLowerCase().trim();
      if (lang === "eng" || iso === "en") {
        english.push(s);
      }
    }
    log("  → " + english.length + " English subtitle(s)");
    if (english.length === 0) {
      return [];
    }
    if (type === "tv") {
      var sNum = parseInt(season, 10) || 1;
      var eNum = parseInt(episode, 10) || 1;
      var filtered = [];
      for (var ei = 0; ei < english.length; ei++) {
        var sub = english[ei];
        var subS = parseInt(sub.SeriesSeason, 10);
        var subE = parseInt(sub.SeriesEpisode, 10);
        if (subS === sNum && subE === eNum) {
          filtered.push(sub);
        }
      }
      if (filtered.length === 0) {
        var animeFallback = [];
        for (var fi = 0; fi < english.length; fi++) {
          var fas = english[fi];
          var faS = parseInt(fas.SeriesSeason, 10);
          var faE = parseInt(fas.SeriesEpisode, 10);
          if ((faS === 0 || isNaN(faS)) && (faE === 0 || isNaN(faE))) {
            animeFallback.push(fas);
          }
        }
        if (animeFallback.length > 0) {
          log(
            "  → no exact S" +
              sNum +
              "E" +
              eNum +
              ", but found " +
              animeFallback.length +
              " anime-style (S0E0) subs",
          );
          filtered = animeFallback;
        } else {
          log(
            "  → no English subs for S" +
              sNum +
              "E" +
              eNum +
              " (had " +
              english.length +
              " English total, none for this episode)",
          );
          return [];
        }
      }
      english = filtered;
      log("  → " + english.length + " English for S" + sNum + "E" + eNum);
    }
    english.sort(function (a, b) {
      return subtitleQualityScore(b) - subtitleQualityScore(a);
    });
    var out = [];
    var seenLabels = {};
    for (var si = 0; si < english.length; si++) {
      var sub = english[si];
      var fileId = sub.IDSubtitleFile;
      if (!fileId) continue;
      var label = "English";
      if (sub.SubHearingImpaired === "1") {
        label += " (SDH)";
      }
      if (sub.UserNickName) {
        var nick = String(sub.UserNickName).trim();
        if (nick && nick.length > 0) {
          label += " [" + nick + "]";
        }
      }
      if (seenLabels[label]) continue;
      seenLabels[label] = true;
      var downloadUrl = DL_BASE + "/en/download/filead/" + String(fileId);
      out.push({
        url: downloadUrl,
        name: label,
        label: label,
        lang: "en",
      });
      if (out.length >= 3) break;
    }
    log(
      "OpenSubtitles: returning " + out.length + " English subtitle option(s)",
    );
    return out;
  } catch (e) {
    warn("fetchOsSubtitles error: " + (e && e.message));
    return [];
  }
}

function attachSubtitlesToStreams(streams, subtitles) {
  if (!streams || !Array.isArray(streams)) return streams;
  if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
    return streams;
  }
  log(
    "attachSubtitlesToStreams: enriching " +
      streams.length +
      " stream(s) with " +
      subtitles.length +
      " subtitle(s)",
  );
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if (!s) continue;
    var externalSubs = cloneSubtitles(subtitles);
    var existing = s.subtitles;
    if (existing && Array.isArray(existing) && existing.length > 0) {
      var normalizedExisting = [];
      for (var ei = 0; ei < existing.length; ei++) {
        var norm = normalizeSubtitle(existing[ei]);
        if (norm) normalizedExisting.push(norm);
      }
      var existingUrls = {};
      for (var ei2 = 0; ei2 < normalizedExisting.length; ei2++) {
        if (normalizedExisting[ei2] && normalizedExisting[ei2].url) {
          existingUrls[normalizedExisting[ei2].url] = true;
        }
      }
      var merged = normalizedExisting.slice();
      for (var si = 0; si < externalSubs.length; si++) {
        if (
          externalSubs[si] &&
          externalSubs[si].url &&
          !existingUrls[externalSubs[si].url]
        ) {
          merged.push(externalSubs[si]);
        }
      }
      s.subtitles = merged;
    } else {
      s.subtitles = externalSubs;
    }
  }
  return streams;
}

async function fetchSubtitles(tmdbId, type, season, episode) {
  var start = Date.now();
  var tmdbIdNum = parseInt(tmdbId, 10) || 0;
  var contentType = type === "tv" ? "tv" : "movie";
  var seasonNum = Math.max(1, parseInt(season, 10) || 1);
  var episodeNum = Math.max(1, parseInt(episode, 10) || 1);
  var cacheKey =
    String(tmdbIdNum) + ":" + contentType + ":S" + seasonNum + "E" + episodeNum;
  if (_subCache[cacheKey] !== undefined) {
    var cached = _subCache[cacheKey];
    log(
      "fetchSubtitles: cache HIT for " +
        cacheKey +
        " (" +
        cached.length +
        " subs)",
    );
    return cached;
  }
  log(
    "fetchSubtitles(" +
      contentType +
      " tmdb:" +
      tmdbIdNum +
      ") S" +
      seasonNum +
      "E" +
      episodeNum,
  );
  try {
    var imdbId = await tmdbToImdb(tmdbIdNum, contentType);
    if (!imdbId) {
      log("fetchSubtitles: cannot resolve TMDB → IMDB for " + tmdbIdNum);
      return [];
    }
    log("  TMDB " + tmdbIdNum + " → IMDB " + imdbId);
    var subs = await fetchOsSubtitles(
      imdbId,
      contentType,
      seasonNum,
      episodeNum,
    );
    log(
      "  → " +
        subs.length +
        " English subtitle(s) in " +
        (Date.now() - start) +
        "ms",
    );
    _subCache[cacheKey] = subs;
    _subCacheKeys.push(cacheKey);
    while (_subCacheKeys.length > _subCacheMax) {
      delete _subCache[_subCacheKeys.shift()];
    }
    return subs;
  } catch (e) {
    warn("fetchSubtitles error: " + (e && e.message));
    return [];
  }
}

module.exports = {
  fetchSubtitles: fetchSubtitles,
  attachSubtitlesToStreams: attachSubtitlesToStreams,
  normalizeSubtitle: normalizeSubtitle,
  cloneSubtitles: cloneSubtitles,
  tmdbToImdb: tmdbToImdb,
};
