import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	ReplyParser,
	SseReader,
	buildLookupMessage,
	emptyData,
	exportFileName,
	ensureChannel,
	gistOf,
	isRefinement,
	lookupMarkdown,
	markdownToHtml,
	maxTokensFor,
	mergeChannels,
	moveLookup,
	reasoningFor,
	renameChannel,
	systemPromptFor,
	DEFAULT_SETTINGS
} from "../lib/core.js";
import { DEFAULT_SYSTEM_PROMPT } from "../lib/prompt.js";

process.env.TZ = "UTC";

const cases = JSON.parse(readFileSync(new URL("../../shared/test-cases.json", import.meta.url), "utf8"));

for (const c of cases.parse) {
	test(`parse: ${c.name}`, () => {
		const parser = new ReplyParser();
		let shown    = "";
		let channel  = null;

		for (const chunk of [...c.chunks.map((x) => parser.push(x)), parser.finish()]) {
			if (chunk.channel) channel = chunk.channel;
		}

		shown = parser.text;

		assert.equal(channel, c.channel);
		assert.equal(parser.channel, c.channel);
		assert.equal(shown, c.text);
	});
}

test("parse: deltas add up to the final text", () => {
	const parser = new ReplyParser();
	let visible  = "";

	for (const chunk of ["CHANNEL: Py", "thon\nOne ", "two ", "three."]) {
		const result = parser.push(chunk);

		if (result.delta) visible += result.delta;
	}

	assert.equal(visible, "One two three.");
	assert.equal(parser.text, "One two three.");
});

for (const c of cases.gist) {
	test(`gist: ${c.input.slice(0, 30)}`, () => assert.equal(gistOf(c.input), c.gist));
}

for (const c of cases.refinement) {
	test(`refinement: ${c.original} → ${c.updated}`, () => assert.equal(isRefinement(c.original, c.updated), c.expected));
}

for (const c of cases.lookupMessage) {
	test(`lookup message: ${c.name}`, () => {
		const message = buildLookupMessage({
			query         : c.query,
			data          : c.data,
			forcedChannel : c.forcedChannel,
			rosterSize    : c.rosterSize,
			now           : c.now
		});

		assert.equal(message, c.expected);
	});
}

test("system prompt fills the target length", () => {
	const prompt = systemPromptFor({ ...DEFAULT_SETTINGS, targetWords: 120 }, DEFAULT_SYSTEM_PROMPT);

	assert.match(prompt, /about 120 words/);
	assert.doesNotMatch(prompt, /\{\{/);
});

test("reasoning allowance and effort", () => {
	assert.equal(maxTokensFor({ targetWords: 80, reasoningEffort: "low" }), 1400);
	assert.equal(maxTokensFor({ targetWords: 80, reasoningEffort: "off" }), 400);
	assert.deepEqual(reasoningFor({ reasoningEffort: "off" }), { enabled: false });
	assert.deepEqual(reasoningFor({ reasoningEffort: "medium" }), { effort: "medium", exclude: true });
});

test("SSE reader handles split lines, keep-alives and DONE", () => {
	const sse   = new SseReader();
	const first = sse.push(": OPENROUTER PROCESSING\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\ndata: {\"choices\":[{\"del");
	const rest  = sse.push("ta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");

	assert.deepEqual(first.deltas, ["Hel"]);
	assert.deepEqual(rest.deltas, ["lo"]);
	assert.equal(sse.finishReason, "stop");
	assert.ok(sse.done);
});

test("SSE reader surfaces mid-stream errors", () => {
	const result = new SseReader().push("data: {\"error\":{\"message\":\"Provider overloaded\"}}\n");

	assert.equal(result.error, "Provider overloaded");
});

test("moving a misfiled lookup removes the channel it created and pins the new one", () => {
	const data   = emptyData();
	const snakes = ensureChannel(data, "Snakes", 1, "l1");

	data.lookups.push({ id: "l1", channelId: snakes.id, createdAt: 1 });

	const python = moveLookup(data, "l1", "Python", 2);

	assert.equal(data.lookups[0].channelId, python.id);
	assert.deepEqual(data.channels.map((c) => c.name), ["Python"]);
	assert.equal(data.pinnedChannelId, python.id);
});

test("renaming onto an existing name merges", () => {
	const data = emptyData();
	const a    = ensureChannel(data, "Python", 1);
	const b    = ensureChannel(data, "Python programming", 2);

	data.lookups.push({ id: "x", channelId: b.id, createdAt: 2 });
	renameChannel(data, b.id, "python", 3);

	assert.deepEqual(data.channels.map((c) => c.name), ["Python"]);
	assert.equal(data.lookups[0].channelId, a.id);
});

test("merge moves the pin", () => {
	const data = emptyData();
	const a    = ensureChannel(data, "A", 1);
	const b    = ensureChannel(data, "B", 1);

	data.pinnedChannelId = b.id;
	mergeChannels(data, b.id, a.id);

	assert.equal(data.pinnedChannelId, a.id);
});

test("markdown: code, bold, lists, escaping", () => {
	assert.equal(
		markdownToHtml("**Bold** and `a<b`\n\n- one\n- two\n\n```py\nx = 1 < 2\n```"),
		"<p><strong>Bold</strong> and <code>a&lt;b</code></p><ul><li>one</li><li>two</li></ul><pre><code>x = 1 &lt; 2</code></pre>"
	);
	assert.equal(markdownToHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
	assert.equal(markdownToHtml("snake_case_name and *em*"), "<p>snake_case_name and <em>em</em></p>");
	assert.equal(markdownToHtml("**`return_exceptions=True`** works"), "<p><strong><code>return_exceptions=True</code></strong> works</p>");
	assert.equal(markdownToHtml("`**not bold**`"), "<p><code>**not bold**</code></p>");
});

for (const c of cases.export) {
	test(`export: ${c.name}`, () => {
		assert.equal(exportFileName(c.lookup), c.fileName);
		assert.equal(lookupMarkdown(c.lookup, c.channel), c.markdown);
	});
}
