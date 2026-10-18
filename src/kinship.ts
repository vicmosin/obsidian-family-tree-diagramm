import { FamilyGraph, Gender } from "./model";

export type Lang = "ru" | "en";

export interface Kin {
	/** e.g. "двоюродная тётя", "first cousin once removed" */
	label: string;
	/** People connecting `me` to the target, both included */
	path: string[];
	/** Some link on the path is marked uncertain */
	uncertain: boolean;
}

interface Blood {
	up: number;
	down: number;
	path: string[];
	/** Exactly one shared parent (half-siblings) */
	halfVia?: string;
}

/** Relationship of every person to one reference person ("me") */
export class Kinship {
	private cache = new Map<string, Kin | undefined>();
	private ancestorCache = new Map<string, Map<string, { dist: number; next: string | null }>>();
	private siblingGroup = new Map<string, string>();

	constructor(
		private g: FamilyGraph,
		readonly me: string,
		private lang: Lang = "ru",
		/** Same rule as the diagram: one listed parent with exactly one spouse → the spouse is the other parent */
		private inferSpouseParent = true
	) {
		// Listed siblings with no known parents get a shared virtual parent so cousins through them still work
		for (const id of g.persons.keys()) {
			if (this.siblingGroup.has(id) || !g.get(g.siblings, id).size) continue;
			const root = "vp:" + id;
			const stack = [id];
			while (stack.length) {
				const x = stack.pop()!;
				if (this.siblingGroup.has(x)) continue;
				this.siblingGroup.set(x, root);
				for (const y of g.get(g.siblings, x)) stack.push(y);
			}
		}
	}

	get(to: string): Kin | undefined {
		if (!this.cache.has(to)) this.cache.set(to, this.compute(to));
		return this.cache.get(to);
	}

	private gender(id: string): Gender {
		return this.g.persons.get(id)?.gender;
	}

	/** My gender, or the opposite of my spouse's when unknown */
	private myGender(): Gender {
		const own = this.gender(this.me);
		if (own) return own;
		for (const s of this.g.get(this.g.spouses, this.me)) {
			const sg = this.gender(s);
			if (sg) return sg === "m" ? "f" : "m";
		}
		return undefined;
	}

	private parentsOf(id: string): string[] {
		const g = this.g;
		const out = [...g.get(g.parents, id)];
		if (this.inferSpouseParent && out.length === 1 && !g.isUncertain("parent", out[0], id)) {
			const spouses = g.get(g.spouses, out[0]);
			if (spouses.size === 1) out.push([...spouses][0]);
		}
		const vp = this.siblingGroup.get(id);
		if (vp) out.push(vp);
		return out;
	}

	private ancestors(id: string) {
		let m = this.ancestorCache.get(id);
		if (m) return m;
		m = new Map([[id, { dist: 0, next: null as string | null }]]);
		const queue = [id];
		while (queue.length) {
			const x = queue.shift()!;
			const d = m.get(x)!.dist;
			if (x.startsWith("vp:")) continue;
			for (const p of this.parentsOf(x)) {
				if (!m.has(p)) {
					m.set(p, { dist: d + 1, next: x });
					queue.push(p);
				}
			}
		}
		this.ancestorCache.set(id, m);
		return m;
	}

	private blood(from: string, to: string): Blood | undefined {
		const A = this.ancestors(from);
		const B = this.ancestors(to);
		let best: string | undefined;
		let bestScore = Infinity;
		for (const [c, a] of A) {
			const b = B.get(c);
			if (!b) continue;
			const score = a.dist + b.dist;
			if (score < bestScore) (best = c), (bestScore = score);
		}
		if (best == null) return undefined;
		const walk = (M: typeof A, start: string) => {
			const out: string[] = [];
			for (let n: string | null = start; n != null; n = M.get(n)!.next) out.push(n);
			return out;
		};
		const upPath = walk(A, best).reverse();
		const downPath = walk(B, best);
		const path = [...upPath, ...downPath.slice(1)].filter((x) => !x.startsWith("vp:"));
		const up = A.get(best)!.dist;
		const down = B.get(best)!.dist;
		let halfVia: string | undefined;
		if (up === 1 && down === 1) {
			const pa = this.parentsOf(from).filter((p) => !p.startsWith("vp:"));
			const pb = this.parentsOf(to).filter((p) => !p.startsWith("vp:"));
			const shared = pa.filter((p) => pb.includes(p));
			if (shared.length === 1 && pa.length >= 2 && pb.length >= 2) halfVia = shared[0];
		}
		return { up, down, path, halfVia };
	}

	private compute(to: string): Kin | undefined {
		const g = this.g;
		const me = this.me;
		const T = this.lang === "ru" ? RU : EN;
		const gTo = this.gender(to);
		const done = (label: string, path: string[]): Kin => {
			const uncertain = this.pathUncertain(path);
			return { label: uncertain ? label + " ?" : label, path, uncertain };
		};

		if (to === me) return { label: T.me, path: [me], uncertain: false };
		if (g.get(g.spouses, me).has(to)) return done(T.noun("spouse", gTo), [me, to]);

		const b = this.blood(me, to);
		if (b) return done(T.blood(b, gTo, b.halfVia ? this.gender(b.halfVia) : undefined), b.path);

		// Spouse of a blood relative
		let best: { kin: Kin; len: number } | undefined;
		const consider = (label: string, path: string[]) => {
			if (!best || path.length < best.len) best = { kin: done(label, path), len: path.length };
		};
		for (const r of g.get(g.spouses, to)) {
			const rb = this.blood(me, r);
			if (!rb) continue;
			consider(T.spouseOfRelative(rb, this.gender(r), gTo), [...rb.path, to]);
		}
		// Blood relative of my spouse
		for (const s of g.get(g.spouses, me)) {
			const sb = this.blood(s, to);
			if (!sb) continue;
			consider(T.relativeOfSpouse(sb, gTo, this.gender(s), this.myGender()), [me, ...sb.path]);
		}
		// Husband of my wife's sister: свояк
		for (const s of g.get(g.spouses, me)) {
			for (const sib of g.allSiblings(s)) {
				if (g.get(g.spouses, sib).has(to) && this.gender(sib) === "f" && gTo === "m" && this.myGender() === "m") {
					consider(T.noun("wifesSistersHusband", gTo), [me, s, sib, to]);
				}
			}
		}
		// Parents of my child's spouse
		for (const c of g.get(g.children, me)) {
			for (const x of g.get(g.spouses, c)) {
				if (g.get(g.parents, x).has(to)) consider(T.noun("coParentInLaw", gTo), [me, c, x, to]);
			}
		}
		if (best) return best.kin;

		const path = this.anyPath(to);
		return path ? done(T.noun("inLaw", gTo), path) : undefined;
	}

	private anyPath(to: string): string[] | undefined {
		const g = this.g;
		const prev = new Map<string, string | null>([[this.me, null]]);
		const queue = [this.me];
		while (queue.length) {
			const x = queue.shift()!;
			if (x === to) break;
			for (const rel of [g.parents, g.children, g.spouses, g.siblings]) {
				for (const y of g.get(rel, x)) if (!prev.has(y)) prev.set(y, x), queue.push(y);
			}
		}
		if (!prev.has(to)) return undefined;
		const out: string[] = [];
		for (let n: string | null = to; n != null; n = prev.get(n)!) out.push(n);
		return out.reverse();
	}

	private pathUncertain(path: string[]): boolean {
		const g = this.g;
		for (let i = 0; i + 1 < path.length; i++) {
			const [a, b] = [path[i], path[i + 1]];
			if (g.isUncertain("parent", a, b) || g.isUncertain("parent", b, a)) return true;
			if (g.isUncertain("spouse", a, b) || g.isUncertain("sibling", a, b)) return true;
		}
		return false;
	}
}

// ---------- Terms ----------

type NounKey =
	| "parent" | "child" | "grandparent" | "grandchild" | "sibling" | "uncle" | "nephew" | "spouse"
	| "stepParent" | "stepChild" | "childInLaw" | "siblingInLaw" | "wifesParent" | "husbandsParent"
	| "wifesSibling" | "husbandsSibling" | "wifesSistersHusband" | "coParentInLaw" | "inLaw";

interface Terms {
	me: string;
	noun(key: NounKey, gender: Gender): string;
	blood(b: Blood, gender: Gender, halfParentGender?: Gender): string;
	spouseOfRelative(r: Blood, relGender: Gender, gender: Gender): string;
	relativeOfSpouse(r: Blood, gender: Gender, spouseGender: Gender, myGender: Gender): string;
}

// Russian: [nominative, genitive] per gender; n = unknown gender
type Forms = { m: [string, string]; f: [string, string]; n: [string, string] };
const both = (m: [string, string], f: [string, string]): Forms => ({ m, f, n: [`${m[0]}/${f[0]}`, `${m[1]}/${f[1]}`] });
const RU_NOUNS: Record<NounKey, Forms> = {
	parent: { m: ["отец", "отца"], f: ["мать", "матери"], n: ["родитель", "родителя"] },
	child: { m: ["сын", "сына"], f: ["дочь", "дочери"], n: ["ребёнок", "ребёнка"] },
	grandparent: both(["дедушка", "дедушки"], ["бабушка", "бабушки"]),
	grandchild: both(["внук", "внука"], ["внучка", "внучки"]),
	sibling: both(["брат", "брата"], ["сестра", "сестры"]),
	uncle: both(["дядя", "дяди"], ["тётя", "тёти"]),
	nephew: both(["племянник", "племянника"], ["племянница", "племянницы"]),
	spouse: { m: ["муж", "мужа"], f: ["жена", "жены"], n: ["супруг(а)", "супруга(и)"] },
	stepParent: both(["отчим", "отчима"], ["мачеха", "мачехи"]),
	stepChild: both(["пасынок", "пасынка"], ["падчерица", "падчерицы"]),
	childInLaw: both(["зять", "зятя"], ["невестка", "невестки"]),
	siblingInLaw: both(["зять", "зятя"], ["невестка", "невестки"]),
	wifesParent: both(["тесть", "тестя"], ["тёща", "тёщи"]),
	husbandsParent: both(["свёкор", "свёкра"], ["свекровь", "свекрови"]),
	wifesSibling: both(["шурин", "шурина"], ["свояченица", "свояченицы"]),
	husbandsSibling: both(["деверь", "деверя"], ["золовка", "золовки"]),
	wifesSistersHusband: both(["свояк", "свояка"], ["свояк", "свояка"]),
	coParentInLaw: both(["сват", "свата"], ["сватья", "сватьи"]),
	inLaw: both(["свойственник", "свойственника"], ["свойственница", "свойственницы"]),
};

interface RuTerm {
	/** Adjective stems: "двоюродн" → двоюродный / двоюродная / двоюродного / двоюродной */
	adj: string[];
	noun: NounKey;
	/** Number of "пра" prefixes */
	pra: number;
}

const LEVEL = ["", "", "двоюродн", "троюродн", "четвероюродн", "пятиюродн", "шестиюродн"];
const levelStem = (n: number) => LEVEL[n] ?? `${n}-юродн`;

function ruTerm(b: Blood, halfParentGender?: Gender): RuTerm {
	const { up, down } = b;
	if (up === 0) return down === 1 ? { adj: [], noun: "child", pra: 0 } : { adj: [], noun: "grandchild", pra: down - 2 };
	if (down === 0) return up === 1 ? { adj: [], noun: "parent", pra: 0 } : { adj: [], noun: "grandparent", pra: up - 2 };
	if (up === 1 && down === 1) {
		const adj = b.halfVia ? (halfParentGender === "m" ? ["единокровн"] : halfParentGender === "f" ? ["единоутробн"] : []) : [];
		return { adj, noun: "sibling", pra: 0 };
	}
	const d = up - down;
	if (d > 0) {
		// Older generation: дядя (d=1), дедушка (d=2), прадедушка (d=3); grandparents' siblings are "двоюродный дедушка"
		const level = down + (d >= 2 ? 1 : 0);
		const adj = level > 1 ? [levelStem(level)] : [];
		return d === 1 ? { adj, noun: "uncle", pra: 0 } : { adj, noun: "grandparent", pra: d - 2 };
	}
	if (d < 0) {
		const e = -d;
		const adj = up > 1 ? [levelStem(up)] : [];
		if (e >= 2) adj.push("пра".repeat(e - 2) + "внучат");
		return { adj, noun: "nephew", pra: 0 };
	}
	return { adj: [levelStem(up)], noun: "sibling", pra: 0 };
}

function ruRender(t: RuTerm, gcase: 0 | 1, gender: Gender): string {
	const forms = RU_NOUNS[t.noun][gender ?? "n"];
	const noun = forms[gcase]
		.split("/")
		.map((w) => "пра".repeat(t.pra) + w)
		.join("/");
	const ending = gender === "f" ? (gcase ? "ой" : "ая") : gcase ? "ого" : "ый";
	return [...t.adj.map((s) => s + ending), noun].join(" ");
}

const RU: Terms = {
	me: "я",
	noun: (key, gender) => RU_NOUNS[key][gender ?? "n"][0],
	blood: (b, gender, hpg) => ruRender(ruTerm(b, hpg), 0, gender),
	spouseOfRelative(r, relGender, gender) {
		if (r.up === 1 && r.down === 0) return RU.noun("stepParent", gender);
		if (r.up === 0 && r.down === 1) return RU.noun("childInLaw", gender);
		if (r.up === 1 && r.down === 1) return RU.noun("siblingInLaw", gender);
		return `${RU.noun("spouse", gender)} ${ruRender(ruTerm(r), 1, relGender)}`;
	},
	relativeOfSpouse(r, gender, spouseGender, myGender) {
		const viaWife = spouseGender === "f" || (!spouseGender && myGender === "m");
		const viaHusband = spouseGender === "m" || (!spouseGender && myGender === "f");
		if (r.up === 1 && r.down === 0 && (viaWife || viaHusband)) return RU.noun(viaWife ? "wifesParent" : "husbandsParent", gender);
		if (r.up === 1 && r.down === 1 && (viaWife || viaHusband)) return RU.noun(viaWife ? "wifesSibling" : "husbandsSibling", gender);
		if (r.up === 0 && r.down === 1) return RU.noun("stepChild", gender);
		return `${ruRender(ruTerm(r), 0, gender)} ${RU_NOUNS.spouse[spouseGender ?? "n"][1]}`;
	},
};

// English
const EN_NOUNS: Record<NounKey, [string, string, string]> = {
	parent: ["father", "mother", "parent"],
	child: ["son", "daughter", "child"],
	grandparent: ["grandfather", "grandmother", "grandparent"],
	grandchild: ["grandson", "granddaughter", "grandchild"],
	sibling: ["brother", "sister", "sibling"],
	uncle: ["uncle", "aunt", "uncle/aunt"],
	nephew: ["nephew", "niece", "nephew/niece"],
	spouse: ["husband", "wife", "spouse"],
	stepParent: ["stepfather", "stepmother", "step-parent"],
	stepChild: ["stepson", "stepdaughter", "stepchild"],
	childInLaw: ["son-in-law", "daughter-in-law", "child-in-law"],
	siblingInLaw: ["brother-in-law", "sister-in-law", "sibling-in-law"],
	wifesParent: ["father-in-law", "mother-in-law", "parent-in-law"],
	husbandsParent: ["father-in-law", "mother-in-law", "parent-in-law"],
	wifesSibling: ["brother-in-law", "sister-in-law", "sibling-in-law"],
	husbandsSibling: ["brother-in-law", "sister-in-law", "sibling-in-law"],
	wifesSistersHusband: ["brother-in-law", "brother-in-law", "brother-in-law"],
	coParentInLaw: ["co-father-in-law", "co-mother-in-law", "co-parent-in-law"],
	inLaw: ["relative by marriage", "relative by marriage", "relative by marriage"],
};
const enNoun = (key: NounKey, g: Gender) => EN_NOUNS[key][g === "m" ? 0 : g === "f" ? 1 : 2];
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
const TIMES = ["", "once", "twice", "three times", "four times", "five times"];
const great = (n: number) => "great-".repeat(Math.max(0, n));

function enBlood(b: Blood, g: Gender): string {
	const { up, down } = b;
	if (up === 0) return down === 1 ? enNoun("child", g) : great(down - 2) + enNoun("grandchild", g);
	if (down === 0) return up === 1 ? enNoun("parent", g) : great(up - 2) + enNoun("grandparent", g);
	if (up === 1 && down === 1) return (b.halfVia ? "half-" : "") + enNoun("sibling", g);
	if (down === 1) return great(up - 2) + enNoun("uncle", g);
	if (up === 1) return great(down - 2) + enNoun("nephew", g);
	const k = Math.min(up, down) - 1;
	const r = Math.abs(up - down);
	const base = `${ORD[k] ?? k + "th"} cousin`;
	return r ? `${base} ${TIMES[r] ?? r + " times"} removed` : base;
}

const EN: Terms = {
	me: "me",
	noun: enNoun,
	blood: (b, g) => enBlood(b, g),
	spouseOfRelative(r, relGender, gender) {
		if (r.up === 1 && r.down === 0) return enNoun("stepParent", gender);
		if (r.up === 0 && r.down === 1) return enNoun("childInLaw", gender);
		if (r.up === 1 && r.down === 1) return enNoun("siblingInLaw", gender);
		return `${enBlood(r, relGender)}'s ${enNoun("spouse", gender)}`;
	},
	relativeOfSpouse(r, gender, spouseGender) {
		if (r.up === 1 && r.down === 0) return enNoun("wifesParent", gender);
		if (r.up === 1 && r.down === 1) return enNoun("wifesSibling", gender);
		if (r.up === 0 && r.down === 1) return enNoun("stepChild", gender);
		return `${enNoun("spouse", spouseGender)}'s ${enBlood(r, gender)}`;
	},
};
