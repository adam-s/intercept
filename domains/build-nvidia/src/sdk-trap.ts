/**
 * E6 — capture the hCaptcha SDK reference before react-hcaptcha (or
 * anyone else) hides it.
 *
 * The hCaptcha loader at `https://js.hcaptcha.com/1/api.js` does
 *
 *   window.hcaptcha = { render, execute, getResponse, getRespKey, reset, … }
 *
 * Then `@hcaptcha/react-hcaptcha` does
 *
 *   this._hcaptcha = e.window.hcaptcha;
 *   // … and may delete or shadow it later
 *
 * After the page settles, an isolated-world `page.evaluate('window.hcaptcha')`
 * returns `undefined`, both because (a) react-hcaptcha can clear the global
 * and (b) `page.evaluate` runs in an isolated world that does not share
 * globals with the main world the SDK touched.
 *
 * The trap below installs as a MAIN-WORLD init script (so it lands BEFORE
 * any page script). It re-defines `window.hcaptcha` as an accessor: every
 * write goes through our setter and is mirrored to a hidden cache that
 * survives later `delete window.hcaptcha`. The original behaviour is
 * preserved (subsequent reads see the most-recently-set value).
 *
 * Once the SDK has been captured, `window.__bn_mintToken(siteKey)` returns
 * a Promise resolving to a fresh `P1_…` token by calling
 * `hcaptcha.execute(siteKey, { async: true })` on the captured ref.
 *
 * NOTE: Init scripts run in main world but Patchright's `page.evaluate`
 * runs in isolated world — the trap, the cache, and `__bn_mintToken` are
 * INVISIBLE from `page.evaluate`. Use `CdpScriptControl.evaluateInMainWorld`
 * (raw CDP `Runtime.evaluate`) to call the mint helper from Node.
 */

const TRAP_GUARD = '__bn_sdkTrapInstalled';
const SDK_CACHE = '__bn_hcaptcha';
const MINT_NAME = '__bn_mintToken';

export const SDK_TRAP_GLOBALS = {
	cache: SDK_CACHE,
	mint: MINT_NAME,
} as const;

/**
 * Returns the trap script source. Idempotent — re-execution in an already-
 * trapped realm short-circuits via `__bn_sdkTrapInstalled`.
 */
export function buildSdkTrapScript(): string {
	return `(() => {
  if (window.${TRAP_GUARD}) return;
  Object.defineProperty(window, '${TRAP_GUARD}', { value: true, configurable: false });

  // Hidden cache — survives any later \`delete window.hcaptcha\` because
  // it lives under a different property name.
  let _captured;
  Object.defineProperty(window, '${SDK_CACHE}', {
    configurable: false,
    enumerable: false,
    get() { return _captured; },
  });

  // Install accessor on \`hcaptcha\`. The SDK does \`window.hcaptcha = X\`;
  // our setter records X into _captured. Reads still return the most-
  // recent value, so the SDK + react-hcaptcha continue to see the API
  // they expect.
  //
  // If something later does \`delete window.hcaptcha\` the accessor is
  // removed; subsequent regular assignments create a normal data property
  // (we no longer trap them). That's fine — by the time delete fires,
  // _captured already holds the full SDK ref.
  let _value;
  try {
    Object.defineProperty(window, 'hcaptcha', {
      configurable: true,
      enumerable: true,
      get() { return _value; },
      set(v) {
        _value = v;
        // Stash the most "complete" SDK we've seen — the loader sets a
        // stub first, then a fully-formed object once the iframe signals
        // ready. We prefer whichever has \`execute\`.
        if (v && typeof v.execute === 'function') {
          _captured = v;
        } else if (!_captured && v) {
          _captured = v;
        }
      },
    });
  } catch (e) {
    // Some realms freeze window early; fall back to passive sniffing.
    setTimeout(function poll() {
      if (window.hcaptcha && typeof window.hcaptcha.execute === 'function') {
        _captured = window.hcaptcha;
        return;
      }
      setTimeout(poll, 50);
    }, 50);
  }

  // Public mint helper, callable via CDP Runtime.evaluate from Node.
  // Returns a Promise that resolves to the token string, or rejects.
  Object.defineProperty(window, '${MINT_NAME}', {
    configurable: false,
    enumerable: false,
    value: function mintToken(captchaIdOrSiteKey, opts) {
      const sdk = _captured || window.hcaptcha;
      if (!sdk || typeof sdk.execute !== 'function') {
        return Promise.reject(new Error('hCaptcha SDK not captured yet (no execute)'));
      }
      // hCaptcha SDK's execute(t, opts) requires the WIDGET ID (returned by
      // render()), not the sitekey. NVIDIA's page already renders an
      // invisible widget — its iframe carries data-hcaptcha-widget-id. If
      // the caller didn't pass one, auto-discover from the DOM.
      let id = captchaIdOrSiteKey;
      if (!id || /^[0-9a-f-]{36}$/i.test(String(id))) {
        // Sitekey-shaped argument (UUID) is wrong shape for execute(); try
        // to find the widget id ourselves.
        const widgetEl = document.querySelector('[data-hcaptcha-widget-id]');
        const wid = widgetEl ? widgetEl.getAttribute('data-hcaptcha-widget-id') : null;
        if (!wid) {
          return Promise.reject(new Error('No widget rendered (no [data-hcaptcha-widget-id] in DOM)'));
        }
        id = wid;
      }
      const o = Object.assign({ async: true }, opts || {});
      try {
        const r = sdk.execute(id, o);
        return Promise.resolve(r).then((v) => {
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object' && typeof v.response === 'string') return v.response;
          throw new Error('execute() returned no token: ' + (typeof v));
        });
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });

  // Diagnostic helper — read-only snapshot of the captured SDK shape.
  Object.defineProperty(window, '__bn_sdkInfo', {
    configurable: false,
    enumerable: false,
    value: function () {
      const sdk = _captured;
      if (!sdk) return { captured: false };
      const keys = Object.keys(sdk);
      const fns = {};
      for (const k of keys) {
        const v = sdk[k];
        fns[k] = typeof v;
      }
      return {
        captured: true,
        keys,
        fns,
        hasExecute: typeof sdk.execute === 'function',
        hasRender: typeof sdk.render === 'function',
        hasGetResponse: typeof sdk.getResponse === 'function',
      };
    },
  });
})();`;
}
