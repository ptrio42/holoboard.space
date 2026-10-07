import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { njumpUrl } from "./nostr";
import { KIND_COMMENT } from "../config";
import { threadContext, threadHref } from "./thread";

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

/**
 * NIP-10 marks the root of a thread when it bothers to mark anything, and the
 * unmarked form is positional; the final unmarked `e` is the direct parent.
 */
const replyTarget = (event: NDKEvent): string | undefined => {
    const tags = event.tags.filter((tag) => tag[0] === "e");
    return (tags.find((tag) => tag[3] === "reply") ?? tags.find((tag) => tag[3] === "root") ?? tags.filter((tag) => !tag[3]).at(-1))?.[1];
};

export function parentOf(event: NDKEvent): Parent | null {
    if (event.kind === KIND_COMMENT) {
        const context = threadContext({ kind: event.kind, tags: event.tags });
        const target = context.root ?? context.parent;
        if (!target) return null;
        return { href: target.type === "event" ? njumpUrl(target.value, "note") : threadHref(target), label: "Comment on" };
    }

    const target = replyTarget(event);
    return target ? { href: njumpUrl(target, "note"), label: "In reply to" } : null;
}
