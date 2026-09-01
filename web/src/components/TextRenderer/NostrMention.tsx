import { useProfileValue } from "@nostr-dev-kit/react";
import { njumpUrl, shortNpub } from "../../lib/nostr";

/**
 * A person mentioned inside a note.
 *
 * This is the whole reason the renderer stopped building an HTML string: a hook
 * cannot run inside one, so a mention could never be more than the first twelve
 * characters of an npub. It reads as a name now, and falls back to the short
 * npub while the profile is still on its way or never arrives.
 *
 * Deliberately lighter than UserProfileInline, which draws the byline. A
 * mention sits inside a sentence, so it gets no avatar and no verification
 * mark; it is a word, not a row.
 */
export function NostrMention({ pubkey }: { pubkey: string }) {
    const profile = useProfileValue(pubkey);
    const name = profile?.displayName?.trim() || profile?.name?.trim();

    return (
        <a
            href={njumpUrl(pubkey)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={profile?.nip05 || undefined}
        >
            {name ? `@${name}` : shortNpub(pubkey)}
        </a>
    );
}
