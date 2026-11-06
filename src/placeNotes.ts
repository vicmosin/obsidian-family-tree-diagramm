import { App, normalizePath, TFolder } from "obsidian";
import { Coords, Place, placeKey } from "./places";

/**
 * Folder for a new note: the plugin setting if set, otherwise Obsidian's "Default location for new notes"
 * (Settings → Files and links). Created if missing.
 */
export async function newNoteFolder(app: App, setting: string): Promise<string> {
	const folder = setting.trim() ? normalizePath(setting.trim()) : app.fileManager.getNewFileParent("").path;
	if (!folder || folder === "/") return "";
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await app.vault.createFolder(folder);
	return folder;
}

/**
 * Saves coordinates as `location` in the place's note. A place without a note gets one (`type: place`)
 * in the place notes folder; an existing note there with the same name is reused.
 */
export async function savePlaceCoords(app: App, place: Place, coords: Coords, folderSetting: string): Promise<"updated" | "created"> {
	let file = place.notePath ? app.vault.getFileByPath(place.notePath) : null;
	let created = false;
	if (!file) {
		const path = await newPlacePath(app, place.name, folderSetting);
		file = app.vault.getFileByPath(path);
		if (!file) {
			file = await app.vault.create(path, "");
			created = true;
		}
	}
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm.type ??= "place";
		fm.location = coords;
	});
	return created ? "created" : "updated";
}

const UNSAFE = /[\\:*?"<>|#^[\]]/g;

/**
 * Where a note for a place without one goes. A path-style link (`[[Geo/Leeds]]`) gets its note at that
 * path, so the link resolves to it; a plain name goes to the place notes folder.
 */
async function newPlacePath(app: App, name: string, folderSetting: string): Promise<string> {
	const parts = name.split("/").map((p) => p.replace(UNSAFE, "").trim()).filter(Boolean);
	const base = parts.pop() || "Place";
	let folder: string;
	if (parts.length) {
		folder = normalizePath(parts.join("/"));
		if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await app.vault.createFolder(folder);
	} else folder = await newNoteFolder(app, folderSetting);
	return normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
}

/**
 * Moves coordinates that versions before 1.1.0 kept in plugin data into place notes. A note's own
 * coordinates win over remembered ones. Entries for places no person mentions are left in `cache`.
 */
export async function migratePlaceCache(
	app: App,
	places: Place[],
	cache: Record<string, Coords>,
	folderSetting: string
): Promise<{ moved: number; left: number }> {
	let moved = 0;
	for (const place of places) {
		// Earlier versions keyed coordinates by note path or by the name written in the person note,
		// which may be an alias or another spelling of the place
		const keys = [...new Set([place.key, placeKey(place.name), ...place.mentions.map(placeKey)])].filter((k) => cache[k]);
		if (!keys.length) continue;
		// place.coords is one of the cache's own arrays when the place had nothing better
		const fromCache = !place.coords || keys.some((k) => cache[k] === place.coords);
		if (fromCache) await savePlaceCoords(app, place, place.coords ?? cache[keys[0]], folderSetting);
		for (const k of keys) delete cache[k];
		moved++;
	}
	return { moved, left: Object.keys(cache).length };
}

