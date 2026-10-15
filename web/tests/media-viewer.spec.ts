import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { readFile } from "node:fs/promises";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const sources = [1, 2, 3].map(index => `https://media.example/viewer-${index}.png`);
const note = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [], content: `Media viewer fixture\n${sources.join("\n")}` }, generateSecretKey());

async function setup(context: BrowserContext, page: Page, failure?: { fail?: boolean; video?: boolean }) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const clip = failure?.video ? await readFile(new URL("./assets/portrait.mp4", import.meta.url)) : undefined;
    const entry = { event: note, id: note.id, rank: 1, weight: 200, sats_paid: 210, first_paid_at: 1700000000, last_paid_at: 1700000000 };
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.pathname.endsWith(".mp4") && clip) {
            const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
            const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
            return route.fulfill({ status: range ? 206 : 200, body: clip.subarray(start, end + 1), contentType: "video/mp4", headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}) } });
        }
        if (url.href === sources[1] && failure?.fail) return route.abort();
        if (url.origin === "https://media.example") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="2000"><rect width="1200" height="2000" fill="#155e75"/></svg>' });
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        return route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } : { entries: [entry], targets: [], total: 1, active_posts: 1, has_more: false, total_sats: 210 } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => { const request = JSON.parse(String(message)); if (request[0] === "REQ") socket.send(JSON.stringify(["EOSE", request[1]])); });
    });
    await page.goto("/help");
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open image 1 of 3", exact: true });
    await expect(opener).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return opener;
}

for (const method of ["Escape", "Close dialog"] as const) test(`viewer ${method} preserves reading state, focus and scroll`, async ({ context, page }) => {
    const opener = await setup(context, page);
    await opener.scrollIntoViewIfNeeded();
    const saved = await page.evaluate(() => {
        const state = { ...history.state, readingScroll: scrollY, readingOrigin: { id: "a".repeat(64), path: "/", top: 97, presentation: 12, expanded: true, expandedTexts: ["main"] }, fixtureValue: "retained" };
        history.replaceState(state, "");
        return { state, top: scrollY, length: history.length };
    });
    await opener.click();
    const viewer = page.getByRole("dialog", { name: "Media 1 of 3", exact: true });
    await expect(viewer).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(saved.length + 1);
    expect(await page.evaluate(() => history.state.readingOrigin)).toEqual(saved.state.readingOrigin);
    expect(await page.evaluate(() => history.state.fixtureValue)).toBe(saved.state.fixtureValue);
    const expectedState = await page.evaluate(() => { const state = { ...history.state }; delete state.holoboardMediaViewer; return state; });
    expect(expectedState.readingScroll).toBe(saved.top);
    await expect(viewer.getByRole("link", { name: "Open source", exact: false })).toHaveAttribute("href", sources[0]);
    await viewer.locator(".yarl__slide_current img").waitFor();
    if (method === "Escape") {
        await viewer.screenshot({ path: test.info().outputPath("viewer.png") });
        const viewport = page.viewportSize()!;
        await page.setViewportSize({ width: 844, height: 390 });
        for (const control of [viewer.getByRole("button", { name: "Close dialog", exact: true }), viewer.locator(".note-media-viewer__source"), viewer.getByRole("button", { name: "Previous media", exact: true }), viewer.getByRole("button", { name: "Next media", exact: true })]) {
            await expect(control).toBeVisible();
            const box = (await control.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(844);
            expect(box.y + box.height).toBeLessThanOrEqual(390);
        }
        const stage = (await viewer.locator(".note-media-viewer__stage").boundingBox())!;
        expect(stage.width).toBeGreaterThan(0);
        expect(stage.height).toBeGreaterThan(100);
        await viewer.screenshot({ path: test.info().outputPath("viewer-landscape.png") });
        await page.setViewportSize(viewport);
    }
    const controls = viewer.locator('.note-media-viewer__icon');
    await expect(controls).toHaveCount(4);
    for (const control of await controls.all()) {
        const bounds = (await control.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    if (method === "Escape") await page.keyboard.press("Escape");
    else await viewer.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => history.state)).toEqual(expectedState);
    expect(await page.evaluate(() => scrollY)).toBe(saved.top);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.goBack();
    await expect(page).toHaveURL(/\/help$/);
});

test("Back closes media before route history, and external route pushes never backtrack", async ({ context, page }) => {
    const opener = await setup(context, page);
    await opener.click();
    await expect(page.getByRole("dialog", { name: "Media 1 of 3" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(opener).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/help$/);
    await page.goto("/");
    await page.getByRole("button", { name: "Open image 1 of 3", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => { history.pushState({ externalRoute: true }, "", "/help"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/help$/);
    expect(await page.evaluate(() => history.state)).toEqual({ externalRoute: true });
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

async function pointerSwipe(page: Page) {
    await page.locator('.note-media-viewer .yarl__slide_current img').evaluate(element => {
        const rect = element.closest('.yarl__container')!.getBoundingClientRect(), y = rect.y + rect.height / 2;
        for (const [type, x] of [["pointerdown", rect.x + rect.width * 0.8], ["pointermove", rect.x + rect.width * 0.5], ["pointermove", rect.x + rect.width * 0.15], ["pointerup", rect.x + rect.width * 0.15]] as const) {
            element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
        }
    });
}

test("viewer navigation, touch swipe and zoom keep the active source synchronized", async ({ context, page }) => {
    const opener = await setup(context, page);
    await opener.click();
    const viewer = page.getByRole("dialog");
    await expect(viewer.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
    await viewer.getByRole("button", { name: "Next media", exact: true }).click();
    await expect(viewer).toHaveAccessibleName("Media 2 of 3");
    await expect(viewer.getByRole("link", { name: "Open source", exact: false })).toHaveAttribute("href", sources[1]);
    await viewer.getByRole("button", { name: "Previous media", exact: true }).click();
    await expect(viewer).toHaveAccessibleName("Media 1 of 3");
    await pointerSwipe(page);
    await expect(viewer).toHaveAccessibleName("Media 2 of 3");
    await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(viewer.locator('.sr-only[aria-live="polite"]')).toContainText("Zoom 200 percent");
    await pointerSwipe(page);
    await expect(viewer).toHaveAccessibleName("Media 2 of 3");
    await viewer.getByRole("button", { name: "Zoom out", exact: true }).click();
    await viewer.locator(".yarl__slide_current img").dblclick();
    await expect.poll(async () => Number((await viewer.locator('.sr-only[aria-live="polite"]').textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(100);
    const zoomOut = viewer.getByRole("button", { name: "Zoom out", exact: true });
    for (let attempt = 0; attempt < 5 && await zoomOut.isEnabled(); attempt++) await zoomOut.click();
    await expect(zoomOut).toBeDisabled();
    await viewer.getByRole("button", { name: "Close dialog", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAccessibleName("Media 3 of 3");
    await viewer.locator(".yarl__slide_current img").evaluate(async element => {
        const rect = element.closest(".yarl__container")!.getBoundingClientRect();
        const center = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        const pointer = (type: string, pointerId: number, x: number) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1 }));
        pointer("pointerdown", 11, center - 30);
        pointer("pointerdown", 12, center + 30);
        pointer("pointermove", 11, center - 70);
        await new Promise(resolve => setTimeout(resolve, 25));
        pointer("pointermove", 12, center + 70);
        pointer("pointerup", 11, center - 70);
        pointer("pointerup", 12, center + 70);
    });
    await expect.poll(async () => Number((await viewer.locator('.sr-only[aria-live="polite"]').textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(100);
    await expect(viewer).toHaveAccessibleName("Media 3 of 3");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open image 3 of 3", exact: true })).toBeFocused();
});

test("viewer above another Modal restores nested scroll and releases simultaneous teardown", async ({ context, page }) => {
    await setup(context, page, { video: true });
    await page.evaluate(async (src) => {
        const reactUrl = "/node_modules/.vite/deps/react.js", clientUrl = "/node_modules/.vite/deps/react-dom_client.js";
        const modalUrl = "/src/components/ui/Modal.tsx", galleryUrl = "/src/components/TextRenderer/NoteMediaGallery.tsx";
        const { default: React } = await import(reactUrl);
        const { default: client } = await import(clientUrl);
        const { Modal } = await import(modalUrl);
        const { NoteMediaGallery } = await import(galleryUrl);
        const videoUrl = "/src/components/TextRenderer/NoteVideo.tsx";
        const { NoteVideo } = await import(videoUrl);
        const host = document.body.appendChild(document.createElement("div"));
        const root = client.createRoot(host, { identifierPrefix: "media-fixture-" });
        (window as unknown as { teardownMediaFixture: () => void }).teardownMediaFixture = () => { root.unmount(); host.remove(); };
        root.render(React.createElement(React.Fragment, null,
            React.createElement("div", { id: "other-video-fixture", style: { position: "fixed", top: 10, right: 10, width: 80, height: 80 } },
                React.createElement(NoteVideo, { item: { kind: "video", src: "https://media.example/other.mp4" } })),
            React.createElement(Modal, { isOpen: true, onClose: () => root.unmount(), title: "Parent fixture", scrollBody: true },
            React.createElement("div", { style: { height: 400 } }),
            React.createElement(NoteMediaGallery, { items: [{ kind: "image", src, width: 1200, height: 2000 }], galleryKey: "nested-viewer-fixture" }),
            React.createElement("div", { style: { height: 700 } }))));
    }, sources[0]);
    const parent = page.getByRole("dialog", { name: "Parent fixture", exact: true });
    const opener = parent.getByRole("button", { name: "Open image 1 of 1", exact: true });
    await opener.scrollIntoViewIfNeeded();
    const before = await parent.locator('[data-modal-body]').evaluate(element => element.scrollTop);
    const otherVideo = page.locator("#other-video-fixture video");
    await expect.poll(() => otherVideo.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await otherVideo.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; video.loop = true; video.currentTime = .5; await video.play(); });
    await expect(otherVideo).toHaveJSProperty("paused", false);
    await opener.click();
    await expect(otherVideo).toHaveJSProperty("paused", true);
    const viewer = page.getByRole("dialog", { name: "Media 1 of 1", exact: true });
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(opener).toBeFocused();
    expect(await parent.locator('[data-modal-body]').evaluate(element => element.scrollTop)).toBe(before);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await opener.click();
    await expect(viewer).toBeVisible();
    await page.evaluate(() => (window as unknown as { teardownMediaFixture: () => void }).teardownMediaFixture());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    expect(await page.evaluate(() => history.state?.holoboardMediaViewer)).toBeUndefined();
});

test("failed viewer image keeps its source and retries without losing the gallery", async ({ context, page }) => {
    const failure = { fail: true };
    const opener = await setup(context, page, failure);
    await opener.click();
    const viewer = page.getByRole("dialog");
    await viewer.getByRole("button", { name: "Next media", exact: true }).click();
    await expect(viewer).toHaveAccessibleName("Media 2 of 3");
    await expect(viewer.getByText("Image unavailable", { exact: true })).toBeVisible();
    await expect(viewer.locator('.note-media-viewer__source')).toHaveAttribute("href", sources[1]);
    failure.fail = false;
    await viewer.getByRole("button", { name: "Retry image", exact: true }).click();
    await expect(viewer.getByText("Image unavailable", { exact: true })).toHaveCount(0);
    await expect(viewer.locator('.yarl__slide_current img')).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
    await viewer.getByRole("button", { name: "Next media", exact: true }).click();
    await expect(viewer).toHaveAccessibleName("Media 3 of 3");
});

test("Holoboard navigation consumes the viewer entry before opening another route", async ({ context, page }) => {
    const opener = await setup(context, page);
    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(async () => {
        const moduleUrl = "/src/lib/discussionNavigation.ts";
        const { navigateReading } = await import(moduleUrl);
        const link = document.createElement("a");
        link.href = "/help";
        navigateReading({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, currentTarget: link, preventDefault() {} });
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/help$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Open image 1 of 3", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/help$/);
});
