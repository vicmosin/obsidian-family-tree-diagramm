import L from "leaflet";
import leafletCss from "leaflet/dist/leaflet.css";
import { feature } from "topojson-client";
import type { FeatureCollection } from "geojson";
import countries from "world-atlas/countries-50m.json";
import { FamilyGraph } from "./model";
import { lifePath, Place, PlaceEvent } from "./places";
import { RenderExtras, RendererCallbacks } from "./render";

export interface MapData {
	graph: FamilyGraph;
	visible: Set<string>;
	places: Map<string, Place>;
	extras?: RenderExtras;
	highlight?: string;
	thisYear?: number;
}

export interface MapHooks {
	/** Places mentioned in notes but without coordinates: offer to look them up */
	onLocate?(): void;
	onOpenPath?(path: string): void;
}

const CSS_ID = "ft-leaflet-css";
const ROLE_ICON: Record<PlaceEvent["role"], string> = { birth: "★", lived: "⌂", death: "†" };
const ROLE_ORDER: Record<PlaceEvent["role"], number> = { birth: 0, lived: 1, death: 2 };

/** Leaflet's stylesheet is injected while a map is open; removed on plugin unload */
export function ensureLeafletCss() {
	if (document.getElementById(CSS_ID)) return;
	const style = document.head.appendChild(document.createElement("style"));
	style.id = CSS_ID;
	style.textContent = leafletCss;
}

export function removeLeafletCss() {
	document.getElementById(CSS_ID)?.remove();
}

let outline: FeatureCollection | undefined;
function worldOutline(): FeatureCollection {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const topo = countries as any;
	outline ??= feature(topo, topo.objects.countries) as unknown as FeatureCollection;
	return outline;
}

export class MapRenderer {
	private el: HTMLElement;
	private map: L.Map;
	private layers = L.layerGroup();
	private tiles?: L.TileLayer;
	private statusEl: HTMLElement;
	private locateEl: HTMLElement;
	private slider: HTMLInputElement;
	private sliderLabel: HTMLElement;
	private yearTo?: number;
	private data?: MapData;
	private tilesLoaded = 0;
	private resizeObserver: ResizeObserver;
	private onOnline = () => this.addTiles();

	constructor(
		container: HTMLElement,
		private cb: RendererCallbacks,
		private opts: { embedded: boolean },
		private hooks: MapHooks = {}
	) {
		ensureLeafletCss();
		this.el = container.appendChild(document.createElement("div"));
		this.el.className = "ft-map";
		const mapEl = this.el.appendChild(document.createElement("div"));
		mapEl.className = "ft-map-leaflet";

		this.map = L.map(mapEl, {
			zoomControl: false,
			worldCopyJump: true,
			scrollWheelZoom: !opts.embedded,
			minZoom: 2,
			maxZoom: 17,
		}).setView([50, 30], 4);
		this.map.attributionControl.setPrefix("");

		// Offline base: country borders bundled with the plugin, drawn below the online tiles
		const pane = this.map.createPane("ft-outline");
		pane.style.zIndex = "150";
		L.geoJSON(worldOutline(), { pane: "ft-outline", interactive: false, style: () => ({ className: "ft-map-land" }) }).addTo(this.map);
		this.layers.addTo(this.map);

		// Overlay controls
		const top = this.el.appendChild(document.createElement("div"));
		top.className = "ft-map-controls";
		this.statusEl = top.appendChild(document.createElement("span"));
		this.statusEl.className = "ft-map-status";
		this.locateEl = top.appendChild(document.createElement("button"));
		this.locateEl.className = "ft-map-locate";
		this.locateEl.onclick = () => this.hooks.onLocate?.();

		const bottom = this.el.appendChild(document.createElement("div"));
		bottom.className = "ft-map-time";
		this.sliderLabel = bottom.appendChild(document.createElement("span"));
		this.slider = bottom.appendChild(document.createElement("input"));
		this.slider.type = "range";
		this.slider.oninput = () => {
			const v = Number(this.slider.value);
			this.yearTo = v >= Number(this.slider.max) ? undefined : v;
			this.updateSliderLabel();
			this.draw();
		};
		// Keep map gestures off the controls
		for (const c of [top, bottom]) L.DomEvent.disableClickPropagation(c), L.DomEvent.disableScrollPropagation(c);

		if (navigator.onLine) this.addTiles();
		else this.setStatus("Offline — built-in map");
		window.addEventListener("online", this.onOnline);

		this.resizeObserver = new ResizeObserver(() => this.map.invalidateSize());
		this.resizeObserver.observe(this.el);
	}

	setData(data: MapData, keepView = false) {
		this.data = data;
		this.setupSlider();
		this.draw();
		const missing = [...data.places.values()].filter((p) => !p.coords).length;
		this.locateEl.textContent = `📍 ${missing} place${missing === 1 ? "" : "s"} without coordinates — find…`;
		this.locateEl.toggleAttribute("hidden", missing === 0 || !this.hooks.onLocate);
		if (!keepView) requestAnimationFrame(() => (data.highlight && this.hasStops(data.highlight) ? this.centerOn(data.highlight) : this.fit()));
	}

	setHighlight(id?: string) {
		if (!this.data) return;
		this.data.highlight = id;
		this.draw();
	}

	centerOn(id: string) {
		if (!this.data) return;
		this.setHighlight(id);
		const coords = lifePath(id, this.data.places).map((s) => s.place.coords!);
		if (!coords.length) return;
		if (coords.length === 1) this.map.setView(coords[0], Math.max(this.map.getZoom(), 7));
		else this.map.fitBounds(L.latLngBounds(coords), { padding: [60, 60], maxZoom: 8 });
	}

	zoomBy(f: number) {
		if (f > 1) this.map.zoomIn();
		else this.map.zoomOut();
	}

	fit() {
		this.map.invalidateSize();
		const coords = [...(this.data?.places.values() ?? [])].filter((p) => p.coords).map((p) => p.coords!);
		if (!coords.length) this.map.setView([50, 30], 4);
		else if (coords.length === 1) this.map.setView(coords[0], 7);
		else this.map.fitBounds(L.latLngBounds(coords), { padding: [50, 50], maxZoom: 9 });
	}

	destroy() {
		window.removeEventListener("online", this.onOnline);
		this.resizeObserver.disconnect();
		this.map.remove();
		this.el.remove();
	}

	private addTiles() {
		if (this.tiles) return;
		this.tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
		});
		this.tiles.on("tileload", () => {
			this.tilesLoaded++;
			this.setStatus("");
		});
		this.tiles.on("tileerror", () => {
			if (!this.tilesLoaded) this.setStatus("Offline — built-in map");
		});
		this.tiles.addTo(this.map);
		this.setStatus("");
	}

	private setStatus(text: string) {
		this.statusEl.textContent = text;
		this.statusEl.toggleAttribute("hidden", !text);
		this.el.classList.toggle("is-offline", !!text);
	}

	private hasStops(id: string) {
		return !!this.data && lifePath(id, this.data.places).length > 0;
	}

	private setupSlider() {
		const data = this.data!;
		const thisYear = data.thisYear ?? new Date().getFullYear();
		const years = [...data.places.values()].flatMap((p) => p.events.map((e) => e.year)).filter((y): y is number => y != null);
		const min = years.length ? Math.min(...years) : thisYear - 100;
		this.slider.min = String(min);
		this.slider.max = String(thisYear);
		this.slider.value = String(this.yearTo ?? thisYear);
		this.slider.parentElement!.toggleAttribute("hidden", years.length < 2);
		this.updateSliderLabel();
	}

	private updateSliderLabel() {
		this.sliderLabel.textContent = this.yearTo ? `up to ${this.yearTo}` : "all years";
	}

	private shown(e: PlaceEvent) {
		return this.yearTo == null || e.year == null || e.year <= this.yearTo;
	}

	private draw() {
		const data = this.data;
		if (!data) return;
		this.layers.clearLayers();
		const g = data.graph;
		const hl = data.highlight;

		// Life routes: birth → places lived → death
		for (const id of data.visible) {
			const stops = lifePath(id, data.places).filter((s) => this.shown(s.event));
			const coords: L.LatLngTuple[] = [];
			for (const s of stops) {
				const c = s.place.coords!;
				const last = coords[coords.length - 1];
				if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
			}
			if (coords.length < 2) continue;
			const p = g.persons.get(id)!;
			const cls = ["ft-map-route"];
			if (p.gender) cls.push(p.gender === "m" ? "is-male" : "is-female");
			if (stops.some((s) => s.event.uncertain)) cls.push("is-uncertain");
			if (id === hl) cls.push("is-active");
			L.polyline(coords, { className: cls.join(" "), weight: id === hl ? 4 : 2.5 })
				.bindTooltip(this.personText(id), { sticky: true, className: "ft-map-tip" })
				.on("click", () => this.cb.onOpen(p, false))
				.addTo(this.layers);
		}

		// Pins
		for (const place of data.places.values()) {
			if (!place.coords) continue;
			const events = place.events.filter((e) => this.shown(e));
			if (!events.length) continue;
			const people = new Set(events.map((e) => e.person));
			const cls = ["ft-map-pin"];
			if (hl && people.has(hl)) cls.push("is-active");
			if (events.every((e) => e.uncertain)) cls.push("is-uncertain");
			L.circleMarker(place.coords, { radius: 5 + Math.sqrt(people.size) * 2.5, className: cls.join(" ") })
				.bindTooltip(place.name.split(",")[0], { permanent: true, direction: "right", offset: [8, 0], className: "ft-map-label" })
				.bindPopup(() => this.popup(place, events), { className: "ft-map-popup", maxWidth: 320 })
				.addTo(this.layers);
		}
	}

	private personText(id: string) {
		const p = this.data!.graph.persons.get(id)!;
		const kin = this.data!.extras?.labels?.get(id);
		return kin ? `${p.name} · ${kin}` : p.name;
	}

	private popup(place: Place, events: PlaceEvent[]): HTMLElement {
		const root = document.createElement("div");
		const h = root.appendChild(document.createElement("div"));
		h.className = "ft-map-popup-title";
		h.textContent = place.name;
		if (place.notePath && this.hooks.onOpenPath) {
			h.classList.add("is-link");
			h.onclick = () => this.hooks.onOpenPath!(place.notePath!);
		}
		const list = root.appendChild(document.createElement("ul"));
		const sorted = [...events].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.year ?? 9999) - (b.year ?? 9999));
		for (const e of sorted) {
			const p = this.data!.graph.persons.get(e.person)!;
			const li = list.appendChild(document.createElement("li"));
			const icon = li.appendChild(document.createElement("span"));
			icon.className = "ft-map-role";
			icon.textContent = ROLE_ICON[e.role];
			icon.title = e.role === "birth" ? "born" : e.role === "death" ? "died" : "lived";
			const year = li.appendChild(document.createElement("span"));
			year.className = "ft-map-year";
			year.textContent = e.year ? (e.to && e.to !== e.year ? `${e.year}–${e.to}` : String(e.year)) : "";
			const a = li.appendChild(document.createElement("a"));
			a.textContent = p.name + (e.uncertain ? " ?" : "");
			a.onclick = () => (p.ghost ? this.cb.onCreate(p) : this.cb.onOpen(p, false));
			const kin = this.data!.extras?.labels?.get(e.person);
			if (kin) {
				const k = li.appendChild(document.createElement("span"));
				k.className = "ft-map-kin";
				k.textContent = kin;
			}
		}
		return root;
	}
}
