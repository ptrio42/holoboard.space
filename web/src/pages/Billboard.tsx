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
        setView(next); setPages(1); setData(null); setLoading(true);
        window.history.replaceState(null, "", `/waiting?view=${next}`);
    };
    return <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6">
        <a href="#board" className="skip-link pixel-frame focus-pixel border-2 border-neon-gold bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">Skip to notes</a>
        <header className="mb-8 space-y-6 text-center">
            <h1 className="font-pixel text-2xl leading-tight tracking-widest text-neon-pink [text-shadow:0_0_18px_rgba(236,72,153,0.55)] sm:text-4xl">HOLOBOARD</h1>
            <p className="mx-auto max-w-xl text-xs leading-relaxed text-cyan-200/70 sm:text-sm">{waiting ? "Paid notes outside the top 21. Support the author and boost visibility to help a note reach the main board." : "The top 21 paid notes. Recent visibility sats count for more. Anyone can support an author and boost a note."}</p>
            <nav aria-label="Board sections" className="flex flex-wrap justify-center gap-5 font-pixel text-[10px] text-cyan-300/60">
                <a href="/" aria-current={!waiting ? "page" : undefined} className={`focus-pixel inline-flex min-h-11 items-center ${!waiting ? "text-neon-gold" : ""}`}>Top 21</a>
                <a href="/waiting" aria-current={waiting ? "page" : undefined} className={`focus-pixel inline-flex min-h-11 items-center ${waiting ? "text-neon-gold" : ""}`}>Waiting room</a>
                <a href="/expired" className="focus-pixel inline-flex min-h-11 items-center">Expired</a>
            </nav>
            <PixelButton variant="accent" onClick={() => { setPromotion(null); setOpen(true); }}>Promote a note</PixelButton>
        </header>
        <main id="board" tabIndex={-1} aria-busy={loading}>
            {waiting && <div className="mb-6 space-y-3">
                <div role="group" aria-label="Waiting room sort" className="flex flex-wrap gap-2">
                    {(["top", "new", "hot"] as const).map((sort) => <PixelButton key={sort} size="sm" variant={view === sort ? "accent" : "ghost"} aria-pressed={view === sort} onClick={() => chooseView(sort)}>{sort === "top" ? "Top" : sort === "new" ? "New" : "Hot"}</PixelButton>)}
                </div>
                <p className="text-xs text-cyan-100/60">{view === "top" ? "Ordered by current ranking weight. Rank numbers continue from 22." : view === "new" ? "Ordered by first promotion on Holoboard. Boosts do not refresh this order." : "Ordered by visibility sats paid in the last 24 hours. Author tips and appearance fees do not count."}</p>
            </div>}
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
