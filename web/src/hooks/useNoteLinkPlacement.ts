import { useLayoutEffect, type RefObject } from "react";

/** Measure an inert link card at text-column width without moving its live instance. */
export function useNoteLinkPlacement(root: RefObject<HTMLDivElement | null>, enabled: boolean, identity: string) {
    useLayoutEffect(() => {
        const element = root.current;
        if (!element || !enabled) return;
        const text = element.querySelector<HTMLElement>(":scope > .note-text, :scope > .note-composition-presentation");
        const media = element.querySelector<HTMLElement>(":scope > .note-composition-media");
        const link = element.querySelector<HTMLElement>(":scope > .note-link-container");
        if (!text || !media || !link) return;
        const fit = () => {
            // Retained board cards keep their presentation while another reader hides them.
            if (!element.getBoundingClientRect().width) return;
            if (getComputedStyle(element).display !== "grid" || !link.querySelector(".note-link-preview")) {
                delete element.dataset.linkPlacement;
                return;
            }
            const copy = link.cloneNode(true) as HTMLElement;
            copy.classList.add("note-link-measure");
            copy.inert = true;
            copy.setAttribute("aria-hidden", "true");
            copy.removeAttribute("id");
            copy.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
            // Images are represented by their fixed thumbnail footprint, with no source request.
            copy.querySelectorAll("img").forEach(image => {
                const placeholder = document.createElement("span");
                placeholder.className = "note-link-measure-image";
                image.replaceWith(placeholder);
            });
            copy.style.width = `${text.getBoundingClientRect().width}px`;
            element.append(copy);
            try {
                const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
                const fits = text.getBoundingClientRect().height + gap + copy.getBoundingClientRect().height <= media.getBoundingClientRect().height + 0.5;
                element.dataset.linkPlacement = fits ? "text" : "media";
            } finally { copy.remove(); }
        };
        fit();
        let frame = 0;
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
        const resize = new ResizeObserver(schedule);
        [element, text, media, link].forEach(node => resize.observe(node));
        // React may finish clipping text after the parent's layout effect. Observe
        // that commit before paint so a reader handoff retains the same placement.
        const mutations = new MutationObserver(fit);
        [text, media, link].forEach(node => mutations.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "data-note-expanded"] }));
        let active = true;
        void document.fonts.ready.then(() => { if (active) schedule(); });
        return () => { active = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); delete element.dataset.linkPlacement; };
    }, [root, enabled, identity]);
}
