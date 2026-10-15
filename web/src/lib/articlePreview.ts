import { Lexer, type MarkedToken, type Token } from "marked";
import { mediaTokens, safeMediaSource, type NoteMediaItem } from "./noteMedia";
import { parseContent } from "../utils/textProcessing/parseContent";
import type { NoteTextToken, TextFormat } from "./noteTextTokens";
import { firstPreviewLink } from "./linkPreview";

/** NIP-23 Markdown previews use lexer data and React nodes, never generated HTML. */
export function articlePreview(content: string, tags: string[][] = []) {
    const words: NoteTextToken[] = [];
    const images = new Set<string>(), videos = new Set<string>();
    const ordered: Pick<NoteMediaItem, "kind" | "src">[] = [];
    const add = (kind: "image" | "video", src: string) => {
        if (!ordered.some(item => item.src === src)) ordered.push({ kind, src });
        (kind === "image" ? images : videos).add(src);
    };
    let link: string | null = null;
    const text = (value: string, formats: readonly TextFormat[] = []) => {
        if (value) words.push(formats.length ? { kind: "formatted", value, formats } : { kind: "text", value });
    };
    const target = (href: string) => {
        try {
            const url = new URL(href);
            return /^https?:$/.test(url.protocol) && !url.username && !url.password ? href : null;
        } catch { return null; }
    };
    const media = (href: string, image = false) => {
        const safe = target(href);
        if (!safe || !safeMediaSource(safe)) return false;
        const token = mediaTokens(safe, tags)[0];
        if (token?.kind === "video") { add("video", safe); return true; }
        if (image || token?.kind === "image") { add("image", safe); return true; }
        return false;
    };
    const label = (tokens: Token[] = []): string => tokens.map(token =>
        "tokens" in token && token.tokens ? label(token.tokens) : "text" in token ? String(token.text) : token.type === "br" ? "\n" : "").join("");
    const inline = (tokens: Token[] = [], formats: readonly TextFormat[] = []) => {
        // This lexer has no extensions; its output contains only built-in tokens.
        for (const token of tokens as MarkedToken[]) {
            switch (token.type) {
                case "strong": case "em": case "del":
                    inline(token.tokens, [...formats, token.type]); break;
                case "codespan": text(token.text, [...formats, "code"]); break;
                case "br": text("\n"); break;
                case "image": media(token.href, true); break;
                case "link": {
                    if (media(token.href)) break;
                    const reference = parseContent(token.href);
                    if (reference.length === 1 && reference[0].kind === "mention") { words.push(reference[0]); break; }
                    const href = target(token.href);
                    const name = label(token.tokens);
                    if (href) { words.push({ kind: "article-link", href, label: name }); link ??= firstPreviewLink(href); }
                    else text(name, formats);
                    break;
                }
                case "text":
                    if (token.tokens) inline(token.tokens, formats);
                    else for (const part of parseContent(token.text)) {
                        if (part.kind === "text") text(part.value, formats);
                        else if (part.kind === "image" || part.kind === "video") media(part.src);
                        else if (part.kind === "link") {
                            if (media(part.href)) continue;
                            if (target(part.href)) { words.push(part); link ??= firstPreviewLink(part.href); }
                            else text(part.href, formats);
                        } else words.push(part);
                    }
                    break;
                default:
                    // Raw HTML, escapes and unknown syntax stay inert text.
                    text("text" in token ? String(token.text) : token.raw, formats);
            }
        }
    };
    const blocks = (tokens: Token[] = []) => {
        for (const token of tokens as MarkedToken[]) {
            switch (token.type) {
                case "space": case "def": break;
                case "heading": inline(token.tokens, ["strong"]); text("\n\n"); break;
                case "paragraph": inline(token.tokens); text("\n\n"); break;
                case "text": if (token.tokens) inline(token.tokens); else text(token.text); text("\n"); break;
                case "blockquote": blocks(token.tokens); break;
                case "code": text(token.text, ["code"]); text("\n\n"); break;
                case "hr": text("\n\n"); break;
                case "list":
                    token.items.forEach((item, index) => {
                        text(item.task ? item.checked ? "[x] " : "[ ] " : token.ordered ? `${Number(token.start) + index}. ` : "• ");
                        blocks(item.tokens);
                    }); text("\n"); break;
                case "table":
                    for (const row of [token.header, ...token.rows]) {
                        row.forEach((cell, index) => { if (index) text(" | "); inline(cell.tokens); }); text("\n");
                    } text("\n"); break;
                default: text("text" in token ? String(token.text) : token.raw); text("\n\n");
            }
        }
    };
    try { blocks(Lexer.lex(content)); }
    catch { return { words: [{ kind: "text" as const, value: content }], images: [], videos: [], media: [], link: null }; }
    // Removed attachments must not leave empty paragraphs in the excerpt.
    const compact: NoteTextToken[] = [];
    for (const token of words) {
        const previous = compact.at(-1);
        if (token.kind === "text" && previous?.kind === "text") previous.value += token.value;
        else compact.push(token);
    }
    for (const token of compact) if (token.kind === "text") token.value = token.value.replace(/\n{3,}/g, "\n\n");
    if (compact[0]?.kind === "text") compact[0].value = compact[0].value.trimStart();
    const last = compact.at(-1);
    if (last?.kind === "text") last.value = last.value.trimEnd();
    return { words: compact, images: [...images], videos: [...videos], media: ordered, link };
}
