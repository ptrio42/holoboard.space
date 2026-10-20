import type { Event, Filter } from 'nostr-tools';
import { NostrCache } from './nostrCache';
import { verifiedNostrEvent } from '../events/verifyNostrEvent';
import { PublicOutbox, type PublicationRecord } from './publicOutbox';
import { IndexedPublicationStore, type PublicationStore } from './publicationStore';
import type { Publisher } from '../transport/nostrTransport';
import type { ClientIdentity, PublicReadIdentity, ContentPolicy } from '../ports';
import { hostNamespace, publicReadNamespace } from './namespace';
import { policyPublish } from '../publication/publicationPolicy';
export { hostNamespace } from './namespace';

export type EventSource = { visibility: 'public' | 'private'; relay: string };
export type PublicIntent = { type: 'authored-public'; principal: string };
const publicKinds = new Set([0, 1, 3, 5, 10002, 10050, 1111]);
function publicEvent(event: Event): Event {
  const verified = verifiedNostrEvent(event);
  if (!verified || !publicKinds.has(verified.kind)) throw new TypeError('Verified public content is required.');
  return verified;
}
/** Bounded borrowed memory cache. Provenance is checked before entry, never inferred from kind. */
export function createPublicCache(identity: PublicReadIdentity, policy: ContentPolicy) {
  const caches = new Map<string, NostrCache>();
  const provenance = new Map<string, Set<string>>();
  let disposed = false;
  return {
    namespace: publicReadNamespace(identity),
    put(input: Event, source: EventSource) {
      if (disposed || source.visibility !== 'public' || !policy.relayAllowed(source.relay)) throw new Error('Source is not an allowed public read channel.');
      const event = publicEvent(input);
      let cache = caches.get(source.relay);
      if (!cache) { cache = new NostrCache(); caches.set(source.relay, cache); }
      cache.put(event);
      if (cache.hasRetained(event.id)) provenance.set(event.id, new Set([...(provenance.get(event.id) ?? []), source.relay]));
      for (const id of provenance.keys()) if (![...caches.values()].some(cache => cache.hasRetained(id))) provenance.delete(id);
    },
    query(filter: Filter) {
      if (disposed) return [];
      const visible = new NostrCache();
      for (const [url, cache] of caches) if (policy.relayAllowed(url)) for (const event of cache.query({})) visible.put(event);
      const events = visible.query(filter); visible.dispose(); return events;
    },
    sources(id: string) { return [...provenance.get(id) ?? []].filter(url => policy.relayAllowed(url) && caches.get(url)?.hasRetained(id)); },
    dispose() { disposed = true; for (const cache of caches.values()) cache.dispose(); caches.clear(); provenance.clear(); },
  };
}
interface ScopedRecord extends PublicationRecord { publicIntent: PublicIntent; namespace: string }
/** The borrowed outbox owns delivery and atomic checkpoints. This wrapper supplies scope and provenance. */
export function createPublicOutbox(identity: ClientIdentity, policy: ContentPolicy, publish: Publisher, injectedStore?: PublicationStore) {
  identity = Object.freeze({ ...identity });
  const namespace = hostNamespace(identity);
  const durable = injectedStore ?? new IndexedPublicationStore(`${namespace}:outbox-v1`);
  const intents = new Map<string, PublicIntent>();
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let disposed = false, storageClosed = false;
  const assertAlive = () => { if (disposed) throw new Error('Public outbox disposed.'); };
  const assertStorage = () => { if (storageClosed) throw new Error('Public outbox storage closed.'); };
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    assertAlive();
    const job = operation(); active.add(job);
    try { return await job; } finally { active.delete(job); }
  }
  const validate = (records: PublicationRecord[]): ScopedRecord[] => records.map(input => {
    const record = input as ScopedRecord;
    const event = publicEvent(record.event);
    if (![1, 1111].includes(event.kind) || event.pubkey !== identity.principal || record.namespace !== namespace ||
        record.publicIntent?.type !== 'authored-public' || record.publicIntent.principal !== identity.principal) throw new Error('Publication has no scoped public author intent.');
    // Do not retain arbitrary caller fields, signer objects or private payload envelopes.
    return { id: record.id, event, createdAt: record.createdAt, attempts: record.attempts, relays: Object.fromEntries(Object.entries(record.relays).map(([url, outcome]) => [url, { state: outcome.state, ...("detail" in outcome ? { detail: outcome.detail } : {}) }])),
      publicIntent: { type: 'authored-public', principal: identity.principal }, namespace };
  });
  const store: PublicationStore = {
    async read() { assertStorage(); return validate(await durable.read()); },
    change(update) {
      assertStorage();
      return durable.change(records => {
        return validate(update(validate(records)).map(record => {
          const intent = intents.get(record.id);
          return intent ? { ...record, publicIntent: intent, namespace } : record;
        }));
      });
    },
  };
  const outbox = new PublicOutbox(store, policyPublish(policy, publish), url => policy.configuredRelay(url) ? url : undefined);
  return {
    namespace,
    list: () => run(() => outbox.list()), forget: (id: string) => run(() => outbox.forget(id)),
    send(id: string, options?: Parameters<PublicOutbox['send']>[1]) {
      const signal = options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
      return run(() => outbox.send(id, { ...options, signal }));
    },
    async enqueue(input: Event, urls: string[], intent: PublicIntent) {
      assertAlive();
      const event = publicEvent(input);
      if (intent?.type !== 'authored-public' || intent.principal !== identity.principal || event.pubkey !== identity.principal) throw new Error('Explicit public author intent is required.');
      if (urls.some(url => !policy.relayAllowed(url))) throw new Error('Destination blocked by current policy.');
      intents.set(event.id, { type: 'authored-public', principal: identity.principal });
      try { return await run(() => outbox.enqueue(event, urls)); } finally { intents.delete(event.id); }
    },
    dispose(): Promise<void> {
      if (closing) return closing;
      disposed = true; lifetime.abort();
      // Reject new API calls immediately, but let started borrowed workflows
      // commit their already observed outcomes before closing the owned store.
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Public outbox shutdown timed out; delivery persistence may be incomplete.')), 10_000);
      });
      const drain = Promise.allSettled([...active]).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Public outbox shutdown could not finish its pending operations.');
      });
      closing = Promise.race([drain, deadline]).finally(() => {
        clearTimeout(timer); storageClosed = true; intents.clear();
        if (durable.dispose) return durable.dispose();
      });
      // pagehide cannot await, but callers still receive the original rejecting
      // Promise and must observe it when confirming durable shutdown.
      void closing.catch(() => {});
      return closing;
    },
  };
}
