/**
 * Calibration for the egress instrument.
 *
 * The instrument's claim is coverage: reach for any browser egress primitive
 * and an event comes out. That claim is only worth what it is tested against,
 * so this builds a fake global carrying every primitive, evaluates the real
 * shipped source against it in a fresh VM context, exercises each one, and
 * asserts the event. A patch that silently stops working — a renamed global, a
 * refactor that drops a case — turns a row red here instead of turning a
 * transport invisible during a live run.
 *
 * The other half of the claim is that it never breaks the page it observes.
 * Frozen globals, throwing hooks, absent DOM: each gets a case, because the
 * failure mode of getting this wrong is a broken target site rather than a
 * failed test.
 */

import { createContext, runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
	DRAIN_SOURCE,
	EGRESS_GLOBAL,
	INSTRUMENT_LIMITS,
	INSTRUMENT_SOURCE,
	UNINSTALL_SOURCE,
} from '../instrument.js';

/** A stand-in browser global carrying every primitive the instrument patches. */
function fakeGlobal(over: Record<string, unknown> = {}) {
	const noop = () => undefined;
	class FakeWS {
		url: string;
		listeners: Record<string, ((ev: unknown) => void)[]> = {};
		constructor(url: string, _proto?: string) {
			this.url = url;
		}
		send(_data: unknown) {}
		addEventListener(k: string, fn: (ev: unknown) => void) {
			this.listeners[k] ??= [];
			this.listeners[k].push(fn);
		}
		emit(k: string, ev: unknown) {
			for (const fn of this.listeners[k] ?? []) fn(ev);
		}
	}
	class FakeES extends FakeWS {}
	class FakeXHR {
		open(_m: string, _u: string) {}
		send(_b?: unknown) {}
	}
	class FakeRTC {
		createDataChannel(_label: string) {
			return {};
		}
	}
	class FakeBC {
		constructor(public name: string) {}
		postMessage(_m: unknown) {}
	}
	const proto = (setter: (v: string) => void) => {
		const o = { _src: '' };
		Object.defineProperty(o, 'src', {
			configurable: true,
			set(v: string) {
				setter(v);
				this._src = v;
			},
			get() {
				return this._src;
			},
		});
		return { prototype: o };
	};

	// The drain and uninstall channels are DOM events now, so the fake has to be a
	// real event target: a stub `document` would make every capture assertion fail
	// for a reason that has nothing to do with the patches.
	const listeners: Record<string, ((e: unknown) => void)[]> = {};
	const attrs: Record<string, string> = {};
	const document = {
		addEventListener: (k: string, fn: (e: unknown) => void) => {
			(listeners[k] ??= []).push(fn);
		},
		dispatchEvent: (e: { type: string }) => {
			for (const fn of listeners[e.type] ?? []) fn(e);
			return true;
		},
		documentElement: {
			setAttribute: (k: string, v: string) => {
				attrs[k] = v;
			},
			getAttribute: (k: string) => attrs[k] ?? null,
			removeAttribute: (k: string) => {
				delete attrs[k];
			},
			hasAttribute: (k: string) => k in attrs,
		},
	};
	class FakeCustomEvent {
		type: string;
		detail: unknown;
		constructor(type: string, init?: { detail?: unknown }) {
			this.type = type;
			this.detail = init?.detail;
		}
	}

	return {
		document,
		CustomEvent: FakeCustomEvent,
		// A vm context ships ECMAScript built-ins only, so the web platform types
		// the instrument branches on have to be supplied deliberately. Reusing the
		// host's keeps `instanceof` meaningful across the boundary.
		URLSearchParams,
		// The base64 path is the whole point of the binary handling, so the fake
		// global has to carry the encoder a browser would.
		btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
		FormData,
		Blob,
		ReadableStream,
		fetch: noop,
		XMLHttpRequest: FakeXHR,
		WebSocket: FakeWS,
		EventSource: FakeES,
		RTCPeerConnection: FakeRTC,
		WebTransport: class {
			constructor(public url: string) {}
		},
		Worker: class {
			constructor(public url: string) {}
		},
		SharedWorker: class {
			constructor(public url: string) {}
		},
		BroadcastChannel: FakeBC,
		importScripts: noop,
		postMessage: noop,
		navigator: { sendBeacon: noop, serviceWorker: { register: noop } },
		SourceBuffer: { prototype: { appendBuffer: noop } },
		HTMLScriptElement: proto(noop),
		HTMLImageElement: proto(noop),
		HTMLFormElement: { prototype: { submit: noop } },
		...over,
	};
}

/** Install the real instrument into a fresh context and return a driver. */
function install(over: Record<string, unknown> = {}) {
	const ctx = createContext(fakeGlobal(over));
	runInNewContext(INSTRUMENT_SOURCE, ctx);
	return {
		ctx: ctx as Record<string, unknown>,
		run: (src: string) => runInNewContext(src, ctx),
		drain: () => runInNewContext(DRAIN_SOURCE, ctx) as Array<Record<string, unknown>>,
		uninstall: () => runInNewContext(UNINSTALL_SOURCE, ctx) as boolean,
	};
}

describe('coverage — every primitive produces an event', () => {
	it.each([
		['fetch', `fetch('https://x.test/api', {method:'POST', body:'{"a":1}'})`, 'fetch', 'POST'],
		[
			'XMLHttpRequest',
			`const x=new XMLHttpRequest(); x.open('GET','/xhr'); x.send()`,
			'xhr',
			'GET',
		],
		['WebSocket', `new WebSocket('wss://x.test/ws')`, 'websocket', 'WS'],
		['EventSource', `new EventSource('https://x.test/sse')`, 'eventsource', 'GET'],
		['sendBeacon', `navigator.sendBeacon('/collect','d')`, 'beacon', 'POST'],
		['RTCPeerConnection', `new RTCPeerConnection()`, 'webrtc', 'OPEN'],
		['WebTransport', `new WebTransport('https://x.test/wt')`, 'webtransport', 'OPEN'],
		['Worker', `new Worker('/w.js')`, 'worker', 'OPEN'],
		['SharedWorker', `new SharedWorker('/sw.js')`, 'worker', 'OPEN'],
		['importScripts', `importScripts('/lib.js')`, 'importscripts', 'GET'],
		['serviceWorker', `navigator.serviceWorker.register('/sw.js')`, 'serviceworker', 'OPEN'],
		['postMessage', `postMessage({a:1},'https://x.test')`, 'postmessage', 'SUB'],
		[
			'MSE',
			`SourceBuffer.prototype.appendBuffer.call({}, new Uint8Array(4))`,
			'media-append',
			'DATA',
		],
	])('records %s', (_name, script, kind, method) => {
		const h = install();
		h.run(script);
		const events = h.drain();
		expect(events.map((e) => e.kind)).toContain(kind);
		expect(events.find((e) => e.kind === kind)?.method).toBe(method);
	});

	it('records both directions of a WebSocket frame', () => {
		const h = install();
		h.run(`
			const ws = new WebSocket('wss://x.test/ws');
			ws.send('hello');
			ws.emit('message', { data: 'world' });
		`);
		const frames = h.drain().filter((e) => e.kind === 'websocket-frame');
		expect(frames.map((f) => f.detail).sort()).toEqual(['received', 'sent']);
		expect(frames.find((f) => f.detail === 'sent')?.body).toBe('hello');
	});

	it('records SSE message payloads, not just the handshake', () => {
		const h = install();
		h.run(`const es = new EventSource('/stream'); es.emit('message', { data: 'tick' })`);
		expect(h.drain().filter((e) => e.kind === 'eventsource')).toHaveLength(2);
	});

	it('records a BroadcastChannel post', () => {
		const h = install();
		h.run(`new BroadcastChannel('updates').postMessage({x:1})`);
		expect(h.drain().find((e) => e.kind === 'broadcast')?.url).toBe('bc:updates');
	});

	it('records a data channel separately from the peer connection', () => {
		const h = install();
		h.run(`new RTCPeerConnection().createDataChannel('chat')`);
		const rtc = h.drain().filter((e) => e.kind === 'webrtc');
		expect(rtc.map((e) => e.detail)).toEqual(['peerconnection', 'datachannel']);
	});

	// JSONP is a real API call that wire capture files under "script", so it is
	// invisible unless something looks at the URL shape.
	it('records a JSONP script insertion but ignores an ordinary one', () => {
		const h = install();
		h.run(`
			Object.create(HTMLScriptElement.prototype).src = 'https://x.test/api?callback=cb1';
			Object.create(HTMLScriptElement.prototype).src = 'https://x.test/bundle.js';
		`);
		const jsonp = h.drain().filter((e) => e.kind === 'jsonp');
		expect(jsonp).toHaveLength(1);
		expect(jsonp[0].url).toContain('callback=cb1');
	});

	it('records a tracking pixel but ignores a plain image', () => {
		const h = install();
		h.run(`
			Object.create(HTMLImageElement.prototype).src = 'https://x.test/p.gif?uid=9';
			Object.create(HTMLImageElement.prototype).src = 'https://x.test/logo.png';
		`);
		expect(h.drain().filter((e) => e.kind === 'image-beacon')).toHaveLength(1);
	});
});

describe('it records what a reader needs to act', () => {
	it('captures the initiating stack frame, not its own', () => {
		const h = install();
		h.run(`function appCode(){ fetch('/api') } appCode()`);
		const initiator = h.drain()[0]?.initiator as string | undefined;
		expect(initiator).toBeTruthy();
		expect(initiator).not.toContain('instrumentSource');
	});

	it('clips an oversized body rather than carrying it whole', () => {
		const h = install();
		h.run(`fetch('/api', { method:'POST', body: 'x'.repeat(5000) })`);
		const body = h.drain()[0]?.body as string;
		expect(body.length).toBeLessThanOrEqual(INSTRUMENT_LIMITS.maxBodyChars + 1);
		expect(body.endsWith('…')).toBe(true);
	});

	// A typed array survives JSON.stringify as `{"0":0,"1":0,…}`, so a clip that
	// relies on a throw spends the whole preview budget on zeros and loses the
	// single fact worth keeping: the payload was binary.
	// Superseded: this used to require a binary body to be recorded as its size
	// and nothing else. Size alone proves a socket exists and is useless for
	// deciding what it carries — protobuf, msgpack and length-prefixed envelopes
	// all arrive this way, and `[binary 128b]` reads exactly like an empty stream.
	it('keeps a binary body decodable rather than reducing it to a size', () => {
		const h = install();
		h.run(`fetch('/upload', { method:'POST', body: new Uint8Array([1,2,3]) })`);
		const body = h.drain()[0]?.body as string;
		expect(body).toContain('[base64:3b]');
		expect(body).toContain('AQID');
	});

	it('bounds a large binary body instead of carrying it whole', () => {
		const h = install();
		h.run(`fetch('/upload', { method:'POST', body: new Uint8Array(9000) })`);
		const body = h.drain()[0]?.body as string;
		expect(body).toContain('[base64:9000b]');
		expect(body.length).toBeLessThan(INSTRUMENT_LIMITS.maxBodyChars * 2);
		expect(body.endsWith('…')).toBe(true);
	});

	// The case this exists for: a socket whose frames are protobuf.
	it('keeps a binary WebSocket frame decodable', () => {
		const h = install();
		h.run(`
			const ws = new WebSocket('wss://x.test/stream');
			ws.emit('message', { data: new Uint8Array([8, 150, 1]).buffer });
		`);
		const frame = h.drain().find((e) => e.kind === 'websocket-frame');
		expect(String(frame?.body)).toContain('[base64:3b]');
	});

	it('reads a form-encoded body out, because the encoded text is the request', () => {
		const h = install();
		h.run(`fetch('/vote', { method:'POST', body: new URLSearchParams({ id: '7', dir: 'up' }) })`);
		expect(h.drain()[0]?.body).toBe('id=7&dir=up');
	});

	// A hook invoked without its receiver still records an event, just a useless
	// one: default verb, empty URL. The transport reads present while its
	// evidence points nowhere, which is worse than no row at all.
	it('gives a prototype hook its receiver, so XHR carries its verb and URL', () => {
		const h = install();
		h.run(`const x = new XMLHttpRequest(); x.open('POST','/api/detail/42'); x.send('{}')`);
		expect(h.drain()[0]).toMatchObject({
			kind: 'xhr',
			method: 'POST',
			url: '/api/detail/42',
			body: '{}',
		});
	});

	it('reads a form element method and action off its receiver', () => {
		const h = install();
		h.run(`
			const f = Object.create(HTMLFormElement.prototype);
			f.method = 'post';
			f.action = '/vote';
			f.submit();
		`);
		expect(h.drain()[0]).toMatchObject({ kind: 'form-submit', method: 'POST', url: '/vote' });
	});

	it('reads the verb off a Request object, not only off init', () => {
		const h = install();
		h.run(`fetch({ url:'https://x.test/r', method:'DELETE' })`);
		expect(h.drain()[0]).toMatchObject({ method: 'DELETE', url: 'https://x.test/r' });
	});
});

describe('it never breaks the page it observes', () => {
	it('calls through to the original primitive', () => {
		let called = '';
		const h = install({
			fetch: (u: string) => {
				called = u;
				return 'ok';
			},
		});
		expect(h.run(`fetch('https://x.test/real')`)).toBe('ok');
		expect(called).toBe('https://x.test/real');
	});

	it('preserves constructed instances and their prototype chain', () => {
		const h = install();
		expect(h.run(`(() => { const w = new WebSocket('wss://x.test/a'); return w.url })()`)).toBe(
			'wss://x.test/a',
		);
		expect(h.run(`new WebSocket('wss://x.test/a') instanceof WebSocket`)).toBe(true);
	});

	it('survives a global that is missing entirely', () => {
		expect(() => install({ WebTransport: undefined, RTCPeerConnection: undefined })).not.toThrow();
	});

	// A worker scope has no DOM, so the event channel does not exist there and the
	// buffer cannot be read back the same way. Installing must still patch and
	// must still not throw — a worker that broke on install would take the page's
	// own work down with it.
	it('installs and patches in a worker scope with no DOM', () => {
		const h = install({ document: undefined, HTMLScriptElement: undefined });
		expect(() => h.run(`importScripts('/lib.js')`)).not.toThrow();
		expect(h.run(`String(importScripts).includes('hook.call')`)).toBe(false);
	});

	it('survives a frozen primitive without losing the rest', () => {
		const frozen = Object.freeze({ sendBeacon: () => true });
		const h = install({ navigator: frozen });
		h.run(`fetch('/still-works')`);
		expect(h.drain()[0]?.kind).toBe('fetch');
	});

	// A second install would otherwise wrap the wrappers, doubling every event.
	it('is idempotent across a re-install', () => {
		const h = install();
		h.run(INSTRUMENT_SOURCE);
		h.run(`fetch('/once')`);
		expect(h.drain()).toHaveLength(1);
	});
});

describe('bounds', () => {
	it('stops recording at the event cap instead of growing without limit', () => {
		const h = install();
		h.run(`for (let i = 0; i < ${INSTRUMENT_LIMITS.maxEvents + 500}; i++) fetch('/p/' + i)`);
		expect(h.drain().length).toBe(INSTRUMENT_LIMITS.maxEvents);
	});

	it('drains empty the second time, so events are never double-counted', () => {
		const h = install();
		h.run(`fetch('/a')`);
		expect(h.drain()).toHaveLength(1);
		expect(h.drain()).toHaveLength(0);
	});

	it('drains to empty rather than throwing when never installed', () => {
		const ctx = createContext({});
		expect(runInNewContext(DRAIN_SOURCE, ctx)).toEqual([]);
	});

	// Superseded on purpose. This used to require the buffer to be a property of
	// `window`, which is the loudest tell an instrumented page can carry —
	// `getOwnPropertyNames` finds it whatever the property flags say. The buffer
	// now lives in a closure reachable only through the DOM event channel, so the
	// requirement is the opposite one.
	it('publishes no global, so the page carries no unexplained property', () => {
		const h = install();
		h.run(`fetch('/a')`);
		expect(h.ctx[EGRESS_GLOBAL]).toBeUndefined();
		expect(h.drain()).toHaveLength(1);
	});
});

describe('it does not announce itself', () => {
	// A patched global is trivially detectable — `String(fetch)` reports source
	// where a native function reports `[native code]` — and bot-detection scripts
	// read exactly that. On a hardened target, instrumenting is then what gets the
	// session blocked: the observation changing the thing observed.
	//
	// A vm context has no native `fetch` to compare against, so what is asserted
	// here is the property that produces the native answer in a real engine: the
	// wrapper reports the *original's* source rather than its own. The live check
	// against genuine natives is `scripts/capture-bench.mjs`.
	const NAMED = 'function originalFetch() { /* pretend native */ }';

	it.each([
		['fetch', 'fetch'],
		['WebSocket', 'WebSocket'],
		['EventSource', 'EventSource'],
		['XHR open', 'XMLHttpRequest.prototype.open'],
	])('%s reports the original source, not the wrapper', (_name, expr) => {
		const h = install();
		const shown = h.run(`String(${expr})`) as string;
		// The wrapper's body is what must not surface. Its tell is the hook call
		// every patched function carries.
		expect(shown).not.toContain('hook.call');
		expect(shown).not.toContain('originals');
	});

	it('returns the replaced function source verbatim', () => {
		const h = install({ fetch: new Function(`return ${NAMED}`)() });
		expect(h.run(`String(fetch)`)).toBe(NAMED);
	});

	// A per-function override would leave an own property, which is its own tell.
	it('leaves no own toString on a wrapped function', () => {
		const h = install();
		expect(h.run(`Object.prototype.hasOwnProperty.call(fetch, 'toString')`)).toBe(false);
	});

	it('keeps toString working for ordinary page functions', () => {
		const h = install();
		expect(h.run(`String(function appFn(){ return 1 })`)).toContain('appFn');
	});

	it('reports the native source for the patched toString itself', () => {
		const h = install();
		expect(h.run(`String(Function.prototype.toString).includes('[native code]')`)).toBe(true);
	});
});

describe('the drain channel crosses worlds without injecting anything', () => {
	// The obvious bridge appends a <script>, which any `script-src` policy
	// refuses — and many real sites ship one, so that path reports an
	// instrumented page as a page that made no calls. DOM events cross the
	// boundary because the DOM is shared, and nothing is injected.
	it('registers a drain listener on the document', () => {
		const listeners: string[] = [];
		const h = install({
			document: {
				addEventListener: (k: string) => listeners.push(k),
				documentElement: { setAttribute: () => {} },
			},
		});
		expect(listeners).toContain(`${EGRESS_GLOBAL}_drain`);
		expect(h.drain).toBeDefined();
	});

	it('answers on the shared DOM when the drain event fires', () => {
		const h = install();
		h.run(`fetch('/api/x')`);
		// Drive the channel exactly as the reader does, from outside the closure.
		const out = h.drain();
		expect(out[0]).toMatchObject({ kind: 'fetch', url: '/api/x' });
	});

	it('restores every patch on the uninstall event, leaving no residue', () => {
		const h = install();
		expect(h.run(`String(fetch).includes('hook.call')`)).toBe(false);
		h.run(`fetch('/before')`);
		expect(h.uninstall()).toBe(true);
		// After restore the wrapper is gone, so a later call records nothing.
		h.run(`fetch('/after')`);
		expect(h.drain()).toHaveLength(0);
	});

	it('installs without a document, because a worker scope has none', () => {
		expect(() => install({ document: undefined })).not.toThrow();
	});
});

describe('the worker is recorded, not rewritten', () => {
	// Instrumenting worker scope was tried and reverted. Loading a blob that
	// installs this instrument and then pulls the real script in with
	// `importScripts` works — and breaks the worker, because a blob has no
	// meaningful base URL, so every relative request the worker makes resolves
	// against the blob and fails. The site's own worker stopped fetching. An aid
	// that breaks what it observes is not a trade this instrument may make.
	it('constructs the worker with the URL it was given', () => {
		const h = install();
		const built = h.run(`(() => { const w = new Worker('./worker.js'); return w.url })()`);
		expect(built).toBe('./worker.js');
	});

	it('does not substitute a blob for the worker script', () => {
		const h = install();
		h.run(`new Worker('/scripts/streamer.worker.js')`);
		const e = h.drain().find((x) => x.kind === 'worker');
		expect(e?.url).toBe('/scripts/streamer.worker.js');
		expect(String(e?.url)).not.toContain('blob:');
	});

	it('records a shared worker the same way', () => {
		const h = install();
		h.run(`new SharedWorker('/sw-shared.js')`);
		expect(h.drain().find((x) => x.kind === 'worker')?.detail).toBe('shared');
	});
});
