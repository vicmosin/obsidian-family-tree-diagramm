import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, extractRelLinks, parseDate, RawNote } from "../src/model";
import { computeLayout } from "../src/layout";
import { Kinship } from "../src/kinship";
import { findIssues } from "../src/check";
import { DEFAULT_FIELDS } from "../src/model";

test("uncertain markers", () => {
	assert.deepEqual(extractRelLinks('"[[Rose]] ?"'), [{ link: "Rose", uncertain: true }]);
	assert.deepEqual(extractRelLinks("maybe [[Son]]"), [{ link: "Son", uncertain: true }]);
	assert.deepEqual(extractRelLinks("возможно [[Son]]"), [{ link: "Son", uncertain: true }]);
	assert.deepEqual(extractRelLinks("[[A]] ?, [[B]]"), [
		{ link: "A", uncertain: true },
		{ link: "B", uncertain: false },
	]);
	assert.deepEqual(extractRelLinks("[[Leeds, England]]"), [{ link: "Leeds, England", uncertain: false }]);
	assert.deepEqual(extractRelLinks([["Nicholas"]]), [{ link: "Nicholas", uncertain: false }]);
});

test("approximate dates", () => {
	assert.equal(parseDate("1931-11-09")!.label, "1931");
	assert.equal(parseDate("около 1895")!.label, "~1895");
	assert.equal(parseDate("1931?")!.label, "~1931");
	assert.equal(parseDate("до 1941")!.label, "<1941");
	assert.equal(parseDate("после 1945")!.label, ">1945");
	assert.equal(parseDate("1890-е")!.label, "1890-е");
	assert.equal(parseDate("1890s")!.label, "1890s");
	assert.equal(parseDate("1890–1895")!.label, "~1890");
	assert.equal(parseDate("Неизвестно")!.year, undefined);
});

// A made-up family across 4 generations; "me" = James. English names carry no patronymic, so genders are explicit
const GENDER: Record<string, "m" | "f"> = {
	"Henry Baker": "m", "Arthur Baker": "m", "Anne Baker": "f", "Edward Baker": "m", "Olivia Baker": "f", "Peter Cole": "m",
	"Thomas Baker": "m", "Susan Baker": "f", "Helen Clark": "f", "Ellen Baker": "f", "Oscar Kim": "m", "James Baker": "m",
	"Emma Baker": "f", "Robert White": "m", "Mary Baker": "f", Rose: "f",
};
const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: { gender: GENDER[basename], ...fm } });
const NOTES = [
	n("Henry Baker", { parent_of: ["[[Arthur Baker]]", "[[Edward Baker]]"], birth_date: "1900" }),
	n("Arthur Baker", { married_to: "[[Anne Baker]]", parent_of: "[[Thomas Baker]]", birth_date: "1930" }),
	n("Anne Baker", { birth_date: "1932" }),
	n("Edward Baker", { parent_of: "[[Olivia Baker]]", birth_date: "1935" }),
	n("Olivia Baker", { parent_of: "[[Peter Cole]]", birth_date: "1960" }),
	n("Peter Cole", { birth_date: "1985" }),
	n("Thomas Baker", { married_to: "[[Susan Baker]]", parent_of: ["[[James Baker]]", "[[Mary Baker]]"], siblings: "[[Ellen Baker]]", birth_date: "1955" }),
	n("Susan Baker", { birth_date: "1958", child_of: "[[Helen Clark]]" }),
	n("Helen Clark", { birth_date: "1933" }),
	n("Ellen Baker", { birth_date: "1960", married_to: "[[Oscar Kim]]" }),
	n("Oscar Kim", {}),
	n("James Baker", { birth_date: "1985", married_to: "[[Emma Baker]]" }),
	n("Emma Baker", { child_of: "[[Robert White]]" }),
	n("Robert White", {}),
	n("Mary Baker", { birth_date: "1988", parent_of: "[[Leo]]" }),
	n("Leo", {}),
	n("Rose", { parent_of: "[[Rose's child]] ?" }),
	n("Rose's child", { child_of: "[[Thomas Baker]] ?" }),
];
const resolve = (l: string) => NOTES.find((x) => x.basename === l) ?? null;
const g = buildGraph(NOTES, resolve);
const ru = new Kinship(g, "James Baker", "ru");
const en = new Kinship(g, "James Baker", "en");
const label = (k: Kinship, id: string) => k.get(id)?.label;

test("Russian kinship terms", () => {
	assert.equal(label(ru, "James Baker"), "я");
	assert.equal(label(ru, "Thomas Baker"), "отец");
	assert.equal(label(ru, "Arthur Baker"), "дедушка");
	assert.equal(label(ru, "Henry Baker"), "прадедушка");
	assert.equal(label(ru, "Edward Baker"), "двоюродный дедушка");
	assert.equal(label(ru, "Olivia Baker"), "двоюродная тётя");
	assert.equal(label(ru, "Peter Cole"), "троюродный брат");
	assert.equal(label(ru, "Ellen Baker"), "тётя");
	assert.equal(label(ru, "Oscar Kim"), "муж тёти");
	assert.equal(label(ru, "Mary Baker"), "сестра");
	assert.equal(label(ru, "Emma Baker"), "жена");
	assert.equal(label(ru, "Robert White"), "тесть");
	assert.equal(label(ru, "Helen Clark"), "бабушка");
	assert.equal(label(ru, "Susan Baker"), "мать", "inferred from Thomas's only spouse");
	assert.equal(label(ru, "Rose's child"), "единокровный брат/сестра ?");
	assert.equal(ru.get("Rose's child")!.uncertain, true);
	assert.deepEqual(ru.get("Olivia Baker")!.path, [
		"James Baker", "Thomas Baker", "Arthur Baker", "Henry Baker",
		"Edward Baker", "Olivia Baker",
	]);
});

test("Russian terms seen from other people", () => {
	const fromOlivia = new Kinship(g, "Olivia Baker", "ru");
	assert.equal(label(fromOlivia, "James Baker"), "двоюродный племянник");
	const fromEdward = new Kinship(g, "Edward Baker", "ru");
	assert.equal(label(fromEdward, "James Baker"), "внучатый племянник");
	assert.equal(label(fromEdward, "Thomas Baker"), "племянник");
	const fromEmma = new Kinship(g, "Emma Baker", "ru");
	assert.equal(label(fromEmma, "Thomas Baker"), "свёкор");
	assert.equal(label(fromEmma, "Mary Baker"), "золовка");
	const fromOscar = new Kinship(g, "Oscar Kim", "ru");
	assert.equal(label(fromOscar, "Thomas Baker"), "шурин");
	const fromThomas = new Kinship(g, "Thomas Baker", "ru");
	assert.equal(label(fromThomas, "Emma Baker"), "невестка");
	assert.equal(label(fromThomas, "Robert White"), "сват");
	assert.equal(label(fromThomas, "Helen Clark"), "тёща");
});

test("English kinship terms", () => {
	assert.equal(label(en, "Edward Baker"), "great-uncle");
	assert.equal(label(en, "Olivia Baker"), "first cousin once removed");
	assert.equal(label(en, "Peter Cole"), "second cousin");
	assert.equal(label(en, "Robert White"), "father-in-law");
	assert.equal(label(en, "Oscar Kim"), "aunt's husband");
});

test("couples are placed side by side, facing their parents", () => {
	const l = computeLayout(g, new Set(g.persons.keys()));
	const node = (id: string) => l.nodes.get(id)!;
	for (const [a, b] of [
		["Arthur Baker", "Anne Baker"],
		["James Baker", "Emma Baker"],
		["Ellen Baker", "Oscar Kim"],
	]) {
		assert.equal(node(a).y, node(b).y, `${a} and ${b} on the same row`);
		assert.ok(Math.abs(node(a).x - node(b).x) <= 220 + 44 + 1, `${a} next to ${b}`);
	}
	const couples = l.unions.filter((u) => u.kind === "couple");
	assert.ok(couples.length >= 4);
	const roseFamily = l.unions.find((u) => u.children.includes("Rose's child"))!;
	assert.ok(roseFamily.uncertainChildren.has("Rose's child"));
	// The uncertain child must not be drawn under Thomas + Susan
	assert.ok(!roseFamily.partners.includes("Susan Baker"));
});

test("data check", () => {
	const issues = findIssues(g, DEFAULT_FIELDS, 2026);
	const oneWay = issues.filter((i) => i.kind === "one-way");
	assert.ok(oneWay.some((i) => i.fix!.person === "Anne Baker" && i.fix!.field === "marriedTo"));
	assert.ok(oneWay.some((i) => i.fix!.person === "James Baker" && i.fix!.field === "childOf"));
	const roseFix = oneWay.find((i) => i.fix!.person === "Rose's child" && i.fix!.target === "Rose");
	assert.equal(roseFix?.fix!.uncertain, true);
	const dates = issues.filter((i) => i.kind === "dates");
	assert.deepEqual(dates.map((i) => i.person), ["Henry Baker"], "only the 1900-born man without a death date");

	const badNotes = [
		n("A", { birth_date: "1950", parent_of: "[[B]]", death_date: "1940" }),
		n("B", { birth_date: "1955", parent_of: "[[C]]" }),
		n("C", { birth_date: "около 1960" }),
	];
	const bad = buildGraph(badNotes, (l) => badNotes.find((x) => x.basename === l) ?? null);
	const msgs = findIssues(bad, DEFAULT_FIELDS, 2026).filter((i) => i.kind === "dates").map((i) => i.message);
	assert.ok(msgs.some((m) => m.includes("before being born")), msgs.join("; "));
	assert.ok(msgs.some((m) => m.includes("after A died")), msgs.join("; "));
	assert.ok(msgs.some((m) => m.includes("was 5 when B")));
	assert.ok(!msgs.some((m) => m.includes("when C was born")), "approximate dates aren't checked for parent age");
});
