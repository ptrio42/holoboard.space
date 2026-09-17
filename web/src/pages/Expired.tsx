import { useCallback, useEffect, useRef, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
import { PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { ndk } from "../lib/ndk";
import { fetchExpired, type ExpiredEntry } from "../lib/expired";

export default function Expired() {
    const [entries, setEntries] = useState<ExpiredEntry[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
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

    return <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6">
        <header className="mb-10 space-y-6">
            <a href="/" className="focus-pixel inline-flex min-h-11 items-center font-pixel text-[9px] tracking-widest text-cyan-300/60 hover:text-neon-cyan">&lt; Back to board</a>
            <div className="space-y-4 text-center">
                <h1 className="font-pixel text-xl leading-relaxed tracking-widest text-cyan-300/70 sm:text-3xl">Expired</h1>
                <p className="mx-auto max-w-xl text-xs leading-relaxed text-cyan-200/60 sm:text-sm">
                    These notes have no sats still counting. Their past payments are kept.
                    Promote one again to bring it back to the board.
                </p>
            </div>
        </header>
        <main aria-busy={loading}>
            {error && <div role="alert" className="mb-6 space-y-3 border-2 border-neon-pink/40 p-4 text-sm text-pink-200">
                <p>{error}</p>
                <PixelButton size="sm" variant="ghost" onClick={() => void load(retryCursor.current)}>Try again</PixelButton>
            </div>}
            {entries.length > 0 && <ul className="space-y-4">
                {entries.map((entry) => <BoardRow key={entry.event.id}
                    event={new NDKEvent(ndk, entry.event)} expired sats={entry.satsPaid} weight={0}
                    lastPaidAt={entry.lastPaidAt} onPromote={() => setSelected(entry.event.id)} />)}
            </ul>}
            {loading && <p role="status" className="mt-6 text-center font-pixel text-[9px] text-cyan-300/50">Loading expired notes...</p>}
            {!loading && !error && entries.length === 0 && <PixelPanel>
                <div className="space-y-3 p-6 text-center">
                    <h2 className="font-pixel text-xs text-cyan-200/70">No expired notes</h2>
                    <p className="text-sm text-cyan-200/50">Notes appear here when their promotion fades to zero.</p>
                </div>
            </PixelPanel>}
            {cursor && !error && <div className="mt-6 flex justify-center">
                <PixelButton variant="ghost" disabled={loading} onClick={() => void load(cursor)}>Load more</PixelButton>
            </div>}
        </main>
        {selected && <PromoteModal initialReference={selected} currentWeight={0}
            onClose={() => setSelected(null)} onPaid={() => {
                setEntries((previous) => previous.filter((entry) => entry.event.id !== selected));
                void load();
            }} />}
    </div>;
}
