/// <reference types="node" />
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const origin = "https://holoboard.example";
const archiveName = "holoboard-previous-assets-v1";
const source = readFileSync(new URL("../../public/preserve-assets.js", import.meta.url), "utf8");
const url = (name: string) => `${origin}/assets/${name}-abcdefgh.js`;
class MemoryCache {
    records = new Map<string, Response>();
    async keys() { return [...this.records.keys()].map(value => new Request(value)); }
    async match(input: Request | string) { return this.records.get(typeof input === "string" ? input : input.url)?.clone(); }
    async put(input: Request | string, response: Response) { this.records.set(typeof input === "string" ? input : input.url, response.clone()); }
    async delete(request: Request) { return this.records.delete(request.url); }
}
function fixture() {
    const store = new Map<string, MemoryCache>();
    let install: (event: { waitUntil(job: Promise<void>): void }) => void;
    runInNewContext(source, {
        self: { registration: { scope: `${origin}/` }, location: { origin }, addEventListener: (_: string, callback: typeof install) => { install = callback; } },
        caches: {
            keys: async () => [...store.keys()],
            open: async (name: string) => { if (!store.has(name)) store.set(name, new MemoryCache()); return store.get(name)!; },
        }, URL, Response, Headers, Date,
    });
    const previous = new MemoryCache(), archive = new MemoryCache();
    store.set(`workbox-precache-v2-${origin}/`, previous);
    store.set(archiveName, archive);
    return { previous, archive, store, install: () => new Promise<void>((resolve, reject) => install({ waitUntil: job => job.then(resolve, reject) })) };
}

it("archives old lazy modules without copying API data or another worker's scope", async () => {
    const f = fixture();
    await f.previous.put(url("qrcode"), new Response("old QR module"));
    await f.previous.put(`${origin}/api/promote`, new Response("private invoice"));
    await f.previous.put(`${origin}/index.html`, new Response("old shell"));
    const other = new MemoryCache(); f.store.set(`workbox-precache-v2-${origin}/other/`, other);
    await other.put(url("foreign"), new Response("other application"));
    await f.install();
    expect([...f.archive.records.keys()]).toEqual([url("qrcode")]);
    expect(await (await f.archive.match(url("qrcode")))?.text()).toBe("old QR module");
});

it("prunes expired and excess archived modules while keeping the captured generation", async () => {
    const f = fixture();
    await f.previous.put(url("active"), new Response("active"));
    for (let i = 0; i < 100; i++) await f.archive.put(url(`older${i}`), new Response("older", { headers: { date: new Date().toUTCString() } }));
    await f.archive.put(url("expired"), new Response("expired", { headers: { date: new Date(Date.now() - 86400001).toUTCString() } }));
    await f.install();
    expect(f.archive.records.size).toBe(96);
    expect(f.archive.records.has(url("active"))).toBe(true);
    expect(f.archive.records.has(url("expired"))).toBe(false);
});

it("fails oversized updates before replacing the archive", async () => {
    const f = fixture();
    await f.archive.put(url("retained"), new Response("retained"));
    await f.previous.put(url("oversized"), new Response(new Uint8Array(12 * 1024 * 1024 + 1)));
    await expect(f.install()).rejects.toThrow("update budget");
    expect([...f.archive.records.keys()]).toEqual([url("retained")]);
});

it("bounds retained bytes across generations", async () => {
    const f = fixture();
    await f.previous.put(url("active"), new Response(new Uint8Array(8 * 1024 * 1024)));
    await f.archive.put(url("older"), new Response(new Uint8Array(8 * 1024 * 1024), { headers: { date: new Date().toUTCString() } }));
    await f.install();
    expect([...f.archive.records.keys()]).toEqual([url("active")]);
});
