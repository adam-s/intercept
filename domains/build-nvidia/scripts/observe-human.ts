/**
 * Observation harness — open a headed browser to a build.nvidia.com chat
 * page, install every research hook (runtime tap, NVIDIA-bundle
 * instrumentation, parent postMessage capture, hCaptcha bundle dump),
 * wait for a human to drive the page, then write a session report to
 * disk.
 *
 * The runtime tap auto-propagates into the hCaptcha OOPIF so we get
 * EventTarget/timer/fetch/XHR visibility from inside the iframe — that
 * is the only way to see the api.hcaptcha.com `getcaptcha` POST body
 * (it originates inside the cross-origin iframe; parent-realm hooks
 * can't see it).
 *
 * USAGE
 *   pnpm tsx domains/build-nvidia/scripts/observe-human.ts \
 *     --model openai/gpt-oss-20b \
 *     [--port 3001] \
 *     [--profile bn-observe-<ts>] \
 *     [--out /tmp/build-nvidia-observe/<ts>/]
 *
 * The script prints the session-report path on exit. Browser stays open
 * so you can repeat input or inspect manually — kill the connect-browser
 * process via the printed `kill` command when done.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface Args {
	model: string;
	port: number;
	profile: string;
	out: string;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let model = 'openai/gpt-oss-20b';
	let port = 3001;
	let profile = `bn-observe-${Date.now()}`;
	let out = '';
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--model') model = argv[++i] ?? model;
		else if (a === '--port') port = Number.parseInt(argv[++i] ?? '3001', 10);
		else if (a === '--profile') profile = argv[++i] ?? profile;
		else if (a === '--out') out = argv[++i] ?? out;
		else if (a === '-h' || a === '--help') {
			console.log(
				`Usage: observe-human.ts --model <vendor/slug> [--port 3001] [--profile <name>] [--out <dir>]`,
			);
			process.exit(0);
		}
	}
	if (!out) out = `/tmp/build-nvidia-observe/${Date.now()}-${profile}`;
	return { model, port, profile, out };
}

const __filenameESM = fileURLToPath(import.meta.url);
const __dirnameESM = dirname(__filenameESM);
const projectRoot = resolve(__dirnameESM, '..', '..', '..');

function logStep(step: string, msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	console.log(`[${ts}] ${step}: ${msg}`);
}

async function check(url: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
	const res = await fetch(url).catch((err: unknown) => err);
	if (res instanceof Error) return { ok: false, status: 0 };
	const r = res as Response;
	const text = await r.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* keep as text */
	}
	return { ok: r.ok, status: r.status, body };
}

async function postJson(
	url: string,
	body: unknown,
): Promise<{ ok: boolean; status: number; body?: unknown }> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}).catch((err: unknown) => err);
	if (res instanceof Error) return { ok: false, status: 0 };
	const r = res as Response;
	const text = await r.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* keep */
	}
	return { ok: r.ok, status: r.status, body: parsed };
}

async function postEmpty(url: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
	const res = await fetch(url, { method: 'POST' }).catch((err: unknown) => err);
	if (res instanceof Error) return { ok: false, status: 0 };
	const r = res as Response;
	const text = await r.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* keep */
	}
	return { ok: r.ok, status: r.status, body: parsed };
}

async function waitForEnter(prompt: string): Promise<void> {
	console.log('');
	console.log('━'.repeat(72));
	console.log(prompt);
	console.log('━'.repeat(72));
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	await new Promise<void>((resolve) =>
		rl.question('Press ENTER when done > ', () => {
			rl.close();
			resolve();
		}),
	);
}

interface FrameSummary {
	frame: string;
	apis: Record<string, number>;
	eventTypes: Record<string, number>;
	trustedRatio: number | null;
}

interface RuntimeTapEntry {
	api: string;
	kind: string;
	type?: string;
	url?: string;
	method?: string;
	body?: string;
	status?: number;
	src?: string;
	headers?: Record<string, string>;
	t?: number;
	durMs?: number;
	evt?: { type: string; isTrusted: boolean; key?: string; x?: number; y?: number };
}

interface RuntimeTapDrain {
	frames: Record<string, RuntimeTapEntry[]>;
	total: number;
	frameUrls: string[];
	frameErrors?: Record<string, string>;
}

function summariseFrames(drain: RuntimeTapDrain): FrameSummary[] {
	const out: FrameSummary[] = [];
	for (const [frame, entries] of Object.entries(drain.frames)) {
		const apis: Record<string, number> = {};
		const types: Record<string, number> = {};
		let trustedTotal = 0;
		let trustedCount = 0;
		for (const e of entries) {
			apis[e.api] = (apis[e.api] ?? 0) + 1;
			const t = e.type ?? e.evt?.type;
			if (t) types[t] = (types[t] ?? 0) + 1;
			if (e.evt) {
				trustedTotal++;
				if (e.evt.isTrusted) trustedCount++;
			}
		}
		out.push({
			frame,
			apis,
			eventTypes: types,
			trustedRatio: trustedTotal > 0 ? +(trustedCount / trustedTotal).toFixed(3) : null,
		});
	}
	return out;
}

function findHCaptchaPosts(drain: RuntimeTapDrain): RuntimeTapEntry[] {
	const out: RuntimeTapEntry[] = [];
	for (const entries of Object.values(drain.frames)) {
		for (const e of entries) {
			if ((e.api === 'fetch' || e.api === 'xhr') && e.url && /hcaptcha\.com/.test(e.url)) {
				out.push(e);
			}
		}
	}
	return out;
}

function findPredictPosts(drain: RuntimeTapDrain): RuntimeTapEntry[] {
	const out: RuntimeTapEntry[] = [];
	for (const entries of Object.values(drain.frames)) {
		for (const e of entries) {
			if (
				(e.api === 'fetch' || e.api === 'xhr') &&
				e.url &&
				/api\.ngc\.nvidia\.com.*predict/.test(e.url)
			) {
				out.push(e);
			}
		}
	}
	return out;
}

async function main(): Promise<void> {
	const args = parseArgs();
	const baseUrl = `http://localhost:${args.port}`;
	const targetUrl = `https://build.nvidia.com/${args.model}`;

	logStep('init', `model=${args.model} port=${args.port} profile=${args.profile}`);
	logStep('init', `out=${args.out}`);

	// 1. Verify API server reachable
	const health = await check(`${baseUrl}/health`).catch(() => ({ ok: false, status: 0 }));
	if (!health.ok) {
		console.error(`API server not reachable on port ${args.port}.`);
		console.error(`Start it with: pnpm --filter @interceptor/api dev`);
		process.exit(1);
	}
	logStep('init', 'API server reachable');

	// 2. Connect headed browser to the model page
	const connectScript = join(projectRoot, 'scripts', 'connect-browser.sh');
	logStep('browser', `launching headed (profile=${args.profile})`);
	const connect = spawnSync(
		'bash',
		[
			connectScript,
			'--headed',
			'--profile',
			args.profile,
			'--url',
			targetUrl,
			'--port',
			String(args.port),
			'--timeout',
			'90',
		],
		{ encoding: 'utf8', stdio: 'inherit' },
	);
	if (connect.status !== 0) {
		console.error(`connect-browser.sh failed (exit ${connect.status})`);
		process.exit(1);
	}

	// 3. Attach research hooks. Order: runtime-tap FIRST so it sees later registrations
	//    that the bundle-capture/instrument modules trigger via their own page interactions.
	const tag = `observe-${Date.now()}`;

	logStep('attach', 'runtime-tap');
	const tapAttach = await postEmpty(`${baseUrl}/api/build-nvidia/debug/runtime-tap/attach`);
	if (!tapAttach.ok) {
		console.error(`runtime-tap attach failed: ${JSON.stringify(tapAttach.body)}`);
		process.exit(1);
	}

	logStep('attach', 'instrument (NVIDIA bundle execute() decorator + parent fetch/xhr)');
	const instrAttach = await postEmpty(`${baseUrl}/api/build-nvidia/debug/instrument/attach`);
	if (!instrAttach.ok) {
		console.warn(
			`instrument attach returned ${instrAttach.status}: ${JSON.stringify(instrAttach.body)}`,
		);
	}

	logStep('attach', `bundle capture (tag=${tag})`);
	const bundleAttach = await postEmpty(
		`${baseUrl}/api/build-nvidia/debug/bundles/start?tag=${encodeURIComponent(tag)}`,
	);
	if (!bundleAttach.ok) {
		console.warn(
			`bundle capture attach returned ${bundleAttach.status}: ${JSON.stringify(bundleAttach.body)}`,
		);
	}

	logStep('attach', 'parent postMessage capture (10 min window)');
	const pmAttach = await postEmpty(
		`${baseUrl}/api/build-nvidia/debug/captcha/pm/start?windowMs=600000`,
	);
	if (!pmAttach.ok) {
		console.warn(`pm capture attach returned ${pmAttach.status}: ${JSON.stringify(pmAttach.body)}`);
	}
	const pmTag = (pmAttach.body as { tag?: string } | undefined)?.tag ?? '';
	if (pmTag) logStep('attach', `pm tag = ${pmTag}`);

	// 4. Reload the page so the runtime-tap init script runs BEFORE any page or
	//    iframe script. Without this, the tap installed too late to wrap the
	//    APIs the page bundle already grabbed references to.
	logStep('reload', 'reloading page so init scripts fire before any page script');
	await postJson(`${baseUrl}/browser/mcp/evaluate`, { script: 'location.reload()' });
	await new Promise((r) => setTimeout(r, 8000));

	// 5. Hand off to the human
	await waitForEnter(
		[
			'Browser is open and instrumented.',
			'',
			'1. Click into the textarea on the chat page',
			'2. Type a prompt naturally (varied speed, real keystrokes)',
			'3. Move the mouse a bit (anywhere — give hCaptcha some motion data)',
			'4. Click Send',
			'5. Wait for a streaming response to start, OR for the request to fail',
			'',
			'Then come back here and press ENTER.',
		].join('\n'),
	);

	// 6. Drain everything
	logStep('drain', 'runtime-tap');
	const tapLog = await check(`${baseUrl}/api/build-nvidia/debug/runtime-tap/log`);
	const tapDrain = (tapLog.body as { ok: boolean } & RuntimeTapDrain) ?? {
		frames: {},
		total: 0,
		frameUrls: [],
	};

	logStep('drain', 'instrument log (parent fetch/xhr + execute() calls)');
	const instrLog = await check(`${baseUrl}/api/build-nvidia/debug/instrument/log`);
	const instrDrain = instrLog.body ?? { entries: [], mutations: [] };

	logStep('drain', 'parent postMessages');
	const pmLog = pmTag
		? await check(
				`${baseUrl}/api/build-nvidia/debug/captcha/pm/poll?tag=${encodeURIComponent(pmTag)}`,
			)
		: { ok: false, status: 0, body: { ok: false, error: 'pm capture did not start' } };
	const pmDrain = pmLog.body ?? { entries: [] };

	logStep('drain', 'bundle capture list');
	const bundleList = await check(
		`${baseUrl}/api/build-nvidia/debug/bundles/list?tag=${encodeURIComponent(tag)}`,
	);
	const bundleListBody = bundleList.body ?? { captured: [] };

	// 7. Stop captures (leave browser running for inspection / retries).
	// Bundle capture stops cleanly. The pm capture self-tears-down after windowMs,
	// so we don't need to stop it explicitly.
	await postEmpty(
		`${baseUrl}/api/build-nvidia/debug/bundles/stop?tag=${encodeURIComponent(tag)}`,
	).catch(() => {});

	// 8. Write session report
	mkdirSync(args.out, { recursive: true });
	writeFileSync(join(args.out, 'runtime-tap.json'), JSON.stringify(tapDrain, null, 2));
	writeFileSync(join(args.out, 'instrument.json'), JSON.stringify(instrDrain, null, 2));
	writeFileSync(join(args.out, 'postmessages.json'), JSON.stringify(pmDrain, null, 2));
	writeFileSync(join(args.out, 'bundles-list.json'), JSON.stringify(bundleListBody, null, 2));

	const frameSummaries = summariseFrames(tapDrain);
	const hcapPosts = findHCaptchaPosts(tapDrain);
	const predictPosts = findPredictPosts(tapDrain);

	const summary = [
		`# observe-human session report`,
		``,
		`- model: \`${args.model}\``,
		`- profile: \`${args.profile}\``,
		`- target: ${targetUrl}`,
		`- bundles dir: \`/tmp/build-nvidia-bundles/${tag}/\``,
		``,
		`## Runtime tap`,
		``,
		`- total entries: **${tapDrain.total}**`,
		`- frames touched: ${tapDrain.frameUrls.length}`,
		`- frames with errors: ${Object.keys(tapDrain.frameErrors ?? {}).length}`,
		``,
		`### Per-frame breakdown`,
		``,
		...frameSummaries.flatMap((f) => [
			`#### \`${f.frame}\``,
			``,
			`- trustedRatio: ${f.trustedRatio === null ? 'n/a' : f.trustedRatio}`,
			`- APIs: ${Object.entries(f.apis)
				.map(([k, v]) => `${k}=${v}`)
				.join(', ')}`,
			`- event types: ${Object.entries(f.eventTypes)
				.map(([k, v]) => `${k}=${v}`)
				.slice(0, 20)
				.join(', ')}`,
			``,
		]),
		``,
		`## hCaptcha network calls (api/hcaptcha.com seen by iframe-side fetch hook)`,
		``,
		`- count: **${hcapPosts.length}**`,
		...hcapPosts
			.slice(0, 10)
			.map(
				(p) =>
					`  - ${p.api.toUpperCase()} ${p.method ?? ''} ${p.url} → status ${p.status ?? '(register)'}`,
			),
		``,
		`## NIM predict POST (chat completion via the playground)`,
		``,
		`- count: **${predictPosts.length}**`,
		...predictPosts.slice(0, 5).map((p) => {
			const tok = p.headers?.['nv-captcha-token'] ?? p.headers?.['Nv-Captcha-Token'] ?? '(none)';
			const tokPreview =
				typeof tok === 'string' ? tok.slice(0, 40) + (tok.length > 40 ? '...' : '') : String(tok);
			return `  - ${p.api.toUpperCase()} ${p.method ?? ''} ${p.url} → status ${p.status ?? '(register)'} | nv-captcha-token: ${tokPreview}`;
		}),
		``,
		`## Files`,
		``,
		`- runtime-tap.json — per-frame log of registrations + invocations`,
		`- instrument.json — parent fetch/xhr + execute() decorator output + bundle mutations`,
		`- postmessages.json — parent-side hCaptcha postMessage transcript`,
		`- bundles-list.json — captured script paths under /tmp/build-nvidia-bundles/${tag}/`,
		``,
	].join('\n');
	writeFileSync(join(args.out, 'summary.md'), summary);

	console.log('');
	console.log('━'.repeat(72));
	console.log(`Session report written to: ${args.out}`);
	console.log(`  Open: ${join(args.out, 'summary.md')}`);
	console.log('━'.repeat(72));
	console.log('');
	console.log(
		`Browser still running. To stop: kill $(cat /tmp/connect-browser-${args.profile}.pid)`,
	);
	console.log(
		`To repeat (without restarting browser): re-run this script with --profile ${args.profile}.`,
	);

	// Quick post-hoc cleanup of the readline; node sometimes hangs on stdin afterward.
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
