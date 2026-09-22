export interface RankingTarget {
    rank: number;
    weight: number;
}

/** Fresh sats add one-for-one to a note's current ranking weight. */
export function amountToPassWeight(targetWeight: number, currentWeight = 0): number {
    const target = Number.isFinite(targetWeight) ? Math.max(0, Math.floor(targetWeight)) : 0;
    const current = Number.isFinite(currentWeight) ? Math.max(0, Math.floor(currentWeight)) : 0;
    return Math.max(1, target - current + 1);
}
