/*
 * The on-page overlay: the lookup panel in a shadow root, pinned to the top
 * right of the page so no site's CSS can reach it. Injected on demand by the
 * context menu or shortcut, together with panel.js.
 */

(() => {
	if (window.__readDeeperOverlay) {
		return;
	}

	const HOST_ID     = "read-deeper-host";
	const CONTEXT_LEN = 300;

	let host  = null;
	let panel = null;

	window.__readDeeperOverlay = true;

	chrome.runtime.onMessage.addListener((message) => {
		if (message.type !== "read-deeper-open") return;

		const selection = window.getSelection();
		const selected  = String(selection || "").trim();
		const text      = (message.text ?? selected).trim();

		open({
			text        : text,
			context     : text && selected && selected.includes(text.slice(0, 40)) ? surroundingText(selection) : "",
			sourceUrl   : location.href,
			sourceTitle : document.title
		});
	});

	function open(query) {
		if (!host) {
			host = document.createElement("div");
			host.id = HOST_ID;
			host.style.cssText = "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;";

			const shadow = host.attachShadow({ mode: "open" });
			const frame  = document.createElement("div");

			frame.style.cssText = [
				"width: min(440px, calc(100vw - 32px))",
				"max-height: calc(100vh - 32px)",
				"overflow-y: auto",
				"border-radius: 12px",
				"box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28)",
				"border: 1px solid rgba(128, 128, 140, 0.35)"
			].join(";");

			shadow.append(frame);

			panel = window.ReadDeeperPanel.mount(frame, { mode: "overlay", onClose: close });
			panel.element.style.padding = "14px";

			document.addEventListener("keydown", onKey, true);
			document.addEventListener("mousedown", onOutside, true);
		}

		document.documentElement.append(host);
		panel.lookUp(query);
	}

	function close() {
		if (host) host.remove();
	}

	function onKey(event) {
		if (event.key === "Escape" && host && host.isConnected) {
			close();
		}
	}

	function onOutside(event) {
		if (host && host.isConnected && !event.composedPath().includes(host)) {
			close();
		}
	}

	/*
	 * A sentence or two either side of the selection, from the nearest block
	 * of text that contains it, so the model can tell which sense is meant.
	 */
	function surroundingText(selection) {
		if (!selection || !selection.rangeCount) return "";

		const range = selection.getRangeAt(0);
		let block   = range.commonAncestorContainer;

		if (block.nodeType !== Node.ELEMENT_NODE) block = block.parentElement;

		while (block && block !== document.body && (block.innerText || "").length < CONTEXT_LEN * 2) {
			const style = getComputedStyle(block);

			if (style.display !== "inline" && (block.innerText || "").length >= CONTEXT_LEN) break;

			block = block.parentElement;
		}

		if (!block) return "";

		const full     = (block.innerText || block.textContent || "").replace(/\s+/g, " ");
		const selected = String(selection).replace(/\s+/g, " ").trim();
		const at       = full.indexOf(selected);

		if (at === -1) return "";

		let start = Math.max(0, at - CONTEXT_LEN);
		let end   = Math.min(full.length, at + selected.length + CONTEXT_LEN);

		// Snap to sentence edges where one is near, so the context reads cleanly.
		const before = full.slice(start, at).search(/[.!?]\s+[A-Z(“"]/);

		if (start > 0 && before !== -1) start += before + 2;

		const afterText = full.slice(at + selected.length, end);
		const lastStop  = Math.max(afterText.lastIndexOf(". "), afterText.lastIndexOf("? "), afterText.lastIndexOf("! "));

		if (end < full.length && lastStop !== -1) end = at + selected.length + lastStop + 1;

		return (start > 0 ? "…" : "") + full.slice(start, end).trim() + (end < full.length ? "…" : "");
	}
})();
