import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, RawNote } from "../src/model";
import { buildRows, parseEvents, DEFAULT_EVENTS_RU } from "../src/timeline";

const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: fm });
const NOTES = [
	n("Grandpa", { birth_date: "около 1900", death_date: "1970", married_to: "[[Grandma]]", parent_of: "[[Father]]" }),
	n("Grandma", { birth_date: "1905" }),
	n("Father", { birth_date: "1931-11-09", married_to: "[[Mother]]", parent_of: "[[Me]]" }),
	n("Mother", { birth_date: "1933" }),
	n("Me", { birth_date: "1985" }),
	n("Great-grandpa", { death_date: "до 1945", parent_of: "[[Mother]]" }),
	n("Nameless", { child_of: "[[Grandpa]]" }),
];
const g = buildGraph(NOTES, (l) => NOTES.find((x) => x.basename === l) ?? null);
const all = new Set(g.persons.keys());

test("parseEvents", () => {
	assert.deepEqual(parseEvents("1941-1945 War\n1991 Collapse\nbad line"), [
		{ from: 1941, to: 1945, label: "War" },
		{ from: 1991, to: 1991, label: "Collapse" },
	]);
	assert.equal(parseEvents(DEFAULT_EVENTS_RU).length, 7);
});

test("rows: spans, estimates and undated people", () => {
	const { rows, undated } = buildRows(g, all, "birth", 2026);
	const row = (id: string) => rows.find((r) => r.person.id === id)!;
	assert.deepEqual(undated.map((p) => p.id), ["Nameless"]);
	assert.equal(row("Me").alive, true);
	assert.equal(row("Me").end, 2026);
	assert.equal(row("Grandpa").startFuzzy, true);
	assert.equal(row("Grandpa").end, 1970);
	// Born 1905, no death date, would be 121 → not alive, end estimated and faded
	assert.equal(row("Grandma").alive, false);
	assert.equal(row("Grandma").endFuzzy, true);
	// Only an approximate death year: start estimated
	assert.equal(row("Great-grandpa").end, 1945);
	assert.equal(row("Great-grandpa").startFuzzy, true);
	assert.deepEqual(rows.map((r) => r.person.id), ["Great-grandpa", "Grandpa", "Grandma", "Father", "Mother", "Me"]);
});

test("family order follows the tree: generations, couples together", () => {
	const ids = buildRows(g, all, "family", 2026).rows.map((r) => r.person.id);
	const idx = (id: string) => ids.indexOf(id);
	assert.ok(idx("Grandpa") < idx("Father") && idx("Father") < idx("Me"));
	assert.equal(Math.abs(idx("Father") - idx("Mother")), 1);
	assert.equal(Math.abs(idx("Grandpa") - idx("Grandma")), 1);
});
