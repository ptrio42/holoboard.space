import type { DiscoveryMetadata } from "../../lib/campaigns";
import { formatSats } from "../../lib/nostr";

export function DiscoveryDetails({ discovery, unranked }: { discovery: DiscoveryMetadata; unranked: boolean }) {
    const amount = `${formatSats(discovery.rewardSats)} sats`;
    const reward = discovery.rewardStatus === "paid" ? `Author reward: ${amount} paid`
        : discovery.rewardStatus === "unavailable" ? "Author reward unavailable"
        : discovery.rewardStatus === "failed" ? "Author reward not paid"
        : discovery.rewardStatus === "uncertain" ? `Author reward: ${amount}, confirmation pending`
        : `Author reward: ${amount} pending`;
    return <aside className="mb-3 space-y-1 border-l-2 border-neon-cyan/35 pl-3 [overflow-wrap:anywhere]" aria-label="Holoboard discovery">
        <p className="font-pixel text-[10px] leading-relaxed text-neon-cyan">Discovered by Holoboard</p>
        <p className="font-mono text-xs leading-relaxed text-cyan-100/80">{discovery.reason}</p>
        <p className={`font-mono text-xs leading-relaxed ${discovery.rewardStatus === "paid" ? "text-neon-gold" : "text-cyan-200/70"}`}>{reward}</p>
        {unranked && <p className="font-mono text-xs leading-relaxed text-cyan-200/60">Discovery until <time dateTime={new Date(discovery.expiresAt * 1000).toISOString()}>{new Date(discovery.expiresAt * 1000).toLocaleDateString()}</time>. Promote to add ranking weight.</p>}
    </aside>;
}
