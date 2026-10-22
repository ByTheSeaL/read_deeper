/*
 * The lookup panel: query box, channel box, streamed answer, follow-up thread.
 * The same component is drawn in three places: the on-page overlay (inside a
 * shadow root), the toolbar popup, and the fallback window. It's a classic
 * script, not a module, because content scripts can't import modules. All
 * logic and rendering happens in the service worker; this only draws what
 * comes back over the "lookup" port.
 */

(() => {
	if (window.ReadDeeperPanel) {
		return;
	}

	const CSS = `
		.rd {
			--bg: #ffffff;
			--fg: #1c1c22;
			--muted: #6b6b76;
			--line: #dcdce3;
			--soft: #f3f3f6;
			--accent: #0e7c7b;
			--accent-fg: #ffffff;
			--pin: #b7791f;
			--error: #b42318;
			--code: #f0f0f4;

			background: var(--bg);
			color: var(--fg);
			display: flex;
			flex-direction: column;
			font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			gap: 10px;
			text-align: left;
		}

		@media (prefers-color-scheme: dark) {
			.rd {
				--bg: #1d1d22;
				--fg: #ececf1;
				--muted: #9d9daa;
				--line: #3a3a44;
				--soft: #27272e;
				--accent: #3fb8b4;
				--accent-fg: #0b1f1f;
				--pin: #e3a948;
				--error: #ff8a80;
				--code: #2b2b33;
			}
		}

		.rd * { box-sizing: border-box; font-family: inherit; }

		.rd-query-row { align-items: flex-start; display: flex; gap: 6px; }

		.rd-query {
			background: var(--soft);
			border: 1px solid var(--line);
			border-radius: 8px;
			color: var(--fg);
			flex: 1;
			font-size: 15px;
			font-weight: 600;
			line-height: 1.4;
			max-height: 120px;
			min-height: 38px;
			padding: 8px 10px;
			resize: none;
		}

		.rd-query:focus, .rd-channel:focus, .rd-follow:focus { border-color: var(--accent); outline: none; }

		.rd button {
			background: var(--accent);
			border: 0;
			border-radius: 8px;
			color: var(--accent-fg);
			cursor: pointer;
			font-size: 13px;
			font-weight: 600;
			min-height: 38px;
			padding: 0 12px;
			white-space: nowrap;
		}

		.rd button.rd-ghost {
			background: transparent;
			border: 1px solid var(--line);
			color: var(--fg);
		}

		.rd button:disabled { cursor: default; opacity: 0.5; }

		.rd-close { font-size: 18px !important; padding: 0 10px !important; }

		.rd-channel-row { align-items: center; display: flex; font-size: 12px; gap: 6px; }

		.rd-channel-label { color: var(--muted); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }

		.rd-channel {
			background: transparent;
			border: 1px solid var(--line);
			border-radius: 6px;
			color: var(--fg);
			flex: 1;
			font-size: 13px;
			min-width: 0;
			padding: 4px 8px;
		}

		.rd button.rd-pin {
			background: transparent;
			border: 1px solid var(--line);
			color: var(--muted);
			font-size: 12px;
			min-height: 28px;
			padding: 0 8px;
		}

		.rd button.rd-pin.rd-pinned { border-color: var(--pin); color: var(--pin); }

		.rd-answer { overflow-wrap: anywhere; }
		.rd-answer p, .rd-turn p { margin: 0 0 8px; }
		.rd-answer ul, .rd-answer ol, .rd-turn ul, .rd-turn ol { margin: 0 0 8px; padding-left: 20px; }
		.rd-answer code, .rd-turn code { background: var(--code); border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; padding: 1px 4px; }
		.rd-answer pre, .rd-turn pre { background: var(--code); border-radius: 6px; margin: 0 0 8px; overflow-x: auto; padding: 8px 10px; }
		.rd-answer pre code, .rd-turn pre code { background: none; padding: 0; }

		.rd-status { color: var(--muted); font-size: 13px; }
		.rd-status.rd-error { color: var(--error); }
		.rd-status:empty { display: none; }

		.rd-thread { display: flex; flex-direction: column; gap: 8px; }
		.rd-thread:empty { display: none; }
		.rd-turn { border-left: 3px solid var(--line); padding-left: 10px; }
		.rd-question { color: var(--muted); font-weight: 600; margin-bottom: 4px; }

		.rd-follow-row { display: flex; gap: 6px; }

		.rd-follow {
			background: var(--soft);
			border: 1px solid var(--line);
			border-radius: 8px;
			color: var(--fg);
			flex: 1;
			font-size: 13px;
			min-width: 0;
			padding: 8px 10px;
		}

		.rd-footer { align-items: center; display: flex; gap: 8px; }
		.rd-footer .rd-meta { color: var(--muted); flex: 1; font-size: 11px; text-align: right; }

		.rd [hidden] { display: none !important; }
	`;

	function el(tag, props = {}, ...children) {
		const node = document.createElement(tag);

		for (const [key, value] of Object.entries(props)) {
			if (key === "class") node.className = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else if (key in node) node[key] = value;
			else node.setAttribute(key, value);
		}

		node.append(...children);

		return node;
	}

	function isRefinement(originalText, newText) {
		const original = (originalText || "").trim().toLowerCase();
		const updated  = (newText || "").trim().toLowerCase();

		return Boolean(original) && updated !== original && updated.includes(original);
	}

	function mount(root, options = {}) {
		const rootNode  = root.getRootNode();
		const styleHost = rootNode instanceof ShadowRoot ? rootNode : document.head;

		if (!styleHost.querySelector("style[data-read-deeper]")) {
			styleHost.append(el("style", { "data-read-deeper": "1", textContent: CSS }));
		}

		const listId = `rd-channels-${Math.random().toString(36).slice(2)}`;

		const query     = el("textarea", { class: "rd-query", rows: 1, placeholder: "A word, phrase or sentence…", spellcheck: false });
		const runButton = el("button", { textContent: options.mode === "overlay" ? "⟳" : "Explain", title: "Explain (Enter)" });
		const close     = el("button", { class: "rd-ghost rd-close", textContent: "×", title: "Close (Esc)", hidden: !options.onClose });
		const channel   = el("input", { class: "rd-channel", placeholder: "auto: picked for you", spellcheck: false });
		const pin       = el("button", { class: "rd-pin", textContent: "auto", title: "Pin this channel for every lookup" });
		const datalist  = el("datalist", { id: listId });
		const status    = el("div", { class: "rd-status" });
		const answer    = el("div", { class: "rd-answer" });
		const thread    = el("div", { class: "rd-thread" });
		const follow    = el("input", { class: "rd-follow", placeholder: "Ask a follow-up…" });
		const askButton = el("button", { textContent: "Ask" });
		const followRow = el("div", { class: "rd-follow-row", hidden: true }, follow, askButton);
		const copy      = el("button", { class: "rd-ghost", textContent: "Copy", hidden: true });
		const settings  = el("button", { class: "rd-ghost", textContent: "Open settings", hidden: true });
		const meta      = el("span", { class: "rd-meta" });

		channel.setAttribute("list", listId);

		const panel = el("div", { class: "rd" },
			el("div", { class: "rd-query-row" }, query, runButton, close),
			el("div", { class: "rd-channel-row" }, el("span", { class: "rd-channel-label", textContent: "Channel" }), channel, pin, datalist),
			status,
			answer,
			thread,
			followRow,
			el("div", { class: "rd-footer" }, copy, settings, meta)
		);

		root.append(panel);

		let port          = null;
		let lookup        = null;   // the stored lookup being shown, once it's finished
		let pending       = null;   // { text, context, sourceUrl, sourceTitle } for the selection we were opened with
		let pinnedName    = null;
		let busy          = false;
		let pendingTurn   = null;

		function connect() {
			if (port) return port;

			port = chrome.runtime.connect({ name: "lookup" });
			port.onMessage.addListener(onMessage);
			port.onDisconnect.addListener(() => {
				port = null;

				if (busy) {
					setBusy(false);
					showStatus("Lost the connection to Read Deeper. Try again.", true);
				}
			});

			return port;
		}

		function send(message) {
			try {
				connect().postMessage(message);
			} catch {
				port = null;
				connect().postMessage(message);
			}
		}

		function setBusy(value) {
			busy = value;
			runButton.disabled = value;
			askButton.disabled = value;
		}

		function showStatus(text, isError = false) {
			status.textContent = text;
			status.classList.toggle("rd-error", isError);
		}

		function showPinState() {
			const pinned = Boolean(pinnedName);

			pin.textContent = pinned ? "📌 pinned" : "auto";
			pin.title       = pinned ? "Unpin: let Read Deeper pick the channel again" : "Pin this channel for every lookup";
			pin.classList.toggle("rd-pinned", pinned);
		}

		function autoGrow() {
			query.style.height = "auto";
			query.style.height = `${Math.min(query.scrollHeight + 2, 120)}px`;
		}

		function onMessage(message) {
			switch (message.type) {
				case "state":
					pinnedName = message.pinned;
					datalist.replaceChildren(...message.channels.map((name) => el("option", { value: name })));
					showPinState();

					if (!lookup && !busy && document.activeElement !== channel) {
						channel.value = pinnedName || "";
					}

					break;

				case "start":
					setBusy(true);
					showStatus("Thinking…");
					settings.hidden = true;

					if (message.op === "lookup") {
						answer.replaceChildren();
						thread.replaceChildren();
						followRow.hidden = true;
						copy.hidden      = true;
						meta.textContent = "";
					} else {
						const answerNode = el("div");

						pendingTurn = answerNode;
						thread.append(el("div", { class: "rd-turn" }, el("div", { class: "rd-question", textContent: message.question }), answerNode));
					}

					break;

				case "channel":
					if (document.activeElement !== channel) channel.value = message.name;
					break;

				case "delta":
					showStatus("");

					if (message.op === "lookup") answer.innerHTML = message.html;
					else if (pendingTurn) pendingTurn.innerHTML = message.html;

					break;

				case "done":
					setBusy(false);
					showStatus("");

					if (message.op === "lookup") {
						showLookup(message.lookup);
						if (options.onLookupDone) options.onLookupDone(message.lookup);
					} else {
						if (pendingTurn) pendingTurn.innerHTML = message.turn.html;
						if (lookup) (lookup.thread = lookup.thread || []).push(message.turn);
						pendingTurn = null;
						follow.value = "";
					}

					break;

				case "error":
					setBusy(false);
					showStatus(message.message, true);
					settings.hidden = !message.needsKey;

					if (message.op === "followup" && pendingTurn) {
						pendingTurn.closest(".rd-turn").remove();
						pendingTurn = null;
					}

					break;
			}
		}

		function showLookup(stored) {
			lookup = stored;

			query.value   = stored.text;
			channel.value = stored.channelName;
			answer.innerHTML = stored.html;
			thread.replaceChildren(...(stored.thread || []).map((turn) => {
				const answerNode = el("div");

				answerNode.innerHTML = turn.html;

				return el("div", { class: "rd-turn" }, el("div", { class: "rd-question", textContent: turn.q }), answerNode);
			}));

			followRow.hidden = false;
			copy.hidden      = false;
			meta.textContent = stored.model || "";
			showStatus("");
			autoGrow();
		}

		function run() {
			const text = query.value.trim();

			if (!text || busy) return;

			if (lookup && (text.toLowerCase() === lookup.text.toLowerCase() || isRefinement(lookup.text, text))) {
				send({
					type            : "lookup",
					text            : text,
					context         : lookup.context,
					sourceUrl       : lookup.sourceUrl,
					sourceTitle     : lookup.sourceTitle,
					replaceLookupId : lookup.id
				});

				return;
			}

			const fromSelection = pending && (text === pending.text || isRefinement(pending.text, text));

			lookup = null;
			send({
				type        : "lookup",
				text        : text,
				context     : fromSelection ? pending.context : "",
				sourceUrl   : fromSelection ? pending.sourceUrl : "",
				sourceTitle : fromSelection ? pending.sourceTitle : ""
			});
		}

		function ask() {
			const question = follow.value.trim();

			if (!question || busy || !lookup) return;

			send({ type: "followup", lookupId: lookup.id, question });
		}

		runButton.addEventListener("click", run);
		askButton.addEventListener("click", ask);

		query.addEventListener("input", autoGrow);
		query.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				run();
			}
		});

		follow.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				ask();
			}
		});

		// Typing a channel name and pressing Enter (or leaving the box) either
		// moves the lookup on screen into that channel or, with none on screen,
		// pins it for the next one. Clearing the box goes back to auto.
		channel.addEventListener("change", () => {
			send({ type: "setChannel", lookupId: lookup ? lookup.id : null, name: channel.value.trim() });
		});

		channel.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				channel.blur();
			}
		});

		pin.addEventListener("click", () => {
			if (pinnedName) {
				send({ type: "pin", name: null });
			} else if (channel.value.trim()) {
				send({ type: "pin", name: channel.value.trim() });
			} else {
				channel.focus();
				showStatus("Type a channel name to pin.");
			}
		});

		copy.addEventListener("click", async () => {
			if (!lookup) return;

			const text = [lookup.explanation, ...(lookup.thread || []).map((t) => `Q: ${t.q}\n${t.a}`)].join("\n\n");

			try {
				await navigator.clipboard.writeText(text);
				copy.textContent = "Copied";
			} catch {
				copy.textContent = "Copy failed";
			}

			setTimeout(() => { copy.textContent = "Copy"; }, 1500);
		});

		settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openOptions" }));

		if (options.onClose) close.addEventListener("click", options.onClose);

		send({ type: "state" });

		return {
			element: panel,

			/* Start a lookup for a selection: { text, context, sourceUrl, sourceTitle }. */
			lookUp(selection) {
				// A new selection replaces whatever is in flight; the service
				// worker aborts the old request when the new one arrives.
				setBusy(false);
				pending     = selection;
				lookup      = null;
				query.value = selection.text;
				autoGrow();

				if (selection.text.trim()) {
					run();
				} else {
					query.focus();
				}
			},

			show(stored) {
				pending = null;
				showLookup(stored);
			},

			focus() {
				query.focus();
				query.select();
			}
		};
	}

	window.ReadDeeperPanel = { mount };
})();
