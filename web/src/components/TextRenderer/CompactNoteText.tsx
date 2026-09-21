import { Fragment, useMemo } from "react";
import { nip19 } from "@nostr-dev-kit/ndk";
import { linkLabel, quoteReference } from "../../lib/noteAttachments";
import { parseContent } from "../../utils/textProcessing/parseContent";
import { NostrMention } from "./NostrMention";

function profilePubkey(bech32: string): string | null {
    try {
        const decoded = nip19.decode(bech32);
        if (decoded.type === "npub") return decoded.data;
        if (decoded.type === "nprofile") return decoded.data.pubkey;
    } catch {
        // Invalid references stay readable links.
    }
    return null;
}

/** A bounded quote body with working links and no recursive quote embeds. */
export function CompactNoteText({ text }: { text: string }) {
    const tokens = useMemo(() => parseContent(text), [text]);
    return <div className="note-body">{tokens.map((token, index) => {
        const key = `preview-${index}`;
        if (token.kind === "text") return <Fragment key={key}>{token.value}</Fragment>;
        if (token.kind === "image") return <span key={key}>[Image]</span>;
        if (token.kind === "video") return <span key={key}>[Video]</span>;
        if (token.kind === "link") return <a key={key} href={token.href} target="_blank"
            rel="noopener noreferrer nofollow">{linkLabel(token.href)}</a>;

        const pubkey = profilePubkey(token.bech32);
        if (pubkey) return <NostrMention key={key} pubkey={pubkey} />;
        const quote = quoteReference(token.bech32);
        return <a key={key} href={`https://njump.me/${quote?.bech32 ?? token.bech32}`} target="_blank"
            rel="noopener noreferrer nofollow">{`${token.bech32.slice(0, 12)}...`}</a>;
    })}</div>;
}
