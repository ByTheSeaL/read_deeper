/*
 * Service worker: owns the context menu and shortcut, every call to
 * OpenRouter, and all writes to history. The panels (on-page overlay, popup,
 * fallback window) talk to it over a "lookup" port and only draw what it
 * sends back.
 */

import {
	FALLBACK_CHANNEL,
	ReplyParser,
	addLookup,
	buildLookupMessage,
	channelById,
	channelSummaries,
	deleteChannel,
	emptyData,
	emptyReplyMessage,
	ensureChannel,
	followUpMessages,
	gistOf,
	lookupById,
	lookupMessages,
	markdownToHtml,
	mergeChannels,
	mostRecentChannelName,
	moveLookup,
	newId,
	pinnedChannel,
	renameChannel,
	replaceLookup,
	systemPromptFor
} from "./lib/core.js";
import { ApiError, checkKey, listModels, streamChat } from "./lib/openrouter.js";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/prompt.js";
import { getSettings, loadData, updateData } from "./lib/storage.js";

const MENU_ID = "read-deeper-explain";

chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({
		id       : MENU_ID,
		title    : "Explain “%s” with Read Deeper",
		contexts : ["selection"]
	});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === MENU_ID) {
		openOverlay(tab, info.selectionText || "");
	}
});

chrome.commands.onCommand.addListener(async (command, tab) => {
	if (command !== "explain-selection") return;

	const active = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

	if (active) openOverlay(active, null);
});

/*
 * Draws the panel on the page. Some pages refuse content scripts (chrome://,
 * the Web Store, some PDF views); the answer then opens in a small window.
 */
async function openOverlay(tab, text) {
	try {
		await chrome.scripting.executeScript({
			target : { tabId: tab.id, frameIds: [0] },
			files  : ["panel.js", "overlay.js"]
		});

		await chrome.tabs.sendMessage(tab.id, { type: "read-deeper-open", text }, { frameId: 0 });
	} catch {
		if (text === null) {
			text = await selectionFromAnyFrame(tab).catch(() => "");
		}

		openWindow({ text: text || "", sourceUrl: tab.url || "", sourceTitle: tab.title || "" });
	}
}

async function selectionFromAnyFrame(tab) {
	const results = await chrome.scripting.executeScript({
		target : { tabId: tab.id, allFrames: true },
		func   : () => String(window.getSelection() || "")
	});

	return (results.find((r) => r.result && r.result.trim()) || {}).result || "";
}

function openWindow(query) {
	const params = new URLSearchParams({ q: query.text, url: query.sourceUrl, title: query.sourceTitle });

	chrome.windows.create({
		url    : chrome.runtime.getURL(`window.html?${params}`),
		type   : "popup",
		width  : 480,
		height : 640
	});
}

// ─── Panel port ─────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== "lookup") return;

	let current   = null;   // AbortController for the in-flight request
	let connected = true;

	const post = (message) => {
		if (!connected) return;

		try {
			port.postMessage(message);
		} catch {
			connected = false;
		}
	};

	// A closed popup doesn't cancel the request: the answer still lands in
	// history and is there next time you open it.
	port.onDisconnect.addListener(() => { connected = false; });

	port.onMessage.addListener(async (message) => {
		try {
			switch (message.type) {
				case "state":
					post(await stateMessage());
					break;

				case "lookup":
				case "followup": {
					if (current) current.abort();

					const controller = current = new AbortController();

					try {
						if (message.type === "lookup") {
							await runLookup(message, post, controller.signal);
						} else {
							await runFollowUp(message, post, controller.signal);
						}
					} finally {
						if (current === controller) current = null;
					}

					break;
				}

				case "cancel":
					if (current) current.abort();
					break;

				case "setChannel":
					await setChannel(message.lookupId, message.name);
					post(await stateMessage());
					break;

				case "pin":
					await updateData((data) => {
						data.pinnedChannelId = message.name ? ensureChannel(data, message.name, Date.now()).id : null;
					});
					post(await stateMessage());
					break;
			}
		} catch (error) {
			if (error.name === "AbortError") return;

			post({
				type     : "error",
				op       : message.type,
				message  : error instanceof ApiError ? error.message : `Something went wrong: ${error.message}`,
				needsKey : Boolean(error.needsKey)
			});
		}
	});
});

async function stateMessage() {
	const data   = await loadData();
	const pinned = pinnedChannel(data);

	return {
		type     : "state",
		pinned   : pinned ? pinned.name : null,
		channels : channelSummaries(data).map((c) => c.name)
	};
}

async function requireSettings() {
	const settings = await getSettings();

	if (!settings.apiKey) {
		const error = new ApiError("Add your OpenRouter API key in Read Deeper's settings first.");

		error.needsKey = true;
		throw error;
	}

	return settings;
}

/*
 * message: { text, context, sourceUrl, sourceTitle, replaceLookupId? }
 * A replaced (re-explained) lookup keeps its id and channel.
 */
async function runLookup(message, post, signal) {
	const settings = await requireSettings();
	const data     = await loadData();
	const now      = Date.now();
	const replaced = message.replaceLookupId ? lookupById(data, message.replaceLookupId) : null;
	const pinned   = pinnedChannel(data);
	const forced   = replaced
		? (channelById(data, replaced.channelId) || {}).name || null
		: (pinned ? pinned.name : null);

	const query = {
		text        : message.text,
		context     : settings.sendContext ? message.context || "" : "",
		sourceUrl   : message.sourceUrl || "",
		sourceTitle : message.sourceTitle || ""
	};

	const prompt = buildLookupMessage({
		query           : query,
		data            : data,
		forcedChannel   : forced,
		rosterSize      : settings.rosterSize,
		now             : now,
		excludeLookupId : replaced ? replaced.id : null
	});

	const system = systemPromptFor(settings, DEFAULT_SYSTEM_PROMPT);
	const parser = new ReplyParser();
	let announced = false;

	post({ type: "start", op: "lookup", text: query.text });

	if (forced) {
		post({ type: "channel", name: forced, pinned: Boolean(pinned) });
		announced = true;
	}

	const emit = (result) => {
		if (result.channel && !announced) {
			post({ type: "channel", name: result.channel, pinned: false });
			announced = true;
		}

		if (result.delta) post({ type: "delta", op: "lookup", html: markdownToHtml(parser.text) });
	};

	const { finishReason } = await streamChat(settings, lookupMessages(system, prompt), (d) => emit(parser.push(d)), signal);

	emit(parser.finish());

	const explanation = parser.text.trim();

	if (!explanation) {
		throw new ApiError(emptyReplyMessage(finishReason));
	}

	const channelName = forced || parser.channel || mostRecentChannelName(data) || FALLBACK_CHANNEL;

	const lookup = await updateData((fresh) => {
		const id      = replaced ? replaced.id : newId();
		const channel = ensureChannel(fresh, channelName, now, id);
		const record  = {
			id          : id,
			text        : query.text,
			context     : query.context,
			sourceUrl   : query.sourceUrl,
			sourceTitle : query.sourceTitle,
			channelId   : channel.id,
			prompt      : prompt,
			explanation : explanation,
			gist        : gistOf(explanation),
			model       : settings.model,
			createdAt   : now,
			thread      : []
		};

		channel.lastUsedAt = now;

		if (replaced) {
			replaceLookup(fresh, record);
		} else {
			addLookup(fresh, record, settings.historyLimit);
		}

		return withChannelName(fresh, record);
	});

	post({ type: "done", op: "lookup", lookup });
	post(await stateMessage());
}

/* message: { lookupId, question } */
async function runFollowUp(message, post, signal) {
	const settings = await requireSettings();
	const data     = await loadData();
	const lookup   = lookupById(data, message.lookupId);

	if (!lookup) {
		throw new ApiError("That lookup is no longer in your history.");
	}

	const channel  = channelById(data, lookup.channelId);
	const system   = systemPromptFor(settings, DEFAULT_SYSTEM_PROMPT);
	const messages = followUpMessages(system, lookup, channel ? channel.name : FALLBACK_CHANNEL, message.question);
	let answer     = "";

	post({ type: "start", op: "followup", question: message.question });

	const { finishReason } = await streamChat(settings, messages, (delta) => {
		answer += delta;
		post({ type: "delta", op: "followup", html: markdownToHtml(stripChannelLine(answer)) });
	}, signal);

	answer = stripChannelLine(answer).trim();

	if (!answer) {
		throw new ApiError(emptyReplyMessage(finishReason));
	}

	const turn = { q: message.question, a: answer, createdAt: Date.now() };

	await updateData((fresh) => {
		const stored = lookupById(fresh, lookup.id);

		if (stored) (stored.thread = stored.thread || []).push(turn);
	});

	post({ type: "done", op: "followup", turn: { ...turn, html: markdownToHtml(turn.a) } });
}

// Follow-ups shouldn't carry a CHANNEL line, but a model that adds one anyway
// shouldn't have it shown.
function stripChannelLine(text) {
	return text.replace(/^\s*[*_`#>\s]*channel\s*:.*(\n+|$)/i, "");
}

async function setChannel(lookupId, name) {
	const clean = (name || "").trim();

	await updateData((data) => {
		if (!clean) {
			data.pinnedChannelId = null;
			return;
		}

		if (lookupId && lookupById(data, lookupId)) {
			moveLookup(data, lookupId, clean, Date.now());
		} else {
			data.pinnedChannelId = ensureChannel(data, clean, Date.now()).id;
		}
	});
}

// ─── One-off requests from the popup and options page ───────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	handleRequest(message)
		.then((result) => sendResponse({ ok: true, result }))
		.catch((error) => sendResponse({ ok: false, error: error.message }));

	return true;
});

async function handleRequest(message) {
	switch (message.type) {
		case "recent": {
			const data = await loadData();

			return data.lookups.slice(-(message.limit || 30)).reverse().map((l) => withChannelName(data, l));
		}

		case "getLookup": {
			const data   = await loadData();
			const lookup = lookupById(data, message.id);

			return lookup ? withChannelName(data, lookup) : null;
		}

		case "channels": {
			const data = await loadData();

			return { channels: channelSummaries(data), pinnedId: data.pinnedChannelId };
		}

		case "channelLookups": {
			const data = await loadData();

			return data.lookups.filter((l) => l.channelId === message.id).reverse().map((l) => withChannelName(data, l));
		}

		case "renameChannel":
			return updateData((data) => renameChannel(data, message.id, message.name, Date.now()));

		case "mergeChannel":
			return updateData((data) => mergeChannels(data, message.id, message.intoId));

		case "deleteChannel":
			return updateData((data) => deleteChannel(data, message.id));

		case "deleteLookup":
			return updateData((data) => {
				data.lookups = data.lookups.filter((l) => l.id !== message.id);
			});

		case "clearHistory":
			return updateData((data) => Object.assign(data, emptyData()));

		case "checkKey":
			return checkKey(message.apiKey);

		case "models":
			return listModels({ force: Boolean(message.force) });

		case "openOptions":
			await chrome.runtime.openOptionsPage();
			return null;

		case "openWindow":
			openWindow(message.query);
			return null;

	}

	throw new Error(`Unknown request ${message.type}`);
}

/* A lookup as the panels need it: channel name resolved, Markdown rendered. */
function withChannelName(data, lookup) {
	const channel = channelById(data, lookup.channelId);

	return {
		...lookup,
		channelName : channel ? channel.name : FALLBACK_CHANNEL,
		html        : markdownToHtml(lookup.explanation),
		thread      : (lookup.thread || []).map((turn) => ({ ...turn, html: markdownToHtml(turn.a) }))
	};
}
