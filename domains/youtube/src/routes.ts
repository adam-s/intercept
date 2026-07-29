/**
 * YouTube — playback exposed as an API.
 *
 * The interesting constraint is that the media cannot be handed over as a URL.
 * A player response served to a real page carries fourteen adaptive formats
 * with an itag and a byte length each, and no `url` and no `signatureCipher` on
 * any of them. Media is negotiated over `POST /videoplayback` with UMP framing,
 * so there is nothing to replay and nothing to redirect to; reconstructing the
 * negotiation means reimplementing a protocol the site changes at will.
 *
 * What does exist is a working player on the page. Driving it gives play,
 * pause, seek and state — which is what a consumer of a video stream actually
 * wants — without pretending to own bytes we cannot fetch. The give-up is
 * reported rather than papered over: `/formats` says plainly that the formats
 * carry no URL, because a route that returned an empty list would read as "this
 * video has no formats".
 *
 * @module domain-youtube/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, rateLimitedFetch, withCompleteness } from '@interceptor/shared';
import { innertubeBody, videoCards } from './innertube';

/** Reads the player response the page was served, from the page itself. */
const PLAYER_RESPONSE = `(() => {
	const m = document.documentElement.innerHTML.match(/ytInitialPlayerResponse\\s*=\\s*(\\{.+?\\});/s);
	if (!m) return { found: false };
	try { return { found: true, data: JSON.parse(m[1]) }; }
	catch (e) { return { found: true, error: String(e).slice(0, 120) }; }
})()`;

/** The player's own state, which is the honest description of a stream. */
const VIDEO_STATE = `(() => {
	const v = document.querySelector('video');
	if (!v) return { video: false };
	return {
		video: true,
		paused: v.paused,
		ended: v.ended,
		currentTime: +v.currentTime.toFixed(2),
		duration: +(v.duration || 0).toFixed(2),
		bufferedTo: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(1) : 0,
		width: v.videoWidth,
		height: v.videoHeight,
		readyState: v.readyState,
		playbackRate: v.playbackRate,
		volume: v.volume,
		muted: v.muted,
	};
})()`;

/** Put the browser on a watch page, unless it is already there. */
async function ensureWatching(
	browser: { getUrl(): string; navigate(url: string): Promise<unknown> },
	videoId: string,
): Promise<void> {
	if (browser.getUrl().includes(`v=${videoId}`)) return;
	DEBUG('youtube', `navigating to watch page for ${videoId}`);
	await browser.navigate(`https://www.youtube.com/watch?v=${videoId}`);
	await new Promise((r) => setTimeout(r, 4000));
}

export const routes: DomainRoute[] = [
	{
		method: 'GET',
		path: '/watch/:videoId/state',
		examples: ['/watch/jNQXAC9IVRw/state'],
		upstream: ['www.youtube.com/watch'],
		transport: 'HLS/Media',
		description: 'Playback state of the real player: position, duration, buffer, dimensions.',
		handler: async (c, browser) => {
			const { videoId } = c.req.param() as Record<string, string>;
			await ensureWatching(browser as never, videoId);
			const state = await browser.evaluate(new Function(`return ${VIDEO_STATE}`) as never);
			if (!(state as { video?: boolean })?.video) {
				// A page with no player is a fact worth reporting, not an empty state.
				return c.json({ error: 'No video element on the page', videoId }, 502);
			}
			return c.json({ videoId, ...(state as object) });
		},
	},
	{
		method: 'POST',
		path: '/watch/:videoId/control',
		examples: ['/watch/jNQXAC9IVRw/control'],
		upstream: ['www.youtube.com/watch'],
		transport: 'HLS/Media',
		description: 'Drive playback: play, pause, seek, rate, volume. Returns the state after.',
		handler: async (c, browser) => {
			const { videoId } = c.req.param() as Record<string, string>;
			const body = (await c.req.json().catch(() => ({}))) as {
				action?: string;
				seconds?: number;
				rate?: number;
				volume?: number;
			};
			await ensureWatching(browser as never, videoId);

			// Actions are named rather than eval'd from the request, so a caller
			// cannot reach past playback into the page.
			const action = String(body.action ?? 'state');
			const scripts: Record<string, string> = {
				play: `document.querySelector('video').play()`,
				pause: `document.querySelector('video').pause()`,
				seek: `document.querySelector('video').currentTime = ${Number(body.seconds ?? 0)}`,
				rate: `document.querySelector('video').playbackRate = ${Number(body.rate ?? 1)}`,
				volume: `document.querySelector('video').volume = ${Math.min(Math.max(Number(body.volume ?? 1), 0), 1)}`,
				mute: `document.querySelector('video').muted = true`,
				unmute: `document.querySelector('video').muted = false`,
				state: '0',
			};
			if (!(action in scripts)) {
				return c.json({ error: `Unknown action "${action}"`, allowed: Object.keys(scripts) }, 400);
			}

			await browser.evaluate(new Function(`return ${scripts[action]}`) as never);
			// Settle before reading back: play and seek both take effect asynchronously,
			// and reporting the state before it moved would be a lie about what happened.
			await new Promise((r) => setTimeout(r, action === 'state' ? 0 : 1200));
			const state = await browser.evaluate(new Function(`return ${VIDEO_STATE}`) as never);
			return c.json({ videoId, action, ...(state as object) });
		},
	},
	{
		method: 'GET',
		path: '/watch/:videoId/formats',
		examples: ['/watch/jNQXAC9IVRw/formats'],
		upstream: ['www.youtube.com/watch'],
		transport: 'HLS/Media',
		description: 'The adaptive formats the player was offered, and whether any carries a URL.',
		handler: async (c, browser) => {
			const { videoId } = c.req.param() as Record<string, string>;
			await ensureWatching(browser as never, videoId);
			const res = (await browser.evaluate(new Function(`return ${PLAYER_RESPONSE}`) as never)) as {
				found?: boolean;
				data?: {
					playabilityStatus?: { status?: string; reason?: string };
					streamingData?: {
						adaptiveFormats?: Array<Record<string, unknown>>;
						formats?: Array<Record<string, unknown>>;
						expiresInSeconds?: string;
					};
				};
			};
			if (!res?.found || !res.data) {
				return c.json({ error: 'No player response embedded in the page', videoId }, 502);
			}

			const sd = res.data.streamingData ?? {};
			const all = [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])];
			const formats = all.map((f) => ({
				itag: f.itag,
				mimeType: f.mimeType,
				quality: f.qualityLabel ?? f.audioQuality,
				contentLength: f.contentLength,
				hasUrl: Boolean(f.url),
				hasCipher: Boolean(f.signatureCipher ?? f.cipher),
			}));
			const withUrl = formats.filter((f) => f.hasUrl).length;

			return c.json({
				videoId,
				playability: res.data.playabilityStatus?.status ?? null,
				expiresInSeconds: sd.expiresInSeconds ?? null,
				formats,
				directlyFetchable: withUrl,
				// Stated rather than implied. An empty URL list is not "no formats" —
				// it is fourteen formats none of which can be fetched, which is a
				// different fact and the one a caller needs.
				_note:
					withUrl > 0
						? 'Some formats carry a URL and can be fetched directly.'
						: 'No format carries a URL or a cipher. Media is negotiated over /videoplayback with UMP framing, so there is nothing to fetch or replay — use the control and state routes, which drive the player that can.',
			});
		},
	},
	{
		method: 'GET',
		path: '/search',
		examples: ['/search?q=lofi'],
		upstream: ['www.youtube.com/youtubei/v1/search'],
		transport: 'JSON API (XHR)',
		description: 'InnerTube search, called from the page so it carries the session.',
		handler: async (c, browser) => {
			const url = new URL(c.req.url);
			const q = url.searchParams.get('q') ?? '';
			if (!q) return c.json({ error: 'q is required' }, 400);

			// Called from a YouTube page: the endpoint is same-origin there, the
			// session is already held, and a request issued inside the browser
			// carries the browser's own TLS handshake rather than the runtime's.
			if (!browser.getUrl().includes('youtube.com')) {
				await browser.navigate('https://www.youtube.com/');
				await new Promise((r) => setTimeout(r, 3000));
			}

			const body = JSON.stringify(innertubeBody({ query: q }));
			const res = (await browser.evaluate(
				new Function(`return fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: ${JSON.stringify(body)},
					credentials: 'include',
				}).then((r) => r.json().then((j) => ({ status: r.status, json: j })))
				  .catch((e) => ({ status: 0, json: { error: String(e).slice(0, 120) } }))`) as never,
			)) as { status?: number; json?: unknown };

			if (res?.status !== 200) {
				return c.json({ error: `Search returned ${res?.status}`, query: q }, 502);
			}
			const videos = videoCards(res.json);
			return c.json(
				withCompleteness({ query: q, videos, total: videos.length, _transport: 'innertube' }),
			);
		},
	},
	{
		method: 'GET',
		path: '/channel/:channelId/videos',
		examples: ['/channel/UCBJycsmduvYEL83R_U4JriQ/videos'],
		upstream: ['www.youtube.com/youtubei/v1/browse'],
		transport: 'JSON API (XHR)',
		description: 'A channel video list through InnerTube browse.',
		handler: async (c, browser) => {
			const { channelId } = c.req.param() as Record<string, string>;
			if (!browser.getUrl().includes('youtube.com')) {
				await browser.navigate('https://www.youtube.com/');
				await new Promise((r) => setTimeout(r, 3000));
			}

			// `params` selects the tab. This value is the videos tab, and it is a
			// borrowed constant: YouTube may change it without notice, and a route
			// that suddenly returns the wrong tab will look like a parsing bug.
			const body = JSON.stringify(
				innertubeBody({ browseId: channelId, params: 'EgZ2aWRlb3PyBgQKAjoA' }),
			);
			const res = (await browser.evaluate(
				new Function(`return fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: ${JSON.stringify(body)},
					credentials: 'include',
				}).then((r) => r.json().then((j) => ({ status: r.status, json: j })))
				  .catch((e) => ({ status: 0, json: { error: String(e).slice(0, 120) } }))`) as never,
			)) as { status?: number; json?: unknown };

			if (res?.status !== 200) {
				return c.json({ error: `Browse returned ${res?.status}`, channelId }, 502);
			}
			const videos = videoCards(res.json);
			return c.json(withCompleteness({ channelId, videos, total: videos.length }));
		},
	},
	{
		method: 'GET',
		path: '/suggest',
		examples: ['/suggest?q=lofi'],
		upstream: ['suggestqueries-clients6.youtube.com/complete/search'],
		transport: 'JSONP',
		description: 'Autocomplete over JSONP: the response is a function call, not JSON.',
		browserRequired: false,
		handler: async (c) => {
			const q = new URL(c.req.url).searchParams.get('q') ?? '';
			if (!q) return c.json({ error: 'q is required' }, 400);

			// JSONP in its strictest form: no callback parameter to name the wrapper,
			// just a hardcoded global. Nothing in the request marks it — the response
			// body is the only tell, which is why a scan of requests alone reports
			// this endpoint as an ordinary script fetch.
			const res = await rateLimitedFetch(
				`https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`,
			);
			if (!res.ok) return c.json({ error: `Suggest returned ${res.status}` }, 502);

			const text = await res.text();
			const inner = text.match(/^[^(]*\((.*)\)[;\s]*$/s)?.[1];
			if (!inner) {
				// The wrapper is the transport. If it is missing, the response is not
				// what this route understands, and guessing at it would invent data.
				return c.json(
					{ error: 'Response was not a JSONP wrapper', preview: text.slice(0, 120) },
					502,
				);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(inner);
			} catch {
				return c.json(
					{ error: 'Wrapper contents were not JSON', preview: inner.slice(0, 120) },
					502,
				);
			}

			const rows = Array.isArray(parsed) ? ((parsed[1] as unknown[]) ?? []) : [];
			const suggestions = rows
				.map((r) => (Array.isArray(r) ? String(r[0] ?? '') : ''))
				.filter(Boolean);
			return c.json(
				withCompleteness({ query: q, suggestions, total: suggestions.length, _transport: 'jsonp' }),
			);
		},
	},
	{
		method: 'GET',
		path: '/watch/:videoId/info',
		examples: ['/watch/jNQXAC9IVRw/info'],
		upstream: ['www.youtube.com/watch'],
		transport: 'Embedded JSON',
		description: 'Video metadata read out of the page, with no API call at all.',
		handler: async (c, browser) => {
			const { videoId } = c.req.param() as Record<string, string>;
			await ensureWatching(browser as never, videoId);

			// Read from the markup rather than from a page global: `evaluate` runs in
			// an isolated world that shares the DOM and not the globals, so reaching
			// for `ytInitialPlayerResponse` directly returns undefined with nothing
			// thrown. The script tag is common ground.
			const res = (await browser.evaluate(new Function(`return ${PLAYER_RESPONSE}`) as never)) as {
				found?: boolean;
				data?: Record<string, unknown>;
			};
			if (!res?.found || !res.data) {
				return c.json({ error: 'No player response embedded in the page', videoId }, 502);
			}

			const vd = res.data.videoDetails as Record<string, unknown> | undefined;
			const micro = (
				res.data.microformat as { playerMicroformatRenderer?: Record<string, unknown> } | undefined
			)?.playerMicroformatRenderer;
			return c.json({
				videoId,
				title: vd?.title ?? null,
				author: vd?.author ?? null,
				channelId: vd?.channelId ?? null,
				lengthSeconds: vd?.lengthSeconds ? Number(vd.lengthSeconds) : null,
				viewCount: vd?.viewCount ? Number(vd.viewCount) : null,
				keywords: vd?.keywords ?? [],
				shortDescription: vd?.shortDescription ?? null,
				publishDate: micro?.publishDate ?? null,
				category: micro?.category ?? null,
				_transport: 'embedded-json',
				_note: 'No API call: the page is served this payload, so the data is already here.',
			});
		},
	},
];
