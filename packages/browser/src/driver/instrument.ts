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

/**
 * Namespace for the DOM event channel. Not a global property — the buffer never
 * becomes one, because an unexplained entry on `window` is the loudest tell an
 * instrumented page carries. This only names the events and the transient
 * handshake attribute.
 */
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
	| 'stream-response'
	| 'blob-script'
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
export const INSTRUMENT_LIMITS = {
	maxEvents: 2000,
	maxBodyChars: 512,
	/**
	 * Blob-backed script sources get their own, far larger allowance. A payload
	 * preview exists to identify a call; a worker's source exists to be scanned
	 * for what it reaches out to, and 512 characters of a bundled worker says
	 * nothing. This is the only place the whole text is ever readable.
	 */
	maxBlobScriptChars: 200_000,
} as const;

/**
 * Runs inside the page. Self-contained by construction: `toString()` is what
 * ships, so a reference to anything in module scope would arrive undefined.
 */
function instrumentSource(
	limits: { maxEvents: number; maxBodyChars: number; maxBlobScriptChars: number },
	globalName: string,
	/** This function's own text, so a worker bootstrap can install it in worker scope. */
	_selfSource: string,
) {
	// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
	const g: any = globalThis;

	// The buffer stays in this closure and never becomes a property of `window`.
	// An unexplained global is the single loudest tell an instrumented page has —
	// `Object.getOwnPropertyNames(window)` finds it whatever the property flags
	// say — and it is unnecessary, because the DOM event below is already the
	// only door the reader needs.
	const events: unknown[] = [];
	const t0 = Date.now();

	/**
	 * Carry the buffer across a navigation.
	 *
	 * The buffer lives in this closure, which is what keeps it off `window` — and
	 * means it dies with the document. That is invisible while a page is only
	 * being watched and fatal once it is being *driven*, because the provocations
	 * worth making are the ones that navigate. A search form records its
	 * submission and navigates in the same tick: no poll interval is short enough
	 * to read the gap, and the event that proves the transport is the one
	 * guaranteed to be lost.
	 *
	 * So the buffer is handed to the next document through `sessionStorage`, which
	 * is per-tab, per-origin, and survives exactly the same-origin navigations
	 * this needs to cross. The key exists only between `pagehide` and the next
	 * install, and the uninstall path clears it, so the residue is bounded rather
	 * than permanent — a real tell, and a smaller one than losing the finding.
	 */
	const HANDOFF_KEY = `${globalName}_handoff`;
	try {
		const carried = g.sessionStorage?.getItem(HANDOFF_KEY);
		if (carried) {
			g.sessionStorage.removeItem(HANDOFF_KEY);
			const parsed = JSON.parse(carried);
			if (Array.isArray(parsed)) events.push(...parsed.slice(0, limits.maxEvents));
		}
	} catch {
		/* storage may be denied by policy; the live buffer still works */
	}
	try {
		g.addEventListener?.('pagehide', () => {
			try {
				if (events.length) g.sessionStorage?.setItem(HANDOFF_KEY, JSON.stringify(events));
			} catch {
				/* a full or denied store loses this document's tail, nothing more */
			}
		});
	} catch {
		/* no event target here — worker scope, where there is no navigation */
	}

	// Idempotence without a global: ping the channel and see whether an earlier
	// install answers. Dispatcher and listener are both in this world, so they
	// share the detail object and the flag survives the round trip.
	try {
		if (g.document?.dispatchEvent) {
			const ping: { detail: { seen: boolean } } = new g.CustomEvent(`${globalName}_ping`, {
				detail: { seen: false },
			});
			g.document.dispatchEvent(ping as unknown as Event);
			if (ping.detail.seen) return;
			g.document.addEventListener(`${globalName}_ping`, (e: { detail?: { seen: boolean } }) => {
				if (e.detail) e.detail.seen = true;
			});
		}
	} catch {
		/* a scope without CustomEvent installs unconditionally */
	}

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
			// A binary payload used to be recorded as its size and nothing else, which
			// is enough to prove a socket exists and useless for deciding what it
			// carries. Protobuf, msgpack and length-prefixed envelopes all arrive
			// this way, and a row saying `[binary 128b]` reads exactly like an empty
			// stream. A bounded base64 prefix keeps it decodable.
			const toBase64 = (bytes: Uint8Array): string => {
				const capped = bytes.subarray(0, Math.floor(limits.maxBodyChars * 0.75));
				let s = '';
				for (const b of capped) s += String.fromCharCode(b);
				const b64 = typeof btoa === 'function' ? btoa(s) : '';
				return `[base64:${bytes.length}b] ${b64}${bytes.length > capped.length ? '…' : ''}`;
			};
			if (typeof ArrayBuffer !== 'undefined') {
				if (ArrayBuffer.isView(v)) {
					return toBase64(new Uint8Array(anyV.buffer, anyV.byteOffset, anyV.byteLength));
				}
				if (v instanceof ArrayBuffer) return toBase64(new Uint8Array(v));
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

	/**
	 * Make a wrapper answer `toString()` the way the function it replaced does.
	 *
	 * A patched global is trivially detectable: `String(fetch)` on a native
	 * function reports `[native code]`, and on a wrapper reports its source.
	 * Bot-detection scripts read exactly that, so instrumenting a hardened target
	 * can be what gets the session blocked — the observation changing the thing
	 * observed. Routing every wrapper through one patched `Function.prototype
	 * .toString` keeps the answer native and leaves no own `toString` property on
	 * the wrapper, which a per-function override would.
	 */
	const originals = new WeakMap<object, unknown>();
	// Every replacement, recorded so the page can be handed back unmodified. A
	// session that keeps the patches carries a permanent tell; one that restores
	// them looks like any other tab from the moment discovery ends.
	const restores: Array<() => void> = [];
	try {
		const fnToString = Function.prototype.toString;
		const patchedToString = function (this: unknown) {
			const orig = originals.get(this as object);
			return fnToString.call(orig ?? this);
		};
		originals.set(patchedToString, fnToString);
		Function.prototype.toString = patchedToString;
		restores.push(() => {
			Function.prototype.toString = fnToString;
		});
	} catch {
		/* a sealed Function.prototype leaves wrappers visible; capture still works */
	}

	/**
	 * Wrap `obj[key]`, always calling through even when the hook fails.
	 *
	 * The hook receives the call's `this`. Prototype methods are where the useful
	 * detail lives — an XHR's verb and URL are stashed on the instance by `open`
	 * and read back by `send`, a form's method and action live on the element —
	 * so a hook invoked without its receiver silently records a default verb and
	 * an empty URL. That produces a row rather than nothing, which is worse: the
	 * transport still shows present while its evidence points nowhere.
	 */
	const patch = (
		// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
		obj: any,
		key: string,
		// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
		hook: (this: any, args: any[]) => void,
	) => {
		try {
			const orig = obj?.[key];
			if (typeof orig !== 'function') return;
			// biome-ignore lint/suspicious/noExplicitAny: patching foreign globals
			const wrapper = function (this: unknown, ...args: any[]) {
				try {
					hook.call(this, args);
				} catch {
					/* a bad hook must not break the page */
				}
				return orig.apply(this, args);
			};
			originals.set(wrapper, orig);
			obj[key] = wrapper;
			restores.push(() => {
				obj[key] = orig;
			});
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

	// ─── Drain channel ──────────────────────────────────────────────────
	// The buffer lives in this world; a reader outside it cannot see the global.
	// The obvious bridge injects a <script>, which any `script-src` policy
	// refuses — and a great many real sites ship one, so that path would report
	// an instrumented page as a page that made no calls. DOM *events* cross the
	// world boundary without injecting anything: a listener registered here fires
	// for an event dispatched from an isolated world, because the DOM is shared.
	// So the reader dispatches, this writes the buffer to an attribute, and the
	// reader reads it back with an ordinary evaluate.
	try {
		if (g.document?.addEventListener) {
			g.document.addEventListener(`${globalName}_drain`, () => {
				try {
					const batch = events.splice(0, events.length);
					g.document.documentElement.setAttribute(`${globalName}_out`, JSON.stringify(batch));
				} catch {
					/* a page that cannot hold the attribute keeps its events buffered */
				}
			});
		}
	} catch {
		/* worker scope has no document; its buffer is read another way */
	}

	// Uninstall rides the same channel. Exposing a named restore function would
	// mean a second unexplained global, which is the residue this is here to
	// remove, so the command arrives as an event like the drain does.
	try {
		if (g.document?.addEventListener) {
			g.document.addEventListener(`${globalName}_uninstall`, () => {
				try {
					// Reverse order: a later patch may wrap an earlier one.
					for (const undo of restores.reverse()) {
						try {
							undo();
						} catch {
							/* one failed restore must not strand the others */
						}
					}
					events.length = 0;
					g.document.documentElement.setAttribute(`${globalName}_gone`, '1');
				} catch {
					/* a page that refuses restoration keeps the patches */
				}
			});
		}
	} catch {
		/* worker scope has no document */
	}

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
			originals.set(Wrapped, Orig);
			g[name] = Wrapped;
			restores.push(() => {
				g[name] = Orig;
			});
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

	// ─── Streaming response bodies ──────────────────────────────────────
	// Reading `.body` off a Response is the streaming access pattern: a caller
	// that wanted the whole payload calls `.json()` or `.text()` instead. This is
	// how token streams, live logs and progressive feeds arrive without SSE or a
	// socket, and at the wire it is an ordinary request — so a capture that only
	// records the request start files a live stream as a slow GET.
	try {
		const desc = Object.getOwnPropertyDescriptor(g.Response?.prototype ?? {}, 'body');
		if (desc?.get) {
			Object.defineProperty(g.Response.prototype, 'body', {
				...desc,
				get(this: { url?: string }) {
					rec({
						kind: 'stream-response',
						method: 'GET',
						url: this?.url ?? '',
						detail: 'body-read',
					});
					return desc.get?.call(this);
				},
			});
			restores.push(() => Object.defineProperty(g.Response.prototype, 'body', desc));
		}
	} catch {
		/* an engine without a patchable Response leaves this row to the scan */
	}

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
	// traffic — and that is where real sites put the interesting work. A finance
	// site's entire price feed and a video site's media fetching both live in
	// one, invisible across every instrumented pass until someone read the
	// worker's source by hand.
	//
	// So the worker is instrumented too. Rather than loading the site's script
	// directly, it loads a bootstrap that installs this same source into the
	// worker's scope and then pulls the original in — the worker runs unchanged,
	// with the patches already in place. Events come back over a BroadcastChannel
	// rather than postMessage, because postMessage is the worker's own protocol
	// with the page and injecting into it would corrupt the site's messages.
	// Recording the script URL, not rewriting the worker.
	//
	// Instrumenting worker scope was tried and reverted. The approach — load a
	// blob that installs this instrument and then pulls the real script in with
	// `importScripts` — works, and breaks the worker: a blob has no meaningful
	// base URL, so every relative request the worker makes resolves against the
	// blob and fails. The site's own worker stopped fetching entirely. An aid
	// that breaks what it observes is not a trade this instrument may make,
	// whatever it would otherwise have shown.
	//
	// The workable version rewrites the worker's response body while it keeps its
	// real URL, which means request routing rather than a page-side patch. Until
	// then the gap is covered by reading: the manifest fetches each worker script
	// and reports the transports in its source, which is how a live run found a
	// price feed no capture could see.
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

	// ─── Blob-backed scripts ────────────────────────────────────────────
	// A worker built from a blob has no fetchable URL: `blob:` resolves only
	// inside the page that made it, so the fallback of reading a worker's source
	// from outside fails exactly where it is needed most. A large video site
	// builds every one of its workers this way, and that is where it fetches
	// media. Capturing the text at the moment the blob becomes a URL is the only
	// point where it is still readable.
	patch(g.URL, 'createObjectURL', (args) => {
		try {
			const blob = args[0] as { type?: string; text?: () => Promise<string> };
			if (!blob?.text) return;
			const type = String(blob.type ?? '');
			if (type && !/javascript|ecmascript|worker|text\/plain/i.test(type)) return;
			// Asynchronous by necessity — a blob cannot be read synchronously — so
			// the source arrives shortly after the URL it describes.
			blob.text().then(
				(text) =>
					rec({ kind: 'blob-script', method: 'DATA', url: 'blob:script', body: clip(text) }),
				() => undefined,
			);
		} catch {
			/* an unreadable blob is a gap, not a failure */
		}
	});

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

			// A form reaches the network two ways and they do not overlap. The patch
			// above sees `form.submit()` and nothing else; a person pressing Enter or
			// clicking a submit button runs the browser's own submission algorithm,
			// which never calls that method and fires this event instead. Measured
			// on all three triggers: button click and Enter produce only the event,
			// `form.submit()` produces only the method call, and each puts a real
			// request on the wire. So capturing one of the two misses whichever half
			// the site uses — and the scripted call, the half we had, is the rare one.
			// A search box is the common case, and it submits the way we could not see.
			const onSubmit = (ev: Event) => {
				try {
					// biome-ignore lint/suspicious/noExplicitAny: foreign element
					const f = (ev as any).target;
					// biome-ignore lint/suspicious/noExplicitAny: foreign element
					const submitter = (ev as any).submitter;
					// The button that submits may redirect the form to somewhere else.
					const method = String(
						submitter?.getAttribute?.('formmethod') || f?.method || 'GET',
					).toUpperCase();
					const action = submitter?.getAttribute?.('formaction') || f?.action;
					// Field names are the finding. The URL says which endpoint; the
					// names say what it accepts, and on a GET form they are exactly the
					// query parameters a route will have to send.
					let body = '';
					try {
						const parts: string[] = [];
						for (const [k, v] of new g.FormData(f).entries()) {
							parts.push(`${k}=${typeof v === 'string' ? v.slice(0, 40) : '[file]'}`);
							if (parts.length >= 20) break;
						}
						body = parts.join('&').slice(0, limits.maxBodyChars);
					} catch {
						/* a detached or exotic form still yields a useful url and method */
					}
					rec({ kind: 'form-submit', method, url: urlOf(action), body });
				} catch {
					/* observation must never break the page's own submission */
				}
			};
			g.document.addEventListener('submit', onSubmit, true);
			restores.push(() => {
				try {
					g.document.removeEventListener('submit', onSubmit, true);
				} catch {
					/* already gone with the document */
				}
			});
		}
	} catch {
		/* worker scope has no DOM — expected, not an error */
	}
}

/**
 * Helpers a build step injects into transpiled output.
 *
 * Authoring the instrument as a function buys type checking and lint over two
 * hundred lines of delicate patching, but shipping it means `toString()`, and
 * transpiled output is not self-contained. Under esbuild's `--keep-names` —
 * which tsx enables by default, and several bundlers do too — every function
 * expression becomes `__name(fn, "id")` with `__name` defined in module scope.
 * The stringified body carries the call and leaves the definition behind, so
 * the page evaluates a reference it cannot resolve and the whole instrument
 * dies with a ReferenceError before its first statement. Nothing throws on our
 * side: install reports success, the drain returns an empty buffer, and the run
 * reads a fully instrumented page as a site that makes no calls.
 *
 * Defining the helpers as identities makes the source self-sufficient whatever
 * the build did. This list covers what is known to appear; a build that injects
 * a new one fails the same silent way, which is why `scripts/capture-bench.mjs`
 * exists and why a recall drop is treated as a regression rather than noise.
 * No unit test can catch this — the test runner's own transpiler decides
 * whether the helper is there at all.
 */
const BUILD_HELPER_PROLOGUE =
	'var __name=function(f){return f};' +
	'var __publicField=function(o,k,v){o[k]=v;return v};' +
	'var __defProp=Object.defineProperty;';

/**
 * The installable source. Wrapped so `addInitScript` can evaluate it directly,
 * and so the same string works in a page, an iframe, and a worker.
 */
/**
 * The installable source.
 *
 * The function receives its own text as an argument so a worker bootstrap can
 * install the same instrument in worker scope — the one place a page-side patch
 * cannot reach, and the place real sites put their price feeds and their media
 * fetching. Passing it along again means a worker that spawns its own worker is
 * covered too.
 */
const SELF = instrumentSource.toString();
export const INSTRUMENT_SOURCE = `(function(){${BUILD_HELPER_PROLOGUE}return (${SELF})(${JSON.stringify(
	INSTRUMENT_LIMITS,
)}, ${JSON.stringify(EGRESS_GLOBAL)}, ${JSON.stringify(SELF)})})()`;

/**
 * Reads and clears the buffer from *outside* the page's world.
 *
 * Runs as an ordinary evaluate — no script injection — so it works under a
 * `script-src` policy that would refuse the main-world bridge. The event
 * crosses into the page's world, the instrument answers on the shared DOM, and
 * this reads the answer back.
 */
export const DRAIN_SOURCE = `(() => {
	try {
		if (typeof document === 'undefined') return [];
		document.dispatchEvent(new CustomEvent(${JSON.stringify(`${EGRESS_GLOBAL}_drain`)}));
		const raw = document.documentElement.getAttribute(${JSON.stringify(`${EGRESS_GLOBAL}_out`)});
		if (raw === null) return [];
		document.documentElement.removeAttribute(${JSON.stringify(`${EGRESS_GLOBAL}_out`)});
		return JSON.parse(raw);
	} catch {
		return [];
	}
})()`;

/**
 * Removes every patch and the buffer, leaving the page as it was found.
 *
 * Discovery aids are detectable by construction — a patched global, an
 * unexplained property on `window`, an attribute that appears and vanishes.
 * That is an acceptable cost while learning what a site has, and an unacceptable
 * one afterwards: the session that collects data should carry no evidence that
 * anything was ever instrumented. Runs as an ordinary evaluate, so no injection
 * and no CSP dependency.
 */
export const UNINSTALL_SOURCE = `(() => {
	try {
		if (typeof document === 'undefined') return false;
		document.dispatchEvent(new CustomEvent(${JSON.stringify(`${EGRESS_GLOBAL}_uninstall`)}));
		const flag = ${JSON.stringify(`${EGRESS_GLOBAL}_gone`)};
		const done = document.documentElement.hasAttribute(flag);
		document.documentElement.removeAttribute(flag);
		return done;
	} catch {
		return false;
	}
})()`;
