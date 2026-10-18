import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, RawNote } from "../src/model";
import { collectPlaces, lifePath, parseLocation, parsePlaces } from "../src/places";

test("parsePlaces: links win over surrounding text", () => {
	assert.deepEqual(
		parsePlaces("Unknown, probably a village near [[Leeds, England]]"),
		[{ name: "Leeds, England", isLink: true, uncertain: true }]
	);
	assert.deepEqual(
		parsePlaces("Неизвестно, предположительно рядом [[Leeds, England]]"),
		[{ name: "Leeds, England", isLink: true, uncertain: true }]
	);
	assert.deepEqual(parsePlaces("[[Manchester]]"), [{ name: "Manchester", isLink: true, uncertain: false }]);
	assert.deepEqual(parsePlaces([["York"]]), [{ name: "York", isLink: true, uncertain: false }]);
	assert.deepEqual(parsePlaces("York"), [{ name: "York", isLink: false, uncertain: false }]);
	assert.deepEqual(parsePlaces("Неизвестно"), []);
	assert.deepEqual(parsePlaces("Unknown"), []);
	assert.deepEqual(parsePlaces(["[[Manchester]] 1950-1975", "Toronto 1991"]), [
		{ name: "Manchester", isLink: true, uncertain: false, from: 1950, to: 1975 },
		{ name: "Toronto", isLink: false, uncertain: false, from: 1991, to: 1991 },
	]);
});

test("parseLocation accepts Map View formats", () => {
	assert.deepEqual(parseLocation([48.57, 39.31]), [48.57, 39.31]);
	assert.deepEqual(parseLocation(["48.57", "39.31"]), [48.57, 39.31]);
	assert.deepEqual(parseLocation("48.57, 39.31"), [48.57, 39.31]);
	assert.equal(parseLocation("Leeds"), undefined);
	assert.equal(parseLocation([200, 10]), undefined);
});

test("collectPlaces groups people by place and orders a life path", () => {
	const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: fm });
	const notes = [
		n("George", { birth_date: "1931", birth_place: "near [[Leeds, England]]", death_date: "2024", death_place: "[[Toronto]]", lived_in: ["[[Manchester]] 1950-1975"] }),
		n("Helen", { birth_date: "1933", birth_place: "[[Leeds, England]]" }),
	];
	const g = buildGraph(notes, (l) => notes.find((x) => x.basename === l) ?? null);
	const placeNotes: Record<string, [number, number] | undefined> = { "Leeds, England": [53.8, -1.55], Toronto: [43.65, -79.38], Manchester: undefined };
	const places = collectPlaces(
		g,
		new Set(g.persons.keys()),
		(link) => (link in placeNotes ? { path: `Places/${link}.md`, name: link, coords: placeNotes[link] } : null),
		{ "Places/Manchester.md": [53.48, -2.24] }
	);
	const leeds = places.get("Places/Leeds, England.md")!;
	assert.equal(leeds.events.length, 2);
	assert.equal(leeds.events.find((e) => e.person === "George")!.uncertain, true);
	assert.deepEqual(places.get("Places/Manchester.md")!.coords, [53.48, -2.24], "coordinates from the plugin cache");
	assert.deepEqual(
		lifePath("George", places).map((s) => s.place.name),
		["Leeds, England", "Manchester", "Toronto"]
	);
});
