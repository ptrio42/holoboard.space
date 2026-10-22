/** Private payment records never share the expendable public cache or outbox. */
export const PAYMENT_RECOVERY_DATABASE = "holoboard-private-payments-v1";
export const PAYMENT_RECOVERY_STORES = { invoices: "invoices", metadata: "metadata", attempts: "walletAttempts" } as const;
export interface PaymentRecoverySnapshot {
    payments: Map<string, string>;
    lastPayment: string | null;
}
export interface PaymentRecoveryStore {
    read(backend: string): Promise<PaymentRecoverySnapshot>;
    change(backend: string, update: (snapshot: PaymentRecoverySnapshot) => void): Promise<PaymentRecoverySnapshot>;
}

/** Synchronous update callbacks run inside a native read/write transaction.
 * Its completion, including all writes, establishes durability. The dedicated
 * attempts store belongs to the wallet coordinator, separate from invoices.
 */
export class IndexedPaymentRecoveryStore implements PaymentRecoveryStore {
    private opening?: Promise<IDBDatabase>;
    private database(): Promise<IDBDatabase> {
        if (this.opening) return this.opening;
        const opening = new Promise<IDBDatabase>((resolve, reject) => {
            if (typeof indexedDB === "undefined") { reject(new Error("Private payment storage is unavailable.")); return; }
            const request = indexedDB.open(PAYMENT_RECOVERY_DATABASE, 1);
            let ended = false;
            const fail = () => { ended = true; clearTimeout(timer); reject(new Error("Could not open private payment storage.")); };
            const timer = setTimeout(fail, 3000);
            request.onblocked = request.onerror = fail;
            request.onupgradeneeded = () => {
                if (ended) { request.transaction?.abort(); return; }
                for (const name of [PAYMENT_RECOVERY_STORES.invoices, PAYMENT_RECOVERY_STORES.attempts]) {
                    request.result.createObjectStore(name, { keyPath: ["backend", "key"] }).createIndex("backend", "backend");
                }
                request.result.createObjectStore(PAYMENT_RECOVERY_STORES.metadata, { keyPath: "backend" });
            };
            request.onsuccess = () => {
                clearTimeout(timer);
                if (ended) { request.result.close(); return; }
                ended = true;
                const database = request.result;
                database.onversionchange = () => { database.close(); this.opening = undefined; };
                resolve(database);
            };
        });
        this.opening = opening;
        void opening.catch(() => { if (this.opening === opening) this.opening = undefined; });
        return opening;
    }
    private async transaction(backend: string, update?: (snapshot: PaymentRecoverySnapshot) => void): Promise<PaymentRecoverySnapshot> {
        const database = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction([PAYMENT_RECOVERY_STORES.invoices, PAYMENT_RECOVERY_STORES.metadata], update ? "readwrite" : "readonly");
            const invoices = transaction.objectStore(PAYMENT_RECOVERY_STORES.invoices);
            const metadata = transaction.objectStore(PAYMENT_RECOVERY_STORES.metadata);
            const records = invoices.index("backend").getAll(backend);
            const pointer = metadata.get(backend);
            let result: PaymentRecoverySnapshot = { payments: new Map(), lastPayment: null };
            let failure: unknown;
            const timer = setTimeout(() => {
                failure = new Error("Private payment storage timed out.");
                try { transaction.abort(); } catch { reject(failure); }
            }, 3000);
            let remaining = 2;
            const read = () => {
                if (--remaining) return;
                try {
                    result = {
                        payments: new Map(records.result.flatMap((record: { backend?: unknown; key?: unknown; value?: unknown }) =>
                            record?.backend === backend && typeof record.key === "string" && typeof record.value === "string" ? [[record.key, record.value] as const] : [])),
                        lastPayment: typeof pointer.result?.lastPayment === "string" ? pointer.result.lastPayment : null,
                    };
                    if (!update) return;
                    const before = new Map(result.payments);
                    update(result);
                    for (const [key, value] of result.payments) {
                        if (before.get(key) !== value) invoices.put({ backend, key, value });
                    }
                    for (const key of before.keys()) if (!result.payments.has(key)) invoices.delete([backend, key]);
                    metadata.put({ backend, lastPayment: result.lastPayment });
                } catch (error) { failure = error; transaction.abort(); }
            };
            records.onsuccess = pointer.onsuccess = read;
            transaction.oncomplete = () => { clearTimeout(timer); resolve(result); };
            transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(failure ?? new Error("Private payment storage did not commit.")); };
        });
    }
    /** Wallet hashes are origin-wide, independent of any invoice API backend. */
    async readWalletAttempts(): Promise<Map<string, unknown>> {
        return this.walletTransaction();
    }
    async changeWalletAttempt(hash: string, update: (record: unknown) => unknown): Promise<unknown> {
        return (await this.walletTransaction(hash, update)).get(hash);
    }
    private async walletTransaction(hash?: string, update?: (record: unknown) => unknown): Promise<Map<string, unknown>> {
        const database = await this.database();
        const namespace = "origin-wallet-attempts-v1";
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(PAYMENT_RECOVERY_STORES.attempts, update ? "readwrite" : "readonly", { durability: "strict" });
            const store = transaction.objectStore(PAYMENT_RECOVERY_STORES.attempts);
            const request = hash ? store.get([namespace, hash]) : store.index("backend").getAll(namespace);
            const result = new Map<string, unknown>();
            let failure: unknown;
            const timer = setTimeout(() => {
                failure = new Error("Private wallet storage timed out.");
                try { transaction.abort(); } catch { reject(failure); }
            }, 3000);
            request.onsuccess = () => {
                try {
                    if (hash) {
                        // A present, malformed envelope must never look absent.
                        const previous = request.result === undefined ? undefined : request.result?.value ?? null;
                        const next = update ? update(previous) : previous;
                        if (next !== undefined) {
                            result.set(hash, next);
                            if (update) store.put({ backend: namespace, key: hash, value: next });
                        }
                    } else for (const record of request.result) {
                        if (record?.backend === namespace && typeof record.key === "string") result.set(record.key, record.value ?? null);
                    }
                } catch (error) { failure = error; transaction.abort(); }
            };
            transaction.oncomplete = () => { clearTimeout(timer); resolve(result); };
            transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(failure ?? new Error("Private wallet storage did not commit.")); };
        });
    }
    read(backend: string) { return this.transaction(backend); }
    change(backend: string, update: (snapshot: PaymentRecoverySnapshot) => void) { return this.transaction(backend, update); }
}
