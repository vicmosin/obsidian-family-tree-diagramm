import dagre from "@dagrejs/dagre";
import { FamilyGraph, Person } from "./model";

export interface LayoutNode {
	id: string;
	person: Person;
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * A family: the partners (0..n) and their children, joined at (x, y).
 * - couple:  partners side by side, joint in the middle of the line between them
 * - single:  one known parent, joint under the card
 * - virtual: siblings with no known parents, joint is a hollow dot above them
 * - loose:   partners that couldn't be placed next to each other
 */
export interface LayoutUnion {
	id: string;
	kind: "couple" | "single" | "virtual" | "loose";
	x: number;
	y: number;
	partners: string[];
	children: string[];
	/** Partners are linked by married_to (otherwise they only share a child) */
	married: boolean;
	/** The marriage itself is marked uncertain */
	uncertainMarriage: boolean;
	/** Children whose link to these parents is uncertain */
	uncertainChildren: Set<string>;
}

export interface Layout {
	nodes: Map<string, LayoutNode>;
	unions: LayoutUnion[];
	width: number;
	height: number;
}

export interface LayoutOptions {
	nodeWidth: number;
	nodeHeight: number;
	/** Child with one known parent who has exactly one spouse is drawn under the couple */
	inferSpouseParent: boolean;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 220, nodeHeight: 96, inferSpouseParent: true };

const COUPLE_GAP = 44;

export interface Family {
	partners: Set<string>;
	children: Set<string>;
	virtual: boolean;
}

export function buildFamilies(g: FamilyGraph, visible: Set<string>, inferSpouseParent: boolean): Map<string, Family> {
	const families = new Map<string, Family>();
	const familyOf = (partners: string[], virtualKey?: string): Family => {
		const key = virtualKey ?? "u:" + [...partners].sort().join("|");
		let f = families.get(key);
		if (!f) families.set(key, (f = { partners: new Set(partners), children: new Set(), virtual: !!virtualKey }));
		return f;
	};
	const visibleOnly = (s: Set<string>) => [...s].filter((x) => visible.has(x));

	for (const child of visible) {
		let parents = visibleOnly(g.get(g.parents, child));
		if (parents.length === 0) continue;
		// Not for uncertain links: a possible child from an affair shouldn't be drawn under the marriage
		if (parents.length === 1 && inferSpouseParent && !g.isUncertain("parent", parents[0], child)) {
			const spouses = visibleOnly(g.get(g.spouses, parents[0]));
			if (spouses.length === 1) parents = [parents[0], spouses[0]];
		}
		familyOf(parents).children.add(child);
	}

	for (const a of visible) {
		for (const b of g.get(g.spouses, a)) if (a < b && visible.has(b)) familyOf([a, b]);
	}

	// Explicit siblings without a shared known parent: hang them under the same family
	const groupOf = new Map<string, Set<string>>();
	for (const a of visible) {
		for (const b of g.get(g.siblings, a)) {
			if (!visible.has(b)) continue;
			const ga = groupOf.get(a) ?? new Set([a]);
			const gb = groupOf.get(b) ?? new Set([b]);
			if (ga === gb) continue;
			for (const x of gb) ga.add(x);
			for (const x of ga) groupOf.set(x, ga);
		}
	}
	const childFamily = new Map<string, Family>();
	for (const f of families.values()) for (const c of f.children) childFamily.set(c, f);
	for (const group of new Set(groupOf.values())) {
		const members = [...group].sort();
		let fam = members.map((m) => childFamily.get(m)).find((f) => f);
		if (!fam) fam = familyOf([], "v:" + members[0]);
		for (const m of members) if (!childFamily.has(m)) fam.children.add(m);
	}
	return families;
}

/** Groups spouses and co-parents into blocks that are laid out as a single unit, ordered left → right */
function buildBlocks(g: FamilyGraph, visible: Set<string>, families: Map<string, Family>): string[][] {
	const adj = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		if (a === b) return;
		(adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
		(adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
	};
	for (const f of families.values()) {
		const ps = [...f.partners];
		for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) link(ps[i], ps[j]);
	}

	const seen = new Set<string>();
	const blocks: string[][] = [];
	for (const start of [...visible].sort()) {
		if (seen.has(start)) continue;
		// Collect the connected component
		const comp: string[] = [];
		const stack = [start];
		seen.add(start);
		while (stack.length) {
			const x = stack.pop()!;
			comp.push(x);
			for (const y of adj.get(x) ?? []) if (!seen.has(y)) seen.add(y), stack.push(y);
		}
		blocks.push(orderBlock(comp, adj));
	}
	return blocks;
}

function orderBlock(comp: string[], adj: Map<string, Set<string>>): string[] {
	if (comp.length <= 2) return comp.sort();
	const deg = (x: string) => adj.get(x)?.size ?? 0;
	const hub = comp.reduce((a, b) => (deg(b) > deg(a) ? b : a));
	// Someone with several partners: put them in the middle
	if (comp.every((x) => x === hub || deg(x) === 1)) {
		const others = comp.filter((x) => x !== hub).sort();
		const left = others.filter((_, i) => i % 2 === 1);
		const right = others.filter((_, i) => i % 2 === 0);
		return [...left, hub, ...right];
	}
	// Otherwise walk the chain from an end
	const startNode = comp.reduce((a, b) => (deg(b) < deg(a) ? b : a));
	const order: string[] = [];
	const done = new Set<string>();
	let cur: string | undefined = startNode;
	while (cur) {
		order.push(cur);
		done.add(cur);
		cur = [...(adj.get(cur) ?? [])].filter((y) => !done.has(y)).sort((a, b) => deg(a) - deg(b))[0];
	}
	for (const x of comp) if (!done.has(x)) order.push(x);
	return order;
}

export function computeLayout(g: FamilyGraph, visible: Set<string>, opts: LayoutOptions = DEFAULT_LAYOUT): Layout {
	const { nodeWidth: w, nodeHeight: h } = opts;
	const families = buildFamilies(g, visible, opts.inferSpouseParent);
	const blocks = buildBlocks(g, visible, families);
	const blockOf = new Map<string, number>();
	blocks.forEach((b, i) => b.forEach((id) => blockOf.set(id, i)));

	const dg = new dagre.graphlib.Graph();
	dg.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 64, marginx: 40, marginy: 40 });
	dg.setDefaultEdgeLabel(() => ({}));

	const byBirth = (a: number, b: number) => sortKey(g, blocks[a][0]).localeCompare(sortKey(g, blocks[b][0]));
	for (const i of blocks.map((_, i) => i).sort(byBirth)) {
		const n = blocks[i].length;
		dg.setNode("b" + i, { width: n * w + (n - 1) * COUPLE_GAP, height: h });
	}
	for (const [key, f] of families) {
		let source: string;
		if (f.partners.size) source = "b" + blockOf.get([...f.partners][0]);
		else {
			source = key;
			dg.setNode(key, { width: 12, height: 12 });
		}
		const kids = [...f.children].sort((a, b) => sortKey(g, a).localeCompare(sortKey(g, b)));
		for (const c of kids) {
			const target = "b" + blockOf.get(c);
			if (target !== source) dg.setEdge(source, target, { weight: 1, minlen: 1 });
		}
	}

	dagre.layout(dg);

	const nodes = new Map<string, LayoutNode>();
	const place = (i: number) => {
		const bn = dg.node("b" + i);
		const block = blocks[i];
		const total = block.length * w + (block.length - 1) * COUPLE_GAP;
		block.forEach((id, k) => {
			nodes.set(id, { id, person: g.persons.get(id)!, x: bn.x - total / 2 + w / 2 + k * (w + COUPLE_GAP), y: bn.y, w, h });
		});
	};
	blocks.forEach((_, i) => place(i));

	// Turn each couple so that every partner sits on the side of their own parents
	const parentX = (id: string): number | undefined => {
		for (const [key, f] of families) {
			if (!f.children.has(id)) continue;
			if (f.virtual) return dg.node(key).x;
			const xs = [...f.partners].map((p) => nodes.get(p)?.x).filter((x): x is number => x != null);
			return xs.length ? xs.reduce((a, b) => a + b) / xs.length : undefined;
		}
		return undefined;
	};
	const multi = blocks.map((b, i) => i).filter((i) => blocks[i].length > 1);
	multi.sort((a, b) => dg.node("b" + a).y - dg.node("b" + b).y);
	for (const i of multi) {
		const block = blocks[i];
		const xs = block.map((id) => nodes.get(id)!.x);
		const cost = (order: string[]) =>
			order.reduce((sum, id, k) => {
				const px = parentX(id);
				return px == null ? sum : sum + Math.abs(px - xs[k]);
			}, 0);
		const reversed = [...block].reverse();
		if (cost(reversed) < cost(block)) {
			blocks[i] = reversed;
			place(i);
		}
	}

	const unions: LayoutUnion[] = [];
	for (const [key, f] of families) {
		const partners = [...f.partners].filter((p) => nodes.has(p)).sort((a, b) => nodes.get(a)!.x - nodes.get(b)!.x);
		const children = [...f.children];
		const married = partners.length === 2 && g.get(g.spouses, partners[0]).has(partners[1]);
		const base = {
			id: key,
			partners,
			children,
			married,
			uncertainMarriage: married && g.isUncertain("spouse", partners[0], partners[1]),
			uncertainChildren: new Set(children.filter((c) => partners.some((p) => g.isUncertain("parent", p, c)))),
		};
		if (f.virtual) {
			const n = dg.node(key);
			for (const c of children) {
				if (children.some((o) => o !== c && g.isUncertain("sibling", c, o))) base.uncertainChildren.add(c);
			}
			unions.push({ ...base, kind: "virtual", x: n.x, y: n.y });
		} else if (partners.length === 1) {
			const p = nodes.get(partners[0])!;
			unions.push({ ...base, kind: "single", x: p.x, y: p.y + h / 2 });
		} else {
			const ns = partners.map((p) => nodes.get(p)!);
			const sameRow = ns.every((n) => n.y === ns[0].y);
			const adjacent = sameRow && ns.length === 2 && Math.abs(ns[1].x - ns[0].x) <= w + COUPLE_GAP + 1;
			if (adjacent) unions.push({ ...base, kind: "couple", x: (ns[0].x + ns[1].x) / 2, y: ns[0].y });
			else {
				const x = ns.reduce((s, n) => s + n.x, 0) / ns.length;
				const y = Math.max(...ns.map((n) => n.y)) + h / 2 + 16;
				unions.push({ ...base, kind: "loose", x, y });
			}
		}
	}
	const gr = dg.graph();
	return { nodes, unions, width: gr.width ?? 0, height: gr.height ?? 0 };
}

/** Birth year first so siblings tend to line up oldest → youngest */
function sortKey(g: FamilyGraph, id: string): string {
	const p = g.persons.get(id);
	const year = p?.birthInfo?.year ?? 9999;
	return year + (p?.fullName ?? id);
}
