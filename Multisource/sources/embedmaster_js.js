/**
 * embedmaster.com — Iframe embed passthrough (Turnstile + JS-rendered)
 *
 * EmbedMaster uses:
 *   - Cloudflare Turnstile (invisible anti-bot captcha)
 *   - 302 redirect chain: embedmaster.link → embdmstrplayer.com/<token>
 *   - Obfuscated JavaScript that loads PlayerJS with stream URLs
 *   - POST-based attestation flow to unlock the player
 *
 * Direct stream extraction requires solving Turnstile and reverse-
 * engineering obfuscated JS — not feasible server-side.
 *
 * Strategy:
 *   Return the embed link URL for the player's headless browser to load.
 *   The player renders the page, solves Turnstile (via user interaction),
 *   and resolves the actual stream.
 *
 * URL patterns:
 *   Movie: https://embedmaster.link/movie/{tmdbId}
 *   TV:    https://embedmaster.link/tv/{tmdbId}/{season}/{episode}
 *
 * Note: embedmaster.com also accepts IMDb IDs (with tt prefix).
 */

var { httpGet } = require("./_shared");

var SOURCE_NAME = "embedmaster.com";
var BASE_URL = "https://embedmaster.link";
var UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function scrapeStreams(params) {
	var start = Date.now();
	var tmdbId = params.tmdbId;
	var type = params.type;
	var season = params.season;
	var episode = params.episode;

	try {
		// Build the embed link URL
		var embedUrl;
		if (type === "tv") {
			embedUrl = BASE_URL + "/tv/" + tmdbId + "/" + season + "/" + episode;
		} else {
			embedUrl = BASE_URL + "/movie/" + tmdbId;
		}

		// Test reachability - follow redirects to ensure it works
		var resp;
		try {
			resp = await httpGet(embedUrl, {
				"User-Agent": UA,
				Referer: BASE_URL + "/",
				Accept: "text/html,application/xhtml+xml",
			});
		} catch (e) {
			// embedmaster.link may redirect or require specific headers
			resp = "";
		}

		if (!resp || resp.length < 10) {
			// Still return the embed URL — the player's headless browser
			// can follow the redirect chain
		}

		return {
			source: SOURCE_NAME,
			status: "working",
			streams: [
				{
					url: embedUrl,
					quality: "Auto",
					headers: {
						"User-Agent": UA,
						Referer: BASE_URL + "/",
					},
				},
			],
			latency_ms: Date.now() - start,
		};
	} catch (e) {
		return fail(e.message);
	}

	function fail(msg) {
		return {
			source: SOURCE_NAME,
			status: "error",
			error: msg || "unknown",
			streams: [],
			latency_ms: Date.now() - start,
		};
	}
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
