import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Event } from "nostr-tools/pure";
import { boardPostTemplate, boardReference, classifyBoardInput, createGuestAuthor } from "../../lib/boardComposer";
import { eventPointer } from "../../lib/nostrPointers";
import { fetchNotePreview } from "../../lib/promote";
import { getConnectedSigner } from "../../lib/connections";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { useConnections } from "../../hooks/useConnections";
import { ENABLE_NOSTR_CONNECT } from "../../config";
import { NoteContent } from "../TextRenderer/NoteContent";
import { CopyButton } from "../ui/CopyButton";
import { StatusMessage } from "../ui/StatusMessage";
import { ConnectionSettings } from "./ConnectionSettings";

export interface BoardComposition { reference: string; event?: Event; post?: boolean }
export interface BoardComposerView {
    editor: ReactNode;
    authorDetails: ReactNode;
    authorExtras: ReactNode;
    canContinue: boolean;
    busy: boolean;
    signing: boolean;
    review: () => Promise<BoardComposition | null>;
}

/** The editor owns text and interpretation; DirectPromote owns invoices. */
export function BoardComposer({ onSource, children }: { onSource: (source: BoardComposition) => void; children: (view: BoardComposerView) => ReactNode }) {
    const connections = useConnections();
    const [text, setText] = useState("");
    const [interpretation, setInterpretation] = useState<"auto" | "quote">("auto");
    const [anonymous, setAnonymous] = useState(false);
    const [reviewed, setReviewed] = useState<Event>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [showAccount, setShowAccount] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const guest = useRef<ReturnType<typeof createGuestAuthor> | undefined>(undefined);
    const generation = useRef(0);
    const reviewAbort = useRef<AbortController | undefined>(undefined);
    const field = useRef<HTMLTextAreaElement>(null);
    const original = useRef<ReturnType<typeof boardReference>>(null);
    const guestMode = anonymous || !connections.signerPubkey;
    const classified = classifyBoardInput(text, interpretation);
    const account = connections.signerPubkey;
    const current = useRef({ text, interpretation, guestMode, account });
    current.current = { text, interpretation, guestMode, account };
    const reviewedSource = useRef<{ input: typeof current.current; source: BoardComposition } | undefined>(undefined);
    const reviewing = useRef<Promise<BoardComposition | null> | undefined>(undefined);
    useEffect(() => () => { generation.current++; reviewAbort.current?.abort(); guest.current?.destroy(); }, []);
    useEffect(() => {
        const input = classifyBoardInput(text, interpretation);
        onSource(input.mode === "original" ? { reference: eventPointer(input.reference.id, input.reference.author, input.reference.relays) } : { reference: reviewed?.id ?? "", event: reviewed, post: true });
    }, [text, interpretation, reviewed, onSource]);
    // Changing accounts invalidates an unpaid review, while issued invoices keep
    // their original snapshot and recipient in DirectPromote.
    useEffect(() => { reviewAbort.current?.abort(); generation.current++; reviewedSource.current = undefined; setReviewed(undefined); setShowKey(false); }, [account, guestMode]);
    const edit = (value: string) => { reviewAbort.current?.abort(); generation.current++; reviewedSource.current = undefined; setText(value); setReviewed(undefined); setError(""); setShowKey(false); };
    const quote = () => {
        if (classified.mode !== "original") return;
        original.current = classified.reference;
        setInterpretation("quote");
        edit(`\n\nnostr:${eventPointer(classified.reference.id, classified.reference.author, classified.reference.relays)}`);
        requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(0, 0); });
    };
    const review = (): Promise<BoardComposition | null> => {
        const snapshot = current.current;
        const input = classifyBoardInput(snapshot.text, snapshot.interpretation);
        if (input.mode === "original") return Promise.resolve({ reference: eventPointer(input.reference.id, input.reference.author, input.reference.relays) });
        if (!snapshot.text.trim() || new TextEncoder().encode(snapshot.text).length > 16384) return Promise.resolve(null);
        const cached = reviewedSource.current;
        if (cached && cached.input.text === snapshot.text && cached.input.interpretation === snapshot.interpretation && cached.input.account === snapshot.account && cached.input.guestMode === snapshot.guestMode) return Promise.resolve(cached.source);
        // React state does not update between calls in the same event. Share the
        // pending operation so two continuations cannot request two signatures.
        if (reviewing.current) return reviewing.current;
        const version = ++generation.current;
        const signer = getConnectedSigner();
        const controller = new AbortController(); reviewAbort.current = controller;
        const isCurrent = () => !controller.signal.aborted && version === generation.current && snapshot.text === current.current.text && snapshot.interpretation === current.current.interpretation && snapshot.account === current.current.account && snapshot.guestMode === current.current.guestMode;
        setBusy(true); setError("");
        const prepare = async (): Promise<BoardComposition | null> => {
            try {
                const template = await boardPostTemplate(snapshot.text, async reference => {
                    const preview = await fetchNotePreview(reference, controller.signal);
                    return preview.event as Event;
                }, snapshot.guestMode, original.current?.id);
                if (!isCurrent()) return null;
                let signed: Event;
                let author: string;
                if (snapshot.guestMode) {
                    guest.current?.destroy(); guest.current = createGuestAuthor();
                    author = guest.current.pubkey;
                    signed = guest.current.sign(template);
                } else {
                    if (!signer || signer !== getConnectedSigner()) throw new Error("Your account changed. Review the post again.");
                    author = snapshot.account!;
                    signed = await signer.signEvent(template);
                }
                if (!isCurrent()) return null;
                if (!snapshot.guestMode && signer !== getConnectedSigner()) throw new Error("Your account changed. Review the post again.");
                const verified = verifiedNostrEvent(signed);
                if (!verified || verified.pubkey !== author || verified.content !== template.content || verified.created_at !== template.created_at || verified.kind !== 1 || JSON.stringify(verified.tags) !== JSON.stringify(template.tags)) throw new Error("The signer changed the post. Review it again.");
                if (!snapshot.guestMode) { guest.current?.destroy(); guest.current = undefined; }
                const source = { reference: verified.id, event: verified, post: true };
                reviewedSource.current = { input: snapshot, source };
                setReviewed(verified);
                return source;
            } catch (failure) {
                if (isCurrent()) setError(failure instanceof Error ? failure.message : "Could not prepare the post. Your text is preserved.");
                return null;
            } finally { reviewing.current = undefined; setBusy(false); }
        };
        const pending = prepare();
        reviewing.current = pending;
        return pending;
    };
    const bytes = new TextEncoder().encode(text).length;
    const authorExtras = classified.mode !== "original" && <div className="space-y-2">
        {!!account && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={anonymous} disabled={busy} onChange={event => { reviewAbort.current?.abort(); generation.current++; reviewedSource.current = undefined; setAnonymous(event.target.checked); setReviewed(undefined); setShowKey(false); }} />Post anonymously</label>}
        {guestMode && <p className="text-xs text-cyan-100/65">No account required. This post has its own anonymous identity. You can save its private author key after review.</p>}
        {reviewed && guestMode && guest.current && <><button className="promotion-action focus-pixel min-h-11" onClick={event => { setShowKey(!showKey); if (showKey) event.currentTarget.focus(); }}>Save author key</button>
            {showKey && <div className="space-y-2"><p className="text-xs text-neon-gold">Keep this key private. It controls this post's identity. Save it before closing or refreshing this editor, or reviewing changed content. An unsaved key cannot be recovered.</p><CopyButton value={guest.current.export()} label="Copy private author key" /></div>}</>}
    </div>;
    const editor = <section aria-label="Add to board editor" className="space-y-3">
        <label className="block space-y-2"><span className="promotion-label">Text or link</span>
            <textarea ref={field} className="composer-textarea board-composer-textarea focus-pixel w-full" rows={4} maxLength={16384} value={text} disabled={busy}
                placeholder="Write something, share a link, or paste a post" onChange={event => edit(event.target.value)} />
        </label>
        {classified.mode !== "original" && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cyan-100/75">
            <span className="promotion-label text-neon-cyan">Your post</span>
            <span>{guestMode ? "Posting as a guest. No account required." : "Posting with your Nostr account."}</span>
            {ENABLE_NOSTR_CONNECT && <button type="button" className="promotion-action focus-pixel min-h-11 text-neon-cyan" disabled={busy} onClick={() => setShowAccount(!showAccount)}>{account ? "Account settings" : "Use a Nostr account"}</button>}
        </div>}
        {showAccount && <ConnectionSettings section="signer" purpose="account" embedded disabled={busy} />}
        {classified.mode === "original" ? <div className="flex flex-wrap items-center gap-3"><span className="promotion-label text-neon-cyan">Original post</span><button className="promotion-action focus-pixel min-h-11" onClick={quote}>Add a comment</button></div> : <>
            <div className="flex flex-wrap items-center gap-3">
                {interpretation === "quote" && original.current && <button className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => { const ref = original.current!; setInterpretation("auto"); edit(eventPointer(ref.id, ref.author, ref.relays)); }}>Use original</button>}
            </div>
            {text.trim() && <div className="composer-attachments @container/row" aria-label="Post attachments"><NoteContent text={text} tags={[]} quoteLimit={1} strictReferences attachmentsOnly /></div>}
            {busy && <StatusMessage loading compact>Verifying references and preparing your post...</StatusMessage>}
            {error && <p role="alert" className="text-sm text-neon-pink">{error}</p>}
        </>}
    </section>;
    const authorDetails = classified.mode !== "original" && <section aria-label="Post author" className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-cyan-100/70">{guestMode ? "Posting as a guest" : "Posting with your Nostr account"}</span>
            {ENABLE_NOSTR_CONNECT && <button className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => setShowAccount(!showAccount)}>{account ? "Account settings" : "Use a Nostr account"}</button>}
        </div>
        {showAccount && <ConnectionSettings section="signer" purpose="account" embedded disabled={busy} />}
        {authorExtras}
    </section>;
    return children({ editor, authorDetails, authorExtras, canContinue: !busy && !!text.trim() && bytes <= 16384, busy, signing: !guestMode && classified.mode !== "original", review });
}
