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
 * these instead.
 *
 * These have to be relays that accept WRITES from any pubkey, which is not the
 * same list as one for reading. The original list was inherited from the
 * relay's FETCH_RELAYS and three of its four entries refused to be written to:
 * nostr.wine charges an 18,888 sat admission, relay.nostr.band is a search
 * aggregator that serves no NIP-11 at all, and damus.io was answering 503. That
 * left one relay, and publishing a mention failed with "0 published, 1 required".
 *
 * Keep this in step with FETCH_RELAYS in relay/fly.toml. If the frontend
 * publishes a mention somewhere the relay is not listening, the mention is
 * simply never seen and nothing says so.
 */
export const PUBLIC_RELAYS = trimmed(
    import.meta.env.VITE_PUBLIC_RELAYS,
    "wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net,wss://nostr.mom,wss://offchain.pub",
)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

/**
 * The Holoboard HTTP API origin. By default it shares the relay's host.
 * A separate origin allows a local backend with external Nostr relays.
 */
export const RELAY_HTTP = trimmed(
    import.meta.env.VITE_API_URL,
    RELAY_URL.replace(/^ws/, "http"),
).replace(/\/+$/, "");

/**
 * Where the relay serves its payment ledger.
 *
 * Derived from the API origin, so all HTTP requests use the same backend.
 * Override only when the ledger is served separately.
 */
export const SATS_ENDPOINT = trimmed(
    import.meta.env.VITE_SATS_ENDPOINT,
    `${RELAY_HTTP}/api/board`,
);

/** Amounts offered in the zap step, in sats. */
export const ZAP_PRESETS = [21, 210, 2_100, 21_000];

/** NIP-22 comment. Ranked alongside plain notes; see the board subscription. */
export const KIND_COMMENT = 1111;
