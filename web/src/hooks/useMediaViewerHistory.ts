import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { MEDIA_VIEWER_ENTRY as ENTRY } from "../lib/mediaViewerEntry";
import { visibleReadingAnchor } from "../lib/readingPosition";
import { pauseNoteVideos } from "./useNoteVideo";
interface ViewerSession {
    id: string;
    url: string;
    started: boolean;
    closing: boolean;
    left: number;
    top: number;
    overflow: string;
    nested: boolean;
    scroll: { element: HTMLElement; left: number; top: number }[];
}
function viewerId(state: unknown): unknown {
    return state && typeof state === "object" ? (state as Record<string, unknown>)[ENTRY] : undefined;
}

/** Own one temporary entry; route changes and unmounts never traverse history. */
export function useMediaViewerHistory(onClose: () => void, openerRef: RefObject<HTMLElement | null>) {
    const closeRef = useRef(onClose);
    const sessionRef = useRef<ViewerSession | null>(null);
    useLayoutEffect(() => { closeRef.current = onClose; });
    useLayoutEffect(() => {
        let session = sessionRef.current;
        if (!session) {
            const ancestors = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>("[data-modal-body]"));
            for (let element = openerRef.current?.parentElement; element; element = element.parentElement) ancestors.add(element);
            session = {
                id: crypto.randomUUID(), url: location.href, started: false, closing: false,
                left: window.scrollX, top: window.scrollY, overflow: document.body.style.overflow,
                nested: !!document.querySelector('[role="dialog"][aria-modal="true"]:not(.note-media-viewer)'),
                scroll: [...ancestors].map(element => ({ element, left: element.scrollLeft, top: element.scrollTop })),
            };
            sessionRef.current = session;
        }
        const current = session;
        const ownsEntry = () => location.href === current.url && viewerId(history.state) === current.id;
        // Retain all existing reading fields, including origin, disclosures and anchors.
        const base = history.state && typeof history.state === "object" ? history.state : {};
        if (!current.started) {
            pauseNoteVideos();
            const saved = { ...base, readingScroll: current.top, readingAnchor: visibleReadingAnchor() };
            // A local route can replace the viewer entry; its predecessor must
            // already contain the exact position to which Back will return.
            history.replaceState(saved, "", current.url);
            history.pushState({ ...saved, [ENTRY]: current.id }, "", current.url);
            current.started = true;
        } else if (location.href === current.url) {
            // React StrictMode repeats effects without opening a second history entry.
            history.replaceState({ ...base, [ENTRY]: current.id }, "", current.url);
        }
        const pop = () => {
            // The app also emits synthetic popstate events after pushState.
            if (ownsEntry()) return;
            current.closing = true;
            closeRef.current();
        };
        window.addEventListener("popstate", pop);
        return () => {
            window.removeEventListener("popstate", pop);
            if (ownsEntry()) {
                const next = { ...history.state };
                delete next[ENTRY];
                history.replaceState(next, "", current.url);
            }
            // Shared Modal cleanup runs separately. Repair only this viewer's nested
            // teardown, where a departing parent and child can otherwise leave hidden.
            queueMicrotask(() => {
                if (document.querySelector(".note-media-viewer")) return;
                const remainingDialog = document.querySelector('[role="dialog"][aria-modal="true"]');
                document.body.style.overflow = remainingDialog ? "hidden" : current.nested && current.overflow === "hidden" ? "" : current.overflow;
                if (location.href !== current.url) return;
                for (const { element, left, top } of current.scroll) {
                    if (element.isConnected) element.scrollTo({ left, top, behavior: "instant" });
                }
                window.scrollTo({ left: current.left, top: current.top, behavior: "instant" });
            });
        };
    }, [openerRef]);
    return useCallback(() => {
        const session = sessionRef.current;
        if (!session || session.closing) return;
        session.closing = true;
        if (location.href === session.url && viewerId(history.state) === session.id) {
            // Wait for traversal before unmounting so Back has one owner.
            history.back();
        } else {
            closeRef.current();
        }
    }, []);
}
