import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Clamps tall content and offers to unfold it.
 *
 * On a board ranked by sats this is a defence rather than a nicety. Nothing
 * bounded the height of a note, so a single sat bought the tallest post on the
 * page and pushed everyone who had paid more below the fold. Rank is supposed
 * to be the only thing that decides position.
 *
 * The button only appears when there is genuinely something hidden, which is
 * measured rather than guessed: a note is as tall as its images, and those
 * arrive after the first render.
 */

/** Roughly a dozen lines of body text. Tall enough to read, short enough to scan. */
const COLLAPSED_MAX_PX = 224;

/** Ignore an overflow too small to be worth a button. */
const SLACK_PX = 24;

interface ExpandableProps {
    children: ReactNode;
    /** Named in the button's accessible label, e.g. "note by alice". */
    label?: string;
}

export function Expandable({ children, label }: ExpandableProps) {
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);

    // Measured on the inner element, which is never the one being clipped, so
    // its height is the real height whether or not the wrapper is collapsed.
    useEffect(() => {
        const element = contentRef.current;
        if (!element) return;

        const measure = () => setOverflows(element.scrollHeight > COLLAPSED_MAX_PX + SLACK_PX);
        measure();

        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [children]);

    const toggle = useCallback(() => setExpanded((open) => !open), []);
    const clamped = overflows && !expanded;

    return (
        <div>
            <div
                className="relative overflow-hidden"
                style={{ maxHeight: clamped ? COLLAPSED_MAX_PX : undefined }}
            >
                <div ref={contentRef}>{children}</div>
                {clamped && (
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-16
                            bg-gradient-to-b from-transparent to-panel"
                    />
                )}
            </div>

            {overflows && (
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={expanded}
                    className="focus-pixel mt-2 font-pixel text-[9px] tracking-widest
                        text-cyan-300/50 hover:text-neon-cyan"
                >
                    {expanded ? "Show less" : "Show more"}
                    <span className="sr-only">{label ? ` of the ${label}` : " of this note"}</span>
                </button>
            )}
        </div>
    );
}
