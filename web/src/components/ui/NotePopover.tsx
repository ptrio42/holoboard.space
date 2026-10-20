import { useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ModalPopoverHost } from "./ModalPopoverHost";

interface NotePopoverProps {
    id: string;
    anchor: HTMLElement;
    title: string;
    menu?: boolean;
    children: ReactNode;
    onClose: (restoreFocus?: boolean) => void;
}

/** Anchored outside clipped note frames, above the board's scanlines. */
export function NotePopover({ id, anchor, title, menu = false, children, onClose }: NotePopoverProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    const titleId = `${id}-title`;
    const host = useContext(ModalPopoverHost);
    useLayoutEffect(() => { closeRef.current = onClose; });

    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const place = () => {
            const bounds = anchor.getBoundingClientRect();
            if (!anchor.isConnected || anchor.getClientRects().length === 0 || bounds.bottom < 0 || bounds.top > innerHeight) {
                closeRef.current(false);
                return;
            }
            const { width, height } = panel.getBoundingClientRect();
            const above = bounds.top - height - 8;
            const top = above >= 12 ? above : bounds.bottom + height + 8 <= innerHeight - 12 ? bounds.bottom + 8 : above;
            const origin = host?.getBoundingClientRect();
            panel.style.left = `${Math.max(12, Math.min(bounds.right - width, innerWidth - width - 12)) - (origin?.left ?? 0)}px`;
            panel.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12)) - (origin?.top ?? 0)}px`;
        };
        place();
        const menuItems = '[role="menuitem"], [role="menuitemradio"]';
        const initial = menu
            ? panel.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? panel.querySelector<HTMLElement>(menuItems)
            : panel.querySelector<HTMLElement>("button");
        initial?.focus({ preventScroll: true });
        const outside = (event: Event) => {
            const target = event.target as Node;
            if (!panel.contains(target) && !anchor.contains(target)) closeRef.current(false);
        };
        const focusAnchor = (event: MouseEvent) => {
            if (event.button !== 0 || !anchor.contains(event.target as Node)) return;
            // Safari otherwise focuses the ancestor and closes before the trigger click.
            event.preventDefault();
            anchor.focus({ preventScroll: true });
        };
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current();
            } else if (event.key === "Tab") {
                closeRef.current();
            } else if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = [...panel.querySelectorAll<HTMLElement>(menuItems)];
                const index = items.indexOf(document.activeElement as HTMLElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
            } else if (menu && event.key === " " && document.activeElement instanceof HTMLAnchorElement) {
                event.preventDefault();
                document.activeElement.click();
            }
        };
        // The board stays mounted behind readers, so history navigation must close its portals.
        const navigate = () => closeRef.current(false);
        window.addEventListener("popstate", navigate);
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("mousedown", focusAnchor, true);
        document.addEventListener("focusin", outside);
        // Handle Escape before an enclosing modal's document listener.
        window.addEventListener("keydown", keyboard, true);
        window.addEventListener("resize", place);
        document.addEventListener("scroll", place, true);
        const observer = new ResizeObserver(place);
        observer.observe(panel);
        return () => {
            window.removeEventListener("popstate", navigate);
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("mousedown", focusAnchor, true);
            document.removeEventListener("focusin", outside);
            window.removeEventListener("keydown", keyboard, true);
            window.removeEventListener("resize", place);
            document.removeEventListener("scroll", place, true);
            observer.disconnect();
        };
    }, [anchor, menu, host]);

    return createPortal(<div id={id} ref={panelRef} className="note-popover" role={menu ? "group" : "dialog"}
        aria-labelledby={titleId}>
        <div className="note-popover__heading">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="note-icon-control" aria-label={`Close ${title.toLowerCase()}`}
                onClick={() => onClose()}><span aria-hidden="true">×</span></button>
        </div>
        {children}
    </div>, host ?? document.body);
}
