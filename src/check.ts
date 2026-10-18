import { FamilyGraph, FieldNames, RelationField, REVERSE_FIELD } from "./model";

export type IssueKind = "one-way" | "missing-note" | "dates" | "structure" | "missing-birth";

/** Adds `target` to `field` in the note of `person` */
export interface ReverseFix {
	person: string;
	field: RelationField;
	target: string;
	uncertain: boolean;
}

export interface Issue {
	kind: IssueKind;
	person: string;
	message: string;
	fix?: ReverseFix;
}

export const ISSUE_TITLES: Record<IssueKind, string> = {
	"one-way": "Links written on one side only",
	"missing-note": "People without a note",
	dates: "Suspicious dates",
	structure: "Structure problems",
	"missing-birth": "No birth date",
};

export function findIssues(g: FamilyGraph, fields: FieldNames, thisYear = new Date().getFullYear()): Issue[] {
	const issues: Issue[] = [];
	const name = (id: string) => g.persons.get(id)?.name ?? id;
	const isGhost = (id: string) => g.persons.get(id)?.ghost ?? true;

	// One-way links
	const declared = new Set(g.declarations.map((d) => `${d.from}|${d.field}|${d.to}`));
	const seenFix = new Set<string>();
	for (const d of g.declarations) {
		if (isGhost(d.to) || isGhost(d.from)) continue;
		const rev = REVERSE_FIELD[d.field];
		const key = `${d.to}|${rev}|${d.from}`;
		if (declared.has(key) || seenFix.has(key)) continue;
		seenFix.add(key);
		issues.push({
			kind: "one-way",
			person: d.to,
			message: `${fields[rev]} should include ${name(d.from)} (stated in ${name(d.from)}'s ${fields[d.field]})`,
			fix: { person: d.to, field: rev, target: d.from, uncertain: d.uncertain },
		});
	}

	// Ghosts
	for (const p of g.persons.values()) {
		if (!p.ghost) continue;
		const by = [...new Set(g.declarations.filter((d) => d.to === p.id).map((d) => name(d.from)))];
		issues.push({ kind: "missing-note", person: p.id, message: `mentioned by ${by.join(", ")}` });
	}

	// Dates
	for (const p of g.persons.values()) {
		if (p.ghost) continue;
		const b = p.birthInfo;
		const d = p.deathInfo;
		if (!b?.year) {
			issues.push({ kind: "missing-birth", person: p.id, message: b ? `birth date "${b.text}" has no year` : "no birth date" });
		}
		if (b?.year && d?.year && d.year < b.year) {
			issues.push({ kind: "dates", person: p.id, message: `died (${d.year}) before being born (${b.year})` });
		}
		if (b?.year && !d && thisYear - b.year > 105) {
			issues.push({ kind: "dates", person: p.id, message: `born ${thisYear - b.year} years ago but no death date` });
		}
		for (const c of g.get(g.children, p.id)) {
			const cp = g.persons.get(c)!;
			const cb = cp.birthInfo;
			if (!cb?.year) continue;
			const approx = cb.approx || !!b?.approx;
			if (b?.year) {
				const age = cb.year - b.year;
				if (age < 0 && (!approx || age < -5)) issues.push({ kind: "dates", person: p.id, message: `child ${name(c)} (${cb.year}) born before the parent (${b.year})` });
				else if (age >= 0 && age < 13 && !approx) issues.push({ kind: "dates", person: p.id, message: `was ${age} when ${name(c)} was born` });
				else if (!approx && ((p.gender === "f" && age > 55) || age > 80)) issues.push({ kind: "dates", person: p.id, message: `was ${age} when ${name(c)} was born` });
			}
			// A father may die before the child is born, so allow a year
			if (d?.year && !d.approx && !cb.approx && cb.year > d.year + (p.gender === "f" ? 0 : 1)) {
				issues.push({ kind: "dates", person: p.id, message: `${name(c)} born ${cb.year}, after ${name(p.id)} died (${d.year})` });
			}
		}
	}

	// Structure
	for (const p of g.persons.values()) {
		const certainParents = [...g.get(g.parents, p.id)].filter((x) => !g.isUncertain("parent", x, p.id));
		if (certainParents.length > 2) {
			issues.push({ kind: "structure", person: p.id, message: `has ${certainParents.length} parents: ${certainParents.map(name).join(", ")}` });
		}
		for (const s of g.get(g.spouses, p.id)) {
			if (p.id < s && (g.get(g.parents, p.id).has(s) || g.get(g.children, p.id).has(s))) {
				issues.push({ kind: "structure", person: p.id, message: `${name(s)} is listed as both spouse and parent/child` });
			}
		}
	}
	for (const id of ancestorCycles(g)) {
		issues.push({ kind: "structure", person: id, message: "is listed as their own ancestor (parent/child links form a loop)" });
	}
	return issues;
}

function ancestorCycles(g: FamilyGraph): string[] {
	const state = new Map<string, 1 | 2>();
	const inCycle = new Set<string>();
	const stack: string[] = [];
	const visit = (id: string) => {
		state.set(id, 1);
		stack.push(id);
		for (const p of g.get(g.parents, id)) {
			if (state.get(p) === 1) stack.slice(stack.indexOf(p)).forEach((x) => inCycle.add(x));
			else if (!state.has(p)) visit(p);
		}
		stack.pop();
		state.set(id, 2);
	};
	for (const id of g.persons.keys()) if (!state.has(id)) visit(id);
	return [...inCycle];
}
