// Test suite for Hono + Bun WebSocket counter challenge.
// Run: node test.js (after starting the server)
// All 5 tests must pass.
//
// Before running: start your server, then run this test.
// Usage: bun run server.ts & sleep 2 && node test.js

const PORT = process.env.TEST_PORT || 3456;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
	if (condition) {
		console.log(`PASS: ${name}`);
		passed++;
	} else {
		console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
		failed++;
	}
}

// Test 1: Server responds on /
let html = '';
try {
	const resp = await fetch(`${BASE}/`);
	assert(resp.status === 200, 'Server responds on /', `status=${resp.status}`);
	html = await resp.text();
} catch (e) {
	console.log(`FAIL: Server not responding on ${BASE} — ${e.message}`);
	console.log('Make sure the server is running first.');
	process.exit(1);
}

// Test 2: HTML has button and counter
const htmlLower = html.toLowerCase();
assert(
	htmlLower.includes('<button') && (htmlLower.includes('count') || htmlLower.includes('counter')),
	'HTML has button and counter element',
	'Check your HTML includes <button> and a counter display',
);

// Tests 3-5: WebSocket functionality
try {
	const ws1 = new WebSocket(`ws://localhost:${PORT}/ws`);
	const ws2 = new WebSocket(`ws://localhost:${PORT}/ws`);

	await Promise.all([
		new Promise((resolve, reject) => {
			ws1.onopen = resolve;
			ws1.onerror = () => reject(new Error('ws1 failed to connect'));
			setTimeout(() => reject(new Error('ws1 connect timeout')), 5000);
		}),
		new Promise((resolve, reject) => {
			ws2.onopen = resolve;
			ws2.onerror = () => reject(new Error('ws2 failed to connect'));
			setTimeout(() => reject(new Error('ws2 connect timeout')), 5000);
		}),
	]);

	function nextMessage(ws, timeout = 5000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout')), timeout);
			ws.addEventListener('message', function handler(e) {
				clearTimeout(timer);
				ws.removeEventListener('message', handler);
				resolve(JSON.parse(e.data));
			});
		});
	}

	// Drain initial messages (some servers send state on connect)
	await Promise.all([
		nextMessage(ws1, 1000).catch(() => {}),
		nextMessage(ws2, 1000).catch(() => {}),
	]);

	// Test 3: inc works
	ws1.send('inc');
	const r1 = await nextMessage(ws1);
	assert(r1.count === 1, 'inc works', `expected count=1, got count=${r1.count}`);

	// Test 4: broadcast works (ws2 got the same update)
	const r2 = await nextMessage(ws2);
	assert(r2.count === 1, 'broadcast works', `expected count=1 on ws2, got count=${r2.count}`);

	// Test 5: dec works
	ws2.send('dec');
	const r3 = await nextMessage(ws1);
	assert(r3.count === 0, 'dec works', `expected count=0, got count=${r3.count}`);

	ws1.close();
	ws2.close();
} catch (e) {
	console.log(`FAIL: WebSocket error — ${e.message}`);
	failed += 3 - (passed - 2); // count remaining WS tests as failed
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
