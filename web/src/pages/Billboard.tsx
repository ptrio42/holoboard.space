import { useCallback, useEffect, useMemo, useState } from "react";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal, RANKING_SECTION } from "../components/PromoteModal/PromoteModal";
import { PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { fetchCampaigns, type CampaignPage, type CampaignView } from "../lib/campaigns";
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
    const events = useMemo(() => data?.entries.map((entry) => ({ ...entry, note: new NDKEvent(ndk, entry.event) })) ?? [], [data]);
    const chooseView = (next: CampaignView) => {
        if (next === view) return;
        setView(next); setPages(1); setData(null); setLoading(true);
        window.history.replaceState(null, "", `/waiting?view=${next}`);
    };
    return <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6">
        <a href="#board" className="skip-link pixel-frame focus-pixel border-2 border-neon-gold bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">Skip to notes</a>
        <header className="mb-4">
            <div className="grid grid-cols-1 justify-items-center gap-y-2 text-center md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:justify-items-start md:gap-x-6 md:gap-y-3 md:text-left">
                <h1 className="font-pixel text-xl leading-tight tracking-widest text-neon-pink [text-shadow:0_0_18px_rgba(236,72,153,0.55)] md:text-2xl">HOLOBOARD</h1>
                <p className="max-w-xl text-xs leading-relaxed text-cyan-200/70 sm:text-sm md:col-span-2">{waiting ? "Paid notes below the top 21. Boost a note to move it up." : "Top 21 paid notes. Recent boosts carry more weight."}</p>
                <PixelButton variant="accent" className="md:col-start-2 md:row-start-1 md:justify-self-end" onClick={() => { setPromotion(null); setOpen(true); }}>Promote a note</PixelButton>
            </div>
            <div className="mt-2 space-y-1 text-center md:text-left">
                <nav aria-label="Board sections" className="flex flex-wrap justify-center gap-x-4 font-pixel text-[10px] text-cyan-200/80 md:justify-start">
                    <a href="/" aria-current={!waiting ? "page" : undefined} className={`focus-pixel inline-flex min-h-11 items-center border-b-2 ${!waiting ? "border-neon-gold text-neon-gold" : "border-transparent hover:text-neon-cyan"}`}>Top 21</a>
                    <a href="/waiting" aria-current={waiting ? "page" : undefined} className={`focus-pixel inline-flex min-h-11 items-center border-b-2 ${waiting ? "border-neon-gold text-neon-gold" : "border-transparent hover:text-neon-cyan"}`}>Waiting room</a>
                    <a href="/expired" className="focus-pixel inline-flex min-h-11 items-center border-b-2 border-transparent hover:text-neon-cyan">Expired</a>
                </nav>
                {waiting && <div className="flex flex-col gap-1 md:flex-row md:flex-wrap md:items-center md:gap-x-4">
                    <div role="group" aria-label="Waiting room sort" aria-describedby="waiting-room-sort-description" className="board-sort flex flex-wrap items-center justify-center gap-2 md:justify-start">
                        <span className="mr-1 text-xs text-cyan-200/70">Sort</span>
                        {(["top", "new", "hot"] as const).map((sort) => <PixelButton key={sort} size="sm" variant="ghost" aria-pressed={view === sort} onClick={() => chooseView(sort)}>{sort === "top" ? "Rank" : sort === "new" ? "New" : "Hot"}</PixelButton>)}
                    </div>
                    <p id="waiting-room-sort-description" className="text-xs text-cyan-100/60">{view === "top" ? "By ranking weight · positions 22+" : view === "new" ? "By first promotion. Boosts do not reset the order." : "By visibility sats in the last 24 hours."}</p>
                </div>}
            </div>
        </header>
        <main id="board" tabIndex={-1} aria-busy={loading}>
            {error && <div role="alert" className="mb-5 space-y-3 border-2 border-neon-pink/40 p-4 text-xs text-neon-pink"><p>{error}</p><PixelButton size="sm" variant="ghost" onClick={refresh}>Try again</PixelButton></div>}
            {loading && !data && <p role="status" className="py-8 text-center font-pixel text-[10px] text-cyan-300/60">Loading notes...</p>}
            {!loading && !error && events.length === 0 && <PixelPanel><div className="space-y-3 p-6 text-center"><h2 className="font-pixel text-xs text-cyan-200/70">{waiting ? view === "hot" ? "No recent boosts here" : "The waiting room is empty" : "The board is empty"}</h2><p className="text-sm text-cyan-100/60">{waiting ? "Active notes outside the top 21 appear here." : "Promote a note to start its campaign."}</p></div></PixelPanel>}
            <ul className="space-y-4">{events.map((entry) => <BoardRow key={entry.id} event={entry.note} rank={entry.rank} sats={entry.satsPaid} weight={entry.weight} billboard={entry.billboard} hotSats={view === "hot" ? entry.hotSats : undefined} firstPaidAt={view === "new" ? entry.firstPaidAt : undefined} onPromote={() => { setPromotion({ id: entry.id, weight: entry.weight }); setOpen(true); }} />)}</ul>
            {data?.hasMore && waiting && <div className="mt-6 flex justify-center"><PixelButton variant="ghost" disabled={loading} onClick={() => { setLoading(true); setPages((value) => value+1); }}>Load more</PixelButton></div>}
            {!waiting && data && data.activePosts > 21 && <p className="mt-6 text-center text-xs text-cyan-100/60"><a href="/waiting" className="focus-pixel inline-flex min-h-11 items-center text-neon-cyan">Discover {data.activePosts-21} more paid notes in the waiting room &gt;</a></p>}
        </main>
        <footer className="mt-12 border-t-2 border-cyan-400/15 pt-6 text-center text-xs text-cyan-100/50"><div className="flex flex-wrap justify-center gap-6"><a href={`/help#${RANKING_SECTION}`} className="focus-pixel inline-flex min-h-11 items-center">How ranking works</a><a href="/help#other-ways-to-promote" className="focus-pixel inline-flex min-h-11 items-center">Other ways to promote</a><a href="https://github.com/ptrio42/holoboard.space" target="_blank" rel="noopener noreferrer" className="focus-pixel inline-flex min-h-11 items-center">GitHub</a></div><p>Only paid visibility affects rank. Each payment loses half its weight every 30 days.</p></footer>
        {open && <PromoteModal initialReference={promotion?.id} currentWeight={promotion?.weight} rankingTargets={data?.targets ?? []} openSection={linkedSection} onPaid={refresh} onClose={() => { setOpen(false); setPromotion(null); setLinkedSection(""); if (window.location.hash) window.history.replaceState(null, "", window.location.pathname+window.location.search); }} />}
    </div>;
}
