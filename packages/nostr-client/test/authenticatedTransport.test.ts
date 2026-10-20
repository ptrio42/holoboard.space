import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools';
import { createContentTransport } from '../src/core/transport/contentTransport';
import type { AuthorSigner } from './fixtures/ports';

const relay = 'ws://127.0.0.1:49152';
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: unknown[][] = [];
  constructor(readonly url: string) { super(); Socket.instances.push(this); }
  send(data: string) { if (this.readyState !== 1) throw Error('closed'); this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const resources: { dispose(): void }[] = [];
function setup() {
  vi.stubGlobal('WebSocket', Socket);
  const key = generateSecretKey();
  const principal = getPublicKey(key);
  const signer: AuthorSigner = { generation: 0, getPublicKey: async () => principal,
    signEvent: vi.fn(async template => finalizeEvent(template, key)) };
  const transport = createContentTransport({ principal, signer, relays: [relay], policy: { generation: 0, configuredRelay: url => url === relay, relayAllowed: url => url === relay, mediaAllowed: () => false, onChange: () => () => {} } });
  resources.push(transport);
  const event = finalizeEvent({ kind: 1, content: 'fixture note', tags: [], created_at: 123 }, key);
  return { key, principal, signer, transport, event };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function connected() { await flush(); const socket = Socket.instances.at(-1)!; socket.open(); socket.frame(['AUTH', 'challenge']); await flush(); return socket; }
function proof(socket: Socket) { return socket.sent.find(frame => frame[0] === 'AUTH')?.[1] as Event; }
afterEach(() => { resources.splice(0).forEach(item => item.dispose()); Socket.instances = []; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('authenticated borrowed transport', () => {
  it('is inert until requested and withholds the persisted event until matching AUTH OK', async () => {
    const { transport, signer, event, principal } = setup();
    expect(Socket.instances).toHaveLength(0);
    expect(signer.signEvent).not.toHaveBeenCalled();
    const observed = vi.fn();
    const delivery = transport.publishSignedEvent(event, [relay], { onOutcome: observed });
    const socket = await connected();
    expect(socket.sent.filter(frame => frame[0] === 'EVENT')).toEqual([]);
    const auth = proof(socket);
    expect(auth).toMatchObject({ kind: 22242, content: '', pubkey: principal, tags: [['relay', relay], ['challenge', 'challenge']] });
    expect(auth.created_at).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
    expect(socket.sent.map(frame => frame[0])).toEqual(['AUTH']);
    socket.frame(['OK', 'f'.repeat(64), true, 'unmatched']); await flush();
    expect(socket.sent).toHaveLength(1);
    socket.frame(['OK', auth.id, true, 'authenticated']); await flush();
    expect(socket.sent[1]).toEqual(['EVENT', JSON.parse(JSON.stringify(event))]);
    socket.frame(['OK', event.id, true, 'stored']);
    expect(await delivery).toEqual({ id: event.id, relays: { [relay]: { state: 'accepted', detail: 'stored' } } });
    expect(observed).toHaveBeenCalledWith(relay, { state: 'accepted', detail: 'stored' });
  });
});

it.each(['signing', 'ack'])('invalidates a changed challenge during %s', async phase => {
  const { transport, signer, event, key } = setup();
  let finishSign: ((value: Event) => void) | undefined;
  let requested: EventTemplate | undefined;
  if (phase === 'signing') signer.signEvent = vi.fn(template => {
    requested = template; return new Promise<Event>(resolve => { finishSign = resolve; });
  });
  const delivery = transport.publishSignedEvent(event, [relay]);
  const socket = await connected();
  const oldProof = proof(socket);
  socket.frame(['AUTH', 'new-challenge']);
  finishSign?.(finalizeEvent(requested!, key));
  if (oldProof) socket.frame(['OK', oldProof.id, true, 'old accepted']);
  const result = await delivery;
  expect(result.relays[relay]).toMatchObject({ state: 'not-sent', detail: expect.stringContaining('challenge changed') });
  expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
});

it.each(['signing', 'ack', 'accepted'])('invalidates signer generation during %s', async phase => {
  vi.useFakeTimers();
  const { transport, signer, event, key } = setup();
  let finishSign: ((value: Event) => void) | undefined;
  let requested: EventTemplate | undefined;
  if (phase === 'signing') signer.signEvent = template => {
    requested = template; return new Promise<Event>(resolve => { finishSign = resolve; });
  };
  const delivery = transport.publishSignedEvent(event, [relay]);
  const socket = await connected();
  const auth = proof(socket);
  if (phase === 'accepted') socket.frame(['OK', auth.id, true, 'ok']);
  signer.generation++;
  finishSign?.(finalizeEvent(requested!, key));
  if (phase === 'ack') socket.frame(['OK', auth.id, true, 'ok']);
  await vi.advanceTimersByTimeAsync(20);
  expect((await delivery).relays[relay].state).toBe('not-sent');
  expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
});

it.each(['reject', 'wrong-key', 'wrong-body', 'stale-time', 'invalid-signature', 'mutated-template', 'malformed', 'wrong-principal'])('does not authorize a %s signer result', async mode => {
  const { transport, signer, event, key } = setup();
  if (mode === 'wrong-principal') signer.getPublicKey = async () => 'b'.repeat(64);
  signer.signEvent = async template => {
    if (mode === 'reject') throw Error('AUTH: Sensitive signer diagnostic');
    if (mode === 'malformed') return null as unknown as Event;
    if (mode === 'mutated-template') template.tags[1][1] = 'attacker challenge';
    const signed = finalizeEvent({ ...template,
      content: mode === 'wrong-body' ? 'HTTP proof' : template.content,
      created_at: mode === 'stale-time' ? template.created_at - 60 : template.created_at,
    }, mode === 'wrong-key' ? generateSecretKey() : key);
    // finalizeEvent carries nostr-tools' verified symbol. Keep it while corrupting the signature.
    if (mode === 'invalid-signature') signed.sig = '0'.repeat(128);
    return signed;
  };
  const delivery = transport.publishSignedEvent(event, [relay]);
  const socket = await connected();
  const result = await delivery;
  expect(result.relays[relay].state).toBe('not-sent');
  expect(result.relays[relay].detail).toMatch(/^AUTH:/);
  expect(result.relays[relay].detail).not.toContain('Sensitive');
  expect(socket.sent).toEqual([]);
});

it('rejects AUTH OK false and never mistakes an EVENT ACK for authentication', async () => {
  const { transport, event } = setup();
  const delivery = transport.publishSignedEvent(event, [relay]);
  const socket = await connected();
  socket.frame(['OK', event.id, true, 'out of order']); await flush();
  expect(socket.sent.map(frame => frame[0])).toEqual(['AUTH']);
  socket.frame(['OK', proof(socket).id, false, 'no']);
  expect((await delivery).relays[relay]).toEqual({ state: 'not-sent', detail: 'AUTH: Relay rejected proof.' });
});

it.each(['no-challenge', 'signing', 'ack'])('cancels before EVENT during %s and ignores late completions', async phase => {
  const { transport, signer, event, key } = setup();
  const controller = new AbortController();
  let finishSign: ((value: Event) => void) | undefined;
  let requested: EventTemplate | undefined;
  if (phase === 'signing') signer.signEvent = template => {
    requested = template; return new Promise<Event>(resolve => { finishSign = resolve; });
  };
  const delivery = transport.publishSignedEvent(event, [relay], { signal: controller.signal });
  await flush(); const socket = Socket.instances.at(-1)!; socket.open();
  if (phase !== 'no-challenge') socket.frame(['AUTH', 'challenge']);
  await flush(); controller.abort();
  finishSign?.(finalizeEvent(requested!, key));
  if (proof(socket)) socket.frame(['OK', proof(socket).id, true, 'late']);
  expect((await delivery).relays[relay].state).toBe('not-sent');
  await flush(); expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
});

it('requires a fresh proof on a reconnected socket and ignores the old AUTH ACK', async () => {
  const { transport, event } = setup();
  const first = transport.publishSignedEvent(event, [relay]); const socket = await connected();
  const old = proof(socket); socket.close();
  expect((await first).relays[relay].state).toBe('not-sent');
  const second = transport.publishSignedEvent(event, [relay]); await flush();
  const next = Socket.instances.at(-1)!; next.open(); next.frame(['AUTH', 'fresh challenge']); await flush();
  next.frame(['OK', old.id, true, 'replayed']); await flush();
  expect(next.sent.map(frame => frame[0])).toEqual(['AUTH']);
  next.frame(['OK', proof(next).id, true, 'ok']); await flush();
  next.frame(['OK', event.id, true, 'stored']);
  expect((await second).relays[relay].state).toBe('accepted');
});

it('keeps anonymous reads, principals and host instances in separate pools', async () => {
  const a = setup(), b = setup();
  const query = a.transport.queryNostr({ kinds: [1] }, [relay]);
  const readSocket = await connected();
  expect(a.signer.signEvent).not.toHaveBeenCalled();
  const id = readSocket.sent.find(frame => frame[0] === 'REQ')![1];
  readSocket.frame(['EVENT', id, a.event]); readSocket.frame(['EOSE', id]);
  expect(await query).toMatchObject({ events: [{ id: a.event.id }], sources: { [a.event.id]: [relay] }, relays: { [relay]: 'eose' }, complete: true });
  const first = a.transport.publishSignedEvent(a.event, [relay]); const author = await connected();
  const second = b.transport.publishSignedEvent(b.event, [relay]); const other = await connected();
  expect(new Set([readSocket, author, other]).size).toBe(3);
  expect(proof(author).pubkey).toBe(a.principal); expect(proof(other).pubkey).toBe(b.principal);
  other.frame(['OK', proof(author).id, true, 'wrong principal']); await flush();
  expect(other.sent.map(frame => frame[0])).toEqual(['AUTH']);
  a.transport.dispose();
  expect((await first).relays[relay].state).toBe('not-sent');
  expect(other.readyState).toBe(1);
  b.transport.dispose(); expect((await second).relays[relay].state).toBe('not-sent');
});

it('preserves detailed per-relay outcomes, signed IDs and observer isolation', async () => {
  vi.useFakeTimers();
  const { signer, principal, event } = setup();
  const urls = [49153, 49154, 49155, 49156].map(port => `ws://127.0.0.1:${port}`);
  const transport = createContentTransport({ signer, principal, relays: urls, policy: { generation: 0, configuredRelay: url => urls.includes(url), relayAllowed: url => urls.includes(url), mediaAllowed: () => false, onChange: () => () => {} } }); resources.push(transport);
  const observer = vi.fn(() => { throw Error('observer'); });
  const delivery = transport.publishSignedEvent(event, urls, { timeout: 1000, onOutcome: observer });
  await flush();
  // The donor allows three simultaneous physical dials. Opening them releases the fourth.
  for (const socket of [...Socket.instances]) { socket.open(); socket.frame(['AUTH', `challenge-${socket.url}`]); }
  await flush();
  for (const socket of Socket.instances.filter(socket => socket.readyState === 0)) { socket.open(); socket.frame(['AUTH', `challenge-${socket.url}`]); }
  await flush();
  for (const socket of Socket.instances) socket.frame(['OK', proof(socket).id, socket.url !== urls[3], 'auth']);
  await flush();
  Socket.instances.find(socket => socket.url === urls[0])!.frame(['OK', event.id, true, 'stored']);
  Socket.instances.find(socket => socket.url === urls[1])!.frame(['OK', event.id, false, 'blocked']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await delivery).toMatchObject({ id: event.id, relays: {
    [urls[0]]: { state: 'accepted', detail: 'stored' }, [urls[1]]: { state: 'rejected', detail: 'blocked' },
    [urls[2]]: { state: 'uncertain' }, [urls[3]]: { state: 'not-sent', detail: 'AUTH: Relay rejected proof.' },
  } });
  expect(observer).toHaveBeenCalledTimes(4);
  for (const socket of Socket.instances) for (const frame of socket.sent.filter(frame => frame[0] === 'EVENT')) expect((frame[1] as Event).id).toBe(event.id);
});

it('bounds missing AUTH acknowledgements and keeps missing read completion incomplete', async () => {
  vi.useFakeTimers(); const { transport, event } = setup();
  const delivery = transport.publishSignedEvent(event, [relay], { timeout: 100, authorizationTimeout: 100 }); const socket = await connected();
  socket.frame(['OK', '0'.repeat(64), true, 'unmatched']);
  await vi.advanceTimersByTimeAsync(100);
  expect((await delivery).relays[relay].state).toBe('not-sent');
  expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
  const query = transport.queryNostr({}, [relay], { timeout: 100 }); await connected();
  await vi.advanceTimersByTimeAsync(100);
  expect(await query).toMatchObject({ complete: false, relays: { [relay]: 'timeout' } });
});

it('fails closed for external destinations, default exports and disposed scopes', async () => {
  const { transport, signer, principal, event } = setup();
  expect(() => createContentTransport({ principal, signer, relays: ['https://relay.example'], policy: { generation: 0, onChange: () => () => {} } })).toThrow(/canonical/);
  await expect(transport.publishSignedEvent(event, ['ws://127.0.0.1:49157'])).rejects.toThrow(/destinations/);
  const donor = await import('../src/core/transport/nostrTransport');
  expect(donor).not.toHaveProperty('publishSignedEvent');
  expect(Socket.instances).toHaveLength(0);
  transport.dispose();
  expect((await transport.publishSignedEvent(event, [relay])).relays[relay].state).toBe('not-sent');
  expect(Socket.instances).toHaveLength(0);
});

it('rechecks authorization when a new challenge follows AUTH OK in the same tick', async () => {
  const { transport, event } = setup();
  const delivery = transport.publishSignedEvent(event, [relay]); const socket = await connected();
  socket.frame(['OK', proof(socket).id, true, 'ok']);
  socket.frame(['AUTH', 'replacement before continuation']);
  expect((await delivery).relays[relay].state).toBe('not-sent');
  expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
});

it('reconciles disallowed sockets and queued dials while retaining the permitted local socket', async () => {
  const { signer, principal } = setup();
  const urls = [49152, 49153, 49154, 49155].map(port => `ws://127.0.0.1:${port}`);
  let network = true;
  const transport = createContentTransport({ signer, principal, relays: urls, policy: { generation: 0, configuredRelay: url => urls.includes(url), relayAllowed: url => urls.includes(url), mediaAllowed: () => false, onChange: () => () => {} },
    relayAllowed: url => network || url === relay }); resources.push(transport);
  const query = transport.queryNostr({}, urls); await flush();
  expect(Socket.instances).toHaveLength(3);
  network = false; transport.reconcile(); await flush();
  expect(Socket.instances).toHaveLength(3); // Fourth destination never dials after policy changed.
  const local = Socket.instances.find(socket => socket.url === relay)!;
  expect(local.readyState).toBe(0);
  expect(Socket.instances.filter(socket => socket !== local).every(socket => socket.readyState === 3)).toBe(true);
  local.open(); await flush();
  local.frame(['EOSE', local.sent.find(frame => frame[0] === 'REQ')![1]]);
  expect((await query).relays[relay]).toBe('eose');
});

it('rechecks policy between authentication and EVENT without losing per-relay results', async () => {
  const { signer, principal, event } = setup();
  let allowed = true;
  const transport = createContentTransport({ signer, principal, relays: [relay], policy: { generation: 0, configuredRelay: url => url === relay, relayAllowed: url => url === relay, mediaAllowed: () => false, onChange: () => () => {} }, relayAllowed: () => allowed }); resources.push(transport);
  const delivery = transport.publishSignedEvent(event, [relay]); const socket = await connected();
  socket.frame(['OK', proof(socket).id, true, 'ok']); allowed = false;
  expect((await delivery).relays[relay].state).toBe('not-sent');
  expect(socket.sent.some(frame => frame[0] === 'EVENT')).toBe(false);
});

it('does not share an authenticated pool between two host instances with the same signer', async () => {
  const { signer, principal, event, transport } = setup();
  const other = createContentTransport({ signer, principal, relays: [relay], policy: { generation: 0, configuredRelay: url => url === relay, relayAllowed: url => url === relay, mediaAllowed: () => false, onChange: () => () => {} } }); resources.push(other);
  const first = transport.publishSignedEvent(event, [relay]); const one = await connected();
  one.frame(['OK', proof(one).id, true, 'ok']); await flush(); one.frame(['OK', event.id, true, 'stored']);
  expect((await first).relays[relay].state).toBe('accepted');
  const second = other.publishSignedEvent(event, [relay]); await flush();
  const two = Socket.instances.at(-1)!; expect(two).not.toBe(one);
  two.open(); await flush(); expect(two.sent).toEqual([]);
  other.dispose(); expect((await second).relays[relay].state).toBe('not-sent');
});

it('retains the donor publication concurrency bound while AUTH is pending', async () => {
  const { signer, principal, transport, event, key } = setup();
  const pending = [event, ...[1, 2, 3].map(index => finalizeEvent({ kind: 1, content: `bounded ${index}`, created_at: 123, tags: [] }, key))]
    .map(note => transport.publishSignedEvent(note, [relay]));
  await connected();
  const fifth = await transport.publishSignedEvent(event, [relay]);
  expect(fifth.relays[relay]).toEqual({ state: 'not-sent', detail: 'Publication budget exhausted.' });
  expect(Socket.instances).toHaveLength(1);
  expect(signer.signEvent).toHaveBeenCalledTimes(4);
  expect(principal).toBe(proof(Socket.instances[0]).pubkey);
  transport.dispose();
  expect((await Promise.all(pending)).every(result => result.relays[relay].state === 'not-sent')).toBe(true);
});

it('disposes owned monitors without reconnecting or restoring a signer', async () => {
  vi.useFakeTimers(); const { transport, signer } = setup();
  const statuses = vi.fn(); transport.monitorRelay(relay, statuses);
  const socket = await connected(); expect(statuses).toHaveBeenCalledWith('connected');
  socket.close(); expect(statuses).toHaveBeenCalledWith('offline');
  transport.dispose(); await vi.advanceTimersByTimeAsync(30000);
  expect(Socket.instances).toHaveLength(1);
  expect(signer.signEvent).not.toHaveBeenCalled();
});

it('fails closed if the borrowed factory is used to publish without an author hook', async () => {
  const { event } = setup();
  const { createNostrTransport } = await import('../src/core/transport/nostrTransport');
  const anonymous = createNostrTransport({ candidates: urls => urls.filter(url => url === relay) }); resources.push(anonymous);
  const delivery = anonymous.publishSignedEvent(event, [relay]); const socket = await connected();
  expect((await delivery).relays[relay]).toEqual({ state: 'not-sent', detail: 'AUTH: Author channel required.' });
  expect(socket.sent).toEqual([]);
});
it('gives author approval its own budget and starts the short event ACK deadline only after send', async () => {
  vi.useFakeTimers();
  const { signer, transport, event, key } = setup();
  let finish!: (event: Event) => void;
  let requested!: EventTemplate;
  signer.signEvent = vi.fn(template => { requested = template; return new Promise(resolve => { finish = resolve; }); });
  const delivery = transport.publishSignedEvent(event, [relay]);
  const socket = await connected();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.sent).toEqual([]);
  finish(finalizeEvent(requested, key)); await flush();
  socket.frame(['OK', proof(socket).id, true, 'authenticated']); await flush();
  expect(socket.sent.at(-1)).toEqual(['EVENT', JSON.parse(JSON.stringify(event))]);
  await vi.advanceTimersByTimeAsync(7_999);
  socket.frame(['OK', event.id, true, 'stored']);
  expect((await delivery).relays[relay].state).toBe('accepted');
});
it('bounds author approval, cancels its late signature and keeps unsent receipts honest', async () => {
  vi.useFakeTimers();
  const { signer, transport, event, key } = setup();
  let finish!: (event: Event) => void;
  let requested!: EventTemplate;
  signer.signEvent = vi.fn(template => { requested = template; return new Promise(resolve => { finish = resolve; }); });
  const delivery = transport.publishSignedEvent(event, [relay], { authorizationTimeout: 20_000 });
  const socket = await connected();
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await delivery).relays[relay]).toEqual({ state: 'not-sent', detail: 'AUTH: Authorization deadline exceeded.' });
  finish(finalizeEvent(requested, key)); await flush();
  expect(socket.sent).toEqual([]);
});
it('retains a short missing EVENT acknowledgement after a slow author approval', async () => {
  vi.useFakeTimers();
  const { signer, transport, event, key } = setup();
  let finish!: (event: Event) => void;
  let requested!: EventTemplate;
  signer.signEvent = vi.fn(template => { requested = template; return new Promise(resolve => { finish = resolve; }); });
  const delivery = transport.publishSignedEvent(event, [relay], { timeout: 100 });
  const socket = await connected(); await vi.advanceTimersByTimeAsync(20_000);
  finish(finalizeEvent(requested, key)); await flush();
  socket.frame(['OK', proof(socket).id, true, 'authenticated']); await flush();
  await vi.advanceTimersByTimeAsync(100);
  expect((await delivery).relays[relay]).toEqual({ state: 'uncertain', detail: 'Acknowledgement deadline exceeded.' });
});
it('caps an oversized author approval budget at three minutes', async () => {
  vi.useFakeTimers();
  const { signer, transport, event } = setup();
  signer.signEvent = vi.fn(() => new Promise(() => {}));
  const delivery = transport.publishSignedEvent(event, [relay], { authorizationTimeout: 1_000_000 });
  const socket = await connected();
  vi.advanceTimersByTime(180_000); await flush();
  expect((await delivery).relays[relay]).toEqual({ state: 'not-sent', detail: 'AUTH: Authorization deadline exceeded.' });
  expect(socket.sent).toEqual([]);
});
