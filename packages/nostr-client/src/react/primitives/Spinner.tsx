/** Four blocks lighting in sequence. No rotation, nothing to smooth out. */
export function Spinner({ label = "Loading" }: { label?: string }) {
    return (
        <span role="status" aria-label={label} className="inline-flex shrink-0 gap-1">
            {[0, 1, 2, 3].map((i) => (
                <span
                    key={i}
                    className="block h-2 w-2 bg-neon-cyan animate-pixel-pulse"
                    style={{ animationDelay: `${i * 0.14}s` }}
                />
            ))}
        </span>
    );
}
