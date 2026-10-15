import { useRef, useState } from "react";
import { useNip05Verification } from "../../hooks/useNip05Verification";
import { profileRelayHints, type ProfileSnapshot } from "../../lib/profileReads";
import { njumpUrl, shortNpub, toNpub } from "../../lib/nostr";
import { Avatar } from "../ui/Avatar";
import { PixelButton } from "../ui/PixelButton";
import { StatusMessage } from "../ui/StatusMessage";

export function ProfileIdentity({ pubkey, hints, snapshot, error, onRefresh }: {
    pubkey: string; hints: string[]; snapshot: ProfileSnapshot | null; error: boolean; onRefresh: () => void;
}) {
    const profile = snapshot?.profile;
    const name = profile?.displayName || profile?.name || shortNpub(pubkey);
    const nip05 = useNip05Verification(pubkey, profile?.nip05);
    const [brokenBanner, setBrokenBanner] = useState<string>();
    const [copy, setCopy] = useState<{ kind: "npub" | "lightning"; state: "copied" | "failed" }>();
    const details = useRef<HTMLDetailsElement>(null);
    const keyText = useRef<HTMLParagraphElement>(null);
    const banner = profile?.banner && profile.banner !== brokenBanner ? profile.banner : undefined;
    const lightning = profile?.lud16 || profile?.lud06;
    const copyValue = async (kind: "npub" | "lightning", value: string) => {
        try { await navigator.clipboard.writeText(value); setCopy({ kind, state: "copied" }); }
        catch {
            setCopy({ kind, state: "failed" });
            if (kind === "npub" && details.current) { details.current.open = true; keyText.current?.focus(); }
        }
    };
    const loading = !error && (!snapshot || snapshot.state === "loading");
    const coverageText = error ? "Could not open this profile. Try again." : loading ? profile ? "Showing saved profile while checking relays..." : "Looking for profile data..." : snapshot?.malformed ? "The latest found profile contains unreadable metadata." : snapshot?.state === "partial" ? profile ? "Profile found. Some sources could not be checked." : "Profile not found yet. Some sources could not be checked." : profile ? "Checked selected profile sources." : "No profile found on checked sources. Other relays may have one.";
    const showNotice = loading || error || snapshot?.malformed || snapshot?.state === "partial" || !profile || snapshot?.cached || snapshot?.limited;
    const nipStatus = { verified: "NIP-05 address matches this public key", checking: "Checking address...", unavailable: "Could not check address", mismatch: "Address does not match this key", invalid: "Invalid NIP-05 address" };
    return <section aria-label="Author profile" className={`profile-identity${banner ? " has-banner" : ""}`}>
        {banner && <div className="profile-banner"><img src={banner} alt="Profile banner" onError={() => setBrokenBanner(banner)} /></div>}
        <header className="profile-person">
            <span className="profile-avatar"><Avatar pubkey={pubkey} src={profile?.picture} name={name} size={72} /></span>
            <div className="profile-name-group"><h3 className="profile-name">{name}</h3>
                {profile?.displayName && profile.name && profile.displayName !== profile.name && <p className="profile-handle">@{profile.name}</p>}
                {profile?.nip05 && nip05.state && <div className={`profile-nip05 is-${nip05.state}`} data-nip05-state={nip05.state}>
                    <div className="profile-nip05-address"><span>{profile.nip05.startsWith("_@") ? profile.nip05.slice(2) : profile.nip05}</span>
                        {nip05.state === "verified" && <svg role="img" aria-label="NIP-05 address matches this public key" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shapeRendering="crispEdges"><path d="M12 2h2v2h-2v2h-2v2H8v2H6v2H4v-2H2V8H0V6h2v2h2v2h2V8h2V6h2V4h2z" /></svg>}
                    </div>
                    <div className={nip05.state === "verified" ? "sr-only" : "profile-nip05-feedback"}>
                        <span className="profile-nip05-status" role="status">{nipStatus[nip05.state]}</span>
                        {nip05.state === "unavailable" && <button type="button" className="profile-copy profile-nip05-retry focus-pixel" aria-label="Retry address check" title="Retry address check" onClick={nip05.retry}>
                            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shapeRendering="crispEdges"><path d="M4 0h6v2H4zM2 2h2v2H2zM10 2h2v4h2v2H8V2h2zM0 6h6v6H4v-2H2V8H0zM10 10h2v2h-2zM4 12h6v2H4z" /></svg>
                        </button>}
                    </div>
                </div>}
            </div>
        </header>
        <div className="profile-about">{profile?.about && <p>{profile.about}</p>}
            {profile?.website && <a className="profile-website focus-pixel" href={profile.website} target="_blank" rel="noopener noreferrer nofollow">{profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>}
        </div>
        {lightning && <section className="profile-lightning" aria-label="Lightning address">
            <div className="profile-lightning-label"><svg aria-hidden="true" width="12" height="16" viewBox="0 0 12 16" fill="currentColor" shapeRendering="crispEdges"><path d="M6 0h4L6 6h6L4 16l2-8H0z" /></svg><span>{profile?.lud16 ? "Lightning" : "Lightning LNURL"}</span></div>
            <div className="profile-lightning-row"><span className="profile-lightning-address">{lightning}</span><button type="button" className="profile-copy focus-pixel" aria-label="Copy Lightning address" title="Copy Lightning address" onClick={() => void copyValue("lightning", lightning)}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" shapeRendering="crispEdges"><path d="M0 0h10v2H2v8H0zM4 4h10v10H4zm2 2v6h6V6z" fillRule="evenodd" /></svg></button></div>
            {copy?.kind === "lightning" && <p className="profile-copy-status" role="status">{copy.state === "copied" ? "Lightning address copied." : "Clipboard unavailable. Select the address to copy it."}</p>}
        </section>}
        <section aria-label="Profile coverage" data-read-state={snapshot?.state ?? (error ? "error" : "loading")} className="profile-coverage">
            {showNotice && <div className="profile-data-notice"><StatusMessage compact loading={loading}>{coverageText}</StatusMessage>
                {snapshot?.cached && !loading && <p>Saved profile data may be outdated.</p>}{snapshot?.limited && <p>Profile reading limits were reached.</p>}
            </div>}
            <details ref={details} className="profile-details"><summary className="focus-pixel">Profile details</summary><div className="profile-detail-body">
                <p className="profile-detail-label">Public key</p><p ref={keyText} tabIndex={-1} className="profile-full-key focus-pixel" aria-label="Nostr public key">{toNpub(pubkey)}</p>
                <div className="profile-tools"><button type="button" className="note-action" onClick={() => void copyValue("npub", toNpub(pubkey))}>Copy npub</button><a className="note-action" href={njumpUrl(pubkey, "npub", [...hints, ...profileRelayHints(pubkey)])} target="_blank" rel="noopener noreferrer">Open elsewhere</a></div>
                {copy?.kind === "npub" && <p className="profile-copy-status" role="status">{copy.state === "copied" ? "Public key copied." : "Clipboard is unavailable. Select the public key below to copy it."}</p>}
                {profile?.nip05 && <><p>NIP-05 declared in the profile: {profile.nip05}</p><p>Address verification checks whether the domain lists this public key. It does not verify the person's identity.</p>{nip05.checkedAt && <p>Address checked at <time dateTime={new Date(nip05.checkedAt).toISOString()}>{new Date(nip05.checkedAt).toLocaleTimeString()}</time>.</p>}</>}
                {!showNotice && <p>{coverageText}</p>}{snapshot?.checkedAt && <p>Sources checked at {new Date(snapshot.checkedAt).toLocaleTimeString()}.</p>}
                {snapshot?.cachedRouting && <p>Author relay list: cached.</p>}
                {Object.entries(snapshot?.routing ?? {}).map(([relay, outcome]) => <p key={`routing:${relay}`}>Relay discovery: {relay}: {outcome}</p>)}
                {Object.entries(snapshot?.relays ?? {}).map(([relay, outcome]) => <p key={relay}>{relay}: {outcome}</p>)}
                <PixelButton variant="ghost" disabled={loading} onClick={() => { onRefresh(); nip05.retry(); }}>Refresh profile</PixelButton>
            </div></details>
        </section>
    </section>;
}
