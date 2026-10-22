/*
 * What happens in a lookup, follow-up or channel change: the Chrome
 * extension's background.js flow, against the plugin's store instead of
 * chrome.storage. The request/reply/channel logic itself is the shared
 * core.js, imported as is, so all three clients behave the same.
 *
 * No Obsidian imports: `npm test` runs this in plain Node with a fake
 * stream and store.
 */

import {
	FALLBACK_CHANNEL,
	ReplyParser,
	addLookup,
	buildLookupMessage,
	channelById,
	channelSummaries,
	emptyReplyMessage,
	ensureChannel,
	followUpMessages,
	gistOf,
	lookupById,
	lookupMessages,
	moveLookup,
	mostRecentChannelName,
	newId,
	pinnedChannel,
	replaceLookup,
	systemPromptFor
} from "../../chrome-extension/lib/core.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../chrome-extension/lib/prompt.js";

export interface Turn {
	q         : string;
	a         : string;
	createdAt : number;
}

export interface Lookup {
	id          : string;
	text        : string;
	context     : string;
	sourceUrl   : string;
	sourceTitle : string;
	channelId   : string;
	prompt      : string;
	explanation : string;
	gist        : string;
	model       : string;
	createdAt   : number;
	thread      : Turn[];
	exportName? : string;
}

export interface Channel {
	id         : string;
	name       : string;
	createdAt  : number;
	lastUsedAt : number;
	createdBy  : string | null;
}

export interface Data {
	channels        : Channel[];
	lookups         : Lookup[];
	pinnedChannelId : string | null;
}

export interface Settings {
	apiKey          : string;
	model           : string;
	targetWords     : number;
	reasoningEffort : string;
	systemPrompt    : string;
	sendContext     : boolean;
	rosterSize      : number;
	historyLimit    : number;
}

export interface Query {
	text             : string;
	context          : string;
	sourceUrl        : string;
	sourceTitle      : string;
	replaceLookupId? : string | null;
}

/** What the engine needs from its host. */
export interface Host {
	settings   : () => Settings;
	loadData   : () => Data;
	updateData : <T>(change: (data: Data) => T) => Promise<T>;
	streamChat : (settings: Settings, messages: unknown[], onDelta: (text: string) => void, signal: AbortSignal) => Promise<{ finishReason: string | null }>;
	exported   : (lookupIds: string[]) => Promise<void>;
}

/** What the engine tells the panel while it works. */
export interface Events {
	channel? : (name: string, pinned: boolean) => void;
	delta?   : (text: string) => void;
}

export class NeedsKeyError extends Error {}
export class LookupError extends Error {}

export class Engine {

	constructor(private readonly host: Host) {}

	private requireSettings(): Settings {
		const settings = this.host.settings();

		if (!settings.apiKey) throw new NeedsKeyError("Add your OpenRouter API key in Read Deeper's settings first.");

		return settings;
	}

	/** A new lookup, or a re-explained one (same id and channel) when replaceLookupId is set. */
	async lookup(query: Query, events: Events, signal: AbortSignal): Promise<Lookup> {
		const settings = this.requireSettings();
		const data     = this.host.loadData();
		const now      = Date.now();
		const replaced = query.replaceLookupId ? lookupById(data, query.replaceLookupId) as Lookup | null : null;
		const pinned   = pinnedChannel(data) as Channel | null;
		const forced   = replaced
			? (channelById(data, replaced.channelId) as Channel | null)?.name ?? null
			: pinned?.name ?? null;

		const asked = {
			text        : query.text,
			context     : settings.sendContext ? query.context || "" : "",
			sourceUrl   : query.sourceUrl || "",
			sourceTitle : query.sourceTitle || ""
		};

		const prompt = buildLookupMessage({
			query           : asked,
			data            : data,
			forcedChannel   : forced,
			rosterSize      : settings.rosterSize,
			now             : now,
			excludeLookupId : replaced ? replaced.id : null
		});

		const parser  = new ReplyParser();
		let announced = false;

		if (forced) {
			events.channel?.(forced, Boolean(pinned));
			announced = true;
		}

		const emit = (result: { channel?: string; delta?: string }) => {
			if (result.channel && !announced) {
				events.channel?.(result.channel, false);
				announced = true;
			}

			if (result.delta) events.delta?.(parser.text);
		};

		const system           = systemPromptFor(settings, DEFAULT_SYSTEM_PROMPT);
		const { finishReason } = await this.host.streamChat(settings, lookupMessages(system, prompt), (d) => emit(parser.push(d)), signal);

		emit(parser.finish());

		const explanation = parser.text.trim();

		if (!explanation) throw new LookupError(emptyReplyMessage(finishReason));

		const channelName = forced || parser.channel || mostRecentChannelName(data) || FALLBACK_CHANNEL;

		const lookup = await this.host.updateData((fresh) => {
			const id      = replaced ? replaced.id : newId();
			const channel = (ensureChannel as unknown as (data: Data, name: string, now: number, createdBy: string) => Channel)(fresh, channelName, now, id);
			const record  : Lookup = {
				id          : id,
				text        : asked.text,
				context     : asked.context,
				sourceUrl   : asked.sourceUrl,
				sourceTitle : asked.sourceTitle,
				channelId   : channel.id,
				prompt      : prompt,
				explanation : explanation,
				gist        : gistOf(explanation),
				model       : settings.model,
				createdAt   : now,
				thread      : [],
				exportName  : replaced?.exportName
			};

			channel.lastUsedAt = now;

			if (replaced) replaceLookup(fresh, record);
			else addLookup(fresh, record, settings.historyLimit);

			return record;
		});

		await this.host.exported([lookup.id]);

		return lookup;
	}

	async followUp(lookupId: string, question: string, events: Events, signal: AbortSignal): Promise<Turn> {
		const settings = this.requireSettings();
		const data     = this.host.loadData();
		const lookup   = lookupById(data, lookupId) as Lookup | null;

		if (!lookup) throw new LookupError("That lookup is no longer in your history.");

		const channel  = channelById(data, lookup.channelId) as Channel | null;
		const system   = systemPromptFor(settings, DEFAULT_SYSTEM_PROMPT);
		const messages = followUpMessages(system, lookup, channel ? channel.name : FALLBACK_CHANNEL, question);
		let   answer   = "";

		const { finishReason } = await this.host.streamChat(settings, messages, (delta) => {
			answer += delta;
			events.delta?.(stripChannelLine(answer));
		}, signal);

		answer = stripChannelLine(answer).trim();

		if (!answer) throw new LookupError(emptyReplyMessage(finishReason));

		const turn = { a: answer, createdAt: Date.now(), q: question };

		await this.host.updateData((fresh) => {
			const stored = lookupById(fresh, lookupId) as Lookup | null;

			if (stored) (stored.thread = stored.thread || []).push(turn);
		});

		await this.host.exported([lookupId]);

		return turn;
	}

	/**
	 * The channel box: with a lookup on screen, moves it to that channel (and
	 * pins it); with none, pins the channel for the next lookup. Empty = auto.
	 */
	async setChannel(lookupId: string | null, name: string): Promise<void> {
		const clean = (name || "").trim();
		let   moved = false;

		await this.host.updateData((data) => {
			if (!clean) {
				data.pinnedChannelId = null;
				return;
			}

			if (lookupId && lookupById(data, lookupId)) {
				moveLookup(data, lookupId, clean, Date.now());
				moved = true;
			} else {
				data.pinnedChannelId = ensureChannel(data, clean, Date.now()).id;
			}
		});

		if (moved && lookupId) await this.host.exported([lookupId]);
	}

	async pin(name: string | null): Promise<void> {
		await this.host.updateData((data) => {
			data.pinnedChannelId = name ? ensureChannel(data, name, Date.now()).id : null;
		});
	}

	/** Channel names, most recently used first, and the pinned one. */
	state(): { channels: string[]; pinned: string | null } {
		const data   = this.host.loadData();
		const pinned = pinnedChannel(data) as Channel | null;

		return { channels: channelSummaries(data).map((c: { name: string }) => c.name), pinned: pinned ? pinned.name : null };
	}

	channelName(lookup: Lookup): string {
		return (channelById(this.host.loadData(), lookup.channelId) as Channel | null)?.name ?? FALLBACK_CHANNEL;
	}
}

// Follow-ups shouldn't carry a CHANNEL line, but a model that adds one anyway
// shouldn't have it shown.
export function stripChannelLine(text: string): string {
	return text.replace(/^\s*[*_`#>\s]*channel\s*:.*(\n+|$)/i, "");
}
