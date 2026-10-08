import { useMemo, useState } from "react";
import { ENABLE_DISCUSSIONS, RELAY_URL } from "../config";
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
import { DiscussionLink } from "../components/ui/DiscussionLink";
import { NoteContent } from "../components/TextRenderer/NoteContent";
import "./Profile.css";

export default function Profile({ pubkey, hints, from }: { pubkey: string; hints: string[]; from: string }) {
    const { snapshot, error, refresh } = useProfileRead(pubkey, hints);
    const promotions = useProfilePromotions(pubkey);
    const [promote, setPromote] = useState(false);
    const [page, setPage] = useState(0);
    const bodies = useMemo(() => new Map(nostrCache.query({ ids: promotions.snapshot?.entries.map(entry => entry.id) ?? [] }).map(event => [event.id, event])), [promotions.snapshot]);
    const entries = promotions.snapshot?.entries ?? [];
    const visible = entries.slice(page * 21, (page + 1) * 21);
    return <BoardLayout section="profile" onPromote={() => setPromote(true)}>
        <main id="profile" tabIndex={-1}>
            <div className="profile-page-context"><a href={from} onClick={navigateReading} className="note-action">{readingBackLabel(from)}</a><h2>Profile</h2></div>
            <div className="profile-composition">
                <ProfileIdentity key={pubkey} pubkey={pubkey} hints={hints} snapshot={snapshot} error={error} onRefresh={refresh} />
                <section aria-label="Active promoted notes" className="profile-promotions">
                    <header className="profile-list-heading"><h3>Promoted notes</h3><span>{entries.length} found</span></header>
                    <p className="profile-list-subtitle">Active on Holoboard, ordered by board rank.</p>
                    <ul className="profile-note-list">{visible.map(entry => {
                        const event = bodies.get(entry.id);
                        return <li key={entry.id}><article className="profile-promoted-note" data-profile-note={entry.id}>
                            <header className="profile-note-metadata"><span className="profile-note-rank">Rank {entry.rank}</span><span aria-label={`${formatSats(entry.weight)} sats counting`}>{formatSats(entry.weight)} sats</span></header>
                            {event ? <><NoteContent text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} />
                                <div className="note-footer">{ENABLE_DISCUSSIONS && <DiscussionLink id={event.id} author={event.pubkey} hints={[RELAY_URL]} seed={event} />}<NoteExternalLink href={njumpUrl(event.id, "note", [RELAY_URL], event.pubkey)} /></div>
                            </> : <><StatusMessage compact>Content is unavailable in the read cache.</StatusMessage><NoteExternalLink href={njumpUrl(entry.id, "note", [RELAY_URL], pubkey)} /></>}
                        </article></li>;
                    })}</ul>
                    {entries.length > 21 && <div className="profile-pagination"><PixelButton variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous notes</PixelButton><span>Page {page + 1} of {Math.ceil(entries.length / 21)}</span><PixelButton variant="ghost" disabled={(page + 1) * 21 >= entries.length} onClick={() => setPage(value => value + 1)}>Next notes</PixelButton></div>}
                    <div className="profile-promotion-coverage" aria-label="Promotion coverage">
                        {promotions.snapshot?.loading && <StatusMessage compact loading>Checking active promotions...</StatusMessage>}
                        {promotions.snapshot && !promotions.snapshot.loading && entries.length === 0 && <StatusMessage compact>No active promotions found in the checked pages.</StatusMessage>}
                        {promotions.snapshot && <><p>{promotions.snapshot.scanned} campaigns checked. {promotions.snapshot.hasMore ? "More pages may contain notes by this author." : "Reached the end of the active campaign pages."}</p><details className="profile-details"><summary className="focus-pixel">Promotion details</summary><div className="profile-detail-body"><p>Checked {promotions.snapshot.pages} campaign pages. Expired promotions are not included.</p><p>Promotion may have been paid by someone else. These results cover checked campaign pages, not this author's complete Nostr feed.</p></div></details></>}
                        {promotions.snapshot?.error && <p role="alert">Could not check the next campaign page. Found notes remain available.</p>}
                        {promotions.snapshot?.limited && <p>Promotion reading limits were reached. Some notes may be missing.</p>}
                        {promotions.snapshot?.hasMore && !promotions.snapshot.limited && <PixelButton variant="ghost" disabled={promotions.snapshot.loading} onClick={promotions.loadMore}>{promotions.snapshot.error ? "Retry promotions" : "Load more promotions"}</PixelButton>}
                    </div>
                </section>
            </div>
        </main>
        {promote && <PromoteModal onClose={() => setPromote(false)} />}
    </BoardLayout>;
}
