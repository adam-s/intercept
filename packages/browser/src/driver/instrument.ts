/**
 * Main-World Egress Instrumentation
 *
 * Wire-level capture sees bytes and loses meaning. It cannot tell an
 * `EventSource` from a long-poll `fetch` — both are a GET that stays open — and
 * it never learns which bundle made the call. That distinction is exactly what
 * a transport elimination table is asking for, so capture that cannot draw it
 * pushes the work onto a model, which then guesses.
 *
 * This patches every browser egress primitive before page scripts run and
 * records what the page *meant*: which API it reached for, the initiating stack
 * frame, and a bounded payload preview. Paired with wire capture (which sees
 * what patching cannot — service workers, native redirects) the two together
 * cover the surface, and neither alone does.
 *
 * Three properties this must hold, because it runs inside somebody else's page:
 *  - It never throws into page code. Every patch is wrapped and always calls
 *    through to the original, so a failure here degrades capture rather than
 *    the page under observation.
 *  - It is bounded. A ring buffer with a hard event cap and a payload preview
 *    limit, because an unbounded buffer on a long-lived page is a leak that
 *    shows up as a browser crash an hour later.
 *  - It is scope-agnostic. The same source installs in a page, an iframe, and a
 *    worker, so it may not assume `document` or `window` exist.
 *
 * @module browser/driver/instrument
 */

/** Where the buffer lands. Stable, because the drain side reads it by name. */
export const EGRESS_GLOBAL = '__ic_egress';

/** One observed egress call, as the page's own JS expressed it. */
export interface EgressEvent {
	/** Which primitive the page reached for — the transport signal. */
	kind: EgressKind;
	/** HTTP verb, or a pseudo-verb for non-HTTP primitives ('WS', 'OPEN', 'SUB'). */
	method: string;
	url: string;
	/** Bounded preview of the request payload, when the primitive carries one. */
	body?: string;
	/** First stack frame outside this instrument — which bundle initiated it. */
	initiator?: string;
	/** Milliseconds since install. Ordering and burst detection, not wall time. */
	t: number;
	/** Per-kind extra: frame direction, MIME, transferred channel label. */
	detail?: string;
}

/**
 * The primitives worth telling apart. Each maps to a distinct elimination-table
 * row, which is the whole reason the list is explicit rather than "network".
 */
export type EgressKind =
	| 'fetch'
	| 'xhr'
	| 'websocket'
	| 'websocket-frame'
	| 'eventsource'
	| 'beacon'
	| 'webrtc'
	| 'webtransport'
	| 'worker'
	| 'serviceworker'
	| 'importscripts'
	| 'jsonp'
	| 'image-beacon'
	| 'media-append'
	| 'form-submit'
	| 'postmessage'
	| 'broadcast';

/** Hard caps. A page left open for an hour must not grow this without bound. */
export const INSTRUMENT_LIMITS = { maxEvents: 2000, maxBodyChars: 512 } as const;

/**
 * Runs inside the page. Self-contained by construction: `toString()` is what
 * ships, so a reference to anything in module scope would arrive undefined.
 */
function instrumentSource(limits: { maxEvents: number; maxBodyChars: number }, globalName: string) {
	// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
	const g: any = globalThis;
	if (g[globalName]) return; // survive a double-install (re-navigation, re-attach)

	const t0 = Date.now();
	const events: unknown[] = [];
	g[globalName] = events;

	const clip = (v: unknown): string | undefined => {
		if (v == null) return undefined;
		const cut = (s: string) =>
			s.length > limits.maxBodyChars ? `${s.slice(0, limits.maxBodyChars)}…` : s;
		try {
			if (typeof v === 'string') return cut(v);

			// Body types that must be described rather than serialized. A typed
			// array survives JSON.stringify as an index-keyed object, so relying on
			// a throw here records `{"0":0,"1":0,…}` and loses the one fact that
			// mattered — the payload was binary. Form bodies go the other way: the
			// encoded text *is* the request, so it is worth reading out.
			// biome-ignore lint/suspicious/noExplicitAny: duck-typing foreign body types
			const anyV = v as any;
			if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) {
				return cut(v.toString());
			}
			if (typeof FormData !== 'undefined' && v instanceof FormData) {
				return cut(`[FormData ${[...v.keys()].join(',')}]`);
			}
			if (typeof ArrayBuffer !== 'undefined') {
				if (ArrayBuffer.isView(v)) return `[binary ${anyV.byteLength}b]`;
				if (v instanceof ArrayBuffer) return `[binary ${v.byteLength}b]`;
			}
			if (typeof Blob !== 'undefined' && v instanceof Blob) {
				return `[Blob ${anyV.size}b ${anyV.type || 'unknown'}]`;
			}
			if (typeof ReadableStream !== 'undefined' && v instanceof ReadableStream) {
				return '[ReadableStream]';
			}

			const s = JSON.stringify(v);
			if (typeof s !== 'string') return `[${Object.prototype.toString.call(v)}]`;
			return cut(s);
		} catch {
			return `[${Object.prototype.toString.call(v)}]`;
		}
	};

	// The frame that called the patched API. Skipping our own frames is what
	// makes this point at the page's bundle instead of at this file.
	const initiator = (): string | undefined => {
		try {
			const lines = String(new Error().stack || '').split('\n');
			for (const line of lines.slice(1)) {
				if (!line.includes('instrumentSource') && !line.includes(globalName)) {
					return line.trim().slice(0, 200);
				}
			}
		} catch {
			/* stack unavailable in this engine — the event is still worth having */
		}
		return undefined;
	};

	const rec = (e: Record<string, unknown>) => {
		try {
			if (events.length >= limits.maxEvents) return;
			events.push({ ...e, t: Date.now() - t0, initiator: initiator() });
		} catch {
			/* recording must never break the caller */
		}
	};

	/** Wrap `obj[key]`, always calling through even when the hook fails. */
	const patch = (
		// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
		obj: any,
		key: string,
		// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
		hook: (args: any[]) => void,
	) => {
		try {
			const orig = obj?.[key];
			if (typeof orig !== 'function') return;
			// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
			obj[key] = function (this: unknown, ...args: any[]) {
				try {
					hook(args);
				} catch {
					/* a bad hook must not break the page */
				}
				return orig.apply(this, args);
			};
		} catch {
			/* a frozen or absent global is a gap, not a failure */
		}
	};

	const urlOf = (v: unknown): string => {
		try {
			if (typeof v === 'string') return v;
			// biome-ignore lint/suspicious/noExplicitAny: Request | URL duck-typing
			const anyV = v as any;
			return String(anyV?.url ?? anyV?.href ?? anyV ?? '');
		} catch {
			return '';
		}
	};

	// ─── fetch ──────────────────────────────────────────────────────────
	patch(g, 'fetch', (args) => {
		const init = args[1] || {};
		rec({
			kind: 'fetch',
			method: String(init.method || args[0]?.method || 'GET').toUpperCase(),
			url: urlOf(args[0]),
			body: clip(init.body),
		});
	});

	// ─── XMLHttpRequest ─────────────────────────────────────────────────
	// open() carries the verb and URL, send() carries the body; stash the former
	// on the instance so the latter can emit one complete event.
	try {
		const XP = g.XMLHttpRequest?.prototype;
		patch(XP, 'open', function (this: unknown, args: unknown[]) {
			// biome-ignore lint/suspicious/noExplicitAny: per-instance stash
			(this as any).__ic = { method: String(args[0] || 'GET'), url: urlOf(args[1]) };
		});
		if (XP) {
			const origSend = XP.send;
			XP.send = function (this: unknown, ...args: unknown[]) {
				// biome-ignore lint/suspicious/noExplicitAny: per-instance stash
				const meta = (this as any).__ic || {};
				rec({
					kind: 'xhr',
					method: meta.method || 'GET',
					url: meta.url || '',
					body: clip(args[0]),
				});
				return origSend.apply(this, args);
			};
		}
	} catch {
		/* engine without a patchable XHR prototype */
	}

	/** Wrap a constructor so `new X(...)` is observed and frames can be tapped. */
	const patchCtor = (name: string, onNew: (inst: unknown, args: unknown[]) => void) => {
		try {
			const Orig = g[name];
			if (typeof Orig !== 'function') return;
			// biome-ignore lint/suspicious/noExplicitAny: reconstructing a foreign ctor
			const Wrapped: any = function (this: unknown, ...args: any[]) {
				const inst = new Orig(...args);
				try {
					onNew(inst, args);
				} catch {
					/* observation failure must not break construction */
				}
				return inst;
			};
			Wrapped.prototype = Orig.prototype;
			for (const k of Object.keys(Orig)) Wrapped[k] = Orig[k];
			g[name] = Wrapped;
		} catch {
			/* absent in this scope */
		}
	};

	// ─── WebSocket ──────────────────────────────────────────────────────
	// Frames matter as much as the handshake: a chat tunnel and a metrics ping
	// look identical at the URL and completely different one frame in.
	patchCtor('WebSocket', (inst, args) => {
		const url = urlOf(args[0]);
		rec({ kind: 'websocket', method: 'WS', url, detail: clip(args[1]) });
		try {
			// biome-ignore lint/suspicious/noExplicitAny: foreign instance
			const ws = inst as any;
			patch(ws, 'send', (sendArgs) =>
				rec({
					kind: 'websocket-frame',
					method: 'WS',
					url,
					body: clip(sendArgs[0]),
					detail: 'sent',
				}),
			);
			ws.addEventListener('message', (ev: { data?: unknown }) =>
				rec({
					kind: 'websocket-frame',
					method: 'WS',
					url,
					body: clip(ev?.data),
					detail: 'received',
				}),
			);
		} catch {
			/* handshake alone still proves the transport */
		}
	});

	// ─── EventSource (SSE) ──────────────────────────────────────────────
	patchCtor('EventSource', (inst, args) => {
		const url = urlOf(args[0]);
		rec({ kind: 'eventsource', method: 'GET', url });
		try {
			// biome-ignore lint/suspicious/noExplicitAny: foreign instance
			(inst as any).addEventListener('message', (ev: { data?: unknown }) =>
				rec({ kind: 'eventsource', method: 'GET', url, body: clip(ev?.data), detail: 'message' }),
			);
		} catch {
			/* open alone still proves SSE */
		}
	});

	// ─── sendBeacon ─────────────────────────────────────────────────────
	patch(g.navigator, 'sendBeacon', (args) =>
		rec({ kind: 'beacon', method: 'POST', url: urlOf(args[0]), body: clip(args[1]) }),
	);

	// ─── WebRTC / WebTransport ──────────────────────────────────────────
	patchCtor('RTCPeerConnection', (inst, args) => {
		rec({
			kind: 'webrtc',
			method: 'OPEN',
			url: clip(args[0]) || 'rtc:peer',
			detail: 'peerconnection',
		});
		// biome-ignore lint/suspicious/noExplicitAny: foreign instance
		patch(inst as any, 'createDataChannel', (dcArgs) =>
			rec({
				kind: 'webrtc',
				method: 'OPEN',
				url: `rtc:${String(dcArgs[0])}`,
				detail: 'datachannel',
			}),
		);
	});
	patchCtor('WebTransport', (_inst, args) =>
		rec({ kind: 'webtransport', method: 'OPEN', url: urlOf(args[0]) }),
	);

	// ─── Workers ────────────────────────────────────────────────────────
	// A worker gets its own global scope, so nothing patched here sees its
	// traffic. Recording the script URL is what tells a reader to go look.
	patchCtor('Worker', (_inst, args) =>
		rec({ kind: 'worker', method: 'OPEN', url: urlOf(args[0]), detail: 'dedicated' }),
	);
	patchCtor('SharedWorker', (_inst, args) =>
		rec({ kind: 'worker', method: 'OPEN', url: urlOf(args[0]), detail: 'shared' }),
	);
	patch(g, 'importScripts', (args) =>
		rec({ kind: 'importscripts', method: 'GET', url: urlOf(args[0]) }),
	);
	try {
		patch(g.navigator?.serviceWorker, 'register', (args) =>
			rec({ kind: 'serviceworker', method: 'OPEN', url: urlOf(args[0]) }),
		);
	} catch {
		/* no service worker in this scope */
	}

	// ─── BroadcastChannel / postMessage ─────────────────────────────────
	// Cross-frame RPC hides real work behind an iframe that does the fetching.
	patchCtor('BroadcastChannel', (inst, args) => {
		const name = String(args[0]);
		// biome-ignore lint/suspicious/noExplicitAny: foreign instance
		patch(inst as any, 'postMessage', (pmArgs) =>
			rec({ kind: 'broadcast', method: 'SUB', url: `bc:${name}`, body: clip(pmArgs[0]) }),
		);
	});
	patch(g, 'postMessage', (args) =>
		rec({
			kind: 'postmessage',
			method: 'SUB',
			url: `pm:${urlOf(args[1]) || '*'}`,
			body: clip(args[0]),
		}),
	);

	// ─── Media Source Extensions ────────────────────────────────────────
	// Adaptive playback appends demuxed segments here; seeing appends proves
	// HLS/DASH even when the manifest fetch is indistinguishable from any GET.
	try {
		patch(g.SourceBuffer?.prototype, 'appendBuffer', (args) => {
			// biome-ignore lint/suspicious/noExplicitAny: ArrayBufferView duck-typing
			const size = (args[0] as any)?.byteLength ?? 0;
			rec({ kind: 'media-append', method: 'DATA', url: 'mse:sourcebuffer', detail: `${size}b` });
		});
	} catch {
		/* no MSE here */
	}

	// ─── DOM-mediated egress: JSONP, pixels, native form posts ──────────
	// These never touch fetch or XHR. JSONP in particular is a real API call
	// that wire capture files under "script".
	try {
		if (g.document) {
			const desc = Object.getOwnPropertyDescriptor(g.HTMLScriptElement.prototype, 'src');
			if (desc?.set) {
				Object.defineProperty(g.HTMLScriptElement.prototype, 'src', {
					...desc,
					set(this: unknown, value: string) {
						if (/[?&](callback|jsonp)=/i.test(String(value))) {
							rec({ kind: 'jsonp', method: 'GET', url: String(value) });
						}
						desc.set?.call(this, value);
					},
				});
			}
			const imgDesc = Object.getOwnPropertyDescriptor(g.HTMLImageElement.prototype, 'src');
			if (imgDesc?.set) {
				Object.defineProperty(g.HTMLImageElement.prototype, 'src', {
					...imgDesc,
					set(this: unknown, value: string) {
						// A pixel carrying a query string is telemetry, not an image.
						if (String(value).includes('?')) {
							rec({ kind: 'image-beacon', method: 'GET', url: String(value) });
						}
						imgDesc.set?.call(this, value);
					},
				});
			}
			patch(g.HTMLFormElement?.prototype, 'submit', function (this: unknown) {
				// biome-ignore lint/suspicious/noExplicitAny: foreign element
				const f = this as any;
				rec({
					kind: 'form-submit',
					method: String(f?.method || 'GET').toUpperCase(),
					url: urlOf(f?.action),
				});
			});
		}
	} catch {
		/* worker scope has no DOM — expected, not an error */
	}
}

/**
 * The installable source. Wrapped so `addInitScript` can evaluate it directly,
 * and so the same string works in a page, an iframe, and a worker.
 */
export const INSTRUMENT_SOURCE = `(${instrumentSource.toString()})(${JSON.stringify(
	INSTRUMENT_LIMITS,
)}, ${JSON.stringify(EGRESS_GLOBAL)})`;

/** Reads and clears the buffer. Exported as source so any driver can evaluate it. */
export const DRAIN_SOURCE = `(() => {
	const b = globalThis[${JSON.stringify(EGRESS_GLOBAL)}];
	if (!b) return [];
	return b.splice(0, b.length);
})()`;
