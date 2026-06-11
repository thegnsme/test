# MultiSource

**SkyStream Gen 2 plugin that aggregates 12 streaming sources and returns 30+ unique streams for movies and TV.**

---

## Architecture

MultiSource uses a **pure dispatcher pattern**. The plugin entry point (`plugin.js`) contains no scraping logic — it only dispatches requests and processes results. All source implementations live in `sources/*.js` and are loaded via a **barrel module** (`sources/index.js`).

```
plugin.js  (dispatcher — routing, TMDB, caching, dedup, sorting)
    │
    └─ require("./sources")   ← barrel
            │
            ├─ vidlink_pro.js
            ├─ videasy_to.js
            ├─ vixsrc_to.js
            ├─ lordflix.js
            ├─ vidsrc_xyz.js
            ├─ embed_cc.js
            ├─ ezvidapi.js
            ├─ superembed_stream.js
            ├─ multiembed_mov.js
            ├─ apiplayer_ru.js
            ├─ mappletv_uk.js
            └─ embedmaster_js.js
```

### Dispatcher (`plugin.js`)

- Parses `nuvio://` URLs into TMDB ID + type + season/episode
- Fetches TMDB metadata (with **response caching** at the endpoint level)
- Calls `SOURCES.aggregateAll()` which runs all 12 sources via `Promise.allSettled`
- **Deduplicates** streams by URL across all sources
- **Auto-detects quality** from URL patterns when the source omits it (e.g., `/1080p/`, `quality=720`, `_4K_`)
- **Sorts** streams: highest quality first, then alphabetically by source label
- Supports subtitle passthrough and custom HTTP headers per stream

### Barrel (`sources/index.js`)

- Contains the **source registry** — one `require()` line per source
- Implements **source health tracking**: sources with 3+ consecutive failures are temporarily skipped (5-minute cooldown)
- **Error classification**: distinguishes timeout, DNS, connection refused, rate limit, 403, 404, and parse errors
- **Adaptive timeouts**: TV content gets 45s budget, movies get 35s; per-source overrides for known slow sources
- Per-source latency tracking logged at debug level

### Shared Library (`sources/_shared.js`)

- HTTP GET/POST wrappers with **exponential backoff retry** + response caching
- `fetchTmdbMeta()` — cached TMDB metadata (title, year, imdb_id)
- `parseM3U8AllQualities()` — parses master M3U8 playlists and returns ALL quality variants sorted by resolution
- `m3u8ToStreams()` — converts M3U8 content directly into `{url, quality, headers}` arrays
- `fetchM3U8AndParse()` — one-liner: fetch a playlist URL → parse all quality variants
- `extractSubtitlesFromM3U8()` — extracts VTT subtitle tracks from M3U8 `#EXT-X-MEDIA:TYPE=SUBTITLES`

### M3U8 Multi-Quality Extraction

Several sources return master M3U8 playlists that contain `#EXT-X-STREAM-INF` entries for multiple resolutions. The shared `parseM3U8AllQualities()` function parses the playlist, extracts each variant's URL and resolution, sorts by quality descending, and returns a stream object per quality level. This gives the player direct access to 1080p, 720p, 480p, etc., instead of a single "Auto" stream.

---

## Quick Start

```bash
# Deploy directly
skystream deploy -u https://raw.githubusercontent.com/YOUR_USER/multisource/main/

# Or add the repository URL to SkyStream settings:
# https://raw.githubusercontent.com/YOUR_USER/multisource/main/repo.json
```

### Manual Deployment

```bash
git clone https://github.com/YOUR_USER/multisource.git
cd multisource
npm install
npx skystream deploy -u https://raw.githubusercontent.com/YOUR_USER/multisource/main/
```

The GitHub Actions workflow (`.github/workflows/build.yml`) handles automatic deployment on every push to `main`.

---

## URL Scheme

| Type  | Pattern                                  | Example               |
| ----- | ---------------------------------------- | --------------------- |
| Movie | `nuvio://movie/{tmdbId}`                 | `nuvio://movie/550`   |
| TV    | `nuvio://tv/{tmdbId}/{season}/{episode}` | `nuvio://tv/1399/1/1` |

The `plugin.js` parser also accepts `tmdb:movie:{id}` / `tmdb:series:{id}` and bare numeric IDs (defaults to movie).

---

## Source List

| #   | Source                | Status     | Avg. Quality | Notes                                                           |
| --- | --------------------- | ---------- | ------------ | --------------------------------------------------------------- |
| 1   | **vidlink.pro**       | Working    | 1080p        | HLS master + subtitles, uses enc-dec.app encryption bridge      |
| 2   | **videasy.to**        | Working    | 1080p        | 3 quality variants (1080p/720p/480p), encrypted API             |
| 3   | **vixsrc.to**         | Working    | 1080p        | Token-based playlist, quality auto-detected from master         |
| 4   | **lordflix**          | Working    | 1080p        | 10 parallel servers via enc-dec.app, multi-quality M3U8         |
| 5   | **vidsrc.xyz**        | Working    | 720p         | Multi-server HLS, tries multiple URL fallback patterns          |
| 6   | **2embed.cc**         | Working    | 720p         | 4 embed servers (Xps, Vesy, Vsrc, Vnest)                        |
| 7   | **ezvidapi**          | Working    | 1080p        | Multi-provider REST API (vidrock + vidlink), subtitles          |
| 8   | **superembed.stream** | Working    | 720p         | Embed + M3U8 extraction via multiembed.mov                      |
| 9   | **multiembed.mov**    | Working    | 720p         | VIP API endpoint, direct HLS/MP4 streams                        |
| 10  | **apiplayer.ru**      | Working    | 1080p        | Direct HLS proxy, no JS required, 60 req/min rate limit         |
| 11  | **mappletv.uk**       | Working    | 1080p        | API-based HLS with multi-quality, session cookie required       |
| 12  | **embedmaster.com**   | Embed-only | 720p         | Cloudflare Turnstile protected — embed URL for headless browser |

> **Status definitions:**
>
> - **Working**: Scrapes playable HLS streams with direct URLs
> - **Embed-only**: Returns an embed page URL; requires a headless browser or JS runtime to resolve

---

## Configuration Reference

All tunables are in `plugin.js` and `sources/index.js`.

### TMDB API

```javascript
// plugin.js — 3 rotating API keys
var TMDB_KEYS = [
  "68e094699525b18a70bab2f86b1fa706",
  "af3a53eb387d57fc935e9128468b1899",
  "0142a22c560ce3efb1cfd6f3b2faab77",
];
```

Keys are rotated round-robin on each call to distribute rate-limit load.

### Timeouts

| Setting                   | Value | Location           |
| ------------------------- | ----- | ------------------ |
| Default HTTP timeout      | 12s   | `plugin.js`        |
| Movie `load` timeout      | 15s   | `plugin.js`        |
| TV `load` timeout         | 40s   | `plugin.js`        |
| Home screen timeout       | 15s   | `plugin.js`        |
| Source aggregator (TV)    | 60s   | `sources/index.js` |
| Source aggregator (movie) | 35s   | `sources/index.js` |
| lordflix override         | 45s   | `sources/index.js` |
| mappletv.uk override      | 25s   | `sources/index.js` |
| ezvidapi override         | 20s   | `sources/index.js` |

### Health Tracking

| Setting            | Value | Location           |
| ------------------ | ----- | ------------------ |
| Failure threshold  | 3     | `sources/index.js` |
| Cooldown period    | 300s  | `sources/index.js` |
| TMDB cache TTL     | 5 min | `plugin.js`        |
| TMDB 404 cache TTL | 1 min | `plugin.js`        |
| TMDB max retries   | 2     | `plugin.js`        |

---

## Adding a New Source

Adding a new source requires exactly **two files to touch**:

### Step 1: Create the source file

Create `sources/yoursource.js`:

```javascript
var { httpGet } = require("./_shared");

var SOURCE_NAME = "yoursource";

async function scrapeStreams(params) {
  var start = Date.now();
  var { tmdbId, type, season, episode } = params;

  try {
    // Your scraping logic here
    var html = await httpGet("https://yoursource.com/embed/" + tmdbId);

    return {
      source: SOURCE_NAME,
      status: "working",
      streams: [
        {
          url: "https://...playlist.m3u8",
          quality: "1080p",
          headers: { Referer: "https://yoursource.com/" },
        },
      ],
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return {
      source: SOURCE_NAME,
      status: "error",
      error: e.message,
      streams: [],
      latency_ms: Date.now() - start,
    };
  }
}

module.exports = { name: SOURCE_NAME, scrapeStreams: scrapeStreams };
```

Your `scrapeStreams` function receives a `params` object:

- `tmdbId` — numeric TMDB ID
- `type` — `"movie"` or `"tv"`
- `season` — number (defaults to 1)
- `episode` — number (defaults to 1)

Return a `{ source, status, streams, latency_ms }` object. The `status` field should be `"working"` when streams are found, or `"error"` / `"no_streams"` on failure.

### Step 2: Register in the barrel

Add one line to `sources/index.js`:

```javascript
var SOURCES_REGISTRY = {
  "vidlink.pro": require("./vidlink_pro"),
  // ... existing sources ...
  yoursource: require("./yoursource"), // ← add here
  // ── Add new sources above this line ──
};
```

That's it. `plugin.js` and `_shared.js` never need changes.

### Return value contract

```typescript
{
    source: string,           // Display name shown in player UI
    status: "working" | "error" | "no_streams" | "embed",
    streams: Array<{
        url: string,          // Stream URL (HLS/MP4)
        quality?: string,     // "1080p", "720p", "Auto", etc.
        headers?: object,     // HTTP headers (Referer, User-Agent, etc.)
        subtitles?: Array<{
            url: string,
            label: string,
            lang: string,
        }>,
    }>,
    error?: string,           // Error message if status is not "working"
    latency_ms: number,       // Your function's execution time
}
```

---

## Project Structure

```
multisource/
├── .github/
│   └── workflows/
│       └── build.yml              # CI/CD: auto-deploys on push to main
├── multisource/
│   ├── plugin.json                 # SkyStream Gen 2 plugin manifest
│   ├── plugin.js                   # Dispatcher: TMDB, routing, dedup, sorting
│   └── sources/
│       ├── index.js                # Barrel: registry, health tracking, aggregation
│       ├── _shared.js              # Shared: HTTP, TMDB, M3U8 parsers, quality utils
│       ├── vidlink_pro.js          # vidlink.pro — HLS master + subtitles (enc-dec)
│       ├── videasy_to.js           # videasy.to — 3-quality encrypted HLS
│       ├── vixsrc_to.js            # vixsrc.to — token-based HLS playlist
│       ├── lordflix.js             # lordflix — 10-server HLS via enc-dec
│       ├── vidsrc_xyz.js           # vidsrc.xyz — multi-server HLS extraction
│       ├── embed_cc.js             # 2embed.cc — 4-server embed extraction
│       ├── ezvidapi.js             # ezvidapi.com — multi-provider REST API
│       ├── superembed_stream.js    # superembed.stream — embed + M3U8
│       ├── multiembed_mov.js       # multiembed.mov — VIP API direct streams
│       ├── apiplayer_ru.js         # apiplayer.ru — direct HLS proxy
│       ├── mappletv_uk.js          # mappletv.uk — API-based multi-quality HLS
│       └── embedmaster_js.js       # embedmaster.com — Turnstile-protected embed
├── .gitignore
├── package.json                    # Dependencies (skystream-extractors)
├── README.md                       # This file
└── repo.json                       # SkyStream repository manifest
```

---

## Test Results

Latest benchmark run:

| Scenario            | Unique Streams | Sources Responded | Time |
| ------------------- | -------------- | ----------------- | ---- |
| Movie (tmdb:550)    | 33             | 12/12             | ~14s |
| TV (tmdb:1399 S1E1) | 30             | 12/12             | ~15s |

Testing is done via the `skystream-cli` tool:

```bash
# Test movie stream aggregation
skystream test -f loadStreams -q "nuvio://movie/550"

# Test TV stream aggregation
skystream test -f loadStreams -q "nuvio://tv/1399/1/1"

# Test home screen
skystream test -f getHome -q "1"

# Test search
skystream test -f search -q "fight club"

# Test metadata loading
skystream test -f load -q "nuvio://movie/550"
```

### Syntax Validation

```bash
node -c multisource/plugin.js
node -c multisource/sources/index.js
node -c multisource/sources/_shared.js
node -c multisource/sources/vidlink_pro.js
# ... repeat for each source file
```

---

## License

MIT
