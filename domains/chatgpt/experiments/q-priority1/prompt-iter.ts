/**
 * Iterative context engineering — measure how response length/quality
 * varies with prompt structure. Goal: find a prompt format that reliably
 * gets the anonymous ChatGPT to emit complete code for the SQLite
 * challenge.
 *
 * Each variant is run, response length captured, and we print what came
 * back. The harness re-uses the existing /v1/chat/completions endpoint.
 */

const API = 'http://localhost:3001';

interface Variant {
	name: string;
	prompt: string;
	model?: string;
}

async function ask(prompt: string, model = 'gpt-4o'): Promise<{ ms: number; content: string }> {
	const t0 = Date.now();
	const r = await fetch(`${API}/api/chatgpt/v1/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			stream: true,
		}),
	});
	const text = await r.text();
	let content = '';
	for (const line of text.split('\n')) {
		if (!line.startsWith('data: ')) continue;
		const payload = line.slice(6).trim();
		if (payload === '[DONE]') continue;
		try {
			const d = JSON.parse(payload) as {
				choices?: Array<{ delta?: { content?: string } }>;
			};
			const c = d.choices?.[0]?.delta?.content;
			if (c) content += c;
		} catch {
			/* ignore */
		}
	}
	return { ms: Date.now() - t0, content };
}

const variants: Variant[] = [
	// 1. Bare-minimum prompt — just ask for code
	{
		name: 'bare',
		prompt: 'Write a JavaScript function that adds two numbers.',
	},
	// 2. Bare with backticks
	{
		name: 'bare+fences',
		prompt: 'Write a JavaScript function that adds two numbers. Wrap in ```javascript fences.',
	},
	// 3. Multi-line code request
	{
		name: 'fizzbuzz',
		prompt:
			'Write FizzBuzz in JavaScript. 15 lines max. Just code in ```javascript fences, no commentary.',
	},
	// 4. Real coding task — short version
	{
		name: 'sqlite-short',
		prompt:
			'Write a complete Node.js ESM script (with imports) that uses better-sqlite3 to query a window function SUM(amount) OVER (PARTITION BY customer_id ORDER BY order_date) on an orders table read from seed.sql. Output JSON. Use ```javascript fences.',
	},
	// 5. Step-by-step decomposition
	{
		name: 'step-by-step',
		prompt: [
			'You are writing a Node.js ESM module called queries.js.',
			'',
			'Required imports:',
			"  import Database from 'better-sqlite3';",
			"  import { readFileSync } from 'node:fs';",
			'',
			'Required steps:',
			'1. Read seed.sql (already in cwd)',
			'2. Open in-memory db, exec(seedSql)',
			'3. Run: SELECT id, customer_id, order_date, amount, SUM(amount) OVER (PARTITION BY customer_id ORDER BY order_date) AS running_total FROM orders ORDER BY customer_id, order_date',
			'4. console.log(JSON.stringify({ running_total: rows }))',
			'',
			'Output: just the file content in a ```javascript code block. No prose.',
		].join('\n'),
	},
	// 6. Asking for confirmation / chain-of-thought-style
	{
		name: 'confirm',
		prompt:
			'I need a Node.js ESM file that runs a SQLite window function. Output ONLY the complete file inside one ```javascript block. The file should: (a) import better-sqlite3 and node:fs, (b) read seed.sql, (c) create in-memory db, (d) run SUM(amount) OVER (PARTITION BY customer_id ORDER BY order_date), (e) console.log JSON. Length: target 25-40 lines.',
	},
	// 7. Try with auto model
	{
		name: 'auto-model',
		prompt: 'Write FizzBuzz in JavaScript. Just the code in fences.',
		model: 'auto',
	},
	// 8. Empty system + spartan user
	{
		name: 'spartan',
		prompt: 'fizzbuzz js',
	},
];

(async () => {
	console.log('Variant'.padEnd(20), 'ms'.padEnd(8), 'len'.padEnd(6), 'preview');
	console.log('─'.repeat(100));
	for (const v of variants) {
		const { ms, content } = await ask(v.prompt, v.model);
		console.log(
			v.name.padEnd(20),
			String(ms).padEnd(8),
			String(content.length).padEnd(6),
			content.replace(/\n/g, ' ').slice(0, 60),
		);
		// Small pacing so we don't trigger rate limits
		await new Promise((r) => setTimeout(r, 1500));
	}
})();
