import { useProfileValue } from "../../hooks/useProfile";
import { ProfileLink } from "../ui/ProfileLink";
import { Avatar } from "../ui/Avatar";
import { shortNpub } from "../../lib/nostr";

interface Props {
    pubkey: string;
    hints?: string[];
    size?: "compact" | "sm" | "md";
}

/**
 * An author, always renderable. A pubkey alone is enough to draw a name and a
 * colour, so there is no loading state to flash: the npub shows first and the
 * profile fills in over it when it arrives.
 */
export const UserProfileInline = ({ pubkey, hints = [], size = "sm" }: Props) => {
    const profile = useProfileValue(pubkey, hints);
    const name = profile?.displayName?.trim() || profile?.name?.trim() || shortNpub(pubkey);
    const px = size === "compact" ? 24 : size === "sm" ? 28 : 36;

    return (
        <ProfileLink
            pubkey={pubkey} hints={hints}
            className={`focus-pixel group inline-flex max-w-full items-center gap-2 no-underline ${size === "compact" ? "board-author" : ""}`}
        >
            <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={px} />
            <span className={`min-w-0 truncate font-pixel text-[10px] tracking-wide text-cyan-200
                group-hover:text-neon-pink ${size === "compact" ? "" : "@xl/row:text-[11px]"}`}>
                {name}
            </span>

        </ProfileLink>
    );
};
