/**
 * hCaptcha-shape captcha site — generic, brand-agnostic teaching example.
 *
 * Mimics the public surface of an hCaptcha-style challenge → proof → token flow:
 *  - GET /                           — gated HTML with iframe-style widget + Send btn
 *  - GET /assets/widget.js           — in-page stub: render(), execute(), postMessage
 *  - POST /api/challenge/:sitekey    — returns a challenge envelope { l, n, req, passkey }
 *  - POST /api/check/:sitekey        — returns a P1_-prefixed JWT-shaped token
 *  - POST /api/submit                — accepts x-captcha-token header, validates shape
 *
 * Token shape: `P1_<b64url>.<b64url>.<b64url>` (3 dot-separated segments).
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

const SITEKEY = 'demo-sitekey-0000-0002';
const TOKEN_PREFIX = 'P1_';

function b64url(buf: Buffer): string {
	return buf.toString('base64url');
}

function mintToken(passkey: string): string {
	const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
	const payload = b64url(
		Buffer.from(
			JSON.stringify({
				exp: Math.floor(Date.now() / 1000) + 120,
				passkey,
				kr: 'demo-key',
			}),
		),
	);
	const sig = b64url(randomBytes(32));
	return `${TOKEN_PREFIX}${header}.${payload}.${sig}`;
}

function isWellFormedToken(t: unknown): t is string {
	if (typeof t !== 'string') return false;
	if (!t.startsWith(TOKEN_PREFIX)) return false;
	const parts = t.slice(TOKEN_PREFIX.length).split('.');
	return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function createHcaptchaSite(): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		c.header('Content-Type', 'text/html; charset=utf-8');
		return c.body(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Captcha-gated send</title>
</head>
<body>
  <h1>Captcha-gated send</h1>
  <div id="captcha-widget" data-captcha-widget data-sitekey="${SITEKEY}"></div>
  <button id="send-btn">Send</button>
  <pre id="status"></pre>
  <script src="/assets/widget.js"></script>
  <script>
    (function () {
      var widget = document.getElementById('captcha-widget');
      var status = document.getElementById('status');
      window.addEventListener('message', function (ev) {
        if (ev.data && ev.data.kind === 'captcha-token') {
          status.textContent = 'token via postMessage: ' + ev.data.token.slice(0, 16) + '...';
        }
      });
      document.getElementById('send-btn').addEventListener('click', async function () {
        status.textContent = 'requesting challenge...';
        var sitekey = widget.dataset.sitekey;
        var ch = await fetch('/api/challenge/' + sitekey, { method: 'POST' }).then(function (r) { return r.json(); });
        var token = await window.captchaWidget.execute(sitekey, ch);
        status.textContent = 'submitting token...';
        var res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-captcha-token': token },
          body: JSON.stringify({ message: 'hello' }),
        }).then(function (r) { return r.json(); });
        status.textContent = JSON.stringify(res);
      });
    })();
  </script>
</body>
</html>`);
	});

	app.get('/assets/widget.js', (c) => {
		c.header('Content-Type', 'application/javascript; charset=utf-8');
		return c.body(`(function () {
  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function rand(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b64url(b);
  }
  window.captchaWidget = {
    execute: async function (sitekey, challenge) {
      // Simulate proof-of-work: just echo the passkey back to /api/check.
      var res = await fetch('/api/check/' + sitekey, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proof: rand(16), passkey: challenge.passkey }),
      });
      var data = await res.json();
      window.postMessage({ kind: 'captcha-token', token: data.token }, '*');
      return data.token;
    },
  };
})();`);
	});

	app.post('/api/challenge/:sitekey', (c) => {
		return c.json({
			l: Math.floor(Math.random() * 1000),
			n: `demo-nonce-${b64url(randomBytes(8))}`,
			req: b64url(randomBytes(24)),
			passkey: b64url(randomBytes(48)),
		});
	});

	app.post('/api/check/:sitekey', async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { passkey?: string; proof?: string };
		if (!body.passkey || !body.proof) return c.json({ error: 'missing_fields' }, 400);
		return c.json({ token: mintToken(body.passkey) });
	});

	app.post('/api/submit', async (c) => {
		const token = c.req.header('x-captcha-token');
		if (!isWellFormedToken(token)) {
			return c.json({ ok: false, error: 'invalid_or_missing_captcha_token' }, 403);
		}
		const body = await c.req.json().catch(() => ({}));
		return c.json({ ok: true, verified: true, received: body });
	});

	app.get('/api/debug/mint', (c) =>
		c.json({ sitekey: SITEKEY, token: mintToken(b64url(randomBytes(48))) }),
	);

	return app;
}
