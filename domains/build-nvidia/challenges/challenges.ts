/**
 * Challenge definitions for the ChatGPT proxy harness.
 *
 * Each challenge has:
 *   - id: unique identifier
 *   - name: display name
 *   - dir: directory under domains/chatgpt/challenges/
 *   - files: list of input files to copy into the work dir
 *   - solution: filename that the LLM must produce
 *   - testCmd: command to run to verify the solution
 *   - prompt: what to send to the LLM
 */

export interface ChallengeDefinition {
	id: string;
	name: string;
	dir: string;
	/** Files relative to dir that must exist in the work directory */
	files: string[];
	/** Filename of the solution the LLM must write */
	solution: string;
	/** Shell command to run the test from inside the work directory */
	testCmd: string;
	/** The prompt sent to ChatGPT (may reference file content) */
	buildPrompt: (fileContents: Record<string, string>) => string;
}

export const CHALLENGES: ChallengeDefinition[] = [
	{
		id: '1-sqlite-windows',
		name: 'SQLite Window Functions',
		dir: '1-sqlite-windows',
		files: ['seed.sql'],
		solution: 'queries.js',
		testCmd: 'node --input-type=module < test.js',
		buildPrompt: ({ 'seed.sql': seed }) =>
			`
You are an expert SQLite developer. Solve this programming challenge precisely.

TASK: Write a Node.js file called queries.js that:
1. Reads seed.sql (already present in the same directory)
2. Creates an in-memory SQLite database using the better-sqlite3 package
3. Seeds the database by running the SQL from seed.sql
4. Runs EXACTLY these 5 window function queries and collects results
5. Outputs a single JSON object to stdout with keys: running_total, rank_customers, prev_order, moving_avg, pct_of_total

REQUIRED QUERIES (in this exact order):
1. running_total: SELECT id, customer_id, order_date, amount, SUM(amount) OVER (PARTITION BY customer_id ORDER BY order_date) AS running_total FROM orders ORDER BY customer_id, order_date
2. rank_customers: SELECT customer_id, SUM(amount) AS total_spend, RANK() OVER (ORDER BY SUM(amount) DESC) AS rank FROM orders GROUP BY customer_id ORDER BY rank
3. prev_order: SELECT id, customer_id, order_date, amount, LAG(amount) OVER (PARTITION BY customer_id ORDER BY order_date) AS prev_amount FROM orders ORDER BY customer_id, order_date
4. moving_avg: SELECT id, customer_id, order_date, amount, ROUND(AVG(amount) OVER (PARTITION BY customer_id ORDER BY order_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS moving_avg FROM orders ORDER BY customer_id, order_date
5. pct_of_total: SELECT id, customer_id, order_date, amount, ROUND(amount * 100.0 / SUM(amount) OVER (PARTITION BY customer_id), 2) AS pct_of_total FROM orders ORDER BY customer_id, order_date

IMPORTANT CONSTRAINTS:
- The file must be valid ESM (import/export), not CommonJS
- Use: import Database from 'better-sqlite3'; import { readFileSync } from 'fs';
- Output ONLY the JSON to stdout, nothing else
- The JSON must be a single object: { running_total: [...], rank_customers: [...], prev_order: [...], moving_avg: [...], pct_of_total: [...] }
- Do NOT include any console.log except the final JSON.stringify output

Here is the seed.sql schema for reference:
\`\`\`sql
${seed}
\`\`\`

Write ONLY the queries.js file content. No explanation, no markdown fencing, just the raw JavaScript code starting with the import statements.
`.trim(),
	},
	{
		id: '2-hono-websocket',
		name: 'Hono + Bun WebSocket Counter',
		dir: '2-hono-websocket',
		files: [],
		solution: 'server.ts',
		testCmd:
			'bun server.ts &>/dev/null & SERVER_PID=$!; sleep 2; node test.js; TEST_EXIT=$?; kill $SERVER_PID 2>/dev/null; exit $TEST_EXIT',
		buildPrompt: () =>
			`
You are an expert Bun/TypeScript developer. Solve this programming challenge precisely.

TASK: Write a Bun + Hono WebSocket server called server.ts that:
1. Listens on port 3456 (use process.env.TEST_PORT if set, otherwise 3456)
2. Serves an HTML page at GET / that includes a <button> and a counter display element
3. Handles WebSocket connections at ws://localhost:3456/ws
4. Maintains a global counter (starts at 0)
5. When a client sends 'inc', increments the counter
6. When a client sends 'dec', decrements the counter
7. After any change, broadcasts { count: <current_count> } as JSON to ALL connected clients

IMPORTANT CONSTRAINTS:
- Use Hono with Bun's built-in WebSocket support: import { Hono } from 'hono'; import { createBunWebSocket } from 'hono/bun';
- The server must handle multiple simultaneous WebSocket connections
- Broadcasts must reach ALL clients including the one who sent the message
- The HTML page must literally include a <button> element and a counter element (test checks HTML)
- Use: const { upgradeWebSocket, websocket } = createBunWebSocket();
- Export default: Bun.serve({ fetch: app.fetch, websocket, port: PORT })

EXAMPLE STRUCTURE:
\`\`\`typescript
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerType>();

const app = new Hono();
let count = 0;
const clients = new Set<WSContext>();

app.get('/', (c) => c.html(\`<button>Click</button><span id="counter">\${count}</span>\`));
app.get('/ws', upgradeWebSocket(() => ({
  onOpen(_, ws) { clients.add(ws); },
  onMessage(event, _) {
    if (event.data === 'inc') count++;
    if (event.data === 'dec') count--;
    for (const client of clients) client.send(JSON.stringify({ count }));
  },
  onClose(_, ws) { clients.delete(ws); }
})));

export default Bun.serve({ fetch: app.fetch, websocket, port: 3456 });
\`\`\`

Write ONLY the server.ts file content. No explanation, no markdown, just raw TypeScript starting with the imports.
`.trim(),
	},
	{
		id: '3-csv-reporter',
		name: 'Python CSV Reporter',
		dir: '3-csv-reporter',
		files: ['data/sales.csv'],
		solution: 'report.py',
		testCmd: 'python3 test.py',
		buildPrompt: ({ 'data/sales.csv': csv }) =>
			`
You are an expert Python developer. Solve this programming challenge precisely.

TASK: Write a Python script called report.py that:
1. Reads the file data/sales.csv (relative path from script location)
2. Computes and prints a sales report with EXACTLY these 5 statistics:

REQUIRED OUTPUT (all 5 must appear in stdout):
1. Total Revenue: $22015.00 (the sum must appear as "$22015.00" or "$22,015.00")
2. Top 3 products by units: Widget A (275 units), Widget B (126 units), Widget C (75 units)
   - Output must contain "Widget A" and "275", "Widget B" and "126", "Widget C" and "75"
3. Revenue by region: North $9355, East $4290, South $4240, West $4130
   - Output must contain "North" and "9355", "East" and "4290", "South" and "4240", "West" and "4130"
4. Highest revenue month: 2024-05 with $4315.00
   - Output must contain "2024-05" and "4315"
5. Highest average order value product: Widget D at $585.00
   - Output must contain "Widget D" and "585"

The CSV columns are: date, product, region, units, revenue

Here is the first few rows of the CSV:
\`\`\`
${csv.split('\n').slice(0, 10).join('\n')}
\`\`\`

CONSTRAINTS:
- Use only Python standard library (csv, collections, etc.) — no pandas/numpy
- The script must run with: python3 report.py
- Print output to stdout

Write ONLY the report.py file content. No explanation, no markdown, just raw Python starting with imports.
`.trim(),
	},
];
