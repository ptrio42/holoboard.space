import { useLayoutEffect } from "react";
import { boardPresentation, readingPosition } from "../lib/readingPosition";

/** Restore an event's viewport position, including delayed reads and board updates. */
export function useReadingPosition(path: string, enabled: boolean) {
    useLayoutEffect(() => {
        if (!enabled) return;
        const previous = history.scrollRestoration;
        history.scrollRestoration = "manual";
        return () => { history.scrollRestoration = previous; };
    }, [enabled]);
    useLayoutEffect(() => {
        if (!enabled) return;
        const saved = readingPosition(history.state);
        const origin = saved.readingOrigin;
        const incoming = saved.readingAlign && origin && boardPresentation(origin) ? origin : undefined;
        const desired = incoming ?? saved.readingAnchor;
        const surface = document.querySelector<HTMLElement>("[data-reading-surface]:not([hidden])");
        if (!surface) return;
        if (!desired && saved.readingScroll === 0) { window.scrollTo({ top: 0, behavior: "instant" }); return; }
        surface.dataset.readingRestoring = "true";
        let stopped = false;
        const apply = () => {
            if (stopped) return;
            const row = desired && surface.querySelector<HTMLElement>(`[data-board-note="${desired.id}"], [data-discussion-key="event:${desired.id}"]`);
            if (!row) { window.scrollTo({ top: saved.readingScroll, behavior: "instant" }); return; }
            const previousGap = Number.parseFloat(row.style.getPropertyValue("--reading-gap")) || 0;
            const baseTop = row.getBoundingClientRect().top + scrollY - previousGap;
            // A newly opened reader can start below the clicked note's position.
            const gap = Math.min(innerHeight, Math.max(0, desired.top - baseTop));
            if (gap !== previousGap) row.style.setProperty("--reading-gap", `${gap}px`);
            const top = Math.max(0, baseTop + gap - desired.top);
            const previousTail = Number.parseFloat(surface.style.getPropertyValue("--reading-tail")) || 0;
            const tail = Math.min(innerHeight, Math.max(0, Math.ceil(top + innerHeight - (document.documentElement.scrollHeight - previousTail))));
            if (tail !== previousTail) surface.style.setProperty("--reading-tail", `${tail}px`);
            window.scrollTo({ top, behavior: "instant" });
            if (incoming && history.state?.readingAlign === true) history.replaceState({ ...history.state, readingAlign: false, readingAnchor: { id: incoming.id, top: incoming.top } }, "");
        };
        const observer = new ResizeObserver(apply);
        const mutations = new MutationObserver(apply);
        const interactions = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
        const stop = () => { stopped = true; delete surface.dataset.readingRestoring; observer.disconnect(); mutations.disconnect(); clearTimeout(timer); for (const name of interactions) window.removeEventListener(name, stop); };
        const timer = window.setTimeout(stop, 35_000);
        observer.observe(surface);
        mutations.observe(surface, { childList: true, subtree: true });
        for (const name of interactions) window.addEventListener(name, stop, { passive: true });
        apply();
        return stop;
    }, [path, enabled]);
}
