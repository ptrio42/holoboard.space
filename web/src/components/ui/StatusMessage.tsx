import type { ReactNode } from "react";
import { Spinner } from "./Spinner";

export function StatusMessage({ children, loading = false, compact = false }: {
    children: ReactNode; loading?: boolean; compact?: boolean;
}) {
    return <div role="status" className={`pixel-status${compact ? " pixel-status--compact" : ""}`}>
        <span aria-hidden="true" className="pixel-status__symbol">
            {loading ? <Spinner /> : <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
                <path d="M4 3h16v2h2v12h-8v2h4v2H6v-2h4v-2H2V5h2V3Zm0 2v10h16V5H4Z" />
                <path d="M7 8h4v2H7zm6 0h4v2h-4z" opacity=".55" />
            </svg>}
        </span>
        <div className="pixel-status__copy">{children}</div>
    </div>;
}
