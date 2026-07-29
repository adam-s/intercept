/**
 * Twitch Domain Routes
 *
 * Discovery (see .agents/rules/discovery.md) found five confirmed transports
 * on twitch.tv: GraphQL (`gql.twitch.tv/gql`, persisted-query POSTs), HLS
 * media (`usher.ttvnw.net` → `*.playlist.ttvnw.net` → CloudFront segments),
 * WebSocket (`irc-ws.chat.twitch.tv`, IRC-over-WS text protocol; also
 * `hermes.twitch.tv`, an encrypted PubSub envelope — see the note on that row
 * below), JSONP (`assets.twitch.tv/eppo/api/flag-config`, feature flags), and
 * Cross-frame RPC (a third-party ad/Prime-extension iframe posting to the
 * page — not Twitch's own data, so no route consumes it).
 *
 * Every route below reaches production twitch.tv/gql.twitch.tv/usher.ttvnw.net
 * directly — there is no local test fixture for this domain. All five are
 * `browserRequired: false`: elimination (routes.ts's inline comments) showed
 * each stage of every chain works from a bare `rateLimitedFetch`/`ws`
 * connection with no cookies, using the public `Client-ID` twitch.tv's own web
 * client ships (`kimne78kx3ncx6brgo4mv6wki5h1ko`) and, for chat, the anonymous
 * `justinfan*` IRC login every logged-out viewer gets.
 *
 * GRAPHQL:
 *  1. GET /directory/:slug/streams — DirectoryPage_Game persisted query.
 *  2. GET /channel/:login/videos   — FilterableVideoTower_Videos persisted query.
 *
 * HLS MEDIA:
 *  3. GET /stream/:login/hls       — PlaybackAccessToken → usher master playlist → variants.
 *
 * WEBSOCKET:
 *  4. GET /chat/:login/tail        — Anonymous IRC-over-WS, capture N chat frames.
 *
 * JSONP:
 *  5. GET /featureflags            — Eppo flag-config JSONP, strip the callback wrapper.
 *
 * @module domain-twitch/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, rateLimitedFetch } from '@interceptor/shared';

const GQL_URL = 'https://gql.twitch.tv/gql';
// The value twitch.tv's own web client ships in every request — not a secret,
// visible in any page load. Confirmed working with zero other headers via a
// bare `curl` (no cookies, no browser) during discovery.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

/**
 * Persisted-query SHA-256 hashes, read off captured traffic on 2026-07-29.
 * Twitch rotates these when it ships a new web client build — a 400 with
 * `PersistedQueryNotFound` means the hash below is stale and needs
 * re-capturing from a fresh page load, not a bug in the request shape.
 */
const PERSISTED_QUERIES = {
	directoryPageGame: '86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd',
	filterableVideoTower: '67004f7881e65c297936f32c75246470629557a393788fb5a69d6d9a25a8fd5f',
	playbackAccessToken: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
} as const;

async function gql(operationName: string, variables: Record<string, unknown>, sha256Hash: string) {
	const res = await rateLimitedFetch(GQL_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Client-ID': CLIENT_ID },
		body: JSON.stringify({
			operationName,
			variables,
			extensions: { persistedQuery: { version: 1, sha256Hash } },
		}),
	});
	return res;
}

/** Parse an HLS master playlist into its quality variants. */
function parseMasterPlaylist(
	playlist: string,
): { quality: string; bandwidth: number; url: string }[] {
	const variants: { quality: string; bandwidth: number; url: string }[] = [];
	const lines = playlist.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
			const bw = lines[i].match(/BANDWIDTH=(\d+)/)?.[1];
			const name = lines[i].match(/(?:STABLE-VARIANT-ID|IVS-NAME)="([^"]+)"/)?.[1];
			const next = lines[i + 1]?.trim();
			if (bw && next && !next.startsWith('#')) {
				variants.push({ quality: name ?? next, bandwidth: Number(bw), url: next });
			}
		}
	}
	return variants;
}

export const routes: DomainRoute[] = [
	// ═══════════════════════════════════════════════════════════════════
	// GRAPHQL
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 1: Directory listing (category/game streams) ──────────
	//
	// GATE FINDING: the persisted query accepts `limit` up to 100 with no
	// `cursor` and returns that many streams in one call — confirmed with
	// limit=100 returning 99 items via a bare `curl` (no browser, no cookies).
	// `limit=300` is rejected server-side ("argument 'first' value must be
	// between 1 and 100"), so paging past 100 requires the `cursor` field.
	// Supplying a real cursor (captured from the live page) gets back
	// `{"errors":[{"message":"failed integrity check", extensions:{code:
	// "IntegrityCheckFailed"}}]}` — GraphQL responds 200 with an error body,
	// not a transport failure. This is Kasada: the endpoint wants a
	// `client-integrity` header holding a token computed by Kasada's
	// obfuscated in-page JS (minted via a POST to `gql.twitch.tv/integrity`
	// carrying `x-kpsdk-ct/cd/h` sensor headers, also Kasada-computed).
	// Tried twice: once via our own bare fetch (no integrity header at all),
	// and once by scripting a real scroll on the connected browser so
	// twitch.tv's own client made the call with its own freshly-minted
	// integrity token attached — captured proof the token was present. Both
	// came back `IntegrityCheckFailed`. Since even organic-shaped traffic
	// from the live, cookied browser session failed the check, this reads as
	// automation detection on the *token minting* step rather than a header
	// we merely forgot, and is not satisfiable without solving Kasada's
	// sensor challenge — out of scope. Reported as a give-up: this route
	// serves one page (up to 100 items) and sets `hasMore` honestly from
	// `pageInfo.hasNextPage` rather than silently truncating.
	{
		method: 'GET',
		path: '/directory/:slug/streams',
		examples: ['/directory/just-chatting/streams', '/directory/just-chatting/streams?limit=100'],
		upstream: ['gql.twitch.tv/gql'],
		transport: 'GraphQL',
		description:
			'Live streams in a category/game directory (DirectoryPage_Game). One page, up to 100 — see the cursor/Kasada note above for why.',
		browserRequired: false,
		handler: async (c) => {
			const slug = (c.req.param() as Record<string, string>).slug;
			const limit = Math.min(Number(new URL(c.req.url).searchParams.get('limit') ?? '30'), 100);

			DEBUG('twitch', `directory: fetching ${slug} limit=${limit}`);
			const res = await gql(
				'DirectoryPage_Game',
				{
					imageWidth: 50,
					slug,
					options: {
						sort: 'RELEVANCE',
						recommendationsContext: { platform: 'web' },
						requestID: 'JIRA-VXP-2397',
						freeformTags: null,
						tags: [],
						broadcasterLanguages: [],
						systemFilters: [],
					},
					sortTypeIsRecency: false,
					limit,
					includeCostreaming: true,
				},
				PERSISTED_QUERIES.directoryPageGame,
			);
			if (!res.ok) return c.json({ error: `GraphQL returned ${res.status}` }, 502);
			const body = (await res.json()) as {
				errors?: { message: string }[];
				data?: {
					game?: {
						id: string;
						name: string;
						streams?: {
							edges: { cursor: string; node: Record<string, unknown> }[];
							pageInfo: { hasNextPage: boolean };
						};
					} | null;
				};
			};
			if (!body.data?.game) {
				return c.json({ error: `No such category "${slug}"`, errors: body.errors ?? [] }, 404);
			}
			const streams = body.data.game.streams;
			const items = streams?.edges.map((e) => e.node) ?? [];
			return c.json({
				slug,
				game: body.data.game.name,
				items,
				returned: items.length,
				hasMore: streams?.pageInfo.hasNextPage ?? false,
				_note: streams?.pageInfo.hasNextPage
					? 'More streams exist beyond this page. Cursor-based paging into them requires a Kasada client-integrity token this session could not mint — see the route comment in routes.ts.'
					: undefined,
			});
		},
	},

	// ─── Route 2: Channel VOD listing ─────────────────────────────────
	{
		method: 'GET',
		path: '/channel/:login/videos',
		examples: ['/channel/t90official/videos'],
		upstream: ['gql.twitch.tv/gql'],
		transport: 'GraphQL',
		description: 'A channel’s archived broadcasts (FilterableVideoTower_Videos), newest first.',
		browserRequired: false,
		handler: async (c) => {
			const login = (c.req.param() as Record<string, string>).login;
			const limit = Math.min(Number(new URL(c.req.url).searchParams.get('limit') ?? '30'), 100);

			DEBUG('twitch', `videos: fetching ${login} limit=${limit}`);
			const res = await gql(
				'FilterableVideoTower_Videos',
				{
					includePreviewBlur: false,
					limit,
					channelOwnerLogin: login,
					broadcastType: 'ARCHIVE',
					videoSort: 'TIME',
				},
				PERSISTED_QUERIES.filterableVideoTower,
			);
			if (!res.ok) return c.json({ error: `GraphQL returned ${res.status}` }, 502);
			const body = (await res.json()) as {
				data?: {
					user?: {
						videos?: {
							edges: { node: Record<string, unknown> }[];
							pageInfo: { hasNextPage: boolean };
						};
					} | null;
				};
			};
			if (!body.data?.user) {
				return c.json({ error: `No such channel "${login}"` }, 404);
			}
			const videos = body.data.user.videos;
			const items = videos?.edges.map((e) => e.node) ?? [];
			return c.json({
				login,
				items,
				returned: items.length,
				hasMore: videos?.pageInfo.hasNextPage ?? false,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// HLS MEDIA
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 3: Live HLS stream — token → master playlist → variants ──
	//
	// Full chain verified with zero browser/cookies during discovery: the
	// PlaybackAccessToken GraphQL call, the usher.ttvnw.net master playlist it
	// unlocks, and one of the master's own variant playlists all returned 200
	// from a bare `curl` with no session. Unlike YouTube (see the
	// domain-youtube config comment), Twitch hands out a real fetchable URL
	// chain rather than negotiating media in a proprietary framing — so this
	// is a genuine media route, not a driven-player workaround.
	{
		method: 'GET',
		path: '/stream/:login/hls',
		examples: ['/stream/t90official/hls'],
		upstream: [
			'gql.twitch.tv/gql',
			'usher.ttvnw.net/api/v2/channel/hls/{login}.m3u8',
			'{node}.playlist.ttvnw.net/v1/playlist/{id}.m3u8',
		],
		transport: 'HLS/Media',
		description:
			'Live stream playback: PlaybackAccessToken → usher master playlist → quality variants (each a directly fetchable .m3u8) → one variant fetched to prove the chain resolves to real segments.',
		browserRequired: false,
		handler: async (c) => {
			const login = (c.req.param() as Record<string, string>).login;

			const tokenRes = await gql(
				'PlaybackAccessToken',
				{ isLive: true, login, isVod: false, vodID: '', playerType: 'site', platform: 'web' },
				PERSISTED_QUERIES.playbackAccessToken,
			);
			if (!tokenRes.ok) return c.json({ error: `Token request returned ${tokenRes.status}` }, 502);
			const tokenBody = (await tokenRes.json()) as {
				data?: { streamPlaybackAccessToken?: { value: string; signature: string } | null };
			};
			const token = tokenBody.data?.streamPlaybackAccessToken;
			if (!token) {
				// A null token here means the channel is offline — Twitch's own
				// contract, not a route failure — so this is reported as a fact,
				// not masked as a 502.
				return c.json({ login, live: false, error: 'Channel is offline or does not exist' }, 404);
			}

			const qs = new URLSearchParams({
				player: 'twitchweb',
				token: token.value,
				sig: token.signature,
				allow_source: 'true',
				allow_audio_only: 'true',
				fast_bread: 'true',
			});
			const masterRes = await rateLimitedFetch(
				`https://usher.ttvnw.net/api/v2/channel/hls/${encodeURIComponent(login)}.m3u8?${qs}`,
			);
			if (!masterRes.ok) {
				return c.json({ login, live: false, error: `usher returned ${masterRes.status}` }, 502);
			}
			const masterPlaylist = await masterRes.text();
			const variants = parseMasterPlaylist(masterPlaylist);

			// A URL that resolves to nothing is not a stream: fetch the lowest-
			// bandwidth variant (cheapest to prove, same chain as the rest) and
			// pull its first segment URL, so the response carries evidence the
			// chain actually resolves rather than just a list of unverified URLs.
			let sampleSegment: { variantPlaylistStatus: number; firstSegmentUrl: string | null } | null =
				null;
			const cheapest = [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
			if (cheapest) {
				const variantRes = await rateLimitedFetch(cheapest.url);
				const variantPlaylist = variantRes.ok ? await variantRes.text() : '';
				const firstSegmentUrl =
					variantPlaylist.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? null;
				sampleSegment = { variantPlaylistStatus: variantRes.status, firstSegmentUrl };
			}

			return c.json({ login, live: true, variants, masterPlaylist, sampleSegment });
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// WEBSOCKET
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 4: Live chat tail (anonymous IRC-over-WS) ──────────────
	//
	// irc-ws.chat.twitch.tv speaks IRC framed over a WebSocket. Confirmed
	// during discovery with the anonymous `justinfan*` login every logged-out
	// viewer's chat box uses — `PASS SCHMOOPIIE` / `NICK justinfan12345` needs
	// no token, and the gateway immediately started delivering tagged PRIVMSG
	// frames for a live, busy channel. Text protocol, not JSON — parsed here
	// into the fields a consumer actually wants.
	//
	// NOT covered here: `hermes.twitch.tv`, a second WebSocket also present in
	// the elimination sweep. Its first frame is a PKCS7-shaped encrypted
	// envelope (`{"welcome":{"keepaliveSec":...,"recoveryUrl":...}}` wrapping
	// base64 ciphertext) — read per discovery.md's "a socket's frames are the
	// finding" rule, and what they show is an encrypted PubSub channel with no
	// documented client-side decryption path. Present, not built: reverse-
	// engineering Twitch's proprietary envelope is a separate project from
	// this discovery pass.
	{
		method: 'GET',
		path: '/chat/:login/tail',
		examples: ['/chat/buster/tail?count=5'],
		upstream: ['irc-ws.chat.twitch.tv/'],
		transport: 'WebSocket',
		description: 'Anonymous chat tail: capture N live PRIVMSG frames from a channel’s chat.',
		browserRequired: false,
		handler: async (c) => {
			const login = (c.req.param() as Record<string, string>).login;
			const count = Math.min(Number(new URL(c.req.url).searchParams.get('count') ?? '5'), 25);
			const wsUrl = 'wss://irc-ws.chat.twitch.tv:443';
			const anonNick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

			DEBUG('twitch', `chat: connecting to ${wsUrl} for #${login}, capturing ${count} messages`);
			const { default: WebSocket } = await import('ws');
			const messages: { user: string; text: string; ts: string; badges: string }[] = [];

			const result = await new Promise<typeof messages>((resolve) => {
				const ws = new WebSocket(wsUrl);
				const timeout = setTimeout(() => {
					ws.close();
					resolve(messages);
				}, 15000);

				ws.on('open', () => {
					ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
					ws.send('PASS SCHMOOPIIE');
					ws.send(`NICK ${anonNick}`);
					ws.send(`JOIN #${login.toLowerCase()}`);
				});
				ws.on('message', (data: Buffer) => {
					for (const line of data.toString().split('\r\n')) {
						if (!line || !line.includes('PRIVMSG')) continue;
						const tagsMatch = line.match(/^@([^ ]+) /);
						const tags = Object.fromEntries(
							(tagsMatch?.[1] ?? '').split(';').map((kv) => kv.split('=') as [string, string]),
						);
						const userMatch = line.match(/:([^!]+)!/);
						const textMatch = line.match(/PRIVMSG #[^ ]+ :(.*)$/);
						if (!userMatch || !textMatch) continue;
						messages.push({
							user: tags['display-name'] || userMatch[1],
							text: textMatch[1],
							ts: tags['tmi-sent-ts'] ?? '',
							// Empty string rather than null for "no badges" — chat frames
							// mix the two states within one capture, and a field whose type
							// varies per element defeats the shape check that guards
							// against silent upstream drift (see route-spec.mjs's shape
							// tier). Consistently a string keeps that check meaningful.
							badges: tags.badges || '',
						});
						if (messages.length >= count) {
							clearTimeout(timeout);
							ws.close();
							resolve(messages);
						}
					}
				});
				ws.on('error', () => {
					clearTimeout(timeout);
					resolve(messages);
				});
			});

			return c.json({
				login,
				messages: result,
				returned: result.length,
				hasMore: result.length < count,
				_note:
					result.length < count
						? 'Fewer messages arrived than requested within the 15s capture window — the channel may be quiet, not offline.'
						: undefined,
				source: wsUrl,
			});
		},
	},

	// ═══════════════════════════════════════════════════════════════════
	// JSONP
	// ═══════════════════════════════════════════════════════════════════

	// ─── Route 5: Feature-flag config (Eppo JSONP) ────────────────────
	{
		method: 'GET',
		path: '/featureflags',
		examples: ['/featureflags'],
		upstream: ['assets.twitch.tv/eppo/api/flag-config/v1/config'],
		transport: 'JSONP',
		description:
			"Twitch web client's Eppo feature-flag config, stripped of its JSONP callback wrapper.",
		browserRequired: false,
		handler: async (c) => {
			// The API key here is the public Eppo SDK key twitch.tv's own bundle
			// ships in cleartext (not a secret credential) — captured from traffic.
			const apiKey = '3mv-BKCSZJDyZrwfqK86har6u13NgxRh.ZWg9bTRsZHJnLmUuZXBwby5jbG91ZCZjcz1tNGxkcmc';
			const qs = new URLSearchParams({
				sdkName: 'js-sdk-client',
				sdkVersion: '3.1.2',
				apiKey,
				callback: '__eppoConfig',
			});
			const res = await rateLimitedFetch(
				`https://assets.twitch.tv/eppo/api/flag-config/v1/config?${qs}`,
			);
			if (!res.ok) return c.json({ error: `Eppo config returned ${res.status}` }, 502);
			const wrapped = await res.text();
			// Strip `/**/ typeof __eppoConfig === 'function' && __eppoConfig({...});`
			const match = wrapped.match(/__eppoConfig\((.*)\);?\s*$/s);
			if (!match) return c.json({ error: 'Could not unwrap JSONP callback' }, 502);
			const config = JSON.parse(match[1]) as { flags?: Record<string, unknown> };
			return c.json({
				environment: (config as { environment?: { name?: string } }).environment?.name,
				flagCount: Object.keys(config.flags ?? {}).length,
				flags: config.flags ?? {},
			});
		},
	},
];
