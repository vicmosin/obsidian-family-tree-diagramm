import { test } from "node:test";
import assert from "node:assert/strict";
import type { SettingDefinition, SettingDefinitionGroup } from "obsidian";
import { rendered, setApiVersionOk } from "./obsidian-mock";
import { DEFAULT_SETTINGS, FamilyTreeSettings, FamilyTreeSettingTab } from "../src/settings";
import { DEFAULT_FIELDS, FamilyGraph } from "../src/model";
import { isDefaultEvents, setLanguage, t } from "../src/i18n";
import en from "../src/i18n/en";
import de from "../src/i18n/de";
import { setObsidianLanguage } from "./obsidian-mock";

function setup() {
	const graph = new FamilyGraph();
	graph.persons.set("Family/George Miller.md", { id: "Family/George Miller.md", fullName: "George Miller", name: "George Miller", ghost: false, gender: "m" });
	let saves = 0;
	let geocodes = 0;
	let migrations = 0;
	let languageApplied = 0;
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, fields: { ...DEFAULT_FIELDS }, placeCache: { "name:leeds": [53.8, -1.55] } } as FamilyTreeSettings,
		graph: () => graph,
		saveSettings: async () => void saves++,
		openGeocode: () => void geocodes++,
		events: () => (isDefaultEvents(plugin.settings.events) ? t().defaultEvents : plugin.settings.events),
		applyLanguage: () => {
			languageApplied++;
			setLanguage(plugin.settings.language);
		},
		migratePlaceCache: async () => {
			migrations++;
			plugin.settings.placeCache = {};
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tab = new FamilyTreeSettingTab({} as any, plugin as any);
	return { tab, plugin, saves: () => saves, geocodes: () => geocodes, migrations: () => migrations, languageApplied: () => languageApplied };
}

const groups = (tab: FamilyTreeSettingTab) => tab.getSettingDefinitions() as SettingDefinitionGroup[];
const items = (tab: FamilyTreeSettingTab) => groups(tab).flatMap((g) => (g.items ?? []) as SettingDefinition[]);

test("definitions: every control key reads a real setting", () => {
	const { tab } = setup();
	assert.deepEqual(
		groups(tab).map((g) => g.heading),
		["Language", "Relationship labels", "Timeline", "Map", "Which notes are people", "Property names", "Diagram"]
	);
	const keys = items(tab).flatMap((d) => ("control" in d && d.control ? [d.control.key] : []));
	assert.equal(keys.length, 22, "the 20 controls of 1.0.x, the place notes folder and the interface language");
	for (const k of keys) assert.notEqual(tab.getControlValue(k), undefined, k);
	assert.equal(tab.getControlValue("fields.parentOf"), "parent_of");
	const me = items(tab).find((d) => d.name === "Me")!;
	assert.ok("control" in me && me.control?.type === "dropdown" && me.control.options["Family/George Miller.md"] === "George Miller");
});

test("setControlValue normalises input and saves", async () => {
	const { tab, plugin, saves } = setup();
	await tab.setControlValue("tag", " #Family ");
	await tab.setControlValue("fields.childOf", "  ");
	await tab.setControlValue("fields.marriedTo", " spouse ");
	await tab.setControlValue("labelLanguage", "en");
	await tab.setControlValue("defaultDepth", 5);
	await tab.setControlValue("showLabels", false);
	assert.equal(plugin.settings.tag, "Family");
	assert.equal(plugin.settings.fields.childOf, "child_of", "empty property name falls back to the default");
	assert.equal(plugin.settings.fields.marriedTo, "spouse");
	assert.equal(plugin.settings.labelLanguage, "en");
	assert.equal(plugin.settings.defaultDepth, 5);
	assert.equal(plugin.settings.showLabels, false);
	assert.equal(saves(), 6);
});

test("Obsidian < 1.13: display() draws the same settings with the classic API", async () => {
	setApiVersionOk(false);
	const { tab, plugin, geocodes, migrations } = setup();
	tab.display();
	assert.deepEqual(
		rendered.filter((r) => r.heading).map((r) => r.name),
		groups(tab).map((g) => g.heading)
	);
	assert.equal(rendered.filter((r) => !r.heading).length, items(tab).length);
	const row = (name: string) => rendered.find((r) => r.name === name)!;
	assert.equal(row("Tag").value, "family-tree");
	assert.equal(row("Default focus depth").kind, "slider");
	assert.deepEqual(
		rendered.filter((r) => r.kind === "button").map((r) => r.buttonText),
		["Restore", "Find", "Move"]
	);

	row("Tag").onChange!("#people");
	assert.equal(plugin.settings.tag, "people");
	row("Folder for place notes").onChange!(" Geo/Places ");
	assert.equal(plugin.settings.placeFolder, "Geo/Places");

	row("Find coordinates").onClick!();
	assert.equal(geocodes(), 1);

	// Actions that change other rows redraw them
	plugin.settings.events = "custom";
	row("Restore default events").onClick!();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(plugin.settings.events, en.defaultEvents);
	assert.equal(rendered.find((r) => r.name === "Historical events")!.value, en.defaultEvents);

	// The migration row only shows while there is something to move
	rendered.find((r) => r.name === "Move remembered coordinates into notes")!.onClick!();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(migrations(), 1);
	assert.equal(rendered.find((r) => r.name === "Move remembered coordinates into notes"), undefined);
});

test("Obsidian 1.13+: actions refresh through update()", async () => {
	setApiVersionOk(true);
	const { tab, plugin } = setup();
	let updates = 0;
	(tab as unknown as { update: () => void }).update = () => void updates++;
	const restore = items(tab).find((d) => d.name === "Restore default events")!;
	assert.ok("action" in restore && restore.action);
	plugin.settings.events = "custom";
	restore.action({} as HTMLElement, 0);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(plugin.settings.events, en.defaultEvents);
	assert.equal(updates, 1);
	const move = items(tab).find((d) => d.name === "Move remembered coordinates into notes")!;
	const visible = () => typeof move.visible === "function" && move.visible();
	assert.equal(visible(), true, "shown while plugin data still holds coordinates");
	plugin.settings.placeCache = {};
	assert.equal(visible(), false, "hidden once everything is moved");
	setApiVersionOk(false);
});

test("interface language: automatic follows Obsidian, a choice overrides it, everything switches", async () => {
	setApiVersionOk(false);
	setObsidianLanguage("de");
	const { tab, plugin, languageApplied } = setup();
	setLanguage(plugin.settings.language);
	tab.display();
	assert.ok(rendered.some((r) => r.heading && r.name === "Sprache"), "German headings with Obsidian in German");
	assert.equal(rendered.find((r) => r.name === "Historische Ereignisse")!.value, de.defaultEvents, "built-in events follow the language");
	assert.deepEqual(
		rendered.filter((r) => r.kind === "button").map((r) => r.buttonText),
		["Wiederherstellen", "Suchen", "Übertragen"]
	);

	await tab.setControlValue("language", "ru");
	assert.equal(plugin.settings.language, "ru");
	assert.equal(languageApplied(), 1);
	assert.ok(rendered.some((r) => r.heading && r.name === "Язык"), "redrawn in Russian");

	// A customised list isn't replaced by translations
	plugin.settings.events = "1900 Custom";
	assert.equal(tab.getControlValue("events"), "1900 Custom");

	await tab.setControlValue("language", "bogus");
	assert.equal(plugin.settings.language, "auto");
	setObsidianLanguage("en");
	setLanguage("auto");
});
