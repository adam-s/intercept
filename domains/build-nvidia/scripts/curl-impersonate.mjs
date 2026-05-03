/**
 * Tiny fetch-shaped wrapper around curl-impersonate (Chrome 145 build).
 *
 * Why: Bun/Node fetch uses BoringSSL/OpenSSL with their own TLS parameters;
 * the JA3/JA4 fingerprint we send does NOT match a real Chrome. Cloudflare
 * (which fronts api.hcaptcha.com) explicitly fingerprints TLS handshakes
 * via JA3/JA4 + http/2 frame ordering. curl-impersonate replays the EXACT
 * Chrome 145 client hello + h2 settings, so the connection looks like a
 * real Chrome to anti-bot middleware.
 *
 * Returns a Response-shaped object with `status`, `headers`, `setCookies`,
 * `arrayBuffer()`, and `text()`. Body input may be a Uint8Array, Buffer,
 * or string.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CURL = '/tmp/curl-impersonate/curl_chrome145';

export async function curlImpersonate(url, opts = {}) {
	const method = (opts.method || 'GET').toUpperCase();
	const headers = opts.headers || {};
	const body = opts.body; // Uint8Array | Buffer | string | undefined

	const tmp = mkdtempSync(path.join(tmpdir(), 'curlimp-'));
	const headerFile = path.join(tmp, 'headers.txt');
	const bodyOutFile = path.join(tmp, 'body.bin');
	let bodyInFile = null;

	const args = [
		url,
		'-s', // silent (no progress)
		'-X',
		method,
		'-D',
		headerFile, // dump headers separately
		'-o',
		bodyOutFile, // body to file
	];

	for (const [k, v] of Object.entries(headers)) {
		args.push('-H', `${k}: ${v}`);
	}

	if (body !== undefined && body !== null) {
		bodyInFile = path.join(tmp, 'in.bin');
		const buf = Buffer.isBuffer(body)
			? body
			: body instanceof Uint8Array
				? Buffer.from(body)
				: Buffer.from(String(body), 'utf8');
		writeFileSync(bodyInFile, buf);
		args.push('--data-binary', `@${bodyInFile}`);
	}

	if (opts.cookieJar) {
		args.push('-b', opts.cookieJar, '-c', opts.cookieJar);
	}

	await new Promise((resolve, reject) => {
		const child = spawn(CURL, args);
		let stderr = '';
		child.stderr.on('data', (d) => {
			stderr += d;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0 && stderr) reject(new Error(`curl exit ${code}: ${stderr.slice(0, 400)}`));
			else resolve();
		});
	});

	const headerText = readFileSync(headerFile, 'utf8');
	const bodyBuf = readFileSync(bodyOutFile);

	// Parse status + headers
	const lines = headerText.split(/\r?\n/);
	const statusLine = lines.shift() || '';
	const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
	const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
	const responseHeaders = new Map();
	const setCookies = [];
	for (const line of lines) {
		if (!line) continue;
		const i = line.indexOf(':');
		if (i < 0) continue;
		const name = line.slice(0, i).trim().toLowerCase();
		const value = line.slice(i + 1).trim();
		if (name === 'set-cookie') setCookies.push(value);
		else responseHeaders.set(name, value);
	}

	// Cleanup
	try {
		unlinkSync(headerFile);
	} catch {}
	try {
		unlinkSync(bodyOutFile);
	} catch {}
	if (bodyInFile)
		try {
			unlinkSync(bodyInFile);
		} catch {}

	return {
		status,
		headers: responseHeaders,
		setCookies,
		_buf: bodyBuf,
		arrayBuffer: async () =>
			bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength),
		text: async () => bodyBuf.toString('utf8'),
		bytes: () => new Uint8Array(bodyBuf.buffer, bodyBuf.byteOffset, bodyBuf.byteLength),
	};
}
