import { useState } from "react";
import { pubkeyHue, toNpub } from "../../lib/nostr";

interface AvatarProps {
    pubkey: string;
    src?: string;
    name?: string;
    size?: number;
}

/**
 * Square on purpose: round avatars fight the pixel grid. Falls back to a solid
 * block keyed off the pubkey, so an author with no picture is still telling
 * apart from the next one.
 */
export function Avatar({ pubkey, src, name, size = 32 }: AvatarProps) {
    // Remember which src failed rather than a bare flag, so a profile that
    // arrives late is given its own chance to load.
    const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
    const broken = !!src && brokenSrc === src;

    const trimmed = name?.trim();
    // Named authors get their own initial; anonymous ones get the first
    // character of the npub body, since every npub starts "npub1".
    const initial = (trimmed?.[0] ?? toNpub(pubkey)[5] ?? "?").toUpperCase();
    const box = { width: size, height: size };

    if (!src || broken) {
        return (
            <span
                aria-hidden="true"
                className="flex shrink-0 items-center justify-center border-2 border-cyan-400/40 font-pixel"
                style={{
                    ...box,
                    backgroundColor: `hsl(${pubkeyHue(pubkey)} 70% 22%)`,
                    color: `hsl(${pubkeyHue(pubkey)} 90% 72%)`,
                    fontSize: Math.max(8, Math.round(size * 0.4)),
                }}
            >
                {initial}
            </span>
        );
    }

    return (
        <img
            src={src}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            onError={() => setBrokenSrc(src)}
            className="shrink-0 border-2 border-cyan-400/40 object-cover"
            style={box}
        />
    );
}
