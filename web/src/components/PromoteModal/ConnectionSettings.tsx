import { useState } from "react";
import { useConnections } from "../../hooks/useConnections";
import { connectExtension, connectRemote, connectWallet, disconnectSigner, disconnectWallet, hasExtensionSigner, retryWalletConnection } from "../../lib/connections";
import { shortNpub } from "../../lib/nostr";
import { CopyButton } from "../ui/CopyButton";
import { PixelButton } from "../ui/PixelButton";
import { QrCode } from "../ui/QrCode";
import { WalletPanel } from "../Wallet/WalletPanel";

const FIELD = "focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-2 text-base text-cyan-100";
export function ConnectionSettings({ disabled = false, section = "all", embedded = false }: { disabled?: boolean; section?: "all" | "wallet" | "signer"; embedded?: boolean }) {
    const connections = useConnections();
    const [walletUri, setWalletUri] = useState("");
    const [bunkerUri, setBunkerUri] = useState("");
    const [expanded, setExpanded] = useState(false);
    const content = <div className="promotion-typography space-y-5 text-sm leading-relaxed text-cyan-100/75">
            {connections.walletStatus !== "connected" && <p className="text-xs">Invoice links, copying and QR payments work without connecting.</p>}
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
                    <p role="status">Connecting to your wallet...</p>
                    <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectWallet}>Cancel wallet connection</PixelButton>
                </> : <>
                    <label className="block space-y-2"><span className="promotion-label">NWC connection string</span><input type="password" className={FIELD} value={walletUri} autoComplete="off" spellCheck={false} placeholder="nostr+walletconnect://..." disabled={disabled} onChange={(event) => setWalletUri(event.target.value)} /></label>
                    <p className="text-xs text-cyan-100/60">Create a mainnet connection for Holoboard in your wallet. Enable wallet info and the permissions you want: balance, sending, receiving, payment checks and history. Set a spending limit if sending is allowed. The connection stays in this browser tab until you disconnect.</p>
                    <PixelButton size="sm" disabled={disabled || !walletUri.trim()} onClick={() => { const uri = walletUri; setWalletUri(""); void connectWallet(uri); }}>Connect NWC wallet</PixelButton>
                    {connections.walletCanRetry && <div className="flex flex-wrap gap-3"><PixelButton size="sm" variant="ghost" disabled={disabled} onClick={retryWalletConnection}>Retry saved wallet connection</PixelButton><PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectWallet}>Forget wallet connection</PixelButton></div>}
                </>}
                {connections.walletError && <p role="alert" className="text-neon-pink">{connections.walletError}</p>}
            </section>}
            {section !== "wallet" && <section className="space-y-3" aria-label="Nostr signer">
                <h3 className="promotion-section-title text-neon-cyan">Nostr signer</h3>
                <p>A signer is optional. It identifies a public zap to the author and does not pay invoices.</p>
                {connections.signerStatus === "connected" ? <>
                    <p role="status">Connected {connections.signerKind === "extension" ? "extension" : "remote signer"}: {shortNpub(connections.signerPubkey)}</p>
                    <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectSigner}>Disconnect signer</PixelButton>
                </> : connections.signerStatus === "connecting" ? <>
                    <p role="status">Waiting for signer approval. Return here after approving the connection.</p>
                    {connections.signerLink && <div className="space-y-3">
                        <a href={connections.signerLink} className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Open Amber / signer</a>
                        <CopyButton value={connections.signerLink} label="Copy signer connection" />
                        <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">Show signer QR code</summary><div className="flex justify-center py-3"><QrCode value={connections.signerLink} size={280} label="Signer connection QR code" /></div></details>
                    </div>}
                    <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={disconnectSigner}>Cancel signer connection</PixelButton>
                </> : <>
                    <div className="flex flex-wrap gap-3">
                        <PixelButton size="sm" disabled={disabled || !hasExtensionSigner()} onClick={() => void connectExtension()}>Connect browser extension</PixelButton>
                        <PixelButton size="sm" disabled={disabled} onClick={() => void connectRemote()}>Connect Amber / remote signer</PixelButton>
                    </div>
                    <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">Use a signer connection string</summary><div className="space-y-3">
                        <label className="block space-y-2"><span className="promotion-label">Bunker connection string</span><input type="password" className={FIELD} value={bunkerUri} autoComplete="off" spellCheck={false} placeholder="bunker://..." disabled={disabled} onChange={(event) => setBunkerUri(event.target.value)} /></label>
                        <PixelButton size="sm" disabled={disabled || !bunkerUri.trim()} onClick={() => { const uri = bunkerUri; setBunkerUri(""); void connectRemote(uri); }}>Connect this signer</PixelButton>
                    </div></details>
                </>}
                {connections.signerAuthUrl && <a href={connections.signerAuthUrl} target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Approve request with signer</a>}
                {connections.signerError && <p role="alert" className="text-neon-pink">{connections.signerError}</p>}
            </section>}
            {!(section === "wallet" && connections.walletStatus === "connected") && <p className="text-xs text-cyan-100/60">Disconnecting removes the local connection. You can revoke wallet permissions in your wallet and signer permissions in your signer.</p>}
        </div>;
    if (embedded) return content;
    return <details open={expanded || connections.signerStatus === "connecting" || !!connections.signerAuthUrl} onToggle={(event) => setExpanded(event.currentTarget.open)} className="disclosure border-t-2 border-cyan-400/20 pt-3">
        <summary className="promotion-action focus-pixel min-h-11 cursor-pointer text-cyan-300/70">Wallet and signer (optional)</summary>
        <div className="mt-3">{content}</div>
    </details>;
}
