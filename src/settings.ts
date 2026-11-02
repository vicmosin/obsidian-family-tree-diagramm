import { App, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type FamilyTreePlugin from "./main";
import { Lang } from "./kinship";
import { DEFAULT_EVENTS_RU } from "./timeline";
import { Coords } from "./places";
import { DEFAULT_FIELDS, FieldNames } from "./model";

export interface FamilyTreeSettings {
	/** Notes whose `type` frontmatter equals this are people */
	typeValue: string;
	/** Notes with this tag are people too */
	tag: string;
	fields: FieldNames;
	photoField: string;
	inferSpouseParent: boolean;
	defaultDepth: number;
	newPersonFolder: string;
	/** Path of the note that represents the vault owner; relationship labels are relative to it */
	me: string;
	labelLanguage: Lang;
	showLabels: boolean;
	/** Historical events on the timeline, one per line: "1941-1945 Великая Отечественная война" */
	events: string;
	/** Folder for new place notes; empty = Obsidian's default location for new notes */
	placeFolder: string;
	/** Coordinates kept in plugin data by versions before 1.1.0, until moved into place notes */
	placeCache: Record<string, Coords>;
}

export const DEFAULT_SETTINGS: FamilyTreeSettings = {
	typeValue: "family-tree",
	tag: "family-tree",
	fields: { ...DEFAULT_FIELDS },
	photoField: "photo",
	inferSpouseParent: true,
	defaultDepth: 3,
	newPersonFolder: "",
	me: "",
	labelLanguage: "ru",
	showLabels: true,
	events: DEFAULT_EVENTS_RU,
	placeFolder: "",
	placeCache: {},
};

type Item = SettingDefinitionItem;
type Group = SettingDefinitionGroup;

/**
 * Settings are defined once, in the declarative format of Obsidian 1.13+ (searchable from the
 * settings search). Older versions call display(), which draws the same definitions with the
 * classic Setting API.
 */
export class FamilyTreeSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FamilyTreePlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): Item[] {
		const s = this.plugin.settings;
		const people = [...this.plugin.graph().persons.values()].filter((p) => !p.ghost).sort((a, b) => a.fullName.localeCompare(b.fullName));
		const field = (key: keyof FieldNames, name: string, desc?: string): SettingDefinition => ({
			name,
			desc,
			control: { type: "text", key: `fields.${key}`, placeholder: DEFAULT_FIELDS[key] },
		});

		return [
			{
				type: "group",
				heading: "Relationship labels",
				items: [
					{
						name: "Me",
						desc: "Labels like “двоюродная тётя” are shown relative to this person. You can also set it from a card's right-click menu.",
						control: {
							type: "dropdown",
							key: "me",
							options: { "": "— not set —", ...Object.fromEntries(people.map((p) => [p.id, p.fullName])) },
						},
					},
					{ name: "Language", control: { type: "dropdown", key: "labelLanguage", options: { ru: "Русский", en: "English" } } },
					{
						name: "Show labels by default",
						desc: "Can be toggled in the tree's toolbar. In code blocks use `labels: false` to hide them.",
						control: { type: "toggle", key: "showLabels" },
					},
				],
			},
			{
				type: "group",
				heading: "Timeline",
				items: [
					{
						name: "Historical events",
						desc: "Shown as bands on the timeline. One per line: a year or range, then a label, e.g. “1941-1945 Великая Отечественная война”.",
						control: { type: "textarea", key: "events", rows: 8 },
					},
					{
						name: "Restore default events",
						desc: "Replace the list above with the built-in one.",
						action: () => void this.change(() => (s.events = DEFAULT_EVENTS_RU)),
					},
				],
			},
			{
				type: "group",
				heading: "Map",
				items: [
					{
						name: "Find coordinates",
						desc: "Look up places on OpenStreetMap and save `location: [lat, lng]` into each place's note. Places without a note get one.",
						action: () => this.plugin.openGeocode(),
					},
					{
						name: "Folder for place notes",
						desc: "Where new place notes are created. Existing place notes are found in any folder. Empty = Obsidian's default location for new notes.",
						control: { type: "text", key: "placeFolder" },
					},
					{
						name: "Move remembered coordinates into notes",
						desc: `${Object.keys(s.placeCache).length} places found by an earlier version are stored in plugin data, which is lost if the plugin is removed. This creates a note for each.`,
						visible: () => Object.keys(s.placeCache).length > 0,
						action: () => void this.plugin.migratePlaceCache().then(() => this.refresh()),
					},
				],
			},
			{
				type: "group",
				heading: "Which notes are people",
				items: [
					{ name: "Type value", desc: "Notes with this value in the `type` property are people.", control: { type: "text", key: "typeValue" } },
					{
						name: "Tag",
						desc: "Notes with this tag (without #) are people too. Notes linked from people are always included.",
						control: { type: "text", key: "tag" },
					},
				],
			},
			{
				type: "group",
				heading: "Property names",
				items: [
					field("parentOf", "Parent of", "Links to this person's children"),
					field("childOf", "Child of", "Links to this person's parents"),
					field("marriedTo", "Married to"),
					field("siblings", "Siblings"),
					field("birthDate", "Birth date"),
					field("deathDate", "Death date"),
					field("birthPlace", "Birth place"),
					field("deathPlace", "Death place"),
					field("livedIn", "Lived in", "Optional list of places, each may carry years: “[[Manchester]] 1950-1975”"),
					field("gender", "Gender", "Optional: m/f. Without it gender is guessed from the patronymic (…вич / …вна)."),
					{
						name: "Photo",
						desc: "Optional property with an image link. Without it the first image embedded in the note is used.",
						control: { type: "text", key: "photoField" },
					},
				],
			},
			{
				type: "group",
				heading: "Diagram",
				items: [
					{
						name: "Infer second parent from spouse",
						desc: "If a child lists only one parent and that parent has exactly one spouse, draw the child under the couple.",
						control: { type: "toggle", key: "inferSpouseParent" },
					},
					{
						name: "Default focus depth",
						desc: "Generations up and down shown in focus mode.",
						control: { type: "slider", key: "defaultDepth", min: 1, max: 8, step: 1 },
					},
					{
						name: "Folder for new people",
						desc: "Where notes are created when you click a person that has no note yet. Empty = Obsidian's default location for new notes.",
						control: { type: "text", key: "newPersonFolder" },
					},
				],
			},
		];
	}

	/** Keys are setting names, or `fields.<name>` for property names */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key.startsWith("fields.")) return s.fields[key.slice(7) as keyof FieldNames];
		return s[key as keyof FamilyTreeSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		const text = typeof value === "string" ? value.trim() : "";
		if (key.startsWith("fields.")) {
			const field = key.slice(7) as keyof FieldNames;
			s.fields[field] = text || DEFAULT_FIELDS[field];
		} else if (key === "tag") s.tag = text.replace(/^#/, "").trim();
		else if (key === "typeValue" || key === "photoField" || key === "newPersonFolder" || key === "placeFolder" || key === "me") s[key] = text;
		else if (key === "labelLanguage") s.labelLanguage = value === "en" ? "en" : "ru";
		else if (key === "events" && typeof value === "string") s.events = value;
		else if ((key === "showLabels" || key === "inferSpouseParent") && typeof value === "boolean") s[key] = value;
		else if (key === "defaultDepth" && typeof value === "number") s.defaultDepth = value;
		await this.plugin.saveSettings();
	}

	/** Obsidian before 1.13: draw the same definitions with the classic API */
	display(): void {
		this.renderLegacy();
	}

	/** Applies a change made by an action and redraws, since it can alter other rows */
	private async change(apply: () => void) {
		apply();
		await this.plugin.saveSettings();
		this.refresh();
	}

	/** Redraws after a change that alters other rows */
	private refresh() {
		const tab = this as unknown as { update?: () => void };
		if (requireApiVersion("1.13.0") && typeof tab.update === "function") tab.update();
		else this.renderLegacy();
	}

	private renderLegacy() {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingDefinitions()) {
			if (!("items" in item)) continue;
			const group = item as Group;
			if (group.heading) new Setting(containerEl).setName(group.heading).setHeading();
			for (const def of group.items ?? []) {
				if ("items" in def) continue;
				if (def.visible === false || (typeof def.visible === "function" && !def.visible())) continue;
				this.renderLegacyItem(def);
			}
		}
	}

	private renderLegacyItem(def: SettingDefinition) {
		const setting = new Setting(this.containerEl).setName(def.name);
		if (def.desc) setting.setDesc(def.desc);
		if ("action" in def && def.action) {
			const action = def.action;
			// Button text is the first word of the name: "Find", "Forget", "Restore"
			setting.addButton((b) => b.setButtonText(def.name.split(" ")[0]).onClick(() => action(b.buttonEl, 0)));
			return;
		}
		if (!("control" in def) || !def.control) return;
		const c = def.control;
		const set = (v: unknown) => void this.setControlValue(c.key, v);
		const value = this.getControlValue(c.key);
		const str = typeof value === "string" ? value : "";
		if (c.type === "text") setting.addText((t) => t.setPlaceholder(c.placeholder ?? "").setValue(str).onChange(set));
		else if (c.type === "textarea") {
			setting.addTextArea((t) => {
				t.setValue(str).onChange(set);
				t.inputEl.rows = c.rows ?? 4;
				t.inputEl.addClass("ft-events-input");
			});
		} else if (c.type === "toggle") setting.addToggle((t) => t.setValue(value === true).onChange(set));
		else if (c.type === "dropdown") setting.addDropdown((d) => d.addOptions(c.options).setValue(str).onChange(set));
		else if (c.type === "slider") setting.addSlider((sl) => sl.setLimits(c.min, c.max, c.step).setValue(Number(value)).onChange(set));
	}
}
