import { mediaAllowed } from "../content/mediaAdmission";
import { useEffect, useRef, useState } from "react";
import { useClient } from "../ClientProvider";
import { COMPOSER_ATTACHMENT_LIMIT, COMPOSER_FILE_LIMIT, type ComposerAttachment, type MediaServer } from "../../core/content/composerMedia";
import type { ComposerGif } from "../../core/ports";
import { NoteContent } from "../content/NoteContent";
import { PixelButton } from "../primitives/PixelButton";
import { StatusMessage } from "../primitives/StatusMessage";

const EMOJIS = [
    ["😀", "happy smile"], ["😂", "laugh tears"], ["🤣", "rolling laugh"], ["😊", "smile blush"], ["😍", "love heart eyes"], ["🥰", "love hearts"],
    ["😎", "cool sunglasses"], ["🤔", "thinking"], ["🫡", "salute respect"], ["🤯", "mind blown"], ["🥹", "touched tears"], ["😅", "sweat relief"],
    ["😭", "cry sad"], ["😢", "sad tear"], ["😡", "angry"], ["🙃", "upside down"], ["🫠", "melting"], ["😴", "sleep tired"],
    ["👀", "eyes looking"], ["👍", "thumbs up yes"], ["👎", "thumbs down no"], ["👏", "clap applause"], ["🙌", "celebrate hands"], ["🙏", "thanks please pray"],
    ["💪", "strong muscle"], ["🤝", "handshake deal"], ["🤙", "call shaka"], ["✌️", "peace"], ["❤️", "heart love"], ["💜", "purple heart"],
    ["💛", "yellow heart"], ["💙", "blue heart"], ["🧡", "orange heart"], ["💚", "green heart"], ["💔", "broken heart"], ["💯", "hundred"],
    ["🔥", "fire hot"], ["⚡", "lightning zap"], ["🚀", "rocket"], ["🎉", "party celebration"], ["✨", "sparkles"], ["⭐", "star"],
    ["✅", "check yes"], ["❌", "cross no"], ["🌈", "rainbow"], ["☀️", "sun"], ["🌍", "earth world"], ["🫂", "hug"],
    ["🐱", "cat"], ["🐶", "dog"], ["🐸", "frog"], ["🦄", "unicorn"], ["🍕", "pizza"], ["☕", "coffee"], ["🍻", "beer cheers"], ["🧡", "bitcoin orange"],
];
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : "The request could not finish. Your draft is preserved.";
interface LocalFile { id: string; file: File; preview: string; alt: string; error?: string; progress?: number }

function ToolIcon({ kind }: { kind: "emoji" | "attach" }) {
    return <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" fill="currentColor" shapeRendering="crispEdges">
        <path d={kind === "emoji" ? "M4 2h12v2h2v12h-2v2H4v-2H2V4h2zm0 2v12h12V4zM6 6h2v2H6zm6 0h2v2h-2zM6 11h2v2h4v-2h2v4H6z" : "M6 2h8v2h2v10h-2V4H6v12h6v-6h-2v4H8V8h6v10H4V4h2z"} />
    </svg>;
}
function MediaThumbnail({ src, type, alt }: { src: string; type: string; alt: string }) {
    if (!src) return <span role="status">Media unavailable.</span>;
    if (type.startsWith("image/") && type !== "image/svg+xml") return <img src={src} alt={alt} className="composer-attachment-image" />;
    if (type.startsWith("video/")) return <video src={src} className="composer-attachment-image" preload="metadata" controls playsInline />;
    return <span className="composer-file-symbol" aria-hidden="true">{type.startsWith("audio/") ? "♪" : "FILE"}</span>;
}

/** Text and media editing is independent of reply ancestry, signing and delivery. */
export function NoteEditor({ text, attachments, onChange, onAttachmentsChange, onPendingChange, onReview, disabled = false, textLabel = "Reply text", placeholder = "Write your reply…", toolbarLabel = "Add to reply" }: {
    text: string; attachments: ComposerAttachment[]; onChange: (text: string) => void; onAttachmentsChange: (items: ComposerAttachment[]) => void;
    onPendingChange: (pending: boolean) => void; onReview: () => void; disabled?: boolean;
    textLabel?: string; placeholder?: string; toolbarLabel?: string;
}) {
    const client = useClient();
    const { getConnectedSigner, getConnections, subscribeConnections } = client.connections;
    const { servers: MEDIA_SERVERS, mediaUrl, uploadMedia, gifSearchAvailable, searchComposerGifs } = client.media;
    const textarea = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const selection = useRef({ start: text.length, end: text.length });
    const currentText = useRef(text); currentText.current = text;
    const currentAttachments = useRef(attachments); currentAttachments.current = attachments;
    const [view, setView] = useState<"write" | "preview">("write");
    const [tool, setTool] = useState<"emoji" | "gif" | "files" | null>(null);
    const [emojiSearch, setEmojiSearch] = useState("");
    const [gifQuery, setGifQuery] = useState("");
    const [gifs, setGifs] = useState<ComposerGif[]>([]);
    const [gifBusy, setGifBusy] = useState(false);
    const [gifError, setGifError] = useState("");
    const [gifLink, setGifLink] = useState("");
    const [serverId, setServerId] = useState(MEDIA_SERVERS[0]?.id ?? "custom");
    const [customServer, setCustomServer] = useState("");
    const [files, setFiles] = useState<LocalFile[]>([]);
    const localFiles = useRef(files); localFiles.current = files;
    const [uploadId, setUploadId] = useState("");
    const [error, setError] = useState("");
    const [dragging, setDragging] = useState(false);
    const transfer = useRef<AbortController | undefined>(undefined);
    const gifRequest = useRef<AbortController | undefined>(undefined);
    const alive = useRef(false);
    const pending = files.length > 0 || !!uploadId;
    const byteCount = new TextEncoder().encode(text).length;
    useEffect(() => { onPendingChange(pending); }, [onPendingChange, pending]);
    useEffect(() => {
        alive.current = true;
        let account = getConnectedSigner();
        const unsubscribe = subscribeConnections(() => { const current = getConnectedSigner(); if (current !== account) { transfer.current?.abort(); account = current; } });
        return () => {
            alive.current = false; unsubscribe(); transfer.current?.abort(); gifRequest.current?.abort();
            localFiles.current.forEach(item => URL.revokeObjectURL(item.preview));
        };
    }, [client]);
    useEffect(() => { if (tool !== "gif") { gifRequest.current?.abort(); setGifBusy(false); } }, [tool]);
    const rememberSelection = () => { const field = textarea.current; if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd }; };
    const insert = (value: string, block = false) => {
        const current = currentText.current;
        const start = Math.min(selection.current.start, current.length), end = Math.min(selection.current.end, current.length);
        const before = current.slice(0, start), after = current.slice(end);
        const added = block ? `${before && !/\s$/.test(before) ? "\n" : ""}${value}${after && !/^\s/.test(after) ? "\n" : ""}` : value;
        const next = before + added + after;
        if (new TextEncoder().encode(next).length > 16384) { setError("This would exceed the 16 KiB text limit."); return false; }
        currentText.current = next; onChange(next); setView("write");
        selection.current = { start: start + added.length, end: start + added.length };
        requestAnimationFrame(() => { const field = textarea.current; field?.focus({ preventScroll: true }); field?.setSelectionRange(selection.current.start, selection.current.end); });
        return true;
    };
    const pickFiles = (picked: File[]) => {
        if (!client.media.available) { setError("File uploads are unavailable in this host. Your draft is preserved."); return; }
        if (disabled || transfer.current) return;
        setError("");
        const count = localFiles.current.length + currentAttachments.current.length;
        if (count + picked.length > COMPOSER_ATTACHMENT_LIMIT) { setError("Use at most eight attachments."); return; }
        if (picked.some(file => !file.size || file.size > COMPOSER_FILE_LIMIT)) { setError("Each file must be between 1 byte and 20 MiB."); return; }
        if ([...localFiles.current.map(item => item.file), ...picked].reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) { setError("Keep selected files within 40 MiB in total."); return; }
        const added = picked.map(file => ({ id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), alt: "" }));
        const next = [...localFiles.current, ...added]; localFiles.current = next; setFiles(next); setTool("files"); setView("write");
    };
    const removeFile = (id: string) => {
        const removed = localFiles.current.find(item => item.id === id); if (removed) URL.revokeObjectURL(removed.preview);
        const next = localFiles.current.filter(item => item.id !== id); localFiles.current = next; setFiles(next);
    };
    const upload = async (item: LocalFile) => {
        if (!client.media.available) { setError("File uploads are unavailable in this host. Your draft is preserved."); return; }
        if (disabled || transfer.current) return;
        const signer = getConnectedSigner(), account = getConnections().signerPubkey;
        if (!signer) { setError("Sign in below to upload this file."); return; }
        if (!getConnections().signerCanUpload) { setError("Reconnect your signer to approve file upload permissions. Your draft is preserved."); return; }
        if (new TextEncoder().encode(currentText.current).length + 2050 > 16384) { setError("Shorten your text to leave room for an uploaded file URL."); return; }
        const controller = new AbortController(); transfer.current = controller; setUploadId(item.id); setError("");
        const patch = (change: Partial<LocalFile>) => { if (alive.current) setFiles(previous => previous.map(value => value.id === item.id ? { ...value, ...change } : value)); };
        try {
            const server: MediaServer = serverId === "custom" ? { name: "Custom Blossom", protocol: "blossom", url: customServer.trim() } : MEDIA_SERVERS.find(value => value.id === serverId)!;
            const uploaded = await uploadMedia(item.file, server, template => signer.signEvent(template), controller.signal, value => patch({ progress: value, error: undefined }));
            if (!alive.current || controller.signal.aborted || signer !== getConnectedSigner() || account !== getConnections().signerPubkey) return;
            if (!insert(uploaded.url, true)) { patch({ error: `Uploaded, but text is full. Copy this URL: ${uploaded.url}` }); return; }
            onAttachmentsChange([...currentAttachments.current.filter(value => value.url !== uploaded.url), { ...uploaded, alt: item.alt }]); removeFile(item.id);
        } catch (failure) { if (alive.current) patch({ error: failureMessage(failure), progress: undefined }); }
        finally { if (transfer.current === controller) transfer.current = undefined; if (alive.current) setUploadId(""); }
    };
    const search = async () => {
        gifRequest.current?.abort(); const controller = new AbortController(); gifRequest.current = controller;
        setGifBusy(true); setGifError(""); setGifs([]);
        try { const results = await searchComposerGifs(gifQuery, controller.signal); if (alive.current && !controller.signal.aborted) setGifs(results); }
        catch (failure) { if (alive.current && !controller.signal.aborted) setGifError(failureMessage(failure)); }
        finally { if (alive.current && gifRequest.current === controller) setGifBusy(false); }
    };
    const insertGif = (url: string) => {
        try { const safe = mediaUrl(url.trim()); if (!/\.gif(?:\?|$)/i.test(safe)) throw new Error("Paste a direct .gif file URL."); if (insert(safe, true)) { setTool(null); setGifLink(""); } }
        catch (failure) { setGifError(failureMessage(failure)); }
    };
    return <section aria-label="Note editor" className={`note-editor${dragging ? " is-dragging" : ""}`}
        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); pickFiles([...event.dataTransfer.files]); } }}>
        <div className="composer-view-switch" role="tablist" aria-label="Editor view">
            {(["write", "preview"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={view === value} className="focus-pixel" onClick={() => setView(value)}>{value === "write" ? "Write" : "Preview"}</button>)}
            <span className={byteCount > 16384 ? "text-neon-pink" : ""} aria-label={`${byteCount} of 16384 bytes`}>{(byteCount / 1024).toFixed(1)} / 16 KiB</span>
        </div>
        {view === "write" ? <textarea ref={textarea} value={text} disabled={disabled} rows={8} maxLength={16384} aria-label={textLabel} placeholder={placeholder}
            className="composer-textarea focus-pixel" onSelect={rememberSelection} onClick={rememberSelection} onKeyUp={rememberSelection} onBlur={rememberSelection}
            onChange={event => { currentText.current = event.target.value; onChange(event.target.value); rememberSelection(); }}
            onPaste={event => { const picked = [...event.clipboardData.files]; if (picked.length) { event.preventDefault(); pickFiles(picked); } }}
            onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (!pending && byteCount <= 16384 && text.trim()) onReview(); } }} />
            : <div className="composer-preview @container/row" role="region" aria-label="Draft preview">{text.trim() ? <NoteContent text={text} tags={[]} embedQuotes={false} previewLinks={false} initiallyExpanded /> : <p>Your preview will appear here.</p>}</div>}
        <div className="composer-tools" role="toolbar" aria-label={toolbarLabel} onPointerDown={rememberSelection}>
            <button type="button" className="composer-tool focus-pixel" aria-label="Emoji" aria-expanded={tool === "emoji"} disabled={disabled} onClick={() => setTool(tool === "emoji" ? null : "emoji")}><ToolIcon kind="emoji" /></button>
            <button type="button" className="composer-tool focus-pixel" aria-label="GIF" aria-expanded={tool === "gif"} disabled={disabled} onClick={() => setTool(tool === "gif" ? null : "gif")}>GIF</button>
            <button type="button" className="composer-tool focus-pixel" aria-label="Attach files" disabled={disabled || !!uploadId || !client.media.available} onClick={() => fileInput.current?.click()}><ToolIcon kind="attach" /></button>
            <button type="button" className="composer-tool composer-upload-settings focus-pixel" aria-expanded={tool === "files"} disabled={disabled} onClick={() => setTool(tool === "files" ? null : "files")}>{serverId === "custom" ? "Blossom" : MEDIA_SERVERS.find(value => value.id === serverId)?.name}</button>
            <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose attachments" onChange={event => { pickFiles([...event.target.files ?? []]); event.target.value = ""; }} />
        </div>
        {tool === "emoji" && <div className="composer-picker" role="region" aria-label="Emoji picker">
            <input type="search" aria-label="Search emoji" placeholder="Search emoji" className="composer-input focus-pixel" value={emojiSearch} onChange={event => setEmojiSearch(event.target.value)} />
            <div className="composer-emoji-grid">{EMOJIS.filter(([, name]) => name.includes(emojiSearch.toLowerCase().trim())).map(([emoji, name], index) => <button type="button" key={`${emoji}:${index}`} className="focus-pixel" aria-label={name} onClick={() => { if (insert(emoji)) setTool(null); }}>{emoji}</button>)}</div>
        </div>}
        {tool === "gif" && <div className="composer-picker" role="region" aria-label="GIF picker">
            {client.media.gifAttribution && <p className="text-xs">GIFs from <a href={client.media.gifAttribution.href} target="_blank" rel="noopener noreferrer">{client.media.gifAttribution.label}</a></p>}

            {gifSearchAvailable() ? <form className="composer-search" onSubmit={event => { event.preventDefault(); void search(); }}>
                <input type="search" className="composer-input focus-pixel" aria-label="Search GIFs" placeholder="Search GIFs" maxLength={120} value={gifQuery} onChange={event => setGifQuery(event.target.value)} />
                <PixelButton type="submit" size="sm" disabled={gifBusy}>Search</PixelButton>
            </form> : <>{client.media.gifSearchLink ? <a href={client.media.gifSearchLink(gifQuery)} target="_blank" rel="noopener noreferrer" className="composer-external-search focus-pixel">Browse GIFs</a> : <p role="status">GIF search is unavailable.</p>}</>}
            {gifBusy && <StatusMessage compact loading>Finding GIFs...</StatusMessage>}
            {gifError && <p role="alert" className="text-xs text-neon-pink">{gifError}</p>}
            {!!gifs.length && <div className="composer-gif-grid">{gifs.filter(gif => client.policy.mediaAllowed(gif.url) && client.policy.mediaAllowed(gif.preview)).map(gif => <button key={gif.url} type="button" className="focus-pixel" aria-label={`Insert ${gif.title}`} onClick={() => insertGif(gif.url)}><img src={gif.preview} alt={gif.title} loading="lazy" /></button>)}</div>}
            <form className="composer-search" onSubmit={event => { event.preventDefault(); insertGif(gifLink); }}><input type="url" className="composer-input focus-pixel" aria-label="GIF link" placeholder="Or paste a direct GIF link" value={gifLink} onChange={event => setGifLink(event.target.value)} /><PixelButton type="submit" size="sm" disabled={!gifLink.trim()}>Add</PixelButton></form>
        </div>}
        {tool === "files" && <div className="composer-picker space-y-3" role="region" aria-label="Upload settings">
            <label className="composer-server-label">Upload to<select className="composer-input focus-pixel" aria-label="Upload server" disabled={!!uploadId} value={serverId} onChange={event => setServerId(event.target.value)}>{MEDIA_SERVERS.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}<option value="custom">Custom Blossom</option></select></label>
            {serverId === "custom" && <input type="url" className="composer-input focus-pixel" aria-label="Blossom server" placeholder="https://blossom.example.com" value={customServer} disabled={!!uploadId} onChange={event => setCustomServer(event.target.value)} />}
            <p className="text-xs text-cyan-100/65">Upload makes the file public on this server. Publishing your reply is a separate step. Up to 20 MiB per file.</p>
            <p className="text-xs text-cyan-100/50">Unuploaded files stay here until you close the editor. Removing an uploaded attachment does not delete its hosted file.</p>
        </div>}
        {!!files.length && <ul className="composer-attachments" aria-label="Selected files">{files.map(item => <li key={item.id} className="composer-attachment">
            <MediaThumbnail src={item.preview} type={item.file.type} alt={item.alt || item.file.name} />
            <div className="composer-attachment-info"><p>{item.file.name}</p><span>{(item.file.size / 1024 / 1024).toFixed(1)} MiB</span>
                <input type="text" className="composer-input focus-pixel" aria-label={`Description for ${item.file.name}`} placeholder="Image description (optional)" maxLength={1000} value={item.alt} disabled={!!uploadId} onChange={event => setFiles(previous => previous.map(value => value.id === item.id ? { ...value, alt: event.target.value } : value))} />
                {item.error && <p role="alert" className="text-neon-pink">{item.error}</p>}
                {uploadId === item.id && <StatusMessage compact loading>{item.progress === 0 || item.progress === undefined ? "Preparing upload..." : `Uploading ${item.progress}%`}</StatusMessage>}
                <div className="composer-attachment-actions">{uploadId === item.id ? <PixelButton size="sm" variant="ghost" onClick={() => transfer.current?.abort()}>Stop upload</PixelButton> : <PixelButton size="sm" disabled={!!uploadId || disabled} onClick={() => void upload(item)}>Upload file</PixelButton>}<button type="button" className="focus-pixel" aria-label={`Remove ${item.file.name}`} disabled={!!uploadId} onClick={() => removeFile(item.id)}>Remove</button></div>
            </div>
        </li>)}</ul>}
        {!!attachments.length && <ul className="composer-attachments" aria-label="Uploaded attachments">{attachments.map(item => <li key={item.url} className="composer-attachment">
            <MediaThumbnail src={mediaAllowed(client.policy, item.url) ? item.url : ""} type={item.type} alt={item.alt || "Uploaded attachment"} />
            <div className="composer-attachment-info"><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-neon-cyan">{new URL(item.url).pathname.split("/").at(-1)}</a>
                <input type="text" className="composer-input focus-pixel" aria-label={`Description for ${item.url}`} placeholder="Image description (optional)" maxLength={1000} value={item.alt} disabled={disabled} onChange={event => onAttachmentsChange(attachments.map(value => value.url === item.url ? { ...value, alt: event.target.value } : value))} />
                <button type="button" className="composer-remove focus-pixel" aria-label={`Remove attachment ${item.url}`} disabled={disabled} onClick={() => { const next = currentText.current.split(/\r?\n/).filter(line => line.trim() !== item.url).join("\n"); currentText.current = next; onChange(next); onAttachmentsChange(attachments.filter(value => value.url !== item.url)); }}>Remove attachment</button>
            </div>
        </li>)}</ul>}
        {error && <p role="alert" className="composer-error">{error}</p>}
        {byteCount > 16384 && <p role="alert" className="composer-error">Your reply exceeds 16 KiB. Shorten it before continuing.</p>}
    </section>;
}

export type NoteEditorProps = Parameters<typeof NoteEditor>[0];
