/*
 * The only code that talks to OpenRouter. It runs in the service worker, where
 * the extension's host permission applies. A content script's fetch would be
 * subject to the page's own CSP.
 */

import { OPENROUTER_BASE, SseReader, describeHttpError, requestBody } from "./core.js";

const HEADERS = {
	"Content-Type" : "application/json",
	"HTTP-Referer" : "https://github.com/ByTheSeaL/read_deeper",
	"X-Title"      : "Read Deeper"
};

export class ApiError extends Error {}

/* Streams a chat completion, calling onDelta(text) per chunk. Resolves to { finishReason }. */
export async function streamChat(settings, messages, onDelta, signal) {
	let response;

	try {
		response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
			method  : "POST",
			headers : { ...HEADERS, Authorization: `Bearer ${settings.apiKey}` },
			body    : JSON.stringify(requestBody(settings, messages)),
			signal  : signal
		});
	} catch (error) {
		if (error.name === "AbortError") throw error;
		throw new ApiError("Couldn't reach OpenRouter. Are you offline?");
	}

	if (!response.ok) {
		throw new ApiError(describeHttpError(response.status, await response.text().catch(() => "")));
	}

	const reader  = response.body.getReader();
	const decoder = new TextDecoder();
	const sse     = new SseReader();

	while (!sse.done) {
		const { value, done } = await reader.read();

		if (done) break;

		const { deltas, error } = sse.push(decoder.decode(value, { stream: true }));

		for (const delta of deltas) onDelta(delta);

		if (error) throw new ApiError(error);
	}

	reader.cancel().catch(() => {});

	return { finishReason: sse.finishReason };
}

export async function checkKey(apiKey) {
	let response;

	try {
		response = await fetch(`${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
	} catch {
		throw new ApiError("Couldn't reach OpenRouter. Are you offline?");
	}

	if (!response.ok) {
		throw new ApiError(describeHttpError(response.status, await response.text().catch(() => "")));
	}

	return (await response.json()).data || {};
}

const MODEL_CACHE_KEY = "modelCache";
const MODEL_CACHE_MS  = 24 * 60 * 60 * 1000;

/* [{ id, name, prompt, completion }] with prices in dollars per million tokens. */
export async function listModels({ force = false } = {}) {
	const cached = (await chrome.storage.local.get(MODEL_CACHE_KEY))[MODEL_CACHE_KEY];

	if (!force && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_MS) {
		return cached.models;
	}

	const response = await fetch(`${OPENROUTER_BASE}/models`);

	if (!response.ok) {
		throw new ApiError(describeHttpError(response.status, ""));
	}

	const models = ((await response.json()).data || [])
		.map((m) => ({
			id         : m.id,
			name       : m.name || m.id,
			prompt     : perMillion(m.pricing && m.pricing.prompt),
			completion : perMillion(m.pricing && m.pricing.completion)
		}))
		.sort((a, b) => a.id.localeCompare(b.id));

	await chrome.storage.local.set({ [MODEL_CACHE_KEY]: { fetchedAt: Date.now(), models } });

	return models;
}

function perMillion(price) {
	const n = Number(price);

	return Number.isFinite(n) ? Math.round(n * 1e6 * 1000) / 1000 : null;
}
