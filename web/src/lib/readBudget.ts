let active = 0;
const waiting: (() => void)[] = [];

export async function withReadBudget<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    if (active >= 4) {
        if (waiting.length >= 64) throw new Error("Nostr read queue full");
        await new Promise<void>((resolve, reject) => {
            const start = () => { signal?.removeEventListener("abort", cancel); active++; resolve(); };
            const cancel = () => { const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1); reject(signal?.reason); };
            waiting.push(start); signal?.addEventListener("abort", cancel, { once: true });
        });
    } else active++;
    try {
        if (signal?.aborted) throw signal.reason;
        return await run();
    } finally { active--; waiting.shift()?.(); }
}
