import { useEffect, useState } from "react";

interface QrCodeProps {
    value: string;
    /** Rendered edge length in CSS pixels. */
    size?: number;
    label: string;
}

/**
 * Drawn as SVG rects rather than a canvas: it stays crisp at any size, and
 * square modules are the one thing on this page that were always pixel art.
 * The generator is loaded on demand so it never lands in the initial bundle.
 */
export function QrCode({ value, size = 220, label }: QrCodeProps) {
    const [matrix, setMatrix] = useState<boolean[][] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setMatrix(null);
        setFailed(false);

        import("qrcode-generator")
            .then(({ default: qrcode }) => {
                if (cancelled) return;
                const qr = qrcode(0, "M");
                // Bolt11 is case-insensitive, and uppercase lets the encoder use
                // alphanumeric mode, which cuts the module count noticeably.
                qr.addData(value.toUpperCase());
                qr.make();
                const count = qr.getModuleCount();
                setMatrix(
                    Array.from({ length: count }, (_, row) =>
                        Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
                    ),
                );
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });

        return () => {
            cancelled = true;
        };
    }, [value]);

    if (failed) return null;

    if (!matrix) {
        return (
            <div
                className="animate-pulse bg-cyan-400/10"
                style={{ width: size, height: size }}
                aria-hidden="true"
            />
        );
    }

    const count = matrix.length;
    const quiet = 2;
    const span = count + quiet * 2;

    return (
        <svg
            role="img"
            aria-label={label}
            viewBox={`0 0 ${span} ${span}`}
            width={size}
            height={size}
            shapeRendering="crispEdges"
            style={{ imageRendering: "pixelated" }}
        >
            <rect width={span} height={span} fill="#e0fbff" />
            {matrix.map((row, y) =>
                row.map((dark, x) =>
                    dark ? (
                        <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#05010d" />
                    ) : null,
                ),
            )}
        </svg>
    );
}
