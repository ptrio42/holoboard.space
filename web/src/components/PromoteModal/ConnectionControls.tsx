import { useState } from "react";
import { ENABLE_NOSTR_CONNECT } from "../../config";
import { useConnections } from "../../hooks/useConnections";
import { shortNpub } from "../../lib/nostr";
import { Modal } from "../ui/Modal";
import { ConnectionSettings } from "./ConnectionSettings";

/** Connections belong to the client and can also be opened inside a payment. */
export function ConnectionControls({ className = "mx-auto max-w-5xl justify-end px-4 py-2 sm:px-6" }: { className?: string }) {
    const connections = useConnections();
    const [section, setSection] = useState<"wallet" | "signer" | null>(null);
    return <>
        <nav aria-label="Connections and help" className={`flex flex-wrap gap-x-5 gap-y-1 text-cyan-200/75 ${className}`}>
            <button type="button" className="promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 hover:text-neon-cyan" onClick={() => setSection("wallet")}>
                Wallet {connections.walletStatus === "connected" && <span className="h-1.5 w-1.5 bg-neon-gold" aria-label="Connected" />}
            </button>
            {ENABLE_NOSTR_CONNECT && <button type="button" className="promotion-action focus-pixel inline-flex min-h-11 items-center gap-2 hover:text-neon-cyan" onClick={() => setSection("signer")}>
                {connections.signerStatus === "connected" ? shortNpub(connections.signerPubkey) : "Connect Nostr"}
                {connections.signerStatus === "connected" && <span className="h-1.5 w-1.5 bg-neon-cyan" aria-label="Connected" />}
            </button>}
            <a href="/help" className="promotion-action focus-pixel inline-flex min-h-11 items-center hover:text-neon-cyan">Help</a>
        </nav>
        {section && <Modal isOpen onClose={() => setSection(null)} title={section === "wallet" ? "Payment wallet" : "Connect Nostr"} scrollBody panelClassName="promotion-typography max-w-xl">
            <ConnectionSettings section={section} embedded />
        </Modal>}
    </>;
}
