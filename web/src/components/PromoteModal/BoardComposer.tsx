import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Event } from "nostr-tools/pure";
import { boardPostTemplate, boardReference, classifyBoardInput, createGuestAuthor } from "../../lib/boardComposer";
import { eventPointer } from "../../lib/nostrPointers";
import { fetchNotePreview } from "../../lib/promote";
import { getConnectedSigner } from "../../lib/connections";
import { verifiedNostrEvent } from "../../lib/verifyNostrEvent";
import { useConnections } from "../../hooks/useConnections";
import { ENABLE_EMAIL_ACCOUNTS, ENABLE_NOSTR_CONNECT } from "../../config";
import { NoteContent } from "../TextRenderer/NoteContent";
import { PixelButton } from "../ui/PixelButton";
import { CopyButton } from "../ui/CopyButton";
import { StatusMessage } from "../ui/StatusMessage";
import { ConnectionSettings } from "./ConnectionSettings";

export interface BoardComposition { reference: string; event?: Event; post?: boolean }

/** The editor owns text and interpretation; DirectPromote owns invoices. */
export function BoardComposer({ onSource, children }: { onSource: (source: BoardComposition) => void; children: (editor: ReactNode) => ReactNode }) {
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
    useEffect(() => () => { generation.current++; reviewAbort.current?.abort(); guest.current?.destroy(); }, []);
    useEffect(() => {
        const input = classifyBoardInput(text, interpretation);
        onSource(input.mode === "original" ? { reference: eventPointer(input.reference.id, input.reference.author, input.reference.relays) } : { reference: reviewed?.id ?? "", event: reviewed, post: true });
    }, [text, interpretation, reviewed, onSource]);
    // Changing accounts invalidates an unpaid review, while issued invoices keep
    // their original snapshot and recipient in DirectPromote.
    useEffect(() => { reviewAbort.current?.abort(); generation.current++; setReviewed(undefined); setShowKey(false); }, [account, guestMode]);
    const edit = (value: string) => { reviewAbort.current?.abort(); generation.current++; setText(value); setReviewed(undefined); setError(""); setShowKey(false); };
    const quote = () => {
        if (classified.mode !== "original") return;
        original.current = classified.reference;
        setInterpretation("quote");
        edit(`\n\nnostr:${eventPointer(classified.reference.id, classified.reference.author, classified.reference.relays)}`);
        requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(0, 0); });
    };
    const review = async () => {
        if (busy || classified.mode === "original") return;
        const snapshot = current.current, version = ++generation.current;
        const signer = getConnectedSigner();
        const controller = new AbortController(); reviewAbort.current = controller;
        setBusy(true); setError("");
        try {
            const template = await boardPostTemplate(snapshot.text, async reference => {
                const preview = await fetchNotePreview(reference, controller.signal);
                return preview.event as Event;
            }, snapshot.guestMode, original.current?.id);
            if (version !== generation.current || snapshot !== current.current && (snapshot.text !== current.current.text || snapshot.account !== current.current.account || snapshot.guestMode !== current.current.guestMode)) return;
            let signed: Event;
            if (snapshot.guestMode) {
                guest.current?.destroy(); guest.current = createGuestAuthor();
                signed = guest.current.sign(template);
            } else {
                if (!signer || signer !== getConnectedSigner()) throw new Error("Your account changed. Review the post again.");
                signed = await signer.signEvent(template);
            }
            if (version !== generation.current || snapshot.account !== current.current.account || snapshot.guestMode !== current.current.guestMode) return;
            const verified = verifiedNostrEvent(signed);
            if (!verified || verified.content !== template.content || verified.created_at !== template.created_at || verified.kind !== 1 || JSON.stringify(verified.tags) !== JSON.stringify(template.tags)) throw new Error("The signer changed the post. Review it again.");
            setReviewed(verified);
        } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : "Could not prepare the post. Your text is preserved."); }
        finally { setBusy(false); }
    };
    const bytes = new TextEncoder().encode(text).length;
    const editor = <section aria-label="Add to board editor" className="space-y-3">
        <label className="block space-y-2"><span className="promotion-label">Text or link</span>
            <textarea ref={field} className="composer-textarea focus-pixel w-full" rows={4} maxLength={16384} value={text} disabled={busy}
                placeholder="Write something, share a link, or paste a post" onChange={event => edit(event.target.value)} />
        </label>
        {classified.mode === "original" ? <div className="flex flex-wrap items-center gap-3"><span className="promotion-label text-neon-cyan">Original post</span><button className="promotion-action focus-pixel min-h-11" onClick={quote}>Add a comment</button></div> : <>
            <div className="flex flex-wrap items-center gap-3"><span className="promotion-label text-neon-cyan">Your post</span>
                {interpretation === "quote" && original.current && <button className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => { const ref = original.current!; setInterpretation("auto"); edit(eventPointer(ref.id, ref.author, ref.relays)); }}>Use original</button>}
            </div>
            {text.trim() && !reviewed && <div className="composer-preview @container/row" aria-label="Post preview"><NoteContent text={text} tags={[]} quoteLimit={1} strictReferences initiallyExpanded /></div>}
            <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-cyan-100/70">Author: {guestMode ? "Anonymous" : "Your account"}</span>
                {!!account && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={anonymous} disabled={busy} onChange={event => { generation.current++; setAnonymous(event.target.checked); setReviewed(undefined); }} />Post anonymously</label>}
                {(ENABLE_EMAIL_ACCOUNTS || ENABLE_NOSTR_CONNECT) && <button className="promotion-action focus-pixel min-h-11" disabled={busy} onClick={() => setShowAccount(!showAccount)}>{account ? "Account settings" : "Sign in / create account"}</button>}
            </div>
            {showAccount && <ConnectionSettings section="signer" purpose="account" embedded disabled={busy} />}
            {guestMode && <p className="text-xs text-cyan-100/65">No account required. This post uses its own author key. Its payment goes to visibility.</p>}
            {reviewed ? <div className="space-y-2"><p role="status" className="text-xs text-neon-cyan">Ready for payment. Published after the board payment is confirmed.</p>
                {guestMode && guest.current && <><button className="promotion-action focus-pixel min-h-11" onClick={() => setShowKey(!showKey)}>Save author key</button>
                    {showKey && <div className="space-y-2"><p className="text-xs text-neon-gold">Keep this key private. It controls this post's identity. Save it before preparing another post or closing this editor. An unsaved key cannot be recovered.</p><CopyButton value={guest.current.export()} label="Copy private author key" /></div>}</>}
            </div> : <PixelButton size="sm" disabled={busy || !text.trim() || bytes > 16384} onClick={() => void review()}>{busy ? "Preparing post..." : "Review post"}</PixelButton>}
            {busy && <StatusMessage loading compact>Verifying references and preparing your post...</StatusMessage>}
            {error && <p role="alert" className="text-sm text-neon-pink">{error}</p>}
        </>}
    </section>;
    return children(editor);
}
