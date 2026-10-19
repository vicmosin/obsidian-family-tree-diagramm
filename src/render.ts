import { Layout, LayoutNode } from "./layout";
import { Person, stripLinks } from "./model";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

export interface RendererCallbacks {
	onOpen(person: Person, newTab: boolean): void;
	onCreate(person: Person): void;
	onFocus?(person: Person): void;
	onContextMenu?(person: Person, e: MouseEvent): void;
}

export interface RenderExtras {
	/** Relationship badge per person */
	labels?: Map<string, string>;
	/** Reference person of the labels ("me") */
	reference?: string;
	/** People connecting the reference person to `id`, for hover highlighting */
	pathTo?(id: string): string[] | undefined;
}

export interface RendererOptions {
	/** Embedded in a note: plain wheel scrolls the note, ctrl/cmd + wheel zooms */
	embedded: boolean;
}

interface Transform {
	x: number;
	y: number;
	k: number;
}

export class TreeRenderer {
	readonly svg: SVGSVGElement;
	private world: SVGGElement;
	private t: Transform = { x: 0, y: 0, k: 1 };
	private layout?: Layout;
	private highlight?: string;
	private nodeEls = new Map<string, SVGGElement>();
	private edgeEls: { el: SVGElement; pairs: [string, string][] }[] = [];
	private extras: RenderExtras = {};
	private dragged = false;
	private cleanups: (() => void)[] = [];

	constructor(
		private container: HTMLElement,
		private cb: RendererCallbacks,
		private opts: RendererOptions
	) {
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.classList.add("ft-svg");
		this.world = el("g", { class: "ft-world" });
		this.svg.appendChild(this.world);
		container.appendChild(this.svg);
		this.bindPanZoom();
	}

	setData(layout: Layout, highlight?: string, keepView = false, extras: RenderExtras = {}) {
		this.layout = layout;
		this.highlight = highlight;
		this.extras = extras;
		this.draw();
		if (!keepView) {
			if (highlight && layout.nodes.has(highlight)) this.centerOn(highlight, false);
			else this.fit();
		}
	}

	setHighlight(id?: string) {
		if (this.highlight) this.nodeEls.get(this.highlight)?.classList.remove("is-active");
		this.highlight = id;
		if (id) this.nodeEls.get(id)?.classList.add("is-active");
	}

	fit() {
		if (!this.layout) return;
		const { width, height } = this.size();
		const lw = Math.max(this.layout.width, 1);
		const lh = Math.max(this.layout.height, 1);
		const k = clamp(Math.min(width / lw, height / lh), 0.1, 1.2);
		this.t = { k, x: (width - lw * k) / 2, y: (height - lh * k) / 2 };
		this.apply();
	}

	centerOn(id: string, animate = true) {
		const n = this.layout?.nodes.get(id);
		if (!n) return;
		const { width, height } = this.size();
		const k = Math.max(this.t.k, 0.8);
		this.t = { k, x: width / 2 - n.x * k, y: height / 2 - n.y * k };
		this.apply(animate);
	}

	zoomBy(factor: number) {
		const { width, height } = this.size();
		this.zoomAt(width / 2, height / 2, factor, true);
	}

	destroy() {
		this.cleanups.forEach((f) => f());
		this.svg.remove();
	}

	private size() {
		const r = this.svg.getBoundingClientRect();
		return { width: r.width || this.container.clientWidth || 800, height: r.height || this.container.clientHeight || 600 };
	}

	private apply(animate = false) {
		this.world.classList.toggle("is-animating", animate);
		this.world.setAttribute("transform", `translate(${this.t.x},${this.t.y}) scale(${this.t.k})`);
	}

	private zoomAt(px: number, py: number, factor: number, animate = false) {
		const k = clamp(this.t.k * factor, 0.1, 3);
		const f = k / this.t.k;
		this.t = { k, x: px - (px - this.t.x) * f, y: py - (py - this.t.y) * f };
		this.apply(animate);
	}

	private bindPanZoom() {
		const svg = this.svg;
		let start: { x: number; y: number; tx: number; ty: number } | null = null;
		const pointers = new Map<number, { x: number; y: number }>();
		let pinchDist = 0;

		const on = <K extends keyof SVGElementEventMap>(
			target: SVGElement,
			type: K,
			fn: (e: SVGElementEventMap[K]) => void,
			o?: AddEventListenerOptions
		) => {
			target.addEventListener(type, fn, o);
			this.cleanups.push(() => target.removeEventListener(type, fn, o));
		};

		on(svg, "pointerdown", (e) => {
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 1) {
				start = { x: e.clientX, y: e.clientY, tx: this.t.x, ty: this.t.y };
				this.dragged = false;
			} else if (pointers.size === 2) {
				const [a, b] = [...pointers.values()];
				pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
			}
		});
		on(svg, "pointermove", (e) => {
			if (!pointers.has(e.pointerId)) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.size === 2) {
				const [a, b] = [...pointers.values()];
				const d = Math.hypot(a.x - b.x, a.y - b.y);
				const r = svg.getBoundingClientRect();
				if (pinchDist) this.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinchDist);
				pinchDist = d;
				this.dragged = true;
				return;
			}
			if (!start) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (!this.dragged && Math.hypot(dx, dy) < 4) return;
			if (!this.dragged) {
				this.dragged = true;
				svg.setPointerCapture(e.pointerId);
				svg.classList.add("is-panning");
			}
			this.t.x = start.tx + dx;
			this.t.y = start.ty + dy;
			this.apply();
		});
		const end = (e: PointerEvent) => {
			pointers.delete(e.pointerId);
			if (pointers.size === 0) {
				start = null;
				svg.classList.remove("is-panning");
			}
		};
		on(svg, "pointerup", end);
		on(svg, "pointercancel", end);
		on(
			svg,
			"wheel",
			(e) => {
				if (this.opts.embedded && !(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				const r = svg.getBoundingClientRect();
				// Trackpad pinch arrives as ctrl+wheel with small deltas
				const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
				this.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
			},
			{ passive: false }
		);
	}

	private draw() {
		const layout = this.layout!;
		this.world.replaceChildren();
		this.nodeEls.clear();
		this.edgeEls = [];
		const edges = el("g", { class: "ft-edges" });
		const joints = el("g", { class: "ft-joints" });
		const nodes = el("g", { class: "ft-nodes" });
		this.world.append(edges, joints, nodes);

		const edge = (d: string, cls: string, pairs: [string, string][]) => {
			const e = el("path", { d, class: "ft-edge " + cls });
			edges.appendChild(e);
			this.edgeEls.push({ el: e, pairs });
			return e;
		};

		const lanes = assignLanes(layout);
		for (const u of layout.unions) {
			const kids = u.children.map((c) => layout.nodes.get(c)!).filter(Boolean);
			const partners = u.partners.map((p) => layout.nodes.get(p)!).filter(Boolean);
			const partnerCls = "ft-edge-partner" + (u.uncertainMarriage ? " is-uncertain" : "") + (u.married ? "" : " is-unmarried");
			const withKids = (p: string): [string, string][] => [...u.partners.filter((o) => o !== p).map((o): [string, string] => [p, o]), ...u.children.map((c): [string, string] => [p, c])];

			if (u.kind === "couple") {
				const [a, b] = partners;
				edge(`M${a.x + a.w / 2},${u.y} H${u.x}`, partnerCls, withKids(a.id));
				edge(`M${u.x},${u.y} H${b.x - b.w / 2}`, partnerCls, withKids(b.id));
			} else if (u.kind === "loose") {
				for (const p of partners) edge(`M${p.x},${p.y + p.h / 2} V${u.y} H${u.x}`, partnerCls, withKids(p.id));
			}

			if (kids.length) {
				const top = Math.min(...kids.map((k) => k.y - k.h / 2));
				const mid = top - 14 - (lanes.get(u.id) ?? 0) * 12;
				for (const k of kids) {
					const uncertain = u.uncertainChildren.has(k.id);
					const pairs: [string, string][] = u.partners.map((p): [string, string] => [p, k.id]);
					// Siblings are connected through the family bar
					pairs.push(...u.children.filter((c) => c !== k.id).map((c): [string, string] => [k.id, c]));
					const cls = "ft-edge-child" + (u.kind === "virtual" ? " is-virtual" : "") + (uncertain ? " is-uncertain" : "");
					edge(`M${u.x},${u.y} V${mid} H${k.x} V${k.y - k.h / 2}`, cls, pairs);
					if (uncertain) {
						const q = el("text", { x: k.x + 8, y: mid + 15, class: "ft-question" });
						q.textContent = "?";
						edges.appendChild(q);
					}
				}
			}
			if (u.kind === "couple" && u.uncertainMarriage) {
				const q = el("text", { x: u.x, y: u.y - 8, class: "ft-question", "text-anchor": "middle" });
				q.textContent = "?";
				edges.appendChild(q);
			}
			if (u.kind !== "single" && (kids.length || u.kind === "couple")) {
				const c = el("circle", { cx: u.x, cy: u.y, r: u.kind === "virtual" ? 5 : 3.5, class: "ft-joint" + (u.kind === "virtual" ? " is-virtual" : "") });
				if (u.kind === "virtual") c.appendChild(title("Siblings — parents unknown"));
				joints.appendChild(c);
			}
		}

		for (const n of layout.nodes.values()) nodes.appendChild(this.drawNode(n));
	}

	private showPath(id?: string) {
		const path = id ? this.extras.pathTo?.(id) : undefined;
		const on = new Set(path ?? []);
		this.svg.classList.toggle("has-path", on.size > 1);
		for (const [nid, e] of this.nodeEls) e.classList.toggle("on-path", on.has(nid));
		for (const { el, pairs } of this.edgeEls) el.classList.toggle("on-path", pairs.some(([a, b]) => on.has(a) && on.has(b)));
	}

	private drawNode(n: LayoutNode): SVGGElement {
		const p = n.person;
		const cls = ["ft-node"];
		if (p.ghost) cls.push("is-ghost");
		if (p.gender) cls.push(p.gender === "m" ? "is-male" : "is-female");
		if (p.id === this.highlight) cls.push("is-active");
		if (p.id === this.extras.reference) cls.push("is-reference");
		if (p.death) cls.push("is-deceased");

		const g = el("g", { class: cls.join(" "), transform: `translate(${n.x - n.w / 2},${n.y - n.h / 2})` });
		g.dataset.id = p.id;
		g.appendChild(el("rect", { class: "ft-card", width: n.w, height: n.h, rx: 10, ry: 10 }));
		g.appendChild(el("rect", { class: "ft-stripe", width: 5, height: n.h - 16, x: 0, y: 8, rx: 2.5 }));

		const fo = el("foreignObject", { x: 0, y: 0, width: n.w, height: n.h });
		const box = html("div", "ft-box");
		if (p.photo) {
			const img = html("img", "ft-photo") as HTMLImageElement;
			img.src = p.photo;
			img.draggable = false;
			box.appendChild(img);
		} else {
			const ph = html("div", "ft-photo ft-photo-empty");
			ph.textContent = initials(p.name);
			box.appendChild(ph);
		}
		const text = html("div", "ft-text");
		const nm = html("div", "ft-name");
		nm.textContent = p.name;
		text.appendChild(nm);
		if (p.altNames) {
			const alt = html("div", "ft-alt");
			alt.textContent = `(${p.altNames})`;
			text.appendChild(alt);
		}
		const dates = lifespan(p);
		if (dates || p.ghost) {
			const d = html("div", "ft-dates");
			d.textContent = p.ghost ? "no note yet" : dates!;
			text.appendChild(d);
		}
		box.appendChild(text);
		fo.appendChild(box);
		g.appendChild(fo);

		const label = this.extras.labels?.get(p.id);
		if (label) {
			const lfo = el("foreignObject", { x: 0, y: -11, width: n.w - 10, height: 22, class: "ft-label-fo" });
			const wrap = html("div", "ft-label-wrap");
			const pill = html("span", "ft-label");
			pill.textContent = label;
			wrap.appendChild(pill);
			lfo.appendChild(wrap);
			g.appendChild(lfo);
		}
		g.appendChild(title(tooltip(p, label)));

		g.addEventListener("click", (e) => {
			if (this.dragged) return;
			if (p.ghost) this.cb.onCreate(p);
			else this.cb.onOpen(p, e.ctrlKey || e.metaKey);
		});
		g.addEventListener("contextmenu", (e) => {
			if (!this.cb.onContextMenu) return;
			e.preventDefault();
			e.stopPropagation();
			this.cb.onContextMenu(p, e);
		});
		g.addEventListener("mouseenter", () => this.showPath(p.id));
		g.addEventListener("mouseleave", () => this.showPath());
		this.nodeEls.set(p.id, g);
		return g;
	}
}

/** Families whose horizontal bars would overlap on the same row get different heights */
function assignLanes(layout: Layout): Map<string, number> {
	const rows = new Map<number, { id: string; from: number; to: number }[]>();
	for (const u of layout.unions) {
		const kids = u.children.map((c) => layout.nodes.get(c)).filter((k): k is LayoutNode => !!k);
		if (!kids.length) continue;
		const top = Math.round(Math.min(...kids.map((k) => k.y - k.h / 2)));
		const xs = [u.x, ...kids.map((k) => k.x)];
		(rows.get(top) ?? rows.set(top, []).get(top)!).push({ id: u.id, from: Math.min(...xs), to: Math.max(...xs) });
	}
	const lanes = new Map<string, number>();
	for (const spans of rows.values()) {
		spans.sort((a, b) => a.from - b.from);
		const laneEnds: number[] = [];
		for (const sp of spans) {
			let lane = laneEnds.findIndex((end) => end + 12 < sp.from);
			if (lane < 0) lane = laneEnds.length;
			laneEnds[lane] = sp.to;
			lanes.set(sp.id, Math.min(lane, 3));
		}
	}
	return lanes;
}

export function lifespan(p: Person): string | undefined {
	const b = p.birthInfo?.label;
	// A death entry without a year ("умер на войне") still means the person is deceased
	const d = p.deathInfo ? p.deathInfo.label ?? "†" : undefined;
	if (!b && !d) return undefined;
	if (!d) return `${b} –`;
	return `${b ?? "?"} – ${d}`;
}

function tooltip(p: Person, label?: string): string {
	const lines = [label ? `${p.fullName} — ${label}` : p.fullName];
	if (p.birth || p.birthPlace) lines.push(`* ${[p.birth, stripLinks(p.birthPlace)].filter(Boolean).join(", ")}`);
	if (p.death || p.deathPlace) lines.push(`† ${[p.death, stripLinks(p.deathPlace)].filter(Boolean).join(", ")}`);
	lines.push(p.ghost ? "Click to create a note" : "Click to open · Ctrl/Cmd+click: new tab · Right-click: more");
	return lines.join("\n");
}

function initials(name: string): string {
	const w = name.split(/\s+/).filter(Boolean);
	return ((w[0]?.[0] ?? "") + (w.length > 2 ? w[2][0] : w[1]?.[0] ?? "")).toUpperCase();
}

function clamp(v: number, lo: number, hi: number) {
	return Math.max(lo, Math.min(hi, v));
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	return e;
}

function html(tag: string, cls: string): HTMLElement {
	const e = document.createElementNS(XHTML_NS, tag);
	e.className = cls;
	return e;
}

function title(text: string) {
	const t = el("title");
	t.textContent = text;
	return t;
}
