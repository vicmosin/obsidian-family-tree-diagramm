import { FamilyGraph, Person, UNCERTAIN, WIKILINK } from "./model";

export type PlaceRole = "birth" | "death" | "lived";
export type Coords = [number, number];

/** One place mention inside a property value */
export interface PlaceMention {
	/** Link target or plain-text name */
	name: string;
	isLink: boolean;
	/** "предположительно", "рядом с", "?" … */
	uncertain: boolean;
	/** Years written next to a lived_in entry: "[[Manchester]] 1950-1960" */
	from?: number;
	to?: number;
}

const NEAR = /рядом|около|возле|под\s|недалеко|near|close to|around/i;
const UNKNOWN = /^(неизвестно|не известно|unknown|\?|-|—)$/i;

/**
 * Places in a property value. When a value contains links, only the links count and the
 * surrounding text just qualifies them: "Unknown, probably a village near [[Leeds, England]]"
 * → Leeds, England (uncertain).
 */
export function parsePlaces(value: unknown): PlaceMention[] {
	const out: PlaceMention[] = [];
	const visit = (v: unknown) => {
		if (v == null) return;
		if (Array.isArray(v)) {
			// Unquoted [[x]] in YAML is a nested list holding the link text
			if (v.length === 1 && typeof v[0] === "string" && !Array.isArray(v[0]) && !v[0].includes("[[")) {
				const name = v[0].trim();
				if (name) out.push({ name, isLink: true, uncertain: false });
				return;
			}
			v.forEach(visit);
			return;
		}
		if (typeof v !== "string") return;
		const s = v.trim();
		if (!s) return;
		const links = [...s.matchAll(WIKILINK)].map((m) => m[1].trim());
		const rest = s.replace(WIKILINK, " ");
		const years = [...rest.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => Number(m[1]));
		const range = years.length ? { from: years[0], to: years[1] ?? years[0] } : {};
		if (links.length) {
			const uncertain = UNCERTAIN.test(rest) || NEAR.test(rest);
			for (const name of links) out.push({ name, isLink: true, uncertain, ...range });
			return;
		}
		const name = s.replace(/(?<!\d)\d{4}(\s*[-–]\s*\d{4})?(?!\d)/g, "").replace(/\s+/g, " ").replace(/^[,;\s]+|[,;\s]+$/g, "");
		if (!name || UNKNOWN.test(name) || name.length > 80) return;
		out.push({ name: name.replace(UNCERTAIN, "").trim() || name, isLink: false, uncertain: UNCERTAIN.test(s), ...range });
	};
	visit(value);
	return out;
}

/** Map View-compatible `location`: [lat, lng], ["lat", "lng"] or "lat, lng" */
export function parseLocation(v: unknown): Coords | undefined {
	let parts: unknown[] | undefined;
	if (Array.isArray(v)) parts = v.length === 1 && typeof v[0] === "string" ? v[0].split(",") : v;
	else if (typeof v === "string") parts = v.split(",");
	if (!parts || parts.length !== 2) return undefined;
	const [lat, lng] = parts.map((x) => Number(String(x).trim()));
	if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
	return [lat, lng];
}

export interface PlaceEvent {
	person: string;
	role: PlaceRole;
	year?: number;
	to?: number;
	uncertain: boolean;
}

export interface Place {
	/** Note path for place notes, "name:<lowercase name>" otherwise */
	key: string;
	name: string;
	/** Place note, if the place is a link to an existing note */
	notePath?: string;
	coords?: Coords;
	events: PlaceEvent[];
}

/** What the vault knows about a place link: its note and the note's `location` */
export type PlaceResolver = (link: string, fromPath: string) => { path: string; name: string; coords?: Coords } | null;

export function placeKey(name: string) {
	return "name:" + name.trim().toLowerCase();
}

export function collectPlaces(
	g: FamilyGraph,
	visible: Set<string>,
	resolve: PlaceResolver,
	cache: Record<string, Coords>
): Map<string, Place> {
	const places = new Map<string, Place>();
	for (const id of visible) {
		const p = g.persons.get(id)!;
		if (!p.places) continue;
		const roles: [PlaceRole, unknown][] = [
			["birth", p.places.birth],
			["death", p.places.death],
			["lived", p.places.lived],
		];
		for (const [role, raw] of roles) {
			for (const m of parsePlaces(raw)) {
				const note = m.isLink ? resolve(m.name, p.path ?? "") : null;
				const key = note?.path ?? placeKey(m.name);
				let place = places.get(key);
				if (!place) {
					place = { key, name: note?.name ?? m.name, notePath: note?.path, coords: note?.coords ?? cache[key], events: [] };
					places.set(key, place);
				}
				place.events.push({ person: id, role, year: eventYear(p, role, m), to: role === "lived" ? m.to : undefined, uncertain: m.uncertain });
			}
		}
	}
	return places;
}

function eventYear(p: Person, role: PlaceRole, m: PlaceMention): number | undefined {
	if (role === "birth") return p.birthInfo?.year;
	if (role === "death") return p.deathInfo?.year;
	return m.from;
}

/** Ordered stops of one person's life that have coordinates: birth → lived (by year) → death */
export function lifePath(person: string, places: Map<string, Place>): { place: Place; event: PlaceEvent }[] {
	const stops: { place: Place; event: PlaceEvent }[] = [];
	for (const place of places.values()) {
		if (!place.coords) continue;
		for (const event of place.events) if (event.person === person) stops.push({ place, event });
	}
	const rank = (e: PlaceEvent) => (e.role === "birth" ? 0 : e.role === "death" ? 2 : 1);
	return stops.sort((a, b) => rank(a.event) - rank(b.event) || (a.event.year ?? 0) - (b.event.year ?? 0));
}
