/**
 * Connect a browser to a URL via the API server's WebSocket endpoint.
 *
 * This is a helper for agents and scripts — it handles the WebSocket protocol
 * (binary JPEG frames, JSON control messages) and keeps the connection alive
 * in the background so traffic capture works via GET /browser/traffic.
 *
 * Usage: node scripts/connect-browser.cjs <port> <profile> <url> [timeout_seconds]
 *
 * Exits with code 0 once browser is ready, keeping the process alive.
 * Exits with code 1 on error or timeout.
 */

const WebSocket = require('ws');

const port = process.argv[2] || '3001';
const profile = process.argv[3] || 'generic';
const url = process.argv[4] || '';
const timeoutSec = parseInt(process.argv[5] || '60', 10);
const headed = process.argv[6] === 'headed';

const wsUrl = `ws://localhost:${port}/browser/stream?profile=${encodeURIComponent(profile)}${url ? `&url=${encodeURIComponent(url)}` : ''}${headed ? '&headless=false' : ''}`;

let ready = false;
let ws;

function log(msg) {
	const ts = new Date().toISOString().slice(11, 19);
	process.stderr.write(`[${ts}] ${msg}\n`);
}

// Timeout guard
const timer = setTimeout(() => {
	if (!ready) {
		log(`ERROR: Timed out after ${timeoutSec}s waiting for browser ready`);
		if (ws) ws.close();
		process.exit(1);
	}
}, timeoutSec * 1000);

try {
	ws = new WebSocket(wsUrl);
} catch (err) {
	log(`ERROR: Failed to create WebSocket connection: ${err.message}`);
	process.exit(1);
}

ws.on('open', () => {
	log(`Connected to ${wsUrl}`);
	log('Waiting for browser to be ready...');
});

ws.on('message', (data, isBinary) => {
	// Binary messages are JPEG screenshot frames — ignore them
	if (isBinary) return;

	try {
		const msg = JSON.parse(data.toString());

		if (msg.type === 'ready') {
			ready = true;
			clearTimeout(timer);
			const reused = msg.reused ? ' (reused existing session)' : '';
			log(`Browser ready!${reused} Profile: ${msg.profile || profile}`);
			// Print the signal line to stdout — this is what the shell script waits for
			console.log(`BROWSER_READY|${port}|${profile}`);
			console.log(
				`Browser connected. Capture traffic at: GET http://localhost:${port}/browser/traffic`,
			);
		} else if (msg.type === 'url') {
			log(`Page URL: ${msg.url}`);
		} else if (msg.type === 'error') {
			log(`ERROR from server: ${msg.message}`);
			if (!ready) {
				clearTimeout(timer);
				process.exit(1);
			}
		} else if (msg.type === 'crash') {
			log(`Browser CRASHED: ${msg.reason}`);
			clearTimeout(timer);
			process.exit(1);
		} else {
			log(`Server message: ${JSON.stringify(msg)}`);
		}
	} catch {
		// Not JSON — likely a binary frame that wasn't flagged. Ignore.
	}
});

ws.on('error', (err) => {
	if (err.code === 'ECONNREFUSED') {
		log(`ERROR: Connection refused on port ${port}. Is the API server running?`);
		log(`  Start it with: pnpm --filter @interceptor/api dev`);
	} else {
		log(`ERROR: WebSocket error: ${err.message}`);
	}
	clearTimeout(timer);
	process.exit(1);
});

ws.on('close', (code, reason) => {
	const reasonStr = reason ? reason.toString() : 'no reason';
	log(`WebSocket closed (code: ${code}, reason: ${reasonStr})`);
	if (!ready) {
		clearTimeout(timer);
		process.exit(1);
	}
	// If already ready and connection closes, the browser stays alive server-side.
	// But we exit since our job is done and agent can reconnect if needed.
	process.exit(0);
});

// Keep process alive — the WebSocket connection must stay open for traffic capture.
// The shell script runs this in the background.
process.on('SIGTERM', () => {
	log('Received SIGTERM, closing connection');
	if (ws) ws.close();
	process.exit(0);
});

process.on('SIGINT', () => {
	log('Received SIGINT, closing connection');
	if (ws) ws.close();
	process.exit(0);
});
