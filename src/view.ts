import { ItemView, MarkdownRenderChild, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { keepTouchesInside } from "./touch";
import { t } from "./i18n";
import type FamilyTreePlugin from "./main";
import { computeLayout } from "./layout";
import { FamilyGraph, focusSet } from "./model";
import { RenderExtras, TreeRenderer } from "./render";
import { parseEvents, TimelineOrder, TimelineRenderer } from "./timeline";
import { MapRenderer } from "./map";

export const VIEW_TYPE = "family-tree-view";

type Mode = "all" | "focus";
export type Display = "tree" | "timeline" | "map";
type AnyRenderer = TreeRenderer | TimelineRenderer | MapRenderer;

const DISPLAYS: { id: Display; icon: string }[] = [
	{ id: "tree", icon: "network" },
	{ id: "timeline", icon: "calendar-range" },
	{ id: "map", icon: "map" },
];

function createRenderer(plugin: FamilyTreePlugin, display: Display, container: HTMLElement, view: FamilyTreeView | undefined, embedded: boolean): AnyRenderer {
	const cb = plugin.callbacks(view);
	container.toggleClass("is-timeline", display === "timeline");
	container.toggleClass("is-map", display === "map");
	if (display === "timeline") return new TimelineRenderer(container, cb, { embedded });
	if (display === "map") {
		return new MapRenderer(container, cb, { embedded }, {
			onLocate: () => plugin.openGeocode(),
			onOpenPath: (path) => void plugin.app.workspace.openLinkText(path, "", "tab"),
		});
	}
	return new TreeRenderer(container, cb, { embedded });
}

function feedRenderer(
	plugin: FamilyTreePlugin,
	renderer: AnyRenderer,
	d: { visible: Set<string>; extras: RenderExtras; highlight?: string; order: TimelineOrder },
	keepView: boolean
) {
	const graph = plugin.graph();
	const inferSpouseParent = plugin.settings.inferSpouseParent;
	if (renderer instanceof TimelineRenderer) {
		const events = parseEvents(plugin.events());
		renderer.setData({ graph, visible: d.visible, extras: d.extras, events, order: d.order, highlight: d.highlight, inferSpouseParent }, keepView);
	} else if (renderer instanceof MapRenderer) {
		renderer.setData({ graph, visible: d.visible, extras: d.extras, highlight: d.highlight, places: plugin.places(d.visible) }, keepView);
	} else {
		renderer.setData(computeLayout(graph, d.visible, plugin.layoutOptions()), d.highlight, keepView, d.extras);
	}
}

export class FamilyTreeView extends ItemView {
	private renderer?: AnyRenderer;
	private display: Display = "tree";
	private order: TimelineOrder = "family";
	private canvas!: HTMLElement;
	private displayBtns = new Map<Display, HTMLElement>();
	private orderEl!: HTMLSelectElement;
	private mode: Mode = "all";
	private depth: number;
	private root?: string;
	/** Labels are relative to this person; defaults to "me" from settings */
	private reference?: string;
	private showLabels: boolean;
	private follow = true;
	private graph?: FamilyGraph;
	private statusEl!: HTMLElement;
	private refEl!: HTMLElement;
	private modeBtn!: HTMLElement;
	private labelsBtn!: HTMLElement;
	private depthEl!: HTMLSelectElement;

	constructor(leaf: WorkspaceLeaf, private plugin: FamilyTreePlugin) {
		super(leaf);
		this.depth = plugin.settings.defaultDepth;
		this.showLabels = plugin.settings.showLabels;
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return t().view.title[this.display];
	}
	getIcon() {
		return "network";
	}

	async onOpen() {
		this.contentEl.addClass("ft-view");
		this.buildUi();
		keepTouchesInside(this, () => this.canvas);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.follow || !file) return;
				const id = this.plugin.graph().persons.has(file.path) ? file.path : undefined;
				if (!id) return;
				if (this.mode === "focus") {
					if (id !== this.root) {
						this.root = id;
						this.refresh();
					}
				} else {
					this.renderer?.setHighlight(id);
					this.renderer?.centerOn(id);
				}
			})
		);

		this.root = this.activePersonId();
		this.updateModeButton();
		// Layout needs the container size
		window.requestAnimationFrame(() => this.refresh(false));
	}

	/** Redraws toolbar and diagram, e.g. after the interface language changed */
	rebuild() {
		this.buildUi();
		this.updateModeButton();
		this.refresh(true);
	}

	private buildUi() {
		const tr = t().view;
		const root = this.contentEl;
		this.renderer?.destroy();
		this.renderer = undefined;
		this.displayBtns.clear();
		root.empty();

		const bar = root.createDiv("ft-toolbar");
		const seg = bar.createDiv("ft-segmented");
		for (const d of DISPLAYS) this.displayBtns.set(d.id, button(seg, d.icon, tr.display[d.id], () => this.setDisplay(d.id)));
		this.orderEl = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": tr.order } });
		this.orderEl.createEl("option", { text: tr.byFamily, value: "family" });
		this.orderEl.createEl("option", { text: tr.byBirth, value: "birth" });
		this.orderEl.value = this.order;
		this.orderEl.onchange = () => {
			this.order = this.orderEl.value as TimelineOrder;
			this.refresh(true);
		};
		this.modeBtn = button(bar, "users", tr.modeAll, () => {
			this.setMode(this.mode === "all" ? "focus" : "all");
		});
		this.depthEl = bar.createEl("select", { cls: "dropdown ft-depth", attr: { "aria-label": tr.generations } });
		for (let d = 1; d <= 8; d++) this.depthEl.createEl("option", { text: tr.depth(d), value: String(d) });
		this.depthEl.value = String(this.depth);
		this.depthEl.onchange = () => {
			this.depth = Number(this.depthEl.value);
			this.refresh();
		};
		this.labelsBtn = button(bar, "tags", tr.labels, () => {
			this.showLabels = !this.showLabels;
			this.labelsBtn.toggleClass("is-active", this.showLabels);
			this.refresh(true);
		});
		this.labelsBtn.toggleClass("is-active", this.showLabels);

		const search = bar.createEl("input", { type: "search", cls: "ft-search", attr: { placeholder: tr.search } });
		const list = bar.createEl("datalist", { attr: { id: "ft-people-" + Math.random().toString(36).slice(2) } });
		search.setAttr("list", list.id);
		search.addEventListener("focus", () => {
			list.empty();
			for (const p of this.graph?.persons.values() ?? []) list.createEl("option", { value: p.fullName });
		});
		search.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			const hit = this.graph?.findByName(search.value)[0];
			if (!hit) return;
			if (this.mode === "focus") {
				this.root = hit.id;
				this.refresh();
			} else {
				this.renderer?.setHighlight(hit.id);
				this.renderer?.centerOn(hit.id);
			}
		});

		this.refEl = bar.createDiv("ft-ref");
		bar.createDiv("ft-spacer");
		this.statusEl = bar.createDiv("ft-status");
		button(bar, "crosshair", tr.center, () => {
			const id = this.activePersonId();
			if (!id) return;
			if (this.mode === "focus") {
				this.root = id;
				this.refresh();
			} else this.renderer?.centerOn(id);
		});
		button(bar, "zoom-in", tr.zoomIn, () => this.renderer?.zoomBy(1.25));
		button(bar, "zoom-out", tr.zoomOut, () => this.renderer?.zoomBy(0.8));
		button(bar, "maximize", tr.fit, () => this.renderer?.fit());

		this.canvas = root.createDiv("ft-canvas");
		this.mountRenderer();
	}

	async onClose() {
		this.renderer?.destroy();
	}

	setDisplay(display: Display) {
		if (display === this.display && this.renderer) return;
		this.display = display;
		this.mountRenderer();
		this.refresh(false);
	}

	private mountRenderer() {
		this.renderer?.destroy();
		this.renderer = createRenderer(this.plugin, this.display, this.canvas, this, false);
		for (const [id, b] of this.displayBtns) b.toggleClass("is-active", id === this.display);
		this.orderEl.toggle(this.display === "timeline");
	}

	focusOn(id: string) {
		this.root = id;
		this.setMode("focus");
	}

	/** Show relationship labels relative to someone else; undefined = back to "me" */
	setReference(id?: string) {
		this.reference = id;
		this.showLabels = true;
		this.labelsBtn.toggleClass("is-active", true);
		this.refresh(true);
	}

	setMode(mode: Mode) {
		this.mode = mode;
		if (mode === "focus" && !this.root) this.root = this.activePersonId();
		this.updateModeButton();
		this.refresh(false);
	}

	/** Rebuild from the vault. keepView keeps the current pan/zoom */
	refresh(keepView = false) {
		if (!this.renderer) return;
		const g = (this.graph = this.plugin.graph());
		let visible: Set<string>;
		if (this.mode === "focus" && this.root && g.persons.has(this.root)) visible = focusSet(g, this.root, this.depth);
		else visible = new Set(g.persons.keys());

		this.statusEl.setText(t().view.people(visible.size));
		if (g.persons.size === 0) this.statusEl.setText(t().view.noPeople(this.plugin.settings.typeValue));

		const ref = this.reference && g.persons.has(this.reference) ? this.reference : this.plugin.meId();
		const extras: RenderExtras = this.showLabels ? this.plugin.labelExtras(ref, visible) : {};
		this.refEl.empty();
		if (this.showLabels && ref && ref !== this.plugin.meId()) {
			this.refEl.createSpan({ text: t().view.relativeTo(g.persons.get(ref)?.name ?? "") });
			button(this.refEl, "x", t().view.backToMe, () => this.setReference(undefined));
		} else if (this.showLabels && !ref) {
			this.refEl.createSpan({ text: t().view.hintMe });
		}

		const highlight = this.mode === "focus" ? this.root : this.activePersonId();
		feedRenderer(this.plugin, this.renderer, { visible, extras, highlight, order: this.order }, keepView);
	}

	private updateModeButton() {
		setIcon(this.modeBtn, this.mode === "all" ? "users" : "user");
		this.modeBtn.toggleClass("is-active", this.mode === "focus");
		this.modeBtn.setAttr("aria-label", this.mode === "all" ? t().view.modeAll : t().view.modeFocus);
		this.depthEl.toggle(this.mode === "focus");
	}

	private activePersonId(): string | undefined {
		const f = this.app.workspace.getActiveFile();
		return f && this.plugin.graph().persons.has(f.path) ? f.path : this.root;
	}
}

/** ```family-tree code block, re-rendered when the vault changes */
export class FamilyTreeBlock extends MarkdownRenderChild {
	private renderer?: AnyRenderer;

	constructor(
		containerEl: HTMLElement,
		private plugin: FamilyTreePlugin,
		private source: string,
		private sourcePath: string,
		private defaultDisplay: Display = "tree"
	) {
		super(containerEl);
	}

	onload() {
		const opts = parseBlock(this.source);
		const wrap = this.containerEl.createDiv("ft-embed");
		wrap.style.height = `${opts.height}px`;
		const bar = wrap.createDiv("ft-embed-bar");
		button(bar, "zoom-in", t().view.zoomIn, () => this.renderer?.zoomBy(1.25));
		button(bar, "zoom-out", t().view.zoomOut, () => this.renderer?.zoomBy(0.8));
		button(bar, "maximize", t().view.fit, () => this.renderer?.fit());
		button(bar, "external-link", t().view.openInView, () => {
			const id = this.resolveRoot(opts.root);
			void this.plugin.activateView(id, display);
		});
		const display: Display = opts.view ?? this.defaultDisplay;
		const canvas = wrap.createDiv("ft-canvas");
		keepTouchesInside(this, canvas);
		const renderer = (this.renderer = createRenderer(this.plugin, display, canvas, undefined, true));

		const draw = (keepView: boolean) => {
			const g = this.plugin.graph();
			const root = this.resolveRoot(opts.root);
			const visible = root && g.persons.has(root) ? focusSet(g, root, opts.depth) : new Set(g.persons.keys());
			const showLabels = opts.labels ?? this.plugin.settings.showLabels;
			const extras = showLabels ? this.plugin.labelExtras(this.plugin.meId(), visible) : {};
			feedRenderer(this.plugin, renderer, { visible, extras, highlight: root, order: opts.order ?? "family" }, keepView);
		};
		window.requestAnimationFrame(() => draw(false));
		this.register(this.plugin.onGraphChange(() => draw(true)));
	}

	onunload() {
		this.renderer?.destroy();
	}

	private resolveRoot(root?: string): string | undefined {
		if (root === "all") return undefined;
		if (!root) {
			// No root given: a block inside a person note focuses on that person, elsewhere shows everyone
			return this.plugin.graph().persons.has(this.sourcePath) ? this.sourcePath : undefined;
		}
		const f = this.plugin.app.metadataCache.getFirstLinkpathDest(root, this.sourcePath);
		return f instanceof TFile ? f.path : undefined;
	}
}

function parseBlock(source: string) {
	const out = {
		root: undefined as string | undefined,
		depth: 2,
		height: 500,
		labels: undefined as boolean | undefined,
		view: undefined as Display | undefined,
		order: undefined as TimelineOrder | undefined,
	};
	for (const line of source.split("\n")) {
		const m = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
		if (!m) continue;
		const [, key, value] = m;
		if (key === "root") out.root = value.replace(/^["']?\[\[|\]\]["']?$/g, "").split("|")[0] || undefined;
		else if (key === "depth") out.depth = Math.max(1, Number(value) || 2);
		else if (key === "height") out.height = Math.max(150, Number(value) || 500);
		else if (key === "labels") out.labels = !/^(false|no|off|0)$/i.test(value);
		else if (key === "view") out.view = value === "timeline" || value === "map" ? value : "tree";
		else if (key === "order") out.order = value === "birth" ? "birth" : "family";
	}
	return out;
}

function button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
	const b = parent.createEl("button", { cls: "clickable-icon ft-btn", attr: { "aria-label": label } });
	setIcon(b, icon);
	b.onclick = onClick;
	return b;
}
