import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, verifyEvent, type EventTemplate } from "nostr-tools/pure";
import { attachmentTags, mediaUrl, readMediaJson, uploadMedia } from "./composerMedia";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
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
it("uses Primal's legacy decoder without changing authorization on other Blossom origins or retrying", async () => {
    const key = generateSecretKey(), file = new File(["file body"], "image1.png", { type: "image/png" });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
    const headers: Record<string, string>[] = [], sends = vi.fn();
    vi.stubGlobal("XMLHttpRequest", class {
        upload = {}; status = 201; responseText = JSON.stringify({ url: `https://image.nostr.build/${hash}.png`, sha256: hash, size: file.size });
        onload?: () => void; current: Record<string, string> = {};
        open() { headers.push(this.current); }
        setRequestHeader(key: string, value: string) { this.current[key] = value; }
        send() { sends(); queueMicrotask(() => this.onload?.()); }
    });
    for (const url of ["https://blossom.primal.net", "https://blossom.nostr.build", "https://blossom.primal.net.example.com"]) {
        await uploadMedia(file, { name: "Selected", protocol: "blossom", url }, async input => finalizeEvent(input, key), new AbortController().signal, () => {});
        const encoded = headers.at(-1)!.Authorization.replace(/^Nostr /, "");
        if (url === "https://blossom.primal.net") {
            expect(encoded).toMatch(/^[A-Za-z0-9+/]+={1,2}$/); expect(encoded.length % 4).toBe(0);
        } else expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        const event = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
        expect(verifyEvent(event)).toBe(true);
        expect(event.tags).toContainEqual(["x", hash]); expect(event.tags).toContainEqual(["server", new URL(url).hostname]);
    }
    expect(sends).toHaveBeenCalledTimes(3);
});

async function queuedUpload(processingUrl = "https://cdn.example.com/job/42", payment_request = "") {
    const key = generateSecretKey(), file = new File(["original file"], "image.png", { type: "image/png" });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
    const sends = vi.fn();
    vi.stubGlobal("XMLHttpRequest", class {
        upload = {}; status = 202; responseText = JSON.stringify({ status: "success", processing_url: processingUrl, payment_request,
            nip94_event: { tags: [["url", "https://cdn.example.com/unfinished.webp"], ["ox", hash], ["m", "image/png"]] } });
        onload?: () => void;
        open(method: string, url: string) { expect(method).toBe("POST"); expect(url).toBe("https://cdn.example.com/"); }
        setRequestHeader() {}
        send() { sends(); queueMicrotask(() => this.onload?.()); }
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ api_url: "https://cdn.example.com" })));
    vi.stubGlobal("fetch", fetchMock);
    const sign = vi.fn(async (template: EventTemplate) => finalizeEvent(template, key));
    const controller = new AbortController(), progress = vi.fn();
    const upload = () => uploadMedia(file, { name: "Check", protocol: "nip96", url: "https://example.com", api: "https://cdn.example.com" }, sign, controller.signal, progress);
    return { upload, hash, sign, fetchMock, sends, controller, progress };
}
it("reads queued NIP-96 processing with fresh GET tokens and attaches only final transformed metadata", async () => {
    const { upload, hash, sign, fetchMock, sends, progress } = await queuedUpload();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ api_url: "https://cdn.example.com" })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "processing", percentage: 30 })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "success", processing_url: "", nip94_event: { tags: [
            ["url", "https://cdn.example.com/final.webp"], ["ox", hash], ["x", "f".repeat(64)], ["m", "image/webp"]] } }), { status: 201 }));
    const promise = upload();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(progress).not.toHaveBeenCalledWith(100);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toMatchObject({ url: "https://cdn.example.com/final.webp", type: "image/webp", sha256: "f".repeat(64) });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls.map(([event]) => event.tags)).toEqual([
        [["u", "https://cdn.example.com/"], ["method", "POST"], ["payload", hash]],
        [["u", "https://cdn.example.com/job/42"], ["method", "GET"]],
        [["u", "https://cdn.example.com/job/42"], ["method", "GET"]],
    ]);
    const reads = fetchMock.mock.calls.slice(1) as unknown as [string, RequestInit][];
    expect(reads.map(([url]) => url)).toEqual(["https://cdn.example.com/job/42", "https://cdn.example.com/job/42"]);
    expect(reads[0][1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(reads[0][1].headers).not.toEqual(reads[1][1].headers);
    expect(progress).toHaveBeenLastCalledWith(100);
});
it.each([
    ["https://other.example.com/job/42", "", "different origin"],
    ["https://cdn.example.com/job/42", "lnbc123", "requires payment"],
])("rejects unsafe or paid processing before requesting another signature (%s)", async (url, payment, error) => {
    const { upload, sign, sends, fetchMock } = await queuedUpload(url, payment);
    await expect(upload()).rejects.toThrow(error);
    expect(sign).toHaveBeenCalledTimes(1); expect(sends).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("bounds processing reads and preserves uncertainty without another file transfer", async () => {
    const { upload, fetchMock, sends, sign } = await queuedUpload();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ api_url: "https://cdn.example.com" })))
        .mockImplementation(async () => new Response(JSON.stringify({ status: "processing", percentage: 99 })));
    const rejected = expect(upload()).rejects.toThrow("file may already be on the server");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (let attempt = 0; attempt < 7; attempt++) await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(9); expect(sends).toHaveBeenCalledTimes(1); expect(sign).toHaveBeenCalledTimes(9);
});
it("cancels pending processing approval before GET and releases upload admission", async () => {
    const { upload, sign, controller, fetchMock, sends } = await queuedUpload();
    let approve!: () => void;
    sign.mockImplementationOnce(async template => finalizeEvent(template, generateSecretKey()))
        .mockImplementationOnce(template => new Promise(resolve => { approve = () => resolve(finalizeEvent(template, generateSecretKey())); }));
    const rejected = expect(upload()).rejects.toThrow("processing did not finish");
    await vi.waitFor(() => expect(approve).toBeTypeOf("function"));
    controller.abort(); approve(); await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(sends).toHaveBeenCalledTimes(1);
    const next = await queuedUpload("https://other.example.com/job/42");
    await expect(next.upload()).rejects.toThrow("different origin");
});
it("does not send a processing GET after slow approval has aged its HTTP token", async () => {
    const { upload, sign, fetchMock } = await queuedUpload();
    vi.useFakeTimers({ toFake: ["Date"] });
    sign.mockImplementationOnce(async template => finalizeEvent(template, generateSecretKey()))
        .mockImplementationOnce(async template => {
            const event = finalizeEvent(template, generateSecretKey());
            vi.setSystemTime(Date.now() + 45000); return event;
        });
    await expect(upload()).rejects.toThrow("processing did not finish");
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("rejects a changed processing URL or mismatched original hash without attaching a result", async () => {
    for (const response of [
        { status: "success", processing_url: "https://cdn.example.com/job/43" },
        { status: "success", nip94_event: { tags: [["url", "https://cdn.example.com/final.webp"], ["ox", "0".repeat(64)]] } },
    ]) {
        const { upload, fetchMock, progress } = await queuedUpload();
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ api_url: "https://cdn.example.com" })))
            .mockResolvedValueOnce(new Response(JSON.stringify(response)));
        await expect(upload()).rejects.toThrow();
        expect(progress).not.toHaveBeenCalledWith(100);
    }
});
