import { afterEach, expect, it, vi } from "vitest";
import { BunkerSigner } from "nostr-tools/nip46";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import type { AbstractSimplePool, SubscribeManyParams } from "nostr-tools/abstract-pool";

function fixture() {
    const clientKey = generateSecretKey(), remoteKey = generateSecretKey();
    const conversation = getConversationKey(remoteKey, getPublicKey(clientKey));
    const subscriptions: SubscribeManyParams[] = [];
    let published!: Event;
    const pool = { subscribe: vi.fn((_relays, _filter, params: SubscribeManyParams) => { subscriptions.push(params); return { close: vi.fn() }; }),
        publish: vi.fn((_relays, event: Event) => { published = event; return [Promise.resolve("saved")]; }) };
    const signer = BunkerSigner.fromBunker(clientKey, { pubkey: getPublicKey(remoteKey), relays: ["wss://relay.example.com"], secret: null }, { pool: pool as unknown as AbstractSimplePool });
    const respond = async (result: string) => {
        const request = JSON.parse(decrypt(published.content, conversation));
        await subscriptions.at(-1)!.onevent!(finalizeEvent({ kind: 24133, created_at: 1700000000, tags: [["p", getPublicKey(clientKey)]],
            content: encrypt(JSON.stringify({ id: request.id, result }), conversation) }, remoteKey));
    };
    return { signer, pool, respond, subscriptions };
}
afterEach(() => vi.useRealTimers());
it("records installed RPC callback rejection for malformed encrypted responses", async () => {
    const { signer, subscriptions } = fixture();
    await expect(subscriptions[0].onevent!({ content: "invalid encrypted response" } as Event)).rejects.toThrow();
    await signer.close();
});
it("records installed NIP-46 request bookkeeping retained after successful responses", async () => {
    const { signer, respond } = fixture();
    for (let i = 0; i < 3; i++) { const request = signer.sendRequest("ping", []); await respond("pong"); expect(await request).toBe("pong"); }
    const internals = signer as unknown as { listeners: Record<string, unknown>; waitingForAuth: Record<string, unknown> };
    expect(Object.keys(internals.listeners)).toHaveLength(0);
    expect(Object.keys(internals.waitingForAuth)).toHaveLength(3);
    await signer.close();
});
it("records installed switchRelays accepting unsafe destinations and reopening after close", async () => {
    vi.useFakeTimers();
    const { signer, pool, respond } = fixture();
    const switchRequest = signer.switchRelays(); await signer.close();
    await respond('["ws://127.0.0.1:9000"]');
    expect(await switchRequest).toBe(true);
    expect(signer.bp.relays).toEqual(["ws://127.0.0.1:9000"]);
    expect(pool.subscribe).toHaveBeenCalledTimes(2);
    expect(() => vi.advanceTimersByTime(5000)).toThrow("close"); await signer.close();
});
