import { App, PluginSettingTab, Setting } from "obsidian";
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
	/** Coordinates found for places that have no note of their own, keyed by placeKey() */
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
	placeCache: {},
};

export class FamilyTreeSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FamilyTreePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = async () => {
			await this.plugin.saveSettings();
		};

		new Setting(containerEl).setName("Relationship labels").setHeading();
		new Setting(containerEl)
			.setName("Me")
			.setDesc("Labels like “двоюродная тётя” are shown relative to this person. You can also set it from a card's right-click menu.")
			.addDropdown((d) => {
				d.addOption("", "— not set —");
				const people = [...this.plugin.graph().persons.values()].filter((p) => !p.ghost).sort((a, b) => a.fullName.localeCompare(b.fullName));
				for (const p of people) d.addOption(p.id, p.fullName);
				d.setValue(s.me).onChange(async (v) => ((s.me = v), await save()));
			});
		new Setting(containerEl)
			.setName("Language")
			.addDropdown((d) =>
				d
					.addOption("ru", "Русский")
					.addOption("en", "English")
					.setValue(s.labelLanguage)
					.onChange(async (v) => ((s.labelLanguage = v as Lang), await save()))
			);
		new Setting(containerEl)
			.setName("Show labels by default")
			.setDesc("Can be toggled in the tree's toolbar. In code blocks use `labels: false` to hide them.")
			.addToggle((t) => t.setValue(s.showLabels).onChange(async (v) => ((s.showLabels = v), await save())));

		new Setting(containerEl).setName("Timeline").setHeading();
		new Setting(containerEl)
			.setName("Historical events")
			.setDesc("Shown as bands on the timeline. One per line: a year or range, then a label, e.g. “1941-1945 Великая Отечественная война”.")
			.addTextArea((t) => {
				t.setValue(s.events).onChange(async (v) => ((s.events = v), await save()));
				t.inputEl.rows = 8;
				t.inputEl.addClass("ft-events-input");
			})
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Restore defaults")
					.onClick(async () => {
						s.events = DEFAULT_EVENTS_RU;
						await save();
						this.display();
					})
			);

		new Setting(containerEl).setName("Map").setHeading();
		new Setting(containerEl)
			.setName("Find coordinates")
			.setDesc(
				`Looks up places on OpenStreetMap and saves \`location: [lat, lng]\` into place notes. ${Object.keys(s.placeCache).length} places without a note are remembered by the plugin.`
			)
			.addButton((b) => b.setButtonText("Find…").onClick(() => this.plugin.openGeocode()))
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Forget remembered coordinates")
					.onClick(async () => {
						s.placeCache = {};
						await save();
						this.display();
					})
			);

		new Setting(containerEl).setName("Which notes are people").setHeading();
		new Setting(containerEl)
			.setName("Type value")
			.setDesc("Notes with this value in the `type` property are people.")
			.addText((t) => t.setValue(s.typeValue).onChange(async (v) => ((s.typeValue = v.trim()), await save())));
		new Setting(containerEl)
			.setName("Tag")
			.setDesc("Notes with this tag (without #) are people too. Notes linked from people are always included.")
			.addText((t) => t.setValue(s.tag).onChange(async (v) => ((s.tag = v.replace(/^#/, "").trim()), await save())));

		new Setting(containerEl).setName("Property names").setHeading();
		const field = (key: keyof FieldNames, name: string, desc = "") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t
						.setPlaceholder(DEFAULT_FIELDS[key])
						.setValue(s.fields[key])
						.onChange(async (v) => ((s.fields[key] = v.trim() || DEFAULT_FIELDS[key]), await save()))
				);
		field("parentOf", "Parent of", "Links to this person's children");
		field("childOf", "Child of", "Links to this person's parents");
		field("marriedTo", "Married to");
		field("siblings", "Siblings");
		field("birthDate", "Birth date");
		field("deathDate", "Death date");
		field("birthPlace", "Birth place");
		field("deathPlace", "Death place");
		field("livedIn", "Lived in", "Optional list of places, each may carry years: “[[Manchester]] 1950-1975”");
		field("gender", "Gender", "Optional: m/f. Without it gender is guessed from the patronymic (…вич / …вна).");
		new Setting(containerEl)
			.setName("Photo")
			.setDesc("Optional property with an image link. Without it the first image embedded in the note is used.")
			.addText((t) => t.setValue(s.photoField).onChange(async (v) => ((s.photoField = v.trim()), await save())));

		new Setting(containerEl).setName("Diagram").setHeading();
		new Setting(containerEl)
			.setName("Infer second parent from spouse")
			.setDesc("If a child lists only one parent and that parent has exactly one spouse, draw the child under the couple.")
			.addToggle((t) => t.setValue(s.inferSpouseParent).onChange(async (v) => ((s.inferSpouseParent = v), await save())));
		new Setting(containerEl)
			.setName("Default focus depth")
			.setDesc("Generations up and down shown in focus mode.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 8, 1)
					.setValue(s.defaultDepth)
					.onChange(async (v) => ((s.defaultDepth = v), await save()))
			);
		new Setting(containerEl)
			.setName("Folder for new people")
			.setDesc("Where notes are created when you click a person that has no note yet. Empty = vault root.")
			.addText((t) => t.setValue(s.newPersonFolder).onChange(async (v) => ((s.newPersonFolder = v.trim()), await save())));
	}
}
