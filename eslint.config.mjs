import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Same checks as the Obsidian Community directory's automated review (https://github.com/obsidianmd/eslint-plugin)
export default defineConfig([
	{ ignores: ["node_modules/", "main.js", "dist/", "docs/", "test/", ".test/", "*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "package.json"],
				},
			},
		},
	},
	{
		// manifest.json is checked as a JS object expression by the plugin's validator
		files: ["manifest.json"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false } },
		plugins: { obsidianmd },
		rules: { "obsidianmd/validate-manifest": "error" },
	},
]);
