import { afterEach, expect, it, vi } from "vitest";
import { AbstractSimplePool, type SubscribeManyParams } from "nostr-tools/abstract-pool";
import type { Event } from "nostr-tools";
import { SignerPool } from "./signerPool";
afterEach(() => vi.restoreAllMocks());
it("contains synchronous and asynchronous RPC callback failures without closing another request", async () => {
    let callback!: SubscribeManyParams["onevent"];
    const close = vi.fn();
    vi.spyOn(AbstractSimplePool.prototype, "subscribe").mockImplementation((_relays, _filter, options) => { callback = options.onevent; return { close }; });
    const pool = new SignerPool({ verifyEvent: () => true, maxWaitForConnection: 1000 });
    for (const onevent of [() => { throw new Error("invalid JSON"); }, async () => { throw new Error("invalid ciphertext"); }]) {
        pool.subscribe(["wss://relay.example.com"], { kinds: [24133] }, { onevent });
        await expect(callback!({} as Event)).resolves.toBeUndefined();
    }
    expect(close).not.toHaveBeenCalled(); pool.destroy();
});
