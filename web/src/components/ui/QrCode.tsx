import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QrSymbol } from "../../lib/qrCode";

interface QrCodeProps {
    value: string;
    /** Rendered edge length in CSS pixels. */
    size?: number;
    label: string;
}

/**
 * Branded codes display the verified pixel raster. Plain codes retain their
 * vector renderer. Generation and decoding load on demand.
 */
export function QrCode({ value, size = 220, label }: QrCodeProps) {
    const container = useRef<HTMLDivElement>(null);
    const [displaySize, setDisplaySize] = useState(size);
    const [symbol, setSymbol] = useState<(QrSymbol & { value: string; size: number }) | null>(null);
    const [failed, setFailed] = useState(false);

    useLayoutEffect(() => {
        const node = container.current!;
        const measure = () => setDisplaySize(Math.max(1, Math.min(size, Math.floor(node.getBoundingClientRect().width))));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [size]);

    useEffect(() => {
        let cancelled = false;
        setSymbol(null);
        setFailed(false);

        import("../../lib/qrCode")
            .then(({ createQrSymbol }) => createQrSymbol(value, displaySize))
            .then((result) => {
                if (cancelled) return;
                setSymbol({ ...result, value, size: displaySize });
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });

        return () => {
            cancelled = true;
        };
    }, [value, displaySize]);

    const content = () => {
        if (failed) return null;

        if (!symbol || symbol.value !== value || symbol.size !== displaySize) {
            return (
                <div
                    className="animate-pulse bg-cyan-400/10"
                    style={{ width: displaySize, height: displaySize }}
                    aria-hidden="true"
                />
            );
        }

        const { matrix, image } = symbol;
        if (image) return <img src={image} width={displaySize} height={displaySize} alt={label}
            data-branded="true" style={{ imageRendering: "pixelated" }} />;
        const count = matrix.length;
        // DENSO's QR guidance requires four clear modules: https://www.qrcode.com/en/howto/code.html
        const quiet = 4;
        const span = count + quiet * 2;

        return (
            <svg
                role="img"
                aria-label={label}
                data-branded="false"
                viewBox={`0 0 ${span} ${span}`}
                width={displaySize}
                height={displaySize}
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
    };
    return <div ref={container} style={{ width: size, maxWidth: "100%" }}>{content()}</div>;
}
