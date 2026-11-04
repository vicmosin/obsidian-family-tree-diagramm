import { debounce, getAllTags, Menu, normalizePath, Notice, parseFrontMatterAliases, Plugin, TFile } from "obsidian";
import { DEFAULT_LAYOUT, LayoutOptions } from "./layout";
import { ReverseFix } from "./check";
import { CheckModal } from "./checkModal";
import { Kinship } from "./kinship";
import { isDefaultEvents, resolveLang, setLanguage, t } from "./i18n";
import { GeocodeModal } from "./geocodeModal";
import { collectPlaces, Coords, parseLocation, Place, PlaceIndex, PlaceNote } from "./places";
import { migratePlaceCache, newNoteFolder, savePlaceCoords } from "./placeNotes";
import { buildGraph, extractLinks, FamilyGraph, Person, RawNote, RELATION_FIELDS } from "./model";
import { RenderExtras, RendererCallbacks } from "./render";
import { DEFAULT_SETTINGS, FamilyTreeSettings, FamilyTreeSettingTab } from "./settings";
import { Display, FamilyTreeBlock, FamilyTreeView, VIEW_TYPE } from "./view";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic"]);

export default class FamilyTreePlugin extends Plugin {
	settings!: FamilyTreeSettings;
	private cached?: FamilyGraph;
	private listeners = new Set<() => void>();

	async onload() {
		await this.loadSettings();
		setLanguage(this.settings.language);

		this.registerView(VIEW_TYPE, (leaf) => new FamilyTreeView(leaf, this));
		this.registerMarkdownCodeBlockProcessor("family-tree", (source, el, ctx) => {
			ctx.addChild(new FamilyTreeBlock(el, this, source, ctx.sourcePath));
		});
		this.registerMarkdownCodeBlockProcessor("family-timeline", (source, el, ctx) => {
			ctx.addChild(new FamilyTreeBlock(el, this, source, ctx.sourcePath, "timeline"));
		});
		this.registerMarkdownCodeBlockProcessor("family-map", (source, el, ctx) => {
			ctx.addChild(new FamilyTreeBlock(el, this, source, ctx.sourcePath, "map"));
		});

		this.addRibbonIcon("network", t().commands.openTree, () => this.activateView());
		this.addCommand({ id: "open-family-tree", name: t().commands.openTree, callback: () => this.activateView() });
		this.addCommand({ id: "open-family-map", name: t().commands.openMap, callback: () => this.activateView(undefined, "map") });
		this.addCommand({ id: "find-place-coordinates", name: t().commands.findCoordinates, callback: () => this.openGeocode() });
		this.addCommand({
			id: "move-remembered-places",
			name: t().commands.movePlaces,
			checkCallback: (checking) => {
				if (!Object.keys(this.settings.placeCache).length) return false;
				if (!checking) void this.migratePlaceCache();
				return true;
			},
		});
		this.addCommand({ id: "open-family-timeline", name: t().commands.openTimeline, callback: () => this.activateView(undefined, "timeline") });
		this.addCommand({
			id: "focus-current-person",
			name: t().commands.showCurrent,
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.graph().persons.has(f.path)) return false;
				if (!checking) void this.activateView(f.path);
				return true;
			},
		});
		this.addCommand({
			id: "set-me",
			name: t().commands.setMe,
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.isPerson(f)) return false;
				if (!checking) void this.setMe(f.path);
				return true;
			},
		});
		this.addCommand({ id: "check-data", name: t().commands.checkData, callback: () => new CheckModal(this).open() });
		// File explorer right-click, the note's "⋯" menu, tab right-click and right-click in the editor
		const addMenuItem = (menu: Menu, file: TFile | null) => {
			if (!file || file.extension !== "md") return;
			const isPerson = this.isPerson(file);
			menu.addItem((item) =>
				item
					.setTitle(isPerson ? t().menu.showInTree : t().menu.openTree)
					.setIcon("network")
					.onClick(() => this.activateView(isPerson ? file.path : undefined))
			);
		};
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => addMenuItem(menu, file instanceof TFile ? file : null)));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, info) => addMenuItem(menu, info.file)));
		this.addSettingTab(new FamilyTreeSettingTab(this.app, this));

		const invalidate = debounce(() => this.invalidate(), 400, true);
		this.registerEvent(this.app.metadataCache.on("changed", invalidate));
		this.registerEvent(this.app.metadataCache.on("resolved", invalidate));
		this.registerEvent(this.app.vault.on("rename", invalidate));
		this.registerEvent(this.app.vault.on("delete", invalidate));
	}

	/** Birth/death/lived places of `visible` people, with coordinates from place notes */
	places(visible: Set<string>): Map<string, Place> {
		const { metadataCache } = this.app;
		return collectPlaces(
			this.graph(),
			visible,
			(link, from) => {
				const f = metadataCache.getFirstLinkpathDest(link, from);
				return f instanceof TFile && f.extension === "md" ? this.placeNote(f) : null;
			},
			this.placeIndex(),
			this.settings.placeCache
		);
	}

	private placeNote(file: TFile): PlaceNote {
		const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return {
			path: file.path,
			name: file.basename,
			aliases: parseFrontMatterAliases(fm ?? null) ?? [],
			coords: parseLocation(fm?.location ?? fm?.coordinates ?? fm?.geo),
		};
	}

	/** Notes with `type: place` or with coordinates, in any folder */
	private placeIndex(): PlaceIndex {
		const notes: PlaceNote[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const types = Array.isArray(fm.type) ? fm.type : [fm.type];
			if (types.includes("place") || fm.location != null || fm.coordinates != null || fm.geo != null) notes.push(this.placeNote(file));
		}
		return new PlaceIndex(notes);
	}

	/** Saves coordinates in the place's note, creating the note if needed */
	savePlaceCoords(place: Place, coords: Coords): Promise<"updated" | "created"> {
		return savePlaceCoords(this.app, place, coords, this.settings.placeFolder);
	}

	/** Moves coordinates remembered in plugin data (before 1.1.0) into place notes */
	async migratePlaceCache(): Promise<void> {
		const places = [...this.places(new Set(this.graph().persons.keys())).values()];
		const { moved, left } = await migratePlaceCache(this.app, places, this.settings.placeCache, this.settings.placeFolder);
		await this.saveSettings();
		new Notice(t().notices.moved(moved, left));
	}

	openGeocode() {
		const missing = [...this.places(new Set(this.graph().persons.keys())).values()].filter((p) => !p.coords);
		if (!missing.length) {
			new Notice(t().notices.allHaveCoords);
			return;
		}
		new GeocodeModal(this, missing).open();
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<FamilyTreeSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			fields: { ...DEFAULT_SETTINGS.fields, ...(data.fields ?? {}) },
			placeCache: { ...(data.placeCache ?? {}) },
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.invalidate();
	}

	layoutOptions(): LayoutOptions {
		return { ...DEFAULT_LAYOUT, inferSpouseParent: this.settings.inferSpouseParent };
	}

	/** Applies a new interface language to open views (command names follow after a restart) */
	applyLanguage() {
		setLanguage(this.settings.language);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof FamilyTreeView) leaf.view.rebuild();
		}
		this.listeners.forEach((fn) => fn());
		new Notice(t().notices.languageChanged);
	}

	/** Historical events for the timeline: the built-in list follows the interface language */
	events(): string {
		return isDefaultEvents(this.settings.events) ? t().defaultEvents : this.settings.events;
	}

	/** Subscribe to vault changes that affect the tree; returns an unsubscribe function */
	onGraphChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private invalidate() {
		this.cached = undefined;
		for (const view of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (view.view instanceof FamilyTreeView) view.view.refresh(true);
		}
		this.listeners.forEach((fn) => fn());
	}

	isPerson(file: TFile): boolean {
		try {
			return this.graph().persons.has(file.path);
		} catch (e) {
			console.error("Family tree: failed to read the vault", e);
			return false;
		}
	}

	graph(): FamilyGraph {
		if (this.cached) return this.cached;
		const { metadataCache } = this.app;
		const s = this.settings;

		const toRaw = (file: TFile): RawNote => ({
			id: file.path,
			basename: file.basename,
			frontmatter: metadataCache.getFileCache(file)?.frontmatter ?? {},
			photo: this.photoOf(file),
		});

		const notes: RawNote[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = metadataCache.getFileCache(file);
			if (!cache) continue;
			const type: unknown = cache.frontmatter?.type;
			const types = Array.isArray(type) ? type : [type];
			const tags = (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
			const byType = !!s.typeValue && types.includes(s.typeValue);
			// A tag alone also marks overview notes (e.g. an index called "Tree"), so require some person data too
			const byTag = !!s.tag && tags.includes(s.tag.toLowerCase()) && this.hasPersonData(cache.frontmatter);
			if (byType || byTag) {
				notes.push(toRaw(file));
			}
		}

		const resolve = (link: string, from: string) => {
			const f = metadataCache.getFirstLinkpathDest(link, from);
			return f instanceof TFile && f.extension === "md" ? toRaw(f) : null;
		};
		this.cached = buildGraph(notes, resolve, s.fields);
		return this.cached;
	}

	private hasPersonData(fm: Record<string, unknown> | undefined): boolean {
		if (!fm) return false;
		const f = this.settings.fields;
		return [f.parentOf, f.childOf, f.marriedTo, f.siblings, f.birthDate, f.deathDate].some((k) => {
			const v = fm[k];
			return v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
		});
	}

	private photoOf(file: TFile): string | undefined {
		const { metadataCache, vault } = this.app;
		const cache = metadataCache.getFileCache(file);
		const candidates: string[] = [];
		if (this.settings.photoField) candidates.push(...extractLinks(cache?.frontmatter?.[this.settings.photoField]));
		for (const e of cache?.embeds ?? []) candidates.push(e.link);
		for (const link of candidates) {
			if (/^https?:\/\//.test(link)) return link;
			const f = metadataCache.getFirstLinkpathDest(link, file.path);
			if (f && IMAGE_EXT.has(f.extension.toLowerCase())) return vault.getResourcePath(f);
		}
		return undefined;
	}

	meId(): string | undefined {
		const me = this.settings.me;
		return me && this.graph().persons.has(me) ? me : undefined;
	}

	async setMe(id: string) {
		this.settings.me = id;
		this.settings.showLabels = true;
		await this.saveSettings();
		new Notice(t().notices.relativeTo(this.graph().persons.get(id)?.name ?? ""));
	}

	/** Relationship badges for `visible` people, relative to `ref` */
	labelExtras(ref: string | undefined, visible: Set<string>): RenderExtras {
		if (!ref) return {};
		const k = new Kinship(this.graph(), ref, resolveLang(this.settings.labelLanguage), this.settings.inferSpouseParent);
		const labels = new Map<string, string>();
		for (const id of visible) {
			const kin = k.get(id);
			if (kin) labels.set(id, kin.label);
		}
		return { labels, reference: ref, pathTo: (id) => k.get(id)?.path };
	}

	callbacks(view?: FamilyTreeView): RendererCallbacks {
		const withView = async (fn: (v: FamilyTreeView) => void) => {
			if (view) return fn(view);
			await this.activateView();
			const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
			if (leaf?.view instanceof FamilyTreeView) fn(leaf.view);
		};
		return {
			onOpen: (p, newTab) => {
				if (p.path) void this.app.workspace.openLinkText(p.path, "", newTab ? "tab" : false);
			},
			onCreate: (p) => void this.createPerson(p),
			onContextMenu: (p, e) => {
				const menu = new Menu();
				if (p.ghost) {
					menu.addItem((i) => i.setTitle(t().menu.createNote).setIcon("file-plus").onClick(() => this.createPerson(p)));
				} else {
					menu.addItem((i) => i.setTitle(t().menu.open).setIcon("file-text").onClick(() => this.app.workspace.openLinkText(p.path!, "", false)));
					menu.addItem((i) => i.setTitle(t().menu.openInNewTab).setIcon("file-plus-2").onClick(() => this.app.workspace.openLinkText(p.path!, "", "tab")));
				}
				menu.addSeparator();
				menu.addItem((i) => i.setTitle(t().menu.focus).setIcon("user").onClick(() => withView((v) => v.focusOn(p.id))));
				menu.addItem((i) =>
					i.setTitle(t().menu.showRelationships).setIcon("tags").onClick(() => withView((v) => v.setReference(p.id)))
				);
				if (!p.ghost) {
					menu.addItem((i) =>
						i
							.setTitle(p.id === this.settings.me ? t().menu.thisIsMeChecked : t().menu.thisIsMe)
							.setIcon("user-check")
							.onClick(() => this.setMe(p.id))
					);
				}
				menu.showAtMouseEvent(e);
			},
		};
	}

	/** Relation properties that person notes store as lists rather than text */
	private listProperties(): Set<string> {
		const keys = new Set<string>();
		const relationKeys = RELATION_FIELDS.map((f) => this.settings.fields[f]);
		for (const p of this.graph().persons.values()) {
			if (!p.path) continue;
			const file = this.app.vault.getFileByPath(p.path);
			const fm: Record<string, unknown> | undefined = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
			for (const k of relationKeys) if (Array.isArray(fm?.[k])) keys.add(k);
		}
		return keys;
	}

	/** Writes missing reverse links into frontmatter. Keeps each property's existing shape (text or list) */
	async applyReverseFixes(fixes: ReverseFix[]): Promise<{ links: number; notes: number }> {
		const byPerson = new Map<string, ReverseFix[]>();
		for (const f of fixes) (byPerson.get(f.person) ?? byPerson.set(f.person, []).get(f.person)!).push(f);
		// Write new values in the same shape (text or list) the vault already uses for that property
		const listKeys = this.listProperties();

		let links = 0;
		let notes = 0;
		for (const [path, list] of byPerson) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			let changed = false;
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				for (const fix of list) {
					const target = this.app.vault.getAbstractFileByPath(fix.target);
					if (!(target instanceof TFile)) continue;
					const key = this.settings.fields[fix.field];
					const linktext = this.app.metadataCache.fileToLinktext(target, file.path, true);
					const existing = fm[key];
					const asList = listKeys.has(key);
					if (extractLinks(existing).some((l) => this.app.metadataCache.getFirstLinkpathDest(l, file.path) === target)) continue;
					const link = `[[${linktext}]]` + (fix.uncertain ? " ?" : "");
					if (Array.isArray(existing)) existing.push(link);
					else if (existing == null || existing === "") fm[key] = asList ? [link] : link;
					else if (typeof existing === "string") fm[key] = asList ? [existing, link] : `${existing}, ${link}`;
					else continue;
					links++;
					changed = true;
				}
			});
			if (changed) notes++;
		}
		return { links, notes };
	}

	async activateView(focusId?: string, display?: Display) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		if (leaf.view instanceof FamilyTreeView) {
			if (display) leaf.view.setDisplay(display);
			if (focusId) leaf.view.focusOn(focusId);
			else leaf.view.setMode("all");
		}
	}

	/** Creates a note for someone who is only referenced by a link, pre-filled with known relations */
	async createPerson(p: Person) {
		const g = this.graph();
		const f = this.settings.fields;
		const link = (id: string, uncertain: boolean) => {
			const other = g.persons.get(id)!;
			return `"[[${other.ghost ? other.linktext : other.fullName}]]${uncertain ? " ?" : ""}"`;
		};
		const list = (ids: Set<string>, uncertain: (other: string) => boolean) =>
			ids.size ? "\n" + [...ids].map((id) => `  - ${link(id, uncertain(id))}`).join("\n") : "";

		const fm = [
			"---",
			`${f.birthDate}: `,
			`${f.birthPlace}: `,
			`${f.deathDate}: `,
			`${f.childOf}:${list(g.get(g.parents, p.id), (o) => g.isUncertain("parent", o, p.id))}`,
			`${f.parentOf}:${list(g.get(g.children, p.id), (o) => g.isUncertain("parent", p.id, o))}`,
			`${f.marriedTo}:${list(g.get(g.spouses, p.id), (o) => g.isUncertain("spouse", p.id, o))}`,
			`${f.siblings}:${list(g.get(g.siblings, p.id), (o) => g.isUncertain("sibling", p.id, o))}`,
			"tags:",
			`  - "#${this.settings.tag || "family-tree"}"`,
			`type: ${this.settings.typeValue || "family-tree"}`,
			"---",
			"",
			`# ${p.fullName}`,
			"",
			...t().newPerson.headings.flatMap((h) => [`## ${h}`, ""]),
		].join("\n");

		const name = (p.linktext ?? p.fullName).replace(/[\\/:*?"<>|]/g, "");
		const folder = await newNoteFolder(this.app, this.settings.newPersonFolder);
		const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(t().notices.exists(path));
			return;
		}
		const file = await this.app.vault.create(path, fm);
		await this.app.workspace.getLeaf("tab").openFile(file);
		new Notice(t().notices.created(p.fullName));
	}
}
