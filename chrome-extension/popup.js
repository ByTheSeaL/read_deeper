/* The toolbar popup: a search box over the same panel, plus recent lookups to reopen. */

const panel = window.ReadDeeperPanel.mount(document.getElementById("panel"), {
	mode         : "popup",
	onLookupDone : () => loadRecent()
});

document.getElementById("settings").addEventListener("click", (event) => {
	event.preventDefault();
	chrome.runtime.openOptionsPage();
});

async function loadRecent() {
	const response = await chrome.runtime.sendMessage({ type: "recent", limit: 15 });
	const lookups  = response && response.ok ? response.result : [];
	const list     = document.getElementById("recent-list");

	document.getElementById("recent").hidden = !lookups.length;

	list.replaceChildren(...lookups.map((lookup) => {
		const item = document.createElement("button");

		item.className = "recent-item";
		item.innerHTML = '<span class="term"></span> <span class="where"></span><span class="gist"></span>';
		item.querySelector(".term").textContent  = lookup.text.length > 60 ? `${lookup.text.slice(0, 59)}…` : lookup.text;
		item.querySelector(".where").textContent = `· ${lookup.channelName}`;
		item.querySelector(".gist").textContent  = lookup.gist;
		item.addEventListener("click", () => {
			panel.show(lookup);
			window.scrollTo(0, 0);
		});

		return item;
	}));
}

panel.focus();
loadRecent();
