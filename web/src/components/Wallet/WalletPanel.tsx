import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { noteEncode } from "nostr-tools/nip19";
import { checkWalletReceive, createWalletReceive, getWalletAccount, loadMoreWalletHistory, prepareWalletSend, refreshWalletAccount, resetWalletSend, reviewWalletSendAttempt, setWalletHistoryFilter, submitWalletSend, subscribeWalletAccount, transactionStatus, type HistoryFilter, type WalletTransaction } from "../../lib/walletAccount";
import { formatSats } from "../../lib/walletInvoice";
import { CopyButton } from "../ui/CopyButton";
import { PixelButton, PixelLink } from "../ui/PixelButton";
import { StatusMessage } from "../ui/StatusMessage";
import { QrCode } from "../ui/QrCode";
import { WalletQrScanner } from "./WalletQrScanner";
import "./WalletPanel.css";

const FIELD = "focus-pixel w-full border-2 border-cyan-400/40 bg-void px-3 py-2 text-cyan-100";
const LABEL = "promotion-label block mb-2 text-cyan-200/70";
const connectionLabel = (id: string) => id.startsWith("nwc:") ? `${id.split(":")[1].slice(0, 8)} / ${id.split(":")[2].slice(0, 8)}` : id;
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const permissions = [
    ["get_balance", "Balance"], ["pay_invoice", "Send"], ["make_invoice", "Receive"],
    ["list_transactions", "History"], ["lookup_invoice", "Payment checks"], ["get_budget", "Connection budget"],
] as const;

type WalletSymbol = "send" | "receive" | "history" | "connection" | "lightning" | "hide" | "show" | "refresh";
function WalletIcon({ symbol }: { symbol: WalletSymbol }) {
    const paths: Record<WalletSymbol, string> = {
        send: "M7 1h2v2h2v2h2v2h-2V5H9v10H7V5H5v2H3V5h2V3h2z",
        receive: "M7 1h2v10h2V9h2v2h-2v2H9v2H7v-2H5v-2H3V9h2v2h2z",
        history: "M3 1h10v2H3zM1 3h2v10H1zM13 3h2v10h-2zM3 13h10v2H3zM7 4h2v4h3v2H7z",
        connection: "M2 3h12v2H2zM2 11h12v2H2zM5 1h2v6H5zM10 9h2v6h-2z",
        lightning: "M8 0h5v2h-2v2H9v2h5v2h-2v2h-2v2H8v2H6v2H3l4-8H2V6h2V4h2V2h2z",
        hide: "M0 2h2v2H0zM2 4h2v2H2zM4 6h2v2H4zM6 8h2v2H6zM8 10h2v2H8zM10 12h2v2h-2zM12 14h2v2h-2zM6 3h5v2H6zM11 5h2v2h-2zM13 7h2v2h-2zM1 7h2v2H1zM3 9h2v2H3zM5 11h3v2H5z",
        show: "M5 3h6v2H5zM3 5h2v2H3zM11 5h2v2h-2zM1 7h2v2H1zM13 7h2v2h-2zM3 9h2v2H3zM11 9h2v2h-2zM5 11h6v2H5zM6 6h4v4H6z",
        refresh: "M5 1h6v2H5zM3 3h2v2H3zM11 3h2v2h2v2H9V5h2zM1 5h2v4H1zM13 7h2v4h-2zM1 9h6v2H5v2H3v-2H1zM11 11h2v2h-2zM5 13h6v2H5z",
    };
    return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" shapeRendering="crispEdges"><path d={paths[symbol]} /></svg>;
}

function Transaction({ transaction }: { transaction: WalletTransaction }) {
    const incoming = transaction.type === "incoming";
    const status = transactionStatus(transaction);
    const tags = transaction.metadata?.nostr?.tags;
    const noteId = Array.isArray(tags) ? tags.find((tag) => Array.isArray(tag) && tag[0] === "e" && typeof tag[1] === "string")?.[1] : undefined;
    const description = typeof transaction.description === "string" ? transaction.description : "";
    return <details className={`wallet-transaction wallet-transaction--${incoming ? "incoming" : "outgoing"}`}>
        <summary className="wallet-transaction-summary focus-pixel">
            <div className="wallet-transaction-row">
                <span className="wallet-transaction-icon"><WalletIcon symbol={incoming ? "receive" : "send"} /></span>
                <span className="min-w-0 flex-1"><span className="promotion-label block text-cyan-100">{incoming ? "Received" : "Sent"}</span><span className="mt-1 block truncate text-xs text-cyan-100/60">{description || (incoming ? "Incoming payment" : "Outgoing payment")}</span></span>
                <span className="wallet-transaction-amount"><span className={incoming ? "text-neon-gold" : "text-cyan-100"}>{incoming ? "+" : "-"}{formatSats(transaction.amount)} sats</span><span className={`block text-xs ${status === "failed" ? "text-neon-pink" : "text-cyan-100/60"}`}>{status === "settled" ? "Paid" : status.charAt(0).toUpperCase() + status.slice(1)}</span></span>
            </div>
        </summary>
        <dl className="wallet-transaction-details space-y-3 text-xs">
            <div><dt className={LABEL}>Date</dt><dd>{transaction.settled_at || transaction.created_at ? date(transaction.settled_at || transaction.created_at!) : "Not provided"}</dd></div>
            <div><dt className={LABEL}>Routing fee</dt><dd>{typeof transaction.fees_paid === "number" ? `${formatSats(transaction.fees_paid)} sats` : "Not provided"}</dd></div>
            {transaction.expires_at && status !== "settled" ? <div><dt className={LABEL}>Expires</dt><dd>{date(transaction.expires_at)}</dd></div> : null}
            {description && <div><dt className={LABEL}>Description</dt><dd className="break-words">{description}</dd></div>}
            <div><dt className={LABEL}>Payment hash</dt><dd className="mb-2 break-all select-all">{transaction.payment_hash}</dd><CopyButton value={transaction.payment_hash} label="Copy payment hash" /></div>
            {typeof transaction.invoice === "string" && transaction.invoice && <CopyButton value={transaction.invoice} label="Copy invoice" />}
            {noteId && /^[0-9a-f]{64}$/i.test(noteId) && <div><a href={`https://njump.me/${noteEncode(noteId)}`} target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-gold">Open note &gt;</a></div>}
        </dl>
    </details>;
}

export function WalletPanel({ disabled = false }: { disabled?: boolean }) {
    const account = useSyncExternalStore(subscribeWalletAccount, getWalletAccount);
    const [tab, setTab] = useState<"send" | "receive" | "history" | "connection">("history");
    const [hidden, setHidden] = useState(false);
    const [destination, setDestination] = useState("");
    const [sendAmount, setSendAmount] = useState("");
    const [receiveAmount, setReceiveAmount] = useState("");
    const [description, setDescription] = useState("");
    const [shareStatus, setShareStatus] = useState("");
    const [now, setNow] = useState(() => Date.now());
    const can = (method: string) => account.methods.includes(method);
    const busy = disabled || !!account.busy;
    useEffect(() => {
        let ticks = 0;
        const check = () => {
            if (document.visibilityState === "hidden") return;
            setNow(Date.now());
            void checkWalletReceive();
            if (++ticks % 4 === 0) void refreshWalletAccount();
        };
        const timer = setInterval(check, 5000);
        const focus = () => { void refreshWalletAccount(); void checkWalletReceive(); setNow(Date.now()); };
        window.addEventListener("focus", focus);
        document.addEventListener("visibilitychange", focus);
        void refreshWalletAccount(); void checkWalletReceive();
        return () => { clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
    }, []);
    const draft = account.send;
    const reported = draft?.attempt?.state === "submitted" && !account.sendConfirmed;
    const uncertain = reported || draft?.attempt?.state === "uncertain";
    const sent = account.sendConfirmed;
    const originalConnection = draft?.attempt?.walletId === account.id;
    const expired = draft ? draft.expiresAt * 1000 <= now : false;
    const received = account.receive?.state === "settled";
    const receiveExpired = account.receive ? account.receive.expiresAt * 1000 <= now : false;
    const budget = account.budget && "total_budget" in account.budget ? account.budget : null;
    const balanceValue = hidden ? "••••" : account.balance === null ? "" : formatSats(account.balance);
    const balanceAvailable = can("get_balance") && account.balance !== null;
    return <div className="wallet-dashboard" aria-label="Wallet dashboard">
        <section className="wallet-balance-frame" aria-label="Wallet balance">
            <div className="wallet-balance-screen">
                <div className="wallet-balance-topline">
                    <h4 className="promotion-label wallet-balance-label"><WalletIcon symbol="lightning" />Balance</h4>
                    <div className="wallet-balance-controls">
                        <button type="button" className="wallet-icon-button focus-pixel" aria-label={hidden ? "Show balance" : "Hide balance"} title={hidden ? "Show balance" : "Hide balance"} aria-pressed={hidden} onClick={() => setHidden(!hidden)}><WalletIcon symbol={hidden ? "hide" : "show"} /></button>
                        <button type="button" className="wallet-icon-button focus-pixel" aria-label={account.refreshing ? "Updating" : "Refresh"} title={account.refreshing ? "Updating" : "Refresh"} disabled={account.refreshing || disabled} onClick={() => { void refreshWalletAccount(); void checkWalletReceive(); }}><WalletIcon symbol="refresh" /></button>
                    </div>
                </div>
                <div className="wallet-balance-readout">
                    <p className={balanceAvailable ? "wallet-balance-value" : "wallet-balance-unavailable"} aria-live="polite" data-testid="wallet-balance" style={{ "--wallet-digits": Math.max(4, balanceValue.length) } as CSSProperties}>{!can("get_balance") ? "Balance access not granted" : account.balance === null ? account.refreshing ? "Loading balance..." : "Balance unavailable" : <><span className="wallet-balance-number">{balanceValue}</span>{" "}<span className="wallet-balance-unit">sats</span></>}</p>
                </div>
                {account.balanceUpdatedAt > 0 && <p className="wallet-balance-updated">Updated {new Date(account.balanceUpdatedAt).toLocaleTimeString()}</p>}
                {account.balanceError && <p role="alert" className="mt-2 text-xs text-neon-pink">{account.balanceError} {account.balance !== null && "The displayed balance may be out of date."}</p>}
                {budget && <p className="wallet-budget">Connection budget: {hidden ? "••••" : formatSats(Math.max(0, budget.total_budget - budget.used_budget))} sats remaining{budget.renews_at ? `. Renews ${date(budget.renews_at)}` : "."}</p>}
                {account.budgetError && <p role="alert" className="mt-2 text-xs text-neon-pink">{account.budgetError}</p>}
            </div>
        </section>
        <nav aria-label="Wallet views" className="wallet-navigation">
            {(["send", "receive", "history", "connection"] as const).map((view) => <PixelButton key={view} size="sm" variant={view === "send" ? "accent" : view === "receive" ? "primary" : "ghost"} aria-pressed={tab === view} className={`wallet-tab wallet-tab--${view}`} onClick={() => setTab(view)}><WalletIcon symbol={view} />{view === "connection" ? "Settings" : view.charAt(0).toUpperCase() + view.slice(1)}</PixelButton>)}
        </nav>
        {tab === "send" && <section className="wallet-workspace space-y-4" aria-label="Send payment">
            <h4 className="promotion-section-title text-neon-cyan">Send</h4>
            {draft ? <>
                <dl className="space-y-3 border border-cyan-400/25 bg-void p-4">
                    <div><dt className={LABEL}>Amount</dt><dd className="wallet-review-amount">{formatSats(draft.amountMsats)} sats</dd></div>
                    {draft.recipient && <div><dt className={LABEL}>To</dt><dd className="break-all">{draft.recipient}</dd></div>}
                    {draft.description && <div><dt className={LABEL}>Description</dt><dd className="break-words">{draft.description}</dd></div>}
                    <div><dt className={LABEL}>Expires</dt><dd className="text-xs">{date(draft.expiresAt)}</dd></div>
                    {draft.feesMsats !== undefined && <div><dt className={LABEL}>Routing fee</dt><dd>{formatSats(draft.feesMsats)} sats</dd></div>}
                </dl>
                {sent ? <p role="status" className="text-neon-gold">Payment confirmed.</p> : reported ? <p role="status">The wallet reported this payment as sent, but its proof is not verified. Check its status. This invoice remains protected.</p> : uncertain ? <p role="status">Payment status is uncertain. This invoice stays protected while you work on other payments. A status check sends no payment.</p> : expired ? <p role="status" className="text-neon-pink">This invoice has expired.</p> : <p className="text-xs text-cyan-100/60">Your wallet may charge a routing fee. Send confirms this payment.</p>}
                {!sent && <PixelButton variant="accent" className="w-full min-h-11" disabled={busy || (uncertain ? !can("lookup_invoice") || !originalConnection : expired || !can("pay_invoice"))} onClick={() => void submitWalletSend()}>{account.busy === "check" ? "Checking payment" : account.busy === "send" ? "Waiting for wallet" : uncertain ? "Check payment status" : `Send ${formatSats(draft.amountMsats)} sats`}</PixelButton>}
                {uncertain && <p className="text-xs text-cyan-100/70">Original connection: {connectionLabel(draft.attempt!.walletId)}. {!originalConnection && "Reconnect that connection to check its status."}</p>}
                {!uncertain && !sent && !can("pay_invoice") && <p className="text-xs text-neon-pink">Sending is not allowed by this connection. Reconnect with invoice payment permission to send.</p>}
                {uncertain && !can("lookup_invoice") && <p className="text-xs text-neon-pink">Payment checks are not allowed by this connection. Check the original wallet history.</p>}
                <PixelButton size="sm" variant="ghost" disabled={busy} onClick={resetWalletSend}>{sent || uncertain ? "New payment" : "Edit payment"}</PixelButton>
                <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">Payment details</summary><div className="space-y-3"><p className="break-all text-xs">{draft.paymentHash}</p><CopyButton value={draft.invoice} label="Copy invoice" /></div></details>
            </> : !can("pay_invoice") ? <p>This connection does not allow sending. Enable invoice payments in your wallet and reconnect.</p> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void prepareWalletSend(destination, sendAmount); }}>
                <label className="block"><span className={LABEL}>Invoice or Lightning Address</span><textarea className={FIELD} value={destination} onChange={(event) => setDestination(event.target.value)} rows={3} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="lnbc... or name@domain.com" disabled={busy} required /></label>
                <WalletQrScanner disabled={busy} onScan={setDestination} />
                <label className="block"><span className={LABEL}>Amount (sats)</span><input className={FIELD} type="text" inputMode="numeric" autoComplete="off" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} placeholder="For an address or amountless invoice" disabled={busy} /></label>
                <p className="text-xs text-cyan-100/60">Fixed-amount invoices use their own amount. Review prepares the payment; you confirm sending on the next screen.</p>
                <PixelButton type="submit" variant="accent" className="w-full min-h-11" disabled={busy || !destination.trim()}>{account.busy === "prepare" ? "Preparing payment" : "Review payment"}</PixelButton>
            </form>}
            {account.pendingSends.some((entry) => entry.paymentHash !== draft?.paymentHash) && <div className="space-y-3 border-t border-cyan-400/25 pt-4" aria-label="Unresolved payments">
                <h4 className="promotion-label text-neon-gold">Unresolved payments</h4>
                <p className="text-xs text-cyan-100/70">These invoices stay protected across wallet connections. Reconnect each original connection to check its payment.</p>
                {account.pendingSends.filter((entry) => entry.paymentHash !== draft?.paymentHash).map((entry) => <div key={entry.paymentHash} className="space-y-2">
                    <p className="break-all text-xs">Hash: {entry.paymentHash}<br />Original connection: {connectionLabel(entry.attempt.walletId)}</p>
                    <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => reviewWalletSendAttempt(entry.paymentHash)}>Review unresolved payment</PixelButton>
                </div>)}
            </div>}
            {account.actionError && <p role="alert" className="text-neon-pink">{account.actionError}</p>}
            {!account.storageAvailable && <p className="text-xs text-neon-pink">Browser storage is blocked. Keep this page open until the payment is confirmed; its status cannot be restored after refresh.</p>}
        </section>}
        {tab === "receive" && <section className="wallet-workspace space-y-4" aria-label="Receive payment">
            <h4 className="promotion-section-title text-neon-cyan">Receive</h4>
            {account.address && <div className="space-y-3 border border-cyan-400/25 bg-void p-4"><p className="promotion-label text-cyan-200/70">Lightning Address</p><p className="break-all text-cyan-100 select-all">{account.address}</p><CopyButton value={account.address} label="Copy Lightning Address" /></div>}
            {!can("make_invoice") ? <p>This connection does not allow creating invoices. Enable receive permissions in your wallet and reconnect.</p> : <>
                {account.receive && <div className="space-y-4 border border-cyan-400/25 bg-void p-4">
                    <p role="status" className={received ? "text-neon-gold" : receiveExpired ? "text-neon-pink" : "text-cyan-100"}>{received ? "Payment received" : receiveExpired ? "Invoice expired" : "Waiting for payment"}: {formatSats(account.receive.amountMsats)} sats</p>
                    {account.receive.description && <p className="break-words text-xs">{account.receive.description}</p>}
                    {!received && !receiveExpired && <>
                        <div className="flex justify-center"><QrCode value={account.receive.invoice} size={220} label="Receive invoice QR code" /></div>
                        <p className="text-xs text-cyan-100/60">Expires {date(account.receive.expiresAt)}</p>
                        <div className="flex flex-wrap gap-3"><CopyButton value={account.receive.invoice} label="Copy receive invoice" /><PixelLink size="sm" variant="ghost" href={`lightning:${account.receive.invoice}`}>Open invoice</PixelLink><PixelButton size="sm" variant="ghost" onClick={() => { void shareInvoice(account.receive!.invoice).then(setShareStatus); }}>Share invoice</PixelButton></div>
                        {shareStatus && <p role="status" className="text-xs">{shareStatus}</p>}
                    </>}
                    {!received && can("lookup_invoice") && <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => void checkWalletReceive()}>Check incoming payment</PixelButton>}
                    {!received && !can("lookup_invoice") && <p className="text-xs text-cyan-100/60">{account.notifications === "active" ? "Waiting for the wallet notification." : "This connection cannot check invoices automatically. Check receipt in your wallet."}</p>}
                </div>}
                <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createWalletReceive(receiveAmount, description); }}>
                    <label className="block"><span className={LABEL}>Receive amount (sats)</span><input className={FIELD} type="text" inputMode="numeric" autoComplete="off" value={receiveAmount} onChange={(event) => setReceiveAmount(event.target.value)} disabled={busy} required /></label>
                    <label className="block"><span className={LABEL}>Description (optional)</span><input className={FIELD} value={description} maxLength={280} onChange={(event) => setDescription(event.target.value)} disabled={busy} /></label>
                    <PixelButton type="submit" className="w-full min-h-11" disabled={busy || !receiveAmount.trim()}>{account.busy === "receive" ? "Creating invoice" : account.receive ? "Create another invoice" : "Create invoice"}</PixelButton>
                    {account.receive && !received && !receiveExpired && <p className="text-xs text-cyan-100/60">Earlier invoices remain payable until they expire.</p>}
                </form>
            </>}
            {account.receiveError && <p role="alert" className="text-neon-pink">{account.receiveError}</p>}
        </section>}
        {tab === "history" && <section className="wallet-workspace space-y-3" aria-label="Payment history">
            <h4 className="promotion-section-title text-neon-cyan">Payment history</h4>
            {!can("list_transactions") ? <p>History access is not granted. Enable transaction history in your wallet and reconnect.</p> : <>
                <div className="wallet-history-filters" aria-label="History filters">{([["all", "All"], ["incoming", "Received"], ["outgoing", "Sent"]] as [HistoryFilter, string][]).map(([filter, label]) => <button key={filter} type="button" className="promotion-action focus-pixel" aria-pressed={account.historyFilter === filter} onClick={() => setWalletHistoryFilter(filter)}>{label}</button>)}</div>
                {account.history.map((tx) => <Transaction key={`${tx.type}:${tx.payment_hash}`} transaction={tx} />)}
                {!account.historyLoaded && !account.historyError && <StatusMessage compact loading>Loading history...</StatusMessage>}
                {account.historyLoaded && !account.history.length && <StatusMessage compact>No transactions returned by this wallet connection.</StatusMessage>}
                {account.historyError && <p role="alert" className="text-neon-pink">{account.historyError} {account.history.length > 0 && "The displayed history may be out of date."}</p>}
                {account.hasMore && <PixelButton size="sm" variant="ghost" disabled={account.loadingMore || account.refreshing} onClick={() => void loadMoreWalletHistory()}>{account.loadingMore ? "Loading history" : "Load more transactions"}</PixelButton>}
                <p className="text-xs text-cyan-100/50">History covers the transactions your wallet exposes to this connection.</p>
            </>}
        </section>}
        {tab === "connection" && <section className="wallet-workspace space-y-4" aria-label="Wallet permissions">
            <h4 className="promotion-section-title text-neon-cyan">Connection permissions</h4>
            <dl className="space-y-2">{permissions.map(([method, label]) => <div key={method} className="flex justify-between gap-3 border-b border-cyan-400/15 py-2"><dt>{label}</dt><dd className={can(method) ? "text-neon-gold" : "text-cyan-100/50"}>{can(method) ? "Allowed" : "Not granted"}</dd></div>)}</dl>
            <p className="text-xs">{account.notifications === "active" ? "Wallet notifications are active." : account.notifications === "connecting" ? "Connecting wallet notifications..." : account.notifications === "failed" ? "Wallet notifications are unavailable. Data refreshes while this panel is open." : "Data refreshes while this panel is open."}</p>
            {!can("get_budget") && <p className="text-xs text-cyan-100/60">This wallet does not expose the connection budget. Manage spending limits in your wallet.</p>}
            {account.budget && !budget && <p className="text-xs text-cyan-100/60">The wallet reports no connection budget.</p>}
            <p className="text-xs text-cyan-100/60">Enable additional permissions in your wallet, then reconnect. Disconnecting here removes the local connection; revoke it in your wallet to invalidate its permissions.</p>
        </section>}
    </div>;
}

async function shareInvoice(invoice: string): Promise<string> {
    try {
        if (navigator.share) { await navigator.share({ title: "Lightning invoice", text: invoice }); return ""; }
        await navigator.clipboard.writeText(invoice); return "Invoice copied for sharing.";
    } catch (failure) { return failure instanceof DOMException && failure.name === "AbortError" ? "" : "Could not share this invoice. Use Copy receive invoice or scan its QR code."; }
}
