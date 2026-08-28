import type { CSSProperties, ReactNode } from "react";

interface PixelPanelProps {
    children: ReactNode;
    /** CSS colour for the notched frame. Rank tiers pass their own. */
    accent?: string;
    /** CSS colour for the outer glow. Omit for a flat frame. */
    glow?: string;
    className?: string;
    style?: CSSProperties;
}

/**
 * A notched frame around a dark panel. The border is a real element rather than
 * a `border` property, because `clip-path` cuts borders off at the corners.
 */
export function PixelPanel({ children, accent = "#22d3ee", glow, className = "", style }: PixelPanelProps) {
    return (
        <div
            className="pixel-frame p-[3px] transition-shadow duration-200"
            style={{ backgroundColor: accent, boxShadow: glow ? `0 0 24px ${glow}` : undefined, ...style }}
        >
            <div className={`pixel-frame bg-panel/92 h-full ${className}`}>{children}</div>
        </div>
    );
}
