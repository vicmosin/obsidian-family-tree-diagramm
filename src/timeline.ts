import { computeLayout, DEFAULT_LAYOUT } from "./layout";
import { FamilyGraph, Person } from "./model";
import { RenderExtras, RendererCallbacks } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface HistEvent {
	from: number;
	to: number;
	label: string;
}

export type TimelineOrder = "birth" | "family";

export interface TimelineData {
	graph: FamilyGraph;
	visible: Set<string>;
	extras?: RenderExtras;
	events: HistEvent[];
	order: TimelineOrder;
	highlight?: string;
	thisYear?: number;
	inferSpouseParent?: boolean;
}

/** "1941-1945 Великая Отечественная война", one per line */
export function parseEvents(text: string): HistEvent[] {
	const out: HistEvent[] = [];
	for (const line of text.split("\n")) {
		const m = line.trim().match(/^(\d{4})(?:\s*[-–—]\s*(\d{4}))?\s+(.+)$/);
		if (m) out.push({ from: Number(m[1]), to: Number(m[2] ?? m[1]), label: m[3].trim() });
	}
	return out;
}

export const DEFAULT_EVENTS_RU = [
	"1914-1918 Первая мировая война",
	"1917 Революция",
	"1918-1922 Гражданская война",
	"1932-1933 Голод",
	"1941-1945 Великая Отечественная война",
	"1986 Чернобыль",
	"1991 Распад СССР",
].join("\n");

export interface Row {
	person: Person;
	/** Drawn span; may be estimated */
	start: number;
	end: number;
	startFuzzy: boolean;
	endFuzzy: boolean;
	alive: boolean;
}

const MAX_AGE_ALIVE = 105;
const UNKNOWN_SPAN = 60;

/** People with at least one known year, with estimated ends where needed */
export function buildRows(
	g: FamilyGraph,
	visible: Set<string>,
	order: TimelineOrder,
	thisYear: number,
	inferSpouseParent = true
): { rows: Row[]; undated: Person[] } {
	const rows: Row[] = [];
	const undated: Person[] = [];
	for (const id of visible) {
		const p = g.persons.get(id)!;
		const b = p.birthInfo?.year;
		const d = p.deathInfo?.year;
		if (b == null && d == null) {
			undated.push(p);
			continue;
		}
		const hasDeath = !!p.deathInfo;
		if (b != null && d != null) {
			rows.push({ person: p, start: b, end: Math.max(d, b), startFuzzy: !!p.birthInfo?.approx, endFuzzy: !!p.deathInfo?.approx, alive: false });
		} else if (b != null) {
			const alive = !hasDeath && thisYear - b <= MAX_AGE_ALIVE;
			const end = alive ? thisYear : Math.min(b + UNKNOWN_SPAN, thisYear);
			rows.push({ person: p, start: b, end, startFuzzy: !!p.birthInfo?.approx, endFuzzy: !alive, alive });
		} else {
			rows.push({ person: p, start: d! - UNKNOWN_SPAN, end: d!, startFuzzy: true, endFuzzy: !!p.deathInfo?.approx, alive: false });
		}
	}

	if (order === "birth") rows.sort((a, b) => a.start - b.start || a.person.fullName.localeCompare(b.person.fullName));
	else {
		// Family order: same reading order as the tree (generation by generation, left to right),
		// so couples and siblings stay together
		const layout = computeLayout(g, visible, { ...DEFAULT_LAYOUT, inferSpouseParent });
		const pos = (r: Row) => layout.nodes.get(r.person.id)!;
		const out = [...rows].sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x);
		rows.splice(0, rows.length, ...out);
	}
	undated.sort((a, b) => a.fullName.localeCompare(b.fullName));
	return { rows, undated };
}

const ROW_H = 30;
const BAR_H = 18;
const AXIS = 34;
const SIDE = 24;

export class TimelineRenderer {
	readonly el: HTMLElement;
	private svg: SVGSVGElement;
	private undatedEl: HTMLElement;
	private zoom = 1;
	private data?: TimelineData;
	private rows: Row[] = [];
	private rowEls = new Map<string, SVGGElement>();
	private cursor?: SVGGElement;
	private scale = { min: 1900, max: 2030, px: 6 };
	/** Top of the first row: event labels + year axis */
	private top = AXIS;
	/** Masks and gradients are looked up document-wide, so ids must be unique per renderer */
	private uid = "ft" + Math.random().toString(36).slice(2, 8);

	constructor(
		container: HTMLElement,
		private cb: RendererCallbacks,
		private opts: { embedded: boolean }
	) {
		this.el = container.appendChild(document.createElement("div"));
		this.el.className = "ft-timeline" + (opts.embedded ? " is-embedded" : "");
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.classList.add("ft-tl-svg");
		this.el.appendChild(this.svg);
		this.undatedEl = document.createElement("div");
		this.undatedEl.className = "ft-tl-undated";
		this.el.appendChild(this.undatedEl);
		this.svg.addEventListener("mousemove", (e) => this.moveCursor(e));
		this.svg.addEventListener("mouseleave", () => this.cursor?.remove());
	}

	setData(data: TimelineData, keepView = false) {
		const scrollTop = this.el.scrollTop;
		const scrollLeft = this.el.scrollLeft;
		this.data = data;
		this.draw();
		if (keepView) {
			this.el.scrollTop = scrollTop;
			this.el.scrollLeft = scrollLeft;
		} else if (data.highlight) this.scrollTo(data.highlight, false);
	}

	setHighlight(id?: string) {
		for (const [rid, g] of this.rowEls) g.classList.toggle("is-active", rid === id);
		if (this.data) this.data.highlight = id;
	}

	scrollTo(id: string, smooth = true) {
		const i = this.rows.findIndex((r) => r.person.id === id);
		if (i < 0) return;
		const r = this.rows[i];
		this.el.scrollTo({
			top: this.top + i * ROW_H - this.el.clientHeight / 2,
			left: this.x(r.start) - this.el.clientWidth / 3,
			behavior: smooth ? "smooth" : "auto",
		});
	}

	centerOn(id: string) {
		this.setHighlight(id);
		this.scrollTo(id);
	}

	zoomBy(f: number) {
		this.zoom = Math.max(0.5, Math.min(6, this.zoom * f));
		this.draw();
	}

	fit() {
		this.zoom = 1;
		this.draw();
	}

	destroy() {
		this.el.remove();
	}

	private x(year: number) {
		return SIDE + (year - this.scale.min) * this.scale.px;
	}

	private draw() {
		const data = this.data;
		if (!data) return;
		const thisYear = data.thisYear ?? new Date().getFullYear();
		const { rows, undated } = buildRows(data.graph, data.visible, data.order, thisYear, data.inferSpouseParent ?? true);
		this.rows = rows;
		this.rowEls.clear();
		const svg = this.svg;
		svg.replaceChildren();

		const min = Math.floor((Math.min(...rows.map((r) => r.start), thisYear - 50) - 5) / 10) * 10;
		const max = Math.max(...rows.map((r) => r.end), thisYear) + 4;
		const avail = Math.max(300, (this.el.clientWidth || 900) - SIDE * 2);
		const px = (avail / (max - min)) * this.zoom;
		this.scale = { min, max, px };

		// Event labels stack in as many lines as needed so they don't overlap
		const laneEnds: number[] = [];
		const evLane = data.events.map((ev) => {
			const x1 = this.x(ev.from);
			let lane = laneEnds.findIndex((end) => end + 8 < x1);
			if (lane < 0) lane = laneEnds.length;
			laneEnds[lane] = x1 + ev.label.length * 6.2;
			return lane;
		});
		this.top = AXIS + laneEnds.length * 13 + 6;

		const width = SIDE * 2 + (max - min) * px;
		const height = this.top + rows.length * ROW_H + 12;
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));

		const defs = el("defs");
		defs.innerHTML = `
			<linearGradient id="${this.uid}-in"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient>
			<linearGradient id="${this.uid}-out"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
		svg.appendChild(defs);

		// Grid and axis
		const grid = el("g", { class: "ft-tl-grid" });
		const step = px * 10 >= 36 ? 10 : px * 25 >= 36 ? 25 : 50;
		for (let y = Math.ceil(min / step) * step; y <= max; y += step) {
			grid.appendChild(el("line", { x1: this.x(y), x2: this.x(y), y1: this.top - 6, y2: height, class: "ft-tl-gridline" }));
			grid.appendChild(text(String(y), { x: this.x(y), y: this.top - 12, class: "ft-tl-year", "text-anchor": "middle" }));
		}
		const now = el("line", { x1: this.x(thisYear), x2: this.x(thisYear), y1: this.top - 6, y2: height, class: "ft-tl-now" });
		grid.appendChild(now);
		svg.appendChild(grid);

		// Historical events
		const events = el("g", { class: "ft-tl-events" });
		data.events.forEach((ev, i) => {
			if (ev.to < min || ev.from > max) return;
			const x1 = this.x(ev.from);
			const w = Math.max(2, this.x(ev.to + 1) - x1);
			const band = el("rect", { x: x1, y: this.top - 4, width: w, height: height - this.top + 4, class: "ft-tl-event" });
			band.appendChild(title(`${ev.from}${ev.to !== ev.from ? "–" + ev.to : ""} ${ev.label}`));
			events.appendChild(band);
			const lbl = text(ev.label, { x: x1 + 3, y: 12 + evLane[i] * 13, class: "ft-tl-event-label" });
			lbl.appendChild(title(`${ev.from}${ev.to !== ev.from ? "–" + ev.to : ""} ${ev.label}`));
			events.appendChild(lbl);
		});
		svg.appendChild(events);

		// Lifelines
		const lines = el("g", { class: "ft-tl-rows" });
		const birthYear = new Map(rows.map((r) => [r.person.id, r.person.birthInfo?.year]));
		rows.forEach((r, i) => {
			const p = r.person;
			const y = this.top + i * ROW_H + (ROW_H - BAR_H) / 2;
			const cls = ["ft-tl-row"];
			if (p.gender) cls.push(p.gender === "m" ? "is-male" : "is-female");
			if (p.ghost) cls.push("is-ghost");
			if (p.id === data.highlight) cls.push("is-active");
			if (p.id === data.extras?.reference) cls.push("is-reference");
			const g = el("g", { class: cls.join(" ") });
			g.dataset.id = p.id;
			g.appendChild(el("rect", { x: 0, y: this.top + i * ROW_H, width, height: ROW_H, class: "ft-tl-hit" }));

			const x1 = this.x(r.start);
			const x2 = Math.max(this.x(r.end), x1 + 4);
			const mask = `${this.uid}-m${i}`;
			const fade = 5 * px;
			if (r.startFuzzy || r.endFuzzy) {
				const m = el("mask", { id: mask });
				m.appendChild(el("rect", { x: x1, y, width: x2 - x1, height: BAR_H, fill: "#fff" }));
				if (r.startFuzzy) m.appendChild(el("rect", { x: x1, y, width: Math.min(fade, (x2 - x1) / 2), height: BAR_H, fill: `url(#${this.uid}-in)` }));
				if (r.endFuzzy) m.appendChild(el("rect", { x: x2 - Math.min(fade, (x2 - x1) / 2), y, width: Math.min(fade, (x2 - x1) / 2), height: BAR_H, fill: `url(#${this.uid}-out)` }));
				// The plain white rect underneath would cancel the fades, so cut the faded parts out of it
				const base = m.firstChild as SVGRectElement;
				const left = r.startFuzzy ? Math.min(fade, (x2 - x1) / 2) : 0;
				const right = r.endFuzzy ? Math.min(fade, (x2 - x1) / 2) : 0;
				base.setAttribute("x", String(x1 + left));
				base.setAttribute("width", String(Math.max(0, x2 - x1 - left - right)));
				defs.appendChild(m);
			}
			const bar = el("rect", { x: x1, y, width: x2 - x1, height: BAR_H, rx: 4, class: "ft-tl-bar" });
			if (r.startFuzzy || r.endFuzzy) bar.setAttribute("mask", `url(#${mask})`);
			g.appendChild(bar);
			if (!r.startFuzzy) g.appendChild(el("rect", { x: x1, y, width: 3, height: BAR_H, rx: 1.5, class: "ft-tl-cap" }));
			if (r.alive) g.appendChild(el("path", { d: `M${x2},${y} l6,${BAR_H / 2} l-6,${BAR_H / 2} z`, class: "ft-tl-cap" }));

			// Children born: ticks on the parent's line
			for (const c of data.graph.get(data.graph.children, p.id)) {
				const cy = birthYear.get(c) ?? data.graph.persons.get(c)?.birthInfo?.year;
				if (cy == null || cy < r.start || cy > r.end) continue;
				const dot = el("circle", { cx: this.x(cy), cy: y + BAR_H / 2, r: 3, class: "ft-tl-child" });
				const child = data.graph.persons.get(c)!;
				dot.appendChild(title(`${cy}: ${child.name}${r.person.birthInfo?.year ? ` (${cy - r.person.birthInfo.year})` : ""}`));
				g.appendChild(dot);
			}

			const kin = data.extras?.labels?.get(p.id);
			// Near the right edge the label goes to the left of the bar instead
			const estWidth = (p.name.length + span(r).length + (kin ? kin.length + 4 : 0)) * 6.6;
			const flip = x1 + 8 + estWidth > width - 4 && x1 - 8 - estWidth > 0;
			const label = text("", flip ? { x: x1 - 8, y: y + BAR_H / 2 + 4, class: "ft-tl-name", "text-anchor": "end" } : { x: x1 + 8, y: y + BAR_H / 2 + 4, class: "ft-tl-name" });
			label.appendChild(tspan(p.name));
			label.appendChild(tspan("  " + span(r), "ft-tl-dates"));
			if (kin) label.appendChild(tspan("  · " + kin, "ft-tl-kin"));
			g.appendChild(label);
			g.appendChild(title([p.fullName, kin, span(r)].filter(Boolean).join("\n")));

			g.addEventListener("click", (e) => {
				if (p.ghost) this.cb.onCreate(p);
				else this.cb.onOpen(p, e.ctrlKey || e.metaKey);
			});
			g.addEventListener("contextmenu", (e) => {
				if (!this.cb.onContextMenu) return;
				e.preventDefault();
				this.cb.onContextMenu(p, e);
			});
			this.rowEls.set(p.id, g);
			lines.appendChild(g);
		});
		svg.appendChild(lines);

		this.undatedEl.replaceChildren();
		if (undated.length) {
			this.undatedEl.appendChild(document.createTextNode("No dates yet: "));
			undated.forEach((p, i) => {
				const a = document.createElement("a");
				a.textContent = p.name;
				a.className = "ft-tl-undated-name";
				a.onclick = () => (p.ghost ? this.cb.onCreate(p) : this.cb.onOpen(p, false));
				this.undatedEl.appendChild(a);
				if (i < undated.length - 1) this.undatedEl.appendChild(document.createTextNode(", "));
			});
		}
		if (!rows.length) {
			svg.appendChild(text("Add birth_date or death_date to person notes to see them here", { x: SIDE, y: this.top + 20, class: "ft-tl-empty" }));
		}
	}

	/** Vertical cursor showing the year and everyone's age at that moment */
	private moveCursor(e: MouseEvent) {
		const r = this.svg.getBoundingClientRect();
		const px = e.clientX - r.left;
		const year = Math.round(this.scale.min + (px - SIDE) / this.scale.px);
		if (year < this.scale.min || year > this.scale.max) return;
		this.cursor?.remove();
		const x = this.x(year);
		const g = el("g", { class: "ft-tl-cursor" });
		const h = Number(this.svg.getAttribute("height"));
		g.appendChild(el("line", { x1: x, x2: x, y1: this.top - 6, y2: h }));
		const badge = text(String(year), { x, y: this.top - 12, "text-anchor": "middle", class: "ft-tl-cursor-year" });
		g.appendChild(el("rect", { x: x - 20, y: this.top - 26, width: 40, height: 18, rx: 9, class: "ft-tl-cursor-bg" }));
		g.appendChild(badge);
		this.rows.forEach((row, i) => {
			const b = row.person.birthInfo?.year;
			if (b == null || year < row.start || year > row.end) return;
			const age = year - b;
			if (age < 0) return;
			const y = this.top + i * ROW_H + ROW_H / 2 + 4;
			g.appendChild(el("rect", { x: x + 4, y: y - 12, width: String(age).length * 7 + 8, height: 16, rx: 3, class: "ft-tl-age-bg" }));
			g.appendChild(text(String(age), { x: x + 8, y, class: "ft-tl-age" }));
		});
		this.svg.appendChild(g);
		this.cursor = g;
	}
}

function span(r: Row): string {
	const b = r.person.birthInfo?.label ?? "?";
	if (r.alive) {
		const age = r.person.birthInfo?.year != null ? ` (${(new Date().getFullYear()) - r.person.birthInfo.year})` : "";
		return `${b} –${age}`;
	}
	const d = r.person.deathInfo ? r.person.deathInfo.label ?? "†" : "?";
	const by = r.person.birthInfo?.year;
	const dy = r.person.deathInfo?.year;
	const age = by != null && dy != null ? ` (${dy - by})` : "";
	return `${b} – ${d}${age}`;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	return e;
}

function text(content: string, attrs: Record<string, string | number>) {
	const t = el("text", attrs);
	t.textContent = content;
	return t;
}

function tspan(content: string, cls?: string) {
	const t = el("tspan", cls ? { class: cls } : {});
	t.textContent = content;
	return t;
}

function title(s: string) {
	const t = el("title");
	t.textContent = s;
	return t;
}
