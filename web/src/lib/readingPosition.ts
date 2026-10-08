import type { BillboardConfig } from "./billboard";

export interface BoardNotePresentation {
    rank?: number; sats?: number; weight?: number; expired?: boolean; isNew?: boolean;
    firstPaidAt?: number; lastPaidAt?: number; hotSats?: number;
    billboard?: BillboardConfig; billboardPreviewSlide?: number;
}
export interface ReadingAnchor { id: string; top: number }
export interface BoardReadingOrigin extends ReadingAnchor { path: string; presentation: number; expanded: boolean; expandedTexts?: string[] }
export interface ReadingPosition { readingScroll: number; readingAnchor?: ReadingAnchor; readingOrigin?: BoardReadingOrigin; readingAlign?: boolean }
// Public presentation metadata only. Signed bodies stay in the shared read cache.
const presentations = new Map<number, BoardNotePresentation>();
let serial = 0;
const HEX = /^[0-9a-f]{64}$/;
const TEXT_KEY = /^(?:main|quote:[0-9a-f]{64})$/;
export function expandedNoteTexts(root: Element | null) {
    return [...root?.querySelectorAll<HTMLElement>('[data-note-text][data-note-expanded="true"]') ?? []]
        .map(node => node.dataset.noteText!).filter(key => TEXT_KEY.test(key)).slice(0, 64);
}
export function boardPresentation(origin?: BoardReadingOrigin) { return origin && presentations.get(origin.presentation); }
export function rememberBoardPresentation(value: BoardNotePresentation) {
    const key = ++serial;
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) return key;
    presentations.set(key, JSON.parse(serialized) as BoardNotePresentation);
    if (presentations.size > 16) presentations.delete(presentations.keys().next().value!);
    return key;
}
export function readingPosition(value: unknown): ReadingPosition {
    const state = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const anchor = (value: unknown): ReadingAnchor | undefined => {
        if (!value || typeof value !== "object") return;
        const { id, top } = value as Record<string, unknown>;
        return typeof id === "string" && HEX.test(id) && typeof top === "number" && Number.isFinite(top) && Math.abs(top) <= 1_000_000 ? { id, top } : undefined;
    };
    const original = anchor(state.readingOrigin);
    const origin = state.readingOrigin as Partial<BoardReadingOrigin> | undefined;
    return {
        readingScroll: typeof state.readingScroll === "number" && Number.isFinite(state.readingScroll) ? Math.max(0, Math.min(state.readingScroll, 10_000_000)) : 0,
        readingAnchor: anchor(state.readingAnchor),
        readingOrigin: original && origin && typeof origin.path === "string" && /^\/(?:waiting(?:\?view=(?:top|new|hot))?|expired)?$/.test(origin.path) && Number.isSafeInteger(origin.presentation)
            ? { ...original, path: origin.path, presentation: origin.presentation!, expanded: origin.expanded === true,
                ...(Array.isArray(origin.expandedTexts) ? { expandedTexts: [...new Set(origin.expandedTexts.filter((key): key is string => typeof key === "string" && TEXT_KEY.test(key)))].slice(0, 64) } : {}) } : undefined,
        readingAlign: state.readingAlign === true,
    };
}
export function visibleReadingAnchor(preferred?: HTMLElement | null): ReadingAnchor | undefined {
    const surface = document.querySelector<HTMLElement>("[data-reading-surface]:not([hidden])");
    const row = preferred ?? [...surface?.querySelectorAll<HTMLElement>("[data-board-note], [data-discussion-key]") ?? []]
        .find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
    const id = row?.dataset.boardNote ?? row?.dataset.discussionKey?.replace(/^event:/, "");
    return row && id && HEX.test(id) ? { id, top: row.getBoundingClientRect().top } : undefined;
}
