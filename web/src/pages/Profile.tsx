import { useMemo, useState } from "react";
import { RELAY_URL } from "../config";
import { useProfileRead } from "../hooks/useProfileRead";
import { useProfilePromotions } from "../hooks/useProfilePromotions";
import { nostrCache } from "../lib/nostrCache";
import { navigateReading } from "../lib/discussionNavigation";
import { readingBackLabel } from "../lib/readingRoutes";
import { formatSats, njumpUrl } from "../lib/nostr";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
import { ProfileIdentity } from "../components/Profile/ProfileIdentity";
import { PixelButton } from "../components/ui/PixelButton";
import { StatusMessage } from "../components/ui/StatusMessage";
import { NoteExternalLink } from "../components/ui/NoteControls";
import { NoteCard } from "../components/BoardRow/NoteCard";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { ndk } from "../lib/ndk";
import "./Profile.css";

export default function Profile({ pubkey, hints, from }: { pubkey: string; hints: string[]; from: string }) {
    const { snapshot, error, refresh } = useProfileRead(pubkey, hints);
    const promotions = useProfilePromotions(pubkey);
    const [promote, setPromote] = useState(false);
    const [promotion, setPromotion] = useState<{ id: string; weight: number }>();
    const [page, setPage] = useState(0);
    const bodies = useMemo(() => new Map(nostrCache.query({ ids: promotions.snapshot?.entries.map(entry => entry.id) ?? [] }).map(event => [event.id, new NDKEvent(ndk, event)])), [promotions.snapshot]);
    const entries = promotions.snapshot?.entries ?? [];
    const visible = entries.slice(page * 21, (page + 1) * 21);
    return <BoardLayout section="profile" onPromote={() => { setPromotion(undefined); setPromote(true); }}>
        <main id="profile" tabIndex={-1}>
            <div className="profile-page-context"><a href={from} onClick={navigateReading} className="note-action">{readingBackLabel(from)}</a><h2>Profile</h2></div>
            <div className="profile-composition">
                <ProfileIdentity key={pubkey} pubkey={pubkey} hints={hints} snapshot={snapshot} error={error} onRefresh={refresh} />
                <section aria-label="Active promoted notes" className="profile-promotions">
                    <header className="profile-list-heading"><h3>Promoted notes</h3><span>{entries.length} found</span></header>
                    <p className="profile-list-subtitle">Active on Holoboard, ordered by board rank.</p>
                    <ul className="profile-note-list">{visible.map(entry => {
                        const event = bodies.get(entry.id);
                        return <li key={entry.id} data-profile-note={entry.id}>
                            {event ? <NoteCard event={event} rank={entry.rank} sats={entry.satsPaid} weight={entry.weight}
                                onPromote={() => { setPromotion({ id: entry.id, weight: entry.weight }); setPromote(true); }} />
                                : <article className="profile-promoted-note"><p className="mb-2 font-pixel text-[10px] text-neon-gold">Rank {entry.rank}</p>
                                    <p className="mb-3 text-xs text-cyan-100/75">{formatSats(entry.weight)} sats counting, {formatSats(entry.satsPaid)} sats paid in total</p><StatusMessage compact>Content is unavailable in the read cache.</StatusMessage><NoteExternalLink href={njumpUrl(entry.id, "note", [RELAY_URL], pubkey)} /></article>}
                        </li>;
                    })}</ul>
                    {entries.length > 21 && <div className="profile-pagination"><PixelButton variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous notes</PixelButton><span>Page {page + 1} of {Math.ceil(entries.length / 21)}</span><PixelButton variant="ghost" disabled={(page + 1) * 21 >= entries.length} onClick={() => setPage(value => value + 1)}>Next notes</PixelButton></div>}
                    <div className="profile-promotion-coverage" aria-label="Promotion coverage">
                        {promotions.snapshot?.loading && <StatusMessage compact loading>Checking active promotions...</StatusMessage>}
                        {promotions.snapshot && !promotions.snapshot.loading && entries.length === 0 && <StatusMessage compact>No active promotions found in the checked pages.</StatusMessage>}
                        {promotions.snapshot?.hasMore && <p>More pages may contain notes by this author.</p>}
                        {promotions.snapshot && <details className="profile-details"><summary className="focus-pixel">Promotion details</summary><div className="profile-detail-body"><p>{promotions.snapshot.scanned} campaigns checked. {promotions.snapshot.hasMore ? "More pages may contain notes by this author." : "Reached the end of the active campaign pages."}</p><p>Checked {promotions.snapshot.pages} campaign pages. Expired promotions are not included.</p><p>Promotion may have been paid by someone else. These results cover checked campaign pages, not this author's complete Nostr feed.</p></div></details>}
                        {promotions.snapshot?.error && <p role="alert">Could not check the next campaign page. Found notes remain available.</p>}
                        {promotions.snapshot?.limited && <p>Promotion reading limits were reached. Some notes may be missing.</p>}
                        {promotions.snapshot?.hasMore && !promotions.snapshot.limited && <PixelButton variant="ghost" disabled={promotions.snapshot.loading} onClick={promotions.loadMore}>{promotions.snapshot.error ? "Retry promotions" : "Load more promotions"}</PixelButton>}
                    </div>
                </section>
            </div>
        </main>
        {promote && <PromoteModal initialReference={promotion?.id} currentWeight={promotion?.weight} onPaid={() => { setPage(0); promotions.refresh(); }} onClose={() => setPromote(false)} />}
    </BoardLayout>;
}
