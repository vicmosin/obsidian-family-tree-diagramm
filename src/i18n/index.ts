import { getLanguage } from "obsidian";
import de from "./de";
import en from "./en";
import ru from "./ru";

export type Lang = "en" | "de" | "ru";
/** A language setting: a fixed language, or "auto" to follow Obsidian's interface language */
export type LangSetting = "auto" | Lang;
export type Strings = typeof en;

export const LANGUAGES: Record<Lang, string> = { en: "English", de: "Deutsch", ru: "Русский" };
const DICTIONARIES: Record<Lang, Strings> = { en, de, ru };

let current: Lang = "en";

/** Obsidian's language when "auto"; languages without a translation fall back to English */
export function resolveLang(setting: LangSetting | undefined): Lang {
	if (setting && setting !== "auto") return setting;
	const code = getLanguage().toLowerCase();
	if (code.startsWith("de")) return "de";
	if (code.startsWith("ru")) return "ru";
	return "en";
}

export function setLanguage(setting: LangSetting | undefined) {
	current = resolveLang(setting);
}

export function lang(): Lang {
	return current;
}

/** Text in the current interface language */
export function t(): Strings {
	return DICTIONARIES[current];
}

/** Built-in historical events of every language, to tell an untouched list from a customised one */
export function isDefaultEvents(text: string): boolean {
	return Object.values(DICTIONARIES).some((d) => d.defaultEvents === text);
}
