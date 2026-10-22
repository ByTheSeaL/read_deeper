#!/usr/bin/env node
/*
 * Runs a scripted series of lookups against OpenRouter using the extension's
 * own prompt-building and reply-parsing code, so you can see channel choice,
 * continuity and answer quality before touching either client.
 *
 *   OPENROUTER_API_KEY=… node scripts/try_prompt.mjs [model] [--words 80] [--effort low]
 */

import {
	DEFAULT_SETTINGS,
	ReplyParser,
	SseReader,
	addLookup,
	buildLookupMessage,
	emptyData,
	ensureChannel,
	gistOf,
	lookupMessages,
	pinnedChannel,
	requestBody,
	systemPromptFor
} from "../chrome-extension/lib/core.js";
import { DEFAULT_SYSTEM_PROMPT } from "../chrome-extension/lib/prompt.js";

const args     = process.argv.slice(2);
const flag     = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const model    = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) || DEFAULT_SETTINGS.model;
const apiKey   = process.env.OPENROUTER_API_KEY;
const settings = { ...DEFAULT_SETTINGS, apiKey, model, targetWords: Number(flag("--words", 80)), reasoningEffort: flag("--effort", "low") };

if (!apiKey) {
	console.error("Set OPENROUTER_API_KEY first.");
	process.exit(1);
}

const HOUR = 3600_000;
const DAY  = 24 * HOUR;
const t0   = Date.UTC(2026, 9, 1, 9);

const PYTHON_DOC = { sourceUrl: "https://docs.python.org/3/library/functools.html", sourceTitle: "functools — Higher-order functions" };
const JOURNAL    = { sourceUrl: "https://journal.example/acute-mi", sourceTitle: "Management of acute myocardial infarction" };
const KANT       = { sourceUrl: "", sourceTitle: "Critique of Pure Reason" };

// Each step: a lookup and what we hope happens. Times move forward so
// "come back tomorrow" really is tomorrow.
const STEPS = [
	{ at: t0, text: "decorator", context: "A decorator is a function returning another function, usually applied as a function transformation using the @wrapper syntax.", ...PYTHON_DOC, expect: "new Python-ish channel" },
	{ at: t0 + 2 * 60_000, text: "functools.wraps", context: "This is a convenience function for invoking update_wrapper() as a function decorator when defining a wrapper function.", ...PYTHON_DOC, expect: "same channel, builds on 'decorator'" },
	{ at: t0 + 4 * 60_000, text: "__wrapped__", context: "the wrapper function gains a __wrapped__ attribute that refers to the function being wrapped.", ...PYTHON_DOC, expect: "same channel" },
	{ at: t0 + 1 * HOUR, text: "ischemia", context: "Prolonged ischemia leads to irreversible myocyte necrosis within 20–40 minutes.", ...JOURNAL, expect: "new medical channel" },
	{ at: t0 + 1 * HOUR + 3 * 60_000, text: "troponin", context: "High-sensitivity troponin assays allow earlier rule-out of MI.", ...JOURNAL, expect: "same medical channel" },
	{ at: t0 + 3 * HOUR, text: "Thoughts without content are empty, intuitions without concepts are blind.", context: "", ...KANT, expect: "new philosophy channel; paraphrase" },
	{ at: t0 + DAY + 2 * HOUR, text: "asyncio.gather", context: "Run awaitable objects in the aws sequence concurrently.", sourceUrl: "https://docs.python.org/3/library/asyncio-task.html", sourceTitle: "Coroutines and Tasks", expect: "back to the Python channel a day later" },
	{ at: t0 + DAY + 3 * HOUR, text: "kernel", context: "The kernel schedules processes and mediates access to hardware.", sourceUrl: "https://os.example/intro", sourceTitle: "Operating Systems: Three Easy Pieces", expect: "OS channel, not ML/maths sense" }
];

async function complete(messages) {
	const started  = Date.now();
	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method  : "POST",
		headers : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Read Deeper (prompt test)" },
		body    : JSON.stringify({ ...requestBody(settings, messages), usage: { include: true } })
	});

	if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);

	const parser = new ReplyParser();
	const sse    = new SseReader();
	const reader = response.body.getReader();
	const decode = new TextDecoder();
	let firstAt  = null;
	let usage    = null;

	while (!sse.done) {
		const { value, done } = await reader.read();

		if (done) break;

		const text = decode.decode(value, { stream: true });

		// Pick the usage block out of the final event without a second parser.
		const usageMatch = text.match(/"usage":(\{[^{}]*(\{[^{}]*\}[^{}]*)*\})/);

		if (usageMatch) {
			try { usage = JSON.parse(usageMatch[1]); } catch { /* partial */ }
		}

		const { deltas, error } = sse.push(text);

		if (error) throw new Error(error);

		for (const delta of deltas) {
			if (firstAt === null) firstAt = Date.now();
			parser.push(delta);
		}
	}

	parser.finish();

	return { parser, finishReason: sse.finishReason, firstMs: firstAt && firstAt - started, totalMs: Date.now() - started, usage };
}

const data   = emptyData();
const system = systemPromptFor(settings, DEFAULT_SYSTEM_PROMPT);
let totalCost = 0;

console.log(`Model: ${model} · target ${settings.targetWords} words · reasoning ${settings.reasoningEffort}\n`);

for (const step of STEPS) {
	const pinned = pinnedChannel(data);
	const prompt = buildLookupMessage({ query: step, data, forcedChannel: pinned && pinned.name, rosterSize: settings.rosterSize, now: step.at });
	const result = await complete(lookupMessages(system, prompt));
	const text   = result.parser.text.trim();
	const name   = result.parser.channel || "(none)";
	const words  = text.split(/\s+/).filter(Boolean).length;
	const cost   = result.usage && result.usage.cost;

	if (cost) totalCost += cost;

	console.log(`━━ ${step.text}`);
	console.log(`   expect: ${step.expect}`);
	console.log(`   CHANNEL: ${name} · ${words} words · first text ${result.firstMs ?? "-"} ms · done ${result.totalMs} ms · finish ${result.finishReason}${cost ? ` · $${cost.toFixed(5)}` : ""}`);
	console.log(`   gist: ${gistOf(text)}`);
	console.log(text.split("\n").map((l) => `   │ ${l}`).join("\n"));
	console.log();

	if (text) {
		const channel = ensureChannel(data, result.parser.channel || "General", step.at);

		channel.lastUsedAt = step.at;
		addLookup(data, { id: String(step.at), ...step, channelId: channel.id, explanation: text, gist: gistOf(text), createdAt: step.at }, 1000);
	}
}

console.log(`Channels: ${data.channels.map((c) => `${c.name} (${data.lookups.filter((l) => l.channelId === c.id).length})`).join(", ")}`);
if (totalCost) console.log(`Total cost: $${totalCost.toFixed(5)}`);
