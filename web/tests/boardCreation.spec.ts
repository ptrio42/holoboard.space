import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { neventEncode, noteEncode } from "nostr-tools/nip19";
import { matchFilter } from "nostr-tools/filter";
import { walletInvoice } from "./helpers/walletFixture";
import { captureGuidedStage, guidedViewports, shortContribution, longContribution } from "./helpers/guidedAcceptance";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
test.skip(process.env.VITE_ENABLE_POST_CREATION !== "true", "Requires the independent creation release gate");
const originalKey = generateSecretKey();
const original = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: "Original source for a quote." }, originalKey);
const unrelatedOriginal = finalizeEvent({ kind: 1, created_at: 1700000001, tags: [], content: "A different post must not replace the requested original." }, originalKey);
const accountKey = generateSecretKey(), accountPubkey = getPublicKey(accountKey);
const boardHash = "b".repeat(64);
const compositionEvidence = new WeakMap<BrowserContext, {
    signerRequests: string[]; reviewedIds: string[]; requests: Record<string, unknown>[]; frames: string[];
}>();

test.afterEach(async ({ context }, info) => {
    const state = compositionEvidence.get(context);
    if (state) await info.attach("composer-evidence", { contentType: "application/json", body: JSON.stringify({
        signerRequests: state.signerRequests, reviewedIds: state.reviewedIds,
        invoiceIds: state.requests.map(request => (request.event as Event | undefined)?.id ?? request.note),
        publicationFrames: state.frames,
    }, null, 2) });
});

async function installExtension(context: BrowserContext, page: Page, getPubkey = async () => accountPubkey, sign = (template: EventTemplate) => finalizeEvent(template, accountKey)) {
    await page.exposeFunction("boardFixturePublicKey", getPubkey);
    await page.exposeFunction("boardFixtureSignEvent", (template: EventTemplate) => {
        const event = sign(template);
        compositionEvidence.get(context)?.signerRequests.push(event.id);
        return event;
    });
    await context.addInitScript(() => {
        const fixture = window as unknown as {
            boardFixturePublicKey(): Promise<string>;
            boardFixtureSignEvent(template: EventTemplate): Promise<Event>;
        };
        Object.assign(window, { nostr: {
            getPublicKey: () => fixture.boardFixturePublicKey(),
            signEvent: (template: EventTemplate) => fixture.boardFixtureSignEvent(template),
        } });
    });
}

async function setup(context: BrowserContext, page: Page, options: { authorWallet?: boolean; previewFailures?: number; mismatchedPreviews?: number; longAuthor?: boolean } = {}) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const state = { previewCalls: 0, previewFailures: options.previewFailures ?? 0, requests: [] as Record<string, unknown>[], signerRequests: [] as string[], reviewedIds: [] as string[], signed: undefined as Event | undefined, paid: false, frames: [] as string[], errors: [] as string[], links: [] as string[], statusChecks: 0, pauseBoard: false, releaseBoard: undefined as (() => void) | undefined };
    compositionEvidence.set(context, state);
    page.on("pageerror", error => state.errors.push(error.message));
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
        let data: unknown = {};
        if (url.pathname === "/api/board/campaigns") data = { entries: [{ id: original.id, event: original, rank: 1, sats_paid: 100, weight: 100 }], targets: [], total: 1, active_posts: 1, has_more: false, total_sats: 100 };
        else if (url.pathname === "/api/board/waiting-updates") data = { count: 0, note_ids: [], checked_at: Date.now() };
        else if (url.pathname === "/api/promote/preview") {
            state.previewCalls++;
            if (state.previewFailures > 0) {
                state.previewFailures--;
                return route.fulfill({ status: 503, headers, json: { error: "Original preview temporarily unavailable" } });
            }
            const event = state.previewCalls <= (options.mismatchedPreviews ?? 0) ? unrelatedOriginal : body.event ?? (body.note === state.signed?.id ? state.signed : original);
            if (body.event) {
                expect(verifyEvent(body.event)).toBe(true); state.signed = body.event;
                if (!state.reviewedIds.includes(body.event.id)) state.reviewedIds.push(body.event.id);
            }
            data = { event, active: state.paid && event.id === state.signed?.id, sats_paid: state.paid && event.id === state.signed?.id ? 210 : 0, weight: 0, rank: 0, author_share: options.authorWallet ? 20 : 0, billboard_fee_sats: 100, images: [] };
        } else if (url.pathname === "/api/support") data = { available: !!options.authorWallet, author: body.event?.pubkey ?? original.pubkey, reason_code: options.authorWallet ? undefined : "no_address", reason: options.authorWallet ? undefined : "No payment address", min_sats: 1, max_sats: options.authorWallet ? 10000000 : 0, allows_nostr: false };
        else if (url.pathname === "/api/promote") {
            state.requests.push(body);
            if (state.pauseBoard) await new Promise<void>(resolve => { state.releaseBoard = resolve; });
            const fee = body.billboard ? 100 : 0;
            data = { invoice: walletInvoice({ hash: boardHash, amountMsats: (body.amount_sats + fee) * 1000 }), payment_hash: boardHash, amount_sats: body.amount_sats + fee, promotion_sats: body.amount_sats, note_id: body.event?.id ?? original.id, expires_at: Math.floor(Date.now() / 1000) + 3600, billboard_fee_sats: fee };
        } else if (url.pathname === "/api/promote/status") { state.statusChecks++; data = { pending: !state.paid, settled: state.paid, publication: state.paid ? "pending" : undefined, receipt: state.paid ? { promotion_sats: 210 } : undefined }; }
        else if (url.pathname === "/api/link-preview") { state.links.push(url.searchParams.get("url")!); data = { url: url.searchParams.get("url"), title: "An ordinary page", description: "Link preview" }; }
        return route.fulfill({ headers, json: data });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(raw => {
            const frame = JSON.parse(String(raw));
            if (frame[0] === "CLOSE") return;
            if (frame[0] !== "REQ") { state.frames.push(frame[0]); return; }
            if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, original))) socket.send(JSON.stringify(["EVENT", frame[1], original]));
            if (options.longAuthor) {
                const metadata = finalizeEvent({ kind: 0, created_at: 1700000001, tags: [], content: JSON.stringify({ name: "Community maker with a deliberately long public author identity for a narrow screen" }) }, originalKey);
                if (frame.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, metadata))) socket.send(JSON.stringify(["EVENT", frame[1], metadata]));
            }
            socket.send(JSON.stringify(["EOSE", frame[1]]));
        });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    return state;
}

test("guest text and links become one private signed post with recoverable invoices", async ({ context, page }, info) => {
    await page.setViewportSize({ width: 390, height: 664 });
    const state = await setup(context, page);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    const text = "A new post about https://example.com/story and https://example.com/other";
    await dialog.getByRole("textbox", { name: "Text or link" }).fill(text);
    await expect(dialog.locator(".note-link-preview")).toHaveCount(1);
    await dialog.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Text or link" })).toHaveCount(0);
    await expect(dialog.getByRole("navigation", { name: "Add to board progress" }).locator('[aria-current="step"]')).toContainText("Budget");
    await expect(dialog.getByRole("group", { name: "Complete total", exact: true })).toContainText("210 sats");
    expect(state.requests).toHaveLength(0); expect(state.frames).toEqual([]);
    const reviewedId = state.signed!.id;
    await dialog.getByRole("button", { name: "Post", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Text or link" })).toHaveValue(text);
    await dialog.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    expect(state.signed!.id).toBe(reviewedId);
    expect(state.reviewedIds).toEqual([reviewedId]); expect(state.requests).toHaveLength(0); expect(state.frames).toEqual([]);
    await expect(dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: /^Billboard appearance/ }).click();
    await expect(dialog.getByRole("article")).toHaveCount(1);
    await expect(dialog.getByRole("link", { name: "Discussion", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Note options", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "< Back to budget", exact: true }).click();
    await dialog.getByText("Post author", { exact: true }).click();
    await dialog.getByRole("button", { name: "Save author key", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Copy private author key" })).toBeVisible();
    for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        await expect(dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`guest-${width}.png`) });
    }
    await dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Payment recipients", exact: true })
        .getByRole("group", { name: "Holoboard visibility payment", exact: true })).toContainText("210 sats");
    expect(state.requests).toHaveLength(1);
    const submitted = state.requests[0].event as Event;
    expect(verifyEvent(submitted)).toBe(true); expect(submitted.content).toBe(text);
    expect(state.requests[0].author_share).toBe(0);
    expect(state.frames).toEqual([]);
    const persisted = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    expect(persisted).not.toContain("nsec1");
    const savedInvoices = await page.evaluate(async () => {
        const { IndexedPaymentRecoveryStore } = await import("/src/lib/paymentRecoveryStore.ts");
        const { paymentBackendKey } = await import("/src/lib/paymentSession.ts");
        const snapshot = await new IndexedPaymentRecoveryStore().read(paymentBackendKey);
        return [...snapshot.payments.values()].map(value => JSON.parse(value));
    });
    expect(savedInvoices).toHaveLength(1);
    // Invoice JSON excludes nostr-tools' in-memory verification symbol.
    expect(savedInvoices[0].event).toEqual(JSON.parse(JSON.stringify(submitted)));
    expect(verifyEvent(savedInvoices[0].event)).toBe(true);
    expect(JSON.stringify(savedInvoices)).not.toContain("nsec1");
    await page.reload();
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(page.getByText("Unfinished payments", { exact: true })).toBeVisible();
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: /Resume/ }).first().click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    state.paid = true;
    await expect(page.getByLabel("Promotion result")).toContainText("Delivery to other apps is pending");
    await expect(dialog.getByRole("group", { name: "Holoboard payment", exact: true })).toContainText("Payment verified");
    expect(state.signed?.id).toBe(submitted.id); expect(state.errors).toEqual([]);
    expect(state.signerRequests).toEqual([]); expect(state.reviewedIds).toEqual([submitted.id]);
});

test("guest invoices survive a closed tab and explicit recovery in a fresh page", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Recover this private guest invoice after closing its tab");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    const event = state.requests[0].event as Event;
    const invoice = await page.getByRole("link", { name: "Open in wallet", exact: true }).getAttribute("href");
    const qr = page.getByRole("img", { name: "Holoboard visibility invoice QR code" });
    await expect(qr).toBeVisible();
    const qrMarkup = await qr.evaluate(element => element.outerHTML);
    await page.close();

    const fresh = await context.newPage();
    fresh.on("pageerror", error => state.errors.push(error.message));
    await fresh.goto("/");
    expect(await fresh.evaluate(() => sessionStorage.getItem("holoboard-last-payment"))).toBeNull();
    await fresh.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(fresh.getByRole("textbox", { name: "Text or link" })).toHaveValue("");
    await expect(fresh.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    await fresh.getByText("Unfinished payments", { exact: true }).click();
    await fresh.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(fresh.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    await expect(fresh.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", invoice!);
    const restoredQr = fresh.getByRole("img", { name: "Holoboard visibility invoice QR code" });
    await expect(restoredQr).toBeVisible();
    expect(await restoredQr.evaluate(element => element.outerHTML)).toBe(qrMarkup);
    await fresh.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { Object.assign(window, { copiedInvoice: value }); return Promise.resolve(); } } }));
    await fresh.getByRole("button", { name: "Copy invoice", exact: true }).click();
    expect(await fresh.evaluate(() => (window as unknown as { copiedInvoice: string }).copiedInvoice)).toBe(invoice!.slice("lightning:".length));
    const restored = await fresh.evaluate(async note => {
        const records = await import("/src/components/PromoteModal/paymentRecords.ts");
        const { nostrCache } = await import("/src/lib/nostrCache.ts");
        if (nostrCache.hasRetained(note)) throw new Error("Private invoice event leaked into the public read cache");
        return records.restorePayment(note);
    }, event.id);
    expect(restored?.event).toEqual(event);
    expect(restored?.board.paymentHash).toBe(boardHash);
    expect(state.requests).toHaveLength(1);
    expect(state.frames).toEqual([]);
    expect(state.errors).toEqual([]);
});

test("blocked private storage keeps invoice actions and explicit in-page recovery available", async ({ context, page }) => {
    await context.addInitScript(() => Object.defineProperty(IDBFactory.prototype, "open", { configurable: true, value: () => { throw new DOMException("Blocked", "SecurityError"); } }));
    const state = await setup(context, page);
    expect(await page.evaluate(() => { try { indexedDB.open("blocked-fixture-diagnostic"); return false; } catch { return true; } })).toBe(true);
    expect(await page.evaluate(async () => (await import("/src/lib/paymentSession.ts")).getPaymentSessionStatus().failed)).toBe(true);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this invoice usable when private storage is blocked");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    await expect(page.getByText("This browser could not save this payment for recovery after closing the tab.", { exact: false })).toBeVisible();
    const invoice = await page.getByRole("link", { name: "Open in wallet", exact: true }).getAttribute("href");
    await expect(page.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", invoice!);
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("older invoice copies stay accessible without assigning a backend or checking their status", async ({ context, page }) => {
    const invoice = walletInvoice({ hash: boardHash, amountMsats: 168000 });
    const authorInvoice = walletInvoice({ hash: "a".repeat(64), amountMsats: 42000 });
    const legacy = { note: original.id, board: { invoice, paymentHash: boardHash, noteId: original.id, amountSats: 168 },
        author: { invoice: authorInvoice, payment_hash: "a".repeat(64), amount_sats: 42 } };
    await context.addInitScript(({ key, value }) => { sessionStorage.setItem(key, value); sessionStorage.setItem("holoboard-last-payment", key); },
        { key: `holoboard-payment:${original.id}`, value: JSON.stringify(legacy) });
    const state = await setup(context, page);
    await expect(page.getByText("Unfinished payments", { exact: true })).toHaveCount(0);
    await page.getByText("Older invoices", { exact: true }).click();
    for (const [label, amount, value] of [["Holoboard", 168, invoice], ["Author", 42, authorInvoice]] as const) {
        await page.getByText(`${label}: ${amount} sats`, { exact: true }).click();
        const part = page.getByLabel(`Older ${label} invoice`, { exact: true });
        await expect(part.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", `lightning:${value}`);
        await expect(part.getByRole("img", { name: `Older ${label} invoice QR code` })).toBeVisible();
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { Object.assign(window, { copiedInvoice: value }); return Promise.resolve(); } } }));
        await part.getByRole("button", { name: "Copy invoice", exact: true }).click();
        expect(await page.evaluate(() => (window as unknown as { copiedInvoice: string }).copiedInvoice)).toBe(value);
    }
    const retained = await page.evaluate(async note => {
        const session = await import("/src/lib/paymentSession.ts");
        return { raw: sessionStorage.getItem(`holoboard-payment:${note}`), imported: session.readPaymentSession(`holoboard-payment:${note}`) };
    }, original.id);
    expect(retained.raw).toBe(JSON.stringify(legacy)); expect(retained.imported).toBeNull();
    expect(state.requests).toHaveLength(0); expect(state.statusChecks).toBe(0); expect(state.signed).toBeUndefined();
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("late updates from another page stay with their original archived invoice", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this original invoice immutable across pages");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    const event = state.requests[0].event as Event;
    const other = await context.newPage();
    await other.goto("/");
    await other.evaluate(async note => {
        const session = await import("/src/lib/paymentSession.ts");
        const records = await import("/src/components/PromoteModal/paymentRecords.ts");
        await session.initializePaymentSessions();
        const old = records.restorePayment(note)!;
        await records.savePayment({ ...old, board: { ...old.board, invoice: "lnbc-new", paymentHash: "c".repeat(64) } });
        await records.savePayment({ ...old, event: undefined, note: "d".repeat(64), board: { ...old.board, noteId: "d".repeat(64), invoice: "lnbc-other", paymentHash: "e".repeat(64) } });
    }, event.id);
    await page.evaluate(async ({ note, hash }) => {
        const records = await import("/src/components/PromoteModal/paymentRecords.ts");
        const stale = records.restorePayment(note)!;
        await records.updateSavedPayment(note, hash, { promotionPaid: true, added: 210 });
        await records.savePayment({ ...stale, promotionPaid: true, added: 210 }, false);
    }, { note: event.id, hash: boardHash });
    const saved = await other.evaluate(async note => {
        const { IndexedPaymentRecoveryStore } = await import("/src/lib/paymentRecoveryStore.ts");
        const { paymentBackendKey } = await import("/src/lib/paymentSession.ts");
        const snapshot = await new IndexedPaymentRecoveryStore().read(paymentBackendKey);
        return { current: JSON.parse(snapshot.payments.get(`holoboard-payment:${note}`)!),
            archived: JSON.parse(snapshot.payments.get(`holoboard-payment:${note}:${"b".repeat(64)}`)!), last: snapshot.lastPayment };
    }, event.id);
    expect(saved.current.board.paymentHash).toBe("c".repeat(64)); expect(saved.current.promotionPaid).toBe(false);
    expect(saved.archived.event).toEqual(event); expect(saved.archived.promotionPaid).toBe(true);
    expect(saved.last).toBe(`holoboard-payment:${"d".repeat(64)}`);
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("a delayed resume locks source choices and cannot replace a draft after closing", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Saved payment A");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    const event = state.requests[0].event as Event;
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.evaluate(async ({ source, otherNote }) => {
        const records = await import("/src/components/PromoteModal/paymentRecords.ts");
        const saved = records.restorePayment(source)!;
        await records.savePayment({ ...saved, note: otherNote, event: undefined, noteSummary: "Saved payment B",
            board: { ...saved.board, noteId: otherNote, paymentHash: "c".repeat(64), invoice: "lnbc-saved-B" } });
    }, { source: event.id, otherNote: original.id });
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await page.getByText("Unfinished payments", { exact: true }).click();
    const resumeA = page.getByText("Saved payment A", { exact: true }).locator("..").getByRole("button", { name: "Resume payment", exact: true });
    const resumeB = page.getByText("Saved payment B", { exact: true }).locator("..").getByRole("button", { name: "Resume payment", exact: true });
    await page.evaluate(async () => {
        const { IndexedPaymentRecoveryStore } = await import("/src/lib/paymentRecoveryStore.ts");
        const originalChange = IndexedPaymentRecoveryStore.prototype.change;
        const fixture = { waiting: false, release: () => {} };
        Object.assign(window, { resumeStorageFixture: fixture });
        IndexedPaymentRecoveryStore.prototype.change = async function(backend, update) {
            IndexedPaymentRecoveryStore.prototype.change = originalChange;
            fixture.waiting = true;
            await new Promise<void>(resolve => { fixture.release = resolve; });
            return originalChange.call(this, backend, update);
        };
    });
    await resumeA.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { resumeStorageFixture: { waiting: boolean } }).resumeStorageFixture.waiting)).toBe(true);
    try {
        await expect(page.getByRole("textbox", { name: "Text or link" })).toBeDisabled();
        await expect(resumeB).toBeDisabled();
        await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeDisabled();
        if (process.env.VITE_ENABLE_NOSTR_CONNECT === "true") await expect(page.getByRole("button", { name: "Use a Nostr account", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Close dialog", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Close dialog", exact: true }).click();
        await page.getByRole("button", { name: "Add to board", exact: true }).click();
        await page.getByRole("textbox", { name: "Text or link" }).fill("Draft B while the closed editor finishes saving");
    } finally {
        await page.evaluate(() => (window as unknown as { resumeStorageFixture: { release(): void } }).resumeStorageFixture.release());
    }
    await expect.poll(() => page.evaluate(async () => (await import("/src/lib/paymentSession.ts")).getPaymentSessionStatus().saving)).toBe(false);
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("Draft B while the closed editor finishes saving");
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeEnabled();
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("original and quote interpretation remain explicit and have separate paid IDs", async ({ context, page }) => {
    const state = await setup(context, page);
    const field = page.getByRole("textbox", { name: "Text or link" });
    await field.fill(original.id);
    await expect(page.getByText("Original post", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add a comment" }).click();
    await field.fill(`My comment nostr:${neventEncode({ id: original.id })}`);
    await field.fill(`nostr:${neventEncode({ id: original.id })}`);
    await expect(page.getByText("Your post", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    expect(state.requests).toHaveLength(1);
    const paid = state.requests[0].event as Event;
    expect(paid.id).not.toBe(original.id);
    expect(state.requests[0].note).toBe(paid.id);
    expect(paid.tags).toContainEqual(["q", original.id, "", original.pubkey]);
    expect(paid.tags.some(tag => tag[0] === "e")).toBe(false);
    expect(state.signerRequests).toEqual([]); expect(state.reviewedIds).toEqual([paid.id]);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("an arbitrary URL containing a note ID remains a new link post", async ({ context, page }) => {
    const state = await setup(context, page);
    const url = `https://example.com/${noteEncode(original.id)}`;
    await page.getByRole("textbox", { name: "Text or link" }).fill(url);
    await expect(page.getByText("Your post", { exact: true })).toBeVisible();
    await expect(page.locator(".note-link-preview")).toHaveCount(1);
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    expect(state.signed?.content).toBe(url);
    expect(state.signed?.tags.some(tag => tag[0] === "q")).toBe(false);
    expect(state.links).toEqual([url]);
});

test("the general action opens blank and resumes an original only after selection", async ({ context, page }) => {
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill(noteEncode(original.id));
    await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Add to board", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("");
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toHaveCount(0);
    await page.getByText("Unfinished payments", { exact: true }).click();
    await page.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].event).toBeUndefined();
    expect(state.frames).toEqual([]);
});

test("Nostr sign-in preserves text and payment choices and can post anonymously", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    await installExtension(context, page);
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("A post from an existing Nostr account");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("textbox", { name: "Custom total in sats" }).fill("333");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.getByRole("button", { name: "Use a Nostr account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with email", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create account", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect(page.getByText("Posting with your Nostr account.", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Text or link" })).toHaveValue("A post from an existing Nostr account");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 333 sats", exact: true })).toBeEnabled();
    expect(state.signed?.pubkey).toBe(accountPubkey);
    expect(state.signed?.tags.some(tag => tag[0] === "l")).toBe(false);
    await expect(page.getByRole("textbox", { name: "Custom total in sats" })).toHaveValue("333");
    const accountPost = state.signed!;
    expect(state.signerRequests).toEqual([accountPost.id]);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.getByText("Author details", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Post anonymously", exact: true }).check();
    await expect(page.getByText("Posting as a guest. No account required.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 333 sats", exact: true })).toBeEnabled();
    expect(state.signed?.pubkey).not.toBe(accountPubkey);
    expect(state.signed?.tags).toContainEqual(["l", "anonymous", "space.holoboard.attribution"]);
    expect(state.signerRequests).toEqual([accountPost.id]);
    expect(state.reviewedIds).toHaveLength(3);
    expect(state.reviewedIds.slice(1)).toEqual([accountPost.id, state.signed!.id]);
    expect(state.requests).toEqual([]);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("late Nostr sign-in preserves already prepared guest invoices", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    let approve!: () => void;
    await installExtension(context, page, () => new Promise<string>(resolve => { approve = () => resolve(accountPubkey); }));
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this guest invoice immutable");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await page.getByText("Post author", { exact: true }).click();
    await page.getByRole("button", { name: "Use a Nostr account", exact: true }).click();
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect.poll(() => typeof approve).toBe("function");
    try {
        await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
        await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    } finally { approve(); }
    const guest = state.requests[0].event as Event;
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("holoboard-signer") ?? "null")?.pubkey)).toBe(accountPubkey);
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    expect(guest.pubkey).not.toBe(accountPubkey);
    state.paid = true;
    await expect(page.getByLabel("Promotion result")).toBeVisible();
    await page.getByRole("button", { name: "Make another payment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toHaveCount(0);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].event).toEqual(guest);
    expect(state.signerRequests).toEqual([]); expect(state.reviewedIds).toEqual([guest.id]);
    expect(state.frames).toEqual([]);
    expect(state.errors).toEqual([]);
});

test("Nostr sign-in during invoice preparation keeps the frozen guest post", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    let approve!: () => void;
    await installExtension(context, page, () => new Promise<string>(resolve => { approve = () => resolve(accountPubkey); }));
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill("Keep this post while the invoice is prepared");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await page.getByText("Post author", { exact: true }).click();
    await page.getByRole("button", { name: "Use a Nostr account", exact: true }).click();
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect.poll(() => typeof approve).toBe("function");
    state.pauseBoard = true;
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect.poll(() => typeof state.releaseBoard).toBe("function");
    const guest = state.requests[0].event as Event;
    try {
        approve();
        await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("holoboard-signer") ?? "null")?.pubkey)).toBe(accountPubkey);
    } finally { state.releaseBoard!(); }
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    expect(state.requests).toHaveLength(1);
    expect(guest.pubkey).not.toBe(accountPubkey);
    expect(state.requests[0].note).toBe(guest.id);
    expect(state.requests[0].event).toEqual(guest);
    expect(state.signerRequests).toEqual([]); expect(state.reviewedIds).toEqual([guest.id]);
    expect(state.frames).toEqual([]);
    expect(state.errors).toEqual([]);
});

for (const phase of ["pending attempt commit", "committed attempt before send", "sent without response"] as const) test(`wallet recovery after tab closure during ${phase}`, async ({ context, page }) => {
    let sends = 0;
    await context.exposeBinding("recoveryFixtureSend", () => { sends++; return new Promise(() => {}); });
    await context.addInitScript(() => {
        Object.assign(window, { webln: { enable: async () => {}, sendPayment: () => (window as unknown as { recoveryFixtureSend(): Promise<unknown> }).recoveryFixtureSend() } });
    });
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill(`Recovery at ${phase}`);
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Payment method", exact: true })).toBeVisible();
    const originalInvoice = await page.getByRole("link", { name: "Open in wallet", exact: true }).getAttribute("href");
    if (phase !== "sent without response") await page.evaluate(phase => {
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
            const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
            const data = value as { value?: unknown };
            const target = phase === "pending attempt commit" ? this.name === "walletAttempts" && (data.value as { attempt?: { state?: string } })?.attempt?.state === "uncertain"
                : this.name === "invoices" && typeof data.value === "string" && data.value.includes('"state":"uncertain"');
            if (target) {
                Object.assign(window, { recoveryWritePending: true });
                // Keep a real native transaction uncommitted until this page closes.
                const hold = () => { const keepalive = this.get(key ?? (this.name === "walletAttempts" ? ["origin-wallet-attempts-v1", (value as { key: string }).key] : [(value as { backend: string }).backend, (value as { key: string }).key])); keepalive.onsuccess = hold; };
                hold();
            }
            return request;
        };
    }, phase);
    await page.getByRole("tab", { name: "Wallet", exact: true }).click();
    await page.getByRole("button", { name: "Pay 210 sats", exact: true }).click();
    if (phase === "sent without response") await expect.poll(() => sends).toBe(1);
    else await expect.poll(() => page.evaluate(() => (window as unknown as { recoveryWritePending?: boolean }).recoveryWritePending)).toBe(true);
    expect(sends).toBe(phase === "sent without response" ? 1 : 0);
    await page.close();

    const fresh = await context.newPage();
    await fresh.goto("/");
    await fresh.getByRole("button", { name: "Add to board", exact: true }).click();
    await fresh.getByText("Unfinished payments", { exact: true }).click();
    await fresh.getByRole("button", { name: "Resume payment", exact: true }).click();
    await fresh.getByRole("tab", { name: "Invoice / QR", exact: true }).click();
    await expect(fresh.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", originalInvoice!);
    await expect(fresh.getByRole("button", { name: "Copy invoice", exact: true })).toBeEnabled();
    await expect(fresh.getByRole("img", { name: "Holoboard visibility invoice QR code" })).toBeVisible();
    const record = await fresh.evaluate(async hash => {
        const store = await import("/src/lib/paymentRecoveryStore.ts");
        return (await new store.IndexedPaymentRecoveryStore().readWalletAttempts()).get(hash);
    }, boardHash);
    if (phase !== "pending attempt commit") expect(record).toMatchObject({ attempt: { state: "uncertain", walletId: "webln" } });
    const result = record ? await fresh.evaluate(async hash => {
        const ledger = await import("/src/lib/walletAttempts.ts");
        const payments = await import("/src/lib/walletPayment.ts");
        await ledger.initializeWalletAttempts();
        let sends = 0;
        try { await payments.payInvoiceSafely({ id: "different-wallet", kind: "nwc", enable: async () => {}, sendPayment: async () => { sends++; return {}; } }, "invoice", hash, undefined, async () => {}); }
        catch (error) { return { sends, error: (error as Error).message, attempt: ledger.getWalletAttempt(hash) }; }
        return { sends, error: "", attempt: ledger.getWalletAttempt(hash) };
    }, boardHash) : undefined;
    // A pending native transaction may abort on closure. Only committed attempts
    // protect a hash that never reached send, while all sent attempts must survive.
    if (record) { expect(record).toMatchObject({ invoice: originalInvoice!.slice("lightning:".length) }); expect(result!.sends).toBe(0); expect(result!.error).toContain("original wallet"); }
    expect(sends).toBe(phase === "sent without response" ? 1 : 0);
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});


for (const length of ["short", "long"] as const) test(`guided actual acceptance with ${length} ordinary-link content`, async ({ context, page }, info) => {
    test.setTimeout(180000);
    const state = await setup(context, page);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    const text = length === "short" ? shortContribution : longContribution;
    await dialog.getByRole("textbox", { name: "Text or link", exact: true }).fill(text);
    await expect(dialog.locator(".note-link-container")).toHaveCount(1);
    await dialog.locator(".note-link-container").scrollIntoViewIfNeeded();
    await expect(dialog.locator(".note-link-preview")).toHaveCount(1);
    await expect(dialog.locator('.note-link-preview')).toHaveAttribute("href", "https://example.com/story");
    if (process.env.VITE_ENABLE_NOSTR_CONNECT !== "true") {
        await expect(dialog.getByRole("button", { name: /Nostr account|Account settings|Connect Nostr/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    }
    const measurements = [];
    for (const viewport of guidedViewports) measurements.push(await captureGuidedStage(page, info, "post", viewport));
    await dialog.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    const reviewed = JSON.parse(JSON.stringify(state.signed!)) as Event;
    expect(verifyEvent({ ...reviewed })).toBe(true);
    await expect(dialog.getByText("All of this amount goes to visibility.", { exact: true })).toBeVisible();
    for (const viewport of guidedViewports) measurements.push(await captureGuidedStage(page, info, "budget", viewport));
    await dialog.getByRole("button", { name: /^Billboard appearance/ }).click();
    await dialog.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    for (const viewport of guidedViewports) measurements.push(await captureGuidedStage(page, info, "appearance", viewport));
    await dialog.getByRole("button", { name: "Standard / free", exact: true }).click();
    await dialog.getByRole("button", { name: "< Back to budget", exact: true }).click();
    await dialog.getByRole("button", { name: "Custom", exact: true }).click();
    const custom = dialog.getByRole("textbox", { name: "Custom total in sats", exact: true });
    await expect(custom).toBeFocused();
    expect(await custom.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, 3]);
    await page.keyboard.press("Backspace");
    await expect(custom).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Enter amount", exact: true })).toBeDisabled();
    await custom.fill("0");
    await expect(custom).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("button", { name: "Enter amount", exact: true })).toBeDisabled();
    await custom.fill("210");
    await dialog.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    const qr = dialog.getByRole("img", { name: "Holoboard visibility invoice QR code", exact: true });
    await expect(qr).toHaveCount(1);
    await expect.poll(() => qr.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    for (const viewport of guidedViewports) measurements.push(await captureGuidedStage(page, info, "payment", viewport));
    await expect(dialog.getByLabel("Holoboard visibility payment", { exact: true })).toContainText("210 sats");
    expect(state.requests).toHaveLength(1); expect(state.requests[0]).toMatchObject({ amount_sats: 210, author_share: 0, note: reviewed.id });
    expect(state.requests[0].event).toEqual(reviewed); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
    await info.attach("guided-spatial-measurements", { contentType: "application/json", body: JSON.stringify({ length, text, measurements }, null, 2) });
});


test("editing a reviewed account post preserves its applicable budget and default split", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    await installExtension(context, page);
    const state = await setup(context, page, { authorWallet: true });
    const field = page.getByRole("textbox", { name: "Text or link" });
    await field.fill("An account post with a chosen budget");
    await page.getByRole("button", { name: "Use a Nostr account", exact: true }).click();
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect(page.getByText("Posting with your Nostr account.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    const split = page.getByRole("slider", { name: "Holoboard share in percent", exact: true });
    await expect(split).toHaveValue("80");
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("textbox", { name: "Custom total in sats" }).fill("500");
    await split.focus(); await split.press("End");
    for (let i = 0; i < 35; i++) await split.press("ArrowLeft");
    await expect(split).toHaveValue("65");
    const first = state.signed!;
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await field.fill("The edited account post keeps its chosen budget");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 500 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Custom total in sats" })).toHaveValue("500");
    await expect(split).toHaveValue("65");
    expect(state.signed!.id).not.toBe(first.id); expect(state.signed!.pubkey).toBe(first.pubkey);
    expect(state.signerRequests).toEqual([first.id, state.signed!.id]);
    expect(state.requests).toHaveLength(0); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});


for (const format of ["nevent", "njump"] as const) test(`a mismatched ${format} preview reports an error and can retry the original`, async ({ context, page }) => {
    const state = await setup(context, page, { mismatchedPreviews: 1 });
    const encoded = neventEncode({ id: original.id, author: original.pubkey, relays: ["wss://nos.lol"] });
    const reference = format === "njump" ? `https://njump.me/${encoded}` : encoded;
    const field = page.getByRole("textbox", { name: "Text or link", exact: true });
    await field.fill(reference);
    await expect(page.getByRole("alert")).toHaveText("The relay returned a different post. Retry or choose another post.");
    await expect(field).toHaveValue(reference);
    await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(unrelatedOriginal.content, { exact: true })).toHaveCount(0);
    expect(state.previewCalls).toBe(2);
    expect(state.signed).toBeUndefined(); expect(state.requests).toHaveLength(0);
    expect(state.signerRequests).toEqual([]); expect(state.reviewedIds).toEqual([]);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("Review retries an unchanged original after a failed preview without signing or invoicing", async ({ context, page }) => {
    const state = await setup(context, page, { previewFailures: 1 });
    await page.getByRole("textbox", { name: "Text or link" }).fill(original.id);
    await expect(page.getByRole("alert")).toHaveText("Original preview temporarily unavailable");
    await expect(page.getByRole("button", { name: "Review & continue", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    expect(state.previewCalls).toBe(2); expect(state.signed).toBeUndefined();
    expect(state.requests).toHaveLength(0); expect(state.signerRequests).toEqual([]);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});


for (const failure of ["rejected", "changed"] as const) test(`a ${failure} account signature keeps the editable post and never prepares invoices`, async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_NOSTR_CONNECT !== "true");
    let attempts = 0;
    await installExtension(context, page, async () => accountPubkey, template => {
        attempts++;
        if (attempts === 1 && failure === "rejected") throw new Error("Signing rejected by user");
        return finalizeEvent(attempts === 1 ? { ...template, content: "Signer changed this content" } : template, accountKey);
    });
    const state = await setup(context, page);
    const text = "Keep the exact words I chose before signing";
    const field = page.getByRole("textbox", { name: "Text or link", exact: true });
    await field.fill(text);
    await page.getByRole("button", { name: "Use a Nostr account", exact: true }).click();
    await page.getByRole("button", { name: "Browser extension", exact: true }).click();
    await expect(page.getByText("Posting with your Nostr account.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText(failure === "changed" ? "The signer changed the requested event or account." : "Signing rejected by user");
    await expect(field).toHaveValue(text);
    await expect(field).toBeEnabled();
    expect(state.requests).toHaveLength(0); expect(state.reviewedIds).toEqual([]);
    await alert.scrollIntoViewIfNeeded();
    const bounds = (await alert.boundingBox())!, body = (await page.locator("[data-modal-body]").boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(body.y); expect(bounds.y + bounds.height).toBeLessThanOrEqual(body.y + body.height + 1);
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    expect(attempts).toBe(2); expect(state.signed?.content).toBe(text); expect(state.signed?.pubkey).toBe(accountPubkey);
    expect(state.reviewedIds).toEqual([state.signed!.id]); expect(state.requests).toHaveLength(0);
    expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("long public author identity and explicit quote remain usable on a narrow phone", async ({ context, page }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const state = await setup(context, page, { longAuthor: true });
    const field = page.getByRole("textbox", { name: "Text or link", exact: true });
    await field.fill(original.id);
    const article = page.getByRole("article", { name: "Original note", exact: true });
    await expect(article).toHaveCount(1);
    await expect(article.getByRole("link", { name: "Open note", exact: true })).toHaveAttribute("href", /^https:\/\/njump\.me\//);
    await expect(article.getByText(/^Community maker with a deliberately long/)).toBeVisible();
    expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("long-public-author-320.png") });
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.screenshot({ path: info.outputPath(`long-public-author-budget-${width}.png`) });
        expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.getByRole("button", { name: "Add a comment", exact: true }).click();
    await field.fill(`My own comment and a real link https://example.com/story\n\nnostr:${neventEncode({ id: original.id })}`);
    await expect(page.getByRole("button", { name: "Use original", exact: true })).toBeVisible();
    await expect(page.locator(".note-link-preview")).toHaveAttribute("href", "https://example.com/story");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    expect(state.signed!.tags).toContainEqual(["q", original.id, "", original.pubkey]);
    expect(state.signed!.id).not.toBe(original.id);
    await page.screenshot({ path: info.outputPath("explicit-quote-budget-320.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(state.requests).toHaveLength(0); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});

test("guest author-key disclosure and contextual help preserve focus near the footer", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    const state = await setup(context, page);
    await page.getByRole("textbox", { name: "Text or link" }).fill(shortContribution);
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await page.getByText("Post author", { exact: true }).click();
    const save = page.getByRole("button", { name: "Save author key", exact: true });
    await save.click();
    const copy = page.getByRole("button", { name: "Copy private author key", exact: true });
    await expect(copy).toBeVisible();
    await copy.focus(); await expect(copy).toBeFocused();
    const copyBounds = (await copy.boundingBox())!, body = (await page.locator("[data-modal-body]").boundingBox())!;
    expect(copyBounds.y + copyBounds.height).toBeLessThanOrEqual(body.y + body.height + 1);
    await save.click(); await expect(copy).toHaveCount(0); await expect(save).toBeFocused();
    const help = page.getByRole("dialog").getByRole("button", { name: "Help >", exact: true });
    await help.click();
    await page.getByRole("button", { name: "< Back to budget", exact: true }).click();
    await expect(help).toBeFocused();
    const prepare = page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true });
    await prepare.focus(); await expect(prepare).toBeFocused();
    const bounds = (await prepare.boundingBox())!; expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
    expect(state.requests).toHaveLength(0); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});


test("guided stages reflow with enlarged text while footer controls stay reachable", async ({ context, page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setup(context, page);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    await page.getByRole("textbox", { name: "Text or link" }).fill(shortContribution);
    const enlarge = async (stage: string) => {
        await page.evaluate(() => document.fonts.ready);
        await dialog.evaluate(element => {
            const nodes = [element as HTMLElement, ...element.querySelectorAll<HTMLElement>("*")];
            const sizes = nodes.filter(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) || node.matches("textarea, input, select"))
                .map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
            for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.screenshot({ path: info.outputPath(`${stage}-text-enlarged-${width}.png`) });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
            const steps = dialog.getByRole("navigation", { name: "Add to board progress", exact: true }).locator("li");
            await expect(steps).toHaveCount(3);
            const geometry = await steps.evaluateAll(elements => elements.map(element => ({
                label: element.firstElementChild!.getBoundingClientRect().toJSON(),
                point: element.lastElementChild!.getBoundingClientRect().toJSON(),
                overflow: element.firstElementChild!.scrollWidth > element.firstElementChild!.clientWidth,
            })));
            for (let index = 0; index < geometry.length; index++) {
                expect(geometry[index].overflow).toBe(false);
                expect(geometry[index].point.y).toBeCloseTo(geometry[0].point.y, 0);
                if (index > 0) expect(geometry[index - 1].label.right).toBeLessThanOrEqual(geometry[index].label.left + 1);
            }
            const action = dialog.getByRole("button", { name: stage === "post" ? "Review & continue" : stage === "budget" ? "Continue to payment · 210 sats" : "Copy invoice", exact: true });
            await action.focus(); await expect(action).toBeFocused();
            const footer = dialog.locator("[data-modal-body] + div");
            const footerActions = footer.locator("button, a[href]");
            await expect(footerActions).toHaveCount(stage === "post" ? 2 : stage === "payment" ? 4 : 3);
            const footerGeometry = await footerActions.evaluateAll(elements => elements.map(element => {
                const text = document.createRange(); text.selectNodeContents(element);
                return { label: element.textContent, rect: element.getBoundingClientRect().toJSON(), text: text.getBoundingClientRect().toJSON() };
            }));
            await info.attach(`${stage}-footer-${width}`, { contentType: "application/json", body: JSON.stringify({ panel: await dialog.boundingBox(), body: await dialog.locator("[data-modal-body]").boundingBox(), footer: await footer.boundingBox(), actions: footerGeometry }) });
            for (const item of footerGeometry) {
                expect(item.rect.y, item.label ?? "Footer action").toBeGreaterThanOrEqual(0);
                expect(item.rect.bottom, item.label ?? "Footer action").toBeLessThanOrEqual(844);
                expect(item.text.top, item.label ?? "Footer text").toBeGreaterThanOrEqual(0);
                expect(item.text.bottom, item.label ?? "Footer text").toBeLessThanOrEqual(844);
            }
            const bounds = (await action.boundingBox())!;
            expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
            if (stage === "budget") {
                const name = dialog.getByText("Anonymous", { exact: true });
                const actions = dialog.locator("[data-preview-actions]");
                await expect(name).toHaveCount(1); await expect(actions).toHaveCount(1);
                const author = (await name.boundingBox())!, reading = (await actions.boundingBox())!;
                const overlap = Math.min(author.x + author.width, reading.x + reading.width) > Math.max(author.x, reading.x)
                    && Math.min(author.y + author.height, reading.y + reading.height) > Math.max(author.y, reading.y);
                expect(overlap).toBe(false);
                const header = (await dialog.locator("[data-preview-header]").boundingBox())!;
                expect(author.x).toBeGreaterThanOrEqual(header.x - 1); expect(author.x + author.width).toBeLessThanOrEqual(header.x + header.width + 1);
                await info.attach(`budget-identity-${width}`, { contentType: "application/json", body: JSON.stringify({ author, reading, header }) });
            }
            await info.attach(`${stage}-enlarged-${width}`, { contentType: "application/json", body: JSON.stringify(geometry) });
        }
        await dialog.evaluate(element => { for (const node of [element as HTMLElement, ...element.querySelectorAll<HTMLElement>("*")]) node.style.removeProperty("font-size"); });
    };
    await enlarge("post");
    await page.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true })).toBeEnabled();
    await enlarge("budget");
    await page.getByRole("button", { name: "Continue to payment · 210 sats", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy invoice", exact: true })).toBeVisible();
    const code = dialog.getByRole("img", { name: "Holoboard visibility invoice QR code", exact: true });
    await expect(code).toHaveCount(1);
    await expect.poll(() => code.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await enlarge("payment");
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});


test("guest appearance fee and recovery help keep the chosen budget explicit", async ({ context, page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setup(context, page);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    await dialog.getByRole("textbox", { name: "Text or link" }).fill(shortContribution);
    await dialog.getByRole("button", { name: "Review & continue", exact: true }).click();
    await expect(dialog.getByText("All of this amount goes to visibility.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Custom", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Custom total in sats", exact: true }).fill("321");
    await dialog.getByRole("button", { name: /^Billboard appearance/ }).click();
    await dialog.getByRole("button", { name: "Billboard / +100 sats", exact: true }).click();
    await dialog.getByRole("button", { name: "< Back to budget", exact: true }).click();
    await expect(dialog.getByText("Visibility receives 321 sats. The 100-sat appearance fee does not add ranking weight.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("slider")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Continue to payment · 421 sats", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Help >", exact: true }).click();
    await expect(dialog.getByText(/Saved unfinished invoices remain available after closing the tab/)).toContainText("same browser profile on this device");
    await expect(dialog.getByText(/Saved unfinished invoices remain available after closing the tab/)).toContainText("select a payment under Unfinished payments to resume");
    await expect(dialog.getByText(/Saved unfinished invoices remain available after closing the tab/)).toContainText("does not transfer to another browser or device");
    await expect(dialog.getByText(/Keep unfinished invoices in this browser tab/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "< Back to budget", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Custom total in sats", exact: true })).toHaveValue("321");
    await expect(dialog.getByRole("button", { name: "Continue to payment · 421 sats", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("guest-fee-help-choices-preserved.png") });
    await dialog.getByRole("button", { name: "Continue to payment · 421 sats", exact: true }).click();
    const allocation = "Visibility receives 321 sats. Appearance costs 100 sats and does not add ranking weight.";
    await expect(dialog.getByText(allocation, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Holoboard visibility and appearance payment", { exact: true })).toContainText("421 sats");
    const invoice = await dialog.getByRole("link", { name: "Open in wallet", exact: true }).getAttribute("href");
    const before = await page.evaluate(async () => {
        const records = await import("/src/components/PromoteModal/paymentRecords.ts");
        return records.unfinishedPayments()[0];
    });
    expect(before.board).toMatchObject({ amountSats: 421, promotionSats: 321, billboardFeeSats: 100, paymentHash: boardHash });
    await dialog.getByRole("button", { name: "Back to budget", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Custom total in sats", exact: true }).fill("999");
    await expect(dialog.getByRole("button", { name: "Continue to payment · 1099 sats", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Resume payment", exact: true }).click();
    await expect(dialog.getByText(allocation, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Holoboard visibility and appearance payment", { exact: true })).toContainText("421 sats");
    await expect(dialog.getByRole("link", { name: "Open in wallet", exact: true })).toHaveAttribute("href", invoice!);
    const after = await page.evaluate(async () => (await import("/src/components/PromoteModal/paymentRecords.ts")).unfinishedPayments()[0]);
    expect(after.board).toEqual(before.board);
    await page.screenshot({ path: info.outputPath("guest-fee-frozen-payment-resumed.png") });
    expect(state.requests).toHaveLength(1); expect(state.frames).toEqual([]); expect(state.errors).toEqual([]);
});
