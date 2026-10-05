import { useEffect, useId, useRef, type ReactNode, type Ref } from "react";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    /** Extra classes for the panel, mostly to widen or narrow it. */
    panelClassName?: string;
    scrollBody?: boolean;
    mobileFullScreen?: boolean;
    compact?: boolean;
    footerRef?: Ref<HTMLDivElement>;
}

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog shell in the app: escape to close, focus trapped inside,
 * focus handed back to whatever opened it, and the page behind it frozen.
 *
 * The focusable list is re-read on every Tab rather than captured once, because
 * the promotion flow swaps its whole body out as it advances.
 */
export function Modal({ isOpen, onClose, title, children, panelClassName = "", scrollBody = false, mobileFullScreen = false, compact = false, footerRef }: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const backdropMouseDown = useRef(false);
    const titleId = useId();

    /*
     * Parents hand a fresh `onClose` down on every render. Reading it through a
     * ref keeps the effect below keyed on `isOpen` alone, so the trap arms once
     * per opening instead of re-arming, snapping focus back to the trigger and
     * restoring an already-hidden body overflow.
     */
    const closeRef = useRef(onClose);
    useEffect(() => {
        closeRef.current = onClose;
    });

    useEffect(() => {
        if (!isOpen) return;

        const opener = document.activeElement as HTMLElement | null;
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                closeRef.current();
                return;
            }
            if (event.key !== "Tab" || !panelRef.current) return;

            const focusable = Array.from(
                panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
            ).filter((element) => element.offsetParent !== null && !element.matches(":disabled"));
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }

            // Safari may skip buttons and links in its native Tab order.
            // Cycle the dialog's controls explicitly so focus stays inside.
            const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
            const nextIndex = event.shiftKey
                ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
                : (activeIndex + 1) % focusable.length;
            focusable[nextIndex].focus();
            event.preventDefault();
        };

        document.addEventListener("keydown", onKeyDown, true);
        const focusTimer = window.setTimeout(() => {
            const target = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
            (target ?? panelRef.current)?.focus();
        }, 0);

        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            window.clearTimeout(focusTimer);
            document.body.style.overflow = overflow;
            opener?.focus?.();
        };
    }, [isOpen]);

    useEffect(() => {
        const viewport = window.visualViewport;
        if (!isOpen || !scrollBody || !viewport) return;
        const fit = () => {
            const overlay = overlayRef.current;
            const panel = panelRef.current;
            if (!overlay || !panel) return;
            overlay.style.top = `${viewport.offsetTop}px`;
            overlay.style.bottom = "auto";
            overlay.style.height = `${viewport.height}px`;
            const padding = getComputedStyle(overlay);
            panel.style.maxHeight = `${viewport.height - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom)}px`;
        };
        fit();
        viewport.addEventListener("resize", fit);
        viewport.addEventListener("scroll", fit);
        return () => {
            viewport.removeEventListener("resize", fit);
            viewport.removeEventListener("scroll", fit);
        };
    }, [isOpen, scrollBody, mobileFullScreen, compact]);

    if (!isOpen) return null;

    return (
        <div
            ref={overlayRef}
            className={`fixed inset-0 z-40 flex justify-center bg-black/85 backdrop-blur-sm sm:items-center sm:p-6
                ${compact ? "items-end" : "items-start"} ${mobileFullScreen ? "p-0" : "p-3"}
                ${scrollBody ? "overflow-hidden" : "overflow-y-auto"}`}
            onMouseDown={(event) => {
                backdropMouseDown.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget && backdropMouseDown.current) onClose();
            }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={`pixel-frame w-full max-w-2xl bg-neon-cyan p-[3px]
                    shadow-[0_0_50px_rgba(34,211,238,0.35)] ${compact ? "sm:my-auto" : "my-auto"}
                    ${scrollBody ? "flex max-h-[calc(100dvh-24px)] flex-col sm:max-h-[calc(100dvh-48px)]" : ""}
                    ${mobileFullScreen ? "h-dvh max-h-dvh sm:h-auto" : ""} ${panelClassName}`}
            >
                <div className={`pixel-frame bg-panel ${scrollBody ? "flex min-h-0 flex-1 flex-col" : ""}`}>
                    <div className="flex shrink-0 items-start justify-between gap-4 border-b-2 border-cyan-400/25 p-4 sm:p-5">
                        <h2
                            id={titleId}
                            className="font-pixel text-sm leading-relaxed tracking-wider text-neon-pink sm:text-base"
                        >
                            {title}
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close dialog"
                            className="focus-pixel -mt-1 shrink-0 px-2 font-pixel text-lg text-cyan-300
                                transition-colors hover:text-neon-pink"
                        >
                            X
                        </button>
                    </div>
                    <div data-modal-body className={scrollBody ? "min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5" : "p-5 sm:p-6"}>{children}</div>
                    {footerRef && <div ref={footerRef} className="shrink-0 border-t border-cyan-400/25 bg-panel px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5 empty:hidden" />}
                </div>
            </div>
        </div>
    );
}
