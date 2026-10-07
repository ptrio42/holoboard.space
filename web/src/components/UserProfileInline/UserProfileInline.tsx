import { useProfileValue } from "../../hooks/useProfile";
import { ProfileLink } from "../ui/ProfileLink";
import { Avatar } from "../ui/Avatar";
import { shortNpub } from "../../lib/nostr";

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
        <ProfileLink
            pubkey={pubkey}
            className="focus-pixel group inline-flex max-w-full items-center gap-2 no-underline"
        >
            <Avatar pubkey={pubkey} src={profile?.picture} name={name} size={px} />
            <span className="min-w-0 truncate font-pixel text-[10px] tracking-wide text-cyan-200
                group-hover:text-neon-pink @xl/row:text-[11px]">
                {name}
            </span>

        </ProfileLink>
    );
};
