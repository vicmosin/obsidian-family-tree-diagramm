import type { Component } from "obsidian";

/**
 * On mobile, Obsidian opens the left or right sidebar on a horizontal swipe anywhere in the
 * workspace, so panning the diagram with a finger kept opening them. Stop touch moves on the
 * diagram from bubbling past the document, where Obsidian listens for that gesture.
 *
 * The listener sits on the document rather than on `el` because Leaflet (1.8+) follows a drag
 * with its own document-level listener; stopping the event at `el` freezes the map. preventDefault
 * is not called, so native scrolling (timeline) still works. Same fix as the Map View plugin:
 * https://github.com/Leaflet/Leaflet/discussions/8972
 */
export function keepTouchesInside(owner: Component, el: HTMLElement | (() => HTMLElement | undefined)) {
	// A function returns the current element when the caller recreates it (the view does on language change)
	const current = typeof el === "function" ? el : () => el;
	owner.registerDomEvent(
		current()?.ownerDocument ?? activeDocument,
		"touchmove",
		(e) => {
			const target = current();
			if (target && e.target instanceof Node && target.contains(e.target)) e.stopPropagation();
		},
		{ passive: true }
	);
}
