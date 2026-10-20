import { afterEach, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { createContentPolicy } from './fixtures/policy';
import { createPublicCache, createPublicOutbox, hostNamespace } from '../src/core/storage/publicScope';
import type { PublicationRecord } from '../src/core/storage/publicOutbox';
import type { PublicationStore } from '../src/core/storage/publicationStore';
import { IndexedPublicationStore } from '../src/core/storage/publicationStore';
import type { Publisher } from '../src/core/transport/nostrTransport';
import type { HostIdentity } from './fixtures/ports';

const local = 'ws://127.0.0.1:49152', network = 'ws://127.0.0.1:49153';
const key = generateSecretKey();
const identity: HostIdentity = { appId: 'nest-rel-prototype', principal: getPublicKey(key), localRelay: local };
const note = (kind = 1, content = 'public fixture note') => finalizeEvent({ kind, content, tags: [], created_at: 123 }, key);
function memory() {
  let records: PublicationRecord[] = [];
  const store: PublicationStore = { read: async () => structuredClone(records), change: async update => { records = structuredClone(update(structuredClone(records))); return structuredClone(records); } };
  return store;
}
const intent = { type: 'authored-public' as const, principal: identity.principal };
const accepted = vi.fn<Publisher>(async (event, urls) => ({ id: event.id, relays: Object.fromEntries(urls.map(url => [url, { state: 'accepted' as const }])) }));
afterEach(() => { vi.unstubAllGlobals(); accepted.mockClear(); });

test('private familiar-kind source is excluded from public cache, including owner-only fixture content', () => {
  const policy = createContentPolicy(local, network), cache = createPublicCache(identity, policy);
  const event = note(1, 'owner private fixture');
  expect(() => cache.put(event, { visibility: 'private', relay: local })).toThrow(/public/);
  expect(cache.query({})).toEqual([]);
  expect(() => cache.put(event, { visibility: 'public', relay: 'wss://unowned.invalid' })).toThrow(/public/);
});
test.each([22242, 78, 30078, 4, 1059, 27235])('rejects kind %s in public cache and outbox even with a public source claim', async kind => {
  const policy = createContentPolicy(local, network), cache = createPublicCache(identity, policy);
  const outbox = createPublicOutbox(identity, policy, accepted, memory());
  expect(() => cache.put(note(kind), { visibility: 'public', relay: local })).toThrow(/public/);
  await expect(outbox.enqueue(note(kind), [local], intent)).rejects.toThrow(/public/);
  expect(await outbox.list()).toEqual([]);
});
test('signature verification runs before storage and strips arbitrary secret fields', async () => {
  const policy = createContentPolicy(local), cache = createPublicCache(identity, policy), store = memory();
  const outbox = createPublicOutbox(identity, policy, accepted, store);
  const event = note();
  expect(() => cache.put({ ...event, content: 'forged' }, { visibility: 'public', relay: local })).toThrow(/verified/i);
  await expect(outbox.enqueue({ ...event, sig: 'f'.repeat(128) }, [local], intent)).rejects.toThrow(/verified/i);
  await outbox.enqueue(Object.assign({}, event, { signerSecret: 'must-not-persist' }), [local], intent);
  expect(JSON.stringify(await store.read())).not.toContain('must-not-persist');
  expect(accepted).not.toHaveBeenCalled();
});
test('public authored intent cannot be substituted with a private source or another principal', async () => {
  const policy = createContentPolicy(local), outbox = createPublicOutbox(identity, policy, accepted, memory());
  await expect(outbox.enqueue(note(), [local], { visibility: 'private', relay: local } as never)).rejects.toThrow(/intent/);
  await expect(outbox.enqueue(note(), [local], { ...intent, principal: 'f'.repeat(64) })).rejects.toThrow(/intent/);
});
test('network-only cached events disappear in community while shared local provenance remains visible', () => {
  const policy = createContentPolicy(local, network), cache = createPublicCache(identity, policy);
  policy.setMode('network');
  const remote = note(1, 'network only'), both = note(1, 'both');
  cache.put(remote, { visibility: 'public', relay: network });
  cache.put(both, { visibility: 'public', relay: network });
  cache.put(both, { visibility: 'public', relay: local });
  expect(cache.query({})).toHaveLength(2);
  policy.setMode('community');
  expect(cache.query({ limit: 1 }).map(event => event.id)).toEqual([both.id]);
  expect(cache.sources(remote.id)).toEqual([]);
  expect(cache.sources(both.id)).toEqual([local]);
});
test('host and principal isolate cache, draft namespaces and outbox records', async () => {
  const policy = createContentPolicy(local), otherHost = { ...identity, appId: 'holoboard-prototype' as const }, otherPrincipal = { ...identity, principal: 'b'.repeat(64) };
  expect(new Set([identity, otherHost, otherPrincipal].map(hostNamespace)).size).toBe(3);
  const cache = createPublicCache(identity, policy), otherCache = createPublicCache(otherHost, policy);
  cache.put(note(), { visibility: 'public', relay: local });
  expect(otherCache.query({})).toEqual([]);
  const store = memory();
  await createPublicOutbox(identity, policy, accepted, store).enqueue(note(), [local], intent);
  for (const scope of [otherHost, otherPrincipal]) await expect(createPublicOutbox(scope, policy, accepted, store).list()).rejects.toThrow(/scoped/);
});
test('restored records require durable public author provenance, not merely familiar kind and signature', async () => {
  const store = memory();
  await store.change(() => [{ id: note().id, event: note(), createdAt: 1, attempts: 0, relays: { [local]: { state: 'pending' } } }]);
  await expect(createPublicOutbox(identity, createContentPolicy(local), accepted, store).list()).rejects.toThrow(/intent/);
});
test('queued and restored network targets obey current policy and accepted outcomes survive disabling network', async () => {
  const policy = createContentPolicy(local, network), store = memory();
  policy.setMode('network');
  const outbox = createPublicOutbox(identity, policy, accepted, store), event = note();
  await outbox.enqueue(event, [local, network], intent);
  expect(accepted).not.toHaveBeenCalled();
  policy.setMode('community');
  const restored = createPublicOutbox(identity, policy, accepted, store);
  expect(await restored.list()).toHaveLength(1);
  const first = await restored.send(event.id);
  expect(first.relays[local].state).toBe('accepted');
  expect(first.relays[network].state).toBe('not-sent');
  expect(accepted.mock.calls[0][1]).toEqual([local]);
  policy.setMode('network');
  await Promise.resolve();
  expect(accepted).toHaveBeenCalledTimes(1);
  const second = await restored.send(event.id);
  expect(accepted.mock.calls[1][1]).toEqual([network]);
  expect(second.relays[network].state).toBe('accepted');
  policy.setMode('community');
  expect((await restored.list())[0].relays[network].state).toBe('accepted');
  await restored.send(event.id);
  expect(accepted).toHaveBeenCalledTimes(2);
});
test('a mode change while storage is queued rechecks targets before invoking the publication port', async () => {
  const policy = createContentPolicy(local, network), store = memory(); policy.setMode('network');
  const outbox = createPublicOutbox(identity, policy, accepted, store);
  await outbox.enqueue(note(), [network], intent);
  const pending = outbox.send(note().id);
  policy.setMode('community');
  expect((await pending).relays[network].state).toBe('not-sent');
  expect(accepted).not.toHaveBeenCalled();
});
test('late publication result ignoring abort stays uncertain and cannot overwrite an already observed receipt', async () => {
  const policy = createContentPolicy(local, network); policy.setMode('network');
  let finish!: (value: Awaited<ReturnType<Publisher>>) => void;
  let signal: AbortSignal | undefined;
  const port: Publisher = (event, _urls, options) => {
    signal = options?.signal; options?.onOutcome?.(local, { state: 'accepted' });
    return new Promise(resolve => { finish = resolve; });
  };
  const store = memory(), outbox = createPublicOutbox(identity, policy, port, store);
  await outbox.enqueue(note(), [local, network], intent);
  const pending = outbox.send(note().id);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  policy.setMode('community'); expect(signal?.aborted).toBe(true);
  finish({ id: note().id, relays: { [local]: { state: 'accepted' }, [network]: { state: 'accepted' } } });
  const result = await pending;
  expect(result.relays[local].state).toBe('accepted'); expect(result.relays[network].state).toBe('uncertain');
  expect((await outbox.list())[0].relays).toEqual(result.relays);
});
test('indexed stores and host caches construct lazily with different database names', async () => {
  const open = vi.fn(() => { throw new Error('test stops before opening storage'); });
  vi.stubGlobal('indexedDB', { open });
  const policy = createContentPolicy(local);
  createPublicCache(identity, policy);
  const a = createPublicOutbox(identity, policy, accepted), b = createPublicOutbox({ ...identity, principal: 'b'.repeat(64) }, policy, accepted);
  expect(open).not.toHaveBeenCalled();
  await expect(a.list()).rejects.toThrow(); await expect(b.list()).rejects.toThrow();
  expect(open).toHaveBeenCalledTimes(2); expect(open.mock.calls[0]).not.toEqual(open.mock.calls[1]);
  a.dispose(); b.dispose();
  const closed = new IndexedPublicationStore(`${hostNamespace(identity)}:outbox-v1`); closed.dispose();
  await expect(closed.read()).rejects.toThrow(/disposed/);
  expect(open).toHaveBeenCalledTimes(2);
});
test('borrowed media rendering rejects unowned image and video/poster URLs before embedding', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HostContext } = await import('./fixtures/context');
  const { createClientHost } = await import('./fixtures/host');
  const { NoteContent } = await import('../src/react/content/NoteContent');
  const host = createClientHost({ identity, signer: { generation: 0, getPublicKey: vi.fn(), signEvent: vi.fn() }, query: vi.fn() });
  const html = renderToStaticMarkup(createElement(HostContext, { value: host }, createElement(NoteContent, {
    text: 'https://unowned.invalid/image.png https://unowned.invalid/video.mp4', initiallyExpanded: true,
  })));
  expect(html).not.toMatch(/<(?:img|video)[^>]*src="https:\/\/unowned/);
  host.dispose();
});

test('network deletion cannot hide primary local data after network mode is disabled', () => {
  const policy = createContentPolicy(local, network), cache = createPublicCache(identity, policy), event = note();
  cache.put(event, { visibility: 'public', relay: local });
  policy.setMode('network');
  cache.put(finalizeEvent({ kind: 5, content: '', tags: [['e', event.id]], created_at: 124 }, key), { visibility: 'public', relay: network });
  expect(cache.query({ kinds: [1] })).toEqual([]);
  policy.setMode('community');
  expect(cache.query({ kinds: [1] }).map(item => item.id)).toEqual([event.id]);
});
test('simulated upload and GIF ports use exact owned assets, borrowed attachment validation and no providers or signer', async () => {
  const { createHostMedia } = await import('./fixtures/media');
  const asset = 'http://127.0.0.1:4173/fixtures/sample.gif';
  const policy = createContentPolicy(local, network, [asset]);
  const forbidden = vi.fn(() => { throw new Error('Unexpected provider contact'); });
  vi.stubGlobal('fetch', forbidden); vi.stubGlobal('XMLHttpRequest', forbidden);
  const media = createHostMedia(policy, { upload: { url: asset, type: 'image/gif', alt: '' }, gifs: [{ url: asset, preview: asset, title: 'Fixture hello' }] });
  const progress = vi.fn(), signal = new AbortController().signal;
  const file = new File(['local bytes'], 'local.txt', { type: 'text/plain' });
  expect(await media.uploadMedia(file, media.MEDIA_SERVERS[0], forbidden, signal, progress)).toEqual({ url: asset, type: 'image/gif', alt: '' });
  expect(progress.mock.calls).toEqual([[0], [100]]);
  expect(await media.searchComposerGifs('hello', signal)).toEqual([{ url: asset, preview: asset, title: 'Fixture hello' }]);
  expect(await media.searchComposerGifs('unmatched', signal)).toEqual([]);
  expect(media.attachmentTags([{ url: asset, type: 'image/gif', alt: 'preview' }], asset)).toEqual([['imeta', `url ${asset}`, 'm image/gif', 'alt preview']]);
  expect(() => media.attachmentTags([{ url: asset, type: 'bad', alt: '' }], asset)).toThrow(/metadata/);
  for (const url of ['https://gifs.nostr.build/sample.gif', 'http://127.0.0.1:4173/other.gif', 'blob:untrusted']) expect(() => media.mediaUrl(url)).toThrow(/owned/);
  await expect(media.uploadMedia(file, { name: 'unowned', protocol: 'blossom', url: 'https://blossom.primal.net' }, forbidden, signal, progress)).rejects.toThrow(/bound/);
  expect(forbidden).not.toHaveBeenCalled();
});
test('unbound media stays inert and simulated completions stop at abort or policy-generation change', async () => {
  const { createHostMedia } = await import('./fixtures/media');
  const asset = 'http://127.0.0.1:4173/fixtures/sample.gif', policy = createContentPolicy(local, network, [asset]);
  const unbound = createHostMedia(policy);
  expect(unbound.gifSearchAvailable()).toBe(false);
  await expect(unbound.searchComposerGifs('', new AbortController().signal)).rejects.toThrow(/unavailable/);
  const media = createHostMedia(policy, { upload: { url: asset, type: 'image/gif', alt: '' }, gifs: [{ url: asset, preview: asset, title: 'Fixture' }] });
  const controller = new AbortController();
  const pending = media.searchComposerGifs('', controller.signal); controller.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  const upload = media.uploadMedia(new File(['x'], 'x'), media.MEDIA_SERVERS[0], vi.fn(), new AbortController().signal, vi.fn());
  policy.setMode('network');
  await expect(upload).rejects.toThrow(/cancelled/);
  expect(() => createHostMedia(policy, { upload: { url: 'https://unowned.invalid/file', type: 'image/png', alt: '' }, gifs: [] })).toThrow(/owned/);
});
test('borrowed gallery keeps owned images but removes unowned video posters and editor attachments before embedding', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HostContext } = await import('./fixtures/context');
  const { createClientHost } = await import('./fixtures/host');
  const { NoteMediaGallery } = await import('../src/react/content/NoteMediaGallery');
  const { NoteEditor } = await import('../src/react/editor/NoteEditor');
  const asset = 'http://127.0.0.1:4173/fixtures/sample.gif', video = 'http://127.0.0.1:4173/fixtures/video.mp4';
  const host = createClientHost({ identity, mediaUrls: [asset, video], signer: { generation: 0, getPublicKey: vi.fn(), signEvent: vi.fn() }, query: vi.fn() });
  const html = renderToStaticMarkup(createElement(HostContext, { value: host }, createElement(NoteMediaGallery, {
    items: [{ kind: 'image', src: asset }, { kind: 'video', src: video, poster: 'https://unowned.invalid/poster.png' }],
  })));
  expect(html).toContain(`src="${asset}"`); expect(html).not.toContain('unowned.invalid');
  const editor = renderToStaticMarkup(createElement(HostContext, { value: host }, createElement(NoteEditor, {
    text: '', attachments: [{ url: 'https://unowned.invalid/image.png', type: 'image/png', alt: '' }],
    onChange: vi.fn(), onAttachmentsChange: vi.fn(), onPendingChange: vi.fn(), onReview: vi.fn(),
  })));
  expect(editor).not.toMatch(/<img[^>]*src="https:\/\/unowned/);
  host.dispose();
});
test('disposing a public outbox cancels an in-flight delivery before its publication port sends EVENT', async () => {
  const policy = createContentPolicy(local), store = memory();
  let signal!: AbortSignal; let finish!: () => void;
  const eventSent = vi.fn();
  const publish: Publisher = async (event, urls, options) => {
    signal = options!.signal!;
    await new Promise<void>(resolve => { finish = resolve; });
    if (!signal.aborted) eventSent();
    return { id: event.id, relays: Object.fromEntries(urls.map(url => [url, { state: 'not-sent' as const }])) };
  };
  const outbox = createPublicOutbox(identity, policy, publish, store);
  await outbox.enqueue(note(), [local], intent);
  const pending = outbox.send(note().id);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const closing = outbox.dispose(); expect(signal.aborted).toBe(true); finish();
  expect((await pending).relays[local].state).toBe('uncertain');
  await closing;
  expect(eventSent).not.toHaveBeenCalled();
  expect((await store.read())[0].relays[local].state).toBe('uncertain');
});
test('disposing a public outbox while a send is queued prevents invoking the publication port', async () => {
  const outbox = createPublicOutbox(identity, createContentPolicy(local), accepted, memory());
  await outbox.enqueue(note(), [local], intent);
  const pending = outbox.send(note().id); outbox.dispose();
  await pending;
  expect(accepted).not.toHaveBeenCalled();
});
test('borrowed reply preparation forwards the host media validator without changing ancestry or metadata checks', async () => {
  const { prepareReply } = await import('../src/core/threads/replyPreparation');
  const { createThreadGraph, reduceThreadGraph } = await import('../src/core/threads/threadGraph');
  const { createHostMedia } = await import('./fixtures/media');
  const asset = 'http://127.0.0.1:4173/fixtures/sample.gif';
  const media = createHostMedia(createContentPolicy(local, network, [asset]));
  const parent = note(), graph = reduceThreadGraph(createThreadGraph(), [parent]);
  const attachment = { url: asset, type: 'image/gif', alt: 'fixture preview' };
  const prepared = prepareReply({ parent, graph, content: asset, createdAt: 124, attachments: [attachment], validateMediaUrl: media.mediaUrl });
  expect(prepared.template.tags).toContainEqual(['imeta', `url ${asset}`, 'm image/gif', 'alt fixture preview']);
  expect(prepared.template.tags).toContainEqual(['e', parent.id, '', 'root', parent.pubkey]);
  expect(() => prepareReply({ parent, graph, content: asset, createdAt: 124, attachments: [{ ...attachment, type: 'invalid' }], validateMediaUrl: media.mediaUrl })).toThrow(/metadata/);
});
test('dispose drains already observed accepted outcomes before closing the outbox', async () => {
  const store = memory(), policy = createContentPolicy(local);
  let closing: Promise<void> | undefined;
  let outbox!: ReturnType<typeof createPublicOutbox>;
  const publish: Publisher = async (event, _urls, options) => {
    options?.onOutcome?.(local, { state: 'accepted', detail: 'saved by relay' });
    closing = outbox.dispose();
    return { id: event.id, relays: { [local]: { state: 'accepted', detail: 'saved by relay' } } };
  };
  outbox = createPublicOutbox(identity, policy, publish, store);
  await outbox.enqueue(note(), [local], intent);
  const result = await outbox.send(note().id);
  await closing;
  expect(result.relays[local]).toEqual({ state: 'accepted', detail: 'saved by relay' });
  expect((await store.read())[0].relays[local]).toEqual(result.relays[local]);
});
test('shutdown drains a queued outcome update and rejects every new operation immediately', async () => {
  const underlying = memory(); let writes = 0; let release!: () => void;
  const store: PublicationStore = { read: underlying.read, change: async update => {
    if (++writes === 3) await new Promise<void>(resolve => { release = resolve; });
    return underlying.change(update);
  } };
  const outbox = createPublicOutbox(identity, createContentPolicy(local), accepted, store);
  await outbox.enqueue(note(), [local], intent);
  const pending = outbox.send(note().id);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(release).toBeTypeOf('function');
  const closing = outbox.dispose(); expect(outbox.dispose()).toBe(closing);
  let closed = false; void closing.then(() => { closed = true; });
  await expect(outbox.list()).rejects.toThrow(/disposed/);
  await expect(outbox.enqueue(note(), [local], intent)).rejects.toThrow(/disposed/);
  await expect(outbox.send(note().id)).rejects.toThrow(/disposed/);
  await expect(outbox.forget(note().id)).rejects.toThrow(/disposed/);
  expect(closed).toBe(false);
  release(); await pending; await closing;
  expect((await underlying.read())[0].relays[local].state).toBe('accepted');
});
test('shutdown reports a failed receipt checkpoint instead of suppressing persistence errors', async () => {
  const underlying = memory(); let writes = 0;
  const store: PublicationStore = { read: underlying.read, change: update => {
    if (++writes === 3) return Promise.reject(new Error('fixture disk failure'));
    return underlying.change(update);
  } };
  let closing!: Promise<unknown>;
  let outbox!: ReturnType<typeof createPublicOutbox>;
  const publish: Publisher = async (event, _urls, options) => {
    options?.onOutcome?.(local, { state: 'accepted' });
    closing = outbox.dispose().then(() => undefined, failure => failure);
    return { id: event.id, relays: { [local]: { state: 'accepted' } } };
  };
  outbox = createPublicOutbox(identity, createContentPolicy(local), publish, store);
  await outbox.enqueue(note(), [local], intent);
  await expect(outbox.send(note().id)).rejects.toThrow(/save delivery outcomes/);
  const failure = await closing;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0].cause.message).toBe('fixture disk failure');
  expect((await underlying.read())[0].relays[local].state).toBe('uncertain');
});
test('shutdown is bounded when an injected publication port ignores abort', async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    const publish: Publisher = async event => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { id: event.id, relays: { [local]: { state: 'accepted' } } };
    };
    const store = memory(), outbox = createPublicOutbox(identity, createContentPolicy(local), publish, store);
    await outbox.enqueue(note(), [local], intent);
    const pending = outbox.send(note().id);
    const pendingFailure = pending.catch(failure => failure);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const closing = outbox.dispose(); const failure = closing.catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure).message).toMatch(/shutdown timed out/);
    finish();
    expect((await pendingFailure).message).toMatch(/save delivery outcomes/);
    expect((await store.read())[0].relays[local].state).toBe('uncertain');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
