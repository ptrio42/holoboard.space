import { useId, useRef, useState, type Ref } from "react";
import { ENABLE_NOSTR_CONNECT, ENABLE_PROFILES } from "../../config";
import { useConnections } from "../../hooks/useConnections";
import { useProfileValue } from "../../hooks/useProfile";
import { shortNpub } from "../../lib/nostr";
import { disconnectSigner } from "../../lib/connections";
import { navigateReading } from "../../lib/discussionNavigation";
import { profileHref, profileRoute } from "../../lib/readingRoutes";
import { AccountIcon } from "../ui/AccountIcon";
import { Avatar } from "../ui/Avatar";
import { Modal } from "../ui/Modal";
import { NotePopover } from "../ui/NotePopover";
import { ConnectionSettings } from "./ConnectionSettings";
import { WalletIcon } from "../ui/WalletIcon";

function ConnectedAccount({ pubkey, buttonRef, onSettings, onDisconnect }: { pubkey: string; buttonRef: Ref<HTMLButtonElement>; onSettings: () => void; onDisconnect: () => void }) {
    const profile = useProfileValue(pubkey);
    const name = profile?.displayName?.trim() || profile?.name?.trim() || "Account";
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    const menuId = useId();
    const close = (restoreFocus = true) => {
        if (restoreFocus) anchor?.focus({ preventScroll: true });
        setAnchor(null);
    };
    const current = window.location.pathname + window.location.search;
    return <>
        <button ref={buttonRef} type="button" className="header-tool header-account" aria-label={`Account: ${name}`} title={`Account: ${name}`}
            aria-haspopup="menu" aria-controls={menuId} aria-expanded={!!anchor}
            onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
            <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={24} />
            <span className="header-tool__label">{name}</span>
        </button>
        {anchor && <NotePopover id={menuId} anchor={anchor} title="Account" menu onClose={close}>
            <div className="header-account-summary">
                <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={32} />
                <div><p>{name}</p><span>{shortNpub(pubkey)}</span></div>
            </div>
            <div role="menu" aria-label="Account" className="note-menu">
                {ENABLE_PROFILES && <a role="menuitem" href={profileHref(pubkey, profileRoute(current)?.from ?? current)} onClick={navigateReading}>Your profile</a>}
                <button type="button" role="menuitem" onClick={() => { close(false); onSettings(); }}>Connection settings</button>
                <button type="button" role="menuitem" onClick={() => { close(false); onDisconnect(); }}>Disconnect</button>
            </div>
        </NotePopover>}
    </>;
}

/** Connections belong to the client and can also be opened inside a payment. */
export function ConnectionControls({ className = "mx-auto max-w-5xl justify-end px-4 py-2 sm:px-6" }: { className?: string }) {
    const connections = useConnections();
    const [section, setSection] = useState<"wallet" | "signer" | null>(null);
    const walletStatusId = useId();
    const signerStatusId = useId();
    const walletRef = useRef<HTMLButtonElement>(null);
    const accountRef = useRef<HTMLButtonElement>(null);
    const disconnectAccount = () => {
        disconnectSigner();
        requestAnimationFrame(() => accountRef.current?.focus({ preventScroll: true }));
    };
    return <>
        <nav aria-label="Connections" className={`header-tools ${className}`}>
            <button ref={walletRef} type="button" className="header-tool" aria-label="Wallet" aria-describedby={walletStatusId}
                title={connections.walletStatus === "connected" ? "Wallet connected" : connections.walletStatus === "connecting" ? "Wallet connecting" : "Wallet"}
                aria-haspopup="dialog" onClick={() => setSection("wallet")}>
                <WalletIcon />
                {connections.walletStatus !== "disconnected" && <span className={`header-tool__status${connections.walletStatus === "connecting" ? " is-connecting" : ""}`} aria-hidden="true" />}
            </button>
            <span id={walletStatusId} className="sr-only">Wallet {connections.walletStatus}</span>
            {ENABLE_NOSTR_CONNECT && (connections.signerStatus === "connected"
                ? <ConnectedAccount key={connections.signerPubkey} pubkey={connections.signerPubkey} buttonRef={accountRef} onSettings={() => setSection("signer")} onDisconnect={disconnectAccount} />
                : <button ref={accountRef} type="button" className="header-tool" aria-label="Sign in" title="Connect your Nostr account"
                    aria-describedby={connections.signerStatus === "connecting" ? signerStatusId : undefined}
                    aria-haspopup="dialog" onClick={() => setSection("signer")}>
                    <AccountIcon /><span className="header-tool__label">Sign in</span>
                    {connections.signerStatus === "connecting" && <><span className="header-tool__status is-connecting" aria-hidden="true" /><span id={signerStatusId} className="sr-only">Connection in progress</span></>}
                </button>)}
        </nav>
        {section && <Modal isOpen onClose={() => setSection(null)} title={section === "wallet" ? connections.walletStatus === "connected" ? "Wallet" : "Connect wallet" : "Nostr account"}
            returnFocusRef={section === "signer" ? accountRef : walletRef} scrollBody panelClassName="promotion-typography max-w-xl">
            <ConnectionSettings section={section} embedded />
        </Modal>}
    </>;
}
