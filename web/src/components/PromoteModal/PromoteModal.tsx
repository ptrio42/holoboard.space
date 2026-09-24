import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { CopyButton } from "../ui/CopyButton";
import { DirectPromote } from "./DirectPromote";
import { RELAY_PUBKEY, RELAY_URL } from "../../config";
import { toNpub } from "../../lib/nostr";
import type { RankingTarget } from "../../lib/ranking";

/** The disclosure a link can point at, so it opens already unfolded. */
export const RANKING_SECTION = "how-ranking-works";

interface PromoteModalProps {
    onClose: () => void;
    /** Set when the dialog was opened by a link to one of its sections. */
    openSection?: string;
    initialReference?: string;
    currentWeight?: number;
    rankingTargets?: RankingTarget[];
    onPaid?: () => void;
}

/** Rendered only while open; closing unmounts it, which is what clears the flow. */
export function PromoteModal({ onClose, openSection, initialReference = "", currentWeight, rankingTargets = [], onPaid }: PromoteModalProps) {
    // A link to the ranking explanation has to do three things, since the text
    // lives in a dialog that does not exist until something opens it: open the
    // dialog, unfold the section, and put it in view. The first is the caller's
    // job; the other two are here.
    const rankingRef = useRef<HTMLDetailsElement>(null);
    const [rankingOpen, setRankingOpen] = useState(openSection === RANKING_SECTION);

    useEffect(() => {
        if (openSection !== RANKING_SECTION) return;
        // Open first, then scroll after React has laid out the expanded text
        // and the dialog has placed its initial focus. Target the summary,
        // rather than centring the entire tall disclosure midway through its
        // explanation.
        let scrollFrame = 0;
        const openFrame = requestAnimationFrame(() => {
            setRankingOpen(true);
            scrollFrame = requestAnimationFrame(() => {
                rankingRef.current
                    ?.querySelector<HTMLElement>("summary")
                    ?.scrollIntoView({ block: "start", inline: "nearest" });
            });
        });
        return () => {
            cancelAnimationFrame(openFrame);
            cancelAnimationFrame(scrollFrame);
        };
    }, [openSection]);

    return (
        <Modal isOpen onClose={onClose} title="Promote a note" panelClassName="max-w-3xl">
            <div className="space-y-6 text-sm text-cyan-100/85">
                {/*
                 * Shown above the payment form, because the point
                 * is to be read before the money moves rather than found
                 * afterwards. It names what comes down without promising that
                 * everything will be looked at: a claim to review every note
                 * would make each one left standing a broken promise.
                 */}
                <section className="border-2 border-cyan-400/25 bg-void/50 p-3">
                    <h3 className="mb-1 font-pixel text-[9px] tracking-widest text-neon-gold">
                        Before you pay
                    </h3>
                    <p className="text-xs leading-relaxed text-cyan-100/70">
                        Nobody vets what goes up. Rank is sats, and recent sats count for more, so
                        a note nobody pays for slides down. Spam, scams and anything illegal come
                        down when we see them. There is no refund. Paying again will not restore
                        a note removed by the operator.
                    </p>
                </section>

                <DirectPromote initialReference={initialReference} currentWeight={currentWeight}
                    rankingTargets={rankingTargets} onPaid={onPaid} />

                {/*
                 * Spelled out rather than summarised, because somebody about to
                 * pay has a right to know what the money buys and for how long.
                 * The half-life in particular: without it a reasonable person
                 * assumes a small top-up refreshes everything they ever paid.
                 */}
                <details
                    id={RANKING_SECTION}
                    ref={rankingRef}
                    open={rankingOpen}
                    onToggle={(event) => setRankingOpen(event.currentTarget.open)}
                    className="disclosure border-t-2 border-cyan-400/20 pt-4"
                >
                    <summary className="focus-pixel cursor-pointer font-pixel text-[10px] tracking-widest
                        text-cyan-300/70 hover:text-neon-cyan">
                        How ranking works
                    </summary>
                    <div className="mt-4 space-y-4 text-xs leading-relaxed text-cyan-100/70">
                        <p>
                            The board is ordered by what a note's sats are worth today, not by what
                            was paid for it. Every payment keeps half its worth for thirty days,
                            half of that for another thirty, and so on down.
                        </p>

                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-pixel text-[9px]
                            text-cyan-300/60">
                            <dt>paid today</dt>
                            <dd>1000 sats count as 1000</dd>
                            <dt>30 days ago</dt>
                            <dd>1000 sats count as 500</dd>
                            <dt>60 days ago</dt>
                            <dd>1000 sats count as 250</dd>
                        </dl>

                        <p>
                            Every payment ages on its own, so a single sat today adds one sat and
                            nothing more: it does not refresh what was paid last year. That is why
                            the top of the board is rented rather than bought.
                        </p>

                        <p>
                            Each row shows the sats still counting today. Open that figure to see
                            the total ever paid; the blocks show how much of the total remains. The
                            whole rule is one line:
                        </p>

                        <code className="block border-2 border-cyan-400/25 bg-void p-2 text-[10px]
                            break-all text-cyan-200/80">
                            score = sum of each payment x 0.5 ^ (its age / 30 days)
                        </code>
                    </div>
                </details>

                <details className="disclosure border-t-2 border-cyan-400/20 pt-4">
                    <summary className="focus-pixel cursor-pointer font-pixel text-[10px] tracking-widest
                        text-cyan-300/70 hover:text-neon-cyan">
                        Other ways to promote
                    </summary>
                    <div className="mt-4 space-y-4 text-xs leading-relaxed">
                        <div>
                            <p className="mb-1 font-pixel text-[9px] tracking-widest text-neon-pink">
                                Mention the relay from any client
                            </p>
                            <p className="text-cyan-100/70">
                                Write a note that tags the
                                relay's npub, below, and contains the note you want promoted. The
                                relay answers with a promotional reply; zap that reply to put the
                                note on the board. The complete <code>promote</code> command is
                                required. Tagging works in clients that do not support promotion
                                details in zap comments.
                            </p>
                        </div>
                        <div>
                            <p className="mb-1 font-pixel text-[9px] tracking-widest text-neon-pink">
                                Zap the relay directly
                            </p>
                            <p className="text-cyan-100/70">
                                Zap the relay's pubkey from any client and put the note reference in
                                the zap comment. <code>nostr:nevent1...</code>, <code>note1...</code>{" "}
                                and a bare 64-character id all work.
                            </p>
                        </div>
                        <dl className="space-y-3">
                            <div>
                                <dt className="mb-1 text-cyan-300/50">Relay pubkey</dt>
                                <dd className="flex flex-wrap items-center gap-2">
                                    <code className="border-2 border-cyan-400/30 bg-void p-2 text-[10px] break-all
                                        text-cyan-200/80 select-all">
                                        {toNpub(RELAY_PUBKEY)}
                                    </code>
                                    <CopyButton value={toNpub(RELAY_PUBKEY)} />
                                </dd>
                            </div>
                            <div>
                                <dt className="mb-1 text-cyan-300/50">Relay URL</dt>
                                <dd className="flex flex-wrap items-center gap-2">
                                    <code className="border-2 border-cyan-400/30 bg-void p-2 text-[10px] break-all
                                        text-cyan-200/80 select-all">
                                        {RELAY_URL}
                                    </code>
                                    <CopyButton value={RELAY_URL} />
                                </dd>
                            </div>
                        </dl>
                    </div>
                </details>
            </div>
        </Modal>
    );
}
