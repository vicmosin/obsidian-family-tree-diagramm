import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, RawNote } from "../src/model";
import { collectPlaces, lifePath, parseLocation, parsePlaces, PlaceIndex } from "../src/places";

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
	assert.deepEqual(parsePlaces("unbekannt"), []);
	assert.deepEqual(parsePlaces("vermutlich bei [[München]]"), [{ name: "München", isLink: true, uncertain: true }]);
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
		(link) => (link in placeNotes ? { path: `Places/${link}.md`, name: link, aliases: [], coords: placeNotes[link] } : null),
		new PlaceIndex([]),
		{ "name:manchester": [53.48, -2.24] }
	);
	const leeds = places.get("Places/Leeds, England.md")!;
	assert.equal(leeds.events.length, 2);
	assert.equal(leeds.events.find((e) => e.person === "George")!.uncertain, true);
	assert.deepEqual(places.get("Places/Manchester.md")!.coords, [53.48, -2.24], "note without coordinates falls back to the pre-1.1.0 plugin cache");
	assert.deepEqual(
		lifePath("George", places).map((s) => s.place.name),
		["Leeds, England", "Manchester", "Toronto"]
	);
});

test("place notes are found by name or alias, in any folder", () => {
	const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: fm });
	const notes = [
		n("George", { birth_date: "1931", birth_place: "York", lived_in: ["[[New Amsterdam]] 1950-1960", "new york 1961"] }),
		n("Helen", { birth_place: "[[Leeds]]" }),
	];
	const g = buildGraph(notes, (l) => notes.find((x) => x.basename === l) ?? null);
	const index = new PlaceIndex([
		{ path: "Anywhere/Deep/York.md", name: "York", aliases: [], coords: [53.96, -1.08] },
		{ path: "Geo/New York.md", name: "New York", aliases: ["New Amsterdam"], coords: [40.71, -74.0] },
		// An alias never hides a note whose file name matches
		{ path: "Geo/Leeds.md", name: "Leeds", aliases: ["York"], coords: [53.8, -1.55] },
	]);
	const places = collectPlaces(g, new Set(g.persons.keys()), () => null, index);
	assert.deepEqual([...places.keys()].sort(), ["Anywhere/Deep/York.md", "Geo/Leeds.md", "Geo/New York.md"]);
	assert.equal(places.get("Geo/New York.md")!.events.length, 2, "former name (alias) and lower-case text both match");
	assert.equal(places.get("Anywhere/Deep/York.md")!.events.length, 1);
	assert.deepEqual(places.get("Geo/Leeds.md")!.coords, [53.8, -1.55], "unresolved link falls back to the index");
});

test("a place remembers every name it is mentioned by, and old coordinates under any of them", () => {
	const n = (basename: string, fm: Record<string, unknown>): RawNote => ({ id: basename, basename, frontmatter: fm });
	const notes = [n("George", { birth_place: "Königsberg" }), n("Helen", { birth_place: "[[Kaliningrad]]" })];
	const g = buildGraph(notes, (l) => notes.find((x) => x.basename === l) ?? null);
	const note = { path: "Geo/Kaliningrad.md", name: "Kaliningrad", aliases: ["Königsberg"] };
	const places = collectPlaces(g, new Set(["Helen", "George"]), (l) => (l === "Kaliningrad" ? note : null), new PlaceIndex([note]), {
		"name:königsberg": [54.71, 20.51],
	});
	const place = places.get(note.path)!;
	assert.deepEqual([...place.mentions].sort(), ["Kaliningrad", "Königsberg"]);
	assert.deepEqual(place.coords, [54.71, 20.51]);
});
