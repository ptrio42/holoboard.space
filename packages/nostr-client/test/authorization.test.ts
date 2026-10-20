import { expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { PublicOutbox } from '../src/core/storage/publicOutbox';
import type { PublicationRecord } from '../src/core/storage/publicOutbox';
import type { PublicationStore } from '../src/core/storage/publicationStore';

test('final authorization owns deeply frozen snapshots and cannot mutate publication or saved state', async () => {
  let records: PublicationRecord[] = [];
  const store: PublicationStore = {
    read: async () => structuredClone(records),
    change: async update => { records = structuredClone(update(structuredClone(records))); return structuredClone(records); },
  };
  const event = finalizeEvent({ kind: 1, content: 'reviewed body', tags: [['t', 'original']], created_at: 123 }, generateSecretKey());
  const relay = 'wss://relay.example';
  const publish = vi.fn(async (body, urls) => ({ id: body.id, relays: Object.fromEntries(urls.map(url => [url, { state: 'accepted' as const }])) }));
  const outbox = new PublicOutbox(store, publish);
  await outbox.enqueue(event, [relay]);
  let retained: any;
  await outbox.send(event.id, { authorize: (record, targets) => {
    retained = record;
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.event.tags[0])).toBe(true);
    expect(Object.isFrozen(record.relays[relay])).toBe(true);
    expect(Object.isFrozen(targets)).toBe(true);
    expect(() => { (record.event as any).content = 'changed'; }).toThrow();
    expect(() => { (targets as string[]).push('wss://other.example'); }).toThrow();
  } });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0][0].content).toBe('reviewed body');
  expect(publish.mock.calls[0][1]).toEqual([relay]);
  expect(retained.relays[relay].state).toBe('uncertain');
  expect((await outbox.list())[0].relays[relay].state).toBe('accepted');
});
test('asynchronous authorization cannot publish while approval is pending', async () => {
  let records: PublicationRecord[] = [];
  const store: PublicationStore = { read: async () => structuredClone(records), change: async update => {
    records = structuredClone(update(structuredClone(records))); return structuredClone(records);
  } };
  const publish = vi.fn();
  const outbox = new PublicOutbox(store, publish);
  const event = finalizeEvent({ kind: 1, content: 'pending authorization', tags: [], created_at: 123 }, generateSecretKey());
  await outbox.enqueue(event, ['wss://relay.example']);
  await expect(outbox.send(event.id, { authorize: async () => {} })).rejects.toThrow(/synchronously/);
  expect(publish).not.toHaveBeenCalled();
});
