/*
 * Everything about a lookup that doesn't touch the browser: building the
 * request, reading the reply, and the channel bookkeeping. Kept free of
 * chrome.* so `node --test` can exercise it, and mirrored line for line by
 * the Android app's Core.kt, so both clients send the model the same thing.
 */

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const DEFAULT_SETTINGS = Object.freeze({
	apiKey          : "",
	model           : "z-ai/glm-5.3-flash",
	targetWords     : 80,
	reasoningEffort : "low",
	systemPrompt    : "",     // empty = the shared default
	sendContext     : true,
	rosterSize      : 12,
	historyLimit    : 1000
});

export const REASONING_EFFORTS = ["off", "low", "medium", "high"];

// The default model always reasons, and its hidden reasoning counts against
// max_tokens; without an allowance a short answer can come back empty.
const REASONING_ALLOWANCE = { off: 0, low: 1000, medium: 3000, high: 6000 };

export const ROSTER_LOOKUPS_PER_CHANNEL = 6;
export const PINNED_HISTORY             = 15;
export const SAME_SOURCE_WINDOW_MS      = 6 * 60 * 60 * 1000;
export const FALLBACK_CHANNEL           = "General";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Request ────────────────────────────────────────────────────────────────

export function systemPromptFor(settings, defaultPrompt) {
	const template = (settings.systemPrompt || "").trim() ? settings.systemPrompt : defaultPrompt;

	return template.split("{{target_words}}").join(String(settings.targetWords));
}

export function maxTokensFor(settings) {
	const visible   = Math.max(100, Math.round(settings.targetWords * 5));
	const reasoning = REASONING_ALLOWANCE[settings.reasoningEffort] ?? REASONING_ALLOWANCE.low;

	return visible + reasoning;
}

export function reasoningFor(settings) {
	if (settings.reasoningEffort === "off") {
		return { enabled: false };
	}

	// exclude: the reasoning still happens, it just isn't streamed back to us.
	return { effort: settings.reasoningEffort || "low", exclude: true };
}

export function requestBody(settings, messages) {
	return {
		model      : settings.model,
		messages   : messages,
		stream     : true,
		max_tokens : maxTokensFor(settings),
		reasoning  : reasoningFor(settings)
	};
}

export function relativeDay(ts, now) {
	const days = Math.floor(startOfDay(now) / DAY_MS) - Math.floor(startOfDay(ts) / DAY_MS);

	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 14) return `${days} days ago`;

	return new Date(ts).toISOString().slice(0, 10);
}

function startOfDay(ts) {
	const d = new Date(ts);

	return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

export function relativeTime(ts, now) {
	const minutes = Math.round((now - ts) / 60000);

	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

	const hours = Math.round(minutes / 60);

	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

	return relativeDay(ts, now);
}

export function normalizeUrl(url) {
	return (url || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

export function isSameSource(previous, current, now) {
	if (!previous || now - previous.createdAt > SAME_SOURCE_WINDOW_MS) {
		return false;
	}

	if (current.sourceUrl && normalizeUrl(previous.sourceUrl) === normalizeUrl(current.sourceUrl)) {
		return true;
	}

	return Boolean(current.sourceTitle) && previous.sourceTitle === current.sourceTitle;
}

/*
 * The user message for a new lookup. `forcedChannel` is set when the reader
 * has pinned a channel, or when re-explaining (which stays in the lookup's
 * channel); otherwise the model picks from the roster.
 */
export function buildLookupMessage({ query, data, forcedChannel, rosterSize, now, excludeLookupId }) {
	const lookups  = data.lookups.filter((l) => l.id !== excludeLookupId);
	const channels = [...data.channels].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
	const out      = ["## Channels", ""];

	const historyLines = (channel, limit) => lookups
		.filter((l) => l.channelId === channel.id)
		.slice(-limit)
		.map((l) => `- ${oneLine(l.text, 80)}: ${l.gist}`);

	if (forcedChannel) {
		const channel = findChannel(data, forcedChannel);
		const lines   = channel ? historyLines(channel, PINNED_HISTORY) : [];

		out.push(`The reader has pinned the channel "${forcedChannel}". Use exactly that name.`);
		out.push("");
		out.push(`### ${forcedChannel}`);
		out.push(...(lines.length ? lines : ["(nothing looked up here yet)"]));
	} else {
		const previous = lookups[lookups.length - 1];

		out.push("Choose the channel for this lookup.");

		if (previous) {
			const previousChannel = data.channels.find((c) => c.id === previous.channelId);
			const same            = isSameSource(previous, query, now);

			if (previousChannel) {
				out.push(
					`Previous lookup: channel "${previousChannel.name}", ${relativeTime(previous.createdAt, now)}` +
					(same ? ", from the same source as this one." : ", from a different source.")
				);
			}
		}

		const roster = channels
			.map((c) => ({ channel: c, lines: historyLines(c, ROSTER_LOOKUPS_PER_CHANNEL) }))
			.filter((entry) => entry.lines.length)
			.slice(0, rosterSize);

		if (!roster.length) {
			out.push("The reader has no channels yet.");
		}

		for (const { channel, lines } of roster) {
			out.push("");
			out.push(`### ${channel.name} (last used ${relativeDay(channel.lastUsedAt, now)})`);
			out.push(...lines);
		}
	}

	if (query.sourceTitle || query.sourceUrl) {
		out.push("", "## Source");
		if (query.sourceTitle) out.push(`Title: ${query.sourceTitle}`);
		if (query.sourceUrl) out.push(`URL: ${query.sourceUrl}`);
	}

	if (query.context && query.context.trim()) {
		out.push("", "## Surrounding text", query.context.trim());
	}

	out.push("", "## Look up", query.text.trim());

	return out.join("\n");
}

export function lookupMessages(systemPrompt, userMessage) {
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userMessage }
	];
}

export function followUpMessages(systemPrompt, lookup, channelName, question) {
	const messages = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: lookup.prompt },
		{ role: "assistant", content: `CHANNEL: ${channelName}\n\n${lookup.explanation}` }
	];

	for (const turn of lookup.thread || []) {
		messages.push({ role: "user", content: turn.q });
		messages.push({ role: "assistant", content: turn.a });
	}

	messages.push({ role: "user", content: question });

	return messages;
}

// ─── Reply ──────────────────────────────────────────────────────────────────

const CHANNEL_LINE = /^[*_`#>\s]*channel\s*[:：]\s*(.+?)\s*$/i;

/*
 * Splits a streamed reply into its CHANNEL line and the explanation. It holds
 * text back only until it can tell whether the reply opens with a CHANNEL
 * line, so the explanation still appears as it streams.
 */
export class ReplyParser {
	constructor() {
		this.pending = "";
		this.decided = false;
		this.channel = null;
		this.text    = "";
	}

	// Returns { channel?, delta? } for whatever this chunk made visible.
	push(chunk) {
		if (this.decided) {
			this.text += chunk;
			return { delta: chunk };
		}

		this.pending += chunk;

		const trimmed  = this.pending.replace(/^\s+/, "");
		const newline  = trimmed.indexOf("\n");
		const bareHead = trimmed.replace(/^[*_`#>\s]+/, "").slice(0, 7).toLowerCase();

		if (newline !== -1) {
			return this.decide(trimmed.slice(0, newline), trimmed.slice(newline + 1));
		}

		// Clearly not a CHANNEL line: stop holding text back.
		if (bareHead.length === 7 && bareHead !== "channel") {
			return this.decide(null, trimmed);
		}

		if (trimmed.length > 160) {
			return this.decide(null, trimmed);
		}

		return {};
	}

	finish() {
		if (this.decided) {
			return {};
		}

		const trimmed = this.pending.replace(/^\s+/, "");

		return this.decide(trimmed, "");
	}

	decide(firstLine, rest) {
		this.decided = true;

		const match = firstLine === null ? null : firstLine.match(CHANNEL_LINE);

		if (match) {
			this.channel = cleanChannelName(match[1]);
			this.text    = rest.replace(/^\s+/, "");
		} else if (firstLine === null) {
			this.text = rest;
		} else {
			this.text = rest ? `${firstLine}\n${rest}` : firstLine;
		}

		const result = {};

		if (this.channel) result.channel = this.channel;
		if (this.text) result.delta = this.text;

		return result;
	}
}

export function cleanChannelName(raw) {
	const name = (raw || "")
		.replace(/[*_`"“”'‘’<>]/g, "")
		.replace(/[.\s]+$/, "")
		.replace(/\s+/g, " ")
		.trim();

	return name.slice(0, 60);
}

const ABBREVIATIONS = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bapprox|\bDr|\bMr|\bMs|\bSt|\bNo|\bFig)\.$/i;

/* The explanation's first sentence, written by the prompt to stand alone. */
export function gistOf(explanation) {
	const plain = (explanation || "")
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/[*`]/g, "")              // underscores stay: they're part of names like __wrapped__
		.replace(/^\s*[-•]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();

	const boundary = /[.!?](?=\s|$)/g;
	let match;

	while ((match = boundary.exec(plain)) !== null) {
		const sentence = plain.slice(0, match.index + 1);

		if (!ABBREVIATIONS.test(sentence) && sentence.length >= 12) {
			return truncate(sentence, 220);
		}
	}

	return truncate(plain, 220);
}

function truncate(text, max) {
	return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

function oneLine(text, max) {
	return truncate((text || "").replace(/\s+/g, " ").trim(), max);
}

export function emptyReplyMessage(finishReason) {
	return finishReason === "length"
		? "The model used its whole allowance thinking and never answered. Try again, or raise the answer length or lower the reasoning effort in settings."
		: "The model sent back an empty answer. Try again, or pick a different model in settings.";
}

export function describeHttpError(status, body) {
	let detail = "";

	try {
		detail = JSON.parse(body).error.message || "";
	} catch {
		detail = (body || "").slice(0, 200);
	}

	switch (status) {
		case 401: return "OpenRouter rejected the API key. Check it in settings.";
		case 402: return "Your OpenRouter account is out of credit.";
		case 403: return `OpenRouter refused the request${detail ? `: ${detail}` : "."}`;
		case 404: return `OpenRouter doesn't know that model${detail ? `: ${detail}` : "."} Pick another in settings.`;
		case 408: return "OpenRouter timed out. Try again.";
		case 429: return "OpenRouter is rate-limiting requests. Wait a moment and try again.";
	}

	if (status >= 500) {
		return `OpenRouter or the model's provider had a problem (${status}). Try again.`;
	}

	return `OpenRouter error ${status}${detail ? `: ${detail}` : ""}`;
}

/*
 * Reads an OpenRouter SSE stream body line by line. Feeds complete lines to
 * the callbacks; keeps a partial trailing line for the next chunk.
 */
export class SseReader {
	constructor() {
		this.buffer       = "";
		this.done         = false;
		this.finishReason = null;
	}

	// Returns { deltas: string[], error?: string }.
	push(text) {
		this.buffer += text;

		const lines  = this.buffer.split(/\r?\n/);
		const deltas = [];

		this.buffer = lines.pop();

		for (const line of lines) {
			if (!line.startsWith("data:")) {
				continue;   // blank separators and ": OPENROUTER PROCESSING" keep-alives
			}

			const payload = line.slice(5).trim();

			if (payload === "[DONE]") {
				this.done = true;
				break;
			}

			let event;

			try {
				event = JSON.parse(payload);
			} catch {
				continue;
			}

			if (event.error) {
				return { deltas, error: event.error.message || "The model's provider returned an error." };
			}

			const choice = event.choices && event.choices[0];

			if (!choice) continue;

			const content = choice.delta && choice.delta.content;

			if (content) deltas.push(content);
			if (choice.finish_reason) this.finishReason = choice.finish_reason;
		}

		return { deltas };
	}
}

// ─── Channels and history ───────────────────────────────────────────────────

export function emptyData() {
	return { channels: [], lookups: [], pinnedChannelId: null };
}

export function newId() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function findChannel(data, name) {
	const wanted = cleanChannelName(name).toLowerCase();

	return data.channels.find((c) => c.name.toLowerCase() === wanted) || null;
}

export function channelById(data, id) {
	return data.channels.find((c) => c.id === id) || null;
}

export function ensureChannel(data, name, now, createdBy = null) {
	const existing = findChannel(data, name);

	if (existing) {
		return existing;
	}

	const channel = {
		id         : newId(),
		name       : cleanChannelName(name) || FALLBACK_CHANNEL,
		createdAt  : now,
		lastUsedAt : now,
		createdBy  : createdBy
	};

	data.channels.push(channel);

	return channel;
}

export function pinnedChannel(data) {
	return data.pinnedChannelId ? channelById(data, data.pinnedChannelId) : null;
}

export function mostRecentChannelName(data) {
	const last = data.lookups[data.lookups.length - 1];
	const channel = last && channelById(data, last.channelId);

	return channel ? channel.name : null;
}

export function addLookup(data, lookup, historyLimit) {
	data.lookups.push(lookup);

	if (data.lookups.length > historyLimit) {
		data.lookups.splice(0, data.lookups.length - historyLimit);
	}
}

export function replaceLookup(data, lookup) {
	const index = data.lookups.findIndex((l) => l.id === lookup.id);

	if (index === -1) {
		data.lookups.push(lookup);
		return;
	}

	// A re-explained lookup moves to the end: it is now the most recent one.
	data.lookups.splice(index, 1);
	data.lookups.push(lookup);
}

export function lookupById(data, id) {
	return data.lookups.find((l) => l.id === id) || null;
}

/*
 * Correcting a misfile: move one lookup to the named channel and pin it. A
 * channel created for that very lookup, and now empty, is removed, so a
 * wrong guess leaves nothing behind.
 */
export function moveLookup(data, lookupId, name, now) {
	const lookup = lookupById(data, lookupId);

	if (!lookup) {
		return null;
	}

	const from = channelById(data, lookup.channelId);
	const to   = ensureChannel(data, name, now);

	lookup.channelId = to.id;
	to.lastUsedAt    = Math.max(to.lastUsedAt, lookup.createdAt);
	data.pinnedChannelId = to.id;

	if (from && from.id !== to.id && from.createdBy === lookup.id && !data.lookups.some((l) => l.channelId === from.id)) {
		removeChannel(data, from.id);
	}

	return to;
}

export function renameChannel(data, id, name, now) {
	const channel = channelById(data, id);
	const clean   = cleanChannelName(name);

	if (!channel || !clean) {
		return;
	}

	const clash = findChannel(data, clean);

	if (clash && clash.id !== id) {
		mergeChannels(data, id, clash.id);
		return;
	}

	channel.name = clean;
}

export function mergeChannels(data, fromId, intoId) {
	const from = channelById(data, fromId);
	const into = channelById(data, intoId);

	if (!from || !into || fromId === intoId) {
		return;
	}

	for (const lookup of data.lookups) {
		if (lookup.channelId === fromId) lookup.channelId = intoId;
	}

	into.lastUsedAt = Math.max(into.lastUsedAt, from.lastUsedAt);

	if (data.pinnedChannelId === fromId) data.pinnedChannelId = intoId;

	removeChannel(data, fromId);
}

export function deleteChannel(data, id) {
	data.lookups = data.lookups.filter((l) => l.channelId !== id);
	removeChannel(data, id);
}

function removeChannel(data, id) {
	data.channels = data.channels.filter((c) => c.id !== id);

	if (data.pinnedChannelId === id) data.pinnedChannelId = null;
}

export function channelSummaries(data) {
	return [...data.channels]
		.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
		.map((c) => ({
			id         : c.id,
			name       : c.name,
			lastUsedAt : c.lastUsedAt,
			count      : data.lookups.filter((l) => l.channelId === c.id).length
		}));
}

/*
 * The query box doubles as a search box, so editing it has to mean one of
 * two things. If the new text still contains the original selection ("wraps"
 * → "functools.wraps in tests"), it's a refinement and replaces the answer
 * in place; anything else is a new lookup.
 */
export function isRefinement(originalText, newText) {
	const original = (originalText || "").trim().toLowerCase();
	const updated  = (newText || "").trim().toLowerCase();

	return Boolean(original) && updated !== original && updated.includes(original);
}

// ─── Markdown history ───────────────────────────────────────────────────────
// Mirrors Core.kt's exportFileName and lookupMarkdown, so every client writes
// the same note for the same lookup. Times are in local time.

function yamlString(text) {
	return "\"" + String(text)
		.replace(/\\/g, "\\\\")
		.replace(/"/g, "\\\"")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t") + "\"";
}

function pad(n, width = 2) {
	return String(n).padStart(width, "0");
}

/*
 * The file name a lookup is saved under: date, time and the term, safe for
 * every filesystem and for Obsidian links. Fixed at first export and kept on
 * the lookup, so re-explaining it rewrites the same file.
 */
export function exportFileName(lookup) {
	const t    = new Date(lookup.createdAt);
	const term = (lookup.text || "")
		.replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60)
		.replace(/[.\s]+$/, "") || "lookup";

	return `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}${pad(t.getMinutes())} ${term}.md`;
}

/* A lookup, its follow-ups and its channel as a Markdown note with YAML front matter. */
export function lookupMarkdown(lookup, channelName) {
	const t           = new Date(lookup.createdAt);
	const sourceTitle = lookup.sourceTitle || "";
	const sourceUrl   = lookup.sourceUrl || "";
	const out         = [
		"---",
		`term: ${yamlString(lookup.text)}`,
		`channel: ${yamlString(channelName)}`,
		`date: ${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
	];

	if (sourceTitle) out.push(`source_title: ${yamlString(sourceTitle)}`);
	if (sourceUrl) out.push(`source: ${yamlString(sourceUrl)}`);

	out.push(`model: ${yamlString(lookup.model)}`, "tags: [read-deeper]", "---", "", `# ${oneLine(lookup.text, 200)}`, "");

	let where = `**Channel:** ${channelName}`;

	if (sourceUrl) where += ` · **Source:** [${oneLine(sourceTitle || sourceUrl, 200)}](${sourceUrl})`;
	else if (sourceTitle) where += ` · **Source:** ${oneLine(sourceTitle, 200)}`;

	out.push(where);

	if ((lookup.context || "").trim()) out.push("", `> ${oneLine(lookup.context, 2000)}`);

	out.push("", (lookup.explanation || "").trim());

	if ((lookup.thread || []).length) {
		out.push("", "## Follow-ups");

		for (const turn of lookup.thread) out.push("", `### ${oneLine(turn.q, 300)}`, "", (turn.a || "").trim());
	}

	return out.join("\n") + "\n";
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Code spans are set aside first so bold can wrap them (**`x=1`**) without
// anything inside the code being treated as Markdown.
function inline(text) {
	const codes = [];
	const held  = text.replace(/`([^`\n]+)`/g, (_, code) => {
		codes.push(`<code>${escapeHtml(code)}</code>`);
		return `\u0000${codes.length - 1}\u0000`;
	});

	return escapeHtml(held)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
		.replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>")
		.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

/* The light Markdown the prompt allows: bold, italics, inline code, fenced code, lists. */
export function markdownToHtml(markdown) {
	const lines = (markdown || "").replace(/\r/g, "").split("\n");
	const out   = [];
	let list    = null;
	let para    = [];

	const flushPara = () => {
		if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
		para = [];
	};

	const flushList = () => {
		if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
		list = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^\s*```/.test(line)) {
			flushPara();
			flushList();

			const code = [];

			for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) {
				code.push(lines[i]);
			}

			out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}

		const bullet  = line.match(/^\s*[-*•]\s+(.*)$/);
		const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);

		if (bullet || ordered) {
			flushPara();

			const tag = bullet ? "ul" : "ol";

			if (!list || list.tag !== tag) {
				flushList();
				list = { tag, items: [] };
			}

			list.items.push((bullet || ordered)[1]);
			continue;
		}

		if (!line.trim()) {
			flushPara();
			flushList();
			continue;
		}

		flushList();
		para.push(line.replace(/^#+\s*/, ""));
	}

	flushPara();
	flushList();

	return out.join("");
}
