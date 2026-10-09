import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readReplyAttachments, readReplyDraft, saveReplyAttachments, saveReplyDraft } from "./replyDrafts";
let storage: Map<string, string>;
const id = "a".repeat(64);
beforeEach(() => {
    storage = new Map([["holoboard-signer", "signer connection"], ["holoboard-payment:fixture", "unpaid invoice"]]);
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
it("restores parent-specific drafts without touching connections or invoices", () => {
    expect(saveReplyDraft(id, "First draft")).toBe(true);
    expect(saveReplyDraft("b".repeat(64), "Second draft")).toBe(true);
    expect(readReplyDraft(id)).toEqual({ text: "First draft", saved: true });
    expect(saveReplyDraft(id, "")).toBe(true);
    expect(readReplyDraft(id).text).toBe("");
    expect(storage.get("holoboard-signer")).toBe("signer connection");
    expect(storage.get("holoboard-payment:fixture")).toBe("unpaid invoice");
});
it("bounds UTF-8 bytes and capacity without evicting drafts", () => {
    for (let i = 0; i < 8; i++) expect(saveReplyDraft(i.toString().repeat(64), `draft ${i}`)).toBe(true);
    expect(saveReplyDraft(id, "overflow")).toBe(false);
    expect(readReplyDraft("0".repeat(64)).text).toBe("draft 0");
    expect(saveReplyDraft("0".repeat(64), "😀".repeat(4097))).toBe(false);
    expect(readReplyDraft("0".repeat(64)).text).toBe("draft 0");
});
it("does not overwrite invalid or unavailable storage", () => {
    storage.set("holoboard-reply-drafts-v1", "broken");
    expect(readReplyDraft(id)).toEqual({ text: "", saved: false });
    expect(saveReplyDraft(id, "draft")).toBe(false);
    expect(storage.get("holoboard-reply-drafts-v1")).toBe("broken");
    vi.stubGlobal("sessionStorage", { getItem() { throw new DOMException("blocked"); } });
    expect(saveReplyDraft(id, "draft")).toBe(false);
});
it("restores uploaded attachment descriptions separately from backwards-compatible text drafts", () => {
    const media = [{ url: "https://media.example.com/file.png", type: "image/png", alt: "Description" }];
    expect(saveReplyAttachments(id, media)).toBe(true); expect(saveReplyDraft(id, media[0].url)).toBe(true);
    expect(readReplyAttachments(id)).toEqual({ attachments: media, saved: true });
    expect(JSON.parse(storage.get("holoboard-reply-drafts-v1")!)[id]).toBe(media[0].url);
    storage.set("holoboard-reply-media-v1", "broken");
    expect(saveReplyAttachments(id, [])).toBe(false);
    expect(storage.get("holoboard-reply-media-v1")).toBe("broken");
    expect(readReplyDraft(id).text).toBe(media[0].url);
});
