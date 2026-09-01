/**
 * Splits the raw content of a kind:1 into pieces the renderer can draw.
 *
 * This used to build an HTML string that was escaped by hand and then handed to
 * DOMPurify. That works, but it means the safety of every note on the board
 * rests on getting the escaping right in the same function that is also
 * matching URLs. Producing plain data instead and letting React create the
 * nodes removes the question: there is no HTML to sanitise, because none is
 * ever built.
 *
 * Nothing here touches the network or nostr encoding. It is a pure function
 * over a string, which is what makes it worth testing.
 */

export type ContentToken =
    | { kind: "text"; value: string }
    | { kind: "link"; href: string }
    | { kind: "image"; src: string }
    | { kind: "video"; src: string }
    /** A `nostr:` reference or a bare bech32 one, still encoded. */
    | { kind: "mention"; bech32: string };

const TOKEN =
    /(https?:\/\/[^\s<>"']+)|((?:nostr:)?(?:npub1|nprofile1|note1|nevent1|naddr1)[023456789acdefghjklmnpqrstuvwxyz]{20,})/gi;

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;

// Deliberately short. These are the formats a browser plays natively without a
// player library; anything else stays a link rather than an element that shows
// a broken control.
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i;

// A URL at the end of a sentence swallows the punctuation, which breaks the
// extension test as surely as it breaks the link.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Balanced-ish: keep a closing bracket only when the URL opened one. */
function trimUrl(url: string): string {
    let trimmed = url.replace(TRAILING_PUNCTUATION, "");
    while (trimmed.endsWith(")") && !trimmed.includes("(")) {
        trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
    return trimmed;
}

export function parseContent(text: string = ""): ContentToken[] {
    const tokens: ContentToken[] = [];
    let cursor = 0;

    const pushText = (value: string) => {
        if (!value) return;
        const previous = tokens[tokens.length - 1];
        if (previous?.kind === "text") previous.value += value;
        else tokens.push({ kind: "text", value });
    };

    for (const match of text.matchAll(TOKEN)) {
        const [token, url, nostrRef] = match;
        const start = match.index ?? 0;

        pushText(text.slice(cursor, start));
        cursor = start + token.length;

        if (url) {
            const href = trimUrl(url);
            // Whatever punctuation was trimmed is still part of the sentence.
            const remainder = url.slice(href.length);

            if (IMAGE_EXTENSION.test(href)) tokens.push({ kind: "image", src: href });
            else if (VIDEO_EXTENSION.test(href)) tokens.push({ kind: "video", src: href });
            else tokens.push({ kind: "link", href });

            pushText(remainder);
        } else if (nostrRef) {
            tokens.push({ kind: "mention", bech32: nostrRef.replace(/^nostr:/i, "").toLowerCase() });
        }
    }

    pushText(text.slice(cursor));
    return tokens;
}
