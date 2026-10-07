import { AbstractSimplePool } from "nostr-tools/abstract-pool";

/** Contain malformed encrypted RPC responses at the library callback boundary. */
export class SignerPool extends AbstractSimplePool {
    override subscribe(...[relays, filter, params]: Parameters<AbstractSimplePool["subscribe"]>) {
        return super.subscribe(relays, filter, { ...params, onevent: async event => {
            try { await params.onevent?.(event); }
            catch { /* Ignore unreadable RPC responses; the owning request retains its deadline. */ }
        } });
    }
}
