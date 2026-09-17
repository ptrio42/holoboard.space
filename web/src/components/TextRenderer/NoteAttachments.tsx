import { useMemo } from "react";
import { linkLabel, noteAttachments } from "../../lib/noteAttachments";
import { NoteQuote } from "./NoteQuote";
import { Expandable } from "../ui/Expandable";

export function NoteAttachments({ content, tags, ownId }: { content: string; tags: string[][]; ownId: string }) {
    const attachments = useMemo(() => noteAttachments(content, tags, ownId), [content, tags, ownId]);
    if (!attachments.links.length && !attachments.quotes.length) return null;
    return <Expandable label="links and quoted notes"><div className="space-y-3" aria-label="Links and quoted notes">
        {attachments.links.length > 0 && <ul className="space-y-1">
            {attachments.links.map((href) => <li key={href}>
                <a href={href} target="_blank" rel="noopener noreferrer nofollow"
                    className="focus-pixel inline-flex min-h-9 max-w-full items-center gap-2 text-[13px] text-neon-cyan hover:text-neon-pink"
                    title={href}>
                    <span aria-hidden="true" className="shrink-0 font-pixel text-[9px]">&gt;</span>
                    <span className="min-w-0 truncate underline underline-offset-4">{linkLabel(href)}</span>
                </a>
            </li>)}
        </ul>}
        {attachments.quotes.map((reference) => <NoteQuote key={reference.key} reference={reference} />)}
    </div></Expandable>;
}
