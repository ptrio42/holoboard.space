/* Preserve lazy modules needed by tabs that survive an automatic worker update. */
const previousAssets = "holoboard-previous-assets-v1";
const assetLimit = 96;
const byteLimit = 12 * 1024 * 1024;
const assetLifetime = 24 * 60 * 60 * 1000;
const assetPath = /^\/assets\/.+-[\w-]+\.(?:js|css|woff2?|svg|png|webp)$/;

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const archive = await caches.open(previousAssets);
        const captured = new Map();
        let bytes = 0;
        // Installation runs before Workbox activation removes obsolete entries.
        for (const name of await caches.keys()) {
            if (!name.startsWith("workbox-precache-v2-") || !name.endsWith(self.registration.scope)) continue;
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
                const url = new URL(request.url);
                if (url.origin !== self.location.origin || !assetPath.test(url.pathname) || captured.has(url.href)) continue;
                const response = await cache.match(request);
                if (!response || response.status !== 200) continue;
                const body = await response.arrayBuffer();
                if (captured.size >= assetLimit || bytes + body.byteLength > byteLimit) {
                    // Retain the active worker rather than install an incomplete archive.
                    throw new Error("Previous application assets exceed the update budget");
                }
                bytes += body.byteLength;
                const headers = new Headers(response.headers);
                headers.delete("content-encoding");
                headers.set("content-length", String(body.byteLength));
                headers.set("date", new Date().toUTCString());
                captured.set(url.href, new Response(body, { status: 200, headers }));
            }
        }
        // Write the complete new generation before evicting older generations.
        // Storage may briefly reach twice the steady-state byte budget.
        for (const [url, response] of captured) await archive.put(url, response);
        let count = captured.size;
        for (const request of await archive.keys()) {
            if (captured.has(request.url)) continue;
            const response = await archive.match(request);
            const storedAt = Date.parse(response?.headers.get("date") ?? "");
            const body = response ? await response.arrayBuffer() : null;
            if (!body || !Number.isFinite(storedAt) || Date.now() - storedAt > assetLifetime ||
                count >= assetLimit || bytes + body.byteLength > byteLimit) {
                await archive.delete(request);
            } else {
                count++;
                bytes += body.byteLength;
            }
        }
    })());
});
