import type { MouseEvent } from "react";
import { expandedNoteTexts, readingPosition, rememberBoardPresentation, visibleReadingAnchor, type BoardNotePresentation, type ReadingPosition } from "./readingPosition";

const positions = new Map<string, ReadingPosition>();

/** Only intercept explicit local reading links; modified clicks keep browser behavior. */
export function navigateReading(event: MouseEvent<HTMLAnchorElement>, presentation?: BoardNotePresentation) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = new URL(event.currentTarget.href);
    if (target.origin !== window.location.origin) return;
    event.preventDefault();
    const source = event.currentTarget.closest<HTMLElement>("[data-board-note]");
    const current = readingPosition(history.state);
    const disclosure = document.querySelector('[data-reading-focus] [data-note-expanded]');
    if (current.readingOrigin && disclosure) {
        current.readingOrigin.expanded = disclosure.getAttribute("data-note-expanded") === "true";
        current.readingOrigin.expandedTexts = expandedNoteTexts(document.querySelector("[data-reading-focus]"));
    }
    const saved = { ...current, readingAlign: false, readingScroll: scrollY, readingAnchor: visibleReadingAnchor(source) };
    positions.set(window.location.pathname + window.location.search, saved);
    if (positions.size > 16) positions.delete(positions.keys().next().value!);
    window.history.replaceState({ ...window.history.state, ...saved }, "");
    const anchor = source && visibleReadingAnchor(source);
    const origin = presentation && anchor && /^\/discussion\//.test(target.pathname) ? { ...anchor,
        path: location.pathname + location.search, presentation: rememberBoardPresentation(presentation),
        expanded: source.querySelector('[data-note-expanded]')?.getAttribute("data-note-expanded") === "true",
        expandedTexts: expandedNoteTexts(source) } : undefined;
    window.history.pushState(origin ? { readingScroll: 0, readingOrigin: origin, readingAlign: true }
        : positions.get(target.pathname + target.search) ?? { readingScroll: 0 }, "", target.pathname + target.search);
    window.dispatchEvent(new PopStateEvent("popstate"));
}
