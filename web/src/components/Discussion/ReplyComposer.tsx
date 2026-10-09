import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Event } from "nostr-tools";
import { neventEncode } from "nostr-tools/nip19";
import { useConnections } from "../../hooks/useConnections";
import { getConnectedSigner, getConnections, subscribeConnections } from "../../lib/connections";
import { prepareReply, type PreparedReply } from "../../lib/replyPreparation";
import { publicationRoutes, type PublicationRoutes } from "../../lib/publicationRoutes";
import { publicOutbox, type PublicationRecord } from "../../lib/publicOutbox";
import { readReplyAttachments, readReplyDraft, saveReplyAttachments, saveReplyDraft } from "../../lib/replyDrafts";
import { attachmentTags } from "../../lib/composerMedia";
import { shortNpub } from "../../lib/nostr";
import type { ThreadGraph } from "../../lib/threadGraph";
import { normalizeThreadRelations } from "../../lib/threadRelations";
import { ConnectionSettings } from "../PromoteModal/ConnectionSettings";
import { Modal } from "../ui/Modal";
import { PixelButton } from "../ui/PixelButton";
import { DiscussionLink } from "../ui/DiscussionLink";
import { CopyButton } from "../ui/CopyButton";
import { StatusMessage } from "../ui/StatusMessage";
import { NoteEditor } from "../Composer/NoteEditor";
import { NoteContent } from "../TextRenderer/NoteContent";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";

function sameParent(record: PublicationRecord, id: string) {
    const target = normalizeThreadRelations(record.event).parent.target;
    return target?.exactId === id || target?.type === "event" && target.value === id;
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : "The request could not finish. Review the saved reply before retrying.";

export function ReplyComposer({ parent, graph, onClose }: { parent: Event; graph: ThreadGraph; onClose: () => void }) {
    const connections = useConnections();
    const [initial] = useState(() => readReplyDraft(parent.id));
    const [initialMedia] = useState(() => readReplyAttachments(parent.id));
    const [attachments, setAttachments] = useState(initialMedia.attachments);
    const mediaDraft = useRef(initialMedia.attachments); mediaDraft.current = attachments;
    const [mediaSaved, setMediaSaved] = useState(initialMedia.saved);
    const [mediaPending, setMediaPending] = useState(false);
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
            const saved = entries.find(value => sameParent(value, parent.id) && value.event.content === initial.text &&
                JSON.stringify(value.event.tags.filter(tag => tag[0] === "imeta")) === JSON.stringify(attachmentTags(initialMedia.attachments, initial.text)));
            if (saved) setRecord(saved);
        }).catch(failure => { if (!cancelled) setError(message(failure)); });
        let observedSigner = getConnectedSigner(), observedPubkey = getConnections().signerPubkey;
        const unsubscribe = subscribeConnections(() => {
            if (observedSigner === getConnectedSigner() && observedPubkey === getConnections().signerPubkey) return;
            observedSigner = getConnectedSigner(); observedPubkey = getConnections().signerPubkey;
            operation.current?.abort("account-changed");
            if (alive.current) setConsentFor("");
        });
        return () => { cancelled = true; alive.current = false; unsubscribe(); operation.current?.abort("editor-closed"); saveReplyDraft(parent.id, draft.current); saveReplyAttachments(parent.id, mediaDraft.current); };
    }, [parent.id, initial.text, initialMedia.attachments]);
    useEffect(() => {
        const timer = setTimeout(() => {
            setDraftSaved(saveReplyDraft(parent.id, text)); setMediaSaved(saveReplyAttachments(parent.id, attachments));
        }, 300);
        return () => clearTimeout(timer);
    }, [parent.id, text, attachments]);

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
        const current = prepareReply({ parent, graph, content: prepared.template.content, attachments, createdAt: prepared.template.created_at });
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
        if (busy || mediaPending || !historyLoaded) return;
        setError("");
        try { setPrepared(prepareReply({ parent, graph, content: text, attachments, createdAt: Math.floor(Date.now() / 1000) })); }
        catch (failure) { setError(message(failure)); }
    };
    const close = () => { operation.current?.abort("editor-closed"); saveReplyDraft(parent.id, draft.current); saveReplyAttachments(parent.id, mediaDraft.current); onClose(); };
    const startAnother = () => {
        setRecord(undefined); setSigned(undefined); setRoutes(undefined); setPrepared(undefined); setConsentFor(""); setForget(false); setError("");
        setText(""); draft.current = ""; setDraftSaved(saveReplyDraft(parent.id, ""));
        setAttachments([]); mediaDraft.current = []; setMediaPending(false); setMediaSaved(saveReplyAttachments(parent.id, []));
    };
    const forgetReceipt = async () => {
        if (!record || !forget || busy) return;
        setError(""); setBusy("Removing local receipt...");
        try { await publicOutbox.forget(record.id); await refreshHistory(); if (alive.current) { setRecord(undefined); setSigned(undefined); setRoutes(undefined); setPrepared(undefined); setForget(false); setConsentFor(""); } }
        catch (failure) { if (alive.current) setError(message(failure)); }
        finally { if (alive.current) setBusy(""); }
    };
    return <Modal isOpen onClose={close} title="Reply" scrollBody mobileFullScreen panelClassName="reply-composer max-w-3xl" footerRef={setFooter}>
        <div className="promotion-typography space-y-4 text-sm text-cyan-100">
            <section aria-label="Reply context" className="reply-context">
                <span className="promotion-label text-cyan-100/50">Replying to</span>
                <UserProfileInline pubkey={parent.pubkey} size="compact" />
                <p className="reply-context-text">{parent.content.slice(0, 1024)}</p>
            </section>
            {record && !sameParent(record, parent.id) && <p className="break-all text-xs text-neon-gold">This saved reply targets a different note: {normalizeThreadRelations(record.event).parent.target?.value ?? "unresolved context"}. The original signed references are preserved.</p>}
            {!record && !signed && !prepared && <NoteEditor text={text} attachments={attachments} disabled={!!busy}
                onChange={value => { draft.current = value; setText(value); }} onAttachmentsChange={setAttachments}
                onPendingChange={setMediaPending} onReview={review} />}
            {(!draftSaved || !mediaSaved) && <p role="alert" className="text-xs text-neon-gold">This draft could not be saved completely. Copy your text and attachment descriptions before closing or reloading.</p>}
            {(prepared || signed || record) && <section aria-label="Reply preview" className="space-y-3">
                <h3 className="promotion-section-title text-neon-cyan">{record || signed ? "Signed reply" : "Review reply"}</h3>
                <div className="composer-reviewed-content @container/row"><NoteContent text={record?.event.content ?? signed?.content ?? prepared?.template.content ?? ""}
                    tags={record?.event.tags ?? signed?.tags ?? prepared?.template.tags ?? []} embedQuotes={false} previewLinks={false} initiallyExpanded />
                    {(record?.event.tags ?? signed?.tags ?? prepared?.template.tags ?? []).filter(tag => tag[0] === "imeta").flatMap((tag, index) => {
                        const alt = tag.find(value => value.startsWith("alt "))?.slice(4);
                        return alt ? [<p key={index} className="text-xs text-cyan-100/60">Image description: {alt}</p>] : [];
                    })}
                </div>
                <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">Reply details</summary>
                    <p className="text-xs text-cyan-100/60">This replies to the selected original Nostr item. Publishing does not promote it on the paid board.</p>
                    {prepared && !record && !signed && <p className="break-all text-xs text-cyan-100/60">Kind {prepared.template.kind}. Parent {prepared.parentId}. Root {prepared.root.value}.</p>}
                    {(record || signed) && <CopyButton value={neventEncode({ id: (record?.event ?? signed)!.id, author: (record?.event ?? signed)!.pubkey, relays: record ? Object.keys(record.relays).slice(0, 3) : [] })} label="Copy reply ID" />}
                </details>
            </section>}
            <ConnectionSettings section="signer" embedded purpose="reply" disabled={!!busy} />
            {connections.signerStatus === "connected" && !connections.signerCanReply && !record && <p role="status" className="text-xs text-neon-gold">This saved connection only requested zap permissions. Disconnect and connect again to request reply permissions.</p>}
            {record && <section aria-label="Reply delivery" className="space-y-3">
                <StatusMessage compact>{deliverySummary}</StatusMessage>
                <ul className="space-y-2 break-all text-xs">{Object.entries(record.relays).map(([url, value]) => <li key={url}>{url}: {value.state}{"detail" in value && value.detail ? ` (${value.detail})` : ""}</li>)}</ul>
                <details className="disclosure"><summary className="promotion-action focus-pixel min-h-11 cursor-pointer">About delivery</summary>
                    {routes && <p className="text-xs text-cyan-100/75">{routes.partial ? "Relay discovery is partial. " : ""}{routes.limited ? "Routing limits were reached. " : ""}Destinations include configured fallbacks. Other relays may have different coverage.</p>}
                    {!routes && <p className="text-xs text-cyan-100/75">These are saved destinations. Current relay preferences have not been rechecked.</p>}
                    <p className="text-xs text-cyan-100/60">Relay acceptance is not a guarantee that every client can find the reply. Retrying sends this exact signed ID only to destinations without confirmed acceptance.</p>
                </details>
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
        {footer && createPortal(<div className="reply-actions">
            <span className="reply-draft-status">{!record && !signed && !prepared ? mediaPending ? "Upload or remove selected files" : draftSaved && mediaSaved ? "Draft saved in this tab" : "Draft not saved"
                : record ? record.attempts === 0 ? "Signed and saved locally" : complete ? "Reply sent" : "Check delivery status" : "Review before publishing"}</span>
            <div className="reply-action-buttons">
            {record ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={startAnother}>Start another reply</PixelButton>
                {complete ? <PixelButton onClick={close}>Done</PixelButton> : <PixelButton disabled={!!busy || !ownsReply || consentFor !== connections.signerPubkey} onClick={publish}>{record.attempts ? "Retry saved reply" : "Publish reply"}</PixelButton>}
            </> : signed ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={() => { setSigned(undefined); setPrepared(undefined); setRoutes(undefined); setError(""); }}>Return to draft</PixelButton>
                <PixelButton disabled={!!busy || !ownsReply} onClick={() => saveSigned()}>Retry saving signed reply</PixelButton>
            </> : prepared ? <>
                <PixelButton variant="ghost" disabled={!!busy} onClick={() => setPrepared(undefined)}>Edit reply</PixelButton>
                <PixelButton disabled={!!busy || connections.signerStatus !== "connected" || !connections.signerCanReply || !historyLoaded} onClick={sign}>Sign reply</PixelButton>
            </> : <PixelButton disabled={!!busy || mediaPending || !text.trim() || new TextEncoder().encode(text).length > 16384 || !historyLoaded} onClick={review}>Review reply</PixelButton>}
            </div>
        </div>, footer)}
    </Modal>;
}
