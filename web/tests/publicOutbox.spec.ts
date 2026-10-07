import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
test.use({ serviceWorkers: "block" });
const key = generateSecretKey();
const make = (content = "Isolated public outbox fixture") => finalizeEvent({ kind: 1, created_at: 1700000000, content, tags: [] }, key);
const urls = ["wss://one.example.com", "wss://two.example.com"];
async function setup(context: BrowserContext, page: Page) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const writes: { relay: string; id: string }[] = [], errors: string[] = [];
    const state = { acceptSecond: false };
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        return route.fulfill({ json: { entries: [], count: 0, note_ids: [], checked_at: Date.now(), targets: [], active_posts: 0, has_more: false, total: 0 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const frame = JSON.parse(String(message));
            if (frame[0] === "REQ") { socket.send(JSON.stringify(["EOSE", frame[1]])); return; }
            if (frame[0] === "CLOSE") return;
            expect(frame[0]).toBe("EVENT");
            const relay = socket.url().replace(/\/$/, ""); writes.push({ relay, id: frame[1].id });
            if (relay !== urls[1] || state.acceptSecond) socket.send(JSON.stringify(["OK", frame[1].id, true, ""]));
        });
    });
    await page.goto("/");
    return { writes, errors, state };
}
test("native outbox survives reload and read-cache clearing, then retries only unresolved destinations", async ({ context, page }) => {
    const fixture = await setup(context, page), event = make();
    await page.evaluate(async ({ event, urls }) => {
        // Vite development imports expose the actual storage and transport,
        // without adding a publication entry point to the product UI.
        // @ts-expect-error Development module URL.
        const { publicOutbox } = await import("/src/lib/publicOutbox.ts");
        sessionStorage.setItem("holoboard-payment:outbox-fixture", "preserved invoice session");
        await publicOutbox.enqueue(event, urls);
    }, { event, urls });
    expect(fixture.writes).toHaveLength(0);
    const first = await page.evaluate(async id => {
        // @ts-expect-error Development module URL.
        return (await import("/src/lib/publicOutbox.ts")).publicOutbox.send(id);
    }, event.id);
    expect(first.relays[urls[0]].state).toBe("accepted"); expect(first.relays[urls[1]].state).toBe("uncertain");
    await page.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("holoboard-nostr-read-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result, transaction = db.transaction("events", "readwrite"); transaction.objectStore("events").clear();
                transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => reject(transaction.error);
            };
        });
    });
    await page.reload();
    const records = await page.evaluate(async () => {
        // @ts-expect-error Development module URL.
        return (await import("/src/lib/publicOutbox.ts")).publicOutbox.list();
    });
    expect(records).toHaveLength(1); expect(records[0].id).toBe(event.id); expect(fixture.writes).toHaveLength(2);
    fixture.state.acceptSecond = true;
    const retried = await page.evaluate(async id => {
        // @ts-expect-error Development module URL.
        return (await import("/src/lib/publicOutbox.ts")).publicOutbox.send(id);
    }, event.id);
    expect(Object.values(retried.relays).every((outcome: { state: string }) => outcome.state === "accepted")).toBe(true);
    expect(fixture.writes).toEqual([{ relay: urls[0], id: event.id }, { relay: urls[1], id: event.id }, { relay: urls[1], id: event.id }]);
    expect(await page.evaluate(() => sessionStorage.getItem("holoboard-payment:outbox-fixture"))).toBe("preserved invoice session");
    expect(fixture.errors).toEqual([]);
});
test("a native transaction failure prevents sending and preserves the saved event", async ({ context, page }) => {
    const fixture = await setup(context, page), event = make();
    await page.evaluate(async ({ event, urls }) => {
        // @ts-expect-error Development module URL.
        const { publicOutbox } = await import("/src/lib/publicOutbox.ts");
        await publicOutbox.enqueue(event, urls);
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
            if (this.name === "holoboard-public-outbox-v1" && args[1] === "readwrite") throw new DOMException("Fixture storage quota", "QuotaExceededError");
            return transaction.apply(this, args);
        };
    }, { event, urls });
    const failure = await page.evaluate(async id => {
        // @ts-expect-error Development module URL.
        try { await (await import("/src/lib/publicOutbox.ts")).publicOutbox.send(id); return "unexpected success"; }
        catch (failure) { return failure instanceof Error ? failure.name : "failure"; }
    }, event.id);
    expect(failure).toBe("QuotaExceededError"); expect(fixture.writes).toHaveLength(0);
    await page.reload();
    const records = await page.evaluate(async () => {
        // @ts-expect-error Development module URL.
        return (await import("/src/lib/publicOutbox.ts")).publicOutbox.list();
    });
    expect(records[0]).toMatchObject({ id: event.id, attempts: 0 }); expect(fixture.errors).toEqual([]);
});
test("native transactions preserve concurrent enqueues from separate tabs", async ({ context, page }) => {
    const fixture = await setup(context, page), second = await context.newPage();
    await second.goto(new URL(test.info().project.use.baseURL!).origin);
    const events = [make("first tab"), make("second tab")];
    await Promise.all([page, second].map((tab, i) => tab.evaluate(async ({ event, urls }) => {
        // @ts-expect-error Development module URL.
        await (await import("/src/lib/publicOutbox.ts")).publicOutbox.enqueue(event, urls);
    }, { event: events[i], urls })));
    const records = await page.evaluate(async () => {
        // @ts-expect-error Development module URL.
        return (await import("/src/lib/publicOutbox.ts")).publicOutbox.list();
    });
    expect(records.map((record: { id: string }) => record.id).sort()).toEqual(events.map(event => event.id).sort());
    expect(fixture.writes).toHaveLength(0); expect(fixture.errors).toEqual([]);
});
