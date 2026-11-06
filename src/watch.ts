import { FamilyGraph } from "./model";
import { parsePlaces } from "./places";

/** Lower-case file name a link or plain place name points to: `Geo/Leeds` → `leeds` */
export function noteName(link: string): string {
	return (link.split("/").pop() ?? link).trim().toLowerCase();
}

/**
 * Names that person notes mention without a note of their own in the tree: people who are only
 * linked (ghosts) and places. Creating or editing a note with one of these names changes the tree.
 */
export function referencedNames(g: FamilyGraph): Set<string> {
	const names = new Set<string>();
	for (const p of g.persons.values()) {
		if (p.ghost && p.linktext) names.add(noteName(p.linktext));
		for (const raw of [p.places?.birth, p.places?.death, p.places?.lived]) {
			for (const m of parsePlaces(raw)) names.add(noteName(m.name));
		}
	}
	return names;
}
