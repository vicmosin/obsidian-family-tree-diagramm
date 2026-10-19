import { test } from "node:test";
import assert from "node:assert/strict";
import type { SettingDefinition, SettingDefinitionGroup } from "obsidian";
import { rendered, setApiVersionOk } from "./obsidian-mock";
import { DEFAULT_SETTINGS, FamilyTreeSettings, FamilyTreeSettingTab } from "../src/settings";
import { DEFAULT_FIELDS, FamilyGraph } from "../src/model";
import { DEFAULT_EVENTS_RU } from "../src/timeline";

function setup() {
	const graph = new FamilyGraph();
	graph.persons.set("Family/George Miller.md", { id: "Family/George Miller.md", fullName: "George Miller", name: "George Miller", ghost: false, gender: "m" });
	let saves = 0;
	let geocodes = 0;
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, fields: { ...DEFAULT_FIELDS }, placeCache: { "name:leeds": [53.8, -1.55] } } as FamilyTreeSettings,
		graph: () => graph,
		saveSettings: async () => void saves++,
		openGeocode: () => void geocodes++,
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tab = new FamilyTreeSettingTab({} as any, plugin as any);
	return { tab, plugin, saves: () => saves, geocodes: () => geocodes };
}

const groups = (tab: FamilyTreeSettingTab) => tab.getSettingDefinitions() as SettingDefinitionGroup[];
const items = (tab: FamilyTreeSettingTab) => groups(tab).flatMap((g) => (g.items ?? []) as SettingDefinition[]);

test("definitions: every control key reads a real setting", () => {
	const { tab } = setup();
	assert.deepEqual(
		groups(tab).map((g) => g.heading),
		["Relationship labels", "Timeline", "Map", "Which notes are people", "Property names", "Diagram"]
	);
	const keys = items(tab).flatMap((d) => ("control" in d && d.control ? [d.control.key] : []));
	assert.equal(keys.length, 20, "same 20 controls as the old settings screen");
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
	const { tab, plugin, geocodes } = setup();
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
		["Restore", "Find", "Forget"]
	);

	row("Tag").onChange!("#people");
	assert.equal(plugin.settings.tag, "people");

	row("Find coordinates").onClick!();
	assert.equal(geocodes(), 1);

	// Actions that change other rows redraw them
	plugin.settings.events = "custom";
	row("Restore default events").onClick!();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(plugin.settings.events, DEFAULT_EVENTS_RU);
	assert.equal(rendered.find((r) => r.name === "Historical events")!.value, DEFAULT_EVENTS_RU);
	rendered.find((r) => r.name === "Forget remembered coordinates")!.onClick!();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(plugin.settings.placeCache, {});
	assert.match(rendered.find((r) => r.name === "Forget remembered coordinates")!.desc!, /^0 places/);
});

test("Obsidian 1.13+: actions refresh through update()", async () => {
	setApiVersionOk(true);
	const { tab, plugin } = setup();
	let updates = 0;
	(tab as unknown as { update: () => void }).update = () => void updates++;
	const forget = items(tab).find((d) => d.name === "Forget remembered coordinates")!;
	assert.ok("action" in forget && forget.action);
	forget.action({} as HTMLElement, 0);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(plugin.settings.placeCache, {});
	assert.equal(updates, 1);
	setApiVersionOk(false);
});
