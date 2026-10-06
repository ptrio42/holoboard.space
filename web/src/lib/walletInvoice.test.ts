import { afterEach, describe, expect, it, vi } from "vitest";
import { addressMetadata, addressMetadataHash, paymentHash, preimage, walletInvoice } from "../../tests/helpers/walletFixture";
import { formatSats, prepareWalletInvoice, readWalletInvoice, satsToMsats, validWalletPreimage } from "./walletInvoice";

afterEach(() => vi.unstubAllGlobals());
describe("wallet invoice review", () => {
    it("reads mainnet invoices and defaults expiry to one hour", () => {
        const timestamp = Math.floor(Date.now()/1000);
        expect(readWalletInvoice(`lightning:${walletInvoice({ timestamp }).toUpperCase()}`)).toMatchObject({ paymentHash, amountMsats: 21000, amountless: false, expiresAt: timestamp + 3600 });
        expect(readWalletInvoice(walletInvoice(), "999").amountMsats).toBe(21000);
    });
    it("requires an explicit amount for amountless invoices", () => {
        expect(() => readWalletInvoice(walletInvoice({ amountMsats: null }))).toThrow("whole number");
        expect(readWalletInvoice(walletInvoice({ amountMsats: null }), "42")).toMatchObject({ amountMsats: 42000, amountless: true });
    });
    it("rejects mocks, testnet, bad checksums and expired invoices", () => {
        expect(() => readWalletInvoice("lnbc21...mock_invoice")).toThrow("test invoices");
        expect(() => readWalletInvoice(walletInvoice({ network: "tb" }))).toThrow("mainnet");
        expect(() => readWalletInvoice(walletInvoice().slice(0, -1) + "q")).toThrow();
        expect(() => readWalletInvoice(walletInvoice({ timestamp: 1000 }))).toThrow("expired");
    });
    it("keeps millisatoshi precision and rejects invalid amounts", () => {
        expect(formatSats(21001)).toBe("21.001");
        for (const value of ["", "0", "-1", "1.1", "Infinity", "9007199254740991"]) expect(() => satsToMsats(value)).toThrow();
    });
    it("checks the payment proof against its invoice hash", async () => {
        expect(await validWalletPreimage(preimage, paymentHash)).toBe(true);
        expect(await validWalletPreimage("ab".repeat(32), paymentHash)).toBe(false);
        expect(await validWalletPreimage(undefined, paymentHash)).toBe(false);
    });
});

describe("Lightning Address invoice preparation", () => {
    function mockAddress(invoice: string, callback = "https://recipient.example/pay?token=preserved") {
        const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ tag: "payRequest", minSendable: 1000, maxSendable: 1000000, metadata: addressMetadata, callback }))).mockResolvedValueOnce(new Response(JSON.stringify({ pr: invoice })));
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }
    it("requests the exact amount directly and verifies its metadata commitment", async () => {
        const fetch = mockAddress(walletInvoice({ metadataHash: addressMetadataHash }));
        expect(await prepareWalletInvoice("lightning:name@recipient.example", "21")).toMatchObject({ recipient: "name@recipient.example", description: "Test recipient", amountMsats: 21000 });
        expect(String(fetch.mock.calls[1][0])).toBe("https://recipient.example/pay?token=preserved&amount=21000");
        expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    });
    it("rejects amount or metadata mismatches without sending", async () => {
        for (const options of [{ amountMsats: 22000, metadataHash: addressMetadataHash }, {}]) {
            mockAddress(walletInvoice(options));
            await expect(prepareWalletInvoice("name@recipient.example", "21")).rejects.toThrow("does not match");
        }
    });
    it("rejects insecure callbacks before requesting an invoice", async () => {
        const fetch = mockAddress(walletInvoice(), "http://recipient.example/pay");
        await expect(prepareWalletInvoice("name@recipient.example", "21")).rejects.toThrow("HTTPS");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
