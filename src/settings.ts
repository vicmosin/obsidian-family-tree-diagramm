import { App, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type FamilyTreePlugin from "./main";
import en from "./i18n/en";
import { LANGUAGES, LangSetting, t } from "./i18n";
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
	/** Language of menus, settings and messages; "auto" follows Obsidian */
	language: LangSetting;
	labelLanguage: LangSetting;
	showLabels: boolean;
	/**
	 * Historical events on the timeline, one per line: "1939-1945 World War II". While it equals a
	 * built-in list, the list of the current interface language is shown instead.
	 */
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
	language: "auto",
	labelLanguage: "auto",
	showLabels: true,
	events: en.defaultEvents,
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
	/** Button labels for action rows, used when drawing them with the classic API */
	private buttonText = new Map<string, string>();

	constructor(app: App, private plugin: FamilyTreePlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): Item[] {
		const s = this.plugin.settings;
		const tr = t().settings;
		const people = [...this.plugin.graph().persons.values()].filter((p) => !p.ghost).sort((a, b) => a.fullName.localeCompare(b.fullName));
		const languages = { auto: tr.auto, ...LANGUAGES };
		const field = (key: keyof FieldNames): SettingDefinition => {
			const [name, desc] = tr.field[key];
			return { name, desc: desc || undefined, control: { type: "text", key: `fields.${key}`, placeholder: DEFAULT_FIELDS[key] } };
		};
		const action = (name: string, desc: string, button: string, run: () => void, visible?: () => boolean): SettingDefinition => {
			this.buttonText.set(name, button);
			return { name, desc, action: run, visible };
		};

		return [
			{
				type: "group",
				heading: tr.languageHeading,
				items: [
					{ name: tr.interfaceLanguage, desc: tr.interfaceLanguageDesc, control: { type: "dropdown", key: "language", options: languages } },
					{ name: tr.labelLanguage, control: { type: "dropdown", key: "labelLanguage", options: languages } },
				],
			},
			{
				type: "group",
				heading: tr.labelsHeading,
				items: [
					{
						name: tr.me,
						desc: tr.meDesc,
						control: {
							type: "dropdown",
							key: "me",
							options: { "": tr.notSet, ...Object.fromEntries(people.map((p) => [p.id, p.fullName])) },
						},
					},
					{ name: tr.showLabels, desc: tr.showLabelsDesc, control: { type: "toggle", key: "showLabels" } },
				],
			},
			{
				type: "group",
				heading: tr.timelineHeading,
				items: [
					{ name: tr.events, desc: tr.eventsDesc, control: { type: "textarea", key: "events", rows: 8 } },
					action(tr.restoreEvents, tr.restoreEventsDesc, tr.restoreButton, () => void this.change(() => (s.events = t().defaultEvents))),
				],
			},
			{
				type: "group",
				heading: tr.mapHeading,
				items: [
					action(tr.findCoordinates, tr.findCoordinatesDesc, tr.findButton, () => this.plugin.openGeocode()),
					{ name: tr.placeFolder, desc: tr.placeFolderDesc, control: { type: "text", key: "placeFolder" } },
					action(
						tr.movePlaces,
						tr.movePlacesDesc(Object.keys(s.placeCache).length),
						tr.moveButton,
						() => void this.plugin.migratePlaceCache().then(() => this.refresh()),
						() => Object.keys(s.placeCache).length > 0
					),
				],
			},
			{
				type: "group",
				heading: tr.peopleHeading,
				items: [
					{ name: tr.typeValue, desc: tr.typeValueDesc, control: { type: "text", key: "typeValue" } },
					{ name: tr.tag, desc: tr.tagDesc, control: { type: "text", key: "tag" } },
				],
			},
			{
				type: "group",
				heading: tr.propertiesHeading,
				items: [
					...(["parentOf", "childOf", "marriedTo", "siblings", "birthDate", "deathDate", "birthPlace", "deathPlace", "livedIn", "gender"] as const).map(field),
					{ name: tr.photo, desc: tr.photoDesc, control: { type: "text", key: "photoField" } },
				],
			},
			{
				type: "group",
				heading: tr.diagramHeading,
				items: [
					{ name: tr.inferParent, desc: tr.inferParentDesc, control: { type: "toggle", key: "inferSpouseParent" } },
					{ name: tr.depth, desc: tr.depthDesc, control: { type: "slider", key: "defaultDepth", min: 1, max: 8, step: 1 } },
					{ name: tr.personFolder, desc: tr.personFolderDesc, control: { type: "text", key: "newPersonFolder" } },
				],
			},
		];
	}

	/** Keys are setting names, or `fields.<name>` for property names */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key.startsWith("fields.")) return s.fields[key.slice(7) as keyof FieldNames];
		if (key === "events") return this.plugin.events();
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
		else if (key === "language" || key === "labelLanguage") {
			s[key] = value === "en" || value === "de" || value === "ru" ? value : "auto";
			if (key === "language") {
				await this.plugin.saveSettings();
				this.plugin.applyLanguage();
				this.refresh();
				return;
			}
		}
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
	refresh() {
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
			setting.addButton((b) => b.setButtonText(this.buttonText.get(def.name) ?? def.name).onClick(() => action(b.buttonEl, 0)));
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
