import { useState } from "react";
import { ZAP_PRESETS } from "../../config";
import { formatSats } from "../../lib/nostr";
import { amountToPassWeight, type RankingTarget } from "../../lib/ranking";
import { PixelButton } from "../ui/PixelButton";

interface PromotionAmountPickerProps {
    amount: number; currentWeight?: number; max?: number; onChange: (amount: number) => void;
    targets: RankingTarget[]; totalForPromotion?: (amount: number) => number;
    showHigherTargets?: boolean; disabled?: boolean;
}
export function PromotionAmountPicker({ amount, currentWeight = 0, max = 10000000, onChange, targets, totalForPromotion = (value) => value, showHigherTargets = false, disabled = false }: PromotionAmountPickerProps) {
    const [customOpen, setCustomOpen] = useState(() => !ZAP_PRESETS.includes(amount));
    const [selectedRank, setSelectedRank] = useState<number | null>(null);
    const targetButton = (target: RankingTarget) => {
        const needed = totalForPromotion(amountToPassWeight(target.weight, currentWeight));
        return <button type="button" key={target.rank} className="promotion-action focus-pixel min-h-11 text-left text-neon-cyan disabled:opacity-40"
            aria-pressed={selectedRank === target.rank && amount === needed} aria-label={`Reach rank ${target.rank}, estimated total ${needed} sats`}
            disabled={disabled || needed > max} onClick={() => { setSelectedRank(target.rank); onChange(needed); }}>
            {target.rank === 21 ? "Top 21" : `#${target.rank}`} <span className="font-body text-sm tracking-normal text-cyan-200/70">~{formatSats(needed)} sats</span>
        </button>;
    };
    return <fieldset className="min-w-0 space-y-2" disabled={disabled}>
        <legend className="promotion-label mb-2 text-cyan-200/70">Amount in sats</legend>
        <div className="grid grid-cols-4 gap-2 min-[360px]:grid-cols-5">
            {ZAP_PRESETS.map((preset) => <PixelButton key={preset} size="sm" className="amount-preset min-h-11"
                variant={selectedRank === null && amount === preset ? "accent" : "ghost"}
                aria-pressed={selectedRank === null && amount === preset} onClick={() => { setSelectedRank(null); setCustomOpen(false); onChange(preset); }}>{formatSats(preset)}</PixelButton>)}
            <button type="button" className="promotion-action focus-pixel col-span-4 min-h-11 text-cyan-200/75 min-[360px]:col-span-1" aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>Custom</button>
        </div>
        {customOpen && <label className="flex items-center gap-3 text-sm text-cyan-200/70">
            <input aria-label="Custom total in sats" type="number" min={1} max={max} step={1} value={amount}
                onChange={(event) => { setSelectedRank(null); onChange(Math.min(max, Math.max(1, Math.floor(Number(event.target.value)||1)))); }}
                className="focus-pixel min-h-11 w-full border border-cyan-400/40 bg-void px-3 py-2 text-right text-base text-cyan-100" />sats
        </label>}
        <div className="flex flex-wrap gap-x-5">{targets.filter((target) => target.rank === 21 || (showHigherTargets && target.rank <= 3)).map(targetButton)}</div>
        {showHigherTargets && targets.length > 0 && <p className="text-xs leading-relaxed text-cyan-100/55">Estimates include your author share. Positions can change before payment; your chosen amount stays fixed.</p>}
    </fieldset>;
}
