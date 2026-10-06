import { decode } from "light-bolt11-decoder";
import { isMockInvoice, MOCK_INVOICE_MESSAGE } from "./invoice";

export interface WalletInvoice {
    invoice: string;
    paymentHash: string;
    amountMsats: number;
    amountless: boolean;
    description: string;
    descriptionHash: string;
    expiresAt: number;
    recipient: string;
}

export function normalizePaymentInput(value: string): string {
    return value.trim().replace(/^lightning:\/\//i, "").replace(/^lightning:/i, "");
}

export function satsToMsats(value: string): number {
    if (!/^\d+$/.test(value.trim())) throw new Error("Enter a whole number of sats greater than zero.");
    const amount = Number(value) * 1000;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid amount in sats.");
    return amount;
}

export function formatSats(msats: number): string {
    return (msats / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function readWalletInvoice(value: string, amount?: string, allowExpired = false): WalletInvoice {
    const invoice = normalizePaymentInput(value);
    if (isMockInvoice(invoice)) throw new Error(MOCK_INVOICE_MESSAGE);
    if (!/^lnbc(?:\d+[munp]?)?1/i.test(invoice)) throw new Error("Use a mainnet Lightning invoice or a Lightning Address.");
    let sections: { name: string; value?: unknown }[];
    try { sections = decode(invoice).sections; } catch { throw new Error("The Lightning invoice is invalid."); }
    const field = (name: string) => sections.find((section) => section.name === name)?.value;
    const hash = field("payment_hash");
    const timestamp = field("timestamp");
    const amountless = field("amount") === undefined;
    const amountMsats = amountless ? satsToMsats(amount ?? "") : Number(field("amount"));
    const expiry = field("expiry") ?? 3600;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof timestamp !== "number" || typeof expiry !== "number" || !Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
        throw new Error("The Lightning invoice has invalid payment details.");
    }
    const expiresAt = timestamp + expiry;
    if (!Number.isSafeInteger(expiresAt) || (!allowExpired && expiresAt <= Date.now() / 1000)) throw new Error("The invoice expired. Request a new one.");
    return { invoice, paymentHash: hash, amountMsats, amountless, description: String(field("description") ?? ""), descriptionHash: String(field("description_hash") ?? ""), expiresAt, recipient: "" };
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validWalletPreimage(preimage: string | undefined, hash: string): Promise<boolean> {
    if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/i.test(preimage)) return false;
    const bytes = Uint8Array.from(preimage.match(/../g)!, (pair) => parseInt(pair, 16));
    return await sha256Hex(bytes) === hash;
}

function securePaymentUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("The payment service returned an invalid URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("The payment service must use HTTPS.");
    return url;
}

async function paymentJson(url: URL): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(15000), credentials: "omit", referrerPolicy: "no-referrer" }); }
    catch { throw new Error("Could not reach the Lightning Address. Its service must allow browser requests."); }
    if (!response.ok) throw new Error("The Lightning Address service is unavailable.");
    const data = await response.json();
    if (!data || typeof data !== "object" || data.status === "ERROR") throw new Error("The Lightning Address service declined the request.");
    return data;
}

/** LUD-16 discovery and LUD-06 invoice checks, with no third-party proxy. */
export async function prepareWalletInvoice(input: string, amount: string): Promise<WalletInvoice> {
    const value = normalizePaymentInput(input);
    if (!value.includes("@")) return readWalletInvoice(value, amount);
    const match = /^([a-z0-9_.+-]+)@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.exec(value);
    if (!match || !match[2].includes(".")) throw new Error("Enter a valid Lightning Address.");
    const recipient = `${match[1]}@${match[2].toLowerCase()}`;
    const amountMsats = satsToMsats(amount);
    const data = await paymentJson(securePaymentUrl(`https://${match[2]}/.well-known/lnurlp/${encodeURIComponent(match[1])}`));
    if (data.tag !== "payRequest" || typeof data.callback !== "string" || typeof data.metadata !== "string" || !Number.isSafeInteger(data.minSendable) || !Number.isSafeInteger(data.maxSendable)) throw new Error("This address does not support Lightning payments.");
    if (amountMsats < Number(data.minSendable) || amountMsats > Number(data.maxSendable)) throw new Error(`This address accepts ${formatSats(Number(data.minSendable))} to ${formatSats(Number(data.maxSendable))} sats.`);
    if (data.payerData && Object.values(data.payerData as Record<string, { mandatory?: boolean }>).some((field) => field?.mandatory)) throw new Error("This address requires payer information. Use your wallet to pay it.");
    let metadata: unknown;
    try { metadata = JSON.parse(data.metadata); } catch { throw new Error("The address returned invalid payment metadata."); }
    if (!Array.isArray(metadata)) throw new Error("The address returned invalid payment metadata.");
    const description = metadata.find((entry) => Array.isArray(entry) && entry[0] === "text/plain")?.[1];
    if (typeof description !== "string") throw new Error("The address returned no payment description.");
    const callback = securePaymentUrl(data.callback);
    callback.searchParams.set("amount", String(amountMsats));
    const result = await paymentJson(callback);
    if (typeof result.pr !== "string") throw new Error("The address returned no Lightning invoice.");
    const prepared = readWalletInvoice(result.pr);
    const metadataHash = await sha256Hex(new TextEncoder().encode(data.metadata));
    if (prepared.amountMsats !== amountMsats || prepared.descriptionHash !== metadataHash) throw new Error("The address returned an invoice that does not match the requested payment.");
    return { ...prepared, recipient, description };
}
