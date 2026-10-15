import { useLayoutEffect } from "react";

const ROW = "[data-board-note], [data-discussion-key], [data-profile-note]";
const BLOCK = "[data-note-text], [data-note-block], .note-footer, .discussion-note__header";
interface Anchor { element: HTMLElement; top: number; bottom: number; scroll: number }

/** Keep the visible reading block steady while earlier asynchronous content grows. */
export function useReadingStability(path: string) {
    useLayoutEffect(() => {
        const surface = document.querySelector<HTMLElement>("[data-reading-surface]:not([hidden])");
        if (!surface || !surface.querySelector("main")) return;
        surface.dataset.readingStable = "true";
        let anchor: Anchor | undefined;
        let frame = 0;
        let interacting = false;
        let width = innerWidth;
        const paused = () => surface.hidden || surface.hasAttribute("data-reading-restoring") || document.body.style.overflow === "hidden";
        const visible = (rect: DOMRect) => rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight;
        const capture = () => {
            if (paused() || scrollY <= 0) { anchor = undefined; return; }
            let element = anchor?.element;
            if (!element?.isConnected || !visible(element.getBoundingClientRect())) {
                const row = [...surface.querySelectorAll<HTMLElement>(ROW)].find(row => visible(row.getBoundingClientRect()));
                const blocks = [...row?.querySelectorAll<HTMLElement>(BLOCK) ?? []]
                    .filter(block => !block.closest("[inert], [aria-hidden=true], [role=dialog]") && visible(block.getBoundingClientRect()));
                // Prefer a text/media block inside a quote over the whole quote frame.
                element = blocks.find(block => !blocks.some(other => block !== other && block.contains(other))) ?? row;
            }
            if (!element) { anchor = undefined; return; }
            const { top, bottom } = element.getBoundingClientRect();
            anchor = { element, top, bottom, scroll: scrollY };
        };
        const apply = () => {
            if (interacting || paused() || innerWidth !== width) { width = innerWidth; anchor = undefined; return; }
            const previous = anchor;
            if (!previous?.element.isConnected || scrollY <= 0) { capture(); return; }
            // A shrinking document can clamp scrollY before the observer runs.
            // That automatic movement must not count as an intentional scroll.
            const limit = Math.max(0, document.documentElement.scrollHeight - innerHeight);
            const movement = scrollY - Math.min(previous.scroll, limit);
            if (previous.bottom - movement <= 0 || previous.top - movement >= innerHeight) { anchor = undefined; capture(); return; }
            const top = previous.element.getBoundingClientRect().top;
            const delta = top - previous.top + movement;
            if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: "instant" });
            capture();
        };
        const resize = new ResizeObserver(apply);
        const mutations = new MutationObserver(apply);
        resize.observe(surface);
        mutations.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden", "data-reading-restoring"] });
        const intent = () => {
            anchor = undefined;
            interacting = true;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => { interacting = false; capture(); });
        };
        window.addEventListener("scroll", capture, { passive: true });
        window.addEventListener("pointerdown", intent, true);
        window.addEventListener("click", intent, true);
        window.addEventListener("keydown", intent, true);
        window.addEventListener("resize", intent);
        capture();
        return () => {
            resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
            window.removeEventListener("scroll", capture);
            window.removeEventListener("pointerdown", intent, true);
            window.removeEventListener("click", intent, true);
            window.removeEventListener("keydown", intent, true);
            window.removeEventListener("resize", intent);
            delete surface.dataset.readingStable;
        };
    }, [path]);
}
