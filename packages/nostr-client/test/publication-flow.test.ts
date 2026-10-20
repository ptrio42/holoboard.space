import { afterEach, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools';
import type { PublicationStore } from '../src/core/storage/publicationStore';
import type { Publisher } from '../src/core/transport/nostrTransport';
import { createClientHost } from './fixtures/host';
import { createPublicCache, createPublicOutbox } from '../src/core/storage/publicScope';
import { createPublicationFlow } from '../src/core/publication/publicationFlow';
import { memoryStore } from './publication-support';

const local = 'ws://127.0.0.1:49152', network = 'ws://127.0.0.1:49153';
const asset = 'http://127.0.0.1:4173/fixtures/sample.gif';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const cleanup: (() => Promise<void>)[] = [];
function setup(store = memoryStore()) {
  const key = generateSecretKey(), principal = getPublicKey(key);
  const signer = { generation: 0, getPublicKey: vi.fn(async () => principal), signEvent: vi.fn(async (template: EventTemplate): Promise<Event> => finalizeEvent(template, key)) };
  const host = createClientHost({ identity: { appId: 'nest-rel-prototype', principal, localRelay: local }, networkRelay: network, mediaUrls: [asset], signer, query: vi.fn() });
  const cache = createPublicCache(host.identity, host.policy);
  const publish = vi.fn<Publisher>(async (event, urls) => ({ id: event.id, relays: Object.fromEntries(urls.map(url => [url, { state: 'accepted' as const }])) }));
  const outbox = createPublicOutbox(host.identity, host.policy, publish, store);
  const flow = createPublicationFlow(host, cache, outbox);
  host.updateDraft({ text: 'A public fixture draft', attachments: [] });
  cleanup.push(async () => { flow.dispose(); host.dispose(); cache.dispose(); await outbox.dispose(); });
  return { key, signer, host, cache, publish, outbox, flow, store };
}
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

test('review, sign/save and explicit send are separate; navigation/list/reload never publishes', async () => {
  const { flow, host, signer, outbox, publish } = setup();
  await expect(flow.signAndSave()).rejects.toThrow(/review/i);
  flow.review(); expect(signer.signEvent).not.toHaveBeenCalled();
  const record = await flow.signAndSave();
  expect(record.event).toMatchObject({ kind: 1, content: host.snapshot().draft.text, tags: [] });
  expect(publish).not.toHaveBeenCalled();
  host.navigate('content'); host.navigate('compose'); await flow.refresh();
  expect(await outbox.list()).toHaveLength(1); expect(publish).not.toHaveBeenCalled();
  await flow.send(record.id); expect(publish).toHaveBeenCalledTimes(1); expect(signer.signEvent).toHaveBeenCalledTimes(1);
});

test.each(['text', 'attachments', 'principal', 'generation', 'destinations', 'policy', 'cancel'])('invalidates review on %s changes', async change => {
  const { flow, host, signer } = setup(); flow.review();
  if (change === 'text') host.updateDraft({ ...host.snapshot().draft, text: 'edited' });
  if (change === 'attachments') host.updateDraft({ ...host.snapshot().draft, attachments: [{ url: 'http://127.0.0.1:4173/asset', type: 'image/png', alt: '' }] });
  if (change === 'principal') signer.getPublicKey.mockResolvedValue('f'.repeat(64));
  if (change === 'generation') signer.generation++;
  if (change === 'destinations') flow.setDestinations([]);
  if (change === 'policy') host.setMode('network');
  if (change === 'cancel') flow.cancel();
  await expect(flow.signAndSave()).rejects.toThrow(); expect(signer.signEvent).not.toHaveBeenCalled();
});

test.each(['key', 'sign'].flatMap(stage => ['text', 'generation', 'policy', 'cancel'].map(change => [stage, change])))('ignores stale asynchronous %s completion after %s', async (stage, change) => {
  const { flow, host, signer, key, outbox } = setup();
  const pendingKey = deferred<string>(), pendingSign = deferred<Event>(); let template!: EventTemplate;
  if (stage === 'key') signer.getPublicKey.mockReturnValue(pendingKey.promise);
  else signer.signEvent.mockImplementation(value => { template = value; return pendingSign.promise; });
  flow.review(); const pending = flow.signAndSave(); const rejected = expect(pending).rejects.toThrow(/changed|cancel/i);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  if (change === 'text') host.updateDraft({ text: 'new draft', attachments: [] });
  if (change === 'generation') signer.generation++;
  if (change === 'policy') host.setMode('network');
  if (change === 'cancel') flow.cancel();
  if (stage === 'key') pendingKey.resolve(host.identity.principal); else pendingSign.resolve(finalizeEvent(template, key));
  await rejected; expect(await outbox.list()).toEqual([]);
});

test.each(['cancelled', 'body', 'signature', 'mutated-template', 'author'])('rejects %s signer results before saving', async mode => {
  const { flow, signer, key, outbox, host } = setup();
  signer.signEvent.mockImplementation(async template => {
    if (mode === 'cancelled') throw Error('Sensitive signer cancellation');
    if (mode === 'mutated-template') template.content = 'mutated';
    const event = finalizeEvent({ ...template, content: mode === 'body' ? 'forged' : template.content }, mode === 'author' ? generateSecretKey() : key);
    if (mode === 'signature') event.sig = '0'.repeat(128);
    return event;
  });
  flow.review(); await expect(flow.signAndSave()).rejects.toThrow();
  expect(await outbox.list()).toEqual([]); expect(host.snapshot().draft.text).toBe('A public fixture draft');
});

test('late successful save remains durable history requiring a fresh explicit saved-event review', async () => {
  const base = memoryStore(), gate = deferred<void>();
  const { flow, host, publish } = setup({ read: base.read, change: async update => { await gate.promise; return base.change(update); } });
  flow.review(); const pending = flow.signAndSave(); const rejected = expect(pending).rejects.toThrow(/saved|changed/i);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  host.updateDraft({ text: 'changed during save', attachments: [] }); gate.resolve(); await rejected;
  await flow.refresh(); const record = (await base.read())[0]; expect(record).toBeDefined();
  await expect(flow.send(record.id)).rejects.toThrow(/review/i); expect(publish).not.toHaveBeenCalled();
  await flow.reviewSaved(record.id); await flow.send(record.id); expect(publish).toHaveBeenCalledTimes(1);
});

test('save failure preserves draft and prevents delivery', async () => {
  const { flow, host, publish } = setup({ read: async () => [], change: async () => { throw Error('disk full'); } });
  flow.review(); await expect(flow.signAndSave()).rejects.toThrow(/save/i);
  expect(host.snapshot().draft.text).toBe('A public fixture draft');
  await expect(flow.send('0'.repeat(64))).rejects.toThrow(); expect(publish).not.toHaveBeenCalled();
});

test('partial delivery and restored history retry the exact saved event and preserve accepted destinations', async () => {
  const { flow, host, publish, signer, cache, outbox } = setup(); host.setMode('network'); flow.setDestinations([local, network]);
  publish.mockImplementationOnce(async event => ({ id: event.id, relays: { [local]: { state: 'accepted' }, [network]: { state: 'uncertain' } } }));
  flow.review(); const saved = await flow.signAndSave(); await flow.send(saved.id);
  const restored = createPublicationFlow(host, cache, outbox);
  await restored.refresh(); expect(restored.snapshot().records[0].relays[network].state).toBe('uncertain');
  await expect(restored.send(saved.id)).rejects.toThrow(/review/i);
  await restored.reviewSaved(saved.id); await restored.send(saved.id);
  expect(publish.mock.calls[1][0]).toEqual(saved.event); expect(publish.mock.calls[1][1]).toEqual([network]);
  expect(signer.signEvent).toHaveBeenCalledTimes(1); restored.dispose();
});

test('replies require public-source cache provenance and use the original verified ancestry', async () => {
  const { flow, host, cache, key } = setup();
  const root = finalizeEvent({ kind: 1, content: 'root', tags: [], created_at: 1 }, key);
  const parent = finalizeEvent({ kind: 1, content: 'reply', tags: [['e', root.id, '', 'root', root.pubkey]], created_at: 2 }, key);
  flow.setReply(parent.id); expect(() => flow.review()).toThrow(/public|parent/i);
  expect(() => cache.put(parent, { visibility: 'private', relay: local })).toThrow();
  cache.put(parent, { visibility: 'public', relay: local }); expect(() => flow.review()).toThrow(/context/i);
  cache.put(root, { visibility: 'public', relay: local }); flow.review();
  const saved = await flow.signAndSave();
  expect(saved.event.tags).toContainEqual(['e', root.id, '', 'root', root.pubkey]);
  expect(saved.event.tags).toContainEqual(['e', parent.id, '', 'reply', parent.pubkey]);
  host.setMode('network'); const networkRoot = finalizeEvent({ ...root, content: 'network root' }, key);
  cache.put(networkRoot, { visibility: 'public', relay: network }); flow.setReply(networkRoot.id); flow.review();
  host.setMode('community'); await expect(flow.signAndSave()).rejects.toThrow();
});

test('stale list completion cannot overwrite a newer accepted receipt', async () => {
  const { flow, outbox } = setup(); flow.review(); const record = await flow.signAndSave();
  const oldRecords = await outbox.list();
  const gate = deferred<typeof oldRecords>(); vi.spyOn(outbox, 'list').mockImplementationOnce(() => gate.promise);
  const pending = flow.refresh(); await flow.send(record.id);
  expect(flow.snapshot().records[0].relays[local].state).toBe('accepted');
  gate.resolve(oldRecords); await pending;
  expect(flow.snapshot().records[0].relays[local].state).toBe('accepted');
});

test('cancelled asynchronous saved-event review cannot authorize send', async () => {
  const { flow, outbox, publish } = setup(); flow.review(); const record = await flow.signAndSave();
  const records = await outbox.list(), gate = deferred<typeof records>();
  vi.spyOn(outbox, 'list').mockImplementationOnce(() => gate.promise);
  const pending = flow.reviewSaved(record.id), rejection = expect(pending).rejects.toThrow(/changed/);
  flow.cancel(); gate.resolve(records); await rejection;
  await expect(flow.send(record.id)).rejects.toThrow(/review/i); expect(publish).not.toHaveBeenCalled();
});

test('root notes preserve borrowed content and attachment limits and owned metadata tags', async () => {
  const { flow, host, signer } = setup();
  const item = { url: asset, type: 'image/gif', alt: 'Owned simulation' };
  host.updateDraft({ text: 'x'.repeat(16385), attachments: [] }); expect(() => flow.review()).toThrow(/16 KiB/);
  host.updateDraft({ text: '😀'.repeat(4097), attachments: [] }); expect(() => flow.review()).toThrow(/16 KiB/);
  host.updateDraft({ text: asset, attachments: Array(9).fill(item) }); expect(() => flow.review()).toThrow(/eight/);
  host.updateDraft({ text: asset, attachments: [{ ...item, alt: 'line\nbreak' }] }); expect(() => flow.review()).toThrow(/metadata/);
  host.updateDraft({ text: 'https://unowned.invalid/file.png', attachments: [{ ...item, url: 'https://unowned.invalid/file.png' }] }); expect(() => flow.review()).toThrow(/owned/);
  expect(signer.signEvent).not.toHaveBeenCalled();
  host.updateDraft({ text: asset, attachments: [item] }); flow.review();
  expect((await flow.signAndSave()).event.tags).toEqual([['imeta', `url ${asset}`, 'm image/gif', 'alt Owned simulation']]);
});

test.each(['pending', 'partly-accepted'])('same-event save cannot authorize historical extra destinations (%s)', async outcome => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    const { flow, host, outbox, publish, signer } = setup();
    host.setMode('network'); flow.setDestinations([local, network]); flow.review();
    const original = await flow.signAndSave();
    if (outcome === 'partly-accepted') {
      publish.mockImplementationOnce(async event => ({ id: event.id, relays: { [local]: { state: 'accepted' }, [network]: { state: 'uncertain' } } }));
      await flow.send(original.id);
    }
    const before = await outbox.list(), sends = publish.mock.calls.length;
    // Keep the exact signature too, so this case isolates destination widening.
    signer.signEvent.mockResolvedValueOnce(original.event);
    flow.setDestinations([local]); flow.review();
    await expect(flow.signAndSave()).rejects.toThrow(/saved|review/i);
    expect(flow.snapshot().readyId).toBeUndefined();
    await expect(flow.send(original.id)).rejects.toThrow(/review/i);
    expect(publish).toHaveBeenCalledTimes(sends);
    expect(await outbox.list()).toEqual(before);
    await flow.reviewSaved(original.id); await flow.send(original.id);
    expect(publish.mock.calls.at(-1)![1]).toEqual(outcome === 'partly-accepted' ? [network] : [local, network]);
    expect(publish.mock.calls.at(-1)![0]).toEqual(original.event);
  } finally { clock.mockRestore(); }
});

test('another enqueue during save cannot expand the reviewed destinations', async () => {
  const base = memoryStore(), gate = deferred<void>(), entered = deferred<void>(); let pause = false;
  const { flow, host, outbox, signer, publish } = setup({ read: base.read, change: async update => {
    if (pause) { pause = false; entered.resolve(); await gate.promise; }
    return base.change(update);
  } });
  host.setMode('network'); flow.review(); pause = true;
  const pending = flow.signAndSave(), rejection = expect(pending).rejects.toThrow(/saved|review/i);
  await entered.promise;
  const signed = await signer.signEvent.mock.results[0].value;
  await outbox.enqueue(signed, [network], { type: 'authored-public', principal: host.identity.principal });
  gate.resolve(); await rejection;
  const stored = (await outbox.list())[0];
  expect(Object.keys(stored.relays).sort()).toEqual([local, network].sort());
  expect(stored.event).toEqual(signed);
  expect(flow.snapshot().readyId).toBeUndefined();
  await expect(flow.send(stored.id)).rejects.toThrow(/review/i); expect(publish).not.toHaveBeenCalled();
  await flow.reviewSaved(stored.id); await flow.send(stored.id);
  expect(publish).toHaveBeenCalledTimes(1);
});

test.each(['body', 'signature'])('save result cannot substitute the reviewed signed %s', async change => {
  const { flow, outbox, key, publish } = setup();
  const enqueue = outbox.enqueue.bind(outbox);
  vi.spyOn(outbox, 'enqueue').mockImplementationOnce(async (...args) => {
    const stored = await enqueue(...args);
    const altered = change === 'body' ? finalizeEvent({ ...stored.event, content: 'Different signed content' }, key) : { ...stored.event, sig: '0'.repeat(128) };
    return { ...stored, id: altered.id, event: altered };
  });
  flow.review(); await expect(flow.signAndSave()).rejects.toThrow(/saved|review/i);
  expect(flow.snapshot().readyId).toBeUndefined();
  const stored = (await outbox.list())[0]; expect(stored.event.content).toBe('A public fixture draft');
  await expect(flow.send(stored.id)).rejects.toThrow(/review/i); expect(publish).not.toHaveBeenCalled();
});

test.each(['delivery-read', 'checkpoint'])('concurrent target expansion at %s cannot widen the actual publication', async stage => {
  const base = memoryStore(), entered = deferred<void>(), release = deferred<void>();
  let active = false, reads = 0;
  const store: PublicationStore = {
    read: async () => {
      if (active && stage === 'delivery-read' && ++reads === 2) { entered.resolve(); await release.promise; }
      return base.read();
    },
    change: async update => {
      if (active && stage === 'checkpoint') { active = false; entered.resolve(); await release.promise; }
      return base.change(update);
    },
  };
  const { flow, host, outbox, publish, signer } = setup(store);
  host.setMode('network'); flow.review(); const saved = await flow.signAndSave();
  active = true; const pending = flow.send(saved.id), rejection = expect(pending).rejects.toThrow(/review|delivery/i);
  await entered.promise;
  await outbox.enqueue(saved.event, [network], { type: 'authored-public', principal: host.identity.principal });
  release.resolve(); await rejection;
  expect(publish).not.toHaveBeenCalled(); expect(signer.signEvent).toHaveBeenCalledTimes(1);
  const history = await outbox.list();
  expect(JSON.stringify(history[0].event)).toBe(JSON.stringify(saved.event));
  expect(Object.keys(history[0].relays).sort()).toEqual([local, network].sort());
  await flow.reviewSaved(saved.id); await flow.send(saved.id);
  expect(publish.mock.calls[0][1].sort()).toEqual([local, network].sort());
});

test('delivery-boundary recheck preserves an accepted destination while refusing a newly added one', async () => {
  const base = memoryStore(), entered = deferred<void>(), release = deferred<void>(); let pause = false, reads = 0;
  const { flow, host, outbox, publish } = setup({ change: base.change, read: async () => {
    if (pause && ++reads === 2) { entered.resolve(); await release.promise; }
    return base.read();
  } });
  host.setMode('network'); flow.review(); const saved = await flow.signAndSave(); await flow.send(saved.id);
  expect((await outbox.list())[0].relays[local].state).toBe('accepted');
  await flow.reviewSaved(saved.id);
  pause = true; const pending = flow.send(saved.id), rejection = expect(pending).rejects.toThrow(/review|delivery/i);
  await entered.promise;
  await outbox.enqueue(saved.event, [network], { type: 'authored-public', principal: host.identity.principal });
  release.resolve(); await rejection;
  expect(publish).toHaveBeenCalledTimes(1);
  expect((await outbox.list())[0].relays[local].state).toBe('accepted');
  await flow.reviewSaved(saved.id); await flow.send(saved.id);
  expect(publish.mock.calls[1][1]).toEqual([network]);
});

test.each(['signature', 'signer-generation'])('actual delivery refuses a changed %s after the preflight read', async change => {
  const base = memoryStore(), entered = deferred<void>(), release = deferred<void>(); let pause = false, reads = 0;
  const { flow, host, outbox, publish, key, signer } = setup({ change: base.change, read: async () => {
    if (pause && ++reads === 2) { entered.resolve(); await release.promise; }
    return base.read();
  } });
  host.setMode('network'); flow.review(); const saved = await flow.signAndSave();
  pause = true; const pending = flow.send(saved.id), rejection = expect(pending).rejects.toThrow(/review|delivery/i);
  await entered.promise;
  if (change === 'signature') {
    const alternate = finalizeEvent({ kind: saved.event.kind, content: saved.event.content, tags: saved.event.tags, created_at: saved.event.created_at }, key);
    expect(alternate.id).toBe(saved.id); expect(alternate.sig).not.toBe(saved.event.sig);
    await base.change(records => records.map(record => record.id === saved.id ? { ...record, event: alternate } : record));
  } else signer.generation++;
  release.resolve(); await rejection;
  expect(publish).not.toHaveBeenCalled(); expect(signer.signEvent).toHaveBeenCalledTimes(1);
  expect((await outbox.list())[0].id).toBe(saved.id);
});
