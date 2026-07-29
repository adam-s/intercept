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

	return {
		// A vm context ships ECMAScript built-ins only, so the web platform types
		// the instrument branches on have to be supplied deliberately. Reusing the
		// host's keeps `instanceof` meaningful across the boundary.
		URLSearchParams,
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
		document: {},
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
	it('labels a binary body by size instead of expanding it', () => {
		const h = install();
		h.run(`fetch('/upload', { method:'POST', body: new Uint8Array(8) })`);
		const e = h.drain()[0];
		expect(e.kind).toBe('fetch');
		expect(e.body).toBe('[binary 8b]');
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

	it('survives a worker scope with no DOM', () => {
		const h = install({ document: undefined, HTMLScriptElement: undefined });
		h.run(`importScripts('/lib.js')`);
		expect(h.drain()[0]?.kind).toBe('importscripts');
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

	it('publishes the buffer under the name the drain side reads', () => {
		const h = install();
		expect(h.ctx[EGRESS_GLOBAL]).toBeDefined();
	});
});
