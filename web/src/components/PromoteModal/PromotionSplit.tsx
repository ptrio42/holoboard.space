import type { CSSProperties, ReactNode } from "react";
import { useProfileValue } from "@nostr-dev-kit/react";
import { Avatar } from "../ui/Avatar";
import { njumpUrl, shortNpub } from "../../lib/nostr";

interface Props {
    author?: string;
    authorShare: number;
    promotionSats: number;
    authorSats: number;
    disabled?: boolean;
    onChange: (share: number) => void;
    children?: ReactNode;
}

export function PromotionSplit({ author, authorShare, promotionSats, authorSats, disabled, onChange, children }: Props) {
    const profile = useProfileValue(author);
    const name = profile?.displayName?.trim() || profile?.name?.trim() || (author ? shortNpub(author) : "Author");
    const visibilityShare = 100 - authorShare;
    // Match the painted boundary to the native 16px thumb, including its end offsets.
    const position = (visibilityShare - 1) / 99;
    return <section aria-label="Payment split" className="space-y-1 border-t border-cyan-400/20 pt-2">
        <div className="grid grid-cols-2 gap-3">
            <div aria-label="Holoboard visibility" className="min-w-0 space-y-1 text-neon-cyan">
                <span className="promotion-label inline-flex min-h-6 items-center">Holoboard</span>
                <p><strong>{promotionSats} sats</strong> <span className="text-xs text-cyan-100/60">{visibilityShare}%</span></p>
            </div>
            <div aria-label="Author support" className="min-w-0 space-y-1 text-right text-neon-pink">
                {author ? <a href={njumpUrl(author)} target="_blank" rel="noopener noreferrer" title={name} aria-label={`Author: ${name}`}
                    className="promotion-label focus-pixel inline-flex min-h-6 items-center gap-2">
                    Author <Avatar pubkey={author} src={profile?.picture} name={name} size={20} />
                </a> : <span className="promotion-label inline-flex min-h-6 items-center">Author</span>}
                <p><strong>{authorSats} sats</strong> <span className="text-xs text-cyan-100/60">{authorShare}%</span></p>
            </div>
        </div>
        <input aria-label="Holoboard share in percent" aria-valuetext={`Holoboard ${visibilityShare}%, ${promotionSats} sats; author ${authorShare}%, ${authorSats} sats`}
            type="range" min={1} max={100} step={1} value={visibilityShare} disabled={disabled}
            className="allocation-slider focus-pixel w-full"
            style={{ "--split-position": authorShare === 0 ? "100%" : `calc(${position * 100}% + ${8 - 16 * position}px)` } as CSSProperties}
            onChange={(event) => onChange(100 - Number(event.target.value))} />
        {children}
    </section>;
}
