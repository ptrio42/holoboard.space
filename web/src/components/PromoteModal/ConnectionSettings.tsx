import { useId, useState } from "react";
import { useConnections } from "../../hooks/useConnections";
import { connectExtension, connectRemote, connectWallet, disconnectSigner, disconnectWallet, hasExtensionSigner, retryWalletConnection } from "../../lib/connections";
import { shortNpub } from "../../lib/nostr";
import { CopyButton } from "../ui/CopyButton";
import { PixelButton, PixelLink } from "../ui/PixelButton";
import { QrCode } from "../ui/QrCode";
import { StatusMessage } from "../ui/StatusMessage";
import { WalletPanel } from "../Wallet/WalletPanel";

const FIELD = "focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-2 text-base text-cyan-100";
export function ConnectionSettings({ disabled = false, section = "all", embedded = false, paymentOnly = false, purpose = "zap" }: { disabled?: boolean; section?: "all" | "wallet" | "signer"; embedded?: boolean; paymentOnly?: boolean; purpose?: "account" | "zap" | "reply" }) {
    const connections = useConnections();
    const [walletUri, setWalletUri] = useState("");
    const [bunkerUri, setBunkerUri] = useState("");
    const [expanded, setExpanded] = useState(false);
    const walletHintId = useId();
    const walletErrorId = useId();
    const extensionHintId = useId();
    const accountConnection = purpose === "account";
    const extensionAvailable = hasExtensionSigner();
    const cancelSigner = <PixelButton size="sm" variant="ghost" aria-label={accountConnection ? "Cancel sign in" : undefined}
        disabled={disabled} onClick={disconnectSigner}>{accountConnection ? "Cancel" : "Cancel signer connection"}</PixelButton>;
    const walletError = connections.walletError && <p id={walletErrorId} role="alert" className="text-neon-pink">{connections.walletError}</p>;
    const content = <div className="promotion-typography space-y-5 text-sm leading-relaxed text-cyan-100/75">
            {section === "signer" && !accountConnection && !paymentOnly && connections.walletStatus !== "connected" && <p className="text-xs">Invoice links, copying and QR payments work without connecting.</p>}
            {section !== "signer" && <section className="space-y-3" aria-label="Payment wallet">
                {section === "all" && <h3 className="promotion-section-title text-neon-cyan">Payment wallet</h3>}
                {connections.walletStatus === "connected" ? <>
                    <div className="wallet-connection-header">
                        <p role="status"><span className="wallet-connection-light" aria-hidden="true" />Connected: {connections.walletName}.</p>
                        <button type="button" className="wallet-icon-button focus-pixel" aria-label="Disconnect wallet" title="Disconnect wallet" disabled={disabled} onClick={disconnectWallet}>
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges"><path d="M1 1h8v2H3v10h6v2H1zM8 7h5V5h2v2h1v2h-1v2h-2V9H8z" /></svg>
                        </button>
                    </div>
                    <WalletPanel disabled={disabled} />
                </> : connections.walletStatus === "connecting" ? <>
                    <StatusMessage compact loading>Connecting to your wallet...</StatusMessage>
                    <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectWallet}>Cancel wallet connection</PixelButton>
                </> : <>
                    <div className="space-y-1">
                        <p className="text-cyan-100">{paymentOnly ? "Pay here with your Lightning wallet." : "Pay for boosts with your Lightning wallet."}</p>
                        <p className="text-xs text-cyan-100/60">Paste an NWC connection link from your wallet.</p>
                    </div>
                    <form className="space-y-3" onSubmit={(event) => {
                        event.preventDefault();
                        if (disabled || !walletUri.trim()) return;
                        const uri = walletUri;
                        setWalletUri("");
                        void connectWallet(uri);
                    }}>
                        <label className="block space-y-2">
                            <span className="promotion-label text-cyan-200/75">NWC connection link</span>
                            <input type="password" className={`${FIELD} min-h-11`} value={walletUri} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                                placeholder="Paste connection link" aria-describedby={`${walletHintId}${connections.walletError ? ` ${walletErrorId}` : ""}`} disabled={disabled} onChange={(event) => setWalletUri(event.target.value)} />
                        </label>
                        <PixelButton type="submit" size="sm" className="w-full [&>span]:min-h-[38px]" disabled={disabled || !walletUri.trim()}>Connect wallet</PixelButton>
                        <p id={walletHintId} className="text-xs text-cyan-100/60">Connecting does not send sats.</p>
                    </form>
                    {walletError}
                    {connections.walletCanRetry && <div className="flex flex-wrap gap-3"><PixelButton size="sm" variant="ghost" disabled={disabled} onClick={retryWalletConnection}>Retry saved wallet connection</PixelButton><PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectWallet}>Forget wallet connection</PixelButton></div>}
                    <details className="disclosure border-t border-cyan-400/20 pt-1">
                        <summary className="promotion-action focus-pixel flex min-h-11 cursor-pointer items-center gap-2 text-cyan-200/75 before:shrink-0 before:whitespace-nowrap">Where do I get a link?</summary>
                        <div className="space-y-3 pb-2 text-xs text-cyan-100/65">
                            <ol className="list-decimal space-y-2 pl-5">
                                <li>In your wallet, create a mainnet Nostr Wallet Connect (NWC) connection for Holoboard.</li>
                                <li>{paymentOnly ? "Allow wallet info, sending and payment checks. Set a spending limit." : "Allow wallet info and choose access to balance, sending, receiving, payment checks and history. Set a spending limit if you allow sending."}</li>
                                <li>Copy the connection link and paste it above.</li>
                            </ol>
                            <p>The connection stays in this browser tab until you disconnect. You can revoke access in your wallet at any time.</p>
                        </div>
                    </details>
                    <p className="text-xs text-cyan-100/60">Invoice / QR payments also work without connecting.</p>
                </>}
                {connections.walletStatus !== "disconnected" && walletError}
            </section>}
            {section !== "wallet" && <section className="space-y-3" aria-label={accountConnection ? "Nostr account" : "Nostr signer"}>
                {!accountConnection && <h3 className="promotion-section-title text-neon-cyan">Nostr signer</h3>}
                {accountConnection ? connections.signerStatus === "disconnected" && <p className="text-cyan-100">Use your Nostr account on Holoboard.</p>
                    : <p>{purpose === "reply" ? "Connect the account that will sign your reply. Connecting does not publish anything." : "A signer is optional. It identifies a public zap to the author and does not pay invoices."}</p>}
                {connections.signerStatus === "connected" ? <>
                    <p role="status">Connected {connections.signerKind === "extension" ? "extension" : "remote signer"}: {shortNpub(connections.signerPubkey)}</p>
                    <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectSigner}>{accountConnection ? "Disconnect account" : "Disconnect signer"}</PixelButton>
                </> : connections.signerStatus === "connecting" ? <>
                    <StatusMessage compact loading>{accountConnection ? "Waiting for approval" : "Waiting for signer approval. Return here after approving the connection."}</StatusMessage>
                    {accountConnection && <p className="text-xs text-cyan-100/65">Approve the connection in your signer, then return here.</p>}
                    {connections.signerLink && <div className="space-y-3">
                        {accountConnection ? <PixelLink href={connections.signerLink} size="sm" className="w-full [&>span]:min-h-[38px]">Open Amber / signer</PixelLink>
                            : <a href={connections.signerLink} className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Open Amber / signer</a>}
                        <div className={accountConnection ? "flex flex-wrap items-center gap-3" : ""}>
                            <CopyButton value={connections.signerLink} label={accountConnection ? "Copy link" : "Copy signer connection"} />
                            {accountConnection && cancelSigner}
                        </div>
                        <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">{accountConnection ? "Show QR" : "Show signer QR code"}</summary><div className="flex justify-center py-3"><QrCode value={connections.signerLink} size={280} label="Signer connection QR code" /></div></details>
                    </div>}
                    {(!accountConnection || !connections.signerLink) && cancelSigner}
                </> : <>
                    <div className={accountConnection ? "grid gap-3" : "flex flex-wrap gap-3"}>
                        <PixelButton size="sm" className={accountConnection ? "w-full [&>span]:min-h-[38px]" : ""}
                            aria-describedby={accountConnection && !extensionAvailable ? extensionHintId : undefined}
                            disabled={disabled || !extensionAvailable} onClick={() => void connectExtension()}>{accountConnection ? "Browser extension" : "Connect browser extension"}</PixelButton>
                        {accountConnection && !extensionAvailable && <p id={extensionHintId} className="text-xs text-cyan-100/60">No Nostr extension detected in this browser.</p>}
                        <PixelButton size="sm" className={accountConnection ? "w-full [&>span]:min-h-[38px]" : ""}
                            disabled={disabled} onClick={() => void connectRemote()}>{accountConnection ? "Amber / remote signer" : "Connect Amber / remote signer"}</PixelButton>
                    </div>
                    <details className={`disclosure${accountConnection ? " border-t border-cyan-400/20 pt-1" : ""}`}><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">{accountConnection ? "Use a bunker link" : "Use a signer connection string"}</summary><div className="space-y-3">
                        <label className="block space-y-2"><span className="promotion-label">{accountConnection ? "Bunker connection link" : "Bunker connection string"}</span><input type="password" className={FIELD} value={bunkerUri} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="bunker://..." disabled={disabled} onChange={(event) => setBunkerUri(event.target.value)} /></label>
                        <PixelButton size="sm" disabled={disabled || !bunkerUri.trim()} onClick={() => { const uri = bunkerUri; setBunkerUri(""); void connectRemote(uri); }}>Connect this signer</PixelButton>
                    </div></details>
                </>}
                {connections.signerAuthUrl && <a href={connections.signerAuthUrl} target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Approve request with signer</a>}
                {connections.signerError && <p role="alert" className="text-neon-pink">{connections.signerError}</p>}
            </section>}
            {!accountConnection && !paymentOnly && section !== "wallet" && <p className="text-xs text-cyan-100/60">Disconnecting removes the local connection. You can revoke wallet permissions in your wallet and signer permissions in your signer.</p>}
        </div>;
    if (embedded) return content;
    return <details open={expanded || connections.signerStatus === "connecting" || !!connections.signerAuthUrl} onToggle={(event) => setExpanded(event.currentTarget.open)} className="disclosure border-t-2 border-cyan-400/20 pt-3">
        <summary className="promotion-action focus-pixel min-h-11 cursor-pointer text-cyan-300/70">Wallet and signer (optional)</summary>
        <div className="mt-3">{content}</div>
    </details>;
}
