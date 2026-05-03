/**
 * Model metadata enrichment for the public /v1/models surface.
 *
 * The catalog from `api.ngc.nvidia.com/.../search/catalog/resources/ENDPOINT`
 * gives us 164 models with messy labels — same concept under multiple
 * spellings ("chat" + "Chat", "reasoning" + "Reasoning"), partner-cloud
 * brand markers mixed with capability tags. This module:
 *
 *   1. Normalizes labels into a canonical lowercase set.
 *   2. Infers a single modality (chat/image/embedding/audio/video/etc.).
 *   3. Extracts capability flags (tool_calling, reasoning, vision, ...).
 *   4. Emits a parameter manifest sized to the modality (so an agent can
 *      validate inputs before calling).
 *
 * Parameter manifests are conservative defaults based on what the
 * playground's request body uses. Per-model fine-tuning lives in the
 * upstream OpenAPI spec at /models/:vendor/:slug/spec — we don't fetch
 * those eagerly (164 round-trips), but the spec route is one hop away
 * if an agent wants the exact validated schema.
 *
 * @module domain-build-nvidia/model-metadata
 */

export type Modality =
	| 'chat'
	| 'embedding'
	| 'image'
	| 'video'
	| 'audio_transcription'
	| 'audio_speech'
	| 'vision'
	| 'safety'
	| 'biology'
	| 'retrieval'
	| 'unknown';

export interface ParameterSpec {
	type: 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object';
	default?: number | string | boolean;
	min?: number;
	max?: number;
	enum?: readonly string[];
	description?: string;
}

export interface ModelCapabilities {
	streaming: boolean;
	tool_calling: boolean;
	vision: boolean;
	reasoning: boolean;
	json_mode: boolean;
	multilingual: boolean;
	long_context: boolean;
	coding: boolean;
	guest_access: boolean;
	preview: boolean;
}

export interface EnrichedModel {
	/** Full ID: `<provider>/<vendor>/<slug>` — what /v1/chat/completions etc. accept. */
	id: string;
	provider: 'nvidia';
	vendor: string;
	slug: string;
	display_name: string;
	description: string;
	modality: Modality;
	capabilities: ModelCapabilities;
	parameters: Record<string, ParameterSpec>;
	endpoints: Record<string, string>;
	/** Original labels from the catalog, deduped + lowercased. */
	tags: string[];
	/** Logo URL or null. */
	logo: string | null;
	/** OpenAI-compat fields (so the openai SDK's models.list() works untouched). */
	object: 'model';
	created: number;
	owned_by: string;
}

/** Catalog summary shape — output of summarizeResource(). */
export interface CatalogSummary {
	slug: string;
	publisher: string | null;
	displayName: string;
	description: string;
	labels: string[];
	logo: string | null;
	available: boolean;
	preview: boolean;
	guestAccess: boolean;
	dateCreated: string;
}

// ─── Modality inference ────────────────────────────────────────────────

/** Modality decision is order-sensitive: more specific labels win first. */
const MODALITY_RULES: Array<{ modality: Modality; match: RegExp }> = [
	{ modality: 'audio_transcription', match: /\b(asr|speech[ -]?to[ -]?text|riva)\b/i },
	{ modality: 'audio_speech', match: /\b(text[ -]?to[ -]?speech|tts)\b/i },
	{ modality: 'video', match: /\bvideo\b/i },
	{ modality: 'image', match: /\b(text[ -]?to[ -]?image|image[ -]?generation|image[ -]?edit)\b/i },
	{ modality: 'embedding', match: /\b(text[ -]?to[ -]?embedding|embedding|nemo retriever|retriever)\b/i },
	{ modality: 'safety', match: /\b(safety|moderation|guardrails?)\b/i },
	{ modality: 'biology', match: /\b(bionemo|drug discovery|biology|protein)\b/i },
	{ modality: 'retrieval', match: /\b(retrieval augmented|rag|reranking)\b/i },
	{ modality: 'vision', match: /\b(object detection|chart detection|table detection|ocr|visual qa|image[ -]?to[ -]?text)\b/i },
	{ modality: 'chat', match: /\b(chat|conversational|language generation|text[ -]?to[ -]?text)\b/i },
];

export function inferModality(labels: readonly string[]): Modality {
	const joined = labels.join(' | ');
	for (const rule of MODALITY_RULES) {
		if (rule.match.test(joined)) return rule.modality;
	}
	return 'unknown';
}

// ─── Capabilities ─────────────────────────────────────────────────────

const CAP_RULES: Array<[keyof ModelCapabilities, RegExp]> = [
	['tool_calling', /\btool[ -]?calling\b/i],
	['reasoning', /\b(reasoning|advanced reasoning|thinking)\b/i],
	['vision', /\b(vision|visual qa|image[ -]?to[ -]?text|multimodal)\b/i],
	['json_mode', /\b(json[ -]?mode|structured output)\b/i],
	['multilingual', /\bmultilingual\b/i],
	['long_context', /\b(long[ -]?context|128k|256k|1m context)\b/i],
	['coding', /\b(coding|code generation|agentic coding)\b/i],
];

export function inferCapabilities(labels: readonly string[], catalog: CatalogSummary): ModelCapabilities {
	const joined = labels.join(' | ');
	const caps: ModelCapabilities = {
		streaming: true, // all chat/SSE NIM endpoints stream
		tool_calling: false,
		vision: false,
		reasoning: false,
		json_mode: false,
		multilingual: false,
		long_context: false,
		coding: false,
		guest_access: catalog.guestAccess,
		preview: catalog.preview,
	};
	for (const [key, re] of CAP_RULES) caps[key] = re.test(joined);
	return caps;
}

// ─── Parameter manifests ─────────────────────────────────────────────

/** OpenAI-style chat parameters. The playground uses these defaults. */
const CHAT_PARAMETERS: Record<string, ParameterSpec> = {
	temperature: {
		type: 'number',
		default: 1,
		min: 0,
		max: 2,
		description: 'Higher = more random. 0 = deterministic.',
	},
	top_p: {
		type: 'number',
		default: 1,
		min: 0,
		max: 1,
		description: 'Nucleus sampling. Use this OR temperature, not both.',
	},
	max_tokens: {
		type: 'integer',
		default: 4096,
		min: 1,
		max: 16384,
		description: 'Maximum output tokens. Per-model ceilings vary; see /models/:vendor/:slug/spec.',
	},
	presence_penalty: { type: 'number', default: 0, min: -2, max: 2 },
	frequency_penalty: { type: 'number', default: 0, min: -2, max: 2 },
	stream: { type: 'boolean', default: true },
};

/** Reasoning models add reasoning_effort; everything else inherits CHAT. */
const REASONING_PARAMETERS: Record<string, ParameterSpec> = {
	...CHAT_PARAMETERS,
	reasoning_effort: {
		type: 'string',
		default: 'medium',
		enum: ['low', 'medium', 'high'],
		description: 'How much intermediate reasoning the model produces. Higher = better quality, more tokens, slower.',
	},
};

const EMBEDDING_PARAMETERS: Record<string, ParameterSpec> = {
	encoding_format: { type: 'string', default: 'float', enum: ['float', 'base64'] },
	dimensions: { type: 'integer', description: 'Optional output dimensionality (model-dependent).' },
	input_type: { type: 'string', enum: ['query', 'passage'], description: 'NVIDIA NIM convention — query for search inputs, passage for documents.' },
};

const IMAGE_PARAMETERS: Record<string, ParameterSpec> = {
	prompt: { type: 'string', description: 'Required: textual description of the image to generate.' },
	negative_prompt: { type: 'string' },
	width: { type: 'integer', default: 1024, min: 256, max: 2048 },
	height: { type: 'integer', default: 1024, min: 256, max: 2048 },
	num_inference_steps: { type: 'integer', default: 30, min: 1, max: 100 },
	guidance_scale: { type: 'number', default: 7.5, min: 0, max: 20 },
	seed: { type: 'integer' },
};

const AUDIO_TRANSCRIPTION_PARAMETERS: Record<string, ParameterSpec> = {
	audio: { type: 'string', description: 'Base64-encoded audio bytes or remote URL.' },
	language: { type: 'string', description: 'ISO-639-1 code; "auto" for detection.' },
};

const AUDIO_SPEECH_PARAMETERS: Record<string, ParameterSpec> = {
	input: { type: 'string', description: 'Required: text to synthesize.' },
	voice: { type: 'string', description: 'Per-model voice ID; see model spec.' },
	response_format: { type: 'string', default: 'wav', enum: ['wav', 'mp3', 'opus', 'flac'] },
	speed: { type: 'number', default: 1, min: 0.25, max: 4 },
};

export function defaultParameters(modality: Modality, capabilities: ModelCapabilities): Record<string, ParameterSpec> {
	switch (modality) {
		case 'chat':
		case 'vision':
			return capabilities.reasoning ? REASONING_PARAMETERS : CHAT_PARAMETERS;
		case 'embedding':
			return EMBEDDING_PARAMETERS;
		case 'image':
			return IMAGE_PARAMETERS;
		case 'audio_transcription':
			return AUDIO_TRANSCRIPTION_PARAMETERS;
		case 'audio_speech':
			return AUDIO_SPEECH_PARAMETERS;
		default:
			return {}; // unknown modalities: agent uses /v1/raw and consults the upstream spec
	}
}

// ─── Endpoint mapping ────────────────────────────────────────────────

/** Which /v1/* endpoints support which modality. */
export function endpointsForModality(modality: Modality): Record<string, string> {
	const ep: Record<string, string> = { mint: '/v1/mint', raw: '/v1/raw' };
	switch (modality) {
		case 'chat':
		case 'vision':
			ep.chat = '/v1/chat/completions';
			break;
		case 'embedding':
			ep.embeddings = '/v1/embeddings';
			break;
		case 'image':
			ep.images = '/v1/images/generations';
			break;
		case 'audio_transcription':
			ep.transcriptions = '/v1/audio/transcriptions';
			break;
		case 'audio_speech':
			ep.speech = '/v1/audio/speech';
			break;
	}
	return ep;
}

// ─── ID parsing ───────────────────────────────────────────────────────

export interface ParsedModelId {
	provider: 'nvidia';
	vendor: string;
	slug: string;
}

/**
 * Accept both `nvidia/<vendor>/<slug>` (new full form) and bare
 * `<vendor>/<slug>` (back-compat with /chat/completions/browserless callers).
 * Throws on malformed.
 */
export function parseModelId(id: string): ParsedModelId {
	const parts = id.split('/');
	if (parts.length === 3) {
		const [provider, vendor, slug] = parts as [string, string, string];
		if (provider !== 'nvidia') {
			throw new Error(`Unknown provider '${provider}'. Expected 'nvidia/<vendor>/<slug>'.`);
		}
		if (!vendor || !slug) throw new Error(`Malformed model id: '${id}'`);
		return { provider: 'nvidia', vendor, slug };
	}
	if (parts.length === 2) {
		const [vendor, slug] = parts as [string, string];
		if (!vendor || !slug) throw new Error(`Malformed model id: '${id}'`);
		return { provider: 'nvidia', vendor, slug };
	}
	throw new Error(
		`Malformed model id: '${id}'. Expected 'nvidia/<vendor>/<slug>' or '<vendor>/<slug>'.`,
	);
}

/** Build the bare upstream slug expected by NVIDIA's predict URL. */
export function upstreamSlug(parsed: ParsedModelId): string {
	return parsed.slug;
}

/** Build the bare-vendor-prefixed model ID expected by build.nvidia.com playground. */
export function playgroundPath(parsed: ParsedModelId): string {
	return `${parsed.vendor}/${parsed.slug}`;
}

// ─── Top-level enrichment ─────────────────────────────────────────────

export function enrichModel(catalog: CatalogSummary): EnrichedModel {
	const labels = catalog.labels.map((l) => l.trim()).filter(Boolean);
	const modality = inferModality(labels);
	const capabilities = inferCapabilities(labels, catalog);
	const id = `nvidia/${catalog.publisher ?? 'unknown'}/${catalog.slug}`;
	const tags = [...new Set(labels.map((l) => l.toLowerCase()))].sort();
	const created = Math.floor(new Date(catalog.dateCreated).getTime() / 1000);
	return {
		id,
		provider: 'nvidia',
		vendor: catalog.publisher ?? 'unknown',
		slug: catalog.slug,
		display_name: catalog.displayName,
		description: catalog.description,
		modality,
		capabilities,
		parameters: defaultParameters(modality, capabilities),
		endpoints: endpointsForModality(modality),
		tags,
		logo: catalog.logo,
		object: 'model',
		created: Number.isFinite(created) ? created : 0,
		owned_by: catalog.publisher ?? 'nvidia',
	};
}
