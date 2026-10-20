import { useLayoutEffect, type RefObject } from "react";

/** Compare complete compositions without replacing live media or the destination. */
export function useNoteLinkPlacement(root: RefObject<HTMLDivElement | null>, enabled: boolean, identity: string) {
    useLayoutEffect(() => {
        const element = root.current;
        if (!element || !enabled) return;
        const text = element.querySelector<HTMLElement>(":scope > .note-text, :scope > .note-composition-presentation");
        const media = element.querySelector<HTMLElement>(":scope > .note-composition-media, :scope > .note-quote-media");
        const link = element.querySelector<HTMLElement>(":scope > .note-link-container");
        if (!text || !media) return;
        const fit = () => {
            // Retained board cards keep their presentation while another reader hides them.
            if (!element.getBoundingClientRect().width) return;
            if (getComputedStyle(element).display !== "grid") {
                delete element.dataset.linkPlacement;
                return;
            }
            if (!link?.querySelector(".note-link-preview")) {
                delete element.dataset.linkPlacement;
                return;
            }
            const copy = link.cloneNode(true) as HTMLElement;
            copy.classList.add("note-link-measure");
            copy.inert = true;
            copy.setAttribute("aria-hidden", "true");
            copy.removeAttribute("id");
            copy.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
            // Fixed footprints keep measurement free of image and video requests.
            copy.querySelectorAll("img").forEach(image => {
                const placeholder = document.createElement("span");
                placeholder.className = "note-link-measure-image";
                image.replaceWith(placeholder);
            });
            element.append(copy);
            try {
                const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
                const style = getComputedStyle(text);
                const textHeight = text.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
                const mediaHeight = media.getBoundingClientRect().height;
                const measure = (placement: "text" | "media", width: number) => {
                    copy.dataset.measurePlacement = placement;
                    copy.style.width = `${width}px`;
                    return copy.getBoundingClientRect().height;
                };
                const besideText = Math.max(textHeight + gap + measure("text", text.getBoundingClientRect().width), mediaHeight);
                const belowMedia = Math.max(textHeight, mediaHeight + gap + measure("media", media.getBoundingClientRect().width));
                element.dataset.linkPlacement = besideText <= belowMedia + .5 ? "text" : "media";
            } finally { copy.remove(); }
        };
        fit();
        let frame = 0;
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
        const resize = new ResizeObserver(schedule);
        [element, text, media, ...(link ? [link] : [])].forEach(node => resize.observe(node));
        // React can finish clipping text after the parent's layout effect. Retain
        // the same placement before paint when handing the card to a reader.
        const mutations = new MutationObserver(fit);
        [text, media, ...(link ? [link] : [])].forEach(node => mutations.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style", "data-note-expanded"] }));
        let active = true;
        void document.fonts.ready.then(() => { if (active) schedule(); });
        return () => {
            active = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
            delete element.dataset.linkPlacement;
        };
    }, [root, enabled, identity]);
}
