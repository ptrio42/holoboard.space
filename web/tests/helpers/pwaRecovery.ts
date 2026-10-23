import { expect, type Page } from "@playwright/test";

/** Inspect browser-native persistence without importing development modules. */
export async function privatePayments(page: Page) {
    return page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("holoboard-private-payments-v1");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise<{ backend: string; key: string; value: string }[]>((resolve, reject) => {
                const transaction = database.transaction("invoices", "readonly");
                const request = transaction.objectStore("invoices").getAll();
                transaction.oncomplete = () => resolve(request.result);
                transaction.onerror = () => reject(transaction.error);
            });
        } finally { database.close(); }
    });
}

/** Optional preview metadata may be dropped by an older compatible whitelist. */
export async function invoiceSnapshots(page: Page) {
    return (await privatePayments(page)).map(record => {
        const payment = JSON.parse(record.value);
        return { backend: record.backend, key: record.key, note: payment.note,
            board: payment.board, author: payment.author, event: payment.event,
            recoveryBackend: payment.recoveryBackend };
    });
}

/** Subscribe before checking for an update, then prove activation and SW navigation. */
export async function activateWorker(page: Page) {
    await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw new Error("Missing service worker");
        const changed = new Promise<void>(done => navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true }));
        await registration.update();
        await changed;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
    const navigation = await page.reload();
    expect(navigation?.fromServiceWorker()).toBe(true);
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
}

async function selectUnfinished(page: Page) {
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
}

/** The committed foundation uses categories, not guided task progress. */
export async function resumeFoundationPayment(page: Page) {
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Promotion editor", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Add to board progress", exact: true })).toHaveCount(0);
    await selectUnfinished(page);
}

export async function resumeGuidedPayment(page: Page) {
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    const progress = page.getByRole("navigation", { name: "Add to board progress", exact: true });
    await expect(progress.locator('[aria-current="step"]')).toContainText("Post");
    await expect(page.getByRole("tablist", { name: "Promotion editor", exact: true })).toHaveCount(0);
    await selectUnfinished(page);
    await expect(progress.locator('[aria-current="step"]')).toContainText("Payment");
}

/** Audit actual native values, including binary views and JSON nested in strings. */
export async function expectPrivateStorage(page: Page, nsec: string, unpaidEventId?: string) {
    const { decode } = await import("nostr-tools/nip19");
    const decoded = decode(nsec);
    if (decoded.type !== "nsec") throw new Error("Unexpected guest export format");
    const result = await page.evaluate(async ({ nsec, secret, unpaidEventId }) => {
        const hex = secret.map(byte => byte.toString(16).padStart(2, "0")).join("");
        const hasSecretBytes = (bytes: ArrayLike<number>) => {
            for (let offset = 0; offset <= bytes.length - secret.length; offset++) {
                if (secret.every((byte, index) => bytes[offset + index] === byte)) return true;
            }
            return false;
        };
        const audit = async (root: unknown) => {
            let secretFound = false, privateEventFound = false;
            const objects = new WeakSet<object>(), strings = new Set<string>();
            const inspect = async (value: unknown): Promise<void> => {
                if (typeof value === "string") {
                    if (strings.has(value)) return;
                    strings.add(value);
                    secretFound ||= value.includes("nsec1") || value.toLowerCase().includes(hex);
                    privateEventFound ||= !!unpaidEventId && value.includes(unpaidEventId);
                    // WebStorage values can contain JSON strings of indexed byte objects.
                    let parsed: unknown;
                    try { parsed = JSON.parse(value); } catch { return; }
                    await inspect(parsed);
                    return;
                }
                if (!value || typeof value !== "object" || objects.has(value)) return;
                objects.add(value);
                let bytes: Uint8Array | undefined;
                if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
                else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
                if (bytes) {
                    secretFound ||= hasSecretBytes(bytes);
                    await inspect(new TextDecoder().decode(bytes));
                    return;
                }
                if (value instanceof Map) {
                    for (const [key, entry] of value) { await inspect(key); await inspect(entry); }
                } else if (value instanceof Set) {
                    for (const entry of value) await inspect(entry);
                } else {
                    const entries = Object.entries(value);
                    const indexed = entries.filter(([key]) => /^(0|[1-9][0-9]*)$/.test(key)).sort(([a], [b]) => Number(a) - Number(b));
                    if (indexed.length && indexed.every(([key, byte], index) => Number(key) === index && Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)) {
                        secretFound ||= hasSecretBytes(indexed.map(([, byte]) => Number(byte)));
                    }
                    for (const [key, entry] of entries) { await inspect(key); await inspect(entry); }
                }
            };
            await inspect(root);
            return { secretFound, privateEventFound };
        };
        // Positive controls stay in memory. Never write the guest key to storage.
        const bytes = new Uint8Array(secret), padded = new Uint8Array(secret.length + 4);
        padded.set(bytes, 2);
        const samples = {
            nsec, hex, array: [...bytes], indexedObject: { ...bytes },
            arrayBuffer: bytes.buffer, typedView: padded.subarray(1, padded.length - 1),
            dataView: new DataView(padded.buffer, 1, padded.length - 2),
            nestedJson: JSON.stringify({ encoded: JSON.stringify({ ...bytes }) }),
            map: new Map([["key", bytes.buffer]]), set: new Set([bytes]), blob: new Blob([bytes]),
        };
        const positiveSamplesDetected: Record<string, boolean> = {};
        for (const [name, sample] of Object.entries(samples)) positiveSamplesDetected[name] = (await audit(sample)).secretFound;
        const cleanSampleAccepted = !(await audit({ ordinary: "Public post", amount: 210, bytes: new Uint8Array([1, 2, 3]) })).secretFound;
        let secretAbsent = !(await audit([Object.entries(localStorage), Object.entries(sessionStorage)])).secretFound;
        let privateEventAbsentFromPublicStores = true;
        for (const entry of await indexedDB.databases()) {
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(entry.name!);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                for (const name of database.objectStoreNames) {
                    const records = await new Promise<unknown[]>((resolve, reject) => {
                        const transaction = database.transaction(name);
                        const store = transaction.objectStore(name), request = store.getAll(), keys = store.getAllKeys();
                        transaction.oncomplete = () => resolve([keys.result, request.result]);
                        transaction.onerror = () => reject(transaction.error);
                    });
                    const checked = await audit(records);
                    secretAbsent &&= !checked.secretFound;
                    if (unpaidEventId && entry.name !== "holoboard-private-payments-v1") privateEventAbsentFromPublicStores &&= !checked.privateEventFound;
                }
            } finally { database.close(); }
        }
        return { secretAbsent, privateEventAbsentFromPublicStores, positiveSamplesDetected, cleanSampleAccepted };
    }, { nsec, secret: [...decoded.data], unpaidEventId });
    expect(result).toEqual({
        secretAbsent: true, privateEventAbsentFromPublicStores: true, cleanSampleAccepted: true,
        positiveSamplesDetected: { nsec: true, hex: true, array: true, indexedObject: true, arrayBuffer: true,
            typedView: true, dataView: true, nestedJson: true, map: true, set: true, blob: true },
    });
}
