import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, emptyData, exportFileName, lookupById, lookupMarkdown, channelById, FALLBACK_CHANNEL } from "../../chrome-extension/lib/core.js";
import { ApiError, checkKey, streamChat } from "../../chrome-extension/lib/openrouter.js";
import { Data, Engine, Lookup, Query, Settings } from "./engine";
import { ReadDeeperView, VIEW_TYPE } from "./view";

/** Where the OpenRouter key is kept: Obsidian's secret store, on this device only. */
const SECRET_ID = "read-deeper-openrouter-key";

export const DEFAULT_EXPORT_FOLDER = "LLMs/sessions/read_deeper";

/** Everything in data.json. Syncthing carries it, so Obsidian on every device shares history. */
interface Saved {
	settings     : Omit<Settings, "apiKey"> & { exportFolder: string };
	data         : Data;
	apiKeyInFile?: string;   // only on Obsidian older than 1.11.4, which has no secret store
}

export default class ReadDeeperPlugin extends Plugin {

	saved!         : Saved;
	engine!        : Engine;
	private queue  = Promise.resolve();

	async onload(): Promise<void> {
		await this.loadSaved();

		this.engine = new Engine({
			exported   : (ids) => this.exportNotes(ids),
			loadData   : () => this.saved.data,
			settings   : () => ({ ...this.saved.settings, apiKey: this.apiKey }),
			streamChat : (settings, messages, onDelta, signal) => streamChat(settings, messages, onDelta, signal),
			updateData : (change) => this.updateData(change)
		});

		this.registerView(VIEW_TYPE, (leaf) => new ReadDeeperView(leaf, this));

		this.addRibbonIcon("book-open-text", "Read Deeper", () => this.openPanel(null));

		this.addCommand({
			callback : () => this.explainSelection(),
			id       : "explain-selection",
			name     : "Explain the selected text"
		});

		this.addCommand({
			callback : () => this.openPanel(null),
			id       : "open",
			name     : "Open the panel"
		});

		// Right-click on selected text in the editor.
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
			const text = editor.getSelection().trim();

			if (!text) return;

			menu.addItem((item) => item
				.setTitle(`Explain “${shorten(text, 30)}” with Read Deeper`)
				.setIcon("book-open-text")
				.setSection("selection")
				.onClick(() => this.openPanel(this.queryFromEditor(editor, view as MarkdownView))));
		}));

		this.addSettingTab(new ReadDeeperSettingTab(this.app, this));
	}

	// --- Storage ----------------------------------------------------------

	private async loadSaved(): Promise<void> {
		const raw = (await this.loadData()) ?? {};
		const { apiKey: _ignored, ...defaults } = DEFAULT_SETTINGS as Settings;

		this.saved = {
			apiKeyInFile : raw.apiKeyInFile,
			data         : { ...emptyData(), ...(raw.data ?? {}) },
			settings     : { ...defaults, exportFolder: DEFAULT_EXPORT_FOLDER, ...(raw.settings ?? {}) }
		};
	}

	/** Syncthing replaced data.json (a lookup made on another device): reload it. */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSaved();
		this.views().forEach((view) => view.refreshState());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.saved);
	}

	/** Every change to history goes through here, one at a time, then is saved. */
	updateData<T>(change: (data: Data) => T): Promise<T> {
		const run = this.queue.then(async () => {
			const result = change(this.saved.data);

			await this.saveData(this.saved);

			return result;
		});

		this.queue = run.then(() => undefined, () => undefined);

		return run;
	}

	get apiKey(): string {
		const secrets = (this.app as any).secretStorage;

		return ((secrets ? secrets.getSecret(SECRET_ID) : this.saved.apiKeyInFile) || "").trim();
	}

	async setApiKey(key: string): Promise<void> {
		const secrets = (this.app as any).secretStorage;

		if (secrets) {
			secrets.setSecret(SECRET_ID, key.trim());
		} else {
			this.saved.apiKeyInFile = key.trim();
			await this.saveSettings();
		}
	}

	get hasSecretStore(): boolean {
		return Boolean((this.app as any).secretStorage);
	}

	// --- Markdown history -------------------------------------------------

	/**
	 * One note per lookup in the chosen folder, in the same format as the
	 * Android app's, rewritten when the lookup changes. Off when the folder
	 * setting is empty. The file name is fixed at first export.
	 */
	async exportNotes(ids: string[]): Promise<void> {
		const folder = normalizePath(this.saved.settings.exportFolder.trim());

		if (!this.saved.settings.exportFolder.trim()) return;

		try {
			if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await this.app.vault.createFolder(folder);

			const notes = await this.updateData((data) => ids
				.map((id) => lookupById(data, id) as Lookup | null)
				.filter((lookup): lookup is Lookup => lookup !== null)
				.map((lookup) => {
					if (!lookup.exportName) lookup.exportName = exportFileName(lookup);

					const channel = channelById(data, lookup.channelId);

					return { content: lookupMarkdown(lookup, channel ? channel.name : FALLBACK_CHANNEL), name: lookup.exportName as string };
				}));

			for (const note of notes) {
				const path     = normalizePath(`${folder}/${note.name}`);
				const existing = this.app.vault.getAbstractFileByPath(path);

				if (existing instanceof TFile) await this.app.vault.modify(existing, note.content);
				else await this.app.vault.create(path, note.content);
			}
		} catch (error) {
			new Notice(`Read Deeper could not save the lookup note: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** The exported note for a lookup, if it exists. */
	noteFor(lookup: Lookup): TFile | null {
		if (!lookup.exportName || !this.saved.settings.exportFolder.trim()) return null;

		const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.saved.settings.exportFolder.trim()}/${lookup.exportName}`));

		return file instanceof TFile ? file : null;
	}

	// --- Selections -------------------------------------------------------

	/**
	 * The command: the editor's selection if a note is being edited, otherwise
	 * whatever is selected on screen (reading view, PDFs). With nothing
	 * selected it just opens the panel to type in.
	 */
	explainSelection(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (view && view.getMode() === "source" && view.editor.getSelection().trim()) {
			this.openPanel(this.queryFromEditor(view.editor, view));
			return;
		}

		this.openPanel(this.queryFromPage());
	}

	queryFromEditor(editor: Editor, view: MarkdownView | null): Query {
		const text = editor.getSelection().trim();
		const from = editor.getCursor("from").line;
		const to   = editor.getCursor("to").line;
		let   top  = from;
		let   end  = to;

		// The paragraph around the selection: out to the nearest blank lines.
		while (top > 0 && editor.getLine(top - 1).trim() && from - top < 20) top--;
		while (end < editor.lineCount() - 1 && editor.getLine(end + 1).trim() && end - to < 20) end++;

		const lines = [];

		for (let line = top; line <= end; line++) lines.push(editor.getLine(line));

		return { context: shorten(lines.join("\n"), 1500), sourceTitle: this.sourceTitle(view?.file ?? null), sourceUrl: "", text };
	}

	queryFromPage(): Query | null {
		const selection = activeWindow.getSelection();
		const text      = (selection?.toString() ?? "").trim();

		if (!text) return null;

		const node  = selection?.anchorNode;
		const start = node instanceof Element ? node : node?.parentElement;
		const block = start?.closest("p, li, blockquote, td, .textLayer, .markdown-preview-section > div") ?? start;

		return { context: shorten(block?.textContent ?? "", 1500), sourceTitle: this.sourceTitle(this.app.workspace.getActiveFile()), sourceUrl: "", text };
	}

	/** The note as a link, so the saved lookup links back to what you were reading. */
	private sourceTitle(file: TFile | null): string {
		if (!file) return "";

		return file.extension === "md" ? `[[${file.basename}]]` : `[[${file.name}]]`;
	}

	// --- Panel ------------------------------------------------------------

	async openPanel(query: Query | null): Promise<void> {
		const { workspace } = this.app;
		let   leaf          = workspace.getLeavesOfType(VIEW_TYPE)[0];

		if (!leaf) {
			const right = workspace.getRightLeaf(false);

			if (!right) return;

			await right.setViewState({ active: true, type: VIEW_TYPE });
			leaf = right;
		}

		await workspace.revealLeaf(leaf);

		const view = leaf.view as ReadDeeperView;

		if (query) view.start(query);
		else view.focusQuery();
	}

	views(): ReadDeeperView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view as ReadDeeperView);
	}
}

function shorten(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();

	return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + "…";
}

// --- Settings ---------------------------------------------------------------

class ReadDeeperSettingTab extends PluginSettingTab {

	constructor(app: App, private readonly plugin: ReadDeeperPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings        = this.plugin.saved.settings;
		const save            = () => this.plugin.saveSettings();

		containerEl.empty();

		let keyInput = "";

		new Setting(containerEl)
			.setName("OpenRouter API key")
			.setDesc(this.plugin.hasSecretStore
				? "Kept in Obsidian's secret store on this device. It is not synced: enter it once on each device."
				: "Saved in this plugin's data file, which Syncthing syncs. Update Obsidian to 1.11.4+ to keep it in the secret store instead.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder(this.plugin.apiKey ? "•••••••• (saved)" : "sk-or-…").onChange((value) => { keyInput = value; });
			})
			.addButton((button) => button.setButtonText("Save and test").onClick(async () => {
				const key = keyInput.trim() || this.plugin.apiKey;

				if (!key) {
					new Notice("Paste a key first.");
					return;
				}

				await this.plugin.setApiKey(key);

				try {
					const info = await checkKey(key);

					new Notice(`Key works${info.label ? ` (${info.label})` : ""}.`);
				} catch (error) {
					new Notice(error instanceof ApiError ? error.message : `Test failed: ${String(error)}`);
				}

				this.display();
			}));

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Any OpenRouter model ID.")
			.addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.model).setValue(settings.model).onChange(async (value) => {
				settings.model = value.trim() || DEFAULT_SETTINGS.model;
				await save();
			}));

		new Setting(containerEl)
			.setName("Answer length")
			.setDesc("About this many words.")
			.addSlider((slider) => slider.setLimits(20, 300, 10).setValue(settings.targetWords).setDynamicTooltip().onChange(async (value) => {
				settings.targetWords = value;
				await save();
			}));

		new Setting(containerEl)
			.setName("Reasoning effort")
			.addDropdown((dropdown) => dropdown
				.addOptions({ high: "High", low: "Low", medium: "Medium", off: "Off" })
				.setValue(settings.reasoningEffort)
				.onChange(async (value) => {
					settings.reasoningEffort = value;
					await save();
				}));

		new Setting(containerEl)
			.setName("Send the surrounding text")
			.setDesc("The paragraph around your selection goes with the lookup, so the answer fits how the term is used there.")
			.addToggle((toggle) => toggle.setValue(settings.sendContext).onChange(async (value) => {
				settings.sendContext = value;
				await save();
			}));

		new Setting(containerEl)
			.setName("Markdown history folder")
			.setDesc("Every lookup is saved as a note here, in the same format as the Android app. Leave empty to save nothing.")
			.addText((text) => text.setPlaceholder(DEFAULT_EXPORT_FOLDER).setValue(settings.exportFolder).onChange(async (value) => {
				settings.exportFolder = value.trim();
				await save();
			}));

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Leave empty for the shared default. {{target_words}} becomes the answer length.")
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.setValue(settings.systemPrompt).onChange(async (value) => {
					settings.systemPrompt = value;
					await save();
				});
			});
	}
}
