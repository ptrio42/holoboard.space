import { useEffect, useState } from "react";
import { ZAP_PRESETS } from "../../config";
import { formatSats } from "../../lib/nostr";
import { amountToPassWeight, type RankingTarget } from "../../lib/ranking";
import { PixelButton } from "../ui/PixelButton";

interface PromotionAmountPickerProps {
    amount: number;
    currentWeight?: number;
    max?: number;
    onChange: (amount: number) => void;
    targets: RankingTarget[];
}

const integerAmount = (value: number, max?: number): number => {
    if (!Number.isFinite(value)) return 1;
    return Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value)));
};

export function PromotionAmountPicker({ amount, currentWeight = 0, max, onChange, targets }: PromotionAmountPickerProps) {
    const [selectedRank, setSelectedRank] = useState<number | null>(null);

    // Keep an explicitly selected goal current when a preview reveals existing
    // weight or the board refreshes while the dialog is open.
    useEffect(() => {
        if (selectedRank === null) return;
        const target = targets.find((candidate) => candidate.rank === selectedRank);
        if (!target) return;
        const targetAmount = amountToPassWeight(target.weight, currentWeight);
        if (typeof max !== "number" || targetAmount <= max) onChange(targetAmount);
    }, [currentWeight, max, onChange, selectedRank, targets]);

    return (
        <fieldset className="space-y-3">
            <legend className="font-pixel text-[10px] tracking-widest text-neon-pink">
                {targets.length > 0 ? "Target position (sats)" : "How many sats"}
            </legend>
            <div className="flex flex-wrap items-center gap-2">
                {targets.length > 0 ? targets.map((target) => {
                    const targetAmount = amountToPassWeight(target.weight, currentWeight);
                    const unavailable = typeof max === "number" && targetAmount > max;
                    return (
                        <PixelButton
                            key={target.rank}
                            size="sm"
                            variant={selectedRank === target.rank ? "accent" : "ghost"}
                            aria-pressed={selectedRank === target.rank}
                            aria-label={`Reach rank ${target.rank}, estimated ${targetAmount} sats`}
                            disabled={unavailable}
                            title={unavailable ? `This requires more than the ${formatSats(max)} sats invoice limit.` : undefined}
                            onClick={() => {
                                setSelectedRank(target.rank);
                                onChange(targetAmount);
                            }}
                        >
                            #{target.rank} · {formatSats(targetAmount)}
                        </PixelButton>
                    );
                }) : ZAP_PRESETS.map((preset) => (
                    <PixelButton
                        key={preset}
                        size="sm"
                        variant={selectedRank === null && amount === preset ? "accent" : "ghost"}
                        aria-pressed={selectedRank === null && amount === preset}
                        onClick={() => {
                            setSelectedRank(null);
                            onChange(preset);
                        }}
                    >
                        {formatSats(preset)}
                    </PixelButton>
                ))}
                <label className="flex items-center gap-2">
                    <span className="sr-only">Custom amount in sats</span>
                    <input
                        type="number"
                        min={1}
                        max={max}
                        step={1}
                        value={amount}
                        onChange={(event) => {
                            setSelectedRank(null);
                            onChange(integerAmount(Number(event.target.value), max));
                        }}
                        className="focus-pixel w-28 border-2 border-cyan-400/40 bg-void px-2 py-2
                            text-right text-cyan-100"
                    />
                    <span className="font-pixel text-[9px] text-cyan-300/60">sats</span>
                </label>
            </div>
            {targets.length > 0 && (
                <p className="text-[11px] leading-relaxed text-cyan-100/50">
                    Estimated from the current board. Positions may change before payment.
                </p>
            )}
        </fieldset>
    );
}
