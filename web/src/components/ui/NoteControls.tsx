import type { ReactNode } from "react";

export function NoteExternalLink({ href, label = "Open note", className = "" }: { href: string; label?: string; className?: string }) {
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow"
        aria-label={label} title={label} className={`note-open ${className}`}>
        <span aria-hidden="true">Open</span>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" shapeRendering="crispEdges">
            <path d="M4 0h8v8h-2V4H8v2H6v2H4v2H2v2H0v-2h2V8h2V6h2V4h2V2H4z" />
        </svg>
    </a>;
}

export function NoteDisclosure({ expanded, controls, onClick, visibleLabel, children }: {
    expanded: boolean; controls: string; onClick: () => void; visibleLabel: string; children: ReactNode;
}) {
    return <button type="button" onClick={onClick} aria-expanded={expanded} aria-controls={controls}
        className="note-action note-disclosure">
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" shapeRendering="crispEdges">
            <path d={expanded ? "M0 4h10v2H0z" : "M4 0h2v4h4v2H6v4H4V6H0V4h4z"} />
        </svg>
        <span aria-hidden="true">{visibleLabel}</span>
        <span className="sr-only">{children}</span>
    </button>;
}
