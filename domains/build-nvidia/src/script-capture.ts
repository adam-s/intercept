/**
 * hCaptcha bundle capture via CDP — Phase 2 follow-up.
 *
 * Uses the existing CdpScriptControl.captureScripts to dump every script
 * served from `*hcaptcha.com*` (the iframe SDK + worker scripts) and
 * `*build.nvidia.com/_next/static/chunks/*` (NVIDIA's React bundle that
 * wraps the postMessage helper) to disk for offline grep/analysis.
 *
 * Bytes are NOT modified — capture only. The doc's Phase-1 instrumentation
 * goal: see what the SDK actually does, look for self-checksum/native-fn
 * checks (PerimeterX/Distil-style anti-bot patterns).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteBrowserService } from '@interceptor/browser/remote';

const DEFAULT_DUMP_DIR = '/tmp/build-nvidia-bundles';

export interface CaptureSession {
	dumpDir: string;
	captured: Array<{ url: string; size: number; path: string; status: number }>;
	stop: () => Promise<void>;
}

const sessions = new Map<string, CaptureSession>();

function urlSlug(url: string): string {
	return url
		.replace(/^https?:\/\//, '')
		.replace(/\?.*$/, '')
		.replace(/[^a-zA-Z0-9._-]/g, '_')
		.slice(0, 200);
}

export async function startBundleCapture(
	browser: RemoteBrowserService,
	tag: string,
	patterns: string[] = [
		'*newassets.hcaptcha.com*',
		'*api.hcaptcha.com*',
		'*build.nvidia.com/_next/static/chunks/*',
	],
	dumpDir: string = `${DEFAULT_DUMP_DIR}/${tag}`,
): Promise<{ ok: boolean; tag: string; dumpDir: string; patterns: string[]; error?: string }> {
	if (sessions.has(tag)) return { ok: false, tag, dumpDir, patterns, error: 'tag already active' };
	const control = browser.getScriptControl();
	if (!control)
		return {
			ok: false,
			tag,
			dumpDir,
			patterns,
			error: 'No CdpScriptControl on this browser session',
		};

	mkdirSync(dumpDir, { recursive: true });
	const session: CaptureSession = { dumpDir, captured: [], stop: async () => {} };
	const stops: Array<() => Promise<void>> = [];

	for (const pattern of patterns) {
		const stop = await control.captureScripts({ urlPattern: pattern }, async (cap) => {
			const slug = urlSlug(cap.url);
			const path = join(dumpDir, `${Date.now()}_${slug}.js`);
			const body = cap.base64Encoded ? Buffer.from(cap.body, 'base64').toString('utf8') : cap.body;
			try {
				writeFileSync(path, body);
				session.captured.push({
					url: cap.url,
					size: body.length,
					path,
					status: cap.responseStatusCode,
				});
			} catch (err) {
				/* drop */
			}
		});
		stops.push(stop);
	}

	session.stop = async () => {
		for (const s of stops) await s().catch(() => {});
	};
	sessions.set(tag, session);
	return { ok: true, tag, dumpDir, patterns };
}

export function getBundleCapture(tag: string): CaptureSession | null {
	return sessions.get(tag) ?? null;
}

export async function stopBundleCapture(tag: string): Promise<{ ok: boolean; error?: string }> {
	const s = sessions.get(tag);
	if (!s) return { ok: false, error: `No capture for tag ${tag}` };
	await s.stop();
	sessions.delete(tag);
	return { ok: true };
}
