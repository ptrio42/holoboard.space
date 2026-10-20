import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal, RANKING_SECTION } from "../components/PromoteModal/PromoteModal";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { WaitingSort } from "../components/BoardLayout/WaitingSort";
import { PixelLink, PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { StatusMessage } from "../components/ui/StatusMessage";
import { fetchCampaigns, type CampaignPage, type CampaignView, type WaitingEntry } from "../lib/campaigns";
import { useWaitingUpdates } from "../hooks/useWaitingUpdates";
import { ndk } from "../lib/ndk";
import { expandedNoteTexts } from "../lib/readingPosition";
import { navigateBoard } from "../lib/discussionNavigation";
import { WaitingRoomLocation } from "../components/BoardLayout/BoardNavigation";

interface BoardSnapshot {
    view: CampaignView;
    pages: number;
    data: CampaignPage<WaitingEntry>;
    notes: Record<string, { expanded: boolean; texts: string[] }>;
}
// Only the two public lists are retained. Payment and account state keep their owners.
const snapshots = new Map<string, BoardSnapshot>();

export default function Billboard({ pathname = window.location.pathname, search = window.location.search }: { pathname?: string; search?: string }) {
    const waiting = pathname === "/waiting";
    const boardKey = waiting ? "/waiting" : "/";
    const waitingHref = useContext(WaitingRoomLocation);
    const selectedView = new URLSearchParams(search).get("view");
    const view: CampaignView = waiting ? selectedView === "new" || selectedView === "hot" ? selectedView : "top" : "board";
    const [initialSnapshot] = useState(() => {
        const saved = snapshots.get(boardKey);
        return saved?.view === view ? saved : undefined;
    });
    const [renderedView, setRenderedView] = useState(view);
    const [pages, setPages] = useState(initialSnapshot?.pages ?? 1);
    const [data, setData] = useState<CampaignPage<WaitingEntry> | null>(initialSnapshot?.data ?? null);
    const [loading, setLoading] = useState(!initialSnapshot);
    const mainRef = useRef<HTMLElement>(null);
    const [error, setError] = useState("");
    const [nudge, setNudge] = useState(0);
    const [promotion, setPromotion] = useState<{ id: string; weight?: number } | null>(null);
    const [open, setOpen] = useState(false);
    const [linkedSection, setLinkedSection] = useState("");
    // Apply URL changes before painting, without starting a new waiting-room visit.
    if (renderedView !== view) {
        setRenderedView(view); setPages(1); setData(null); setLoading(true);
    }
    const refresh = useCallback(() => setNudge((value) => value+1), []);
    useEffect(() => {
        if (data) snapshots.set(boardKey, { view, pages, data, notes: initialSnapshot?.notes ?? {} });
    }, [boardKey, view, pages, data, initialSnapshot]);
    useLayoutEffect(() => {
        mainRef.current?.closest<HTMLElement>("[data-reading-surface]")?.style.removeProperty("--reading-tail");
    }, [view]);
    useLayoutEffect(() => {
        const main = mainRef.current;
        return () => {
            const saved = snapshots.get(boardKey);
            const rows = main?.querySelectorAll<HTMLElement>("[data-board-note]");
            if (!saved || !rows?.length) return;
            snapshots.set(boardKey, { ...saved, notes: Object.fromEntries([...rows].map(row => [row.dataset.boardNote!, {
                expanded: row.querySelector("[data-note-expanded]")?.getAttribute("data-note-expanded") === "true",
                texts: expandedNoteTexts(row),
            }])) });
        };
    }, [boardKey]);
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
                const results = await Promise.all(Array.from({ length: pages }, (_, index) => fetchCampaigns(view, index+1, request.signal, true)));
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
    const waitingPosts = data?.waitingPosts ?? Math.max(0, (data?.activePosts ?? 0) - 21);
    const chooseView = (next: CampaignView) => {
        if (next === view) return;
        window.history.replaceState(null, "", `/waiting?view=${next}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
    };
    return <BoardLayout newWaitingCount={updates.count} section={waiting ? "waiting" : "board"} onPromote={() => { setPromotion(null); setOpen(true); }}
        sectionControls={waiting && <WaitingSort view={view} onChoose={chooseView}
            onHelp={() => { setPromotion(null); setLinkedSection(RANKING_SECTION); setOpen(true); }} />}>
        <main ref={mainRef} id="board" tabIndex={-1} aria-label={waiting ? "Waiting room" : "TOP 21"} aria-busy={loading}>
            {waiting && updates.count > 0 && <p role="status" className="mb-4 text-xs text-neon-gold">{updates.count} new {updates.count === 1 ? "note" : "notes"} since your last visit.</p>}
            {error && <div role="alert" className="mb-5 space-y-3 border-2 border-neon-pink/40 p-4 text-xs text-neon-pink"><p>{error}</p><PixelButton size="sm" variant="ghost" onClick={refresh}>Try again</PixelButton></div>}
            {loading && !data && <StatusMessage loading>Loading notes...</StatusMessage>}
            {!loading && !error && events.length === 0 && <PixelPanel><StatusMessage><h2 className="font-pixel text-xs text-cyan-200/85">{waiting ? view === "hot" ? "No recent boosts here" : view === "new" ? "The waiting room is empty" : "No paid notes at these ranks" : "The board is empty"}</h2><p>{waiting ? view === "new" ? "New promotions and Holoboard discoveries appear here." : "Active paid notes outside the top 21 appear here." : "Promote a note to start its campaign."}</p>{waiting && view !== "new" && waitingPosts > 0 && <PixelLink href="/waiting?view=new" onClick={navigateBoard} variant="ghost">See New</PixelLink>}</StatusMessage></PixelPanel>}
            <ul className="space-y-4">{events.map((entry) => <BoardRow key={entry.id} initiallyExpanded={initialSnapshot?.notes[entry.id]?.expanded} initiallyExpandedTexts={initialSnapshot?.notes[entry.id]?.texts} isNew={waiting && newIds.has(entry.id)} event={entry.note} rank={entry.rank} sats={entry.satsPaid} weight={entry.weight} billboard={entry.billboard} showUnknownRank={entry.entryType !== "discovery"} discovery={entry.discovery} firstVisibleAt={view === "new" ? entry.firstVisibleAt : undefined} hotSats={view === "hot" ? entry.hotSats : undefined} firstPaidAt={view === "new" ? entry.firstPaidAt : undefined} onPromote={() => { setPromotion({ id: entry.id, weight: entry.weight }); setOpen(true); }} />)}</ul>
            {data?.hasMore && waiting && <div className="mt-6 flex justify-center"><PixelButton variant="ghost" disabled={loading} onClick={() => { setLoading(true); setPages((value) => value+1); }}>Load more</PixelButton></div>}
            {!waiting && waitingPosts > 0 && <div className="mt-6 flex justify-center"><PixelLink href={waitingHref} onClick={navigateBoard} variant="ghost" className="[&>span]:min-h-11">Waiting room ({waitingPosts})</PixelLink></div>}
        </main>
        {open && <PromoteModal initialReference={promotion?.id} currentWeight={promotion?.weight} rankingTargets={data?.targets ?? []} openSection={linkedSection} onPaid={refresh} onClose={() => { setOpen(false); setPromotion(null); setLinkedSection(""); if (window.location.hash) window.history.replaceState(null, "", window.location.pathname+window.location.search); }} />}
    </BoardLayout>;
}
