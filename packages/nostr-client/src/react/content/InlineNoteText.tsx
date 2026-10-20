import { createElement, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { nip19 } from "nostr-tools";
import type { NoteTextToken } from "../../core/content/noteTextTokens";
import { linkLabel } from "../../core/content/noteAttachments";
import { useClient } from "../ClientProvider";
import { NostrMention } from "./NostrMention";

function inlineToken(token: NoteTextToken, key: number, referenceUrl?: (bech32: string) => string): ReactNode {
    if (token.kind === "text") return token.value;
    if (token.kind === "image" || token.kind === "video") return null;
    if (token.kind === "link" || token.kind === "article-link") {
        const label = token.kind === "article-link" ? token.label : linkLabel(token.href);
        return <a key={key} href={token.href} target="_blank" rel="noopener noreferrer nofollow">{label.length > 48 ? `${label.slice(0, 45)}...` : label}</a>;
    }
    if (token.kind === "formatted") return token.value;
    try {
        const decoded = nip19.decode(token.bech32);
        if (decoded.type === "npub") return <NostrMention key={key} pubkey={decoded.data} />;
        if (decoded.type === "nprofile") return <NostrMention key={key} pubkey={decoded.data.pubkey} relays={decoded.data.relays} />;
    } catch { /* Invalid references remain usable source links. */ }
    if (!referenceUrl) return <span key={key} title="Reference navigation is unavailable.">{token.bech32}</span>;
    return <a key={key} href={referenceUrl(token.bech32)} target="_blank" rel="noopener noreferrer nofollow">{`${token.bech32.slice(0, 12)}...`}</a>;
}

/** Measure DOM copies, keeping each mention and its shared profile read mounted once. */
export function InlineNoteText({ tokens, className = "", complete = false, initiallyExpanded = false, textKey = "main", quoted = false }: {
    tokens: NoteTextToken[]; className?: string; complete?: boolean; initiallyExpanded?: boolean; textKey?: string; quoted?: boolean;
}) {
    const { navigation } = useClient();
    const segments = useMemo(() => tokens.flatMap((token, index) => {
        if (token.kind === "formatted") return (token.value.match(/\S+\s*|\s+/gu) ?? []).map(word =>
            token.formats.reduceRight<ReactNode>((child, format) => createElement(format, null, child), word));
        const part = inlineToken(token, index, navigation.referenceUrl);
        return typeof part === "string" ? part.match(/\S+\s*|\s+/gu) ?? [] : part ? [part] : [];
    }), [tokens, navigation]);
    const [cut, setCut] = useState(segments.length);
    const [expanded, setExpanded] = useState(initiallyExpanded);
    const root = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLSpanElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const restore = useRef(false);
    const id = useId();

    useLayoutEffect(() => {
        const element = root.current;
        const source = content.current;
        if (!element || !source) return;
        const fit = () => {
            if (complete) { setCut(segments.length); return; }
            const style = getComputedStyle(element);
            const copy = document.createElement("div");
            copy.className = "note-text-measure";
            copy.setAttribute("aria-hidden", "true");
            copy.inert = true;
            copy.style.width = `${element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`;
            const cloned = source.cloneNode(true) as HTMLElement;
            cloned.removeAttribute("id");
            cloned.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
            cloned.querySelectorAll("[hidden]").forEach(node => node.removeAttribute("hidden"));
            [...cloned.children].forEach((node, index) => { if (typeof segments[index] === "string") node.textContent = segments[index] as string; });
            const tail = document.createElement("span");
            tail.className = "note-text-tail";
            tail.append("… ");
            const button = document.createElement("button");
            button.className = "note-text-toggle";
            button.textContent = "more";
            button.tabIndex = -1;
            tail.append(button);
            copy.append(cloned, tail);
            element.append(copy);
            try {
                const words = [...cloned.children] as HTMLElement[];
                const lineHeight = parseFloat(style.lineHeight);
                const limit = (parseInt(style.getPropertyValue("--note-lines")) || 5) * lineHeight;
                tail.style.display = "none";
                if (copy.getBoundingClientRect().height <= limit + 0.5) { setCut(segments.length); return; }
                tail.style.display = "inline";
                let previous = -1;
                const show = (count: number) => {
                    if (previous >= 0 && typeof segments[previous] === "string") words[previous].textContent = segments[previous] as string;
                    words.forEach((word, index) => { word.hidden = index >= count; });
                    previous = count - 1;
                    if (previous >= 0 && typeof segments[previous] === "string") words[previous].textContent = (segments[previous] as string).trimEnd();
                };
                let low = 0, high = words.length;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    show(middle);
                    if (copy.getBoundingClientRect().height <= limit + 0.5) low = middle;
                    else high = middle - 1;
                }
                show(low);
                while (low > 0) {
                    const range = document.createRange();
                    range.selectNodeContents(words[low - 1]);
                    const last = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1);
                    const bounds = button.getBoundingClientRect();
                    if (last && Math.abs((last.top + last.bottom - bounds.top - bounds.bottom) / 2) < lineHeight / 2) break;
                    show(--low);
                }
                setCut(low);
            } finally { copy.remove(); }
        };
        fit();
        let frame = 0;
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
        const resize = new ResizeObserver(schedule);
        resize.observe(element);
        const mutations = new MutationObserver(schedule);
        mutations.observe(source, { childList: true, subtree: true, characterData: true });
        let active = true;
        void document.fonts.ready.then(() => { if (active) schedule(); });
        return () => { active = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); };
    }, [segments, complete]);

    useLayoutEffect(() => {
        if (!restore.current || !toggle.current) return;
        restore.current = false;
        const bounds = toggle.current.getBoundingClientRect();
        if (bounds.top < 0 || bounds.bottom > innerHeight) toggle.current.scrollIntoView({ block: "center", behavior: "instant" });
        toggle.current.focus({ preventScroll: true });
    }, [expanded]);

    if (!segments.length) return null;
    const clipped = cut < segments.length;
    return <div ref={root} className={`note-body note-text ${className}`} data-note-text={textKey} data-note-expanded={expanded}>
        <span ref={content} id={id} className="note-text-content">{segments.map((part, index) => <span key={index} className="note-text-segment" hidden={!expanded && index >= cut}>
            {!expanded && clipped && index === cut - 1 && typeof part === "string" ? part.trimEnd() : part}
        </span>)}</span>
        {clipped && <span className="note-text-tail">{expanded ? " " : "… "}<button ref={toggle} type="button" className="note-text-toggle"
            aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? "Show less" : "Show more"} ${quoted ? "quoted note text" : "note text"}`}
            onClick={() => { restore.current = expanded; setExpanded(value => !value); }}>{expanded ? "less" : "more"}</button></span>}
    </div>;
}
