import { useEffect, useRef } from "react";
import { RELAY_PUBKEY, RELAY_URL } from "../../config";
import { toNpub } from "../../lib/nostr";
import { CopyButton } from "../ui/CopyButton";

export const RANKING_SECTION = "how-ranking-works";

/** Shared by the help page and the promotion's contextual help panel. */
export function HelpContent({ section = "" }: { section?: string }) {
    const content = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!section) return;
        const frame = requestAnimationFrame(() => {
            const heading = Array.from(content.current?.querySelectorAll<HTMLElement>("h2[id]") ?? [])
                .find((element) => element.id === section);
            heading?.scrollIntoView({ block: "start" });
            heading?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [section]);

    return <div ref={content} className="promotion-typography space-y-8 text-sm leading-relaxed text-cyan-100/80">
        <nav aria-label="Help topics" className="flex flex-wrap gap-x-5 gap-y-1 text-neon-cyan">
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center" href={`#${RANKING_SECTION}`}>Ranking</a>
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center" href="#payments">Payments</a>
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center" href="#other-ways-to-promote">Promote from Nostr</a>
        </nav>
        <section className="space-y-4" aria-labelledby={RANKING_SECTION}>
            <h2 id={RANKING_SECTION} tabIndex={-1} className="promotion-section-title focus-pixel text-neon-pink">How ranking works</h2>
            <p>The main board shows positions 1 through 21. Other active paid notes appear in the waiting room, with Top, New and Hot views. Only sats paid for visibility count toward rank and Hot. Author support goes directly to the author; appearance fees are separate.</p>
            <p>Position presets estimate the total including your author share and any appearance fee. Selecting a position fixes the amount; changing the split updates estimates without changing your chosen amount. Positions may change before payment.</p>
            <p>Rank follows what each payment is worth today. Every payment loses half its ranking weight every 30 days. A boost adds fresh weight without refreshing earlier payments.</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-l-2 border-neon-cyan/40 pl-4">
                <dt>Paid today</dt><dd>1000 sats count as 1000</dd>
                <dt>30 days ago</dt><dd>1000 sats count as 500</dd>
                <dt>60 days ago</dt><dd>1000 sats count as 250</dd>
            </dl>
            <p>Each row shows the sats still counting today. Open that figure to see the total ever paid; the blocks show how much remains.</p>
            <code className="block overflow-x-auto border border-cyan-400/25 bg-void p-3 text-xs">score = sum of each payment x 0.5 ^ (its age / 30 days)</code>
            <p>Top follows current weight. New follows the first promotion, so a boost does not reset its date. Hot follows visibility sats paid in the last 24 hours.</p>
        </section>
        <section className="space-y-4" aria-labelledby="payments">
            <h2 id="payments" tabIndex={-1} className="promotion-section-title focus-pixel text-neon-pink">Payments and author support</h2>
            <p>Anyone can promote their own note or someone else's. No account or signer is needed to open, copy or scan an invoice. An optional NWC or browser wallet can pay recipient invoices in sequence. Connecting a wallet sends no payment.</p>
            <p>Visibility and author support have separate invoices and can succeed independently. A public author zap requires a Nostr signer and your explicit consent. Ordinary author support needs no signer.</p>
            <p>New campaigns default to 80% visibility and 20% author support. A confirmed missing Lightning address defaults a new campaign to visibility only. Boosts use the saved campaign split; older campaigns without a split default to visibility only.</p>
            <p>The first successful promotion fixes the campaign's public zap split. Later payers can adjust their own allocation without changing that public split. Author sats round down, with at least 1 sat reserved for visibility.</p>
            <p>Keep unfinished invoices in this browser tab. After returning from your wallet, Holoboard checks payment status. A lost response is not proof of failure: check your wallet before another attempt. Manual author confirmation is marked as reported by you until a payment proof is verified.</p>
            <p>For a confirmation DM, open Payment options, enable Send me a confirmation DM and enter an npub. Reply YES to that DM for one notification when the promotion expires. Reviving a promotion requires fresh notification consent.</p>
        </section>
        <section className="space-y-4" aria-labelledby="appearance-and-rules">
            <h2 id="appearance-and-rules" tabIndex={-1} className="promotion-section-title focus-pixel text-neon-pink">Appearance and promotion rules</h2>
            <p>Billboard appearance has a separate fee, shown before payment. Choose it when starting a promotion period. It stays fixed while the note is active, including during boosts. The preview shows appearance, not a guaranteed rank.</p>
            <p>Billboard text and images come from the original note. Appearance does not edit or republish that note. If appearance becomes unavailable when payment settles, its fee adds visibility weight instead.</p>
            <p>Payment does not guarantee a top 21 position. Spam, scams and illegal content may be removed without a refund. Paying again cannot restore a note removed by the operator.</p>
        </section>
        <section className="space-y-4" aria-labelledby="other-ways-to-promote">
            <h2 id="other-ways-to-promote" tabIndex={-1} className="promotion-section-title focus-pixel text-neon-pink">Other ways to promote</h2>
            <p><strong className="text-cyan-100">Mention Holoboard.</strong> From any Nostr client, tag the account below with the complete <code>promote</code> command and the original note reference. Holoboard replies with a promotional note; zap that reply to promote the original.</p>
            <p><strong className="text-cyan-100">Zap Holoboard directly.</strong> Put the note reference in the zap comment. <code>nostr:nevent1...</code>, <code>note1...</code> and a 64-character event ID work.</p>
            <p><strong className="text-cyan-100">Send a DM.</strong> Send <code>PROMOTE &lt;amount&gt; &lt;note&gt;</code> to receive an invoice in the conversation.</p>
            <dl className="space-y-4">
                <div><dt className="promotion-label mb-2 text-cyan-300/60">Holoboard pubkey</dt><dd className="space-y-2"><code className="block break-all border border-cyan-400/25 bg-void p-3 text-xs select-all">{toNpub(RELAY_PUBKEY)}</code><CopyButton value={toNpub(RELAY_PUBKEY)} label="Copy Holoboard pubkey" /></dd></div>
                <div><dt className="promotion-label mb-2 text-cyan-300/60">Relay URL</dt><dd className="flex flex-wrap items-center gap-3"><code className="break-all text-xs select-all">{RELAY_URL}</code><CopyButton value={RELAY_URL} label="Copy relay URL" /></dd></div>
            </dl>
            <a className="promotion-action focus-pixel inline-flex min-h-11 items-center text-neon-cyan" href="https://github.com/ptrio42/holoboard.space/blob/main/relay/README.md#promotion-through-nostr" target="_blank" rel="noopener noreferrer">Command reference &gt;</a>
        </section>
    </div>;
}
