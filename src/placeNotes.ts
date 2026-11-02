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
		const name = place.name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Place";
		const folder = await newNoteFolder(app, folderSetting);
		const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
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
		const key = cache[place.key] ? place.key : placeKey(place.name);
		const coords = cache[key];
		if (!coords) continue;
		// place.coords is the cache's own array when the place had nothing better
		if (!place.coords || place.coords === coords) await savePlaceCoords(app, place, coords, folderSetting);
		delete cache[key];
		moved++;
	}
	return { moved, left: Object.keys(cache).length };
}

