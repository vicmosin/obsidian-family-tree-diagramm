import { test } from "node:test";
import assert from "node:assert/strict";
import en from "../src/i18n/en";
import de from "../src/i18n/de";
import ru from "../src/i18n/ru";
import { resolveLang } from "../src/i18n";
import { setObsidianLanguage } from "./obsidian-mock";

/** Every leaf as "path: type", so missing keys or a string where a function belongs show up */
function shape(o: unknown, path = ""): string[] {
	if (Array.isArray(o)) return [`${path}: array(${o.length})`];
	if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
	return [`${path}: ${typeof o}`];
}

test("German and Russian have exactly the English keys", () => {
	assert.deepEqual(shape(de), shape(en));
	assert.deepEqual(shape(ru), shape(en));
});

test("no translation is empty", () => {
	const leaves = (o: unknown, path: string): [string, string][] => {
		if (typeof o === "function") return [[path, String((o as (...a: unknown[]) => unknown)(2, 3, 4, 5))]];
		if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
		return [[path, String(o)]];
	};
	for (const [name, dict] of Object.entries({ en, de, ru })) {
		for (const [path, value] of leaves(dict, name)) {
			// Property names without an explanation have an intentionally empty description
			if (/\.settings\.field\.\w+\.1$/.test(path)) continue;
			assert.notEqual(value.trim(), "", path);
		}
	}
});

test("plural forms", () => {
	assert.equal(en.view.people(1), "1 person");
	assert.equal(en.view.people(3), "3 people");
	assert.equal(de.view.people(1), "1 Person");
	assert.equal(de.view.people(3), "3 Personen");
	assert.deepEqual([1, 2, 5, 21, 22, 25, 11].map((n) => ru.view.people(n)), [
		"1 человек", "2 человека", "5 человек", "21 человек", "22 человека", "25 человек", "11 человек",
	]);
	assert.equal(ru.map.missing(1), "📍 1 место без координат — найти…");
	assert.equal(ru.map.missing(3), "📍 3 места без координат — найти…");
	assert.equal(ru.map.missing(7), "📍 7 мест без координат — найти…");
});

test("language follows Obsidian unless chosen", () => {
	const cases: [string, string][] = [["de", "de"], ["de-AT", "de"], ["ru", "ru"], ["en-GB", "en"], ["zh", "en"], ["uk", "en"]];
	for (const [code, expected] of cases) {
		setObsidianLanguage(code);
		assert.equal(resolveLang("auto"), expected, code);
	}
	setObsidianLanguage("de");
	assert.equal(resolveLang("ru"), "ru");
	setObsidianLanguage("en");
});
