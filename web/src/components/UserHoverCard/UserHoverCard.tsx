interface Props {
    user: any;
}

export const UserHoverCard = ({ user }: Props) => {
    return (
        <div className="absolute top-full left-0 z-[9999] mt-2 w-128 rounded-xl bg-white shadow-lg border p-4">
            <div className="flex gap-3">
                <img
                    src={user.picture}
                    alt={user.name}
                    className="w-12 h-12 rounded-full"
                />

                <div>
                    <div className="font-semibold">
                        {user.displayName || user.name || 'Anonymous'}
                    </div>
                    <div className="text-sm text-gray-500">
                        {user.nip05 && <p>NIP-05: {user.nip05}</p>}
                    </div>
                </div>
            </div>

            <p className="mt-3 text-sm text-gray-700">
                {user.about}
            </p>

            {/*<div className="mt-3 flex gap-4 text-sm">*/}
        {/*<span>*/}
          {/*<strong>{user.followersCount ?? 0}</strong> followers*/}
        {/*</span>*/}
                {/*<span>*/}
          {/*<strong>{user.postsCount ?? 0}</strong> posts*/}
        {/*</span>*/}
            {/*</div>*/}

            {/*<button className="mt-4 w-full rounded-full bg-black text-white py-2 text-sm hover:bg-gray-800">*/}
                {/*Follow*/}
            {/*</button>*/}
        </div>
    );
};
