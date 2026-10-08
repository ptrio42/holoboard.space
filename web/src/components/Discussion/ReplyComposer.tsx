import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Event } from "nostr-tools";
import { useConnections } from "../../hooks/useConnections";
import { getConnectedSigner, getConnections, subscribeConnections } from "../../lib/connections";
import { prepareReply, type PreparedReply } from "../../lib/replyPreparation";
import { publicationRoutes, type PublicationRoutes } from "../../lib/publicationRoutes";
import { publicOutbox, type PublicationRecord } from "../../lib/publicOutbox";
import { readReplyDraft, saveReplyDraft } from "../../lib/replyDrafts";
import { shortNpub } from "../../lib/nostr";
import type { ThreadGraph } from "../../lib/threadGraph";
import { normalizeThreadRelations } from "../../lib/threadRelations";
import { ConnectionSettings } from "../PromoteModal/ConnectionSettings";
import { Modal } from "../ui/Modal";
import { PixelButton } from "../ui/PixelButton";
import { DiscussionLink } from "../ui/DiscussionLink";
import { CopyButton } from "../ui/CopyButton";
import { StatusMessage } from "../ui/StatusMessage";

function sameParent(record: PublicationRecord, id: string) {
    const target = normalizeThreadRelations(record.event).parent.target;
    return target?.exactId === id || target?.type === "event" && target.value === id;
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : "The request could not finish. Review the saved reply before retrying.";

export function ReplyComposer({ parent, graph, onClose }: { parent: Event; graph: ThreadGraph; onClose: () => void }) {
    const connections = useConnections();
    const [initial] = useState(() => readReplyDraft(parent.id));
    const [text, setText] = useState(initial.text);
    const draft = useRef(initial.text);
    const [draftSaved, setDraftSaved] = useState(initial.saved);
    const [prepared, setPrepared] = useState<PreparedReply>();
    const [signed, setSigned] = useState<Event>();
    const [routes, setRoutes] = useState<PublicationRoutes>();
    const [record, setRecord] = useState<PublicationRecord>();
    const [history, setHistory] = useState<PublicationRecord[]>([]);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [consentFor, setConsentFor] = useState("");
    const [forget, setForget] = useState(false);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [footer, setFooter] = useState<HTMLDivElement | null>(null);
    const operation = useRef<AbortController | undefined>(undefined);
    const alive = useRef(false);
    const owner = record?.event.pubkey ?? signed?.pubkey ?? connections.signerPubkey;
    const ownsReply = connections.signerStatus === "connected" && connections.signerPubkey === owner;
    const outcomes = Object.values(record?.relays ?? {});
    const accepted = outcomes.filter(value => value.state === "accepted").length;
    const complete = outcomes.length > 0 && accepted === outcomes.length;
    const deliverySummary = busy === "Sending reply..." ? "Sending reply. Outcomes are not final."
        : error ? "Saved reply available. Review the error before retrying."
        : record?.attempts === 0 ? "Saved locally. This reply has not been sent."
        : complete ? "Accepted by all selected relays."
        : accepted > 0 ? `Accepted by ${accepted} of ${outcomes.length} selected relays. Other outcomes are listed below.`
        : outcomes.some(value => value.state === "uncertain") ? "Delivery is uncertain. The reply may already be public."
        : "No selected relay accepted this reply. Review the delivery reasons below.";
    const refreshHistory = async () => { const entries = await publicOutbox.list(); if (alive.current) { setHistory(entries.sort((a, b) => b.createdAt - a.createdAt)); setHistoryLoaded(true); } return entries; };

    useEffect(() => {
        alive.current = true;
        let cancelled = false;
        publicOutbox.list().then(entries => {
            if (cancelled) return;
            setHistory(entries.sort((a, b) => b.createdAt - a.createdAt)); setHistoryLoaded(true);
            // Restore a matching receipt for inspection only. Neither this nor
            // reconnecting or reloading grants permission to send it.
            const saved = entries.find(value => sameParent(value, parent.id) && value.event.content === initial.text);
            if (saved) setRecord(saved);
        }).catch(failure => { if (!cancelled) setError(message(failure)); });
        let observedSigner = getConnectedSigner(), observedPubkey = getConnections().signerPubkey;
        const unsubscribe = subscribeConnections(() => {
            if (observedSigner === getConnectedSigner() && observedPubkey === getConnections().signerPubkey) return;
            observedSigner = getConnectedSigner(); observedPubkey = getConnections().signerPubkey;
            operation.current?.abort("account-changed");
            if (alive.current) setConsentFor("");
        });
        return () => { cancelled = true; alive.current = false; unsubscribe(); operation.current?.abort("editor-closed"); saveReplyDraft(parent.id, draft.current); };
    }, [parent.id, initial.text]);
    useEffect(() => {
        const timer = setTimeout(() => setDraftSaved(saveReplyDraft(parent.id, text)), 300);
        return () => clearTimeout(timer);
    }, [parent.id, text]);

    const run = async (label: string, task: (signal: AbortSignal, requireAccount: () => void) => Promise<void>) => {
        if (operation.current) return;
        const account = getConnectedSigner(), pubkey = getConnections().signerPubkey;
        if (!account || !pubkey) { setError("Connect a signer first."); return; }
        const controller = new AbortController(); operation.current = controller;
        const requireAccount = () => {
            if (controller.signal.aborted || getConnectedSigner() !== account || getConnections().signerPubkey !== pubkey) throw new Error("The request stopped. Review the account and saved reply before retrying.");
        };
        setError(""); setBusy(label); setConsentFor("");
        try { requireAccount(); await task(controller.signal, requireAccount); }
        catch (failure) { if (alive.current) setError(message(failure)); }
        finally { controller.abort(); if (operation.current === controller) operation.current = undefined; if (alive.current) setBusy(""); }
    };
    const saveSigned = (input?: Event) => void run("Preparing relay destinations...", async (signal, requireAccount) => {
        const event = input ?? signed;
        if (!event) throw new Error("Sign this reply first.");
        if (event.pubkey !== getConnections().signerPubkey) throw new Error("Connect the account that signed this reply.");
        const plan = await publicationRoutes(event, signal); requireAccount();
        if (!plan.targets.length) throw new Error("No safe publication destination was found. Your reply has not been sent.");
        setRoutes(plan);
        const stored = await publicOutbox.enqueue(event, plan.targets); requireAccount();
        setRecord(stored); await refreshHistory();
    });
    const sign = () => void run("Waiting for signature...", async (signal, requireAccount) => {
        if (!prepared || !getConnections().signerCanReply) throw new Error("Reconnect your signer to approve reply permissions. Your draft is preserved.");
        const current = prepareReply({ parent, graph, content: prepared.template.content, createdAt: prepared.template.created_at });
        if (JSON.stringify(current.template) !== JSON.stringify(prepared.template)) throw new Error("Reply context changed. Edit and review the reply again before signing.");
        const event = await getConnectedSigner()!.signEvent(prepared.template); requireAccount();
        setSigned(event); setBusy("Preparing relay destinations...");
        const plan = await publicationRoutes(event, signal); requireAccount();
        if (!plan.targets.length) throw new Error("No safe publication destination was found. Your reply has not been sent.");
        setRoutes(plan);
        const stored = await publicOutbox.enqueue(event, plan.targets); requireAccount();
        setRecord(stored); await refreshHistory();
    });
    const publish = () => {
        if (!record || !ownsReply || consentFor !== connections.signerPubkey) return;
        void run("Sending reply...", async (signal, requireAccount) => {
            requireAccount();
            if (record.event.pubkey !== getConnections().signerPubkey) throw new Error("Connect the account that signed this reply.");
            try { const result = await publicOutbox.send(record.id, { signal }); if (alive.current) setRecord(result); }
            finally {
                const entries = await refreshHistory();
                const current = entries.find(value => value.id === record.id); if (alive.current && current) setRecord(current);
            }
        });
    };
    const review = () => {
        setError("");
        try { setPrepared(prepareReply({ parent, graph, content: text, createdAt: Math.floor(Date.now() / 1000) })); }
        catch (failure) { setError(message(failure)); }
    };
    const close = () => { operation.current?.abort("editor-closed"); saveReplyDraft(parent.id, draft.current); onClose(); };
    const startAnother = () => {
        setRecord(undefined); setSigned(undefined); setRoutes(undefined); setPrepared(undefined); setConsentFor(""); setForget(false); setError("");
        setText(""); draft.current = ""; setDraftSaved(saveReplyDraft(parent.id, ""));
    };
    const forgetReceipt = async () => {
        if (!record || !forget || busy) return;
        setError(""); setBusy("Removing local receipt...");
        try { await publicOutbox.forget(record.id); await refreshHistory(); if (alive.current) { setRecord(undefined); setSigned(undefined); setRoutes(undefined); setPrepared(undefined); setForget(false); setConsentFor(""); } }
        catch (failure) { if (alive.current) setError(message(failure)); }
        finally { if (alive.current) setBusy(""); }
    };
    return <Modal isOpen onClose={close} title="Reply" scrollBody footerRef={setFooter}>
        <div className="promotion-typography space-y-5 text-sm text-cyan-100">
            <section aria-label="Reply context" className="space-y-2">
                <p className="promotion-section-title text-neon-cyan">Replying to {shortNpub(parent.pubkey)}</p>
                <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-cyan-100/75">{parent.content.slice(0, 1024)}</p>
                <p className="text-xs text-cyan-100/60">This replies to the original Nostr note. It does not promote the reply or change the paid board.</p>
            </section>
            {record && !sameParent(record, parent.id) && <p className="break-all text-xs text-neon-gold">This saved reply targets a different note: {normalizeThreadRelations(record.event).parent.target?.value ?? "unresolved context"}. The original signed references are preserved.</p>}
            {!record && !signed && !prepared && <label className="block space-y-2"><span className="promotion-label">Reply text</span>
                <textarea value={text} disabled={!!busy} rows={6} maxLength={16384} onChange={event => { draft.current = event.target.value; setText(event.target.value); }} className="focus-pixel w-full border-2 border-cyan-400/40 bg-void p-3 text-base text-cyan-100" />
                <span className="block text-xs text-cyan-100/60">Up to 16 KiB of text. Drafts are saved in this browser tab.</span>
            </label>}
            {!draftSaved && <p role="alert" className="text-xs text-neon-gold">This draft could not be saved. Copy your text before closing or reloading.</p>}
            {(prepared || signed || record) && <section aria-label="Reply preview" className="space-y-3">
                <h3 className="promotion-section-title text-neon-cyan">{record || signed ? "Signed reply" : "Review reply"}</h3>
                <p className="whitespace-pre-wrap break-words text-sm">{record?.event.content ?? signed?.content ?? prepared?.template.content}</p>
                {prepared && !record && !signed && <p className="break-all text-xs text-cyan-100/60">Kind {prepared.template.kind}. Parent {prepared.parentId}. Root {prepared.root.value}.</p>}
                {(record || signed) && <CopyButton value={(record?.event ?? signed)!.id} label="Copy reply ID" />}
            </section>}
            <ConnectionSettings section="signer" embedded purpose="reply" disabled={!!busy} />
            {connections.signerStatus === "connected" && !connections.signerCanReply && !record && <p role="status" className="text-xs text-neon-gold">This saved connection only requested zap permissions. Disconnect and connect again to request reply permissions.</p>}
            {routes && <p className="text-xs text-cyan-100/75">{routes.partial ? "Relay discovery is partial. " : ""}{routes.limited ? "Routing limits were reached. " : ""}Destinations include configured fallbacks. Other relays may have different coverage.</p>}
            {record && !routes && <p className="text-xs text-cyan-100/75">These are saved destinations. Current relay preferences have not been rechecked.</p>}
            {record && <section aria-label="Reply delivery" className="space-y-3">
                <StatusMessage compact>{deliverySummary}</StatusMessage>
                <ul className="space-y-2 break-all text-xs">{Object.entries(record.relays).map(([url, value]) => <li key={url}>{url}: {value.state}{"detail" in value && value.detail ? ` (${value.detail})` : ""}</li>)}</ul>
                <p className="text-xs text-cyan-100/60">Relay acceptance is not a guarantee that every client can find the reply. Retrying sends this exact signed ID only to destinations without confirmed acceptance.</p>
                {record.attempts > 0 && <DiscussionLink id={record.id} author={record.event.pubkey} hints={Object.entries(record.relays).filter(([, value]) => value.state === "accepted").map(([url]) => url)} seed={record.event} label="View reply" />}
                {!complete && <label className="flex min-h-11 items-start gap-3 text-xs"><input type="checkbox" className="mt-1" disabled={!!busy || !ownsReply} checked={!!consentFor && consentFor === connections.signerPubkey} onChange={event => setConsentFor(event.target.checked ? connections.signerPubkey : "")} /><span>I agree to publish this reply publicly as {shortNpub(record.event.pubkey)} to the listed relays.</span></label>}
                {!ownsReply && <p role="status" className="text-xs text-neon-gold">Connect the account that signed this reply to send or retry it.</p>}
                <details className="disclosure"><summary className="focus-pixel min-h-11 cursor-pointer text-xs">Manage local receipt</summary>
                    <label className="flex min-h-11 items-start gap-3 text-xs"><input type="checkbox" checked={forget} disabled={!!busy} onChange={event => setForget(event.target.checked)} /><span>Forget this local receipt. This cannot delete a public reply or cancel a sent attempt.</span></label>
                    <PixelButton variant="ghost" disabled={!!busy || !forget} onClick={() => void forgetReceipt()}>Forget local receipt</PixelButton>
                </details>
            </section>}
            <details className="disclosure"><summary className="focus-pixel min-h-11 cursor-pointer text-xs">Saved replies ({history.length}/32)</summary>
                <ul className="space-y-3">{history.map(value => <li key={value.id} className="border-t border-cyan-400/20 pt-3">
                    <p className="break-words text-xs">{value.event.content.slice(0, 120)}</p>
                    <p className="text-xs text-cyan-100/60">{shortNpub(value.event.pubkey)}. {value.attempts === 0 ? "Not sent" : `${Object.values(value.relays).filter(outcome => outcome.state === "accepted").length}/${Object.keys(value.relays).length} relays accepted`}.</p>
                    <PixelButton variant="ghost" disabled={!!busy} onClick={() => { setRecord(value); setSigned(undefined); setPrepared(undefined); setRoutes(undefined); setConsentFor(""); setForget(false); setError(""); }}>Review saved reply</PixelButton>
                </li>)}</ul>
                {!history.length && <p className="text-xs text-cyan-100/60">No saved replies in this browser.</p>}
            </details>
            {!historyLoaded && <PixelButton variant="ghost" disabled={!!busy} onClick={() => void refreshHistory().catch(failure => { if (alive.current) setError(message(failure)); })}>Retry reading saved replies</PixelButton>}
            {busy && <StatusMessage compact loading>{busy}</StatusMessage>}
            {error && <p role="alert" className="break-words text-sm text-neon-pink">{error}</p>}
        </div>
        {footer && createPortal(<div className="flex flex-wrap items-center justify-end gap-3">
            {record ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={startAnother}>Start another reply</PixelButton>
                {complete ? <PixelButton onClick={close}>Done</PixelButton> : <PixelButton disabled={!!busy || !ownsReply || consentFor !== connections.signerPubkey} onClick={publish}>{record.attempts ? "Retry saved reply" : "Publish reply"}</PixelButton>}
            </> : signed ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={() => { setSigned(undefined); setPrepared(undefined); setRoutes(undefined); setError(""); }}>Return to draft</PixelButton>
                <PixelButton disabled={!!busy || !ownsReply} onClick={() => saveSigned()}>Retry saving signed reply</PixelButton>
            </> : prepared ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={() => setPrepared(undefined)}>Edit reply</PixelButton>
                <PixelButton disabled={!!busy || connections.signerStatus !== "connected" || !connections.signerCanReply || !historyLoaded} onClick={sign}>Sign reply</PixelButton>
            </> : <PixelButton disabled={!!busy || !text.trim() || !historyLoaded} onClick={review}>Review reply</PixelButton>}
        </div>, footer)}
    </Modal>;
}
