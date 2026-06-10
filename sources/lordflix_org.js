/**
 * =============================================================================
 *  SOURCE: lordflix.org — DISABLED (requires browser JavaScript)
 *  =============================================================================
 *  Chain:
 *    1. TMDB metadata → snowhouse.lordflix.club → encrypted JS file
 *    2. The JS file is a Cloudflare challenge script that requires browser
 *       execution (captcha, fingerprinting, etc.) to reveal the real video URL.
 *
 *  WHY DISABLED:
 *    snowhouse.lordflix.club serves a Cloudflare JavaScript challenge that
 *    must be executed by a real browser. SkyStream's QuickJS runtime cannot
 *    execute arbitrary browser JS (DOM APIs, WebAssembly, etc.).
 *
 *  STATUS:
 *    - All 9 servers (Berlin, Phoenix, Comet, Oslo, Luna, Sakura, Rio,
 *      Ativa, Moscow) tested — all return Cloudflare challenge scripts.
 *    - enc-dec.app's dec-lordflix fails with "Malformed JSON payload"
 *      because the input is JS code, not encrypted JSON.
 *    - Can only work as an /embed source loaded in a WebView.
 *
 *  If SkyStream ever adds WebView-based embed support, this source can be
 *  re-enabled as an embed type. For direct stream scraping it is
 *  fundamentally incompatible.
 * =============================================================================
 */

var SOURCE_NAME = "lordflix.org";

async function scrapeStreams(params) {
	return {
		source: SOURCE_NAME,
		status: "embed",
		error:
			"snowhouse.lordflix.club requires browser JavaScript (Cloudflare challenge) — " +
			"incompatible with QuickJS runtime. Use as /embed source in WebView instead.",
		streams: [],
		latency_ms: 0,
	};
}

module.exports = {
	name: SOURCE_NAME,
	scrapeStreams: scrapeStreams,
};
