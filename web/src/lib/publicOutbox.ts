import type { Event } from "nostr-tools";
import { publishSignedEvent, type DeliveryOutcome } from "./nostrTransport";
import { relayCandidates, safeRelay } from "./relayPolicy";
import { verifiedNostrEvent } from "./verifyNostrEvent";
import { IndexedPublicationStore, type PublicationStore } from "./publicationStore";

export interface PublicationRecord {
    id: string; event: Event; createdAt: number; attempts: number;
    relays: Record<string, DeliveryOutcome | { state: "pending" }>;
}
let activeDeliveries = 0;
function validate(records: PublicationRecord[]): PublicationRecord[] {
    if (records.length > 32 || JSON.stringify(records).length * 3 > 1_048_576) throw new Error("Publication outbox is full. Review saved publications before adding another.");
    const ids = new Set<string>();
    return records.map(record => {
        const event = verifiedNostrEvent(record.event);
        if (!event || ![1, 1111].includes(event.kind) || event.id !== record.id || ids.has(record.id) || JSON.stringify(event).length * 3 > 65536 ||
            !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Number.isSafeInteger(record.attempts) || record.attempts < 0) throw new Error("Publication storage contains an invalid event or record.");
        ids.add(record.id);
        const entries = Object.entries(record.relays);
        if (!entries.length || entries.length > 12 || entries.some(([url, outcome]) => safeRelay(url) !== url || !outcome ||
            !["pending", "accepted", "rejected", "uncertain", "not-sent"].includes(outcome.state) ||
            ("detail" in outcome && (typeof outcome.detail !== "string" || outcome.detail.length > 256)))) throw new Error("Publication storage contains invalid delivery state.");
        return { ...record, event, relays: Object.fromEntries(entries.map(([url, outcome]) => [url, { ...outcome }])) };
    });
}
/** Durable public events only. Call send explicitly after reviewing the account
 * and destinations; construction, enqueue, listing and reload never publish.
 */
export class PublicOutbox {
    private running = new Map<string, Promise<PublicationRecord>>();
    constructor(privateStore: PublicationStore = new IndexedPublicationStore(), privatePublish: typeof publishSignedEvent = publishSignedEvent) {
        this.store = privateStore; this.publish = privatePublish;
    }
    private store: PublicationStore;
    private publish: typeof publishSignedEvent;
    async list() { return validate(await this.store.read()); }
    /** Removing a receipt cannot cancel delivery or delete a public event. */
    async forget(id: string) {
        if (this.running.has(id)) throw new Error("Wait for this delivery to finish before forgetting its local receipt.");
        await this.change(records => records.filter(record => record.id !== id));
    }
    private change(update: (records: PublicationRecord[]) => PublicationRecord[]) {
        return this.store.change(records => validate(update(validate(records))));
    }
    async enqueue(input: Event, urls: string[]): Promise<PublicationRecord> {
        const event = verifiedNostrEvent(input);
        if (!event || ![1, 1111].includes(event.kind)) throw new TypeError("A verified signed note or comment is required.");
        const targets = relayCandidates(urls, 12);
        if (!targets.length || urls.length > 12 || urls.some(url => !safeRelay(url))) throw new TypeError("Invalid publication destinations.");
        const records = await this.change(records => {
            const old = records.find(record => record.id === event.id);
            if (old) {
                for (const url of targets) old.relays[url] ??= { state: "pending" };
                return records;
            }
            return [...records, { id: event.id, event, relays: Object.fromEntries(targets.map(url => [url, { state: "pending" as const }])), createdAt: Date.now(), attempts: 0 }];
        });
        return records.find(record => record.id === event.id)!;
    }
    send(id: string, options: { signal?: AbortSignal } = {}): Promise<PublicationRecord> {
        const existing = this.running.get(id); if (existing) return existing;
        if (activeDeliveries >= 2) return Promise.reject(new Error("Publication delivery is busy. Try again after the current requests finish."));
        activeDeliveries++;
        const job = this.deliver(id, options.signal).finally(() => { this.running.delete(id); activeDeliveries--; });
        this.running.set(id, job); return job;
    }
    private async deliver(id: string, signal?: AbortSignal): Promise<PublicationRecord> {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
        try {
            let record = (await this.list()).find(record => record.id === id);
            if (!record) throw new Error("Saved publication was not found.");
            if (controller.signal.aborted) return record;
            const targets = Object.entries(record.relays).filter(([, outcome]) => outcome.state !== "accepted").map(([url]) => url);
            if (!targets.length) return record;
            // A crash after this durable checkpoint is inconclusive, even if it
            // happened just before send. Retry always uses the stored exact ID.
            record = (await this.change(records => records.map(value => value.id !== id ? value : { ...value, attempts: value.attempts + 1,
                relays: Object.fromEntries(Object.entries(value.relays).map(([url, outcome]) => [url, targets.includes(url) && outcome.state !== "accepted" ? { state: "uncertain" as const, detail: "Interrupted attempt may have reached the relay." } : outcome])) }))).find(value => value.id === id)!;
            if (!record) throw new Error("This publication receipt was removed in another tab. Delivery was stopped.");
            if (controller.signal.aborted) return record;
            const attempt = record.attempts;
            let checkpoint = Promise.resolve(), checkpointFailure: unknown;
            const observed = new Set<string>();
            const saveOutcome = (url: string, outcome: DeliveryOutcome) => {
                if (!targets.includes(url) || observed.has(url)) return; observed.add(url);
                checkpoint = checkpoint.then(async () => {
                    const updated = await this.change(records => records.map(value => value.id !== id ? value : { ...value,
                        relays: { ...value.relays, [url]: value.relays[url]?.state === "accepted" || value.attempts !== attempt && outcome.state !== "accepted" ? value.relays[url] : outcome } }));
                    record = updated.find(value => value.id === id)!;
                    if (!record) throw new Error("This publication receipt was removed in another tab. Delivery was stopped.");
                }).catch(failure => { checkpointFailure ??= failure; controller.abort("storage-failed"); });
            };
            let result: Awaited<ReturnType<typeof publishSignedEvent>>;
            try { result = await this.publish(record.event, targets, { signal: controller.signal, onOutcome: saveOutcome }); }
            catch (failure) { controller.abort(); await checkpoint; throw failure; }
            for (const [url, outcome] of Object.entries(result.relays)) saveOutcome(url, outcome);
            await checkpoint;
            if (checkpointFailure) throw new Error("Could not save delivery outcomes. This event may already be public. Retry its saved outbox entry.", { cause: checkpointFailure });
            return record;
        } finally { signal?.removeEventListener("abort", abort); controller.abort(); }
    }
}
export const publicOutbox = new PublicOutbox();
