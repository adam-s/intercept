#!/usr/bin/env tsx
/**
 * Challenge Runner
 *
 * Solves programming challenges by calling the ChatGPT proxy endpoint.
 *
 * USAGE
 * ─────
 *   # Solve all 3 challenges
 *   pnpm tsx domains/chatgpt/challenges/run.ts
 *
 *   # Solve a specific challenge
 *   pnpm tsx domains/chatgpt/challenges/run.ts 1-sqlite-windows
 *
 * PREREQUISITES
 * ─────────────
 *   1. API server running:  pnpm --filter @interceptor/api dev
 *   2. Browser connected:   ./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com
 *   3. Session harvested:   curl -X POST http://localhost:3001/api/chatgpt/session/harvest
 *   4. Fingerprint active:  curl -X POST http://localhost:3001/api/chatgpt/fingerprint/attach \
 *                             -H 'Content-Type: application/json' \
 *                             -d '{"mode":"control"}'
 *
 * HOW IT WORKS
 * ────────────
 *   For each challenge:
 *   1. Read the challenge's input files (seed.sql, CSV, etc.)
 *   2. Build a precise prompt with the challenge requirements
 *   3. POST /api/chatgpt/chat — streams response through the proxy
 *   4. Extract the code block from the response
 *   5. Write the solution file to a temp directory
 *   6. Copy any required input files into the temp directory
 *   7. Install dependencies if needed (npm install / pip install)
 *   8. Run the test command and report pass/fail
 */

import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHALLENGES } from './challenges.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const CHALLENGE_DIR = __dirname;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
	console.log(`[harness] ${msg}`);
}

function section(title: string) {
	console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
}

/** Extract the first code block from a markdown/text response. */
function extractCode(response: string): string {
	// Try fenced code block first
	const fencedMatch = response.match(/```(?:\w+)?\n([\s\S]+?)\n```/);
	if (fencedMatch) return fencedMatch[1].trim();

	// No fence — return the whole response trimmed
	return response.trim();
}

/** Call POST /api/chatgpt/chat and collect the streamed response. */
async function callChatGPT(message: string, model = 'gpt-4o'): Promise<string> {
	const resp = await fetch(`${API_BASE}/api/chatgpt/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ message, model }),
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Chat proxy returned ${resp.status}: ${body}`);
	}

	const contentType = resp.headers.get('content-type') ?? '';

	// SSE stream — collect all delta text
	if (contentType.includes('text/event-stream')) {
		const reader = resp.body!.getReader();
		const decoder = new TextDecoder();
		let fullText = '';
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
					if (typeof delta === 'string') fullText += delta;
				} catch {
					// skip malformed lines
				}
			}
		}
		return fullText;
	}

	// Plain JSON fallback
	const json = (await resp.json()) as Record<string, unknown>;
	return (json.text ?? json.content ?? json.message ?? JSON.stringify(json)) as string;
}

/** Run a shell command and return { exitCode, stdout, stderr }. */
function runCommand(cmd: string, cwd: string) {
	const result = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000 });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

// ─── Per-challenge setup ──────────────────────────────────────────────────────

function setupWorkDir(challengeId: string, files: string[]): string {
	const workDir = mkdtempSync(join(tmpdir(), `challenge-${challengeId}-`));
	log(`Work dir: ${workDir}`);

	for (const f of files) {
		const src = join(CHALLENGE_DIR, challengeId, f);
		const dest = join(workDir, f);
		// Create subdirectory if needed
		const destDir = dirname(dest);
		if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
		cpSync(src, dest);
		log(`Copied ${f}`);
	}

	return workDir;
}

function installDeps(challengeId: string, workDir: string) {
	if (challengeId === '1-sqlite-windows') {
		// Copy test.js from challenge dir so we can run node test.js
		const testSrc = join(CHALLENGE_DIR, challengeId, 'test.js');
		if (existsSync(testSrc)) {
			writeFileSync(join(workDir, 'test.js'), readFileSync(testSrc));
			log('Copied test.js');
		}
		// Need better-sqlite3
		log('Installing better-sqlite3...');
		const pkg = JSON.stringify({
			name: 'challenge',
			version: '1.0.0',
			type: 'module',
			dependencies: { 'better-sqlite3': '^9.0.0' },
		});
		writeFileSync(join(workDir, 'package.json'), pkg);
		const r = runCommand('npm install --silent 2>&1', workDir);
		if (r.exitCode !== 0) {
			log(`npm install failed:\n${r.stdout}\n${r.stderr}`);
		}
	}

	if (challengeId === '2-hono-websocket') {
		// Copy test.js
		const testSrc = join(CHALLENGE_DIR, challengeId, 'test.js');
		if (existsSync(testSrc)) {
			writeFileSync(join(workDir, 'test.js'), readFileSync(testSrc));
			log('Copied test.js');
		}
		// Need hono for Bun
		log('Installing hono...');
		const pkg = JSON.stringify({
			name: 'challenge',
			version: '1.0.0',
			type: 'module',
			dependencies: { hono: '^4.0.0' },
		});
		writeFileSync(join(workDir, 'package.json'), pkg);
		const r = runCommand('bun install 2>&1', workDir);
		if (r.exitCode !== 0) log(`bun install failed: ${r.stderr}`);
	}

	if (challengeId === '3-csv-reporter') {
		// Copy test.py
		const testSrc = join(CHALLENGE_DIR, challengeId, 'test.py');
		if (existsSync(testSrc)) {
			writeFileSync(join(workDir, 'test.py'), readFileSync(testSrc));
			log('Copied test.py');
		}
	}
}

// ─── Main runner ─────────────────────────────────────────────────────────────

async function runChallenge(id: string): Promise<boolean> {
	const def = CHALLENGES.find((c) => c.id === id);
	if (!def) throw new Error(`Unknown challenge: ${id}`);

	section(`Challenge: ${def.name} (${def.id})`);

	// 1. Read input files
	const fileContents: Record<string, string> = {};
	for (const f of def.files) {
		const p = join(CHALLENGE_DIR, def.dir, f);
		fileContents[f] = readFileSync(p, 'utf8');
	}

	// 2. Build prompt
	const prompt = def.buildPrompt(fileContents);
	log(`Sending prompt (${prompt.length} chars) to ChatGPT...`);

	// 3. Call ChatGPT proxy
	let raw: string;
	try {
		raw = await callChatGPT(prompt);
	} catch (err) {
		log(`ERROR calling chat proxy: ${err}`);
		return false;
	}
	log(`Received response (${raw.length} chars)`);

	// 4. Extract code
	const code = extractCode(raw);
	if (!code) {
		log('ERROR: No code found in response');
		console.log('--- Raw response ---\n', raw);
		return false;
	}
	log(`Extracted code (${code.length} chars)`);

	// 5. Set up work directory
	const workDir = setupWorkDir(def.dir, def.files);

	// 6. Write solution file
	writeFileSync(join(workDir, def.solution), code, 'utf8');
	log(`Wrote ${def.solution}`);

	// 7. Install dependencies
	installDeps(def.id, workDir);

	// 8. Run test
	log(`Running test: ${def.testCmd}`);
	const { exitCode, stdout, stderr } = runCommand(def.testCmd, workDir);
	console.log('\n--- Test output ---');
	if (stdout) console.log(stdout);
	if (stderr) console.error(stderr);

	const passed = exitCode === 0;
	log(passed ? '✓ PASSED' : `✗ FAILED (exit ${exitCode})`);
	return passed;
}

async function main() {
	const args = process.argv.slice(2);
	const targetIds = args.length > 0 ? args : CHALLENGES.map((c) => c.id);

	section('ChatGPT Challenge Harness');
	log(`API: ${API_BASE}`);
	log(`Challenges: ${targetIds.join(', ')}`);

	// Verify API is up
	try {
		const health = await fetch(`${API_BASE}/health`);
		if (!health.ok) throw new Error(`status ${health.status}`);
		log('API server: OK');
	} catch (err) {
		log(`ERROR: Cannot reach API server at ${API_BASE} — ${err}`);
		log('Start it with: pnpm --filter @interceptor/api dev');
		process.exit(1);
	}

	const results: { id: string; passed: boolean }[] = [];

	for (const id of targetIds) {
		const passed = await runChallenge(id);
		results.push({ id, passed });
	}

	section('Results');
	let allPassed = true;
	for (const { id, passed } of results) {
		console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id}`);
		if (!passed) allPassed = false;
	}
	console.log(`\n${results.filter((r) => r.passed).length}/${results.length} challenges passed`);

	process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
