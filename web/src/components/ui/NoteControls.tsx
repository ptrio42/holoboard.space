import type { ReactNode } from "react";

export function CommentIcon() {
    return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" shapeRendering="crispEdges">
        <path d="M0 0h12v8H6v2H4v2H2V8H0V0Zm2 2v4h2v2h2V6h4V2H2Z" />
    </svg>;
}

export function NoteReplyButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
    return <button type="button" className="note-icon-control" aria-label="Reply" title="Reply" disabled={disabled} onClick={onClick}><CommentIcon /></button>;
}

export function BoostIcon() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges">
        <path d="M11 3h2v2h2v2h2v2h-3v2H12v2h4v2h-2v2H12v2H10v2H8v2H6v-4h2v-4H6v-2h2v-2h2V9H7V7h2V5h2z" />
    </svg>;
}

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
