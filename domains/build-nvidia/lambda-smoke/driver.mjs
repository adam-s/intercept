#!/usr/bin/env node

/**
 * Lambda smoke driver for build-nvidia.
 *
 * Mirrors toolkit/experiments/poc-lambda-fanout/driver.ts. For each iteration:
 *   1. Capture an UN-BURNED predict POST locally via the running API server
 *      (POST /api/build-nvidia/debug/capture-unburned).
 *   2. Read the captured tuple back via /debug/last-predict.
 *   3. Invoke the deployed Lambda with the tuple as the payload.
 *   4. Lambda replays the POST from its own egress IP, returns status + IP.
 *
 * Tells us:
 *   - Does NVIDIA accept tokens minted on home IP from a different IP?
 *     (i.e., is the predict endpoint per-IP locked or only per-token?)
 *   - How many distinct Lambda IPs do we hit? (validates IP rotation works)
 *   - Latency from Lambda → NVIDIA.
 *
 * Usage:
 *   node domains/build-nvidia/lambda-smoke/driver.mjs --n 5
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, a, i, arr) => {
		if (a.startsWith('--')) {
			const k = a.slice(2);
			const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
			acc.push([k, v]);
		}
		return acc;
	}, []),
);

const N = Number(args.n ?? 1);
const FN_NAME = args.fn ?? 'bn-smoke-predict';
const REGION = args.region ?? process.env.AWS_REGION ?? 'us-east-1';
const BASE = args.base ?? 'http://localhost:3001';
const MODEL = args.model ?? 'openai/gpt-oss-20b';
const MESSAGE = args.message ?? 'What is 2+2? Answer in one word.';

console.log(`[driver] n=${N} fn=${FN_NAME} region=${REGION} base=${BASE} model=${MODEL}`);

async function showHomeIP() {
	try {
		const r = await fetch('https://api.ipify.org?format=json');
		const j = await r.json();
		return j.ip;
	} catch {
		return 'unknown';
	}
}

async function capturePredict() {
	const r = await fetch(`${BASE}/api/build-nvidia/debug/capture-unburned`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, message: MESSAGE }),
	});
	if (!r.ok) throw new Error(`capture-unburned ${r.status}`);
	const last = await fetch(`${BASE}/api/build-nvidia/debug/last-predict`);
	const j = await last.json();
	if (!j.ok || !j.capture) throw new Error('last-predict missing');
	return j.capture;
}

function invokeLambda(payload) {
	const tmp = mkdtempSync(join(tmpdir(), 'bn-smoke-'));
	const payloadPath = join(tmp, 'payload.json');
	const respPath = join(tmp, 'resp.json');
	writeFileSync(payloadPath, JSON.stringify(payload));
	try {
		const r = spawnSync(
			'aws',
			[
				'lambda',
				'invoke',
				'--function-name',
				FN_NAME,
				'--region',
				REGION,
				'--payload',
				`fileb://${payloadPath}`,
				'--cli-binary-format',
				'raw-in-base64-out',
				respPath,
			],
			{ encoding: 'utf-8' },
		);
		if (r.status !== 0) return { error: `aws cli exited ${r.status}: ${r.stderr.slice(0, 200)}` };
		const text = readFileSync(respPath, 'utf-8');
		const parsed = JSON.parse(text);
		if (parsed.errorMessage) return { error: `lambda error: ${parsed.errorMessage}` };
		return parsed;
	} finally {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	}
}

const homeIP = await showHomeIP();
console.log(`[driver] home IP: ${homeIP}`);

const results = [];
for (let i = 0; i < N; i++) {
	const tCap = Date.now();
	let cap;
	try {
		cap = await capturePredict();
	} catch (e) {
		console.log(`  [${i + 1}/${N}] capture failed: ${e.message}`);
		results.push({ stage: 'capture', error: e.message });
		continue;
	}
	const captureMs = Date.now() - tCap;
	const headerKeys = Object.keys(cap.headers ?? {});
	const tokenHeader = cap.headers?.['nv-captcha-token'] ?? cap.headers?.['Nv-Captcha-Token'] ?? '';
	console.log(
		`  [${i + 1}/${N}] captured in ${captureMs}ms — url=${cap.url?.slice(0, 60)}…  ` +
			`tokenLen=${tokenHeader.length} cookies=${cap.cookies?.length ?? 0} headerCount=${headerKeys.length}`,
	);

	const tInvoke = Date.now();
	const r = invokeLambda(cap);
	const invokeMs = Date.now() - tInvoke;
	if (r.error) {
		console.log(`     ↳ lambda error: ${r.error}`);
		results.push({ stage: 'lambda', error: r.error, captureMs });
		continue;
	}
	console.log(
		`     ↳ lambda srcIP=${r.sourceIP} status=${r.status} replayMs=${r.durationMs} invokeMs=${invokeMs}` +
			(r.bodyExcerpt ? ` body="${r.bodyExcerpt.slice(0, 80).replace(/\n/g, '\\n')}…"` : ''),
	);
	results.push({ stage: 'done', captureMs, invokeMs, ...r });
}

console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
const captured = results.filter((r) => r.stage !== 'capture');
const invoked = results.filter((r) => r.stage === 'done');
const ok2xx = invoked.filter((r) => r.status >= 200 && r.status < 300);
const sse = invoked.filter((r) =>
	(r.headersExcerpt?.['content-type'] ?? '').includes('event-stream'),
);
const distinctIPs = new Set(invoked.map((r) => r.sourceIP).filter(Boolean));
const statusCounts = {};
for (const r of invoked) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

console.log(`Total iterations: ${results.length}`);
console.log(`Captured locally: ${captured.length}/${results.length}`);
console.log(`Lambda invocations: ${invoked.length}`);
console.log(`Predict 2xx:       ${ok2xx.length}/${invoked.length}`);
console.log(`SSE responses:     ${sse.length}/${invoked.length}`);
console.log(`Distinct AWS IPs:  ${distinctIPs.size} — ${[...distinctIPs].join(', ')}`);
console.log(`Status counts:     ${JSON.stringify(statusCounts)}`);

if (invoked.length > 0 && ok2xx.length === 0) {
	console.log(`\nFIRST FAILURE BODY:\n  ${invoked[0].bodyExcerpt?.slice(0, 300)}`);
}

process.exit(ok2xx.length > 0 ? 0 : 1);
