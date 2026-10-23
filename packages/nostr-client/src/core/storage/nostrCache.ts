import { verifiedNostrEvent } from "../events/verifyNostrEvent";
import { matchFilter, type Event, type Filter } from "nostr-tools";

interface RecordEntry { event: Event; expires: number; size: number }
const MAX_ENTRIES = 2048;
const MAX_BYTES = 8_388_608;
export function newerEvent(candidate: Pick<Event, "id" | "created_at">, current?: Pick<Event, "id" | "created_at">): boolean {
    return !current || candidate.created_at > current.created_at || (candidate.created_at === current.created_at && candidate.id < current.id);
}
export function replaceableKey(event: Event): string | undefined {
    if (event.kind === 0 || event.kind === 3 || (event.kind >= 10000 && event.kind < 20000)) return `${event.kind}:${event.pubkey}:`;
    if (event.kind >= 30000 && event.kind < 40000) return `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`;
}

/** An expendable read cache, isolated from identity and payment storage. */
export class NostrCache {
    private records = new Map<string, RecordEntry>();
    private bytes = 0;
    private db?: IDBDatabase;
    private dirty = false;
    private timer?: ReturnType<typeof setTimeout>;
    readonly ready: Promise<void>;
    constructor(persistent = false, private readonly databaseName?: string) {
        if (persistent && !databaseName) throw new TypeError("Persistent caches require an explicit database name.");
        this.ready = persistent && typeof indexedDB !== "undefined" ? this.open().catch(() => {}) : Promise.resolve();
    }
    dispose() { if (this.timer) clearTimeout(this.timer); this.db?.close(); this.db = undefined; this.records.clear(); this.bytes = 0; }
    private open(): Promise<void> {
        return new Promise((resolve) => {
            const request = indexedDB.open(this.databaseName!, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "event.id" });
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => { this.db?.close(); this.db = undefined; };
                const transaction = this.db.transaction("events", "readonly");
                let scanned = 0;
                const cursor = transaction.objectStore("events").openCursor();
                cursor.onsuccess = () => {
                    if (!cursor.result || ++scanned > 4096) return;
                    const entry = cursor.result.value as RecordEntry;
                    if (entry.expires > Date.now()) this.put(entry.event, entry.expires, false);
                    cursor.result.continue();
                };
                transaction.oncomplete = () => { this.scheduleSave(); resolve(); };
                transaction.onerror = () => resolve();
            };
        });
    }
    put(event: Event, expires?: number, save = true) {
        const verified = verifiedNostrEvent(event);
        if (!verified) return;
        event = verified;
        if (event.kind >= 20000 && event.kind < 30000) return;
        this.prune();
        const size = JSON.stringify(event).length * 3;
        if (size > 262144) return;
        const key = replaceableKey(event);
        if (key) {
            for (const [id, entry] of this.records) {
                if (replaceableKey(entry.event) !== key) continue;
                if (!newerEvent(event, entry.event) && id !== event.id) return;
                this.remove(id);
            }
        }
        this.remove(event.id);
        const ttl = event.kind === 0 ? 15 * 60_000 : event.kind === 10002 || event.kind === 10050 ? 5 * 60_000 : event.kind === 5 ? 30 * 86400_000 : 86400_000;
        this.records.set(event.id, { event, expires: expires ?? Date.now() + ttl, size }); this.bytes += size;
        this.prune(); if (save) this.scheduleSave();
    }
    private remove(id: string) { const old = this.records.get(id); if (old) { this.bytes -= old.size; this.records.delete(id); } }
    private prune() {
        for (const [id, entry] of this.records) if (entry.expires <= Date.now()) this.remove(id);
        while (this.records.size > MAX_ENTRIES || this.bytes > MAX_BYTES) this.remove(this.records.keys().next().value!);
    }
    private deleted(event: Event): boolean {
        for (const { event: deletion } of this.records.values()) {
            if (deletion.kind !== 5 || deletion.pubkey !== event.pubkey) continue;
            if (deletion.tags.some((tag) => tag[0] === "e" && tag[1] === event.id)) return true;
            const key = replaceableKey(event);
            if (key && event.created_at <= deletion.created_at && deletion.tags.some((tag) => tag[0] === "a" && tag[1] === key)) return true;
        }
        return false;
    }
    query(filter: Filter): Event[] {
        this.prune();
        // Match before sorting/limiting. Every tag remains available regardless
        // of position or tag count; signatures are retained on disk.
        return [...this.records.values()].map((entry) => ({ ...entry.event, tags: entry.event.tags.map((tag) => [...tag]) }))
            .filter((event) => matchFilter(filter, event) && !this.deleted(event))
            .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
            .slice(0, filter.limit ?? MAX_ENTRIES);
    }
    /** Retention membership only; deletion visibility remains query()'s policy. */
    hasRetained(id: string): boolean { this.prune(); return this.records.has(id); }
    private scheduleSave() {
        this.dirty = true;
        if (this.timer || !this.db) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.db || !this.dirty) return;
            this.dirty = false; this.prune();
            try {
                const transaction = this.db.transaction("events", "readwrite");
                const store = transaction.objectStore("events"); store.clear();
                for (const entry of this.records.values()) store.put(entry);
                transaction.onabort = () => { this.db?.close(); this.db = undefined; };
            } catch { this.db?.close(); this.db = undefined; }
        }, 2000);
    }
    stats() { this.prune(); return { entries: this.records.size, bytes: this.bytes }; }
}
