import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, type EventTemplate } from "nostr-tools/pure";
import { attachmentTags, mediaUrl, readMediaJson, uploadMedia } from "./composerMedia";

afterEach(() => vi.unstubAllGlobals());
it("limits active media destinations and includes only metadata for URLs retained in the text", () => {
    const attachment = { url: "https://media.example.com/a.png", type: "image/png", alt: "A blue pixel", sha256: "a".repeat(64), size: 12 };
    expect(attachmentTags([attachment], attachment.url)).toEqual([["imeta", `url ${attachment.url}`, "m image/png", `x ${attachment.sha256}`, "size 12", "alt A blue pixel"]]);
    expect(attachmentTags([attachment], "Removed attachment")).toEqual([]);
    for (const url of ["javascript:alert(1)", "data:image/png;base64,AA", "http://example.com/a.png", "https://name:secret@example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/a.png"]) expect(() => mediaUrl(url)).toThrow();
    expect(() => attachmentTags([{ ...attachment, alt: "a\nx forged" }], attachment.url)).toThrow("metadata");
});
it("bounds JSON bytes before parsing and rejects a payment requirement without following it", async () => {
    await expect(readMediaJson(new Response("x".repeat(65537)))).rejects.toThrow("limit");
    await expect(readMediaJson(new Response("invoice", { status: 402 }))).rejects.toThrow("requires payment");
});
it("scopes Blossom authorization to the file and server and checks the returned descriptor", async () => {
    const key = generateSecretKey(), file = new File(["file body"], "image.png", { type: "image/png" });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
    const requests: { url: string; headers: Record<string, string>; body?: File | FormData }[] = [];
    vi.stubGlobal("XMLHttpRequest", class {
        upload = {}; status = 201; responseText = JSON.stringify({ url: `https://media.example.com/${hash}.png`, sha256: hash, size: file.size });
        onload?: () => void; current = { url: "", headers: {} as Record<string, string>, body: undefined as File | FormData | undefined };
        open(method: string, url: string) { expect(method).toBe("PUT"); this.current.url = url; requests.push(this.current); }
        setRequestHeader(key: string, value: string) { this.current.headers[key] = value; }
        send(body: File | FormData) { this.current.body = body; queueMicrotask(() => this.onload?.()); }
    });
    const signed: EventTemplate[] = [];
    const result = await uploadMedia(file, { name: "Custom", protocol: "blossom", url: "https://media.example.com" }, async template => { signed.push(template); return finalizeEvent(template, key); }, new AbortController().signal, () => {});
    expect(result.sha256).toBe(hash); expect(requests[0].body).toBe(file);
    expect(signed[0]).toMatchObject({ kind: 24242, tags: [["t", "upload"], ["x", hash], ["server", "media.example.com"], ["expiration", expect.any(String)]] });
    expect(requests[0].headers["X-SHA-256"]).toBe(hash);
    expect(requests[0].headers.Authorization).toMatch(/^Nostr [A-Za-z0-9_-]+$/);
});
it("does not send a file after cancellation during signer approval and serializes upload admission", async () => {
    const controller = new AbortController(), key = generateSecretKey();
    let approval!: (event: ReturnType<typeof finalizeEvent>) => void, template!: EventTemplate;
    const file = new File(["file"], "file.txt", { type: "text/plain" });
    const upload = uploadMedia(file, { name: "Custom", protocol: "blossom", url: "https://media.example.com" }, input => { template = input; return new Promise(resolve => { approval = resolve; }); }, controller.signal, () => {});
    const rejected = expect(upload).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(approval).toBeTypeOf("function"));
    await expect(uploadMedia(file, { name: "Other", protocol: "blossom", url: "https://other.example.com" }, async input => finalizeEvent(input, key), controller.signal, () => {})).rejects.toThrow("already active");
    controller.abort(); approval(finalizeEvent(template, key)); await rejected;
});
