import { useCallback, useEffect, useRef, useState } from "react";
import {
    NDKEvent,
    NDKKind,
    NDKRelaySet,
    NDKSubscriptionCacheUsage,
    NDKZapper,
    type NDKSubscription,
} from "@nostr-dev-kit/ndk";
import { useNDK } from "@nostr-dev-kit/react";
import { PUBLIC_RELAYS, RELAY_PUBKEY } from "../../config";
import { parseNoteReference, toNeventUri, toNpub, type NoteReference } from "../../lib/nostr";

/**
 * The mention flow, which is the one with real usage:
 *
 *   1. publish a kind:1 mentioning the relay and quoting the note
 *   2. the relay answers with a promotional reply carrying a `promoted_note` tag
 *   3. zapping that reply is what buys the ranking
 *
 * Steps 1 to 3 all happen on public relays. The board relay rejects anything
 * that has not been paid for yet, so none of this can go through it.
 */
export type Stage =
    | "compose"
    | "publishing"
    | "awaiting-reply"
    | "choose-amount"
    | "invoice"
    | "paid";

export interface PromotionState {
    stage: Stage;
    error: string | null;
    note: NoteReference | null;
    reply: NDKEvent | null;
    amountSats: number | null;
    invoice: string | null;
}

const REPLY_TIMEOUT_MS = 90_000;

const initialState: PromotionState = {
    stage: "compose",
    error: null,
    note: null,
    reply: null,
    amountSats: null,
    invoice: null,
};

export function usePromotionFlow() {
    const { ndk } = useNDK();
    const [state, setState] = useState<PromotionState>(initialState);

    const replySub = useRef<NDKSubscription | null>(null);
    const receiptSub = useRef<NDKSubscription | null>(null);
    const replyTimer = useRef<number | null>(null);
    const settleInvoice = useRef<((result: { preimage: string } | undefined) => void) | null>(null);
    const invoiceShown = useRef(false);

    const teardown = useCallback(() => {
        replySub.current?.stop();
        replySub.current = null;
        receiptSub.current?.stop();
        receiptSub.current = null;
        if (replyTimer.current !== null) window.clearTimeout(replyTimer.current);
        replyTimer.current = null;
        settleInvoice.current?.(undefined);
        settleInvoice.current = null;
    }, []);

    useEffect(() => teardown, [teardown]);

    const fail = useCallback((message: string, stage: Stage) => {
        setState((current) => ({ ...current, stage, error: message }));
    }, []);

    /** Step 1 and 2: publish the mention, then wait for the relay to answer it. */
    const submitNote = useCallback(
        async (input: string) => {
            if (!ndk) return;
            const note = parseNoteReference(input);
            if (!note) {
                fail(
                    "That does not look like a note. Paste a note1, an nevent1, a 64-character id, or a link containing one.",
                    "compose",
                );
                return;
            }
            if (!ndk.signer) {
                fail("Connect a signer before promoting a note.", "compose");
                return;
            }

            teardown();
            setState({ ...initialState, stage: "publishing", note });

            const relaySet = NDKRelaySet.fromRelayUrls(PUBLIC_RELAYS, ndk);
            const mention = new NDKEvent(ndk);
            mention.kind = NDKKind.Text;
            mention.content = `nostr:${toNpub(RELAY_PUBKEY)} promote ${toNeventUri(note)}`;
            mention.tags = [["p", RELAY_PUBKEY]];

            let published: Set<unknown>;
            try {
                published = await mention.publish(relaySet, 10_000);
            } catch (cause) {
                fail(
                    cause instanceof Error ? cause.message : "Could not publish the mention.",
                    "compose",
                );
                return;
            }
            if (published.size === 0) {
                fail("No public relay accepted the mention. Check your connection.", "compose");
                return;
            }

            setState((current) => ({ ...current, stage: "awaiting-reply" }));

            replySub.current = ndk.subscribe(
                [{ kinds: [NDKKind.Text], authors: [RELAY_PUBKEY], "#e": [mention.id] }],
                {
                    closeOnEose: false,
                    relayUrls: PUBLIC_RELAYS,
                    cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                },
                {
                    onEvent: (reply: NDKEvent) => {
                        // A reply without this tag is the relay's usage text or an
                        // error, not something worth zapping.
                        const promoted = reply.tagValue("promoted_note");
                        replySub.current?.stop();
                        replySub.current = null;
                        if (replyTimer.current !== null) window.clearTimeout(replyTimer.current);

                        if (!promoted) {
                            fail(reply.content.trim() || "The relay could not fetch that note.", "compose");
                            return;
                        }
                        setState((current) => ({
                            ...current,
                            stage: "choose-amount",
                            reply,
                            error: null,
                        }));
                    },
                },
            );

            replyTimer.current = window.setTimeout(() => {
                replySub.current?.stop();
                replySub.current = null;
                fail(
                    "The relay did not answer within 90 seconds. It may be offline. " +
                        "The manual routes below still work once it is back.",
                    "compose",
                );
            }, REPLY_TIMEOUT_MS);
        },
        [ndk, fail, teardown],
    );

    /** Step 3: zap the promotional reply. */
    const zapReply = useCallback(
        async (amountSats: number) => {
            const reply = state.reply;
            if (!ndk || !reply) return;

            setState((current) => ({
                ...current,
                stage: "invoice",
                amountSats,
                invoice: null,
                error: null,
            }));

            // The receipt is the source of truth for "paid". A copy-pasted invoice
            // never reports back, so this is what closes the loop for wallets that
            // are not WebLN.
            receiptSub.current = ndk.subscribe(
                [{ kinds: [NDKKind.Zap], "#e": [reply.id] }],
                {
                    closeOnEose: false,
                    relayUrls: PUBLIC_RELAYS,
                    cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                },
                {
                    onEvent: () => {
                        settleInvoice.current?.({ preimage: "" });
                        settleInvoice.current = null;
                        setState((current) => ({ ...current, stage: "paid" }));
                    },
                },
            );

            /*
             * NDKZapper swallows the real failure into a `notice` and throws a
             * flat "All zap attempts failed", so keep the notices around and
             * report the last one instead.
             */
            const notices: string[] = [];
            invoiceShown.current = false;
            const zapper = new NDKZapper(reply, amountSats * 1_000, "msat", {
                ndk,
                signer: ndk.signer,
                comment: "holoboard.space",
                lnPay: async ({ pr }) => {
                    invoiceShown.current = true;
                    setState((current) => ({ ...current, invoice: pr }));
                    if (typeof window !== "undefined" && window.webln) {
                        try {
                            await window.webln.enable();
                            return await window.webln.sendPayment(pr);
                        } catch {
                            // Fall through to the copy-and-pay path below.
                        }
                    }
                    return new Promise((resolve) => {
                        settleInvoice.current = resolve;
                    });
                },
            });

            zapper.on("notice", (message: string) => notices.push(message));

            try {
                const results = await zapper.zap(["nip57"]);
                const failure = Array.from(results.values()).find((r) => r instanceof Error);
                if (failure instanceof Error) throw failure;
            } catch (cause) {
                /*
                 * Once the invoice is on screen the zapper's own promise is no
                 * longer the thing we are waiting on: it only settles when the
                 * receipt arrives or the flow is torn down, so a rejection here
                 * is bookkeeping, not a failure the payer needs to see.
                 */
                if (invoiceShown.current) return;
                receiptSub.current?.stop();
                receiptSub.current = null;
                const raw = cause instanceof Error ? cause.message : String(cause);
                const detail = notices.at(0) ?? raw;
                fail(
                    /no zap endpoint|no zap method|zap spec/i.test(detail)
                        ? "The relay has no Lightning address on its profile, so it cannot be zapped yet."
                        : detail,
                    "choose-amount",
                );
                return;
            }

            setState((current) =>
                current.stage === "paid" ? current : { ...current, stage: "paid" },
            );
        },
        [ndk, state.reply, fail],
    );

    return { state, submitNote, zapReply };
}
