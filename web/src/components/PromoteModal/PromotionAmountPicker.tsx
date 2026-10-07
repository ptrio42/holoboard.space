import { useId } from "react";
import { ZAP_PRESETS } from "../../config";
import { formatSats } from "../../lib/nostr";
import { amountToPassWeight, type RankingTarget } from "../../lib/ranking";
import { PixelButton } from "../ui/PixelButton";

export interface AmountSelection {
    mode: "amount" | "position";
    rank: number | null;
    custom: boolean;
}
interface PromotionAmountPickerProps {
    amount: string; validAmount: boolean; currentWeight?: number; max?: number; appearanceFee?: number; onChange: (amount: string) => void;
    targets: RankingTarget[]; totalForPromotion?: (amount: number) => number;
    selection: AmountSelection; onSelectionChange: (selection: AmountSelection) => void;
    disabled?: boolean;
}
export function PromotionAmountPicker({ amount, validAmount, currentWeight = 0, max = 10000000, appearanceFee = 0, onChange, targets, totalForPromotion = (value) => value, selection, onSelectionChange, disabled = false }: PromotionAmountPickerProps) {
    const errorId = useId();
    const selectedAmount = validAmount ? Number(amount) : null;
    const positions = targets.filter((target) => target.rank === 21 || target.rank <= 3).sort((a, b) => b.rank - a.rank);
    const targetButton = (target: RankingTarget) => {
        const needed = totalForPromotion(amountToPassWeight(target.weight, currentWeight));
        return <PixelButton size="sm" key={target.rank} className="amount-preset min-h-12" variant={selection.rank === target.rank && selectedAmount === needed ? "accent" : "ghost"}
            aria-pressed={selection.rank === target.rank && selectedAmount === needed} aria-label={`Reach rank ${target.rank}, estimated total ${needed + appearanceFee} sats`}
            disabled={disabled || needed > max} onClick={() => { onSelectionChange({ ...selection, rank: target.rank }); onChange(String(needed)); }}>
            <span className="flex flex-col items-center gap-1"><span>#{target.rank}</span><span className="font-body text-xs tracking-normal text-cyan-200/70">~{formatSats(needed + appearanceFee)}</span></span>
        </PixelButton>;
    };
    return <fieldset className="promotion-amount-picker min-w-0 space-y-2" disabled={disabled}>
        <legend className="promotion-label mb-1 text-cyan-200/70">Amount in sats</legend>
        <div role="group" aria-label="Choose by amount or target position" className="grid grid-cols-2 gap-2">
            <PixelButton size="sm" variant={selection.mode === "amount" ? "accent" : "ghost"} aria-pressed={selection.mode === "amount"}
                onClick={() => onSelectionChange({ ...selection, mode: "amount" })}>Amount</PixelButton>
            <PixelButton size="sm" variant={selection.mode === "position" ? "accent" : "ghost"} aria-pressed={selection.mode === "position"} aria-label="Target position"
                onClick={() => onSelectionChange({ ...selection, mode: "position" })}>Position</PixelButton>
        </div>
        <div className="space-y-2">
            <div className="promotion-presets grid min-h-[50px] grid-cols-[repeat(4,minmax(0,1fr))_4rem] gap-1 sm:gap-2">
                {selection.mode === "amount" ? ZAP_PRESETS.map((preset) => <PixelButton key={preset} size="sm" className="amount-preset min-h-12"
                    variant={selectedAmount === preset ? "accent" : "ghost"}
                    aria-pressed={selectedAmount === preset} onClick={() => { onSelectionChange({ mode: "amount", rank: null, custom: false }); onChange(String(preset)); }}>{formatSats(preset)}</PixelButton>) : positions.length ? positions.map(targetButton) :
                    <p className="col-span-4 flex min-h-12 items-center text-xs text-cyan-100/70">No higher target positions available.</p>}
                <button type="button" className="promotion-action focus-pixel col-start-5 min-h-11 text-cyan-200/75" aria-expanded={selection.custom} onClick={() => onSelectionChange({ ...selection, custom: !selection.custom })}>Custom</button>
            </div>
            {selection.custom && <label className="flex items-center gap-3 text-sm text-cyan-200/70">
                <input aria-label="Custom total in sats" type="text" inputMode="numeric" pattern="[0-9]*" value={amount} autoFocus
                    aria-invalid={!validAmount} aria-describedby={!validAmount && amount !== "" ? errorId : undefined}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => { onSelectionChange({ ...selection, rank: null }); onChange(event.target.value); }}
                    className="focus-pixel min-h-11 w-full border border-cyan-400/40 bg-void px-3 py-2 text-right text-base text-cyan-100" />sats
            </label>}
            {!validAmount && amount !== "" && <p id={errorId} className="text-xs text-neon-gold">Enter a whole amount from 1 to {max.toLocaleString("en-US")} sats.</p>}
        </div>
    </fieldset>;
}
