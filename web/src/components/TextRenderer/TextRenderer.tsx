import { Fragment, useMemo } from "react";
import { nip19 } from "@nostr-dev-kit/ndk";
import { parseContent, type ContentToken } from "../../utils/textProcessing/parseContent";
import { NostrMention } from "./NostrMention";
import { noteAttachments, quoteReference } from "../../lib/noteAttachments";
import { NoteQuote } from "./NoteQuote";

/**
 * Draws the body of a kind:1.
 *
 * Everything here came from a stranger. It used to be handled by escaping the
 * text, weaving HTML around it and running the result through DOMPurify, which
 * works but puts the safety of the board in the hands of one escaping function.
 * React builds the nodes now: the text goes in as a string and comes out as a
 * text node, so there is no markup to smuggle anything through and no sanitiser
 * to configure correctly.
 *
 * Links are safe by construction rather than by filtering, because the parser
 * only ever matches `https?://`, so no `javascript:` href can reach an anchor.
 */

interface Props {
    text: string;
    tags?: string[][];
    ownId?: string;
    embedQuotes?: boolean;
}

/** Text nodes carry the newlines, which JSX will not turn into breaks for us. */
function withBreaks(value: string, keyPrefix: string) {
    const lines = value.split(/\r?\n/);
    return lines.map((line, index) => (
        <Fragment key={`${keyPrefix}-${index}`}>
            {index > 0 && <br />}
            {line}
        </Fragment>
    ));
}

/** A bech32 reference to somebody, as opposed to one to a note. */
function pubkeyOf(bech32: string): string | null {
    try {
        const decoded = nip19.decode(bech32);
        if (decoded.type === "npub") return decoded.data;
        if (decoded.type === "nprofile") return decoded.data.pubkey;
    } catch {
        // Not decodable, so it is shown as a link rather than a name.
    }
    return null;
}

function renderToken(token: ContentToken, key: string, embedQuotes: boolean, ownId?: string) {
    switch (token.kind) {
        case "text":
            return <Fragment key={key}>{withBreaks(token.value, key)}</Fragment>;

        case "image":
            return <img key={key} src={token.src} alt="" loading="lazy" decoding="async" />;

        case "video":
            // No autoplay and metadata only. A dozen notes are on screen at
            // once, and a board that starts a dozen streams on load is a board
            // nobody waits for.
            return (
                <video
                    key={key}
                    src={token.src}
                    controls
                    playsInline
                    preload="metadata"
                />
            );

        case "mention": {
            const pubkey = pubkeyOf(token.bech32);
            if (pubkey) return <NostrMention key={key} pubkey={pubkey} />;
            const quote = embedQuotes ? quoteReference(token.bech32) : null;
            if (quote && quote.key !== ownId) return <NoteQuote key={key} reference={quote} />;
            return (
                <a
                    key={key}
                    href={`https://njump.me/${token.bech32}`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                >
                    {`${token.bech32.slice(0, 12)}...`}
                </a>
            );
        }

        case "link": {
            const quote = embedQuotes ? quoteReference(token.href) : null;
            if (quote && quote.key !== ownId) return <NoteQuote key={key} reference={quote} />;
            return (
                <a
                    key={key}
                    href={token.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                >
                    {token.href.length > 64 ? `${token.href.slice(0, 61)}...` : token.href}
                </a>
            );
        }
    }
}

export default function TextRenderer({ text, tags, ownId, embedQuotes = true }: Props) {
    const tokens = useMemo(() => parseContent(text), [text]);
    const taggedQuotes = useMemo(() => {
        const inline = new Set(noteAttachments(text).quotes.map((quote) => quote.key));
        return embedQuotes ? noteAttachments("", tags, ownId).quotes.filter((quote) => !inline.has(quote.key)) : [];
    }, [text, tags, ownId, embedQuotes]);

    return (
        <div className="note-body">
            {tokens.map((token, index) => renderToken(token, `t${index}`, embedQuotes, ownId))}
            {taggedQuotes.map((reference) => <NoteQuote key={reference.key} reference={reference} />)}
        </div>
    );
}
