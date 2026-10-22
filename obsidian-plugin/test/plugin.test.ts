// Smoke test: the real plugin (main.ts + view.ts + engine.ts + the shared
// core.js/openrouter.js) in jsdom, against a stand-in obsidian module and a
// fake OpenRouter streaming reply at `fetch`. Checks a full lookup from a
// selection: streamed answer in the panel, history saved, note written in the
// Android format; then a follow-up and a channel move rewrite that note.
//
// Not a substitute for trying it in Obsidian: no real CSS or workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

process.env.TZ = "UTC";

const dom = new JSDOM("<!doctype html><body></body>");
const g   = globalThis as any;

g.window = dom.window;
g.activeWindow = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
Object.defineProperty(g, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });

// Obsidian's DOM helpers.
const proto = dom.window.HTMLElement.prototype as any;

function make(tag: string, options?: any, parent?: HTMLElement): HTMLElement {
	const el = document.createElement(tag);

	if (typeof options === "string") el.className = options;
	else if (options) {
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.textContent = String(options.text);
		if (options.type) el.setAttribute("type", options.type);
		for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
	}

	parent?.appendChild(el);

	return el;
}

g.createDiv = (options?: any) => make("div", options);
g.createSpan = (options?: any) => make("span", options);
proto.createDiv = function (options?: any) { return make("div", options, this); };
proto.createSpan = function (options?: any) { return make("span", options, this); };
proto.createEl = function (tag: string, options?: any) { return make(tag, options, this); };
proto.empty = function () { this.replaceChildren(); };
proto.setText = function (text: string) { this.textContent = text; };
proto.addClass = function (...names: string[]) { this.classList.add(...names); };
proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
proto.toggleClass = function (name: string, on: boolean) { this.classList.toggle(name, on); };
proto.hide = function () { this.style.display = "none"; };
proto.show = function () { this.style.display = ""; };

// The vault: a map of path → content.
const files = new Map<string, string>();

class TAbstractFile { constructor(public path: string) {} }
class TFile extends TAbstractFile { get name() { return this.path.split("/").pop()!; } get basename() { return this.name.replace(/\.[^.]+$/, ""); } get extension() { return this.name.split(".").pop()!; } }
class TFolder extends TAbstractFile {}

const folders = new Set<string>();
const views   = new Map<string, Function>();
const leaves  : any[] = [];
let   saved   : any = null;

const reading = new TFile("current/Fluent Python notes.md");

const app: any = {
	secretStorage: { secrets: {} as Record<string, string>, getSecret(id: string) { return this.secrets[id] ?? null; }, setSecret(id: string, value: string) { this.secrets[id] = value; } },
	vault: {
		create         : async (path: string, content: string) => { files.set(path, content); },
		createFolder   : async (path: string) => { folders.add(path); },
		getAbstractFileByPath: (path: string) => (files.has(path) ? new TFile(path) : folders.has(path) ? new TFolder(path) : null),
		modify         : async (file: TFile, content: string) => { files.set(file.path, content); }
	},
	workspace: {
		getActiveFile        : () => reading,
		getActiveViewOfType  : () => null,
		getLeaf              : () => ({ openFile: async () => {} }),
		getLeavesOfType      : (type: string) => leaves.filter((leaf) => leaf.type === type),
		getRightLeaf         : () => {
			const leaf: any = { type: null, view: null };

			leaf.setViewState = async ({ type }: any) => {
				leaf.type = type;
				leaf.view = views.get(type)!(leaf);
				document.body.appendChild(leaf.view.contentEl);
				await leaf.view.onOpen();
			};
			leaves.push(leaf);

			return leaf;
		},
		on                   : () => ({}),
		revealLeaf           : async () => {}
	}
};

class Component { registerEvent() {} register() {} }

const obsidian = {
	ItemView        : class extends Component { app = app; contentEl = createDiv(); constructor(public leaf: any) { super(); } },
	MarkdownView    : class {},
	Notice          : class { constructor(message: string) { throw new Error(`Notice: ${message}`); } },
	Plugin          : class extends Component {
		app = app; manifest = { id: "read-deeper" };
		async loadData() { return saved; }
		async saveData(data: any) { saved = JSON.parse(JSON.stringify(data)); }
		registerView(type: string, factory: Function) { views.set(type, factory); }
		addRibbonIcon() {} addCommand() {} addSettingTab() {}
	},
	PluginSettingTab: class {},
	Setting         : class {},
	TFile,
	TFolder,
	normalizePath   : (path: string) => path.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
	sanitizeHTMLToDom: (html: string) => { const t = document.createElement("template"); t.innerHTML = html; return t.content; },
	setIcon         : () => {}
};

// OpenRouter: answers every request with this streamed reply.
let reply   = "";
const sent  : any[] = [];

g.fetch = async (_url: string, init: any) => {
	sent.push(JSON.parse(init.body));

	const lines   = [...reply].reduce<string[]>((chunks, char, i) => (i % 7 === 0 ? [...chunks, char] : [...chunks.slice(0, -1), chunks.at(-1) + char]), []);
	const encoder = new TextEncoder();
	const body    = new ReadableStream({
		start(controller) {
			for (const chunk of lines) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
			controller.close();
		}
	});

	return { body, ok: true, status: 200 };
};

const built = await esbuild.build({ bundle: true, entryPoints: ["src/main.ts"], external: ["obsidian"], format: "cjs", platform: "node", write: false });
const mod   = { exports: {} as any };

new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, (name: string) => {
	if (name === "obsidian") return obsidian;
	throw new Error(`unexpected require: ${name}`);
});

const Plugin = mod.exports.default;
const plugin = new Plugin();

await plugin.onload();
app.secretStorage.setSecret("read-deeper-openrouter-key", "sk-or-test");

const panel = () => leaves[0].view.contentEl as HTMLElement;
const wait  = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a selection is explained, streamed into the panel, saved, and written as a note", async () => {
	reply = "CHANNEL: Python\n\n`functools.wraps` copies a function's name and docstring onto its wrapper.\n\n- Use it in decorators.";

	await plugin.openPanel({ context: "Use @wraps when writing a decorator.", sourceTitle: "[[Fluent Python notes]]", sourceUrl: "", text: "functools.wraps" });
	await wait();

	assert.match(panel().querySelector(".rd-answer")!.textContent!, /copies a function's name/);
	assert.equal(panel().querySelector(".rd-answer li")?.textContent, "Use it in decorators.");
	assert.equal((panel().querySelector(".rd-channel") as HTMLInputElement).value, "Python");

	const prompt = sent[0].messages[1].content;

	assert.match(prompt, /## Source\nTitle: \[\[Fluent Python notes\]\]/);
	assert.match(prompt, /## Surrounding text\nUse @wraps when writing a decorator\./);
	assert.equal(sent[0].model, "z-ai/glm-5.3-flash");

	assert.equal(saved.data.lookups.length, 1);
	assert.equal(saved.data.channels[0].name, "Python");
	assert.equal(JSON.stringify(saved).includes("sk-or-test"), false, "API key never written to data.json");

	const [path, note] = [...files.entries()][0];

	assert.match(path, /^LLMs\/sessions\/read_deeper\/\d{4}-\d\d-\d\d \d{4} functools\.wraps\.md$/);
	assert.match(note, /^---\nterm: "functools\.wraps"\nchannel: "Python"\ndate: .*\nsource_title: "\[\[Fluent Python notes\]\]"\nmodel: "z-ai\/glm-5\.3-flash"\ntags: \[read-deeper\]\n---\n\n# functools\.wraps\n\n\*\*Channel:\*\* Python · \*\*Source:\*\* \[\[Fluent Python notes\]\]\n\n> Use @wraps when writing a decorator\.\n\n`functools\.wraps` copies/);
});

test("a follow-up is answered, kept with the lookup, and added to the same note", async () => {
	reply = "Yes, methods work the same way.";

	(panel().querySelector(".rd-follow") as HTMLInputElement).value = "Methods too?";
	(panel().querySelector(".rd-follow-row button") as HTMLElement).click();
	await wait();

	assert.match(panel().querySelector(".rd-thread")!.textContent!, /You: Methods too\?Yes, methods work the same way\./);
	assert.equal(saved.data.lookups[0].thread[0].q, "Methods too?");
	assert.equal(files.size, 1, "same note rewritten, not a second one");
	assert.match([...files.values()][0], /## Follow-ups\n\n### Methods too\?\n\nYes, methods work the same way\.\n$/);

	// The follow-up sent the whole thread so far.
	assert.deepEqual(sent.at(-1).messages.map((m: any) => m.role), ["system", "user", "assistant", "user"]);
});

test("typing another channel moves the lookup there, and the note follows", async () => {
	const box = panel().querySelector(".rd-channel") as HTMLInputElement;

	box.value = "Python Decorators";
	box.dispatchEvent(new dom.window.Event("change"));
	await wait();

	assert.equal(saved.data.channels.find((c: any) => c.id === saved.data.lookups[0].channelId).name, "Python Decorators");
	assert.match([...files.values()][0], /channel: "Python Decorators"/);
});

test("the next lookup sees the earlier one in its channel roster", async () => {
	reply = "CHANNEL: Python Decorators\n\n`@property` turns a method into a read-only attribute.";

	await plugin.openPanel({ context: "", sourceTitle: "[[Fluent Python notes]]", sourceUrl: "", text: "@property" });
	await wait();

	assert.match(sent.at(-1).messages[1].content, /### Python Decorators[^\n]*\n- functools\.wraps: `?functools\.wraps`? copies/);
	assert.equal(files.size, 2);
});

test("without a key, the panel says so and nothing is sent", async () => {
	app.secretStorage.setSecret("read-deeper-openrouter-key", "");

	const before = sent.length;

	await plugin.openPanel({ context: "", sourceTitle: "", sourceUrl: "", text: "monad" });
	await wait();

	assert.equal(sent.length, before);
	assert.match(panel().querySelector(".rd-status")!.textContent!, /Add your OpenRouter API key/);
});
