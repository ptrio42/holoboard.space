import { useState } from "react";
import { ENABLE_NOSTR_CONNECT } from "../../config";
import { useConnections } from "../../hooks/useConnections";
import { shortNpub } from "../../lib/nostr";
import { Modal } from "../ui/Modal";
import { ConnectionSettings } from "./ConnectionSettings";
import { PixelButton } from "../ui/PixelButton";
import { WalletIcon } from "../ui/WalletIcon";

/** Connections belong to the client and can also be opened inside a payment. */
export function ConnectionControls({ className = "mx-auto max-w-5xl justify-end px-4 py-2 sm:px-6" }: { className?: string }) {
    const connections = useConnections();
    const [section, setSection] = useState<"wallet" | "signer" | null>(null);
    return <>
        <nav aria-label="Connections" className={`flex flex-wrap items-center gap-2 text-cyan-200/75 ${className}`}>
            <PixelButton variant="ghost" size="sm" title="Wallet" className="relative min-h-11 min-w-11 focus-pixel [&>span]:min-h-[38px] [&>span]:px-2 [&>span]:py-0 [&>span]:text-[10px]" onClick={() => setSection("wallet")}>
                <WalletIcon /><span className="sr-only md:not-sr-only">Wallet</span>
                {connections.walletStatus === "connected" && <span className="absolute right-2 top-2 h-1.5 w-1.5 bg-neon-gold" aria-label="Connected" />}
            </PixelButton>
            {ENABLE_NOSTR_CONNECT && <button type="button" className="promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 hover:text-neon-cyan" onClick={() => setSection("signer")}>
                {connections.signerStatus === "connected" ? shortNpub(connections.signerPubkey) : "Connect Nostr"}
                {connections.signerStatus === "connected" && <span className="h-1.5 w-1.5 bg-neon-cyan" aria-label="Connected" />}
            </button>}
        </nav>
        {section && <Modal isOpen onClose={() => setSection(null)} title={section === "wallet" ? "Payment wallet" : "Connect Nostr"} scrollBody panelClassName="promotion-typography max-w-xl">
            <ConnectionSettings section={section} embedded />
        </Modal>}
    </>;
}
