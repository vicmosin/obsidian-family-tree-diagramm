import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { mockApp, TFile, TFolder } from "./obsidian-mock";
import { migratePlaceCache, savePlaceCoords } from "../src/placeNotes";
import { Coords, Place } from "../src/places";

const place = (name: string, notePath?: string, coords?: Coords): Place => ({
	key: notePath ?? `name:${name.toLowerCase()}`,
	name,
	notePath,
	coords,
	events: [],
});
const asApp = (a: ReturnType<typeof mockApp>) => a as unknown as App;

test("new place notes go to Obsidian's default folder when the setting is empty", async () => {
	const app = mockApp("Inbox");
	assert.equal(await savePlaceCoords(asApp(app), place("Gusev"), [54.59, 22.2], ""), "created");
	const f = app.files.get("Inbox/Gusev.md") as TFile;
	assert.deepEqual(f.frontmatter, { type: "place", location: [54.59, 22.2] });
	assert.ok(app.files.get("Inbox") instanceof TFolder, "missing folder is created");
});

test("vault root as default location, and the plugin's folder setting", async () => {
	const root = mockApp("/");
	await savePlaceCoords(asApp(root), place("York"), [53.96, -1.08], "");
	assert.ok(root.files.get("York.md"));
	const app = mockApp("Inbox");
	await savePlaceCoords(asApp(app), place("York"), [53.96, -1.08], " Geo//Places/ ");
	assert.ok(app.files.get("Geo/Places/York.md"), "setting wins and is normalised");
});

test("existing notes are updated, not duplicated, and keep their own type", async () => {
	const app = mockApp("Inbox");
	const linked = new TFile("Somewhere/Leeds, England.md");
	linked.frontmatter = { type: "city", aliases: ["Leeds"] };
	app.files.set(linked.path, linked);
	assert.equal(await savePlaceCoords(asApp(app), place("Leeds, England", linked.path), [53.8, -1.55], ""), "updated");
	assert.deepEqual(linked.frontmatter, { type: "city", aliases: ["Leeds"], location: [53.8, -1.55] });

	const sameName = new TFile("Inbox/Gusev.md");
	app.files.set(sameName.path, sameName);
	assert.equal(await savePlaceCoords(asApp(app), place("Gusev"), [54.59, 22.2], ""), "updated");
	assert.equal(app.files.size, 3, "no second Gusev note");
});

test("unsafe characters are removed from new file names", async () => {
	const app = mockApp("");
	await savePlaceCoords(asApp(app), place('Ростов-на-Дону: "старый" город?'), [47.22, 39.72], "Places");
	assert.ok(app.files.get("Places/Ростов-на-Дону старый город.md"));
});

test("migration moves remembered coordinates into notes", async () => {
	const app = mockApp("Inbox");
	const own = new TFile("Geo/Leeds.md");
	own.frontmatter = { type: "place", location: [53.8, -1.55] };
	app.files.set(own.path, own);
	const cache: Record<string, Coords> = {
		"name:gusev": [54.59, 22.2],
		"name:leeds": [0, 0],
		"name:nowhere": [1, 1],
	};
	const places = [
		place("Gusev", undefined, cache["name:gusev"]),
		place("Leeds", own.path, [53.8, -1.55]),
		place("Toronto", undefined, undefined),
	];
	const res = await migratePlaceCache(asApp(app), places, cache, "");
	assert.deepEqual(res, { moved: 2, left: 1 });
	assert.deepEqual((app.files.get("Inbox/Gusev.md") as TFile).frontmatter, { type: "place", location: [54.59, 22.2] });
	assert.deepEqual(own.frontmatter.location, [53.8, -1.55], "a note's own coordinates are kept");
	assert.deepEqual(cache, { "name:nowhere": [1, 1] }, "unmentioned places stay in plugin data");
	assert.equal(app.files.get("Inbox/Toronto.md"), undefined);
});
