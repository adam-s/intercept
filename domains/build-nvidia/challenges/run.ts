#!/usr/bin/env tsx
/**
 * Build-Nvidia Challenge Runner — model matrix
 *
 * Solves the same 3 programming challenges (originally written for the
 * chatgpt proxy) against arbitrary NVIDIA NIM models via the
 * `/api/build-nvidia/chat/completions` proxy. Produces a model × challenge
 * pass/fail matrix.
 *
 * USAGE
 * ─────
 *   # Default matrix: 5 curated models × 3 challenges
 *   pnpm tsx domains/build-nvidia/challenges/run.ts
 *
 *   # One model, all challenges
 *   pnpm tsx domains/build-nvidia/challenges/run.ts --model openai/gpt-oss-20b
 *
 *   # All default models, one challenge
 *   pnpm tsx domains/build-nvidia/challenges/run.ts --challenge 1-sqlite-windows
 *
 *   # One cell
 *   pnpm tsx domains/build-nvidia/challenges/run.ts \
 *     --model meta/llama-3_3-70b-instruct --challenge 3-csv-reporter
 *
 *   # Override the model list (comma-separated)
 *   pnpm tsx domains/build-nvidia/challenges/run.ts \
 *     --models openai/gpt-oss-20b,moonshotai/kimi-k2.6
 *
 * PREREQUISITES
 * ─────────────
 *   1. API server running:   pnpm --filter @interceptor/api dev
 *   2. NVIDIA_API_KEY set:   export NVIDIA_API_KEY=nvapi-…
 *      (alternatively, pass via Authorization header — but the harness
 *       reads from env and forwards it; clients can also POST directly.)
 *
 * NO BROWSER required — the chat route hits integrate.api.nvidia.com
 * with a Bearer token.
 *
 * DEPENDENCY CACHING
 * ──────────────────
 *   `1-sqlite-windows` requires `npm install better-sqlite3` (~30s native
 *   compile). To avoid re-installing for each model in the matrix, we
 *   prepare each challenge's work dir ONCE and copy it for each run.
 */

import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHALLENGES } from './challenges.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const CHALLENGE_DIR = __dirname;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ?? '';

const DEFAULT_MODELS = [
	'openai/gpt-oss-20b',
	'openai/gpt-oss-120b',
	'moonshotai/kimi-k2.6',
	'meta/llama-3_3-70b-instruct',
	'qwen/qwen2_5-coder-32b-instruct',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
	console.log(`[harness] ${msg}`);
}

function section(title: string) {
	console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

/** Extract the first fenced code block from a markdown response, or trim raw. */
function extractCode(response: string): string {
	const fenced = response.match(/```(?:\w+)?\n([\s\S]+?)\n```/);
	if (fenced) return fenced[1].trim();
	return response.trim();
}

/** Call POST /api/build-nvidia/chat/completions and collect text. Streaming-aware. */
async function callModel(message: string, model: string, timeoutMs = 180_000): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetch(`${API_BASE}/api/build-nvidia/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(NVIDIA_API_KEY ? { Authorization: `Bearer ${NVIDIA_API_KEY}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: message }],
				stream: true,
				temperature: 0.2,
				max_tokens: 8192,
			}),
			signal: ctrl.signal,
		});

		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`HTTP ${resp.status}: ${body.slice(0, 400)}`);
		}

		const ct = resp.headers.get('content-type') ?? '';
		if (ct.includes('text/event-stream') && resp.body) {
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let full = '';
			let buf = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;
					try {
						const parsed = JSON.parse(data);
						const delta = parsed?.choices?.[0]?.delta?.content;
						if (typeof delta === 'string') full += delta;
					} catch {
						// skip malformed
					}
				}
			}
			return full;
		}

		const json = (await resp.json()) as Record<string, unknown>;
		const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
		if (Array.isArray(choices) && choices[0]?.message?.content) return choices[0].message.content;
		return JSON.stringify(json);
	} finally {
		clearTimeout(timer);
	}
}

function runCommand(cmd: string, cwd: string, timeoutMs = 60_000) {
	const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: timeoutMs });
	return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ─── Per-challenge cached work dir ───────────────────────────────────────────

const cachedWorkDirs = new Map<string, string>();

/** Build a cached, dependency-installed work dir for a challenge once. */
function prepareCachedDir(id: string): string {
	const cached = cachedWorkDirs.get(id);
	if (cached) return cached;
	const dir = mkdtempSync(join(tmpdir(), `bn-cache-${id}-`));
	const def = CHALLENGES.find((c) => c.id === id);
	if (!def) throw new Error(`Unknown challenge: ${id}`);

	for (const f of def.files) {
		const src = join(CHALLENGE_DIR, def.dir, f);
		const dest = join(dir, f);
		const destDir = dirname(dest);
		if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
		cpSync(src, dest);
	}
	const testSrc = join(CHALLENGE_DIR, def.dir, id === '3-csv-reporter' ? 'test.py' : 'test.js');
	if (existsSync(testSrc))
		writeFileSync(
			join(dir, id === '3-csv-reporter' ? 'test.py' : 'test.js'),
			readFileSync(testSrc),
		);

	if (id === '1-sqlite-windows') {
		log(`[cache] installing better-sqlite3 in ${dir}`);
		const pkg = JSON.stringify({
			name: 'challenge',
			version: '1.0.0',
			type: 'module',
			dependencies: { 'better-sqlite3': '^12.0.0' },
		});
		writeFileSync(join(dir, 'package.json'), pkg);
		const r = runCommand('npm install --no-audit --no-fund 2>&1', dir, 240_000);
		if (r.exitCode !== 0) log(`[cache] npm install failed: ${r.stdout.slice(-400)}`);
	}
	if (id === '2-hono-websocket') {
		log(`[cache] installing hono in ${dir}`);
		const pkg = JSON.stringify({
			name: 'challenge',
			version: '1.0.0',
			type: 'module',
			dependencies: { hono: '^4.0.0' },
		});
		writeFileSync(join(dir, 'package.json'), pkg);
		runCommand('bun install 2>&1', dir);
	}

	cachedWorkDirs.set(id, dir);
	return dir;
}

/** Clone the cache, write the new solution, run the test. */
function runWithSolution(
	id: string,
	code: string,
): { passed: boolean; stdout: string; stderr: string } {
	const def = CHALLENGES.find((c) => c.id === id);
	if (!def) throw new Error(`Unknown challenge: ${id}`);
	const cache = prepareCachedDir(id);
	const work = mkdtempSync(join(tmpdir(), `bn-run-${id}-`));
	cpSync(cache, work, { recursive: true });
	writeFileSync(join(work, def.solution), code, 'utf8');
	const r = runCommand(def.testCmd, work, 90_000);
	rmSync(work, { recursive: true, force: true });
	return { passed: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr };
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface CellResult {
	model: string;
	challenge: string;
	passed: boolean;
	error?: string;
	durationMs: number;
}

function parseArgs(argv: string[]): { models: string[]; challenges: string[] } {
	let models = DEFAULT_MODELS;
	let challenges = CHALLENGES.map((c) => c.id);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--model') {
			models = [argv[++i]];
		} else if (a === '--models') {
			models = argv[++i]
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (a === '--challenge') {
			challenges = [argv[++i]];
		} else if (a === '--challenges') {
			challenges = argv[++i]
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}
	return { models, challenges };
}

async function main() {
	const { models, challenges } = parseArgs(process.argv.slice(2));

	section('build-nvidia challenge matrix');
	log(`API:        ${API_BASE}`);
	log(`Models:     ${models.join(', ')}`);
	log(`Challenges: ${challenges.join(', ')}`);
	log(
		`Auth:       ${NVIDIA_API_KEY ? 'NVIDIA_API_KEY env (Bearer)' : 'NONE — set NVIDIA_API_KEY'}`,
	);

	if (!NVIDIA_API_KEY) {
		log(
			'ERROR: NVIDIA_API_KEY is not set. Get a key from https://build.nvidia.com/explore/discover and `export NVIDIA_API_KEY=nvapi-…`.',
		);
		process.exit(2);
	}

	try {
		const health = await fetch(`${API_BASE}/health`);
		if (!health.ok) throw new Error(`HTTP ${health.status}`);
	} catch (err) {
		log(`ERROR: API server at ${API_BASE} unreachable — ${err}`);
		process.exit(1);
	}

	// Pre-prepare caches up-front so the first model doesn't pay setup cost.
	for (const cid of challenges) prepareCachedDir(cid);

	const results: CellResult[] = [];
	for (const model of models) {
		for (const cid of challenges) {
			const def = CHALLENGES.find((c) => c.id === cid);
			if (!def) continue;
			section(`${model}  ×  ${def.name}`);
			const start = Date.now();

			// Build prompt
			const fileContents: Record<string, string> = {};
			for (const f of def.files) {
				fileContents[f] = readFileSync(join(CHALLENGE_DIR, def.dir, f), 'utf8');
			}
			const prompt = def.buildPrompt(fileContents);

			// Call model
			let raw = '';
			try {
				log(`Calling ${model} (${prompt.length} char prompt)…`);
				raw = await callModel(prompt, model);
				log(`Got ${raw.length} chars`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`ERROR: ${msg}`);
				results.push({
					model,
					challenge: cid,
					passed: false,
					error: msg,
					durationMs: Date.now() - start,
				});
				continue;
			}

			const code = extractCode(raw);
			if (!code) {
				log('ERROR: empty response');
				results.push({
					model,
					challenge: cid,
					passed: false,
					error: 'empty response',
					durationMs: Date.now() - start,
				});
				continue;
			}

			// Run the test
			let passed = false;
			let testStdout = '';
			let testStderr = '';
			try {
				const r = runWithSolution(cid, code);
				passed = r.passed;
				testStdout = r.stdout;
				testStderr = r.stderr;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({
					model,
					challenge: cid,
					passed: false,
					error: msg,
					durationMs: Date.now() - start,
				});
				continue;
			}

			if (!passed) {
				console.log('--- test stdout ---\n', testStdout.slice(-800));
				console.log('--- test stderr ---\n', testStderr.slice(-400));
			}
			log(`${passed ? '✓ PASS' : '✗ FAIL'}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
			results.push({ model, challenge: cid, passed, durationMs: Date.now() - start });
		}
	}

	// ─── Matrix print ────────────────────────────────────────────────
	section('Matrix');
	const cIds = challenges;
	const header = ['model'.padEnd(50), ...cIds.map((c) => c.padEnd(20))].join('  ');
	console.log(header);
	console.log('-'.repeat(header.length));
	for (const m of models) {
		const cells = cIds.map((cid) => {
			const r = results.find((x) => x.model === m && x.challenge === cid);
			if (!r) return 'skip'.padEnd(20);
			const tag = r.passed
				? `✓ ${(r.durationMs / 1000).toFixed(0)}s`
				: r.error
					? `✗ err`
					: `✗ fail`;
			return tag.padEnd(20);
		});
		console.log([m.padEnd(50), ...cells].join('  '));
	}

	const passCount = results.filter((r) => r.passed).length;
	console.log(`\nTotal: ${passCount}/${results.length} cells passed`);
	process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
