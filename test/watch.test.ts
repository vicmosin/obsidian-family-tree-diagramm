import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, RawNote } from "../src/model";
import { noteName, referencedNames } from "../src/watch";

test("names of linked-only people and of places count as referenced", () => {
	const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: fm });
	const notes = [n("George", { birth_place: "near [[Geo/Leeds]]", lived_in: "York 1950-1960", married_to: "[[People/Helen Brown]]" })];
	const g = buildGraph(notes, (l) => notes.find((x) => x.basename === l) ?? null);
	const names = referencedNames(g);
	for (const name of ["leeds", "york", "helen brown"]) assert.ok(names.has(name), name);
	assert.ok(!names.has("george"), "people with a note are tracked by path instead");
	assert.equal(noteName("Geo/Old Towns/Leeds "), "leeds");
});
