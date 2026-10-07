import { useMemo, useState } from "react";
import { ENABLE_DISCUSSIONS } from "../config";
import { useProfileRead } from "../hooks/useProfileRead";
import { useProfilePromotions } from "../hooks/useProfilePromotions";
import { useReadingRestore } from "../hooks/useReadingRestore";
import { nostrCache } from "../lib/nostrCache";
import { navigateReading } from "../lib/discussionNavigation";
import { readingBackLabel } from "../lib/readingRoutes";
import { formatSats, njumpUrl, shortNpub, toNpub } from "../lib/nostr";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
import { Avatar } from "../components/ui/Avatar";
import { PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { StatusMessage } from "../components/ui/StatusMessage";
import { Expandable } from "../components/ui/Expandable";
import { NoteExternalLink } from "../components/ui/NoteControls";
import { DiscussionLink } from "../components/ui/DiscussionLink";
import TextRenderer from "../components/TextRenderer/TextRenderer";

export default function Profile({ pubkey, hints, from }: { pubkey: string; hints: string[]; from: string }) {
    const { snapshot, error, refresh } = useProfileRead(pubkey, hints);
    const promotions = useProfilePromotions(pubkey);
    const [promote, setPromote] = useState(false);
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const copyKey = async () => {
        try { await navigator.clipboard.writeText(toNpub(pubkey)); setCopyState("copied"); }
        catch { setCopyState("failed"); }
    };
    const [page, setPage] = useState(0);
    const profile = snapshot?.profile;
    const name = profile?.displayName || profile?.name || shortNpub(pubkey);
    const bodies = useMemo(() => new Map(nostrCache.query({ ids: promotions.snapshot?.entries.map(entry => entry.id) ?? [] }).map(event => [event.id, event])), [promotions.snapshot]);
    const contentVersion = useMemo(() => ({ snapshot, promotions: promotions.snapshot }), [snapshot, promotions.snapshot]);
    useReadingRestore(contentVersion);
    const entries = promotions.snapshot?.entries ?? [];
    const visible = entries.slice(page * 21, (page + 1) * 21);
    return <BoardLayout section="profile" onPromote={() => setPromote(true)}>
        <main id="profile" tabIndex={-1}>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <a href={from} onClick={navigateReading} className="note-action inline-flex min-h-11 items-center">{readingBackLabel(from)}</a>
                <h2 className="font-pixel text-xs text-neon-cyan">Profile</h2>
            </div>
            <PixelPanel accent="#22d3ee">
                <section aria-label="Author profile" className="space-y-4 p-4 sm:p-5">
                    <header className="flex items-start gap-4">
                        <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={64} />
                        <div className="min-w-0 flex-1"><h3 className="break-words font-pixel text-xs leading-6 text-neon-cyan">{name}</h3>
                            {profile?.displayName && profile.name && profile.displayName !== profile.name && <p className="mt-1 break-words text-sm text-cyan-100/75">@{profile.name}</p>}
                        </div>
                    </header>
                    <p className="break-all text-xs text-cyan-100/75" aria-label="Nostr public key">{toNpub(pubkey)}</p>
                    {profile?.about && <p className="whitespace-pre-wrap break-words text-sm text-cyan-50/90">{profile.about}</p>}
                    {profile?.website && <a href={profile.website} target="_blank" rel="noopener noreferrer nofollow" className="focus-pixel inline-block min-h-11 max-w-full break-all text-sm text-neon-cyan">{profile.website}</a>}
                    {profile?.nip05 && <p className="break-words text-xs text-cyan-100/75">Claimed address (unverified): {profile.nip05}</p>}
                    <div className="note-footer flex-wrap gap-x-5">
                        <button type="button" className="note-action min-h-11" onClick={() => void copyKey()}>Copy npub</button>
                        <a href={njumpUrl(pubkey)} target="_blank" rel="noopener noreferrer" className="note-action inline-flex min-h-11 items-center">Open elsewhere</a>
                    </div>
                    {copyState !== "idle" && <p role="status" className="text-xs text-neon-cyan">{copyState === "copied" ? "Public key copied." : "Clipboard is unavailable. Select the public key above to copy it."}</p>}
                </section>
            </PixelPanel>
            <section aria-label="Profile coverage" data-read-state={snapshot?.state ?? (error ? "error" : "loading")} className="my-5 space-y-2 text-xs text-cyan-100/75">
                <StatusMessage compact loading={!error && (!snapshot || snapshot.state === "loading")}>
                    {error ? "Could not open this profile. Try again." : !snapshot || snapshot.state === "loading" ? profile ? "Showing saved profile while checking relays..." : "Looking for profile data..." : snapshot.malformed ? "The latest found profile contains unreadable metadata." : snapshot.state === "partial" ? profile ? "Profile found. Some sources could not be checked." : "Profile not found yet. Some sources could not be checked." : profile ? "Checked selected profile sources." : "No profile found on checked sources. Other relays may have one."}
                </StatusMessage>
                {snapshot?.cached && <p>Saved profile data is shown. It may be outdated.</p>}
                {snapshot?.limited && <p>Profile reading limits were reached.</p>}
                {snapshot?.checkedAt && <p>Sources checked at {new Date(snapshot.checkedAt).toLocaleTimeString()}.</p>}
                <details><summary className="focus-pixel inline-flex min-h-11 cursor-pointer items-center">Profile source details</summary>
                    {snapshot?.cachedRouting && <p>Author relay list: cached.</p>}
                    {Object.entries(snapshot?.routing ?? {}).map(([relay, outcome]) => <p className="break-all" key={`routing:${relay}`}>Relay discovery: {relay}: {outcome}</p>)}
                    {Object.entries(snapshot?.relays ?? {}).map(([relay, outcome]) => <p className="break-all" key={relay}>{relay}: {outcome}</p>)}
                </details>
                <PixelButton variant="ghost" disabled={snapshot?.state === "loading"} onClick={refresh}>Refresh profile</PixelButton>
            </section>
            <section aria-label="Active promoted notes" className="mt-8">
                <h3 className="mb-3 font-pixel text-xs text-neon-gold">Active promoted notes ({entries.length} found)</h3>
                <p className="mb-4 text-xs text-cyan-100/75">Notes by this author currently promoted on Holoboard, ordered by board rank. Promotion may have been paid by someone else.</p>
                <ul className="space-y-4">{visible.map(entry => {
                    const event = bodies.get(entry.id);
                    return <li key={entry.id}><PixelPanel accent="#fbbf24"><article className="space-y-3 p-4" data-profile-note={entry.id}>
                        <header className="flex flex-wrap justify-between gap-3 text-xs text-cyan-100/75"><span className="font-pixel text-[10px] text-neon-gold">Rank {entry.rank}</span><span>{formatSats(entry.weight)} sats counting</span></header>
                        {event ? <Expandable label="promoted note" footer={control => <div className="note-footer flex-wrap">{control}<div className="ml-auto flex flex-wrap items-center gap-x-4">{ENABLE_DISCUSSIONS && <DiscussionLink id={event.id} author={event.pubkey} seed={event} />}<NoteExternalLink href={njumpUrl(event.id, "note")} /></div></div>}>
                            <TextRenderer text={event.content} tags={event.tags} ownId={event.id} embedQuotes={false} previewLinks={false} />
                        </Expandable> : <><p className="text-sm text-cyan-100/75">Content is unavailable in the read cache.</p><NoteExternalLink href={njumpUrl(entry.id, "note")} /></>}
                    </article></PixelPanel></li>;
                })}</ul>
                {entries.length > 21 && <div className="mt-4 flex flex-wrap items-center gap-4"><PixelButton variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous notes</PixelButton><span className="text-xs text-cyan-100/75">Page {page + 1} of {Math.ceil(entries.length / 21)}</span><PixelButton variant="ghost" disabled={(page + 1) * 21 >= entries.length} onClick={() => setPage(value => value + 1)}>Next notes</PixelButton></div>}
                <div className="mt-4 space-y-3 text-xs text-cyan-100/75" aria-label="Promotion coverage">
                    {promotions.snapshot?.loading && <StatusMessage compact loading>Checking active promotions...</StatusMessage>}
                    {promotions.snapshot && !promotions.snapshot.loading && entries.length === 0 && <p>No active promotions found in the checked pages.</p>}
                    {promotions.snapshot && <p>Checked {promotions.snapshot.pages} campaign pages ({promotions.snapshot.scanned} entries). {promotions.snapshot.hasMore ? "More pages remain unchecked." : "Reached the end of the selected campaign pages."} Expired promotions are not included.</p>}
                    {promotions.snapshot?.error && <p role="alert">Could not check the next campaign page. Found notes remain available.</p>}
                    {promotions.snapshot?.limited && <p>Promotion reading limits were reached. Some notes may be missing.</p>}
                    {promotions.snapshot?.hasMore && !promotions.snapshot.limited && <PixelButton variant="ghost" disabled={promotions.snapshot.loading} onClick={promotions.loadMore}>{promotions.snapshot.error ? "Retry promotions" : "Load more promotions"}</PixelButton>}
                </div>
            </section>
        </main>
        {promote && <PromoteModal onClose={() => setPromote(false)} />}
    </BoardLayout>;
}
