import type { PublicationRecord } from "./publicOutbox";

export interface PublicationStore {
    read(): Promise<PublicationRecord[]>;
    change(update: (records: PublicationRecord[]) => PublicationRecord[]): Promise<PublicationRecord[]>;
}
/** Atomic read/modify/write transactions also serialize independent browser tabs.
 * The database opens lazily; merely importing the disabled feature creates no storage.
 */
export class IndexedPublicationStore implements PublicationStore {
    private opening?: Promise<IDBDatabase>;
    private transactions = 0;
    private database() {
        if (this.opening) return this.opening;
        const opening = new Promise<IDBDatabase>((resolve, reject) => {
            if (typeof indexedDB === "undefined") { reject(new Error("Durable publication storage is unavailable.")); return; }
            // Native open() can throw synchronously when storage is blocked.
            // Do not create a deadline for a request that never started.
            const request = indexedDB.open("holoboard-public-outbox-v1", 1);
            let ended = false;
            const fail = () => { ended = true; clearTimeout(timer); reject(new Error("Could not open durable publication storage.")); };
            const timer = setTimeout(fail, 3000);
            request.onupgradeneeded = () => {
                if (ended) request.transaction?.abort();
                else request.result.createObjectStore("events", { keyPath: "id" });
            };
            request.onerror = fail; request.onblocked = fail;
            request.onsuccess = () => {
                clearTimeout(timer);
                if (ended) { request.result.close(); return; }
                ended = true; const db = request.result;
                db.onversionchange = () => { db.close(); this.opening = undefined; };
                resolve(db);
            };
        });
        this.opening = opening;
        void opening.catch(() => { if (this.opening === opening) this.opening = undefined; });
        return opening;
    }
    private async transaction(update?: (records: PublicationRecord[]) => PublicationRecord[]) {
        if (this.transactions >= 16) throw new Error("Publication storage is busy.");
        this.transactions++;
        try {
            const db = await this.database();
            return await new Promise<PublicationRecord[]>((resolve, reject) => {
            const transaction = db.transaction("events", update ? "readwrite" : "readonly");
            const store = transaction.objectStore("events");
            const request = store.getAll(undefined, 33);
            let records: PublicationRecord[] = [], failure: unknown;
            const timer = setTimeout(() => {
                failure = new Error("Publication storage timed out.");
                try { transaction.abort(); } catch { reject(failure); }
            }, 3000);
            request.onsuccess = () => {
                try {
                    if (request.result.length > 32) throw new Error("Publication storage exceeds its record limit.");
                    records = update ? update(request.result) : request.result;
                    if (records.length > 32 || JSON.stringify(records).length * 3 > 1_048_576) throw new Error("Publication storage is full.");
                    if (update) { store.clear(); for (const record of records) store.put(record); }
                } catch (error) { failure = error; transaction.abort(); }
            };
            transaction.oncomplete = () => { clearTimeout(timer); resolve(records); };
            transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(failure ?? new Error("Could not save publication state. The event may already be public.")); };
            });
        } finally { this.transactions--; }
    }
    read() { return this.transaction(); }
    change(update: (records: PublicationRecord[]) => PublicationRecord[]) { return this.transaction(update); }
}
