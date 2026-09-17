import { useEffect, useRef, useState } from "react";
import { NDKSubscriptionCacheUsage, type NDKEvent, type NDKSubscription } from "@nostr-dev-kit/ndk";
import { PUBLIC_RELAYS, RELAY_URL } from "../../config";
import { ndk } from "../../lib/ndk";
import { quoteExcerpt, type NoteQuoteReference } from "../../lib/noteAttachments";
import { UserProfileInline } from "../UserProfileInline/UserProfileInline";

/** One level of quotation only. A quote never imports another ranked row or its animations. */
export function NoteQuote({ reference }: { reference: NoteQuoteReference }) {
    const container = useRef<HTMLDivElement>(null);
    const [event, setEvent] = useState<NDKEvent | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const href = `https://njump.me/${reference.bech32}`;

    useEffect(() => {
        let subscription: NDKSubscription | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        const start = () => {
            if (subscription || stopped) return;
            subscription = ndk.subscribe(reference.filter, {
                closeOnEose: true,
                cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                // Grouped requests can outlive a row changing from plain text to billboard.
                groupable: false,
                relayUrls: [...new Set([RELAY_URL, ...PUBLIC_RELAYS, ...reference.relays.filter((url) => /^wss?:\/\//i.test(url))])],
            }, false);
            subscription.on("event", (note: NDKEvent) => {
                if (stopped) return;
                setEvent((current) => !current || (note.created_at ?? 0) > (current.created_at ?? 0) ? note : current);
            });
            subscription.on("eose", () => { if (!stopped) setUnavailable(true); });
            timeout = setTimeout(() => { if (!stopped) { setUnavailable(true); subscription?.stop(); } }, 8000);
            subscription.start();
        };
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { observer.disconnect(); start(); }
        }, { rootMargin: "200px" });
        if (container.current) observer.observe(container.current);
        return () => { stopped = true; observer.disconnect(); clearTimeout(timeout); subscription?.stop(); };
    }, [reference]);

    return (
        <div ref={container} className="note-quote" aria-label="Quoted note">
            <span className="font-pixel text-[8px] tracking-widest text-cyan-300/50">QUOTED NOTE</span>
            {event ? <>
                <div className="mt-2"><UserProfileInline pubkey={event.pubkey} /></div>
                <a href={href} target="_blank" rel="noopener noreferrer nofollow"
                    className="focus-pixel mt-2 block text-[13px] leading-relaxed text-cyan-50/80 hover:text-neon-cyan">
                    {quoteExcerpt(event.content)}
                </a>
            </> : <a href={href} target="_blank" rel="noopener noreferrer nofollow"
                className="note-action mt-2 block py-2">
                {unavailable ? "Open quoted note" : "Loading quoted note…"}
            </a>}
        </div>
    );
}
