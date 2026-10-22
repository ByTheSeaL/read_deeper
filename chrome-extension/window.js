/*
 * The fallback for pages that won't take the overlay (chrome:// pages, the
 * Web Store, some PDF views): the same panel in a small window of its own.
 */

const params = new URLSearchParams(location.search);
const panel  = window.ReadDeeperPanel.mount(document.getElementById("panel"), { mode: "window" });

panel.lookUp({
	text        : params.get("q") || "",
	context     : "",
	sourceUrl   : params.get("url") || "",
	sourceTitle : params.get("title") || ""
});
