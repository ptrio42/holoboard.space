import { useCallback, useEffect, useMemo, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal, RANKING_SECTION } from "../components/PromoteModal/PromoteModal";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { PixelLink, PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { fetchCampaigns, type CampaignPage, type CampaignView } from "../lib/campaigns";
import { useWaitingUpdates } from "../hooks/useWaitingUpdates";
import { ndk } from "../lib/ndk";

export default function Billboard() {
    const waiting = window.location.pathname === "/waiting";
    const selectedView = new URLSearchParams(window.location.search).get("view");
    const [view, setView] = useState<CampaignView>(waiting ? selectedView === "new" || selectedView === "hot" ? selectedView : "top" : "board");
    const [pages, setPages] = useState(1);
    const [data, setData] = useState<CampaignPage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [nudge, setNudge] = useState(0);
    const [promotion, setPromotion] = useState<{ id: string; weight: number } | null>(null);
    const [open, setOpen] = useState(false);
    const [linkedSection, setLinkedSection] = useState("");
    const refresh = useCallback(() => setNudge((value) => value+1), []);
    useEffect(() => {
        const readHash = () => { if (window.location.hash === `#${RANKING_SECTION}`) { setLinkedSection(RANKING_SECTION); setOpen(true); } };
        readHash(); window.addEventListener("hashchange", readHash);
        return () => window.removeEventListener("hashchange", readHash);
    }, []);
    useEffect(() => {
        let controller: AbortController;
        const load = async () => {
            controller?.abort();
            const request = new AbortController(); controller = request;
            try {
                const results = await Promise.all(Array.from({ length: pages }, (_, index) => fetchCampaigns(view, index+1, request.signal)));
                if (request.signal.aborted) return;
                const entries = [...new Map(results.flatMap((result) => result.entries).map((entry) => [entry.id, entry])).values()];
                setData({ ...results[0], entries, hasMore: results[results.length-1].hasMore }); setError("");
            } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load campaigns."); }
            finally { if (!request.signal.aborted) setLoading(false); }
        };
        void load();
        const timer = window.setInterval(() => void load(), 15000);
        const onVisible = () => { if (document.visibilityState === "visible") void load(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
    }, [view, pages, nudge]);
    const updates = useWaitingUpdates(waiting, !loading && !error ? data?.checkedAt : undefined);
    const newIds = useMemo(() => new Set(updates.noteIds), [updates.noteIds]);
    const events = useMemo(() => data?.entries.map((entry) => ({ ...entry, note: new NDKEvent(ndk, entry.event) })) ?? [], [data]);
    const chooseView = (next: CampaignView) => {
        if (next === view) return;
        setView(next); setPages(1); setData(null); setLoading(true);
        window.history.replaceState(null, "", `/waiting?view=${next}`);
    };
    return <BoardLayout newWaitingCount={updates.count} section={waiting ? "waiting" : "board"} onPromote={() => { setPromotion(null); setOpen(true); }}
        headerContent={waiting && <div role="group" aria-label="Waiting room sort" className="board-sort mt-4 flex flex-wrap items-center justify-center gap-2 md:justify-start">
                <span className="mr-1 hidden text-xs text-cyan-200/70 min-[360px]:inline">Sort</span>
                {(["top", "new", "hot"] as const).map((sort) => <PixelButton key={sort} size="sm" variant="ghost" aria-pressed={view === sort} onClick={() => chooseView(sort)}>{sort === "top" ? "Rank" : sort === "new" ? "New" : "Hot"}</PixelButton>)}
                <button type="button" aria-label="How sorting works" className="focus-pixel inline-flex min-h-11 min-w-11 items-center justify-center font-pixel text-[10px] text-cyan-200/70 hover:text-neon-cyan" onClick={() => { setPromotion(null); setLinkedSection(RANKING_SECTION); setOpen(true); }}>?</button>
            </div>}>
        <main id="board" tabIndex={-1} aria-busy={loading}>
            {waiting && updates.count > 0 && <p role="status" className="mb-4 text-xs text-neon-gold">{updates.count} new {updates.count === 1 ? "note" : "notes"} since your last visit.</p>}
            {error && <div role="alert" className="mb-5 space-y-3 border-2 border-neon-pink/40 p-4 text-xs text-neon-pink"><p>{error}</p><PixelButton size="sm" variant="ghost" onClick={refresh}>Try again</PixelButton></div>}
            {loading && !data && <p role="status" className="py-8 text-center font-pixel text-[10px] text-cyan-300/60">Loading notes...</p>}
            {!loading && !error && events.length === 0 && <PixelPanel><div className="space-y-3 p-6 text-center"><h2 className="font-pixel text-xs text-cyan-200/70">{waiting ? view === "hot" ? "No recent boosts here" : "The waiting room is empty" : "The board is empty"}</h2><p className="text-sm text-cyan-100/60">{waiting ? "Active notes outside the top 21 appear here." : "Promote a note to start its campaign."}</p></div></PixelPanel>}
            <ul className="space-y-4">{events.map((entry) => <BoardRow key={entry.id} isNew={waiting && newIds.has(entry.id)} event={entry.note} rank={entry.rank} sats={entry.satsPaid} weight={entry.weight} billboard={entry.billboard} hotSats={view === "hot" ? entry.hotSats : undefined} firstPaidAt={view === "new" ? entry.firstPaidAt : undefined} onPromote={() => { setPromotion({ id: entry.id, weight: entry.weight }); setOpen(true); }} />)}</ul>
            {data?.hasMore && waiting && <div className="mt-6 flex justify-center"><PixelButton variant="ghost" disabled={loading} onClick={() => { setLoading(true); setPages((value) => value+1); }}>Load more</PixelButton></div>}
            {!waiting && data && data.activePosts > 21 && <div className="mt-6 flex justify-center"><PixelLink href="/waiting" variant="ghost" className="[&>span]:min-h-11">Waiting room ({data.activePosts-21})</PixelLink></div>}
        </main>
        {open && <PromoteModal initialReference={promotion?.id} currentWeight={promotion?.weight} rankingTargets={data?.targets ?? []} openSection={linkedSection} onPaid={refresh} onClose={() => { setOpen(false); setPromotion(null); setLinkedSection(""); if (window.location.hash) window.history.replaceState(null, "", window.location.pathname+window.location.search); }} />}
    </BoardLayout>;
}
