import { useCallback, useEffect, useRef, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
import { PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { StatusMessage } from "../components/ui/StatusMessage";
import { useWaitingUpdates } from "../hooks/useWaitingUpdates";
import { ndk } from "../lib/ndk";
import { fetchExpired, type ExpiredEntry } from "../lib/expired";

export default function Expired() {
    const updates = useWaitingUpdates();
    const [entries, setEntries] = useState<ExpiredEntry[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);
    const retryCursor = useRef<string | undefined>(undefined);

    const load = useCallback(async (next?: string) => {
        controller.current?.abort();
        const request = new AbortController();
        controller.current = request;
        retryCursor.current = next;
        setLoading(true);
        setError("");
        try {
            const page = await fetchExpired(next, request.signal);
            if (request.signal.aborted) return;
            setEntries((previous) => {
                const combined = next ? [...previous, ...page.entries] : page.entries;
                return [...new Map(combined.map((entry) => [entry.event.id, entry])).values()];
            });
            setCursor(page.nextCursor);
        } catch (failure) {
            if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load expired notes.");
        } finally {
            if (!request.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
        return () => controller.current?.abort();
    }, [load]);

    return <BoardLayout newWaitingCount={updates.count} section="expired" onPromote={() => { setSelected(null); setOpen(true); }}
        headerContent={<p className="mt-4 text-center text-sm leading-relaxed text-cyan-100/60 md:text-left">Promotion has faded to zero. Promote a note again to return it to the board.</p>}>
        <main id="board" tabIndex={-1} aria-busy={loading}>
            {error && <div role="alert" className="mb-5 space-y-3 border-2 border-neon-pink/40 p-4 text-xs text-neon-pink">
                <p>{error}</p>
                <PixelButton size="sm" variant="ghost" onClick={() => void load(retryCursor.current)}>Try again</PixelButton>
            </div>}
            {entries.length > 0 && <ul className="space-y-4">
                {entries.map((entry) => <BoardRow key={entry.event.id}
                    event={new NDKEvent(ndk, entry.event)} expired sats={entry.satsPaid} weight={0}
                    lastPaidAt={entry.lastPaidAt} onPromote={() => { setSelected(entry.event.id); setOpen(true); }} />)}
            </ul>}
            {loading && <StatusMessage loading>Loading expired notes...</StatusMessage>}
            {!loading && !error && entries.length === 0 && <PixelPanel>
                <StatusMessage>
                    <h2 className="font-pixel text-xs text-cyan-200/85">No expired notes</h2>
                    <p>Notes appear here when their promotion fades to zero.</p>
                </StatusMessage>
            </PixelPanel>}
            {cursor && !error && <div className="mt-6 flex justify-center">
                <PixelButton variant="ghost" disabled={loading} onClick={() => void load(cursor)}>Load more</PixelButton>
            </div>}
        </main>
        {open && <PromoteModal initialReference={selected ?? undefined} currentWeight={selected ? 0 : undefined}
            onClose={() => { setOpen(false); setSelected(null); }} onPaid={() => {
                setEntries((previous) => previous.filter((entry) => entry.event.id !== selected));
                void load();
            }} />}
    </BoardLayout>;
}
