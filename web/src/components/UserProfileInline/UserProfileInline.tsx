import { useProfileValue } from "@nostr-dev-kit/react";
import { Avatar } from "../ui/Avatar";
import { njumpUrl, shortNpub } from "../../lib/nostr";

interface Props {
    pubkey: string;
    size?: "sm" | "md";
}

/**
 * An author, always renderable. A pubkey alone is enough to draw a name and a
 * colour, so there is no loading state to flash: the npub shows first and the
 * profile fills in over it when it arrives.
 */
export const UserProfileInline = ({ pubkey, size = "sm" }: Props) => {
    const profile = useProfileValue(pubkey);
    const name = profile?.displayName?.trim() || profile?.name?.trim() || shortNpub(pubkey);
    const px = size === "sm" ? 28 : 36;

    return (
        <a
            href={njumpUrl(pubkey)}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-pixel group inline-flex max-w-full items-center gap-2 no-underline"
        >
            <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={px} />
            <span className="min-w-0 truncate font-pixel text-[10px] tracking-wide text-cyan-200
                group-hover:text-neon-pink sm:text-[11px]">
                {name}
            </span>
            {profile?.nip05 && (
                <span aria-label="Has a verified nostr address" title={profile.nip05}
                    className="font-pixel text-[9px] text-neon-cyan/70">
                    +
                </span>
            )}
        </a>
    );
};
