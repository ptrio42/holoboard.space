/**
 * Runtime configuration.
 *
 * Everything here can be overridden with a `VITE_`-prefixed variable in
 * `.env.local`; the defaults are the production holoboard deployment, so a
 * fresh clone runs against the real board with no setup.
 */

const trimmed = (value: string | undefined, fallback: string): string => {
    const candidate = value?.trim();
    return candidate ? candidate : fallback;
};

/** The holoboard relay. It serves the ranked board and nothing else. */
export const RELAY_URL = trimmed(
    import.meta.env.VITE_RELAY_URL,
    "wss://relay.holoboard.space",
);

/** The relay's own identity. Promotions are mentions of, and zaps to, this key. */
export const RELAY_PUBKEY = trimmed(
    import.meta.env.VITE_RELAY_PUBKEY,
    "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643",
);

/**
 * Public relays. The holoboard relay only accepts notes that were already paid
 * for, so mentions, its replies, profiles and zap receipts all travel over
 * these instead. Keep them in sync with the relay's own FETCH_RELAYS.
 */
export const PUBLIC_RELAYS = trimmed(
    import.meta.env.VITE_PUBLIC_RELAYS,
    "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band,wss://nostr.wine",
)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

/**
 * Where the relay serves its payment ledger.
 *
 * Derived from RELAY_URL rather than configured separately: it is the same host
 * over plain HTTP, and two URLs that have to be kept in step is one more thing
 * to get wrong. Override only if the ledger ever moves somewhere else.
 */
export const SATS_ENDPOINT = trimmed(
    import.meta.env.VITE_SATS_ENDPOINT,
    `${RELAY_URL.replace(/^ws/, "http").replace(/\/+$/, "")}/api/board`,
);

/** How many ranked notes to ask the board for. */
export const BOARD_LIMIT = Number(import.meta.env.VITE_BOARD_LIMIT ?? 50);

/** Amounts offered in the zap step, in sats. */
export const ZAP_PRESETS = [21, 210, 2_100, 21_000];
