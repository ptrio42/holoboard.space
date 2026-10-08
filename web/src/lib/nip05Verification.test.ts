import { afterEach, describe, expect, it, vi } from "vitest";
import { nip05Endpoint, verifyNip05 } from "./nip05Verification";

const pubkey = "a".repeat(64), other = "b".repeat(64);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("NIP-05 domain checks", () => {
    it("uses the exact local name and the canonical HTTPS domain", () => {
        expect(nip05Endpoint("alice@Example.COM")?.href).toBe("https://example.com/.well-known/nostr.json?name=alice");
        expect(nip05Endpoint("_@example.com")?.searchParams.get("name")).toBe("_");
        expect(nip05Endpoint("example.com")?.searchParams.get("name")).toBe("_");
    });
    it.each(["alice+tag@example.com", "Alice@example.com", "alice@127.0.0.1", "alice@host.local", "alice@host.internal", "alice@host.localhost", "alice@localhost", "alice@-host.com", "alice@host_.com", "alice@host.com:443", "alice@host.com/path", "alice@user:pass@host.com", "a".repeat(321)])("does not fetch unsupported or local identifiers: %s", async identifier => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        expect((await verifyNip05(pubkey, identifier)).state).toBe("invalid");
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("verifies only an exact own-property mapping and omits credentials and redirects", async () => {
        const fetcher = vi.fn().mockResolvedValue(Response.json({ names: { alice: pubkey } })); vi.stubGlobal("fetch", fetcher);
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("verified");
        expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });
    it.each([{ alice: other }, {}, { someoneelse: pubkey }])("distinguishes a valid document without the matching key: %j", async names => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ names })));
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("mismatch");
    });
    it.each([null, [], { names: [] }, { names: null }, { names: { alice: 42 } }, { names: { alice: "A".repeat(64) } }])("keeps malformed responses inconclusive: %j", async document => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(document)));
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("unavailable");
    });
    it("keeps network and redirect failures inconclusive", async () => {
        const fetcher = vi.fn().mockRejectedValue(new TypeError("Network or redirect blocked")); vi.stubGlobal("fetch", fetcher);
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("unavailable");
        fetcher.mockResolvedValue(new Response("redirect", { status: 302, headers: { location: "https://other.example.com" } }));
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("unavailable");
        fetcher.mockResolvedValue(new Response("not found", { status: 404 }));
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("unavailable");
    });
    it("bounds streamed responses even without a trustworthy length header", async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
        expect((await verifyNip05(pubkey, "alice@example.com")).state).toBe("unavailable");
        expect(cancel).toHaveBeenCalledOnce();
    });
    it("cancels a stalled response body when its profile closes", async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"names":')); }, cancel });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
        const controller = new AbortController();
        const result = verifyNip05(pubkey, "alice@example.com", controller.signal);
        await vi.waitFor(() => expect(stream.locked).toBe(true));
        controller.abort("profile closed");
        await expect(result).rejects.toBe("profile closed");
        expect(cancel).toHaveBeenCalledOnce();
    });
    it("limits requests to eight seconds, including an unavailable domain", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)))));
        const result = verifyNip05(pubkey, "alice@example.com");
        await vi.advanceTimersByTimeAsync(8001);
        expect((await result).state).toBe("unavailable");
    });
});
