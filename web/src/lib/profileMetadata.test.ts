import { describe, expect, it } from "vitest";
import { bech32 } from "@scure/base";
import { profileMetadata } from "./profileMetadata";
const metadata = (fields: Record<string, unknown>) => profileMetadata({ content: JSON.stringify(fields) });
const lnurl = (url: string) => bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2048);
describe("profile identity fields", () => {
    it("retains the declared safe banner and Lightning destinations without discovering payments", () => {
        const lud06 = lnurl("https://pay.example.com/lnurl/alice");
        expect(metadata({ banner: "https://images.example.com/cover.jpg", lud16: "alice@pay.example.com", lud06 })).toMatchObject({ banner: "https://images.example.com/cover.jpg", lud16: "alice@pay.example.com", lud06 });
    });
    it.each(["javascript:alert(1)", "data:image/svg+xml,unsafe", "https://user:secret@example.com/a.jpg", "https://example.com/ a.jpg"])("rejects unsafe banner URLs: %s", banner => {
        expect(metadata({ banner })?.banner).toBeUndefined();
    });
    it.each([42, {}, "invalid", "<script>alert(1)</script>", "alice@example.com\nother", "lightning:alice@example.com"])("discards malformed Lightning addresses: %j", lud16 => {
        expect(metadata({ lud16 })?.lud16).toBeUndefined();
    });
    it("checks the LNURL checksum and decoded destination without expanding malformed data", () => {
        expect(metadata({ lud06: lnurl("https://pay.example.com/alice") })?.lud06).toBeTruthy();
        expect(metadata({ lud06: lnurl("javascript:alert(1)") })?.lud06).toBeUndefined();
        expect(metadata({ lud06: lnurl("https://user:secret@example.com/alice") })?.lud06).toBeUndefined();
        expect(metadata({ lud06: "lnurl1invalidchecksum" })?.lud06).toBeUndefined();
        expect(metadata({ lud06: [] })?.lud06).toBeUndefined();
    });
});
