import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { walletInvoice } from "./helpers/walletFixture";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

async function fixture(context: BrowserContext, page: Page) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        // Production QRs sit above scanlines in Modal; retain that layer in the fixture.
        if (url.pathname === "/qr-fixture") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body style="padding:16px"><div id="qr-fixture" style="position:relative;z-index:60"></div></body></html>' });
        return route.continue();
    });
    await page.goto("/qr-fixture");
    await page.evaluate(async () => {
        const refresh = (await import("/@react-refresh")).default;
        refresh.injectIntoGlobalHook(window);
        Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
        // Use the same optimized React modules as the component, including Vite's cache query.
        const source = await fetch("/src/components/ui/QrCode.tsx").then(response => response.text());
        const main = await fetch("/src/main.tsx").then(response => response.text());
        const react = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
        const dom = main.match(/from\s+["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
        if (!react || !dom) throw new Error("Could not find the fixture's optimized React modules");
        const React = (await import(react)).default;
        const { createRoot } = (await import(dom)).default;
        const { QrCode } = await import("/src/components/ui/QrCode.tsx");
        const root = createRoot(document.getElementById("qr-fixture"));
        Object.assign(window, { renderQr: (value: string, size: number) => root.render(React.createElement(QrCode, { value, size, label: "Fixture QR code" })) });
    });
}

const invoice = walletInvoice({ timestamp: 1700000000 });
const signer = `nostrconnect://${"a1".repeat(32)}?relay=${encodeURIComponent("wss://relay.example.com")}&secret=${"b2".repeat(16)}&perms=get_public_key%2Csign_event%3A1&name=Holoboard`;
const fullSigner = "nostrconnect://56a97b118b99f2afbcec8abe873effa0f4eac7c3ae84fca04fd60ca3558a5d22?relay=ws%3A%2F%2F127.0.0.1%3A3334%2F&secret=76e689d1260c4a00fece04567f98819450d801616c8b5d11c2156ba236fdab75&perms=sign_event%3A9734%2Csign_event%3A1%2Csign_event%3A1111&name=Holoboard&url=http%3A%2F%2F127.0.0.1%3A62199";
const cases = [
    { name: "ordinary invoice", value: invoice, branded: true },
    { name: "pairing token", value: signer, branded: true },
    { name: "full pairing token", value: fullSigner, branded: undefined },
    { name: "short invoice fixture", value: "lnbc-author", branded: true },
    { name: "dense invoice", value: walletInvoice({ timestamp: 1700000000, description: "Long invoice description. ".repeat(25) }), branded: false },
];

for (const { name, value, branded } of cases) for (const size of [220, 280]) {
    test(`${name} round-trips at ${size}px with readable branding or plain fallback`, async ({ context, page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await fixture(context, page);
        await page.evaluate(({ value, size }) => (window as unknown as { renderQr: (value: string, size: number) => void }).renderQr(value, size), { value, size });
        const qr = page.getByRole("img", { name: "Fixture QR code", exact: true });
        // WebKit can reject a branded device-scale raster even when smaller
        // checks pass. Optional branding must preserve a readable plain fallback.
        const optional = branded === undefined || (testInfo.project.name === "iphone" && branded && name !== "short invoice fixture");
        await expect(qr).toHaveAttribute("data-branded", optional ? /^(true|false)$/ : String(branded));
        const image = PNG.sync.read(await qr.screenshot({ path: testInfo.outputPath("qr.png") }));
        let decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data;
        if (!decoded && await qr.getAttribute("data-branded") === "false") {
            // jsQR can miss fractional-pixel dense grids that native Vision reads.
            // Resample screenshot module centers, without consulting encoded data.
            const span = Number((await qr.getAttribute("viewBox"))!.split(" ")[2]);
            const pixels = span * 3;
            const raster = new Uint8ClampedArray(pixels * pixels * 4);
            for (let y = 0; y < pixels; y++) for (let x = 0; x < pixels; x++) {
                const sx = Math.floor((Math.floor(x / 3) + 0.5) * image.width / span);
                const sy = Math.floor((Math.floor(y / 3) + 0.5) * image.height / span);
                raster.set(image.data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * pixels + x) * 4);
            }
            decoded = jsQR(raster, pixels, pixels)?.data;
        }
        expect(decoded).toBe(/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(value) ? value.toUpperCase() : value);
        expect(errors).toEqual([]);
    });
}

test("changing the QR replaces the payload and preserves copyable pairing tokens", async ({ context, page }) => {
    await fixture(context, page);
    for (const value of [invoice, signer, signer.replace("b2".repeat(16), "c3".repeat(16))]) {
        await page.evaluate(value => (window as unknown as { renderQr: (value: string, size: number) => void }).renderQr(value, 280), value);
        const qr = page.getByRole("img", { name: "Fixture QR code", exact: true });
        await expect(async () => {
            const image = PNG.sync.read(await qr.screenshot());
            const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data;
            expect(decoded).toBe(value === invoice ? value.toUpperCase() : value);
        }).toPass();
    }
});

test("an unavailable mark preserves an unbranded, readable invoice", async ({ context, page }) => {
    await fixture(context, page);
    // Vite inlines this small SVG. Stall its image decode instead of an HTTP URL.
    await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
        Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value: string) {
            if (value.startsWith("data:image/svg+xml") || value.includes("holoboard-mark.svg")) return;
            descriptor.set!.call(this, value);
        } });
        Object.assign(window, { restoreQrMark: () => Object.defineProperty(HTMLImageElement.prototype, "src", descriptor) });
    });
    await page.evaluate(value => (window as unknown as { renderQr: (value: string, size: number) => void }).renderQr(value, 220), invoice);
    const qr = page.getByRole("img", { name: "Fixture QR code", exact: true });
    await expect(qr).toHaveAttribute("data-branded", "false");
    const image = PNG.sync.read(await qr.screenshot());
    expect(jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data).toBe(invoice.toUpperCase());
    await page.evaluate(() => (window as unknown as { restoreQrMark: () => void }).restoreQrMark());
    await page.evaluate(value => (window as unknown as { renderQr: (value: string, size: number) => void }).renderQr(value, 280), signer);
    await expect(qr).toHaveAttribute("data-branded", "true");
    const recovered = PNG.sync.read(await qr.screenshot());
    expect(jsQR(new Uint8ClampedArray(recovered.data), recovered.width, recovered.height)?.data).toBe(signer);
});
