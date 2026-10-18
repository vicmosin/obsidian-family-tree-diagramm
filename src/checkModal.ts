import { Modal, Notice } from "obsidian";
import type FamilyTreePlugin from "./main";
import { findIssues, Issue, ISSUE_TITLES, IssueKind } from "./check";

const ORDER: IssueKind[] = ["one-way", "dates", "structure", "missing-note", "missing-birth"];

export class CheckModal extends Modal {
	constructor(private plugin: FamilyTreePlugin) {
		super(plugin.app);
	}

	onOpen() {
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ft-check");
		this.titleEl.setText("Family tree check");

		const g = this.plugin.graph();
		const issues = findIssues(g, this.plugin.settings.fields);
		if (!issues.length) {
			contentEl.createEl("p", { text: `All good — ${g.persons.size} people, no problems found.` });
			return;
		}

		const byKind = new Map<IssueKind, Issue[]>();
		for (const i of issues) (byKind.get(i.kind) ?? byKind.set(i.kind, []).get(i.kind)!).push(i);

		for (const kind of ORDER) {
			const list = byKind.get(kind);
			if (!list?.length) continue;
			const details = contentEl.createEl("details", { cls: "ft-check-section" });
			// Long, low-priority lists start collapsed
			details.open = kind !== "missing-birth" && kind !== "missing-note";
			const summary = details.createEl("summary");
			summary.createSpan({ text: ISSUE_TITLES[kind] });
			summary.createSpan({ cls: "ft-check-count", text: String(list.length) });

			if (kind === "one-way") {
				const row = details.createDiv("ft-check-actions");
				row.createSpan({
					cls: "ft-check-hint",
					text: "The tree already reads these correctly. Adding the reverse links keeps your notes consistent if you use them elsewhere.",
				});
				const btn = row.createEl("button", { cls: "mod-cta", text: `Add ${list.length} missing link${list.length > 1 ? "s" : ""}` });
				btn.onclick = async () => {
					btn.disabled = true;
					const { links, notes } = await this.plugin.applyReverseFixes(list.map((i) => i.fix!));
					new Notice(`Added ${links} link${links === 1 ? "" : "s"} in ${notes} note${notes === 1 ? "" : "s"}`);
					// Metadata cache updates asynchronously
					window.setTimeout(() => this.render(), 600);
				};
			}

			const ul = details.createEl("ul");
			for (const i of list.sort((a, b) => this.name(a.person).localeCompare(this.name(b.person)))) {
				const li = ul.createEl("li");
				const a = li.createEl("a", { text: this.name(i.person), cls: "internal-link" });
				a.onclick = () => {
					const p = g.persons.get(i.person);
					if (!p) return;
					if (p.ghost) void this.plugin.createPerson(p);
					else void this.app.workspace.openLinkText(p.path!, "", "tab");
					this.close();
				};
				li.createSpan({ text: " — " + i.message });
			}
		}
	}

	private name(id: string) {
		return this.plugin.graph().persons.get(id)?.fullName ?? id;
	}

	onClose() {
		this.contentEl.empty();
	}
}
