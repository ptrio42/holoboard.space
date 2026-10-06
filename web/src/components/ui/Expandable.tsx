import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NoteDisclosure } from "./NoteControls";

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
    expandedContent?: ReactNode;
    expandLabel?: string;
    collapseLabel?: string;
    footer?: (control: ReactNode) => ReactNode;
}

export function Expandable({ children, label, expandedContent, expandLabel = "Show more", collapseLabel = "Show less", footer }: ExpandableProps) {
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const [collapsedHeight, setCollapsedHeight] = useState(COLLAPSED_MAX_PX);
    const [clipsBlock, setClipsBlock] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const contentId = useId();

    // Measured on the inner element, which is never the one being clipped, so
    // its height is the real height whether or not the wrapper is collapsed.
    useEffect(() => {
        const element = contentRef.current;
        if (!element) return;

        const measure = () => {
            const overflowing = element.scrollHeight > COLLAPSED_MAX_PX + SLACK_PX;
            setOverflows(overflowing);
            let height = COLLAPSED_MAX_PX;
            let blockBoundary = false;
            const top = element.getBoundingClientRect().top;
            const blocks = element.querySelectorAll<HTMLElement>("[data-note-block]");
            let lastBlockEnd = 0;
            for (const block of blocks) {
                const bounds = block.getBoundingClientRect();
                const start = bounds.top - top;
                const end = bounds.bottom - top;
                if (start < height && end > height) {
                    // Keep a leading quote intact; later quotes unfold as complete previews.
                    height = start < SLACK_PX ? end : start;
                    blockBoundary = true;
                    break;
                }
                if (start >= height && lastBlockEnd > 0) {
                    height = lastBlockEnd;
                    blockBoundary = true;
                    break;
                }
                if (end <= height) lastBlockEnd = end;
            }
            setCollapsedHeight(height);
            setClipsBlock(blockBoundary);
            blocks.forEach(block => {
                block.inert = overflowing && !expanded && block.getBoundingClientRect().top - top >= height;
            });
            // A clipped link must not receive keyboard focus outside the visible preview.
            element.querySelectorAll<HTMLElement>("a, button, input, video, [tabindex]").forEach(control => {
                const bounds = control.getBoundingClientRect();
                control.inert = overflowing && !expanded && bounds.bottom - top > height;
            });
        };
        measure();

        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [children, expanded]);

    const toggle = useCallback(() => setExpanded((open) => !open), []);
    const clamped = overflows && !expanded;
    const control = overflows || expandedContent ? <NoteDisclosure expanded={expanded} controls={contentId} onClick={toggle}
        visibleLabel={expanded ? "Less" : expandedContent ? "Original" : "More"}>
        {expanded ? collapseLabel : expandLabel}
        {label ? ` of the ${label}` : " of this note"}
    </NoteDisclosure> : null;

    return (
        <div>
            <div
                id={contentId}
                className="relative overflow-hidden"
                style={{ maxHeight: clamped ? collapsedHeight : undefined }}
            >
                <div ref={contentRef}>{children}</div>
                {expanded && expandedContent}
                {clamped && !clipsBlock && (
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-16
                            bg-gradient-to-b from-transparent to-panel"
                    />
                )}
            </div>

            {footer ? footer(control) : control && <div className="mt-1">{control}</div>}
        </div>
    );
}
