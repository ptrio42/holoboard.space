import { useEffect, useMemo, useState } from "react";
import { NDKKind, NDKSubscriptionCacheUsage } from "@nostr-dev-kit/ndk";
import { useSubscribe } from "@nostr-dev-kit/react";
import { BoardRow } from "../components/BoardRow/BoardRow";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
import { PixelButton } from "../components/ui/PixelButton";
import { PixelPanel } from "../components/ui/PixelPanel";
import { useRelayStatus } from "../hooks/useRelayStatus";
import { useSatsMap } from "../hooks/useSatsMap";
import { BOARD_LIMIT, RELAY_URL, SATS_ENDPOINT } from "../config";

export default function Billboard() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const { status: relayStatus, retry: retryRelay } = useRelayStatus(RELAY_URL);
    const { sats, ranks, refresh: refreshSats } = useSatsMap(SATS_ENDPOINT);

    /*
     * The relay does the ranking and returns the board already ordered, so the
     * only correct thing to do here is render it in the order it arrives.
     *
     * The three flags below are what keep that true. NDK fans every event it
     * sees out to every subscription whose filter matches, so without
     * `exclusiveRelay` a kind:1 pulled from a public relay for the promotion
     * flow lands on the board with a rank nobody paid for, and without
     * `skipOptimisticPublishEvent` so does the mention this app publishes
     * itself. ONLY_RELAY covers the third route: cached events come back in
     * whatever order IndexedDB feels like, which reshuffles the ranking.
     */
    const { events, eose } = useSubscribe(
        [{ kinds: [NDKKind.Text], limit: BOARD_LIMIT }],
        {
            subId: "board",
            relayUrls: [RELAY_URL],
            exclusiveRelay: true,
            skipOptimisticPublishEvent: true,
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            dontSaveToCache: true,
            closeOnEose: false,
        },
    );

    /*
     * The relay serves the board already ranked, so arrival order is right on
     * first load. It stops being right the moment somebody pays: the relay now
     * broadcasts the promoted note to open subscriptions, but a broadcast
     * arrives at the end of the stream regardless of where it belongs, and a
     * note that merely gained sats does not arrive again at all.
     *
     * So order by the rank the ledger reports, falling back to arrival order
     * for anything the ledger has not caught up with yet.
     */
    const ordered = useMemo(() => {
        if (ranks.size === 0) return events;
        const arrival = new Map(events.map((event, index) => [event.id, index]));
        return [...events].sort((a, b) => {
            const ra = ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const rb = ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            if (ra !== rb) return ra - rb;
            return (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0);
        });
    }, [events, ranks]);

    // A note that just arrived is not in the ledger yet, and waiting out the
    // poll would leave it sitting at the bottom with no sats beside it.
    useEffect(() => {
        if (events.length > 0) refreshSats();
    }, [events.length, refreshSats]);

    const isOffline = relayStatus === "offline";
    const isLoading = !isOffline && !eose && events.length === 0;
    const isEmpty = !isOffline && eose && events.length === 0;

    return (
        <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6">
            <a href="#board" className="skip-link pixel-frame focus-pixel border-2 border-neon-gold
                bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">
                Skip to the board
            </a>

            <header className="mb-10 space-y-6">
                {/* No sign-in here on purpose. Reading the board needs no key,
                    and neither does paying to promote; the only route that
                    wants a signer is the "Use my nostr key" tab, which asks for
                    one itself. A connect button on the way in advertised a
                    requirement that does not exist. */}
                <RelayBadge status={relayStatus} />

                <div className="space-y-4 text-center">
                    <h1 className="font-pixel text-2xl leading-tight tracking-widest text-neon-pink
                        [text-shadow:0_0_18px_rgba(236,72,153,0.55)] sm:text-4xl md:text-5xl">
                        HOLOBOARD
                    </h1>
                    <p className="mx-auto max-w-xl text-xs leading-relaxed text-cyan-200/70 sm:text-sm">
                        A bulletin board where the only ranking signal is sats. Pay to push any note
                        up the list. Pay more, sit higher. That is the whole rule.
                    </p>
                    <div className="flex justify-center">
                        <PixelButton size="lg" variant="accent" onClick={() => setIsModalOpen(true)}>
                            Promote a note
                        </PixelButton>
                    </div>
                </div>
            </header>

            <main id="board" tabIndex={-1}>
                <h2 className="sr-only">The board, ranked by total sats paid</h2>

                {isOffline && <RelayDown onRetry={retryRelay} />}
                {isLoading && <LoadingRows />}
                {isEmpty && <EmptyBoard onPromote={() => setIsModalOpen(true)} />}

                {events.length > 0 && (
                    <ul className="space-y-4">
                        {ordered.map((event, index) => (
                            <BoardRow
                                key={event.id}
                                event={event}
                                rank={index + 1}
                                sats={sats.get(event.id)}
                            />
                        ))}
                    </ul>
                )}

                {events.length > 0 && (
                    <div className="mt-6">
                        <OpenSlot rank={events.length + 1} onPromote={() => setIsModalOpen(true)} />
                    </div>
                )}
            </main>

            <footer className="mt-16 border-t-2 border-cyan-400/15 pt-6 text-center">
                <p className="font-pixel text-[9px] leading-relaxed tracking-widest text-cyan-300/35">
                    Served by {RELAY_URL.replace(/^wss?:\/\//, "")}
                </p>
            </footer>

            {isModalOpen && <PromoteModal onClose={() => setIsModalOpen(false)} />}
        </div>
    );
}

function RelayBadge({ status }: { status: "connecting" | "connected" | "offline" }) {
    const tone =
        status === "connected"
            ? { dot: "bg-neon-cyan", text: "text-cyan-300/70", label: "Relay online" }
            : status === "connecting"
              ? { dot: "bg-neon-gold animate-flicker", text: "text-amber-300/70", label: "Connecting" }
              : { dot: "bg-neon-pink", text: "text-pink-300/80", label: "Relay offline" };

    return (
        <p className="flex items-center gap-2 font-pixel text-[9px] tracking-widest">
            <span className={`block h-2 w-2 ${tone.dot}`} aria-hidden="true" />
            <span className={tone.text}>{tone.label}</span>
        </p>
    );
}

function LoadingRows() {
    return (
        <ul className="space-y-4" aria-busy="true" aria-label="Loading the board">
            {[0, 1, 2].map((row) => (
                <li key={row}>
                    <PixelPanel accent="rgba(34,211,238,0.2)">
                        <div className="flex animate-pulse gap-5 p-5">
                            <div className="h-6 w-6 bg-cyan-400/20" />
                            <div className="flex-1 space-y-3">
                                <div className="h-4 w-40 bg-cyan-400/20" />
                                <div className="h-3 w-full bg-cyan-400/10" />
                                <div className="h-3 w-4/5 bg-cyan-400/10" />
                            </div>
                        </div>
                    </PixelPanel>
                </li>
            ))}
        </ul>
    );
}

function RelayDown({ onRetry }: { onRetry: () => void }) {
    return (
        <PixelPanel accent="#ec4899" glow="rgba(236,72,153,0.3)">
            <div className="space-y-4 p-6 text-center" role="alert">
                <p className="font-pixel text-xs leading-relaxed text-neon-pink">Cannot reach the relay</p>
                <p className="text-sm leading-relaxed text-cyan-100/70">
                    <code className="text-cyan-200">{RELAY_URL}</code> is not answering, so there is
                    no board to show. This page cannot rank anything on its own.
                </p>
                <p className="text-xs text-cyan-300/50">Retrying every 15 seconds.</p>
                <PixelButton size="sm" onClick={onRetry}>
                    Try again now
                </PixelButton>
            </div>
        </PixelPanel>
    );
}

function EmptyBoard({ onPromote }: { onPromote: () => void }) {
    return (
        <PixelPanel accent="rgba(34,211,238,0.4)">
            <div className="space-y-4 p-8 text-center">
                <p className="font-pixel text-xs leading-relaxed text-neon-gold">The board is empty</p>
                <p className="mx-auto max-w-md text-sm leading-relaxed text-cyan-100/70">
                    Nothing has been paid for yet. The relay stores only what somebody bought, so an
                    empty board means an empty ledger. First zap takes rank one.
                </p>
                <PixelButton variant="accent" onClick={onPromote}>
                    Take rank 1
                </PixelButton>
            </div>
        </PixelPanel>
    );
}

function OpenSlot({ rank, onPromote }: { rank: number; onPromote: () => void }) {
    return (
        <PixelPanel accent="rgba(34,211,238,0.22)">
            <div className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="flex items-center gap-5">
                    <span className="font-pixel text-lg text-cyan-300/30" aria-hidden="true">
                        {rank}
                    </span>
                    <p className="text-sm text-cyan-200/60">This slot is open. Any note, any sats.</p>
                </div>
                <PixelButton size="sm" onClick={onPromote}>
                    Promote a note
                </PixelButton>
            </div>
        </PixelPanel>
    );
}
