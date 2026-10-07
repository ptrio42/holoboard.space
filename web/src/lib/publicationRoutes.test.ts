import { beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { publicationRoutes } from "./publicationRoutes";
const mock = vi.hoisted(() => ({ query: vi.fn(), cached: vi.fn(), put: vi.fn() }));
vi.mock("./nostrTransport", () => ({ queryNostr: mock.query }));
vi.mock("./nostrCache", async original => ({ ...await original<typeof import("./nostrCache")>(), nostrCache: { ready: Promise.resolve(), query: mock.cached, put: mock.put } }));
vi.mock("../config", () => ({ PUBLIC_RELAYS: ["wss://fallback.example.com"], RELAY_URL: "wss://board.example.com" }));
const key = generateSecretKey(), recipient = generateSecretKey();
const note = finalizeEvent({ kind: 1, created_at: 100, content: "reply", tags: [["p", getPublicKey(recipient)]] }, key);
const list = (secret: Uint8Array, tags: string[][]) => finalizeEvent({ kind: 10002, created_at: 100, content: "", tags }, secret);
beforeEach(() => { mock.query.mockReset(); mock.cached.mockReset().mockReturnValue([]); mock.put.mockReset(); });
it("selects author write relays and recipient read relays without publishing to discovery or unrelated read relays", async () => {
    const author = list(key, [["r", "wss://author-write.example.com", "write"], ["r", "wss://author-read.example.com", "read"]]);
    const inbox = list(recipient, [["r", "wss://recipient-read.example.com", "read"], ["r", "wss://recipient-write.example.com", "write"]]);
    mock.query.mockImplementation(async filter => ({ complete: true, events: [filter.authors[0] === note.pubkey ? author : inbox], relays: { "wss://discovery.example.com": "eose" } }));
    const routes = await publicationRoutes(note);
    expect(routes.targets).toEqual(["wss://author-write.example.com", "wss://recipient-read.example.com", "wss://fallback.example.com"]);
    expect(routes).toMatchObject({ partial: false, limited: false }); expect(routes.sources).toHaveLength(2);
    expect(routes.targets.some(url => /discovery|author-read|recipient-write|board/.test(url))).toBe(false);
});
it("retains observed routing after partial discovery and distinguishes cache reuse", async () => {
    mock.cached.mockImplementation(filter => filter.authors[0] === note.pubkey ? [list(key, [["r", "wss://cached-write.example.com", "write"]])] : []);
    mock.query.mockResolvedValue({ complete: false, events: [list(recipient, [["r", "wss://partial-read.example.com", "read"]])], relays: { "wss://discovery.example.com": "timeout" } });
    const routes = await publicationRoutes(note);
    expect(routes).toMatchObject({ partial: true, targets: ["wss://cached-write.example.com", "wss://partial-read.example.com", "wss://fallback.example.com"] });
    expect(routes.sources[0].cached).toBe(true); expect(mock.query).toHaveBeenCalledTimes(1);
});
it("bounds selected recipients and destinations and rejects forged routing lists", async () => {
    const tags = Array.from({ length: 9 }, (_, i) => ["p", (i + 1).toString(16).padStart(64, "0")]);
    const crowded = finalizeEvent({ kind: 1, created_at: 100, content: "", tags }, key);
    const authored = list(key, Array.from({ length: 8 }, (_, i) => ["r", `wss://write${i}.example.com`]));
    mock.query.mockResolvedValue({ complete: false, events: [{ ...authored, id: "f".repeat(64) }], relays: {} });
    expect(await publicationRoutes(crowded)).toMatchObject({ targets: ["wss://fallback.example.com"], partial: true, limited: true });
    expect(mock.query).toHaveBeenCalledTimes(5);
});
it("does not start discovery when cancelled or when the event is forged", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await publicationRoutes(note, controller.signal)).partial).toBe(true);
    expect(mock.query).not.toHaveBeenCalled();
    await expect(publicationRoutes({ ...note, sig: "0".repeat(128) })).rejects.toThrow("verified");
});
it("shares a bounded destination list across the author, selected recipients and fallback", async () => {
    const people = Array.from({ length: 5 }, () => generateSecretKey());
    const crowded = finalizeEvent({ kind: 1, created_at: 100, content: "reply", tags: people.map(person => ["p", getPublicKey(person)]) }, key);
    const lists = new Map([key, ...people].map((person, index) => [getPublicKey(person), list(person, Array.from({ length: 4 }, (_, relay) => ["r", `wss://person${index}-relay${relay}.example.com`]))]));
    mock.query.mockImplementation(async filter => ({ complete: true, events: [lists.get(filter.authors[0])], relays: {} }));
    const routes = await publicationRoutes(crowded);
    expect(routes.targets).toHaveLength(12); expect(routes.limited).toBe(true);
    expect(routes.sources).toHaveLength(5); expect(routes.targets).toContain("wss://fallback.example.com");
    for (const source of routes.sources) {
        const advertised = lists.get(source.pubkey)!.tags.map(tag => tag[1]);
        expect(routes.targets.some(target => advertised.includes(target))).toBe(true);
    }
});
