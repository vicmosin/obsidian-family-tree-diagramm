import { Modal, Notice, requestUrl, TFile } from "obsidian";
import type FamilyTreePlugin from "./main";
import { Coords, Place } from "./places";

interface Candidate {
	place: Place;
	status: "waiting" | "searching" | "found" | "not-found" | "error";
	coords?: Coords;
	label?: string;
	accept: boolean;
}

/** Looks up coordinates on OpenStreetMap (Nominatim), one request per second as its usage policy requires */
export class GeocodeModal extends Modal {
	private candidates: Candidate[];
	private running = false;
	private cancelled = false;

	constructor(
		private plugin: FamilyTreePlugin,
		places: Place[]
	) {
		super(plugin.app);
		this.candidates = places.map((place) => ({ place, status: "waiting", accept: false }));
	}

	onOpen() {
		this.titleEl.setText("Find coordinates for places");
		this.render();
	}

	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ft-geo");
		contentEl.createEl("p", {
			cls: "ft-check-hint",
			text:
				"Place names (not people) are sent to OpenStreetMap's search. Check each match before saving — old or renamed places can be found in the wrong country. " +
				"Places with a note get `location: [lat, lng]` in that note; others are remembered by the plugin.",
		});

		const table = contentEl.createEl("table", { cls: "ft-geo-table" });
		for (const c of this.candidates) {
			const tr = table.createEl("tr");
			const cb = tr.createEl("td").createEl("input", { type: "checkbox" });
			cb.checked = c.accept;
			cb.disabled = c.status !== "found";
			cb.onchange = () => (c.accept = cb.checked);
			tr.createEl("td", { cls: "ft-geo-name", text: c.place.name });
			const result = tr.createEl("td", { cls: "ft-geo-result" });
			if (c.status === "found") {
				result.createSpan({ text: c.label ?? "" });
				const link = result.createEl("a", {
					text: " View on map ↗",
					href: `https://www.openstreetmap.org/?mlat=${c.coords![0]}&mlon=${c.coords![1]}#map=10/${c.coords![0]}/${c.coords![1]}`,
				});
				link.setAttr("target", "_blank");
			} else {
				result.setText(
					{ waiting: "", searching: "searching…", "not-found": "not found — add `location: [lat, lng]` to the place note by hand", error: "network error" }[c.status]
				);
			}
		}

		const buttons = contentEl.createDiv("ft-check-actions");
		const search = buttons.createEl("button", { text: this.running ? "Searching…" : "Search", cls: this.anyFound() ? "" : "mod-cta" });
		search.disabled = this.running;
		search.onclick = () => this.search();
		const save = buttons.createEl("button", { text: "Save selected", cls: this.anyFound() ? "mod-cta" : "" });
		save.disabled = this.running || !this.candidates.some((c) => c.accept);
		save.onclick = () => this.save();
	}

	private anyFound() {
		return this.candidates.some((c) => c.status === "found");
	}

	private async search() {
		this.running = true;
		for (const c of this.candidates) {
			if (this.cancelled) return;
			if (c.status === "found") continue;
			c.status = "searching";
			this.render();
			try {
				const url =
					"https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru,en&q=" + encodeURIComponent(c.place.name);
				const res = await requestUrl({ url, headers: { "User-Agent": "Obsidian-Family-Tree-Diagram/0.1 (personal genealogy notes)" } });
				const hit = (res.json as { lat: string; lon: string; display_name: string }[])[0];
				if (hit) {
					c.status = "found";
					c.coords = [Number(Number(hit.lat).toFixed(5)), Number(Number(hit.lon).toFixed(5))];
					c.label = hit.display_name;
					c.accept = true;
				} else c.status = "not-found";
			} catch {
				c.status = "error";
			}
			this.render();
			await sleep(1100);
		}
		this.running = false;
		this.render();
	}

	private async save() {
		let notes = 0;
		let cached = 0;
		for (const c of this.candidates) {
			if (!c.accept || !c.coords) continue;
			const file = c.place.notePath ? this.app.vault.getAbstractFileByPath(c.place.notePath) : null;
			if (file instanceof TFile) {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					fm.location = c.coords;
				});
				notes++;
			} else {
				this.plugin.settings.placeCache[c.place.key] = c.coords;
				cached++;
			}
		}
		await this.plugin.saveSettings();
		new Notice(`Saved coordinates: ${notes} in place notes, ${cached} in plugin data`);
		this.close();
	}
}

function sleep(ms: number) {
	return new Promise((r) => window.setTimeout(r, ms));
}
