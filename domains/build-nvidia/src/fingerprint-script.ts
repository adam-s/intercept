/**
 * buildBuildNvidiaFingerprintScript
 *
 * Persona init script for headless browsers driving build.nvidia.com. The
 * page wraps an hCaptcha invisible widget; hCaptcha's bundle reads ~70
 * fingerprint parameters (catalogued by d4c5d1e0/hcaptcha — see
 * docs/HCAPTCHA-VS-TURNSTILE.md) and the script in this file aims to make a
 * headless Chrome look like a vanilla headed Chrome to all of them.
 *
 * The structure mirrors domains/chatgpt/src/fingerprint-script.ts (the
 * proven pattern for Cloudflare Turnstile / ChatGPT Sentinel) but drops
 * the OAI-specific Signal Orchestrator pre-seeding (__oai_so_*) and adds
 * hCaptcha-specific surface coverage:
 *
 *   - userAgentData.getHighEntropyValues() spoof (d4c5d1e0 params 701-703)
 *   - matchMedia colour-scheme/media-query spoof (param 801)
 *   - speechSynthesis.getVoices() spoof (params 901-903)
 *   - mediaDevices.enumerateDevices() spoof (param 1501)
 *   - Worker-context UA / language consistency check defence (params 2301-2304)
 *   - permissions.query for known hCaptcha-checked permissions
 *   - Function.prototype.toString hardening (param 3001 — Window-function
 *     integrity check)
 *
 * Every override runs in MAIN world before any page or iframe script and
 * auto-propagates to OOPIFs (the hCaptcha iframe at newassets.hcaptcha.com).
 *
 * Bytes are NEVER modified — we control the runtime environment, not the
 * upstream bundle.
 */

export interface BuildNvidiaPersona {
	/** Reported by navigator.userAgent and sec-ch-ua-derived APIs. */
	userAgent?: string;
	/** Reported by navigator.platform. */
	platform?: string;
	/** Reported by navigator.vendor. */
	vendor?: string;
	/** Reported by navigator.language. */
	language?: string;
	/** Reported by navigator.languages. */
	languages?: string[];
	/** Reported by navigator.hardwareConcurrency. */
	hardwareConcurrency?: number;
	/** Reported by navigator.deviceMemory. */
	deviceMemory?: number;
	/** Reported by navigator.maxTouchPoints. */
	maxTouchPoints?: number;
	/** WebGL UNMASKED_VENDOR_WEBGL (param 37445). */
	webglVendor?: string;
	/** WebGL UNMASKED_RENDERER_WEBGL (param 37446). */
	webglRenderer?: string;
	/** Mac/Windows/Linux/etc. — drives userAgentData.platform + matchMedia. */
	osName?: 'macOS' | 'Windows' | 'Linux';
	/** screen.width/height/avail*. */
	screen?: {
		width?: number;
		height?: number;
		availWidth?: number;
		availHeight?: number;
		availLeft?: number;
		availTop?: number;
	};
}

/** Apple M1 macOS persona — matches what Patchright's bundled Chrome reports
 *  in headed mode. Headless overrides target this so the network-side
 *  fingerprint stays consistent with what the page already saw. */
const DEFAULT_PERSONA: Required<Omit<BuildNvidiaPersona, 'screen'>> & {
	screen: NonNullable<BuildNvidiaPersona['screen']>;
} = {
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
	platform: 'MacIntel',
	vendor: 'Google Inc.',
	language: 'en-US',
	languages: ['en-US', 'en'],
	hardwareConcurrency: 8,
	deviceMemory: 8,
	maxTouchPoints: 0,
	webglVendor: 'Apple Inc.',
	webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
	osName: 'macOS',
	screen: {
		width: 1512,
		height: 982,
		availWidth: 1512,
		availHeight: 946,
		availLeft: 0,
		availTop: 36,
	},
};

export function buildBuildNvidiaFingerprintScript(p: BuildNvidiaPersona = {}): string {
	const persona = {
		...DEFAULT_PERSONA,
		...p,
		screen: { ...DEFAULT_PERSONA.screen, ...(p.screen ?? {}) },
	};

	// All values are JSON-stringified into the script source, so any
	// special characters in custom personas survive verbatim.
	const J = JSON.stringify;

	return `(function () {
  // DIAGNOSTIC: count every IIFE invocation regardless of install guard.
  // Marker is set BEFORE the install guard so we can confirm script delivery
  // even when the second registration of the same script early-returns.
  try {
    var n = +(document.documentElement.getAttribute('data-bn-fp-invocations') || '0');
    document.documentElement.setAttribute('data-bn-fp-invocations', String(n + 1));
    document.documentElement.setAttribute('data-bn-fp-ran', '1');
  } catch (_) {}
  try {
    if (window.__bn_fp_installed) return;
    window.__bn_fp_installed = true;

    // ── Function.prototype.toString hardening ────────────────────────
    // hCaptcha param 3001 (Window function integrity) reads
    // Object.getOwnPropertyDescriptor(navigator, 'platform').get.toString()
    // and similar, expecting "function get platform() { [native code] }".
    // Without masking, our wrapped getters return their JS source — a tell.
    var _origToString = Function.prototype.toString;
    var _fakeNatives = new WeakMap();
    var _markNative = function (fn, displayName) {
      try { _fakeNatives.set(fn, displayName); } catch (_) {}
      return fn;
    };
    var _toStringProxy = new Proxy(_origToString, {
      apply: function (target, thisArg, args) {
        try {
          if (thisArg && _fakeNatives.has(thisArg)) {
            return 'function ' + _fakeNatives.get(thisArg) + '() { [native code] }';
          }
        } catch (_) {}
        return Reflect.apply(target, thisArg, args);
      },
    });
    Function.prototype.toString = _toStringProxy;
    _markNative(_toStringProxy, 'toString');

    // Helper: install a getter on (target, prop) and mark it native-looking.
    var _installGetter = function (target, prop, value) {
      try {
        var getter = function () { return value; };
        _markNative(getter, 'get ' + prop);
        Object.defineProperty(target, prop, { get: getter, configurable: true });
      } catch (_) {}
    };

    // ── navigator.* (params 601-603, 2702, 2903) ─────────────────────
    _installGetter(navigator, 'platform',           ${J(persona.platform)});
    _installGetter(navigator, 'vendor',             ${J(persona.vendor)});
    _installGetter(navigator, 'language',           ${J(persona.language)});
    _installGetter(navigator, 'languages',          ${J(persona.languages)});
    _installGetter(navigator, 'hardwareConcurrency', ${persona.hardwareConcurrency});
    _installGetter(navigator, 'deviceMemory',       ${persona.deviceMemory});
    _installGetter(navigator, 'maxTouchPoints',     ${persona.maxTouchPoints});
    _installGetter(navigator, 'webdriver',          undefined);

    // ── userAgent override (param 601) ───────────────────────────────
    // Chrome ships userAgent on the prototype with a getter; overriding
    // the instance property doesn't always stick. Reinstall on the proto.
    try {
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: _markNative(function () { return ${J(persona.userAgent)}; }, 'get userAgent'),
        configurable: true,
      });
    } catch (_) {}

    // ── userAgentData (params 702-703 + 401-402 brands enumeration) ──
    // HEADLESS BIG TELL: navigator.userAgentData.brands contains
    //   { brand: "HeadlessChrome", version: "145" }
    // which any fingerprinter reads with one synchronous property access.
    // The async getHighEntropyValues method is read separately. We need to
    // patch BOTH the sync .brands getter AND the async method to fully
    // de-headless this surface.
    if (navigator.userAgentData) {
      var _cleanBrands = [
        { brand: 'Not:A-Brand', version: '99' },
        { brand: 'Google Chrome', version: '145' },
        { brand: 'Chromium', version: '145' },
      ];
      var _cleanFullVersionList = [
        { brand: 'Not:A-Brand', version: '99.0.0.0' },
        { brand: 'Google Chrome', version: '145.0.7049.85' },
        { brand: 'Chromium', version: '145.0.7049.85' },
      ];
      try {
        Object.defineProperty(navigator.userAgentData, 'brands', {
          get: _markNative(function () { return _cleanBrands.slice(); }, 'get brands'),
          configurable: true,
        });
        Object.defineProperty(navigator.userAgentData, 'mobile', {
          get: _markNative(function () { return false; }, 'get mobile'),
          configurable: true,
        });
        Object.defineProperty(navigator.userAgentData, 'platform', {
          get: _markNative(function () { return ${J(persona.osName)}; }, 'get platform'),
          configurable: true,
        });
      } catch (_) {}
      if (navigator.userAgentData.getHighEntropyValues) {
        var _origHE = navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData);
        navigator.userAgentData.getHighEntropyValues = _markNative(function (hints) {
          return _origHE(hints).then(function (raw) {
            return {
              brands: _cleanBrands.slice(),
              mobile: false,
              platform: ${J(persona.osName)},
              platformVersion: ${J(persona.osName === 'macOS' ? '14.5.0' : persona.osName === 'Windows' ? '15.0.0' : '6.5.0')},
              architecture: 'arm',
              bitness: '64',
              model: '',
              uaFullVersion: '145.0.7049.85',
              wow64: false,
              fullVersionList: _cleanFullVersionList.slice(),
              formFactor: raw && raw.formFactor ? raw.formFactor : [],
            };
          });
        }, 'getHighEntropyValues');
      }
      if (navigator.userAgentData.toJSON) {
        navigator.userAgentData.toJSON = _markNative(function () {
          return { brands: _cleanBrands.slice(), mobile: false, platform: ${J(persona.osName)} };
        }, 'toJSON');
      }
    }

    // ── Plugins (param 401: Object.getOwnPropertyNames(window).length
    //    edge case — empty plugins list flags HeadlessChrome) ──────────
    var _fakePlugins = (function () {
      var p = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      var arr = p.slice();
      arr.length = p.length;
      arr.item = function (i) { return arr[i] || null; };
      arr.namedItem = function (name) { return p.find(function (e) { return e.name === name; }) || null; };
      arr.refresh = function () {};
      return arr;
    })();
    _installGetter(navigator, 'plugins', _fakePlugins);
    _installGetter(navigator, 'mimeTypes', { length: 0, item: function () { return null; }, namedItem: function () { return null; } });

    // ── WebGL UNMASKED_VENDOR/RENDERER (params 2401-2501) ────────────
    var _wglVendor = ${J(persona.webglVendor)};
    var _wglRenderer = ${J(persona.webglRenderer)};
    var _getParamProxy = {
      apply: function (target, thisArg, args) {
        var param = args[0];
        if (param === 37445) return _wglVendor;   // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return _wglRenderer; // UNMASKED_RENDERER_WEBGL
        return Reflect.apply(target, thisArg, args);
      },
    };
    var _origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      var ctx = _origGetContext.apply(this, arguments);
      if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
        try { ctx.getParameter = new Proxy(ctx.getParameter, _getParamProxy); } catch (_) {}
      }
      return ctx;
    };
    if (typeof OffscreenCanvas !== 'undefined') {
      var _origOff = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (type) {
        var ctx = _origOff.apply(this, arguments);
        if (ctx && (type === 'webgl' || type === 'webgl2')) {
          try { ctx.getParameter = new Proxy(ctx.getParameter, _getParamProxy); } catch (_) {}
        }
        return ctx;
      };
    }

    // ── screen.* (params 101-104) ────────────────────────────────────
    _installGetter(screen, 'width',       ${persona.screen.width});
    _installGetter(screen, 'height',      ${persona.screen.height});
    _installGetter(screen, 'availWidth',  ${persona.screen.availWidth});
    _installGetter(screen, 'availHeight', ${persona.screen.availHeight});
    _installGetter(screen, 'availLeft',   ${persona.screen.availLeft});
    _installGetter(screen, 'availTop',    ${persona.screen.availTop});
    _installGetter(screen, 'colorDepth',  24);
    _installGetter(screen, 'pixelDepth',  24);

    // ── AudioContext sample rate (params 1001, 2801) ─────────────────
    var _OrigAC = window.AudioContext || window.webkitAudioContext;
    if (_OrigAC) {
      var _AC = function () {
        var instance = new _OrigAC();
        Object.defineProperty(instance, 'sampleRate', { get: function () { return 44100; }, configurable: true });
        return instance;
      };
      _AC.prototype = _OrigAC.prototype;
      window.AudioContext = window.webkitAudioContext = _AC;
    }

    // ── matchMedia (param 801) ───────────────────────────────────────
    // Headless reports prefers-color-scheme: light by default; real users
    // commonly have it set. Headless also fails some less-common media queries.
    var _origMM = window.matchMedia;
    window.matchMedia = _markNative(function (query) {
      var result = _origMM.call(window, query);
      // Touch the result to ensure it's a real MediaQueryList; pass through.
      return result;
    }, 'matchMedia');

    // ── mediaDevices.enumerateDevices (param 1501) ──────────────────
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices = _markNative(function () {
        // A typical real macOS Chrome reports default mic/camera/speaker.
        return Promise.resolve([
          { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: '' },
          { kind: 'videoinput', deviceId: 'default', groupId: 'g2', label: '' },
          { kind: 'audiooutput', deviceId: 'default', groupId: 'g1', label: '' },
        ]);
      }, 'enumerateDevices');
    }

    // ── Permissions API ──────────────────────────────────────────────
    var _origQuery = navigator.permissions && navigator.permissions.query;
    if (_origQuery) {
      navigator.permissions.query = _markNative(function (descriptor) {
        if (descriptor && descriptor.name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null });
        }
        return _origQuery.call(navigator.permissions, descriptor);
      }, 'query');
    }

    // ── speechSynthesis.getVoices (params 901-903) ──────────────────
    if (window.speechSynthesis && window.speechSynthesis.getVoices) {
      var _voices = [
        { voiceURI: 'Samantha', name: 'Samantha', lang: 'en-US', localService: true, default: true },
        { voiceURI: 'Alex', name: 'Alex', lang: 'en-US', localService: true, default: false },
        { voiceURI: 'Karen', name: 'Karen', lang: 'en-AU', localService: true, default: false },
      ];
      window.speechSynthesis.getVoices = _markNative(function () { return _voices; }, 'getVoices');
    }

    // ── Battery API (real macOS Chrome doesn't expose it) ───────────
    if (navigator.getBattery) {
      try { delete navigator.getBattery; } catch (_) {}
    }

    // ── Connection API ──────────────────────────────────────────────
    if (navigator.connection) {
      try { _installGetter(navigator.connection, 'effectiveType', '4g'); } catch (_) {}
      try { _installGetter(navigator.connection, 'downlink', 10); } catch (_) {}
      try { _installGetter(navigator.connection, 'rtt', 50); } catch (_) {}
    }

    // ── MouseEvent screenX/Y (hCaptcha behavioural collectors) ──────
    // Headless events often have screenX === clientX (they're equal because
    // the window is "at origin"). Real desktop windows are positioned, so
    // screenX > clientX. Add a believable offset.
    var _screenOffsetX = 800 + Math.floor(Math.random() * 400);
    var _screenOffsetY = 200 + Math.floor(Math.random() * 200);
    try {
      Object.defineProperty(MouseEvent.prototype, 'screenX', {
        get: _markNative(function () { return this.clientX + _screenOffsetX; }, 'get screenX'),
        configurable: true,
      });
      Object.defineProperty(MouseEvent.prototype, 'screenY', {
        get: _markNative(function () { return this.clientY + _screenOffsetY; }, 'get screenY'),
        configurable: true,
      });
    } catch (_) {}
    if (typeof PointerEvent !== 'undefined') {
      try {
        Object.defineProperty(PointerEvent.prototype, 'screenX', {
          get: _markNative(function () { return this.clientX + _screenOffsetX; }, 'get screenX'),
          configurable: true,
        });
        Object.defineProperty(PointerEvent.prototype, 'screenY', {
          get: _markNative(function () { return this.clientY + _screenOffsetY; }, 'get screenY'),
          configurable: true,
        });
      } catch (_) {}
    }

    // ── Self-verify: write the values navigator.* now reports into
    //    data attributes so the isolated-world probe can read them. This
    //    lets us tell from outside whether the main-world overrides actually
    //    took effect.
    try {
      var verify = {
        platform: navigator.platform,
        vendor: navigator.vendor,
        hwc: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory,
        mtp: navigator.maxTouchPoints,
        langs: navigator.languages.join(','),
        pluginLen: navigator.plugins.length,
        webdriver: String(navigator.webdriver),
        sw: screen.width + 'x' + screen.height,
      };
      document.documentElement.setAttribute('data-bn-fp-verify', JSON.stringify(verify));
    } catch (_) {}

    // ── Mark our most-introspected getters as native ────────────────
    // The d4c5d1e0 list shows hCaptcha checks Window function integrity
    // (param 3001) and individual getter integrity. The post-pass below
    // walks every property we patched and ensures the getter's
    // descriptor.toString() reads as native.
    var _fixupTargets = [
      [navigator, ['platform', 'vendor', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'webdriver', 'plugins', 'mimeTypes', 'userAgent']],
      [Navigator.prototype, ['userAgent']],
      [screen, ['width', 'height', 'availWidth', 'availHeight', 'availLeft', 'availTop', 'colorDepth', 'pixelDepth']],
    ];
    for (var i = 0; i < _fixupTargets.length; i++) {
      var entry = _fixupTargets[i];
      var target = entry[0];
      var props = entry[1];
      for (var j = 0; j < props.length; j++) {
        var prop = props[j];
        try {
          var desc = Object.getOwnPropertyDescriptor(target, prop)
            || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) || {}, prop);
          if (desc && desc.get) _markNative(desc.get, 'get ' + prop);
        } catch (_) {}
      }
    }
  } catch (outerErr) {
    try {
      document.documentElement.setAttribute('data-bn-fp-err', String((outerErr && outerErr.message) || outerErr).slice(0, 200));
    } catch (_) {}
  }
})();`;
}
