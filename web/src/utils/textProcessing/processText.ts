/**
 * Turns the raw content of a kind:1 into HTML.
 *
 * Everything here came from a stranger, so the text is escaped first and only
 * then are links and images woven in. Matching before escaping is what lets a
 * crafted note smuggle markup through, and DOMPurify downstream is the second
 * line of defence, not the first.
 */

const TOKEN =
    /(https?:\/\/[^\s<>"']+)|((?:nostr:)?(?:npub1|nprofile1|note1|nevent1)[023456789acdefghjklmnpqrstuvwxyz]{20,})/gi;

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

const withBreaks = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br />");

const linkTo = (href: string, text: string): string =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(text)}</a>`;

export const processText = (text: string = ""): string => {
    let html = "";
    let cursor = 0;

    for (const match of text.matchAll(TOKEN)) {
        const [token, url, nostrRef] = match;
        const start = match.index;

        html += withBreaks(text.slice(cursor, start));
        cursor = start + token.length;

        if (url) {
            html += IMAGE_EXTENSION.test(url)
                ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" />`
                : linkTo(url, url.length > 64 ? `${url.slice(0, 61)}...` : url);
        } else if (nostrRef) {
            const bare = nostrRef.replace(/^nostr:/i, "");
            html += linkTo(`https://njump.me/${bare}`, `${bare.slice(0, 12)}...`);
        }
    }

    return html + withBreaks(text.slice(cursor));
};
