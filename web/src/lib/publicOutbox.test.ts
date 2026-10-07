import { beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { PublicOutbox, type PublicationRecord } from "./publicOutbox";
import type { PublicationStore } from "./publicationStore";
import type { publishSignedEvent } from "./nostrTransport";
const key = generateSecretKey();
const make = (content = "public reply") => finalizeEvent({ kind: 1, created_at: 1700000000, content, tags: [] }, key);
const urls = ["wss://one.example.com", "wss://two.example.com"];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
class MemoryStore implements PublicationStore {
    records: PublicationRecord[] = []; fail = false; changes = 0;
    private queue = Promise.resolve();
    async read() { await this.queue; return clone(this.records); }
    change(update: (records: PublicationRecord[]) => PublicationRecord[]) {
        const result = this.queue.then(() => {
            this.changes++; if (this.fail) throw new Error("storage unavailable");
            this.records = clone(update(clone(this.records))); return clone(this.records);
        });
        this.queue = result.then(() => {}, () => {}); return result;
    }
}
let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); });
it("persists before sending, retains partial outcomes and retries the exact signed ID without resending accepted targets", async () => {
    const event = make();
    const publish = vi.fn<typeof publishSignedEvent>().mockImplementation(async (signed, targets, options) => {
        expect(store.records[0].event.id).toBe(event.id);
        for (const url of targets) expect(store.records[0].relays[url].state).toBe("uncertain");
        const relays = Object.fromEntries(targets.map(url => [url, { state: url === urls[0] ? "accepted" as const : "uncertain" as const }]));
        for (const [url, outcome] of Object.entries(relays)) options?.onOutcome?.(url, outcome);
        return { id: signed.id, relays };
    });
    const outbox = new PublicOutbox(store, publish); await outbox.enqueue(event, urls);
    expect(publish).not.toHaveBeenCalled();
    expect((await outbox.send(event.id)).relays).toEqual({ [urls[0]]: { state: "accepted" }, [urls[1]]: { state: "uncertain" } });
    const restored = new PublicOutbox(store, publish); await restored.list(); expect(publish).toHaveBeenCalledTimes(1);
    await restored.send(event.id);
    expect(publish.mock.calls[1][0].id).toBe(event.id); expect(publish.mock.calls[1][1]).toEqual([urls[1]]);
    expect(store.records[0].attempts).toBe(2);
});
it("fails closed when enqueue or the pre-send checkpoint cannot be saved", async () => {
    const publish = vi.fn<typeof publishSignedEvent>(); const outbox = new PublicOutbox(store, publish); const event = make();
    store.fail = true; await expect(outbox.enqueue(event, urls)).rejects.toThrow("storage");
    store.fail = false; await outbox.enqueue(event, urls); store.fail = true;
    await expect(outbox.send(event.id)).rejects.toThrow("storage"); expect(publish).not.toHaveBeenCalled();
    expect(store.records[0].attempts).toBe(0);
});
it("preserves an inconclusive durable record when acknowledgement checkpointing fails", async () => {
    const event = make();
    const publish = vi.fn<typeof publishSignedEvent>().mockImplementation(async (signed, targets, options) => {
        store.fail = true; options?.onOutcome?.(targets[0], { state: "accepted" });
        return { id: signed.id, relays: { [targets[0]]: { state: "accepted" } } };
    });
    const outbox = new PublicOutbox(store, publish); await outbox.enqueue(event, [urls[0]]);
    await expect(outbox.send(event.id)).rejects.toThrow("may already be public");
    expect(store.records[0]).toMatchObject({ id: event.id, attempts: 1, relays: { [urls[0]]: { state: "uncertain" } } });
    store.fail = false; expect((await new PublicOutbox(store, publish).list())[0].event.id).toBe(event.id);
});
it("joins duplicate send actions and bounds process-wide delivery admission", async () => {
    const event = make(); const deliver: (() => void)[] = [];
    const publish = vi.fn<typeof publishSignedEvent>().mockImplementation((signed, targets) => new Promise(resolve => deliver.push(() => resolve({ id: signed.id, relays: Object.fromEntries(targets.map(url => [url, { state: "accepted" as const }])) }))));
    const outbox = new PublicOutbox(store, publish); await outbox.enqueue(event, urls);
    const first = outbox.send(event.id); expect(outbox.send(event.id)).toBe(first);
    const another = new PublicOutbox(store, publish); const next = make("another"); await another.enqueue(next, urls);
    const second = another.send(next.id);
    await expect(new PublicOutbox(store, publish).send("a".repeat(64))).rejects.toThrow("busy");
    await vi.waitFor(() => expect(deliver).toHaveLength(2)); deliver.forEach(finish => finish()); await Promise.all([first, second]);
    expect(publish).toHaveBeenCalledTimes(2);
});
it("does not publish on listing, enqueue, duplicate enqueue or an already cancelled send", async () => {
    const event = make(), publish = vi.fn<typeof publishSignedEvent>(); const outbox = new PublicOutbox(store, publish);
    await outbox.list(); await outbox.enqueue(event, urls); await outbox.enqueue(event, urls);
    const controller = new AbortController(); controller.abort(); await outbox.send(event.id, { signal: controller.signal });
    expect((await outbox.list())).toHaveLength(1); expect(publish).not.toHaveBeenCalled();
    expect(store.records[0].attempts).toBe(0);
});
it("rejects forged objects, unsafe targets and record capacity exhaustion without evicting saved events", async () => {
    const event = make(), publish = vi.fn<typeof publishSignedEvent>(); const outbox = new PublicOutbox(store, publish);
    await expect(outbox.enqueue({ ...event, id: "0".repeat(64) }, urls)).rejects.toThrow("verified");
    await expect(outbox.enqueue(event, ["wss://127.0.0.1"])).rejects.toThrow("destinations");
    // Seed a full durable snapshot once. Re-enqueuing every prefix would
    // repeatedly verify the same signatures without adding capacity evidence.
    store.records = Array.from({ length: 32 }, (_, i) => {
        const event = make(`note ${i}`);
        return { id: event.id, event, relays: Object.fromEntries(urls.map(url => [url, { state: "pending" as const }])), createdAt: 100, attempts: 0 };
    });
    await expect(outbox.enqueue(make("overflow"), urls)).rejects.toThrow("full");
    expect(store.records).toHaveLength(32); expect(publish).not.toHaveBeenCalled();
});
it.each(["accepted", "uncertain"] as const)("cannot downgrade a newer %s outcome when a separate instance checkpoints a stale result", async state => {
    const event = make(); let rejectOld!: () => void;
    const oldPublish = vi.fn<typeof publishSignedEvent>().mockImplementation((signed, targets) => new Promise(resolve => { rejectOld = () => resolve({ id: signed.id, relays: { [targets[0]]: { state: "rejected" } } }); }));
    const first = new PublicOutbox(store, oldPublish); await first.enqueue(event, [urls[0]]); const pending = first.send(event.id);
    await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
    const accepted = vi.fn<typeof publishSignedEvent>().mockImplementation(async (signed, targets) => ({ id: signed.id, relays: { [targets[0]]: { state } } }));
    await new PublicOutbox(store, accepted).send(event.id); rejectOld(); await pending;
    expect(store.records[0].relays[urls[0]].state).toBe(state);
});
