// Just enough of Obsidian's settings API to exercise src/settings.ts in Node
export let apiVersionOk = false;
export function setApiVersionOk(v: boolean) {
	apiVersionOk = v;
}
export function requireApiVersion(): boolean {
	return apiVersionOk;
}

export interface Row {
	name?: string;
	desc?: string;
	heading?: boolean;
	kind?: string;
	value?: unknown;
	buttonText?: string;
	onChange?: (v: unknown) => void;
	onClick?: () => void;
	options?: Record<string, string>;
}

export const rendered: Row[] = [];

function component(row: Row, kind: string) {
	row.kind = kind;
	const c: Record<string, unknown> = {
		inputEl: { rows: 0, addClass() {} },
		buttonEl: {},
	};
	const self = c as Record<string, (...a: unknown[]) => unknown>;
	c.setValue = (v: unknown) => ((row.value = v), c);
	c.setPlaceholder = () => c;
	c.setLimits = () => c;
	c.addOptions = (o: Record<string, string>) => ((row.options = o), c);
	c.onChange = (f: (v: unknown) => void) => ((row.onChange = f), c);
	c.setButtonText = (t: string) => ((row.buttonText = t), c);
	c.onClick = (f: () => void) => ((row.onClick = f), c);
	return self;
}

export class Setting {
	private row: Row = {};
	constructor(_el: unknown) {
		rendered.push(this.row);
	}
	setName(n: string) {
		this.row.name = n;
		return this;
	}
	setDesc(d: string) {
		this.row.desc = d;
		return this;
	}
	setHeading() {
		this.row.heading = true;
		return this;
	}
	addText(cb: (c: unknown) => void) {
		cb(component(this.row, "text"));
		return this;
	}
	addTextArea(cb: (c: unknown) => void) {
		cb(component(this.row, "textarea"));
		return this;
	}
	addToggle(cb: (c: unknown) => void) {
		cb(component(this.row, "toggle"));
		return this;
	}
	addDropdown(cb: (c: unknown) => void) {
		cb(component(this.row, "dropdown"));
		return this;
	}
	addSlider(cb: (c: unknown) => void) {
		cb(component(this.row, "slider"));
		return this;
	}
	addButton(cb: (c: unknown) => void) {
		cb(component(this.row, "button"));
		return this;
	}
}

export class PluginSettingTab {
	containerEl = { empty: () => (rendered.length = 0) };
	constructor(
		public app: unknown,
		_plugin: unknown
	) {}
}
export class App {}
