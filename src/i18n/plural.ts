export interface PluralForms {
	one: string;
	/** Russian 2–4 */
	few?: string;
	/** Russian 5–20 */
	many?: string;
	other: string;
}

/** Picks the plural form for `count` and replaces `#` with the number */
export function plural(locale: string, count: number, forms: PluralForms): string {
	const rule = new Intl.PluralRules(locale).select(count) as keyof PluralForms;
	return (forms[rule] ?? forms.other).replace(/#/g, String(count));
}
