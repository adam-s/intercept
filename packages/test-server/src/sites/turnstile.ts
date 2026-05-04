/**
 * Turnstile-shape captcha site — generic, brand-agnostic teaching example.
 *
 * Mimics the public surface of a Turnstile-style invisible captcha:
 *  - GET /                    — gated HTML page with a widget container + form
 *  - GET /assets/widget.js    — stub that exposes window.captchaWidget.execute(sitekey)
 *  - POST /api/verify         — accepts { token }, validates shape, returns 200/400
 *
 * The token shape is `0.<base64url>` with a length floor — matches the real
 * Turnstile token prefix without any Cloudflare branding.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

const SITEKEY = 'demo-sitekey-0000-0001';
const TOKEN_PREFIX = '0.';

function mintToken(): string {
	return TOKEN_PREFIX + randomBytes(96).toString('base64url');
}

function isWellFormedToken(t: unknown): t is string {
	return typeof t === 'string' && t.startsWith(TOKEN_PREFIX) && t.length >= 64;
}

export function createTurnstileSite(): Hono {
	const app = new Hono();

	app.get('/', (c) => {
		c.header('Content-Type', 'text/html; charset=utf-8');
		return c.body(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Captcha-gated form</title>
</head>
<body>
  <h1>Captcha-gated form</h1>
  <p>Verify you're human, then submit.</p>
  <form id="gated-form" method="POST" action="/api/verify">
    <div id="captcha-widget" data-captcha-widget data-sitekey="${SITEKEY}"></div>
    <input type="hidden" name="token" id="captcha-token-input" value="">
    <button type="button" id="verify-btn">Verify</button>
    <button type="submit" id="submit-btn" disabled>Submit</button>
  </form>
  <pre id="status"></pre>
  <script src="/assets/widget.js"></script>
  <script>
    (function () {
      var widget = document.getElementById('captcha-widget');
      var input = document.getElementById('captcha-token-input');
      var status = document.getElementById('status');
      var submit = document.getElementById('submit-btn');
      var id = window.captchaWidget.render(widget, { sitekey: widget.dataset.sitekey });
      document.getElementById('verify-btn').addEventListener('click', function () {
        window.captchaWidget.execute(id).then(function (token) {
          input.value = token;
          submit.disabled = false;
          status.textContent = 'Token minted (length ' + token.length + ')';
        });
      });
    })();
  </script>
</body>
</html>`);
	});

	app.get('/assets/widget.js', (c) => {
		c.header('Content-Type', 'application/javascript; charset=utf-8');
		return c.body(`(function () {
  var widgets = {};
  var n = 0;
  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function mint() {
    var bytes = new Uint8Array(96);
    crypto.getRandomValues(bytes);
    return '${TOKEN_PREFIX}' + b64url(bytes);
  }
  window.captchaWidget = {
    render: function (el, opts) {
      var id = 'w' + (++n);
      widgets[id] = { el: el, sitekey: (opts && opts.sitekey) || '' };
      el.setAttribute('data-widget-id', id);
      return id;
    },
    execute: function (id) {
      if (!widgets[id]) return Promise.reject(new Error('unknown widget ' + id));
      return Promise.resolve(mint());
    },
  };
})();`);
	});

	app.post('/api/verify', async (c) => {
		const ct = c.req.header('content-type') ?? '';
		let token: unknown;
		if (ct.includes('application/json')) {
			const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
			token = body.token;
		} else {
			const form = await c.req.parseBody();
			token = form.token;
		}
		if (!isWellFormedToken(token)) {
			return c.json({ ok: false, error: 'invalid_token' }, 400);
		}
		return c.json({ ok: true, verified: true, echo: { tokenPrefix: token.slice(0, 2) } });
	});

	// Expose the sitekey + a server-minted token for tests that don't run a browser.
	app.get('/api/debug/mint', (c) => c.json({ sitekey: SITEKEY, token: mintToken() }));

	return app;
}
