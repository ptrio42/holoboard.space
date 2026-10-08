import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, matchFilter, type Event, type Filter } from "nostr-tools";
import { DiscussionCoordinator, type DiscussionHandle, type DiscussionSnapshot } from "./discussionReads";
import { nostrCache } from "./nostrCache";
import { queryNostr, type QueryResult, type RelayOutcome } from "./nostrTransport";
import { projectThread } from "./threadGraph";

vi.mock("../config", () => ({ RELAY_URL: "wss://board.example.com", PUBLIC_RELAYS: ["wss://a.example.com", "wss://b.example.com"] }));
vi.mock("./nostrTransport", () => ({ queryNostr: vi.fn() }));
const board = "wss://board.example.com", a = "wss://a.example.com", b = "wss://b.example.com";
const handles: DiscussionHandle[] = [];
const key = () => generateSecretKey();
function note(tags: string[][] = [], time = 100, secret = key(), kind = 1, content = "") {
    return finalizeEvent({ kind, created_at: time, tags, content }, secret);
}
const reply = (parent: Event, root = parent, time = 100) => note([["e", root.id, "", "root", root.pubkey], ["e", parent.id, "", "reply", parent.pubkey]], time);
function list(secret: Uint8Array, tags: string[][] = []) {
    const event = note(tags, 100, secret, 10002); nostrCache.put(event); return event;
}
function open(coordinator: DiscussionCoordinator, seed: Event, options: { signal?: AbortSignal; hints?: string[] } = {}) {
    const handle = coordinator.open({ focusId: seed.id, seed, ...options }); handles.push(handle); return handle;
}
async function drain(handle: DiscussionHandle, runs = 20): Promise<DiscussionSnapshot> {
    let snapshot = await handle.loadMore();
    for (let i = 1; i < runs && snapshot.hasMore; i++) snapshot = await handle.loadMore();
    return snapshot;
}
function response(events: Event[], urls: string[], outcome: RelayOutcome = "eose"): QueryResult {
    return { events, sources: Object.fromEntries(events.map((event) => [event.id, urls])),
        relays: Object.fromEntries(urls.map((url) => [url, outcome])), complete: outcome === "eose" };
}
function network(records: Map<string, Event[]>, outcome?: (filter: Filter, url: string) => RelayOutcome) {
    vi.mocked(queryNostr).mockImplementation(async (filter, urls, options) => {
        const found = [...new Map(urls.flatMap((url) => records.get(url) ?? []).filter((event) => matchFilter(filter, event))
            .map((event) => [event.id, event])).values()].sort((x, y) => y.created_at - x.created_at || x.id.localeCompare(y.id)).slice(0, filter.limit ?? 512);
        for (const event of found) options?.onEvent?.(event);
        return response(found, urls, outcome?.(filter, urls[0]) ?? "eose");
    });
}
beforeEach(() => { vi.mocked(queryNostr).mockReset(); network(new Map()); });
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Holoboard discussion retrieval", () => {
    it("keeps a promoted middle reply as focus and discovers unpaid parents and descendants", async () => {
        const root = note(), focus = reply(root, root, 110), unpaid = reply(focus, root, 120), promoted = reply(unpaid, root, 90);
        const sibling = reply(root, root, 130), quote = note([["q", focus.id]], 140), quoteReply = reply(quote, quote, 150);
        const mention = note([["e", focus.id, "", "mention"]], 160);
        network(new Map([[a, [root, unpaid, promoted, sibling, quote, quoteReply, mention]]]));
        const handle = open(new DiscussionCoordinator(), focus);
        const result = await drain(handle);
        const projection = projectThread(result.graph, focus.id);
        expect(projection.ancestors.map((row) => row.key)).toEqual([`event:${root.id}`]);
        expect(projection.replies.map((row) => row.key)).toEqual([`event:${unpaid.id}`, `event:${promoted.id}`]);
        expect(result.focusId).toBe(focus.id);
        expect(result.sources[unpaid.id]).toEqual([a]);
        expect(result.sources[focus.id]).toBeUndefined();
        result.sources[unpaid.id].push("wss://injected.example.com");
        expect(handle.snapshot().sources[unpaid.id]).toEqual([a]);
        for (const event of [sibling, quote, quoteReply, mention]) expect(result.graph.events.has(event.id)).toBe(false);
        expect(result.coverage.some((item) => item.filter["#e"]?.includes(root.id))).toBe(false);
        expect(result.state).toBe("settled");
    });

    it("resolves a parent revealed by a root candidate without merging a false root claim", async () => {
        const focus = note(), missing = reply(focus), child = reply(missing, focus), otherRoot = note();
        const conflicting = reply(otherRoot, focus);
        network(new Map([[a, [child, missing, conflicting, otherRoot]]]));
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.nodes.get(`event:${child.id}`)?.parent).toBe(`event:${missing.id}`);
        expect(result.graph.nodes.get(`event:${conflicting.id}`)?.rootState).toBe("conflict");
        expect(projectThread(result.graph, focus.id).replies.map((row) => row.key)).toEqual([`event:${missing.id}`, `event:${child.id}`]);
    });

    it("uses independent cursors for relays with unequal date ranges", async () => {
        const secret = key(); list(secret);
        const focus = note([], 1, secret);
        const eventsA = [100, 99, 98].map((time) => reply(focus, focus, time));
        const eventsB = [90, 80, 70].map((time) => reply(focus, focus, time));
        network(new Map([[a, eventsA], [b, eventsB]]));
        const result = await drain(open(new DiscussionCoordinator({ pageSize: 2, maxTargets: 1 }), focus));
        for (const event of [...eventsA, ...eventsB]) expect(result.graph.events.has(event.id)).toBe(true);
        const calls = vi.mocked(queryNostr).mock.calls.filter(([filter]) => filter["#e"]?.includes(focus.id));
        expect(calls.some(([filter, urls]) => urls[0] === a && filter.until === 99)).toBe(true);
        expect(calls.some(([filter, urls]) => urls[0] === b && filter.until === 80)).toBe(true);
        expect(result.coverage.filter((item) => item.filter["#e"]?.includes(focus.id)).every((item) => item.exhausted)).toBe(true);
    });

    it("keeps timeout observations and retries only that relay's unadvanced cursor", async () => {
        const secret = key(); list(secret);
        const focus = note([], 1, secret), fast = [90, 80, 70].map((time) => reply(focus, focus, time)), slow = reply(focus, focus, 100);
        let failed = true;
        network(new Map([[a, [slow]], [b, fast]]), (filter, url) => url === a && filter["#e"] ? failed ? "timeout" : "eose" : "eose");
        const handle = open(new DiscussionCoordinator({ pageSize: 2, maxTargets: 1 }), focus);
        const first = await handle.loadMore();
        expect(first.graph.events.has(slow.id)).toBe(true);
        const incomplete = first.coverage.find((item) => item.relay === a && item.filter["#e"]);
        expect(incomplete?.outcome).toBe("timeout"); expect(incomplete?.cursor).toBeUndefined(); expect(incomplete?.exhausted).toBe(false);
        expect(first.coverage.find((item) => item.relay === b && item.filter["#e"])?.exhausted).toBe(true);
        failed = false;
        const before = vi.mocked(queryNostr).mock.calls.length;
        const final = await drain(handle);
        expect(final.state).toBe("settled");
        expect(vi.mocked(queryNostr).mock.calls.slice(before).some(([, urls]) => urls[0] === b)).toBe(false);
    });

    it("never silently advances past a timestamp with more than 512 matching events", async () => {
        const secret = key(); list(secret);
        const focus = note([], 1, secret);
        const events = Array.from({ length: 513 }, (_, index) => note([["e", focus.id, "", "root"]], 100, secret, 1, String(index)));
        network(new Map([[a, events]]));
        const result = await drain(open(new DiscussionCoordinator({ maxTargets: 1 }), focus));
        const coverage = result.coverage.find((item) => item.relay === a && item.filter["#e"]);
        expect(coverage?.truncated).toBe(true); expect(coverage?.exhausted).toBe(false);
        expect(coverage?.cursor?.until).toBe(100); expect(coverage?.cursor?.limit).toBe(512);
        expect(result.limitations).toContain("pages");
        expect(result.graph.children.get(`event:${focus.id}`)).toHaveLength(512);
    }, 60_000);

    it("fetches an exact old address version through its author's outbox despite a newer cached version", async () => {
        const author = key(), pubkey = getPublicKey(author), outbox = "wss://writer.example.com";
        list(author, [["r", outbox, "write"]]);
        const old = note([["d", "article"]], 100, author, 30023), latest = note([["d", "article"]], 200, author, 30023);
        const address = `30023:${pubkey}:article`; nostrCache.put(latest);
        const focus = note([["A", address], ["E", old.id], ["K", "30023"], ["P", pubkey],
            ["a", address], ["e", old.id], ["k", "30023"], ["p", pubkey]], 210, key(), 1111);
        network(new Map([[outbox, [old]]]));
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.nodes.get(`event:${focus.id}`)?.parent).toBe(`event:${old.id}`);
        expect(result.graph.nodes.get(`event:${focus.id}`)?.parentState).toBe("resolved");
        expect(nostrCache.query({ kinds: [30023], authors: [pubkey] })[0].id).toBe(latest.id);
        expect(vi.mocked(queryNostr).mock.calls.some(([filter, urls]) => filter.ids?.includes(old.id) && urls.includes(outbox))).toBe(true);
        expect(vi.mocked(queryNostr).mock.calls.some(([filter]) => filter.ids?.includes(latest.id))).toBe(false);
    });

    it("discovers a missing author's write relay from the parent's reference hint", async () => {
        const author = key(), parent = note([], 100, author), hint = "wss://reference.example.com", outbox = "wss://private-outbox.example.com";
        const relays = note([["r", outbox, "write"]], 100, author, 10002);
        const focus = note([["e", parent.id, hint, "reply", parent.pubkey]]);
        network(new Map([[hint, [relays]], [outbox, [parent]]]));
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.nodes.get(`event:${focus.id}`)?.parentState).toBe("resolved");
        expect(vi.mocked(queryNostr).mock.calls.some(([filter, urls]) => filter.authors?.includes(parent.pubkey) && filter.kinds?.includes(10002) && urls.includes(hint))).toBe(true);
    });

    it("can resolve an uncached focus from a known author's write relay without a seed", async () => {
        const author = key(), focus = note([], 100, author), outbox = "wss://focus-outbox.example.com";
        list(author, [["r", outbox, "write"]]); network(new Map([[outbox, [focus]]]));
        const coordinator = new DiscussionCoordinator();
        const handle = coordinator.open({ focusId: focus.id, author: focus.pubkey }); handles.push(handle);
        const result = await drain(handle);
        expect(result.graph.events.has(focus.id)).toBe(true);
        expect(result.coverage.some((item) => item.purpose === "ancestor" && item.relay === outbox && item.satisfied)).toBe(true);
    });

    it("retries transient shared-transport budgets without advancing the failed branch", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), child = reply(focus); let limited = true;
        network(new Map([[a, [child]]]), (filter, url) => limited && url === a && filter["#e"] ? "budget" : "eose");
        const handle = open(new DiscussionCoordinator({ maxTargets: 1 }), focus);
        const first = await handle.loadMore();
        const branch = first.coverage.find((item) => item.relay === a && item.filter["#e"]);
        expect(branch?.cursor).toBeUndefined(); expect(branch?.truncated).toBe(false); expect(first.hasMore).toBe(true);
        limited = false;
        expect((await drain(handle)).coverage.find((item) => item.key === branch!.key)?.exhausted).toBe(true);
    });

    it("keeps failed metadata discovery retryable without reopening successful branches", async () => {
        const focus = note(); let unavailable = true;
        network(new Map(), (filter) => unavailable && filter.kinds?.includes(10002) ? "closed" : "eose");
        const handle = open(new DiscussionCoordinator(), focus);
        const first = await handle.loadMore();
        expect(first.state).toBe("paused"); expect(first.hasMore).toBe(true);
        const before = vi.mocked(queryNostr).mock.calls.length; unavailable = false;
        const result = await drain(handle);
        expect(result.state).toBe("settled");
        expect(vi.mocked(queryNostr).mock.calls.slice(before).every(([filter]) => filter.kinds?.includes(10002))).toBe(true);
    });

    it("uses NIP-65 read relays for candidates and keeps a signed list received before timeout", async () => {
        const author = key(), focus = note([], 100, author), child = reply(focus), inbox = "wss://inbox.example.com", outbox = "wss://outbox.example.com";
        const relays = note([["r", inbox, "read"], ["r", outbox, "write"], ["r", "wss://127.0.0.1", "read"]], 100, author, 10002);
        network(new Map([["wss://purplepag.es", [relays]], [inbox, [child]]]), (filter) => filter.kinds?.includes(10002) ? "timeout" : "eose");
        const result = await drain(open(new DiscussionCoordinator(), focus, { hints: ["ws://evil.example.com", "wss://relay.local"] }));
        expect(result.graph.events.has(child.id)).toBe(true);
        expect(result.routing.find((route) => route.author === focus.pubkey)?.relays["wss://purplepag.es"]).toBe("timeout");
        expect(result.coverage.some((item) => item.purpose === "descendants" && item.relay === inbox)).toBe(true);
        expect(result.coverage.some((item) => item.relay === outbox)).toBe(false);
        expect(vi.mocked(queryNostr).mock.calls.flatMap(([, urls]) => urls).some((url) => url.includes("127.0.0.1") || url.includes("relay.local") || url.startsWith("ws:"))).toBe(false);
    });

    it("prioritizes the author's public read relay within a single-query allowance", async () => {
        const author = key(), inbox = "wss://public-replies.example.com/inbox";
        list(author, [["r", inbox, "read"]]);
        const focus = note([], 100, author), child = reply(focus);
        network(new Map([[inbox, [child]]]));
        const result = await open(new DiscussionCoordinator({ maxRequests: 1 }), focus).loadMore();
        expect(result.requests).toBe(1);
        expect(result.coverage[0].relay).toBe(inbox);
        expect(result.graph.events.has(child.id)).toBe(true);
    });

    it("uses a public read inbox even when it also receives DMs, without importing DM-only relays", async () => {
        const author = key(), focus = note([], 100, author), child = reply(focus);
        const shared = "wss://public.example.com/inbox", dmOnly = "wss://private.example.com/inbox";
        list(author, [["r", shared, "read"]]);
        const dmList = note([["relay", shared], ["relay", dmOnly]], 200, author, 10050);
        nostrCache.put(dmList);
        network(new Map([["wss://purplepag.es", [dmList]], [shared, [child]], [dmOnly, [child]]]));
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.events.has(child.id)).toBe(true);
        expect(result.coverage.some(work => work.purpose === "descendants" && work.relay === shared)).toBe(true);
        expect(result.coverage.some(work => work.relay === dmOnly)).toBe(false);
        expect(vi.mocked(queryNostr).mock.calls.flatMap(([, urls]) => urls)).not.toContain(dmOnly);
        expect(vi.mocked(queryNostr).mock.calls.some(([filter]) => filter.kinds?.includes(10050))).toBe(false);
    });

    it("discovers NIP-22 replies by address and keeps the original exact focus", async () => {
        const author = key(), article = note([["d", "test"]], 100, author, 30023);
        const address = `30023:${article.pubkey}:test`;
        const child = note([["A", address], ["K", "30023"], ["P", article.pubkey], ["a", address], ["k", "30023"], ["p", article.pubkey]], 110, key(), 1111);
        const grandchild = note([["A", address], ["K", "30023"], ["P", article.pubkey], ["e", child.id, "", child.pubkey], ["k", "1111"], ["p", child.pubkey]], 90, key(), 1111);
        network(new Map([[a, [child, grandchild]]]));
        const result = await drain(open(new DiscussionCoordinator(), article));
        expect(projectThread(result.graph, article.id).replies.map((row) => row.key)).toEqual([`event:${child.id}`, `event:${grandchild.id}`]);
        expect(result.focusId).toBe(article.id);
    });

    it("shares one admitted target across all exact-ID and address predicates", async () => {
        const author = key(); list(author);
        const article = note([["d", "one-target"]], 100, author, 30023), address = `30023:${article.pubkey}:one-target`;
        const child = note([["A", address], ["K", "30023"], ["P", article.pubkey], ["a", address], ["k", "30023"], ["p", article.pubkey]], 110, author, 1111);
        network(new Map([[board, [child]]]));
        const result = await drain(open(new DiscussionCoordinator({ maxTargets: 1 }), article));
        expect(projectThread(result.graph, article.id).replies.map(row => row.key)).toEqual([`event:${child.id}`]);
        expect(result.coverage.some(work => work.filter["#a"]?.includes(address))).toBe(true);
        expect(result.coverage.filter(work => work.purpose === "descendants").every(work =>
            work.target.type === "event" ? work.target.value === article.id : work.target.exactId === article.id)).toBe(true);
        expect(result.hasMore).toBe(false);
    });

    it("keeps missing parents explicit after every selected relay sends EOSE", async () => {
        const focus = note(), missingId = "f".repeat(64), child = note([["e", focus.id, "", "root"], ["e", missingId, "", "reply"]]);
        network(new Map([[a, [child]]]));
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.nodes.get(`event:${child.id}`)?.parentState).toBe("missing");
        expect(result.coverage.filter((item) => item.purpose === "ancestor" && item.filter.ids?.includes(missingId)).every((item) => item.exhausted)).toBe(true);
        expect(result.state).toBe("settled");
        expect(result.retentionLimited).toBe(false);
    });

    it("does not turn external scopes into HTTP requests or relay destinations", async () => {
        const external = "https://private.example.com/secret";
        const focus = note([["I", external], ["K", "web"], ["i", external], ["k", "web"]], 100, key(), 1111);
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect(result.graph.nodes.get(`event:${focus.id}`)?.parentState).toBe("external");
        expect(result.coverage.some((item) => item.purpose === "ancestor")).toBe(false);
        expect(vi.mocked(queryNostr).mock.calls.flatMap(([, urls]) => urls)).not.toContain(external);
    });

    it("uses cached replies immediately but still asks the network for descendant coverage", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), cached = reply(focus); nostrCache.put(cached);
        network(new Map(), (filter) => filter["#e"] ? "timeout" : "eose");
        const handle = open(new DiscussionCoordinator({ maxTargets: 1 }), focus);
        const result = await handle.loadMore();
        expect(result.graph.events.has(cached.id)).toBe(true);
        expect(result.coverage.filter((item) => item.filter["#e"]).every((item) => item.outcome === "timeout" && !item.exhausted)).toBe(true);
        expect(result.retentionLimited).toBe(false);
    });

    it("does not admit a forged ID, wrong filter or stale verification flag", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), valid = reply(focus), unrelated = note();
        const forged = { ...valid, id: "0".repeat(64) }, mutated = { ...valid, content: "changed after signing" };
        vi.mocked(queryNostr).mockImplementation(async (_filter, urls, options) => {
            for (const event of [forged, mutated, unrelated]) options?.onEvent?.(event);
            return response([forged, mutated, unrelated], urls);
        });
        const result = await drain(open(new DiscussionCoordinator(), focus));
        expect([...result.graph.events.keys()]).toEqual([focus.id]);
    });

    it("shares the same in-flight run across views and cancels only after the final view closes", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), late = reply(focus);
        let signal: AbortSignal | undefined;
        vi.mocked(queryNostr).mockImplementation(async (_filter, urls, options) => {
            signal = options!.signal;
            return new Promise((resolve) => signal!.addEventListener("abort", () => {
                options?.onEvent?.(late); resolve(response([], urls, "cancelled"));
            }, { once: true }));
        });
        const coordinator = new DiscussionCoordinator({ maxSessions: 1 });
        const controller = new AbortController();
        const first = open(coordinator, focus, { signal: controller.signal }), second = open(coordinator, focus);
        const pending = first.loadMore(); expect(second.loadMore()).toBe(pending);
        await vi.waitFor(() => expect(signal).toBeDefined());
        controller.abort(); expect(signal!.aborted).toBe(false);
        second.close(); expect(signal!.aborted).toBe(true);
        const result = await pending;
        expect(result.state).toBe("closed"); expect(result.graph.events.has(late.id)).toBe(false);
        expect(() => open(coordinator, note())).not.toThrow();
    });

    it("bounds open sessions and handles and releases admission on close", () => {
        const coordinator = new DiscussionCoordinator({ maxSessions: 1, maxHandles: 2 });
        const focus = note(), first = open(coordinator, focus), second = open(coordinator, focus);
        expect(() => open(coordinator, focus)).toThrow(/handle budget/);
        first.close(); expect(() => open(coordinator, note())).toThrow(/session budget/);
        second.close(); expect(() => open(coordinator, note())).not.toThrow();
    });

    it("does not reserve target, author or source capacity for an unsent broad frontier", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author);
        const children = Array.from({ length: 70 }, (_, index) => reply(focus, focus, 200 + index));
        for (const child of children) nostrCache.put(child);
        network(new Map([[board, children]]));
        const result = await open(new DiscussionCoordinator({ requestsPerRun: 1 }), focus).loadMore();
        expect(result.requests).toBe(1);
        expect(result.coverage).toHaveLength(1);
        expect(result.routing.map(route => route.author)).toEqual([focus.pubkey]);
        expect(result.limitations).not.toContain("targets");
        expect(result.limitations).not.toContain("authors");
        expect(result.limitations).not.toContain("branches");
        expect(result.hasMore).toBe(true);
        expect(projectThread(result.graph, focus.id).replies).toHaveLength(70);
    }, 60_000);

    it("keeps cached ancestors from consuming missing-parent network lookup capacity", async () => {
        const author = key(); list(author);
        const root = note([], 100, author);
        const grandparent = note([["e", root.id, "", "reply", root.pubkey]], 110, author);
        const parent = note([["e", grandparent.id, "", "reply", grandparent.pubkey]], 120, author);
        const focus = note([["e", root.id, "", "root", root.pubkey], ["e", parent.id, "", "reply", parent.pubkey]], 130, author);
        nostrCache.put(root);
        network(new Map([[board, [parent, grandparent]]]));
        const result = await drain(open(new DiscussionCoordinator({ maxLookups: 2 }), focus));
        expect(projectThread(result.graph, focus.id).ancestors.map(row => row.key)).toEqual([
            `event:${root.id}`, `event:${grandparent.id}`, `event:${parent.id}`,
        ]);
        expect(result.limitations).not.toContain("lookups");
    });

    it.each([board, a])("discovers parent-only grandchildren before duplicate sources consume the lifetime budget (%s)", async source => {
        const author = key(); list(author);
        const focus = note([], 100, author);
        const children = Array.from({ length: 70 }, (_, index) => note([["e", focus.id, "", "reply", focus.pubkey]], 200 + index, author));
        const grandchildren = children.map((child, index) => note([["e", child.id, "", "reply", child.pubkey]], 300 + index, author));
        network(new Map([[source, [...children, ...grandchildren]]]));
        const coordinator = new DiscussionCoordinator();
        const result = await drain(open(coordinator, focus));
        const found = new Set(projectThread(result.graph, focus.id).replies.map(row => row.key));
        expect(children.every(child => found.has(`event:${child.id}`))).toBe(true);
        expect(grandchildren.filter(child => found.has(`event:${child.id}`)).length).toBeGreaterThanOrEqual(60);
        expect(result.limitations).not.toContain("branches");
        expect(result.requests).toBeLessThanOrEqual(coordinator.limits.maxRequests);
        expect(result.coverage.length).toBeLessThanOrEqual(result.requests);
        expect(result.observedEvents).toBeLessThanOrEqual(coordinator.limits.maxEvents);
    }, 60_000);

    it("resolves the promoted focus context before discovering authors on a cached reply frontier", async () => {
        const author = key(); list(author);
        const root = note([], 90, author), focus = note([["e", root.id, "", "root", root.pubkey]], 100, author);
        const children = Array.from({ length: 8 }, (_, i) => reply(focus, root, 200 + i));
        for (const child of children) nostrCache.put(child);
        network(new Map([[board, [root]]]));
        const result = await open(new DiscussionCoordinator({ requestsPerRun: 2 }), focus).loadMore();
        const calls = vi.mocked(queryNostr).mock.calls;
        expect(calls[0][0].ids).toEqual([root.id]);
        expect(calls[1][0]["#e"]).toEqual([focus.id]);
        expect(result.routing.map(route => route.author)).toEqual([focus.pubkey]);
        expect(projectThread(result.graph, focus.id).ancestors.map(row => row.key)).toEqual([`event:${root.id}`]);
        expect(result.hasMore).toBe(true);
    });

    it("stops offering continuation when actual source-record capacity is exhausted", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), handle = open(new DiscussionCoordinator({ maxBranches: 1 }), focus);
        const result = await drain(handle);
        expect(result.coverage).toHaveLength(1);
        expect(result.requests).toBe(1);
        expect(result.limitations).toContain("branches");
        expect(result.queuedWork).toEqual({ ancestor: 0, descendants: 0 });
        expect(result.hasMore).toBe(false);
        await handle.loadMore();
        expect(vi.mocked(queryNostr)).toHaveBeenCalledTimes(1);
    });

    it("does not keep retrying discovery after all remaining source records are blocked", async () => {
        const focus = note();
        network(new Map(), filter => filter.kinds?.includes(10002) ? "timeout" : "eose");
        const result = await drain(open(new DiscussionCoordinator({ maxBranches: 1 }), focus));
        expect(result.requests).toBe(2);
        expect(result.coverage).toHaveLength(1);
        expect(Object.values(result.routing[0].relays)).toContain("timeout");
        expect(result.limitations).toContain("branches");
        expect(result.hasMore).toBe(false);
    });

    it("stops at the lifetime request budget and reports unfinished work", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author);
        const handle = open(new DiscussionCoordinator({ maxRequests: 2 }), focus);
        const result = await drain(handle);
        expect(result.requests).toBe(2); expect(result.limitations).toContain("requests"); expect(result.hasMore).toBe(false);
        expect(result.queuedWork.ancestor + result.queuedWork.descendants).toBeGreaterThan(0);
        await handle.loadMore(); expect(vi.mocked(queryNostr)).toHaveBeenCalledTimes(2);
    });

    it("reports lifetime exhaustion when only failed relay discovery remains", async () => {
        network(new Map(), filter => filter.kinds?.includes(10002) ? "timeout" : "eose");
        const result = await drain(open(new DiscussionCoordinator({ maxRequests: 7 }), note()));
        expect(result.coverage).toHaveLength(6);
        expect(result.coverage.every(work => work.exhausted)).toBe(true);
        expect(result.requests).toBe(7);
        expect(result.limitations).toContain("requests");
        expect(result.stopReason).toBe("requests");
        expect(result.hasMore).toBe(false);
    });

    it("yields between immediate queries so the batch deadline can stop work", async () => {
        vi.useFakeTimers();
        const author = key(); list(author);
        const focus = note([], 100, author), handle = open(new DiscussionCoordinator({ runTimeout: 1 }), focus);
        const pending = handle.loadMore();
        await vi.advanceTimersByTimeAsync(2);
        const result = await pending;
        expect(result.stopReason).toBe("timeout"); expect(result.hasMore).toBe(true);
        expect(result.requests).toBeLessThan(6);
    });

    it("preserves accepted replies when the byte budget stops a request", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), child = reply(focus), later = reply(focus, focus, 99);
        const bytes = JSON.stringify(child).length * 3;
        network(new Map([[board, [child, later]]]));
        const result = await drain(open(new DiscussionCoordinator({ maxBytes: bytes + 1 }), focus));
        expect(result.graph.events.has(child.id)).toBe(true); expect(result.graph.events.has(later.id)).toBe(false);
        expect(result.limitations).toContain("bytes"); expect(result.receivedBytes).toBe(bytes);
        expect(result.coverage.some((item) => item.outcome === "budget")).toBe(true);
        expect(result.hasMore).toBe(false);
    });

    it("reports event retention pressure separately from EOSE and stops further admission", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), child = reply(focus); nostrCache.put(child);
        const result = await drain(open(new DiscussionCoordinator({ maxEvents: 1 }), focus));
        expect(result.retentionLimited).toBe(true); expect(result.limitations).toContain("events");
        expect(result.graph.events.has(child.id)).toBe(false); expect(result.hasMore).toBe(false);
        expect(result.coverage.every((item) => item.outcome === undefined)).toBe(true);
    });

    it("marks oversized candidates as local retention loss instead of exhausting their source", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author), child = reply(focus); network(new Map([[a, [child]]]));
        const limit = JSON.stringify(focus).length * 3 + 1;
        const result = await drain(open(new DiscussionCoordinator({ maxEventBytes: limit }), focus));
        expect(result.graph.events.has(focus.id)).toBe(true); expect(result.graph.events.has(child.id)).toBe(false);
        expect(result.retentionLimited).toBe(true); expect(result.limitations).toContain("event-size");
        expect(result.coverage.find((item) => item.relay === a && item.filter["#e"])?.exhausted).toBe(false);
    });

    it("releases idle graph retention while keeping the independent read cache", async () => {
        const coordinator = new DiscussionCoordinator(), focus = note(), other = note();
        const first = open(coordinator, focus); expect(first.snapshot().hasMore).toBe(true); first.close();
        const second = open(coordinator, other);
        expect(second.snapshot().graph.events.has(focus.id)).toBe(false);
        expect(nostrCache.query({ ids: [focus.id] })[0].id).toBe(focus.id);
    });

    it("can use the last allowed request without reporting a nonexistent request shortfall", async () => {
        const author = key(); list(author);
        const focus = note([], 100, author);
        const result = await drain(open(new DiscussionCoordinator({ maxRelays: 1, maxRequests: 2 }), focus));
        expect(result.requests).toBe(2); expect(result.state).toBe("settled"); expect(result.limitations).not.toContain("requests");
    });

    it("returns detached coverage data and keeps one graph across discussion views", async () => {
        const coordinator = new DiscussionCoordinator(), focus = note(), other = note();
        const first = open(coordinator, focus), second = open(coordinator, other);
        const result = await drain(first);
        result.coverage[0].filter.kinds!.push(42); result.coverage[0].target.relays.push("wss://modified.example.com");
        expect(first.snapshot().coverage[0].filter.kinds).not.toContain(42);
        expect(first.snapshot().coverage[0].target.relays).not.toContain("wss://modified.example.com");
        expect(first.snapshot().graph).toBe(second.snapshot().graph);
        expect(first.snapshot().graph.events.has(other.id)).toBe(true);
    });
});
