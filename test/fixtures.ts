import { RawNote } from "../src/model";

/** A made-up family with the same shapes as real notes: one-sided links, siblings without parents, ghosts */
export const NOTES: RawNote[] = [
	{
		id: "Family/George Miller.md",
		basename: "George Miller",
		frontmatter: {
			birth_date: "1931-11-09",
			birth_place: "Unknown, probably near [[Leeds, England]]",
			death_date: "2024-03-03",
			child_of: ["[[Walter Miller]]", "[[Alice Miller]]"],
			parent_of: "[[Susan Turner (Baker, Miller)]]",
			married_to: "[[Helen Miller (Clark)]]",
			gender: "m",
			tags: ["#family-tree"],
			type: "family-tree",
			siblings: [["Nicholas Miller"], "[[Leonard Miller]]", "[[Teresa Miller]]"],
		},
	},
	{
		id: "Family/Helen Miller (Clark).md",
		basename: "Helen Miller (Clark)",
		frontmatter: { birth_date: "1933-02-01", gender: "f", type: "family-tree" },
	},
	{
		id: "Family/Susan Turner (Baker, Miller).md",
		basename: "Susan Turner (Baker, Miller)",
		frontmatter: { birth_date: "1958-05-05", gender: "f", type: "family-tree", child_of: "[[Helen Miller (Clark)]]" },
	},
	{
		id: "Family/Teresa Miller.md",
		basename: "Teresa Miller",
		frontmatter: { gender: "f", type: "family-tree", parent_of: "[[Lucy]]" },
	},
	{
		id: "Family/Nicholas Miller.md",
		basename: "Nicholas Miller",
		frontmatter: { gender: "m", type: "family-tree", parent_of: "[[Nathan Miller]]" },
	},
];

export function resolver(notes: RawNote[]) {
	return (link: string) => notes.find((n) => n.basename === link) ?? null;
}
