import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });
const author = generateSecretKey();
const source = (name: string) => `https://media.example/${name}`;
const portrait = source("portrait.png"), panorama = source("panorama.png"), video = source("portrait.mp4");
const svg = (width: number, height: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#164e63"/><rect x="5%" y="5%" width="90%" height="90%" fill="none" stroke="#22d3ee" stroke-width="8"/></svg>`;

/** Signed board and relay fixtures follow the existing reader tests. */
async function setup(context: BrowserContext, page: Page, options: { content: string; tags?: string[][]; broken?: { recover: boolean }; requests?: Set<string>; tail?: boolean }) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const note = finalizeEvent({ kind: 1, created_at: 1700000000, content: options.content, tags: options.tags ?? [] }, author);
    const profile = finalizeEvent({ kind: 0, created_at: 1700000000, content: JSON.stringify({ name: "Media author" }), tags: [] }, author);
    const entry = { id: note.id, event: note, rank: 1, weight: 200, sats_paid: 210, hot_sats: 200, first_paid_at: 1700000000, last_paid_at: 1700000000 };
    const tail = options.tail ? Array.from({ length: 8 }, (_, index) => finalizeEvent({ kind: 1, created_at: 1700000000, content: `Additional text-only note ${index + 1}.`, tags: [] }, author)) : [];
    const entries = [entry, ...tail.map((event, index) => ({ ...entry, id: event.id, event, rank: index + 2 }))];
    // Locally generated two-second H.264 fixture, with no external media reads.
    const clip = await readFile(new URL("./assets/portrait.mp4", import.meta.url));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === "media.example") {
            options.requests?.add(url.href);
            if (url.pathname === "/broken.png" && !options.broken?.recover) return route.fulfill({ status: 404, body: "Unavailable" });
            if (url.pathname.endsWith(".mp4")) {
                const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
                const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
                return route.fulfill({ status: range ? 206 : 200, body: clip.subarray(start, end + 1), contentType: "video/mp4",
                    headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}) } });
            }
            return route.fulfill({ contentType: "image/svg+xml", body: url.pathname === "/panorama.png" ? svg(1600, 200) : svg(400, 800) });
        }
        if (url.origin !== "http://127.0.0.1:3334") return route.abort();
        const data = url.pathname.includes("waiting-updates") ? { count: 0, note_ids: [], checked_at: Date.now() } :
            { entries, targets: [], total: entries.length, active_posts: entries.length, has_more: false, total_sats: entries.length * 210 };
        return route.fulfill({ json: data, headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await context.routeWebSocket("**/*", socket => {
        if (socket.url().startsWith(origin.replace(/^http/, "ws"))) return socket.connectToServer();
        socket.onMessage(message => {
            const request = JSON.parse(String(message));
            if (request[0] !== "REQ") return;
            for (const event of [note, profile, ...tail]) if (request.slice(2).some((filter: Parameters<typeof matchFilter>[0]) => matchFilter(filter, event))) socket.send(JSON.stringify(["EVENT", request[1], event]));
            socket.send(JSON.stringify(["EOSE", request[1]]));
        });
    });
    await page.goto("/");
    const row = page.locator("article").first();
    await expect(row).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { row, gallery: row.locator(".note-gallery"), note };
}

for (const width of [320, 390, 430, 1440]) test(`mixed media preserve source order, bounded loading and frame at ${width}px`, async ({ context, page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = new Set<string>();
    const sources = [portrait, video, panorama, ...Array.from({ length: 7 }, (_, index) => source(`image-${index + 4}.png`))];
    const { gallery } = await setup(context, page, { content: "A mixed gallery.\n" + [...sources, portrait, video].join("\n"), tags: [["imeta", `url ${portrait}`, "dim 400x800"]], requests });
    await expect(gallery).toHaveCount(1);
    await expect(gallery.getByRole("button", { name: /^Select / })).toHaveCount(7);
    await expect(gallery.locator("video")).toHaveCount(0);
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    expect(requests.has(video)).toBe(false);
    expect(requests.size).toBeLessThanOrEqual(7);
    for (const lateSource of sources.slice(7)) expect(requests.has(lateSource)).toBe(false);
    expect(await gallery.locator(".note-gallery__thumbnail").evaluateAll(nodes => nodes.every(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44;
    }))).toBe(true);
    const initial = (await gallery.locator(".note-gallery__lead").boundingBox())!;
    expect(initial.height).toBeGreaterThan(188);
    expect(initial.height).toBeLessThanOrEqual(460);
    const navigation = await gallery.locator(".note-gallery__toolbar").boundingBox();
    expect(navigation!.y).toBeGreaterThanOrEqual(initial.y);
    expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(initial.y + initial.height);
    const thumbnails = (await gallery.locator(".note-gallery__thumbnails").boundingBox())!;
    expect(thumbnails.y).toBeGreaterThanOrEqual(initial.y + initial.height);
    const navigationControls = gallery.locator(".note-gallery__toolbar button");
    await expect(navigationControls).toHaveCount(2);
    expect(await navigationControls.evaluateAll(nodes => nodes.every(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44;
    }))).toBe(true);
    await page.screenshot({ path: info.outputPath(`mixed-gallery-${width}.png`), fullPage: true });
    for (let index = 0; index < sources.length; index++) {
        await expect.poll(() => gallery.evaluate(element => {
            const lead = element.querySelector(".note-gallery__image img, video");
            return {
                index: Number(element.getAttribute("data-media-index")), src: lead?.getAttribute("src"),
                fit: lead ? getComputedStyle(lead).objectFit : null,
                counter: element.querySelector(".note-gallery__counter")?.textContent,
                thumbnails: element.querySelectorAll(".note-gallery__thumbnail").length,
                videos: element.querySelectorAll("video").length,
                height: Math.round(element.querySelector(".note-gallery__lead")!.getBoundingClientRect().height),
            };
        })).toEqual({ index, src: sources[index], fit: "contain", counter: `${index + 1} / ${sources.length}`, thumbnails: 7,
            videos: index === 1 ? 1 : 0, height: Math.round(initial.height) });
        if (index < sources.length - 1) await gallery.getByRole("button", { name: "Next media", exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const poster of ["none", "provided", "broken"] as const) test(`video keeps a visible paused preview behind Play with ${poster} poster`, async ({ context, page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { gallery } = await setup(context, page, { content: `A video preview.\n${video}`,
        tags: poster === "none" ? [] : [["imeta", `url ${video}`, `image ${source(poster === "broken" ? "broken.png" : "portrait.png")}`]] });
    const player = gallery.locator("video");
    await player.scrollIntoViewIfNeeded();
    await expect.poll(() => player.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(poster === "provided" ? 1 : 2);
    if (poster === "provided") await expect(gallery.locator(".note-video-poster-probe")).toHaveJSProperty("naturalWidth", 400);
    const play = gallery.getByRole("button", { name: "Play video", exact: true });
    await expect(play).toBeVisible();
    await expect(play).toHaveCSS("background-image", "none");
    await expect(play).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(player).toHaveJSProperty("paused", true);
    await gallery.screenshot({ path: info.outputPath(`video-preview-${poster}.png`) });
    await play.click();
    await expect(player).toHaveJSProperty("paused", false);
    await expect(play).toHaveCount(0);
});

test("single panoramas use their complete shallow frame at phone and desktop widths", async ({ context, page }, info) => {
    const { gallery } = await setup(context, page, { content: `A complete panorama.\n${panorama}` });
    const image = gallery.locator(".note-gallery__image img");
    await expect(image).toHaveJSProperty("naturalWidth", 1600);
    for (const width of [320, 390, 430, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(async () => {
            const frame = (await gallery.locator(".note-gallery__lead").boundingBox())!;
            expect(frame.height).toBeLessThan(188);
            expect(frame.height).toBeCloseTo(Math.max(44, frame.width / 8), 0);
        }).toPass();
        await expect(image).toHaveCSS("object-fit", "contain");
        await page.screenshot({ path: info.outputPath(`panorama-${width}.png`), fullPage: true });
    }
});

test("a panorama-first gallery reserves a stable readable frame for portraits and video", async ({ context, page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { gallery } = await setup(context, page, { content: [panorama, portrait, video].join("\n"), tags: [["imeta", `url ${panorama}`, "dim 1600x200"]] });
    const first = (await gallery.locator(".note-gallery__lead").boundingBox())!;
    expect(first.height).toBeCloseTo(Math.min(first.width, 460), 0);
    expect(first.height).toBeGreaterThan(188);
    await gallery.getByRole("button", { name: "Select image 2 of 3", exact: true }).click();
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    await expect(gallery.locator(".note-gallery__image img")).toHaveCSS("object-fit", "contain");
    expect((await gallery.locator(".note-gallery__lead").boundingBox())!.height).toBeCloseTo(first.height, 0);
    await page.screenshot({ path: info.outputPath("panorama-first-portrait.png"), fullPage: true });
    await gallery.getByRole("button", { name: "Select video 3 of 3", exact: true }).click();
    await expect(gallery.locator("video")).toHaveAttribute("src", video);
    await expect(gallery.locator("video")).toHaveCSS("object-fit", "contain");
    expect((await gallery.locator(".note-gallery__lead").boundingBox())!.height).toBeCloseTo(first.height, 0);
});

test("intrinsic dimensions replace incorrect signed hints and persist through discussion", async ({ context, page }, info) => {
    test.skip(process.env.VITE_ENABLE_DISCUSSIONS !== "true");
    await page.setViewportSize({ width: 390, height: 844 });
    const { row, gallery } = await setup(context, page, { content: `A portrait with an incorrect size hint.\n${portrait}\n${panorama}`,
        tags: [["imeta", `url ${portrait}`, "dim 1600x200"]], tail: true });
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    await expect.poll(() => gallery.locator(".note-gallery__lead").evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(460, 0);
    await gallery.getByRole("button", { name: "Select image 2 of 2", exact: true }).click();
    await expect(gallery.locator(".note-gallery__image img")).toHaveAttribute("src", panorama);
    expect((await gallery.locator(".note-gallery__lead").boundingBox())!.height).toBeCloseTo(460, 0);
    await row.getByRole("link", { name: "Discussion", exact: true }).click();
    const focus = page.getByRole("article", { name: "Discussion focus" });
    await expect(focus.locator(".note-gallery")).toHaveAttribute("data-media-index", "1");
    await expect(focus.locator(".note-gallery__image img")).toHaveAttribute("src", panorama);
    expect((await focus.locator(".note-gallery__lead").boundingBox())!.height).toBeCloseTo(460, 0);
    await page.screenshot({ path: info.outputPath("intrinsic-dimensions-discussion.png"), fullPage: true });
    await page.getByRole("link", { name: "Back to board", exact: true }).click();
    await expect(gallery).toHaveAttribute("data-media-index", "1");
    expect((await gallery.locator(".note-gallery__lead").boundingBox())!.height).toBeCloseTo(460, 0);
});

test("navigation cancels a viewer while its lazy module is still loading", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_DISCUSSIONS !== "true");
    await page.setViewportSize({ width: 390, height: 844 });
    const { row, gallery } = await setup(context, page, { content: `A pending viewer.\n${portrait}` });
    let pendingModule: Route | undefined;
    await page.route("**/src/components/TextRenderer/NoteMediaViewer.tsx*", route => {
        if (pendingModule) return route.continue();
        pendingModule = route;
    });
    await gallery.getByRole("button", { name: "Open image 1 of 1", exact: true }).click();
    await expect.poll(() => !!pendingModule).toBe(true);
    await expect(page.getByText("Opening media", { exact: true })).toBeVisible();
    await row.getByRole("link", { name: "Discussion", exact: true }).click();
    await expect(page.getByRole("article", { name: "Discussion focus" })).toBeVisible();
    await expect(page.getByText("Opening media", { exact: true })).toHaveCount(0);
    const moduleURL = pendingModule!.request().url();
    await pendingModule!.continue();
    // Await that exact module graph and React's next committed frame, so a late
    // dialog cannot escape an assertion made immediately after releasing the file.
    await page.evaluate(async url => {
        await import(url);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, moduleURL);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Opening media", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to board", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Opening media", { exact: true })).toHaveCount(0);
});

test("a failed source retains its position and supports source access and retry", async ({ context, page }) => {
    const broken = { recover: false };
    const { gallery } = await setup(context, page, { content: [portrait, source("broken.png"), panorama].join("\n"), broken });
    await gallery.getByRole("button", { name: "Select image 2 of 3", exact: true }).click();
    await expect(gallery.getByText("Image unavailable", { exact: true })).toBeVisible();
    await expect(gallery.getByRole("link", { name: "Open source", exact: false })).toHaveAttribute("href", source("broken.png"));
    await expect(gallery.getByRole("button", { name: /^Select / })).toHaveCount(3);
    await expect(gallery).toHaveAttribute("data-media-index", "1");
    await gallery.getByRole("button", { name: "Next media", exact: true }).click();
    await expect(gallery.getByRole("button", { name: "Open image 3 of 3", exact: true })).toBeVisible();
    await gallery.getByRole("button", { name: "Previous media", exact: true }).click();
    broken.recover = true;
    await gallery.getByRole("button", { name: "Retry image", exact: true }).click();
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    await expect(gallery).toHaveAttribute("data-media-index", "1");
    await expect(gallery.getByRole("button", { name: "Open image 2 of 3", exact: true })).toBeVisible();
});

test("recovering a failed source in the viewer also restores its inline image", async ({ context, page }) => {
    const broken = { recover: false };
    const { gallery } = await setup(context, page, { content: [portrait, source("broken.png")].join("\n"), broken });
    await gallery.getByRole("button", { name: "Select image 2 of 2", exact: true }).click();
    await expect(gallery.getByText("Image unavailable", { exact: true })).toBeVisible();
    await gallery.getByRole("button", { name: "Select image 1 of 2", exact: true }).click();
    await gallery.getByRole("button", { name: "Open image 1 of 2", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Next media", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "Media 2 of 2", exact: true });
    await expect(viewer.getByText("Image unavailable", { exact: true })).toBeVisible();
    broken.recover = true;
    await viewer.getByRole("button", { name: "Retry image", exact: true }).click();
    await expect(viewer.locator(".yarl__slide_current img")).toHaveJSProperty("naturalWidth", 400);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 400);
    await expect(gallery.getByRole("button", { name: "Open image 2 of 2", exact: true })).toBeVisible();
});

test("video survives text expansion, pauses on selection and restores time without autoplay", async ({ context, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { row, gallery } = await setup(context, page, { content: "Original long note context. ".repeat(45) + `\n${video}\n${portrait}`, tail: true });
    const inline = gallery.locator("video");
    await inline.scrollIntoViewIfNeeded();
    await expect.poll(() => inline.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    const original = await inline.elementHandle();
    await row.getByRole("button", { name: "Show more note text", exact: true }).click();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await expect(gallery.locator("video")).toHaveCount(1);
    await row.getByRole("button", { name: "Show less note text", exact: true }).click();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await inline.scrollIntoViewIfNeeded();
    await inline.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; node.loop = true; node.currentTime = .65; await node.play(); });
    await expect(inline).toHaveJSProperty("paused", false);
    await gallery.getByRole("button", { name: "Select image 2 of 2", exact: true }).click();
    expect(await original!.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    const savedTime = await original!.evaluate(node => (node as HTMLVideoElement).currentTime);
    await expect(page.locator("video")).toHaveCount(0);
    await gallery.getByRole("button", { name: "Select video 1 of 2", exact: true }).click();
    await expect(inline).toHaveJSProperty("paused", true);
    await expect.poll(() => inline.evaluate(node => (node as HTMLVideoElement).currentTime).then(time => Math.abs(time - savedTime))).toBeLessThan(.1);
    await expect(page.locator("video")).toHaveCount(1);
    await inline.scrollIntoViewIfNeeded();
    await inline.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; node.loop = true; await node.play(); });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(inline).toHaveJSProperty("paused", true);
    await inline.scrollIntoViewIfNeeded();
    await inline.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; node.loop = true; await node.play(); });
    await gallery.getByRole("button", { name: "Open video 1 of 2", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "Media 1 of 2", exact: true });
    await expect(viewer).toBeVisible();
    await expect(inline).toHaveJSProperty("paused", true);
    await expect(viewer.locator("video")).toHaveCount(1);
    await expect.poll(() => page.locator("video").evaluateAll(nodes => nodes.filter(node => !node.paused).length)).toBe(0);
    await expect.poll(() => viewer.locator("video").evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await viewer.locator("video").evaluate(node => { (node as HTMLVideoElement).currentTime = 1.25; });
    await expect.poll(() => viewer.locator("video").evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.25, 1);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(page.locator("video")).toHaveCount(1);
    await expect(inline).toHaveJSProperty("paused", true);
    await expect.poll(() => inline.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.25, 1);
    if (process.env.VITE_ENABLE_DISCUSSIONS === "true") {
        const retained = await inline.elementHandle();
        await inline.scrollIntoViewIfNeeded();
        await inline.evaluate(async element => { const node = element as HTMLVideoElement; node.muted = true; node.loop = true; await node.play(); });
        await row.getByRole("link", { name: "Discussion", exact: true }).click();
        await expect(page.getByRole("article", { name: "Discussion focus" })).toBeVisible();
        expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
        expect(await retained!.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
        const discussionVideo = page.getByRole("article", { name: "Discussion focus" }).locator("video");
        await discussionVideo.scrollIntoViewIfNeeded();
        await expect(discussionVideo).toHaveJSProperty("paused", true);
        await expect.poll(() => discussionVideo.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
        await discussionVideo.evaluate(node => { (node as HTMLVideoElement).currentTime = 1.1; });
        await expect.poll(() => discussionVideo.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.1, 1);
        await page.getByRole("link", { name: "Back to board", exact: true }).click();
        await expect(inline).toHaveJSProperty("paused", true);
        await expect.poll(() => inline.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.1, 1);
    }
});

test("discussion preserves the selected source, first frame and exact board return offset", async ({ context, page }) => {
    test.skip(process.env.VITE_ENABLE_DISCUSSIONS !== "true");
    await page.setViewportSize({ width: 390, height: 844 });
    const { row, gallery } = await setup(context, page, { content: `Keep my selected source.\n${portrait}\n${video}\n${panorama}`, tail: true });
    await gallery.getByRole("button", { name: "Select image 3 of 3", exact: true }).click();
    await expect(gallery.locator(".note-gallery__image img")).toHaveJSProperty("naturalWidth", 1600);
    const originalImage = await gallery.locator(".note-gallery__image img").elementHandle();
    const discussion = row.getByRole("link", { name: "Discussion", exact: true });
    await discussion.scrollIntoViewIfNeeded();
    const before = (await row.boundingBox())!, frame = (await gallery.locator(".note-gallery__lead").boundingBox())!;
    const offset = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => {
        const frames: { src: string | null; height: number; x: number; y: number; width: number; cardHeight: number }[] = [];
        Object.assign(window, { mediaHandoffFrames: frames });
        let remaining = 60;
        const sample = () => {
            const card = document.querySelector("[data-reading-focus] article");
            if (card) {
                const rect = card.getBoundingClientRect();
                frames.push({ src: card.querySelector(".note-gallery__image img")?.getAttribute("src") ?? null,
                    height: card.querySelector(".note-gallery__lead")!.getBoundingClientRect().height,
                    x: rect.x, y: rect.y, width: rect.width, cardHeight: rect.height });
            }
            if (--remaining) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });
    await discussion.click();
    const focus = page.getByRole("article", { name: "Discussion focus" });
    await expect(focus.locator(".note-gallery")).toHaveAttribute("data-media-index", "2");
    await expect.poll(() => page.evaluate(() => (window as unknown as { mediaHandoffFrames: unknown[] }).mediaHandoffFrames.length)).toBeGreaterThan(0);
    const frames = await page.evaluate(() => (window as unknown as { mediaHandoffFrames: { src: string | null; height: number; x: number; y: number; width: number; cardHeight: number }[] }).mediaHandoffFrames);
    expect(frames.length).toBeGreaterThan(0);
    for (const sample of frames) {
        expect(sample.src).toBe(panorama);
        expect(Math.abs(sample.height - frame.height)).toBeLessThan(2);
        for (const axis of ["x", "y", "width"] as const) expect(Math.abs(sample[axis] - before[axis]), axis).toBeLessThan(2);
        expect(Math.abs(sample.cardHeight - before.height)).toBeLessThan(2);
    }
    await page.getByRole("link", { name: "Back to board", exact: true }).click();
    await expect(gallery).toHaveAttribute("data-media-index", "2");
    expect(await originalImage!.evaluate(node => node.isConnected)).toBe(true);
    expect(Math.abs((await gallery.locator(".note-gallery__lead").boundingBox())!.height - frame.height)).toBeLessThan(2);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - offset)).toBeLessThan(2);
});
