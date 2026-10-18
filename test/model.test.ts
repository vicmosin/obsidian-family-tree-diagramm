import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, extractLinks, focusSet, guessGender, parseName } from "../src/model";
import { buildFamilies, computeLayout } from "../src/layout";
import { NOTES, resolver } from "./fixtures";

const V = "Family/George Miller.md";
const N = "Family/Helen Miller (Clark).md";
const S = "Family/Susan Turner (Baker, Miller).md";
const T = "Family/Teresa Miller.md";
const K = "Family/Nicholas Miller.md";

test("extractLinks handles strings, lists, unquoted [[x]] and aliases", () => {
	assert.deepEqual(extractLinks('"[[A]]"'), ["A"]);
	assert.deepEqual(extractLinks(["[[A|alias]]", [["B"]], "[[C#Heading]]"]), ["A", "B", "C"]);
	assert.deepEqual(extractLinks("[[A]], [[B]]"), ["A", "B"]);
	assert.deepEqual(extractLinks(null), []);
	assert.deepEqual(extractLinks(""), []);
});

test("parseName splits previous surnames", () => {
	assert.deepEqual(parseName("Susan Turner (Baker, Miller)"), {
		name: "Susan Turner",
		altNames: "Baker, Miller",
	});
	assert.deepEqual(parseName("George Miller"), { name: "George Miller" });
});

test("guessGender uses property then patronymic", () => {
	// Russian patronymics: "Иван Петрович", "Мария Ивановна"
	assert.equal(guessGender(undefined, "Иван Петрович Иванов"), "m");
	assert.equal(guessGender(undefined, "Мария Ивановна Иванова"), "f");
	assert.equal(guessGender(undefined, "Lucy"), undefined);
	assert.equal(guessGender("f", "Lucy"), "f");
	assert.equal(guessGender("ж", "Lucy"), "f");
});

test("buildGraph links both directions and creates ghosts", () => {
	const g = buildGraph(NOTES, resolver(NOTES));
	assert.ok(g.get(g.children, V).has(S));
	assert.ok(g.get(g.parents, S).has(V));
	assert.ok(g.get(g.parents, S).has(N), "child_of from Susan");
	assert.ok(g.get(g.spouses, N).has(V));
	assert.ok(g.get(g.siblings, T).has(V));
	assert.ok(g.get(g.siblings, K).has(V), "unquoted [[x]] parsed as nested list");
	const sergey = g.persons.get("ghost:walter miller")!;
	assert.equal(sergey.ghost, true);
	assert.equal(g.persons.get(V)!.birth, "1931-11-09");
	assert.equal(g.persons.get(V)!.gender, "m");
});

test("siblings without listed parents join George's parents' family", () => {
	const g = buildGraph(NOTES, resolver(NOTES));
	const fams = buildFamilies(g, new Set(g.persons.keys()), true);
	const parentsFamily = [...fams.values()].find((f) => f.children.has(V))!;
	assert.equal(parentsFamily.partners.size, 2);
	assert.ok(parentsFamily.children.has(T));
	assert.ok(parentsFamily.children.has(K));
});

test("focusSet keeps the right relatives", () => {
	const g = buildGraph(NOTES, resolver(NOTES));
	const s = focusSet(g, S, 1);
	assert.ok(s.has(S) && s.has(V) && s.has(N));
	assert.ok(s.has(T), "siblings of ancestors (aunts/uncles) are included");
	assert.ok(!s.has("ghost:lucy"), "cousins are not");
	assert.ok(!s.has("ghost:walter miller"), "grandparents are beyond depth 1");
});

test("layout puts generations top to bottom", () => {
	const g = buildGraph(NOTES, resolver(NOTES));
	const l = computeLayout(g, new Set(g.persons.keys()));
	const y = (id: string) => l.nodes.get(id)!.y;
	assert.ok(y("ghost:walter miller") < y(V));
	assert.ok(y(V) < y(S));
	assert.equal(y(V), y(N));
	assert.equal(y(V), y(T));
});
