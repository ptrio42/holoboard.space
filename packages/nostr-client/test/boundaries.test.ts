import { expect, test, vi } from 'vitest';
import { createContentTransport, createPublicCache, createPublicOutbox, createNostrTransport, IndexedPublicationStore } from '../src/core/index';
import { createMediaPresentation } from '../src/react/index';
import type { ContentPolicy } from '../src/core/ports';

const policy: ContentPolicy = { generation: 0, configuredRelay: url => url === 'wss://relay.example', relayAllowed: () => false, mediaAllowed: () => false, onChange: () => () => {} };
test('construction creates no sockets, storage requests, provider fetches or signer requests', async () => {
  const forbidden = vi.fn(() => { throw Error('Implicit I/O'); });
  vi.stubGlobal('WebSocket', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('fetch', forbidden);
  try {
    const identity = { appId: 'inert-test', principal: '1'.repeat(64), localRelay: 'wss://relay.example' };
    const signer = { generation: 0, getPublicKey: forbidden, signEvent: forbidden };
    const transport = createContentTransport({ principal: identity.principal, signer, relays: [identity.localRelay], policy });
    const cache = createPublicCache(identity, policy);
    const store = new IndexedPublicationStore('explicit:test');
    const outbox = createPublicOutbox(identity, policy, forbidden, store);
    const presentation = createMediaPresentation();
    expect(presentation.knownMedia('https://example.test/file.png')).toBeUndefined();
    expect(cache.query({})).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    await outbox.dispose(); transport.dispose(); cache.dispose();
    expect(forbidden).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
test('a core transport has no configured endpoint or ambient publication entrypoint', async () => {
  const forbidden = vi.fn(); vi.stubGlobal('WebSocket', forbidden);
  const transport = createNostrTransport({ candidates: () => [] });
  try {
    expect((await transport.queryNostr({}, ['wss://unconfigured.example'])).events).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  } finally { transport.dispose(); vi.unstubAllGlobals(); }
});
test('anonymous reading owns a public cache and transport without an author or signer', async () => {
  const { createPublicReadTransport } = await import('../src/core/index');
  const forbidden = vi.fn(); vi.stubGlobal('WebSocket', forbidden);
  try {
    const cache = createPublicCache({ appId: 'anonymous-reader', localRelay: 'wss://relay.example' }, policy);
    expect(cache.namespace).toContain('anonymous');
    const transport = createPublicReadTransport({ relays: ['wss://relay.example'], policy });
    expect(transport).not.toHaveProperty('publishSignedEvent');
    expect((await transport.queryNostr({}, ['wss://relay.example'])).complete).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
    transport.dispose(); cache.dispose();
  } finally { vi.unstubAllGlobals(); }
});
