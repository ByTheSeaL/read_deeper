import { ItemView, WorkspaceLeaf, sanitizeHTMLToDom, setIcon } from "obsidian";
import { isRefinement, markdownToHtml, relativeDay } from "../../chrome-extension/lib/core.js";
import { Lookup, NeedsKeyError, Query } from "./engine";
import type ReadDeeperPlugin from "./main";

export const VIEW_TYPE = "read-deeper";

/**
 * The lookup screen, laid out as on Chrome and Android: the query box
 * (edit and press Enter to re-explain), the channel box with a pin, the
 * streamed answer, its follow-up thread, and Copy. With no lookup on
 * screen it lists recent lookups.
 */
export class ReadDeeperView extends ItemView {

	private lookup     : Lookup | null          = null;
	private pending    : Query | null           = null;   // the selection the panel was opened with
	private controller : AbortController | null = null;
	private busy       = false;

	private queryEl!    : HTMLTextAreaElement;
	private channelEl!  : HTMLInputElement;
	private pinEl!      : HTMLButtonElement;
	private listEl!     : HTMLDataListElement;
	private statusEl!   : HTMLElement;
	private answerEl!   : HTMLElement;
	private threadEl!   : HTMLElement;
	private followRow!  : HTMLElement;
	private followEl!   : HTMLInputElement;
	private footerEl!   : HTMLElement;
	private recentEl!   : HTMLElement;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ReadDeeperPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Read Deeper";
	}

	getIcon(): string {
		return "book-open-text";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;

		root.empty();
		root.addClass("read-deeper");

		const queryRow = root.createDiv("rd-row");

		this.queryEl = queryRow.createEl("textarea", { attr: { placeholder: "A word, phrase or sentence…", rows: "1", spellcheck: "false" }, cls: "rd-query" });

		const run = queryRow.createEl("button", { attr: { "aria-label": "Explain" }, cls: "clickable-icon rd-icon" });

		setIcon(run, "refresh-cw");

		const channelRow = root.createDiv("rd-row rd-channel-row");

		channelRow.createSpan({ cls: "rd-label", text: "Channel" });
		this.listEl    = channelRow.createEl("datalist", { attr: { id: `rd-channels-${Math.random().toString(36).slice(2)}` } });
		this.channelEl = channelRow.createEl("input", { attr: { list: this.listEl.id, placeholder: "auto: picked for you", spellcheck: "false" }, cls: "rd-channel", type: "text" });
		this.pinEl     = channelRow.createEl("button", { cls: "rd-pin", text: "auto" });

		this.statusEl  = root.createDiv("rd-status");
		this.answerEl  = root.createDiv("rd-answer markdown-rendered");
		this.threadEl  = root.createDiv("rd-thread markdown-rendered");
		this.followRow = root.createDiv("rd-row rd-follow-row");
		this.followEl  = this.followRow.createEl("input", { attr: { placeholder: "Ask a follow-up…" }, cls: "rd-follow", type: "text" });

		const ask = this.followRow.createEl("button", { attr: { "aria-label": "Ask" }, cls: "clickable-icon rd-icon" });

		setIcon(ask, "send");

		this.footerEl = root.createDiv("rd-footer");
		this.recentEl = root.createDiv("rd-recent");

		run.addEventListener("click", () => this.run());
		ask.addEventListener("click", () => this.ask());

		this.queryEl.addEventListener("input", () => this.autoGrow());
		this.queryEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.run();
			}
		});

		this.followEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.ask();
			}
		});

		// Enter or leaving the box: moves the lookup on screen to that channel,
		// or with none on screen pins it for the next one. Empty = auto.
		this.channelEl.addEventListener("change", async () => {
			await this.plugin.engine.setChannel(this.lookup?.id ?? null, this.channelEl.value);
			this.reloadLookup();
			this.refreshState();
		});

		this.channelEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.channelEl.blur();
			}
		});

		this.pinEl.addEventListener("click", async () => {
			const { pinned } = this.plugin.engine.state();

			if (pinned) {
				await this.plugin.engine.pin(null);
			} else if (this.channelEl.value.trim()) {
				await this.plugin.engine.pin(this.channelEl.value.trim());
			} else {
				this.channelEl.focus();
				this.showStatus("Type a channel name to pin.");
			}

			this.refreshState();
		});

		this.showLookup(null);
		this.refreshState();
	}

	async onClose(): Promise<void> {
		// A closed panel doesn't cancel the request: the answer still lands in history.
	}

	focusQuery(): void {
		this.queryEl?.focus();
	}

	/** Opened from a selection: put it in the box and explain it. */
	start(query: Query): void {
		this.pending       = query;
		this.lookup        = null;
		this.queryEl.value = query.text;
		this.autoGrow();
		void this.lookupNow({ ...query });
	}

	// --- Actions ----------------------------------------------------------

	private run(): void {
		const text = this.queryEl.value.trim();

		if (!text || this.busy) return;

		const lookup = this.lookup;

		// Same text or a widened version of it: re-explain in place.
		if (lookup && (text.toLowerCase() === lookup.text.toLowerCase() || isRefinement(lookup.text, text))) {
			void this.lookupNow({ context: lookup.context, replaceLookupId: lookup.id, sourceTitle: lookup.sourceTitle, sourceUrl: lookup.sourceUrl, text });
			return;
		}

		const pending       = this.pending;
		const fromSelection = pending !== null && (text === pending.text || isRefinement(pending.text, text));

		this.lookup = null;

		void this.lookupNow({
			context     : fromSelection ? pending!.context : "",
			sourceTitle : fromSelection ? pending!.sourceTitle : "",
			sourceUrl   : fromSelection ? pending!.sourceUrl : "",
			text
		});
	}

	private async lookupNow(query: Query): Promise<void> {
		this.controller?.abort();

		const controller = this.controller = new AbortController();

		this.setBusy(true);
		this.showStatus("Thinking…");
		this.answerEl.empty();
		this.threadEl.empty();
		this.followRow.hide();
		this.footerEl.empty();
		this.recentEl.empty();

		if (!query.replaceLookupId && !this.plugin.engine.state().pinned) this.channelEl.value = "";

		try {
			const lookup = await this.plugin.engine.lookup(query, {
				channel : (name) => { this.channelEl.value = name; },
				delta   : (text) => this.renderMarkdown(this.answerEl, text)
			}, controller.signal);

			this.showLookup(lookup);
			this.showStatus("");
		} catch (error) {
			this.showError(error);
		} finally {
			if (this.controller === controller) this.controller = null;
			this.setBusy(false);
			this.refreshState();
		}
	}

	private async ask(): Promise<void> {
		const question = this.followEl.value.trim();
		const lookup   = this.lookup;

		if (!question || this.busy || !lookup) return;

		this.controller?.abort();

		const controller = this.controller = new AbortController();
		const turnEl     = this.threadEl.createDiv("rd-turn");

		turnEl.createDiv({ cls: "rd-turn-question", text: `You: ${question}` });

		const answerEl = turnEl.createDiv("rd-turn-answer");

		this.setBusy(true);
		this.showStatus("Thinking…");

		try {
			await this.plugin.engine.followUp(lookup.id, question, { delta: (text) => this.renderMarkdown(answerEl, text) }, controller.signal);

			this.followEl.value = "";
			this.reloadLookup();
			this.showStatus("");
		} catch (error) {
			turnEl.remove();
			this.showError(error);
		} finally {
			if (this.controller === controller) this.controller = null;
			this.setBusy(false);
		}
	}

	// --- Drawing ----------------------------------------------------------

	/** The lookup on screen, or (none) the recent list. */
	private showLookup(lookup: Lookup | null): void {
		this.lookup = lookup;
		this.answerEl.empty();
		this.threadEl.empty();
		this.footerEl.empty();
		this.recentEl.empty();

		if (!lookup) {
			this.followRow.hide();
			this.renderRecent();
			return;
		}

		this.queryEl.value   = lookup.text;
		this.channelEl.value = this.plugin.engine.channelName(lookup);
		this.autoGrow();
		this.renderMarkdown(this.answerEl, lookup.explanation);

		for (const turn of lookup.thread || []) {
			const turnEl = this.threadEl.createDiv("rd-turn");

			turnEl.createDiv({ cls: "rd-turn-question", text: `You: ${turn.q}` });
			this.renderMarkdown(turnEl.createDiv("rd-turn-answer"), turn.a);
		}

		this.followRow.show();

		const copy = this.footerEl.createEl("button", { cls: "rd-ghost", text: "Copy" });

		copy.addEventListener("click", async () => {
			const text = [lookup.explanation, ...(lookup.thread || []).map((t) => `Q: ${t.q}\n${t.a}`)].join("\n\n");

			try {
				await navigator.clipboard.writeText(text);
				copy.setText("Copied");
			} catch {
				copy.setText("Copy failed");
			}

			window.setTimeout(() => copy.setText("Copy"), 1500);
		});

		const note = this.plugin.noteFor(lookup);

		if (note) {
			const open = this.footerEl.createEl("button", { cls: "rd-ghost", text: "Open note" });

			open.addEventListener("click", () => this.app.workspace.getLeaf("tab").openFile(note));
		}

		const back = this.footerEl.createEl("button", { cls: "rd-ghost", text: "Recent" });

		back.addEventListener("click", () => {
			this.queryEl.value = "";
			this.pending       = null;
			this.showLookup(null);
			this.refreshState();
		});

		this.footerEl.createSpan({ cls: "rd-meta", text: lookup.model });
	}

	private renderRecent(): void {
		const data    = this.plugin.saved.data;
		const lookups = data.lookups.slice(-30).reverse();

		if (!lookups.length) {
			this.recentEl.createDiv({ cls: "rd-empty", text: "Select text in a note, then right-click → Explain with Read Deeper. Or type above." });
			return;
		}

		this.recentEl.createDiv({ cls: "rd-recent-title", text: "Recent" });

		const now = Date.now();

		for (const lookup of lookups) {
			const item = this.recentEl.createDiv("rd-recent-item");

			item.createDiv({ cls: "rd-recent-term", text: lookup.text });
			item.createDiv({ cls: "rd-recent-meta", text: `${this.plugin.engine.channelName(lookup)} · ${relativeDay(lookup.createdAt, now)}` });
			item.addEventListener("click", () => {
				this.pending = null;
				this.showLookup(lookup);
			});
		}
	}

	/** Reads the lookup on screen again after it changed (follow-up, moved channel). */
	private reloadLookup(): void {
		if (!this.lookup) return;

		const fresh = this.plugin.saved.data.lookups.find((item) => item.id === this.lookup!.id) ?? null;

		this.showLookup(fresh);
	}

	/** Channel list for the box and the pin button. Also called after a sync from another device. */
	refreshState(): void {
		if (!this.pinEl) return;

		const { channels, pinned } = this.plugin.engine.state();

		this.listEl.empty();

		for (const name of channels) this.listEl.createEl("option", { attr: { value: name } });

		this.pinEl.setText(pinned ? "📌 pinned" : "auto");
		this.pinEl.toggleClass("rd-pinned", Boolean(pinned));
		this.pinEl.setAttribute("aria-label", pinned ? "Unpin: let Read Deeper pick the channel again" : "Pin this channel for every lookup");

		if (!this.lookup && !this.busy && document.activeElement !== this.channelEl) this.channelEl.value = pinned ?? "";
		if (!this.lookup && !this.busy) {
			this.recentEl.empty();
			this.renderRecent();
		}
	}

	/** The shared light-Markdown renderer, as the other clients use. It escapes all text. */
	private renderMarkdown(el: HTMLElement, markdown: string): void {
		el.empty();
		el.append(sanitizeHTMLToDom(markdownToHtml(markdown)));
	}

	private showStatus(text: string): void {
		this.statusEl.setText(text);
		this.statusEl.removeClass("rd-error");
	}

	private showError(error: unknown): void {
		if (error instanceof Error && error.name === "AbortError") return;

		this.statusEl.empty();
		this.statusEl.addClass("rd-error");
		this.statusEl.setText(error instanceof Error ? error.message : String(error));

		if (error instanceof NeedsKeyError) {
			const link = this.statusEl.createEl("a", { cls: "rd-settings-link", text: " Open settings" });

			link.addEventListener("click", () => {
				const setting = (this.app as any).setting;

				setting?.open();
				setting?.openTabById(this.plugin.manifest.id);
			});
		}
	}

	private setBusy(value: boolean): void {
		this.busy = value;
		this.contentEl.toggleClass("is-busy", value);
	}

	private autoGrow(): void {
		this.queryEl.style.height = "auto";
		this.queryEl.style.height = `${Math.min(this.queryEl.scrollHeight + 2, 120)}px`;
	}
}
