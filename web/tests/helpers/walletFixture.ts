import { bech32 } from "@scure/base";

export const preimage = "42".repeat(32);
export const paymentHash = "425ed4e4a36b30ea21b90e21c712c649e8214c29b7eaf68089d1039c6e55384c";
export const incomingHash = "a1".repeat(32);
export const addressMetadata = JSON.stringify([["text/plain", "Test recipient"]]);
export const addressMetadataHash = "de5a96a63ce12355025e28e83ec243b5c92588b710f49963f1218c44f4687140";
const hexBytes = (value: string) => Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));

const words = (value: number, length = 0): number[] => {
    const result = [];
    do { result.unshift(value % 32); value = Math.floor(value / 32); } while (value);
    while (result.length < length) result.unshift(0);
    return result;
};
const tag = (code: number, data: number[]) => [code, ...words(data.length, 2), ...data];

/** Bech32 invoice fixtures have placeholder signatures and are only used by mocks. */
export function walletInvoice(options: { amountMsats?: number | null; hash?: string; description?: string; metadataHash?: string; timestamp?: number; expiry?: number; network?: string } = {}): string {
    const amount = options.amountMsats === undefined ? 21000 : options.amountMsats;
    const prefix = `ln${options.network ?? "bc"}${amount === null ? "" : `${amount * 10}p`}`;
    const hash = options.hash ?? paymentHash;
    const description = options.metadataHash
        ? tag(23, bech32.toWords(hexBytes(options.metadataHash)))
        : tag(13, bech32.toWords(new TextEncoder().encode(options.description ?? "Wallet test invoice")));
    const data = [
        ...words(options.timestamp ?? Math.floor(Date.now()/1000), 7),
        ...tag(1, bech32.toWords(hexBytes(hash))),
        ...description,
        ...(options.expiry === undefined ? [] : tag(6, words(options.expiry))),
        ...new Array(104).fill(0),
    ];
    return bech32.encode(prefix, data, 5000);
}
