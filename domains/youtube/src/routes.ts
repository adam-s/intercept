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
import { DEBUG } from '@interceptor/shared';

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
];
