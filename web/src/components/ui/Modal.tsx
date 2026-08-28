import { useEffect, useId, useRef, type ReactNode } from "react";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    /** Extra classes for the panel, mostly to widen or narrow it. */
    panelClassName?: string;
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
export function Modal({ isOpen, onClose, title, children, panelClassName = "" }: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);
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
            ).filter((element) => element.offsetParent !== null);
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;

            if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
                last.focus();
                event.preventDefault();
            } else if (!event.shiftKey && active === last) {
                first.focus();
                event.preventDefault();
            }
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

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto
                bg-black/85 p-3 backdrop-blur-sm sm:items-center sm:p-6"
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
                className={`pixel-frame my-auto w-full max-w-2xl bg-neon-cyan p-[3px]
                    shadow-[0_0_50px_rgba(34,211,238,0.35)] ${panelClassName}`}
            >
                <div className="pixel-frame bg-panel">
                    <div className="flex items-start justify-between gap-4 border-b-2 border-cyan-400/25 p-5 sm:p-6">
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
                    <div className="p-5 sm:p-6">{children}</div>
                </div>
            </div>
        </div>
    );
}
