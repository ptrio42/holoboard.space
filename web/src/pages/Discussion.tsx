import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ENABLE_REPLY_PUBLICATION, SATS_ENDPOINT } from "../config";
import type { Event } from "nostr-tools";
import { useDiscussion } from "../hooks/useDiscussion";
import { useSatsMap } from "../hooks/useSatsMap";
import { nostrCache } from "../lib/nostrCache";
import { DISCUSSION_PAGE_SIZE, defaultExpansion, discussionCoverage, discussionProjection, expandedReplies } from "../lib/discussionView";
import { navigateReading } from "../lib/discussionNavigation";
import type { ThreadRow } from "../lib/threadGraph";
import { BoardLayout } from "../components/BoardLayout/BoardLayout";
import { DiscussionNote } from "../components/Discussion/DiscussionNote";
import { DiscussionSources } from "../components/Discussion/DiscussionSources";
import { PixelButton } from "../components/ui/PixelButton";
import { StatusMessage } from "../components/ui/StatusMessage";
import { readingBackLabel } from "../lib/readingRoutes";
import { PromoteModal } from "../components/PromoteModal/PromoteModal";
const ReplyComposer = ENABLE_REPLY_PUBLICATION ? lazy(() => import("../components/Discussion/ReplyComposer").then(module => ({ default: module.ReplyComposer }))) : null;

interface ReadingState { collapsed: string[]; page: number; pendingPage: number; context: boolean }
const STORAGE_KEY = "holoboard-discussion-reading-v1";
const initialState = (): ReadingState => ({ collapsed: [], page: 0, pendingPage: 0, context: false });
function savedState(id: string): ReadingState {
    try {
        const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")[id];
        if (!value || typeof value !== "object") return initialState();
        return { collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter((key: unknown) => typeof key === "string" && /^event:[0-9a-f]{64}$/.test(key)).slice(0, 2048) : [],
            page: Number.isSafeInteger(value.page) && value.page >= 0 ? Math.min(value.page, 128) : 0,
            pendingPage: Number.isSafeInteger(value.pendingPage) && value.pendingPage >= 0 ? Math.min(value.pendingPage, 128) : 0, context: value.context === true };
    } catch { return initialState(); }
}

export default function Discussion({ focusId, author, from }: { focusId: string; author?: string; from: string }) {
    const { snapshot, error, loadMore, retry } = useDiscussion(focusId, author);
    const ledger = useSatsMap(SATS_ENDPOINT);
    const [reading, setReading] = useState(() => savedState(focusId));
    const [promote, setPromote] = useState(false);
    const [replyTo, setReplyTo] = useState<Event>();
    const jumpTo = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
        if (!jumpTo.current) return;
        const target = document.getElementById(jumpTo.current);
        jumpTo.current = undefined;
        if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); }
    }, [reading]);
    useEffect(() => {
        try {
            const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
            delete saved[focusId];
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...Object.entries(saved).slice(-7), [focusId, reading]])));
        } catch { /* Reading remains usable when storage is disabled. */ }
    }, [focusId, reading]);
    const projection = useMemo(() => snapshot && discussionProjection(snapshot.graph, focusId), [snapshot, focusId]);
    const projectedKeys = useMemo(() => new Set(projection ? [projection.focus, ...projection.ancestors, ...projection.replies, ...projection.unresolved].map(row => row.key) : []), [projection]);
    // One cache scan per graph update, rather than cloning the cache for each row.
    const bodies = useMemo(() => new Map(snapshot ? nostrCache.query({ ids: [...snapshot.graph.events.keys()] }).map(event => [event.id, event]) : []), [snapshot]);
    const expanded = useMemo(() => snapshot ? defaultExpansion(snapshot.graph, new Set(reading.collapsed)) : new Set<string>(), [snapshot, reading.collapsed]);
    const coverage = snapshot && discussionCoverage(snapshot);
    const toggle = (key: string) => setReading(value => expanded.has(key)
        ? { ...value, collapsed: [...value.collapsed, key].slice(-2048) }
        : { ...value, collapsed: value.collapsed.filter(id => id !== key) });
    const showParent = (key: string) => {
        if (!snapshot || !projection) return;
        const path = new Set<string>();
        let node = snapshot.graph.nodes.get(key);
        while (node && !path.has(node.key) && path.size <= snapshot.graph.limits.maxDepth) {
            path.add(node.key); node = node.parent ? snapshot.graph.nodes.get(node.parent) : undefined;
        }
        const collapsed = reading.collapsed.filter(id => !path.has(id));
        const opened = defaultExpansion(snapshot.graph, new Set(collapsed));
        const pageFor = (rows: ThreadRow[], previous: number) => {
            const index = expandedReplies(rows, opened).findIndex(row => row.key === key);
            return index < 0 ? previous : Math.floor(index / DISCUSSION_PAGE_SIZE);
        };
        setReading(value => ({ ...value, collapsed, context: value.context || projection.ancestors.some(row => row.key === key),
            page: pageFor(projection.replies, value.page), pendingPage: pageFor(projection.unresolved, value.pendingPage) }));
        jumpTo.current = `discussion-note-${key.slice("event:".length)}`;
    };
    const note = (row: ThreadRow, tree = false) => {
        const node = snapshot!.graph.nodes.get(row.key);
        const parent = node?.parentState === "resolved" && node.parent ? snapshot!.graph.nodes.get(node.parent) : undefined;
        const children = snapshot!.graph.children.get(row.key)?.length ?? 0;
        return <li key={row.key} id={node?.event ? `discussion-note-${node.event.id}` : undefined} tabIndex={-1} data-discussion-key={row.key}
            className={tree ? "relative border-l-2 border-cyan-400/25 pl-3 focus:outline-neon-cyan" : "focus:outline-neon-cyan"}
            style={tree ? { marginLeft: `${Math.min(row.depth - 1, 3) * 10}px` } : undefined}>
            {tree && <span aria-hidden="true" className="absolute left-0 top-6 h-0.5 w-3 bg-cyan-400/40" />}
            <DiscussionNote node={node} event={node?.event ? bodies.get(node.event.id) : undefined} focus={row.key === `event:${focusId}`}
                parent={parent} parentEvent={parent?.event ? bodies.get(parent.event.id) : undefined} onParent={parent && projectedKeys.has(parent.key) ? () => showParent(parent.key) : undefined}
                promoted={!!node?.event && ledger.sats.has(node.event.id)}>
                {ENABLE_REPLY_PUBLICATION && node?.event && bodies.has(node.event.id) && <button type="button" className="note-action inline-flex min-h-11 items-center" onClick={() => setReplyTo(bodies.get(node.event!.id))}>Reply</button>}
                {tree && children > 0 && <button type="button" className="note-action inline-flex min-h-11 items-center" aria-expanded={expanded.has(row.key)}
                    onClick={() => toggle(row.key)}>{expanded.has(row.key) ? "Hide replies" : `Show replies (${children})`}</button>}
            </DiscussionNote>
        </li>;
    };
    const replies = (rows: ThreadRow[], pending = false) => {
        const visible = expandedReplies(rows, expanded);
        const page = Math.min(pending ? reading.pendingPage : reading.page, Math.max(0, Math.ceil(visible.length / DISCUSSION_PAGE_SIZE) - 1));
        const choose = (next: number) => setReading(value => ({ ...value, [pending ? "pendingPage" : "page"]: next }));
        return <>
            <ul className="space-y-3">{visible.slice(page * DISCUSSION_PAGE_SIZE, (page + 1) * DISCUSSION_PAGE_SIZE).map(row => note(row, true))}</ul>
            {visible.length > DISCUSSION_PAGE_SIZE && <div className="mt-4 flex flex-wrap items-center gap-4" aria-label={pending ? "Unresolved branch pages" : "Reply pages"}>
                <PixelButton variant="ghost" disabled={page === 0} onClick={() => choose(page - 1)}>Previous replies</PixelButton>
                <span className="text-xs text-cyan-100/75">Page {page + 1} of {Math.ceil(visible.length / DISCUSSION_PAGE_SIZE)}</span>
                <PixelButton variant="ghost" disabled={(page + 1) * DISCUSSION_PAGE_SIZE >= visible.length} onClick={() => choose(page + 1)}>Next replies</PixelButton>
            </div>}
        </>;
    };
    return <BoardLayout section="discussion" onPromote={() => setPromote(true)}>
        <main id="discussion" tabIndex={-1}>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <a href={from} onClick={navigateReading} className="note-action inline-flex min-h-11 items-center">{readingBackLabel(from)}</a>
                <h2 className="font-pixel text-xs text-neon-cyan">Discussion</h2>
            </div>
            {error && <div role="alert"><p className="mb-3 text-sm text-neon-pink">Could not open this discussion. Try again.</p><PixelButton onClick={retry}>Try again</PixelButton></div>}
            {!snapshot && !error && <StatusMessage loading>Opening discussion...</StatusMessage>}
            {snapshot && projection && <>
                {projection.ancestors.length > 0 && <section aria-label="Ancestor context" className="mb-5">
                    <h3 className="mb-3 font-pixel text-[10px] text-cyan-100/75">Earlier context</h3>
                    {projection.ancestors.length > 8 && <button type="button" className="note-action mb-3 inline-flex min-h-11 items-center" aria-expanded={reading.context} onClick={() => setReading(value => ({ ...value, context: !value.context }))}>{reading.context ? "Less context" : `Show earlier context (${projection.ancestors.length - 8})`}</button>}
                    <ul className="space-y-3">{(reading.context ? projection.ancestors : projection.ancestors.slice(-8)).map(row => note(row))}</ul>
                </section>}
                <ul className="mb-6">{note(projection.focus)}</ul>
                <section aria-label="Replies">
                    <h3 className="mb-2 font-pixel text-xs text-neon-cyan">{projection.loadedReplyCount} found {projection.loadedReplyCount === 1 ? "reply" : "replies"}</h3>
                    <p className="mb-4 text-xs text-cyan-100/75">Oldest first within each branch.</p>
                    {projection.loadedReplyCount === 0 && <StatusMessage compact>No replies found yet. Other relays may have more.</StatusMessage>}
                    {replies(projection.replies)}
                </section>
                {projection.unresolved.length > 0 && <section aria-label="Unresolved branches" className="mt-6">
                    <h3 className="mb-3 font-pixel text-[10px] text-neon-gold">Unresolved branches</h3>
                    <p className="mb-4 text-xs text-cyan-100/75">These notes reference this discussion, but their parent path is unresolved. They are kept separate.</p>
                    {replies(projection.unresolved, true)}
                </section>}
                <section aria-label="Discussion coverage" data-read-state={snapshot.state} className="mt-6 border-t-2 border-cyan-400/20 pt-4">
                    <StatusMessage compact loading={snapshot.state === "loading"}>{snapshot.state === "loading" ? "Loading discussion..." : coverage?.partial ? "Partial results. Some sources or reading limits remain unresolved." : "Checked selected sources. Other relays may have more replies."}</StatusMessage>
                    <p className="mt-2 text-xs text-cyan-100/75">This read covers replies up to {new Date(snapshot.until * 1000).toLocaleTimeString()}. Reopen the discussion to check newer replies.</p>
                    {(coverage?.limited || projection.truncated) && <p className="mt-2 text-xs text-neon-gold">Reading limits were reached. Some notes or context may be missing.</p>}
                    <DiscussionSources snapshot={snapshot} />
                    {snapshot.hasMore && <PixelButton className="mt-3" variant="ghost" disabled={snapshot.state === "loading"} onClick={loadMore}>Load more</PixelButton>}
                </section>
            </>}
        </main>
        {promote && <PromoteModal onClose={() => setPromote(false)} onPaid={ledger.refresh} />}
        {ReplyComposer && replyTo && snapshot && <Suspense fallback={<StatusMessage loading>Opening reply editor...</StatusMessage>}><ReplyComposer key={replyTo.id} parent={replyTo} graph={snapshot.graph} onClose={() => setReplyTo(undefined)} /></Suspense>}
    </BoardLayout>;
}
