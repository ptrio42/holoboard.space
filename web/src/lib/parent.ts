import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { njumpUrl } from "./nostr";
import { KIND_COMMENT } from "../config";

/**
 * What a note is hanging off, when it is hanging off something.
 *
 * The board ranks fragments as readily as it ranks whole thoughts: a NIP-22
 * comment is always scoped to a root, and a kind:1 carrying an `e` tag is a
 * reply, which is the same thing written differently. Shown on their own both
 * read as somebody talking to nobody. A line saying what they answer costs one
 * tag lookup and is the difference between a fragment and an orphan.
 */

export interface Parent {
    /** Where to read the thing being answered. */
    href: string;
    /** "Comment on" or "In reply to": a comment is scoped, a reply is threaded. */
    label: string;
}

const firstTag = (event: NDKEvent, name: string): string[] | undefined =>
    event.tags.find((tag) => tag[0] === name && typeof tag[1] === "string" && tag[1] !== "");

/**
 * NIP-10 marks the root of a thread when it bothers to mark anything, and the
 * unmarked form is positional, so an unmarked first `e` is the best guess left.
 */
const replyTarget = (event: NDKEvent): string | undefined => {
    const marked = event.tags.find((tag) => tag[0] === "e" && (tag[3] === "root" || tag[3] === "reply"));
    return (marked ?? firstTag(event, "e"))?.[1];
};

export function parentOf(event: NDKEvent): Parent | null {
    if (event.kind === KIND_COMMENT) {
        // NIP-22 puts the root scope in uppercase tags and the immediate parent
        // in lowercase ones. The root is the more useful of the two to a reader
        // arriving cold, so it is preferred.
        const rootEvent = firstTag(event, "E") ?? firstTag(event, "e");
        if (rootEvent) return { href: njumpUrl(rootEvent[1], "note"), label: "Comment on" };

        // An I tag scopes a comment to something outside nostr entirely.
        const external = firstTag(event, "I") ?? firstTag(event, "i");
        if (external && /^https?:\/\//i.test(external[1])) {
            return { href: external[1], label: "Comment on" };
        }
        return null;
    }

    const target = replyTarget(event);
    return target ? { href: njumpUrl(target, "note"), label: "In reply to" } : null;
}
