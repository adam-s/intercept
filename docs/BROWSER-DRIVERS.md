# Browser drivers: Patchright and Camoufox

Both engines sit behind the driver seam in
[packages/browser/src/driver/](../packages/browser/src/driver/). This file
records why both exist and which to reach for. It is a decision record, so it
states costs as plainly as benefits.

## The one-line version

Patchright is Chromium with stealth patches and full CDP. Camoufox is Firefox
with its fingerprint set in C++, below the reach of any page script. Camoufox
wins on getting through bot protection; Patchright wins on everything that needs
CDP, and on capacity.

## Comparison

| Dimension | Patchright (Chromium) | Camoufox (Firefox) |
|---|---|---|
| **Fingerprint layer** | JavaScript overrides injected over CDP — real, but installed by script and therefore discoverable by script | C++, inside the engine. Nothing for page script to find |
| **WAF pass rate** | See the measurement below — tied on every target probed here | See below. The sibling-repo advantage did not reproduce on these targets |
| **True headless** | Supported and usable | Refused by the driver — it trips Cloudflare regardless of engine. Linux uses a virtual display; elsewhere runs headed |
| **Headless GPU leak** | Leaks SwiftShader in true headless, a standard detection signal | Not applicable, since true headless is not used |
| **CDP access** | Full | None. Firefox speaks Juggler, and Playwright exposes no CDP session for it |
| **Live browser view** | CDP `Page.startScreencast` — efficient, frames on visual change | No equivalent. Falls back to a `page.screenshot()` loop: works, costs more per frame, lower rate. **The one real feature loss** |
| **`page.evaluate` world** | Isolated — page globals are invisible and reads return `undefined` with nothing thrown | The page's own world. Page globals read directly |
| **Traffic capture** | Works. Was CDP `Network.*`, now the shared protocol-agnostic path | Same shared path, same results |
| **Persona OS pinning** | Not available | Available, and load-bearing for any persistent profile |
| **Memory per browser** | ~300–400 MB | ~1.4 GB. Pool capacity drops accordingly |
| **Binary size** | Chromium, already a dependency | ~611 MB, fetched separately |
| **Version coupling** | Patchright pins its own Chromium | camoufox ↔ playwright-core must match per build; a mismatch crashes rather than reporting a version error |
| **Language maturity here** | Proven in this repo | `camoufox-js` wraps `playwright-core`; the Python path is the one with mileage in these repos |

## The measurement (2026-07-28)

Run it yourself: `npx tsx scripts/waf-probe.mjs`. macOS host, Apple M3 Pro.

| Signal | Patchright | Camoufox |
|---|---|---|
| Automation tells | **0** | **0** |
| `navigator.webdriver` | false | false |
| Reported UA | Chrome 145 / macOS | Firefox 152 / **Windows** |
| Reported WebGL | Apple M3 Pro (the real host) | **NVIDIA GTX 980** |
| Cloudflare managed challenge (`nowsecure.nl`) | passed | passed |
| DataDome's own origin | passed | passed |
| Kasada's own origin | passed | passed |
| Turnstile demo | token issued | token issued |

**They tie.** The sibling-repo finding that Camoufox beats Chromium did not
reproduce on any target that can be probed here, and the honest reading is that
these targets are not hard enough to separate them — not that the difference is
imaginary. A tie on easy targets is weak evidence either way.

Two things the run did establish:

- **Patchright had one real tell, now fixed.** Headless Chromium advertised
  `HeadlessChrome/145.0.0.0` in its user agent — the single most trivially
  readable automation signal there is, and it was on by default. The driver now
  strips it. That fix moved Patchright from 1 tell to 0, and it is why the two
  tie today.
- **Camoufox's persona is genuinely a different machine.** It reported Windows
  and an NVIDIA GTX 980 from a macOS Apple-silicon host, and page script has no
  way to see through it because the values come from the engine, not a script
  override. That is a capability Patchright structurally cannot match, and it is
  the reason to keep the driver even while the two tie on easy targets.

The Turnstile line proves the integration works end to end and nothing more: the
demo's sitekey is Cloudflare's documented always-passes test key, and the token
issued reads `XXXX.DUMMY.TOKEN.XXXX`.

## The version pin

`playwright-core` is pinned **exactly**, not ranged, in
`packages/browser/package.json`. A camoufox build matches one playwright-core
line, and a mismatch surfaces as a Juggler protocol error at launch rather than
a version error — so a caret range floats onto a broken combination silently.

Verified 2026-07-28 on camoufox v152.0.4-beta.28:

| playwright-core | Result |
|---|---|
| 1.62.0 | Fails at launch: `Found property "<root>.viewport.isMobile" ... not described in this scheme` |
| 1.53.1 | Works — the pinned version |

`driver.test.ts` pins this: it fails if the declared version stops being an
exact pin, or if the installed version drifts from it. Re-probe the pair after
any camoufox upgrade and update both the pin and the table above.

Installing the engine is a separate, large download and is deliberately not part
of a default install:

```bash
pnpm --filter @interceptor/browser exec camoufox-js fetch
```

The driver reports its absence cleanly rather than failing at launch.

## Which to use

**Patchright is the default**, and the measurement above is why: it ties
Camoufox on every target probed, keeps CDP (the live browser view and raw input
injection), runs true headless, and costs roughly a quarter of the memory. On
current evidence there is no reason to pay Camoufox's costs by default.

**Reach for Camoufox when a target actually challenges you** — and specifically
when it fingerprints Chromium. Its persona is a different operating system and a
different GPU, set in the engine where page script cannot see through it, so it
is the escape hatch when the Chromium path has been identified. It is also the
one to reach for when a persistent, OS-pinned profile is worth maintaining
against a Cloudflare-gated origin.

**Revisit this if the target mix changes.** The tie was measured on targets that
are not hard. If a real target starts failing under Patchright, re-run
`scripts/waf-probe.mjs`, add that target, and let the evidence decide rather
than the reputation.

## Two settings that decide whether Camoufox works

Both are cheap to get wrong and expensive to diagnose.

1. **Never true headless.** It trips Cloudflare on any engine. The driver
   refuses it rather than running in a mode that reliably fails — a refusal is
   debuggable, an unexplained challenge is not.

2. **Pin the persona OS on any persistent profile.** A clearance cookie is bound
   to the user agent that earned it. Camoufox randomizes persona OS per launch,
   so an unpinned persistent profile silently invalidates its own cookie and
   re-challenges every run. Pinned, the challenge stops firing at all — which
   beats solving it. The driver defaults the pin on whenever a profile directory
   is given.

**Ephemeral versus persistent is a per-target choice, not a global default.** A
Cloudflare-gated origin needs the persistent profile so its clearance survives.
A flagged DataDome session needs the opposite: a fresh persona *is* the
recovery. Same knob, opposite settings, which is why it belongs in a domain's
config rather than in a framework default.

## What the move retires

`remote/fingerprint-controller.ts` spoofs fingerprints from JavaScript over CDP.
Under Camoufox it is not ported — it is deleted and replaced by launch config,
because an engine-level fingerprint is strictly stronger than a script-installed
one. Any work invested in the CDP spoofing path is work Camoufox makes
unnecessary.

`remote/cdp-script-control.ts` splits: its `addInitScript` path is ordinary
Playwright and ports unchanged; its raw-CDP script-body capture does not, and
`page.route()` covers most of what that was for.

## Why both are kept

Introducing the Firefox path and retiring Chromium in the same change would mean
a capture failure has two possible causes and no way to tell which. Patchright
stays until the Firefox path has proved out on real targets.
