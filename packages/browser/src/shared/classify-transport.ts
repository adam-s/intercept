/**
 * Data Transport Classifier
 *
 * Implements the elimination protocol from .agents/rules/discovery.md
 * as executable code. Given captured traffic entries, returns the classified
 * transport type for each data pattern detected.
 *
 * Priority order (checked in this exact sequence):
 *   (a) WebSocket
 *   (b) GraphQL
 *   (c) gRPC-Web
 *   (d) Server-Sent Events
 *   (e) JSON API
 *   (f) Encoded API (base64, protobuf, msgpack, binary)
 *   (g) SSR / Document (only when a-f are empty)
 *
 * @module browser/shared/classify-transport
 */

/**
 * Transport types matching the elimination protocol.
 */
export type TransportType =
	| 'WEBSOCKET'
	| 'GRAPHQL'
	| 'GRPC_WEB'
	| 'SSE'
	| 'JSON_API'
	| 'EMBEDDED_JSON'
	| 'ENCODED_API'
	| 'SSR'
	| 'HYBRID'
	| 'UNKNOWN';

/**
 * Encoding subtypes for ENCODED_API transport.
 */
export type EncodingType = 'base64' | 'protobuf' | 'msgpack' | 'binary' | 'unknown';

/**
 * A single classified traffic entry.
 */
export interface TrafficClassification {
	/** The transport type detected */
	transport: TransportType;
	/** For ENCODED_API: the specific encoding */
	encoding?: EncodingType;
	/** The URL pattern that matched */
	url: string;
	/** HTTP method */
	method: string;
	/** Response content-type (if available) */
	contentType: string;
	/** Why this classification was chosen */
	evidence: string;
}

/**
 * Input traffic entry — matches the shape from the traffic capture buffer.
 */
export interface TrafficEntry {
	url: string;
	method: string;
	status: number;
	requestHeaders?: Record<string, string>;
	requestBody?: unknown;
	responseHeaders?: Record<string, string>;
	responseBody?: unknown;
}

/**
 * Overall classification result for a page.
 */
export interface PageClassification {
	/** All individual classifications */
	entries: TrafficClassification[];
	/** Summary: unique transport types found */
	transports: TransportType[];
	/** Is this a hybrid page? (SSR shell + XHR data) */
	isHybrid: boolean;
	/** Did we find any data-bearing traffic? */
	hasDataTraffic: boolean;
	/** Warnings or issues */
	warnings: string[];
}

/**
 * Classify a single traffic entry.
 */
export function classifyEntry(entry: TrafficEntry): TrafficClassification {
	const ct = getContentType(entry);
	const url = entry.url.toLowerCase();

	// (a) WebSocket — check URL scheme
	if (url.startsWith('wss://') || url.startsWith('ws://')) {
		return {
			transport: 'WEBSOCKET',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: 'URL uses ws:// or wss:// scheme',
		};
	}

	// (b) GraphQL — check URL path or request body
	if (isGraphQL(entry)) {
		return {
			transport: 'GRAPHQL',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: detectGraphQLEvidence(entry),
		};
	}

	// (c) gRPC-Web — check content-type
	if (ct.includes('application/grpc-web') || ct.includes('application/grpc')) {
		return {
			transport: 'GRPC_WEB',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: `Content-Type: ${ct}`,
		};
	}

	// (d) SSE — check content-type
	if (ct.includes('text/event-stream')) {
		return {
			transport: 'SSE',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: 'Content-Type: text/event-stream',
		};
	}

	// (e) JSON API — check if response is parseable JSON
	if (isJsonResponse(entry, ct)) {
		return {
			transport: 'JSON_API',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: 'Response is application/json with parseable body',
		};
	}

	// (f) Encoded API — non-JSON response body from XHR/Fetch
	const encoding = detectEncoding(entry, ct);
	if (encoding) {
		return {
			transport: 'ENCODED_API',
			encoding,
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: `Encoded response detected: ${encoding} (Content-Type: ${ct})`,
		};
	}

	// If we get here with a non-HTML response, it's still likely an API
	if (!ct.includes('text/html') && !ct.includes('text/css') && !ct.includes('image/')) {
		return {
			transport: 'ENCODED_API',
			encoding: 'unknown',
			url: entry.url,
			method: entry.method,
			contentType: ct,
			evidence: `Non-standard response type: ${ct}`,
		};
	}

	// Default: unknown (likely a page load, not data)
	return {
		transport: 'UNKNOWN',
		url: entry.url,
		method: entry.method,
		contentType: ct,
		evidence: 'Could not classify — likely a page navigation or static asset',
	};
}

/**
 * Classify all traffic for a page load.
 * Filters out known non-data traffic (analytics, tracking, static assets).
 */
export function classifyPage(
	entries: TrafficEntry[],
	options: { hasLoadingState?: boolean; waitTimeMs?: number } = {},
): PageClassification {
	const warnings: string[] = [];
	const filtered = filterDataEntries(entries);
	const classifications = filtered.map(classifyEntry);

	const transports = [...new Set(classifications.map((c) => c.transport))].filter(
		(t) => t !== 'UNKNOWN',
	);

	const hasDataTraffic = transports.length > 0;

	// Hybrid detection: if we see both SSR indicators and XHR data
	const hasXHR = transports.some((t) =>
		['JSON_API', 'GRAPHQL', 'ENCODED_API', 'WEBSOCKET', 'SSE', 'GRPC_WEB'].includes(t),
	);

	// If no data traffic was found, check for SSR
	if (!hasDataTraffic) {
		// Warn about potential missed traffic
		if (options.hasLoadingState) {
			warnings.push(
				'CRITICAL: Page showed a loading state but no XHR traffic was captured. ' +
					'The data likely loaded via XHR but the capture window was too short. ' +
					'Increase wait time and re-capture. DO NOT classify as SSR.',
			);
		}

		if ((options.waitTimeMs ?? 0) < 15000) {
			warnings.push(
				`Wait time was ${options.waitTimeMs ?? 0}ms (< 15s recommended). ` +
					'Some sites defer data loading. Increase wait time before classifying as SSR.',
			);
		}

		if (!options.hasLoadingState && (options.waitTimeMs ?? 0) >= 15000) {
			transports.push('SSR');
		}
	}

	const isHybrid = hasXHR && options.hasLoadingState === true;
	if (isHybrid && !transports.includes('HYBRID')) {
		transports.push('HYBRID');
	}

	return {
		entries: classifications,
		transports,
		isHybrid,
		hasDataTraffic,
		warnings,
	};
}

// --- Internal helpers ---

function getContentType(entry: TrafficEntry): string {
	const headers = entry.responseHeaders ?? {};
	return (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
}

function isGraphQL(entry: TrafficEntry): boolean {
	const url = entry.url.toLowerCase();
	// URL-based detection
	if (url.includes('/graphql') || url.includes('/gql')) return true;

	// Body-based detection (POST with query/mutation) — handles single and batched requests
	if (entry.method === 'POST' && entry.requestBody) {
		const bodies = Array.isArray(entry.requestBody) ? entry.requestBody : [entry.requestBody];
		for (const item of bodies) {
			if (item && typeof item === 'object') {
				const body = item as Record<string, unknown>;
				if (typeof body.query === 'string') {
					return (
						body.query.includes('{') ||
						body.query.includes('query') ||
						body.query.includes('mutation')
					);
				}
			}
		}
	}

	// Response-based detection (has data/errors shape)
	if (entry.responseBody && typeof entry.responseBody === 'object') {
		const resp = entry.responseBody as Record<string, unknown>;
		if ('data' in resp && (typeof resp.data === 'object' || 'errors' in resp)) {
			// Could be GraphQL — but also could be a regular API
			// Only flag if URL hints at GraphQL too
			if (url.includes('graph') || url.includes('gql')) return true;
		}
	}

	return false;
}

function detectGraphQLEvidence(entry: TrafficEntry): string {
	const url = entry.url.toLowerCase();
	if (url.includes('/graphql') || url.includes('/gql')) {
		return `GraphQL endpoint URL: ${entry.url}`;
	}
	if (entry.requestBody && typeof entry.requestBody === 'object') {
		const body = entry.requestBody as Record<string, unknown>;
		if (typeof body.query === 'string') {
			return `Request body contains GraphQL query: ${(body.query as string).slice(0, 100)}`;
		}
	}
	return 'GraphQL detected from response shape';
}

function isJsonResponse(entry: TrafficEntry, ct: string): boolean {
	if (ct.includes('application/json')) return true;

	// Some APIs don't set content-type but return valid JSON
	if (!ct && entry.responseBody !== undefined) {
		if (typeof entry.responseBody === 'object' && entry.responseBody !== null) return true;
	}

	return false;
}

function detectEncoding(entry: TrafficEntry, ct: string): EncodingType | null {
	// Protobuf
	if (
		ct.includes('application/x-protobuf') ||
		ct.includes('application/protobuf') ||
		ct.includes('application/proto')
	) {
		return 'protobuf';
	}

	// MessagePack
	if (ct.includes('application/x-msgpack') || ct.includes('application/msgpack')) {
		return 'msgpack';
	}

	// Base64 — octet-stream with base64-like content
	if (ct.includes('application/octet-stream')) {
		if (typeof entry.responseBody === 'string') {
			// Check if it looks like base64
			if (/^[A-Za-z0-9+/=]+$/.test(entry.responseBody.trim())) {
				return 'base64';
			}
		}
		return 'binary';
	}

	// Binary data with no clear type
	if (ct.includes('application/binary') || ct.includes('application/x-binary')) {
		return 'binary';
	}

	return null;
}

/**
 * Filter out known non-data traffic (analytics, tracking, static assets).
 */
function filterDataEntries(entries: TrafficEntry[]): TrafficEntry[] {
	const skipPatterns = [
		'google-analytics',
		'googletagmanager',
		'google.com/ccm',
		'googleadservices',
		'doubleclick.net',
		'facebook.com/tr',
		'connect.facebook.net',
		'segment.io',
		'segment.com',
		'sentry.io',
		'bugsnag.com',
		'hotjar.com',
		'fullstory.com',
		'amplitude.com',
		'mixpanel.com',
		'forter.com',
		'riskified.com',
		'branch.io',
		'adjust.com',
		'appsflyer.com',
		'fingerprintjs.com',
		'arkoselabs.com',
		'awswaf.com',
	];

	const skipExtensions = [
		'.js',
		'.mjs',
		'.css',
		'.png',
		'.jpg',
		'.jpeg',
		'.gif',
		'.svg',
		'.webp',
		'.woff',
		'.woff2',
		'.ttf',
		'.eot',
		'.ico',
		'.map',
	];

	return entries.filter((e) => {
		const url = e.url.toLowerCase();

		// Skip tracking/analytics
		if (skipPatterns.some((p) => url.includes(p))) return false;

		// Skip static assets
		const path = url.split('?')[0];
		if (skipExtensions.some((ext) => path.endsWith(ext))) return false;

		return true;
	});
}
