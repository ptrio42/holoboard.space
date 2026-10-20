import { isAnonymousPost } from "../../lib/boardComposer";
import { UserProfileInline } from "./UserProfileInline";
import { Avatar } from "../ui/Avatar";
import { ProfileLink } from "../ui/ProfileLink";

export function NoteAuthor({ event, hints, size = "compact" }: {
    event: { pubkey: string; tags: string[][] }; hints?: string[]; size?: "compact" | "sm" | "md";
}) {
    if (!isAnonymousPost(event)) return <UserProfileInline pubkey={event.pubkey} hints={hints} size={size} />;
    return <ProfileLink pubkey={event.pubkey} hints={hints} className="board-author focus-pixel inline-flex max-w-full items-center gap-2" title={`Anonymous, public key ${event.pubkey}`}>
        <Avatar pubkey={event.pubkey} name="Anonymous" size={size === "md" ? 36 : size === "sm" ? 28 : 24} />
        <span className="font-pixel text-[10px] text-cyan-200">Anonymous</span>
    </ProfileLink>;
}
