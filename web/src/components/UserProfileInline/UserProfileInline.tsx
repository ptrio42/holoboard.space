import { useState } from "react";
// import { UserHoverCard } from "./UserHoverCard";
import { useProfileValue } from "@nostr-dev-kit/react";
import {UserHoverCard} from "../UserHoverCard/UserHoverCard";

export interface User {
    id: string;
    username: string;
    fullName?: string;
    avatarUrl: string;
    bio?: string;
    followersCount?: number;
    postsCount?: number;
    isVerified?: boolean;
}


interface Props {
    pubkey: string;
    size?: "sm" | "md";
    showHoverCard?: boolean;
}

export const UserProfileInline = ({
                                      pubkey,
                                      size = "sm",
                                      showHoverCard = true,
                                  }: Props) => {
    const [isHovered, setIsHovered] = useState(false);
    const profile = useProfileValue(pubkey);

    if (!profile) {
        return <div>Loading profile for {pubkey}...</div>;
    }

    return (
        <div
            className="relative inline-flex items-center gap-2"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <img
                src={profile.picture}
                alt={profile.name}
                className={`rounded-full object-cover ${
                    size === "sm" ? "w-8 h-8" : "w-10 h-10"
                    }`}
            />

            <span className="font-medium text-sm hover:underline cursor-pointer">
        {profile.displayName || profile.name || 'Anonymous'}
                {/*{user.isVerified && (*/}
                    {/*<span className="ml-1 text-blue-500">✔</span>*/}
                {/*)}*/}
      </span>

            {showHoverCard && isHovered && (
                <UserHoverCard user={profile} />
            )}
        </div>
    );
};
