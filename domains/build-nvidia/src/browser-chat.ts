/**
 * Browser-driven chat for build.nvidia.com — no API key required.
 *
 * The playground at https://build.nvidia.com/<vendor>/<model> POSTs to
 * `api.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/<bareModel>` with a
 * single-use `nv-captcha-token` (P1_-prefixed hCaptcha) header. The
 * hCaptcha SDK lives entirely inside a sandboxed iframe at
 * `newassets.hcaptcha.com`; `window.hcaptcha` is undefined on the parent
 * page. The only entity that can mint a fresh token is the React Send
 * handler. So we drive the UI: fill the textarea, click Send, and harvest
 * the SSE response via `page.waitForResponse`.
 *
 * Single-flight per page: the UI itself disables Send between turns, and
 * two concurrent submits would race the textarea + captcha widget. We
 * mirror that with a per-page promise mutex.
 *
 * Buffered (not chunk-streamed): Patchright's `response.body()` waits
 * for the upstream to close the SSE stream. The harness consumes a full
 * SSE block at once. True chunk streaming would need CDP
 * `Fetch.requestPaused` interception — out of scope here.
 */

import type { RemoteBrowserService } from '@interceptor/browser/remote';
import type { Page } from 'patchright';

const BUILD_BASE = 'https://build.nvidia.com';
const NGC_HOST = 'api.ngc.nvidia.com';
const NGC_PREDICT_PREFIX = '/v2/predict/models/qc69jvmznzxy/';

const tails = new WeakMap<object, Promise<unknown>>();

export interface BrowserChatOptions {
	/** Vendor-prefixed slug, e.g., "openai/gpt-oss-20b". */
	model: string;
	/** Single user prompt. Multi-turn isn't supported by the UI surface. */
	message: string;
	/** Server-side cap on the SSE wait. Default 180s. */
	timeoutMs?: number;
}

export interface BrowserChatResult {
	status: number;
	contentType: string;
	/** Buffered SSE body (text/event-stream). */
	body: string;
}

export async function browserDrivenChat(
	browser: RemoteBrowserService,
	opts: BrowserChatOptions,
): Promise<BrowserChatResult> {
	const page = browser.getPage();
	if (!page) throw new Error('Browser not connected');

	const prev = tails.get(page) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => {
		release = r;
	});
	tails.set(
		page,
		prev.then(() => next),
	);
	await prev;
	try {
		return await runOne(page, opts.model, opts.message, opts.timeoutMs ?? 180_000);
	} finally {
		release();
	}
}

async function runOne(
	page: Page,
	modelSlug: string,
	message: string,
	timeoutMs: number,
): Promise<BrowserChatResult> {
	// 1. Navigate (idempotent — only goto if not already on this model's page).
	const targetUrl = `${BUILD_BASE}/${modelSlug}`;
	if (!page.url().startsWith(targetUrl)) {
		await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	}

	// 2. Dismiss modals on first visit (OneTrust, Acknowledge & Continue).
	await dismissModals(page);

	// 3. Wait for the visible chat textarea (placeholder set, not the hidden
	//    captcha-response textareas) and the Send button.
	await page.waitForFunction(VISIBLE_INPUT_FN, { timeout: 30_000 });
	await page.waitForSelector('button[aria-label="Send"]', { timeout: 30_000 });

	// 4. Pre-arm the response listener BEFORE clicking Send. The bare model
	//    name (last segment of the slug) is what the API path uses.
	const bareModel = modelSlug.includes('/') ? (modelSlug.split('/').pop() ?? modelSlug) : modelSlug;
	const targetPath = `${NGC_PREDICT_PREFIX}${bareModel}`;
	const responsePromise = page.waitForResponse(
		(resp) => {
			const u = resp.url();
			return u.includes(NGC_HOST) && u.includes(targetPath) && resp.request().method() === 'POST';
		},
		{ timeout: timeoutMs },
	);

	// 5. Drive the UI with COORDINATE-BASED clicks + real keyboard typing.
	//    `locator.click({force: true})` synthesises a single mousedown→mouseup
	//    with no prior motion — hCaptcha invisible mode rejects this as a bot
	//    signature and silently fails to mint a token. Verified empirically:
	//    a vanilla headed Chrome with coord-based clicks + page.keyboard.type
	//    DOES get a valid token, while locator.click({force: true}) does not.
	//    The same heuristic applies to `locator.fill` — it sets the value
	//    without firing keyboard events; behavioural collectors see a "user
	//    materialised, no typing" pattern. Use the keyboard.

	// Resolve textarea + Send coordinates from the DOM.
	const taSelector =
		'textarea[placeholder]:not([name="g-recaptcha-response"]):not([name="h-captcha-response"])';
	const taCoords = await page.locator(taSelector).first().boundingBox();
	if (!taCoords) throw new Error('Textarea not visible');
	const taX = Math.round(taCoords.x + taCoords.width / 2);
	const taY = Math.round(taCoords.y + taCoords.height / 2);

	// Click into the textarea via real coord click (uses CDP
	// Input.dispatchMouseEvent under the hood — see RemoteBrowserService.click).
	await page.mouse.click(taX, taY);
	await page.waitForTimeout(120);

	// Clear any pre-existing draft and type the prompt.
	await page.keyboard.press('Control+A');
	await page.keyboard.press('Delete');
	await page.keyboard.type(message, { delay: 35 });
	await page.waitForTimeout(250);

	// Resolve Send button coordinates AFTER typing — its position can shift
	// once the textarea expands.
	const sendCoords = await page.locator('button[aria-label="Send"]').boundingBox();
	if (!sendCoords) throw new Error('Send button not visible');
	const sendX = Math.round(sendCoords.x + sendCoords.width / 2);
	const sendY = Math.round(sendCoords.y + sendCoords.height / 2);

	// Move the mouse to Send (gives behavioural collectors a mousemove path)
	// and click via coords. `page.mouse.click` honours steps when given via
	// move; the click itself is a normal mousedown→mouseup sequence at the
	// resolved point.
	await page.mouse.move(sendX, sendY, { steps: 10 });
	await page.waitForTimeout(80);
	await page.mouse.click(sendX, sendY);

	// 6. Wait for the response to land, then extract the assembled text from
	//    the DOM. We can't reliably call `response.body()` on SSE streams —
	//    Patchright proxies through CDP `Network.getResponseBody`, which
	//    returns "No data found" for streams the browser has already consumed
	//    chunk-by-chunk into the DOM. Until we plumb a full Fetch.requestPaused
	//    intercept-and-replay path (HCAPTCHA-VS-TURNSTILE.md Phase 4), we read
	//    the rendered answer back from the chat region.
	const response = await responsePromise;
	const status = response.status();
	const contentType = response.headers()['content-type'] || 'text/event-stream';

	// Wait for the page to finish appending the assistant turn. The chat
	// region adds a "Reasoning Complete" marker once streaming stops.
	const text = await waitForAssistantTurn(page, message, timeoutMs);

	return {
		status,
		contentType,
		body: text,
	};
}

/**
 * Poll the chat region until the assistant turn after our prompt is complete.
 * Returns the assistant's rendered text. Throws on timeout.
 */
async function waitForAssistantTurn(
	page: Page,
	prompt: string,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	const escaped = prompt.replace(/[\\]/g, '\\\\').replace(/'/g, "\\'");
	const expr = `(() => {
		const main = document.querySelector('main, [role="main"]');
		if (!main) return null;
		const lines = main.innerText.split('\\n').map(l => l.trim()).filter(Boolean);
		// Find the LAST occurrence of our prompt (in case the user has chat history).
		let promptIdx = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i] === '${escaped}') { promptIdx = i; break; }
		}
		if (promptIdx < 0) return null;
		// Walk forward; collect lines until the next "Reasoning Complete" marker
		// followed by the assistant text, or until we hit footer chrome.
		const tail = lines.slice(promptIdx + 1);
		// Drop everything after the model's epilogue chrome ("Tools", "Parameters",
		// "GOVERNING TERMS", license/copyright lines).
		const stops = ['Tools', 'Parameters', 'GOVERNING TERMS:', 'Terms of Use', 'Copyright'];
		const cutAt = tail.findIndex(l => stops.some(s => l.startsWith(s)));
		const turn = cutAt >= 0 ? tail.slice(0, cutAt) : tail;
		// Check for completion marker.
		const done = turn.some(l => l === 'Reasoning Complete' || l === 'Response complete');
		if (!done && turn.length === 0) return null;
		return { done, lines: turn };
	})()`;
	while (Date.now() < deadline) {
		const r = (await page.evaluate(expr).catch(() => null)) as {
			done: boolean;
			lines: string[];
		} | null;
		if (r && r.done) {
			// Drop the marker line itself; the rest is the assistant body.
			return r.lines
				.filter((l) => l !== 'Reasoning Complete' && l !== 'Response complete')
				.join('\n');
		}
		await page.waitForTimeout(400);
	}
	throw new Error('Assistant turn did not complete before timeout');
}

async function dismissModals(page: Page): Promise<void> {
	const ot = page.locator('#onetrust-accept-btn-handler');
	if (await ot.count()) await ot.click({ timeout: 5_000 }).catch(() => {});
	const ack = page.getByRole('button', { name: /acknowledge\s*&?\s*continue/i });
	if (await ack.count())
		await ack
			.first()
			.click({ timeout: 5_000 })
			.catch(() => {});
	await page
		.waitForSelector('div.nv-modal-overlay', { state: 'detached', timeout: 10_000 })
		.catch(() => {});
}

// Inline string for page.waitForFunction — tsx/esbuild's keepNames wraps
// arrow-function values, breaking the eval. Plain template form works.
const VISIBLE_INPUT_FN = `() => {
  const tas = Array.from(document.querySelectorAll('textarea'));
  return tas.some((t) => t.placeholder && !t.disabled && t.offsetParent !== null);
}`;
