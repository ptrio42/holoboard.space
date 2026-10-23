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

/** Audit every native store without returning private author material to reports. */
export async function expectPrivateStorage(page: Page, nsec: string, unpaidEventId?: string) {
    const { decode } = await import("nostr-tools/nip19");
    const decoded = decode(nsec);
    if (decoded.type !== "nsec") throw new Error("Unexpected guest export format");
    const forbidden = [nsec, Buffer.from(decoded.data).toString("hex"), JSON.stringify([...decoded.data]), JSON.stringify(decoded.data)];
    const result = await page.evaluate(async ({ forbidden, unpaidEventId }) => {
        const webStorage = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
        let secretAbsent = !webStorage.includes("nsec1") && forbidden.every(value => !webStorage.includes(value));
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
                        const request = transaction.objectStore(name).getAll();
                        transaction.oncomplete = () => resolve(request.result);
                        transaction.onerror = () => reject(transaction.error);
                    });
                    const serialized = JSON.stringify(records);
                    secretAbsent &&= !serialized.includes("nsec1") && forbidden.every(value => !serialized.includes(value));
                    if (unpaidEventId && entry.name !== "holoboard-private-payments-v1") privateEventAbsentFromPublicStores &&= !serialized.includes(unpaidEventId);
                }
            } finally { database.close(); }
        }
        return { secretAbsent, privateEventAbsentFromPublicStores };
    }, { forbidden, unpaidEventId });
    expect(result).toEqual({ secretAbsent: true, privateEventAbsentFromPublicStores: true });
}
