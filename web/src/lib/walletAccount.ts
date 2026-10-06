import type { NWCClient, Nip47GetInfoResponse, Nip47GetBudgetResponse, Nip47Transaction } from "@getalby/sdk/nwc";
import { payInvoiceSafely, withTimeout, type PaymentWallet, type WalletAttempt } from "./walletPayment";
import { prepareWalletInvoice, readWalletInvoice, satsToMsats, validWalletPreimage, type WalletInvoice } from "./walletInvoice";

export type WalletTransaction = Omit<Partial<Nip47Transaction>, "state"> & {
    type: "incoming" | "outgoing"; payment_hash: string; amount: number;
    state?: "settled" | "pending" | "failed" | "accepted" | "expired";
};
export type HistoryFilter = "all" | "incoming" | "outgoing";
export interface WalletSend extends WalletInvoice { attempt?: WalletAttempt; feesMsats?: number }
export interface WalletReceive extends WalletInvoice { state: "pending" | "settled" | "expired" }
interface WalletSession { send: WalletSend | null; receive: WalletReceive | null; attempts: Record<string, WalletAttempt> }
export interface WalletAccount {
    id: string; methods: string[]; address: string;
    balance: number | null; balanceUpdatedAt: number; balanceError: string;
    budget: Nip47GetBudgetResponse | null; budgetError: string;
    history: WalletTransaction[]; historyFilter: HistoryFilter; historyLoaded: boolean;
    historyError: string; hasMore: boolean; refreshing: boolean; loadingMore: boolean;
    notifications: "unavailable" | "connecting" | "active" | "failed";
    send: WalletSend | null; receive: WalletReceive | null;
    busy: "prepare" | "send" | "receive" | "check" | null;
    actionError: string; receiveError: string; storageAvailable: boolean;
}
const empty = (): WalletAccount => ({
    id: "", methods: [], address: "", balance: null, balanceUpdatedAt: 0, balanceError: "",
    budget: null, budgetError: "", history: [], historyFilter: "all", historyLoaded: false,
    historyError: "", hasMore: false, refreshing: false, loadingMore: false,
    notifications: "unavailable", send: null, receive: null, busy: null,
    actionError: "", receiveError: "", storageAvailable: true,
});
let state = empty();
let client: NWCClient | undefined;
let payer: PaymentWallet | undefined;
let generation = 0;
let historyRequest = 0;
let stopNotifications: (() => void) | undefined;
let refreshing: Promise<void> | undefined;
const sessions = new Map<string, WalletSession>();
const listeners = new Set<() => void>();
export const getWalletAccount = () => state;
export const subscribeWalletAccount = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(patch: Partial<WalletAccount>) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); }
const storageKey = (id: string) => `holoboard-wallet-activity:${id}`;
function validInvoice(value: unknown): value is WalletInvoice {
    if (!value || typeof value !== "object") return false;
    const invoice = value as WalletInvoice;
    return typeof invoice.invoice === "string" && /^lnbc/i.test(invoice.invoice) && /^[0-9a-f]{64}$/.test(invoice.paymentHash) && Number.isSafeInteger(invoice.amountMsats) && invoice.amountMsats > 0 && Number.isSafeInteger(invoice.expiresAt) && typeof invoice.amountless === "boolean" && typeof invoice.recipient === "string" && typeof invoice.description === "string" && typeof invoice.descriptionHash === "string";
}
function validAttempt(value: unknown): value is WalletAttempt {
    if (!value || typeof value !== "object") return false;
    const attempt = value as WalletAttempt;
    return ["unpaid", "uncertain", "submitted"].includes(attempt.state) && typeof attempt.walletId === "string";
}
function session(id: string): WalletSession {
    const existing = sessions.get(id);
    if (existing) return existing;
    const result: WalletSession = { send: null, receive: null, attempts: {} };
    try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null");
        if (saved) {
            if (saved.attempts && typeof saved.attempts === "object") for (const [hash, attempt] of Object.entries(saved.attempts)) {
                if (/^[0-9a-f]{64}$/.test(hash) && validAttempt(attempt) && attempt.walletId === id) result.attempts[hash] = attempt;
            }
            if (validInvoice(saved.send)) result.send = { ...saved.send, attempt: result.attempts[saved.send.paymentHash] };
            if (validInvoice(saved.receive) && ["pending", "settled", "expired"].includes(saved.receive.state)) result.receive = saved.receive;
        }
    } catch { /* In-memory attempts still protect this page when storage is blocked. */ }
    sessions.set(id, result);
    return result;
}
function save(id: string) {
    try { sessionStorage.setItem(storageKey(id), JSON.stringify(session(id))); }
    catch { if (state.id === id) update({ storageAvailable: false }); }
}
function supported(method: string) { return state.methods.includes(method); }
function requireAccount(method: string) {
    if (!client || !state.id) throw new Error("Connect an NWC wallet first.");
    if (!supported(method)) throw new Error("This wallet connection does not allow this action.");
    return { wallet: client, id: state.id, current: generation };
}
const currentAccount = (current: number) => current === generation;
const msats = (amount: unknown): amount is number => typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;

export function clearWalletAccount() {
    generation++; historyRequest++;
    const stop = stopNotifications; stopNotifications = undefined;
    try { stop?.(); } catch { /* Clearing local credentials must survive a closed subscription. */ }
    client = undefined; payer = undefined; refreshing = undefined;
    update(empty());
}

export function attachWalletAccount(wallet: NWCClient, info: Nip47GetInfoResponse, paymentWallet?: PaymentWallet, address = "") {
    clearWalletAccount();
    client = wallet; payer = paymentWallet;
    const id = `nwc:${wallet.walletPubkey}:${wallet.publicKey}`;
    const stored = session(id);
    update({ id, methods: [...info.methods], address: typeof info.lud16 === "string" && info.lud16 ? info.lud16 : address, send: stored.send, receive: stored.receive });
    const current = generation;
    void refreshWalletAccount();
    const types = (Array.isArray(info.notifications) ? info.notifications : []).filter((type) => type === "payment_received" || type === "payment_sent");
    if (!types.length) return;
    update({ notifications: "connecting" });
    void wallet.subscribeNotifications((notification) => {
        if (!currentAccount(current)) return;
        const incoming = notification.notification;
        if (notification.notification_type === "payment_received" && state.receive?.paymentHash === incoming.payment_hash && incoming.type === "incoming" && incoming.amount === state.receive.amountMsats && transactionStatus(incoming) === "settled") {
            stored.receive = { ...state.receive, state: "settled" }; save(id); update({ receive: stored.receive, receiveError: "" });
        }
        void refreshWalletAccount();
    }, types).then((stop) => {
        if (!currentAccount(current)) { stop(); return; }
        stopNotifications = stop; update({ notifications: "active" });
    }).catch(() => { if (currentAccount(current)) update({ notifications: "failed" }); });
}

export function transactionStatus(transaction: WalletTransaction): string {
    if (transaction.state === "settled" || (transaction.settled_at ?? 0) > 0) return "settled";
    if (transaction.state === "failed") return "failed";
    if (transaction.state === "accepted") return "accepted";
    if (transaction.type === "incoming" && transaction.expires_at && transaction.expires_at <= Date.now()/1000) return "expired";
    return transaction.state ?? "pending";
}

async function fetchHistory(wallet: NWCClient, current: number, append = false) {
    const request = ++historyRequest;
    const filter = state.historyFilter;
    const offset = append ? state.history.length : 0;
    const limit = append ? 20 : Math.max(20, state.history.length);
    if (append) update({ loadingMore: true });
    try {
        const result = await withTimeout(wallet.listTransactions({ limit, offset, unpaid: true, ...(filter === "all" ? {} : { type: filter }) }), 15000, "Could not load wallet history.");
        if (!currentAccount(current) || request !== historyRequest) return;
        if (!Array.isArray(result.transactions) || result.transactions.some((tx) => !tx || !["incoming", "outgoing"].includes(tx.type) || typeof tx.payment_hash !== "string" || !/^[0-9a-f]{64}$/i.test(tx.payment_hash) || !msats(tx.amount) || (tx.state !== undefined && !["settled", "pending", "failed", "accepted", "expired"].includes(tx.state)))) throw new Error("Invalid history");
        const transactions = result.transactions as WalletTransaction[];
        const combined = append ? [...state.history, ...transactions] : transactions;
        const unique = new Map(combined.map((tx) => [`${tx.type}:${tx.payment_hash}`, tx]));
        update({ history: [...unique.values()], historyLoaded: true, historyError: "", hasMore: transactions.length >= limit });
    } catch {
        if (currentAccount(current) && request === historyRequest) update({ historyError: "Could not refresh history. Check the wallet connection and permissions." });
    } finally { if (currentAccount(current) && request === historyRequest) update({ loadingMore: false }); }
}

export function refreshWalletAccount(): Promise<void> {
    if (refreshing) return refreshing;
    if (!client) return Promise.resolve();
    const wallet = client, current = generation;
    update({ refreshing: true });
    const operation = async () => {
        const jobs: Promise<unknown>[] = [];
        if (supported("get_balance")) jobs.push((async () => {
            try {
                const result = await withTimeout(wallet.getBalance(), 15000, "Could not read wallet balance.");
                if (!msats(result.balance)) throw new Error("Invalid balance");
                if (currentAccount(current)) update({ balance: result.balance, balanceUpdatedAt: Date.now(), balanceError: "" });
            } catch { if (currentAccount(current)) update({ balanceError: "Could not refresh balance. Check the wallet connection and permissions." }); }
        })());
        if (supported("get_budget")) jobs.push((async () => {
            try {
                const result = await withTimeout(wallet.getBudget(), 15000, "Could not read the connection budget.");
                if ("total_budget" in result && (!msats(result.total_budget) || !msats(result.used_budget))) throw new Error("Invalid budget");
                if (currentAccount(current)) update({ budget: result, budgetError: "" });
            } catch { if (currentAccount(current)) update({ budgetError: "Could not refresh the connection budget." }); }
        })());
        if (supported("list_transactions")) jobs.push(fetchHistory(wallet, current));
        await Promise.allSettled(jobs);
        if (currentAccount(current)) { refreshing = undefined; update({ refreshing: false }); }
    };
    refreshing = operation();
    // A connection without read permissions finishes without awaiting a request.
    void refreshing.then(() => { if (currentAccount(current)) refreshing = undefined; });
    return refreshing;
}

export function setWalletHistoryFilter(filter: HistoryFilter) {
    if (filter === state.historyFilter || !client || !supported("list_transactions")) return;
    update({ historyFilter: filter, history: [], historyLoaded: false, historyError: "", hasMore: false });
    void fetchHistory(client, generation);
}
export async function loadMoreWalletHistory() {
    if (!client || !state.hasMore || state.loadingMore || state.refreshing) return;
    await fetchHistory(client, generation, true);
}

export async function prepareWalletSend(input: string, amount: string) {
    if (state.busy) return;
    const { id, current } = requireAccount("pay_invoice");
    if (state.send?.attempt?.state === "uncertain") throw new Error("Check the current payment before preparing another one.");
    update({ busy: "prepare", actionError: "" });
    try {
        const invoice = await prepareWalletInvoice(input, amount);
        if (!currentAccount(current)) return;
        const stored = session(id);
        stored.send = { ...invoice, attempt: stored.attempts[invoice.paymentHash] };
        save(id); update({ send: stored.send });
    } catch (failure) { if (currentAccount(current)) update({ actionError: failure instanceof Error ? failure.message : "Could not prepare this payment." }); }
    finally { if (currentAccount(current)) update({ busy: null }); }
}

export function resetWalletSend() {
    if (!state.id || state.busy || state.send?.attempt?.state === "uncertain") return;
    session(state.id).send = null; save(state.id); update({ send: null, actionError: "" });
}

/** Checking an uncertain send never sends another payment in the same action. */
export async function submitWalletSend() {
    if (state.busy || !state.send || !payer) return;
    const { id, current } = requireAccount("pay_invoice");
    const draft = state.send, paymentWallet = payer, stored = session(id);
    if (draft.attempt?.state === "submitted") return;
    update({ busy: draft.attempt?.state === "uncertain" ? "check" : "send", actionError: "" });
    const saveAttempt = (attempt: WalletAttempt) => {
        stored.attempts[draft.paymentHash] = attempt;
        stored.send = { ...draft, attempt }; save(id);
        if (currentAccount(current)) update({ send: stored.send });
    };
    try {
        if (draft.attempt?.state === "uncertain") {
            if (!paymentWallet.lookupPayment || draft.attempt.walletId !== id) throw new Error("This connection cannot check the payment. Check the original wallet history.");
            const status = await paymentWallet.lookupPayment(draft.paymentHash);
            if (status.state === "paid" && await validWalletPreimage(status.preimage, draft.paymentHash)) saveAttempt({ state: "submitted", walletId: id, preimage: status.preimage });
            else if (status.state === "unpaid") saveAttempt({ state: "unpaid", walletId: id });
            else throw new Error("Payment status is still uncertain. Check again later or check the original wallet history.");
            return;
        }
        const decoded = readWalletInvoice(draft.invoice, String(draft.amountMsats / 1000));
        if (decoded.paymentHash !== draft.paymentHash || decoded.amountMsats !== draft.amountMsats || decoded.amountless !== draft.amountless || decoded.expiresAt !== draft.expiresAt) throw new Error("The saved payment details do not match this invoice. Review it again.");
        const guarded: PaymentWallet = { ...paymentWallet, sendPayment: async (invoice) => {
            const proof = await paymentWallet.sendPayment(invoice, draft.amountless ? draft.amountMsats : undefined);
            if (!await validWalletPreimage(proof.preimage, draft.paymentHash)) throw new Error("The wallet did not provide a valid payment proof. Check its history.");
            if (msats(proof.feesPaidMsats)) draft.feesMsats = proof.feesPaidMsats;
            return proof;
        } };
        await payInvoiceSafely(guarded, draft.invoice, draft.paymentHash, draft.attempt, saveAttempt, draft.expiresAt);
    } catch (failure) { if (currentAccount(current)) update({ actionError: failure instanceof Error ? failure.message : "The wallet did not confirm this payment." }); }
    finally { if (currentAccount(current)) { update({ busy: null }); void refreshWalletAccount(); } }
}

export async function createWalletReceive(amount: string, description: string) {
    if (state.busy) return;
    const { wallet, id, current } = requireAccount("make_invoice");
    update({ busy: "receive", receiveError: "" });
    try {
        const amountMsats = satsToMsats(amount);
        const result = await withTimeout(wallet.makeInvoice({ amount: amountMsats, description: description.trim(), expiry: 3600 }), 15000, "The wallet did not return an invoice. Check its history before creating another.");
        if (!currentAccount(current)) return;
        const invoice = readWalletInvoice(result.invoice);
        if (invoice.amountMsats !== amountMsats || result.payment_hash !== invoice.paymentHash || result.type !== "incoming") throw new Error("The wallet returned an invoice with different payment details.");
        const stored = session(id);
        stored.receive = { ...invoice, state: transactionStatus(result) === "settled" ? "settled" : "pending" };
        save(id); update({ receive: stored.receive });
    } catch (failure) { if (currentAccount(current)) update({ receiveError: failure instanceof Error && !('code' in failure) ? failure.message : "Could not create an invoice. Check wallet permissions." }); }
    finally { if (currentAccount(current)) update({ busy: null }); }
}

const checkingReceive = new Set<string>();
export async function checkWalletReceive() {
    if (!client || !state.receive || state.receive.state === "settled" || !supported("lookup_invoice")) return;
    const { wallet, id, current } = requireAccount("lookup_invoice");
    const receive = state.receive;
    const request = `${current}:${receive.paymentHash}`;
    if (checkingReceive.has(request)) return;
    checkingReceive.add(request);
    try {
        const result = await withTimeout(wallet.lookupInvoice({ payment_hash: receive.paymentHash }), 12000, "Could not check the incoming payment.");
        if (!currentAccount(current) || state.receive?.paymentHash !== receive.paymentHash) return;
        if (result.payment_hash !== receive.paymentHash || result.type !== "incoming" || result.amount !== receive.amountMsats) throw new Error("Mismatched invoice");
        const status = transactionStatus(result);
        const stored = session(id);
        stored.receive = { ...receive, state: status === "settled" ? "settled" : receive.expiresAt <= Date.now()/1000 ? "expired" : "pending" };
        save(id); update({ receive: stored.receive, receiveError: "" });
        if (status === "settled") void refreshWalletAccount();
    } catch { if (currentAccount(current)) update({ receiveError: "Could not check this invoice. Check the wallet connection or its history." }); }
    finally { checkingReceive.delete(request); }
}
