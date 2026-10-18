export type Gender = "m" | "f" | undefined;

export interface DateInfo {
	/** Original text */
	text: string;
	/** Best-guess year, used for sorting and checks */
	year?: number;
	/** Not an exact date: "около 1895", "1890-е", "до 1941", "1931?" */
	approx: boolean;
	/** Short form for cards: "1931", "~1895", "<1941", ">1941", "1890-е" */
	label?: string;
}

export interface Person {
	id: string;
	/** Full note name, e.g. "Susan Turner (Baker, Miller)" */
	fullName: string;
	/** Name without the parenthesised part */
	name: string;
	/** Previous / maiden surnames from the parenthesised part */
	altNames?: string;
	/** True when the person is only referenced by a link and has no note yet */
	ghost: boolean;
	/** Vault path of the note (undefined for ghosts) */
	path?: string;
	/** Link text used to reference a ghost; used as the file name when creating it */
	linktext?: string;
	birth?: string;
	death?: string;
	birthInfo?: DateInfo;
	deathInfo?: DateInfo;
	birthPlace?: string;
	deathPlace?: string;
	gender: Gender;
	/** Resource URL of a portrait */
	photo?: string;
	/** Raw frontmatter values of the place properties, parsed by places.ts */
	places?: { birth?: unknown; death?: unknown; lived?: unknown };
}

export interface RawNote {
	/** Unique id, the vault path */
	id: string;
	basename: string;
	frontmatter: Record<string, unknown>;
	photo?: string;
}

export interface FieldNames {
	parentOf: string;
	childOf: string;
	marriedTo: string;
	siblings: string;
	gender: string;
	birthDate: string;
	deathDate: string;
	birthPlace: string;
	deathPlace: string;
	livedIn: string;
}

export const DEFAULT_FIELDS: FieldNames = {
	parentOf: "parent_of",
	childOf: "child_of",
	marriedTo: "married_to",
	siblings: "siblings",
	gender: "gender",
	birthDate: "birth_date",
	deathDate: "death_date",
	birthPlace: "birth_place",
	deathPlace: "death_place",
	livedIn: "lived_in",
};

export type RelationField = "parentOf" | "childOf" | "marriedTo" | "siblings";
export const RELATION_FIELDS: RelationField[] = ["parentOf", "childOf", "marriedTo", "siblings"];
export const REVERSE_FIELD: Record<RelationField, RelationField> = {
	parentOf: "childOf",
	childOf: "parentOf",
	marriedTo: "marriedTo",
	siblings: "siblings",
};

/** A link written in a note's frontmatter */
export interface Declaration {
	from: string;
	field: RelationField;
	to: string;
	uncertain: boolean;
}

type Relation = Map<string, Set<string>>;
export type RelKind = "parent" | "spouse" | "sibling";

export class FamilyGraph {
	persons = new Map<string, Person>();
	parents: Relation = new Map();
	children: Relation = new Map();
	spouses: Relation = new Map();
	siblings: Relation = new Map();
	declarations: Declaration[] = [];
	private uncertain = new Set<string>();
	private certain = new Set<string>();

	get(rel: Relation, id: string): Set<string> {
		return rel.get(id) ?? EMPTY;
	}

	addParent(parent: string, child: string, uncertain = false) {
		if (parent === child) return;
		add(this.parents, child, parent);
		add(this.children, parent, child);
		this.mark("parent", parent, child, uncertain);
	}

	addSpouses(a: string, b: string, uncertain = false) {
		if (a === b) return;
		add(this.spouses, a, b);
		add(this.spouses, b, a);
		this.mark("spouse", a, b, uncertain);
	}

	addSiblings(a: string, b: string, uncertain = false) {
		if (a === b) return;
		add(this.siblings, a, b);
		add(this.siblings, b, a);
		this.mark("sibling", a, b, uncertain);
	}

	/** True when every note that states this relation marks it as uncertain. For "parent", a is the parent */
	isUncertain(kind: RelKind, a: string, b: string): boolean {
		const k = relKey(kind, a, b);
		return this.uncertain.has(k) && !this.certain.has(k);
	}

	/** Explicit siblings plus everyone sharing at least one parent */
	allSiblings(id: string): Set<string> {
		const out = new Set(this.get(this.siblings, id));
		for (const p of this.get(this.parents, id)) {
			for (const c of this.get(this.children, p)) if (c !== id) out.add(c);
		}
		return out;
	}

	findByName(query: string): Person[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return [...this.persons.values()].filter((p) => p.fullName.toLowerCase().includes(q));
	}

	private mark(kind: RelKind, a: string, b: string, uncertain: boolean) {
		(uncertain ? this.uncertain : this.certain).add(relKey(kind, a, b));
	}
}

function relKey(kind: RelKind, a: string, b: string): string {
	if (kind === "parent") return `p:${a}>${b}`;
	return `${kind}:${a < b ? a + "|" + b : b + "|" + a}`;
}

const EMPTY: Set<string> = new Set();

function add(rel: Relation, key: string, value: string) {
	let s = rel.get(key);
	if (!s) rel.set(key, (s = new Set()));
	s.add(value);
}

export const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)]+)\)/g;
export const UNCERTAIN = /\?|возможно|предположительно|вероятно|наверное|не точно|неточно|maybe|possibly|probably|perhaps|unconfirmed|uncertain/i;

export interface RelLink {
	link: string;
	uncertain: boolean;
}

/** Splits on , ; and newlines that are not inside [[...]] or (...) */
function splitSegments(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "[" || ch === "(") depth++;
		else if ((ch === "]" || ch === ")") && depth > 0) depth--;
		if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Extracts link targets from a relation value (string, list, nested list from unquoted [[x]]).
 * A "?" or a word like "возможно" next to a link marks it as uncertain: `"[[Rose]] ?"`.
 */
export function extractRelLinks(value: unknown): RelLink[] {
	const out: RelLink[] = [];
	const visit = (v: unknown) => {
		if (v == null) return;
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		if (typeof v !== "string") return;
		for (const seg of splitSegments(v)) {
			const links: string[] = [];
			for (const m of seg.matchAll(WIKILINK)) links.push(m[1].trim());
			for (const m of seg.matchAll(MDLINK)) links.push(safeDecode(m[1].trim()).replace(/\.md$/, ""));
			const rest = seg.replace(WIKILINK, " ").replace(MDLINK, " ");
			if (links.length) {
				const uncertain = UNCERTAIN.test(rest);
				for (const link of links) out.push({ link, uncertain });
			} else {
				// Plain text (or the inner value of an unquoted [[x]] that YAML parsed as a nested list)
				const uncertain = UNCERTAIN.test(seg);
				const link = seg.replace(new RegExp(UNCERTAIN.source, "gi"), " ").replace(/\s+/g, " ").trim();
				if (link) out.push({ link, uncertain });
			}
		}
	};
	visit(value);
	return out;
}

export function extractLinks(value: unknown): string[] {
	return extractRelLinks(value).map((l) => l.link);
}

function safeDecode(s: string): string {
	try {
		return decodeURI(s);
	} catch {
		return s;
	}
}

export function parseName(fullName: string): { name: string; altNames?: string } {
	const m = fullName.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
	if (m && m[1]) return { name: m[1].trim(), altNames: m[2].trim() || undefined };
	return { name: fullName.trim() };
}

export function guessGender(value: unknown, name: string): Gender {
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (["m", "male", "man", "м", "муж", "мужской", "мужчина"].includes(v)) return "m";
		if (["f", "female", "woman", "ж", "жен", "женский", "женщина"].includes(v)) return "f";
	}
	// Russian / Ukrainian patronymic: "Петрович" / "Ивановна"
	const words = name.split(/\s+/);
	if (words.length >= 2) {
		const patronymic = words[1].toLowerCase();
		if (/(вна|чна|ична|инична)$/.test(patronymic)) return "f";
		if (/(вич|ьич|ич)$/.test(patronymic)) return "m";
	}
	return undefined;
}

export function formatDate(value: unknown): string | undefined {
	if (value == null || value === "") return undefined;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (Array.isArray(value)) return value.map((v) => formatDate(v)).filter(Boolean).join(", ") || undefined;
	return String(value).trim() || undefined;
}

const APPROX = /около|ок\.|примерно|приблизительно|~|≈|circa|\bca\.|\bc\.|about|\babt\b|approx|\?|предположительно|возможно|вероятно/i;
// \b is ASCII-only in JS, so Cyrillic words are delimited by hand
const BEFORE = /(?:^|[\s(])до(?=[\s\d])|не позднее|before|\bbef\b|</i;
const AFTER = /после|не ранее|after|\baft\b|>/i;

export function parseDate(value?: string): DateInfo | undefined {
	if (!value) return undefined;
	const text = value.trim();
	if (!text) return undefined;
	const years = [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => Number(m[1]));
	const decade = text.match(/(?<!\d)(\d{3}0)\s*-?\s*(ые|е|х|s)(?![a-zа-я])/i);
	if (decade) {
		const y = Number(decade[1]);
		const ru = /[а-я]/i.test(decade[2]);
		return { text, year: y + 5, approx: true, label: ru ? `${y}-е` : `${y}s` };
	}
	if (!years.length) return { text, approx: true };
	const year = years[0];
	if (BEFORE.test(text)) return { text, year, approx: true, label: `<${year}` };
	if (AFTER.test(text)) return { text, year, approx: true, label: `>${year}` };
	// Two different years: a range like "1890–1895"
	const approx = APPROX.test(text) || (years.length > 1 && years[1] !== year);
	return { text, year, approx, label: approx ? `~${year}` : String(year) };
}

export function yearOf(date?: string): string | undefined {
	const y = parseDate(date)?.year;
	return y ? String(y) : undefined;
}

export function stripLinks(text?: string): string | undefined {
	return text?.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * @param notes   person notes to start from (e.g. all notes with type: family-tree)
 * @param resolve resolves a link from a note to another note (null when the target doesn't exist)
 */
export function buildGraph(
	notes: RawNote[],
	resolve: (linktext: string, fromId: string) => RawNote | null,
	fields: FieldNames = DEFAULT_FIELDS
): FamilyGraph {
	const g = new FamilyGraph();
	const queue: RawNote[] = [];

	const ensure = (note: RawNote): string => {
		if (!g.persons.has(note.id)) {
			const fm = note.frontmatter ?? {};
			const { name, altNames } = parseName(note.basename);
			const birth = formatDate(fm[fields.birthDate]);
			const death = formatDate(fm[fields.deathDate]);
			g.persons.set(note.id, {
				id: note.id,
				fullName: note.basename,
				name,
				altNames,
				ghost: false,
				path: note.id,
				birth,
				death,
				birthInfo: parseDate(birth),
				deathInfo: parseDate(death),
				birthPlace: formatDate(fm[fields.birthPlace]),
				deathPlace: formatDate(fm[fields.deathPlace]),
				gender: guessGender(fm[fields.gender], name),
				photo: note.photo,
				places: { birth: fm[fields.birthPlace], death: fm[fields.deathPlace], lived: fm[fields.livedIn] },
			});
			queue.push(note);
		}
		return note.id;
	};

	const ensureLink = (linktext: string, fromId: string): string => {
		const target = resolve(linktext, fromId);
		if (target) return ensure(target);
		const id = "ghost:" + linktext.toLowerCase();
		if (!g.persons.has(id)) {
			const { name, altNames } = parseName(linktext);
			g.persons.set(id, {
				id,
				fullName: linktext,
				name,
				altNames,
				ghost: true,
				linktext,
				gender: guessGender(undefined, name),
			});
		}
		return id;
	};

	notes.forEach(ensure);

	// Linked notes are pulled in even if they're not tagged, so keep processing until the queue drains
	while (queue.length) {
		const note = queue.shift()!;
		const fm = note.frontmatter ?? {};
		const me = note.id;
		for (const field of RELATION_FIELDS) {
			for (const { link, uncertain } of extractRelLinks(fm[fields[field]])) {
				const other = ensureLink(link, me);
				if (other === me) continue;
				g.declarations.push({ from: me, field, to: other, uncertain });
				if (field === "parentOf") g.addParent(me, other, uncertain);
				else if (field === "childOf") g.addParent(other, me, uncertain);
				else if (field === "marriedTo") g.addSpouses(me, other, uncertain);
				else g.addSiblings(me, other, uncertain);
			}
		}
	}
	return g;
}

/**
 * People shown when focusing on `root`: ancestors and descendants up to `depth` generations,
 * siblings of the root and of every ancestor, and spouses of everyone in that set.
 */
export function focusSet(g: FamilyGraph, root: string, depth: number): Set<string> {
	const out = new Set<string>([root]);
	const blood = new Set<string>([root]);

	const walk = (rel: Relation) => {
		let frontier = [root];
		for (let d = 0; d < depth && frontier.length; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const r of g.get(rel, id)) {
					if (!blood.has(r)) {
						blood.add(r);
						next.push(r);
					}
				}
			}
			frontier = next;
		}
	};
	walk(g.parents);
	const ancestors = new Set(blood);
	walk(g.children);

	for (const id of ancestors) for (const s of g.allSiblings(id)) blood.add(s);
	for (const id of blood) {
		out.add(id);
		for (const s of g.get(g.spouses, id)) out.add(s);
	}
	return out;
}
