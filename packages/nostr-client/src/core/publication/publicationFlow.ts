import type { DeepReadonly } from '../storage/publicOutbox';
import type { EventTemplate } from 'nostr-tools';
import { verifiedNostrEvent } from '../events/verifyNostrEvent';
import { prepareReply } from '../threads/replyPreparation';
import { createThreadGraph, reduceThreadGraph } from '../threads/threadGraph';
import type { PublicationRecord } from '../storage/publicOutbox';
import type { PublicationHost } from '../ports';
import type { createPublicCache, createPublicOutbox } from '../storage/publicScope';

type Cache = ReturnType<typeof createPublicCache>;
type Outbox = ReturnType<typeof createPublicOutbox>;
interface Binding { revision: number; principal: string; signer: number; policy: number }
interface Review extends Binding { template: EventTemplate; destinations: string[]; parent?: string }
interface SavedReview extends Binding { id: string; event: string; destinations: string[] }
export interface PublicationSnapshot {
  phase: 'editing' | 'reviewed' | 'signing' | 'saving' | 'ready' | 'sending';
  destinations: readonly string[]; parent?: string; review?: Readonly<Review>; readyId?: string;
  records: PublicationRecord[]; message: string; busy: boolean;
}
/** One host owns the draft. This controller holds review snapshots and durable receipts only. */
export function createPublicationFlow(host: PublicationHost, cache: Cache, outbox: Outbox) {
  let state: PublicationSnapshot = { phase: 'editing', destinations: [host.identity.localRelay], records: [], message: '', busy: false };
  const listeners = new Set<() => void>();
  let revision = 0, recordVersion = 0, disposed = false;
  let draftFingerprint = JSON.stringify(host.snapshot().draft);
  let generation = host.policy.generation;
  let reviewed: Review | undefined, savedReview: SavedReview | undefined;
  let sending: AbortController | undefined;
  const emit = (update: Partial<PublicationSnapshot>) => {
    state = { ...state, ...update }; if (!disposed) listeners.forEach(listener => listener());
  };
  const alive = () => { if (disposed || host.snapshot().disposed) throw Error('Publication controller is disposed.'); };
  const bind = (): Binding => ({ revision, principal: host.identity.principal, signer: host.signer.generation, policy: host.policy.generation });
  const matches = (binding: Binding) => !disposed && !host.snapshot().disposed && binding.revision === revision &&
    binding.principal === host.identity.principal && binding.signer === host.signer.generation && binding.policy === host.policy.generation;
  function invalidate(message = 'Review changed or cancelled. Review again before signing or sending.') {
    revision++; reviewed = undefined; savedReview = undefined; sending?.abort();
    emit({ phase: 'editing', review: undefined, readyId: undefined, message });
  }
  const unsubscribe = host.subscribe(() => {
    const fingerprint = JSON.stringify(host.snapshot().draft);
    if (fingerprint !== draftFingerprint || generation !== host.policy.generation || host.snapshot().disposed) {
      draftFingerprint = fingerprint; generation = host.policy.generation; invalidate();
    }
  });
  function template(createdAt: number): EventTemplate {
    const { text, attachments } = host.snapshot().draft;
    if (!text.trim() || new TextEncoder().encode(text).length > 16384) throw Error('A note needs text of at most 16 KiB.');
    if (state.parent) {
      const events = cache.query({});
      const parent = events.find(event => event.id === state.parent && event.kind === 1);
      if (!parent || !cache.sources(parent.id).length) throw Error('Reply parent needs an allowed verified public source. Read its thread first.');
      return prepareReply({ parent, graph: reduceThreadGraph(createThreadGraph(), events), content: text, createdAt,
        attachments, validateMediaUrl: host.media.mediaUrl }).template;
    }
    const result = { kind: 1, content: text, created_at: createdAt, tags: host.media.attachmentTags(attachments, text) };
    if (JSON.stringify(result).length * 3 > 65536) throw Error('Prepared note exceeds the 64 KiB event limit.');
    return result;
  }
  function assertReview(review: Review) {
    alive();
    if (reviewed !== review || !matches(review) || review.destinations.some(url => !host.policy.relayAllowed(url)) ||
      JSON.stringify(template(review.template.created_at)) !== JSON.stringify(review.template)) throw Error('Review changed or cancelled. Review again.');
  }
  async function refresh() {
    alive(); const version = ++recordVersion; const records = await outbox.list();
    if (!disposed && version === recordVersion) emit({ records }); return records;
  }
  const recordReview = (record: PublicationRecord): SavedReview => ({ ...bind(), id: record.id, event: JSON.stringify(record.event), destinations: Object.keys(record.relays) });
  function assertSaved(review: SavedReview | undefined, id: string) {
    alive(); if (!review || savedReview !== review || review.id !== id || !matches(review)) throw Error('Review the saved account, event and destinations before sending.');
  }
  function authorizeSaved(review: SavedReview | undefined, id: string, record: DeepReadonly<PublicationRecord> | undefined, targets: readonly string[]) {
    assertSaved(review, id);
    if (!record || record.id !== id || JSON.stringify(record.event) !== review!.event ||
      JSON.stringify(Object.keys(record.relays).sort()) !== JSON.stringify([...review!.destinations].sort()) ||
      targets.some(url => !review!.destinations.includes(url))) throw Error('Saved event or destinations changed.');
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    setDestinations(urls: string[]) {
      alive(); if (urls.length > 12 || urls.some(url => !host.policy.configuredRelay(url))) throw Error('Only configured destinations are available.');
      invalidate(); emit({ destinations: [...new Set(urls)] });
    },
    setReply(id?: string) { alive(); invalidate(); emit({ parent: id }); },
    cancel() { alive(); invalidate(); },
    review() {
      alive(); if (state.busy) throw Error('Wait for the current operation.');
      invalidate('');
      if (!state.destinations.length || state.destinations.some(url => !host.policy.relayAllowed(url))) throw Error('Choose currently allowed destinations.');
      const review: Review = { ...bind(), template: template(Math.floor(Date.now() / 1000)), destinations: [...state.destinations], parent: state.parent };
      reviewed = review;
      // Expose a copy; UI and consumers cannot mutate the authorization token.
      emit({ phase: 'reviewed', review: structuredClone(review), message: 'Review this public event, account and destinations. Signing saves it without sending.' });
    },
    async signAndSave(): Promise<PublicationRecord> {
      alive(); const review = reviewed;
      if (!review || state.busy) throw Error('Review before signing.');
      assertReview(review); emit({ busy: true, phase: 'signing', message: 'Waiting for the author signature.' });
      let saving = false;
      try {
        const principal = await host.signer.getPublicKey(); assertReview(review);
        if (principal !== review.principal) throw Error('Signer account changed.');
        const signed = await host.signer.signEvent(structuredClone(review.template)); assertReview(review);
        const event = verifiedNostrEvent(signed);
        if (!event || event.pubkey !== review.principal || event.kind !== review.template.kind ||
          event.content !== review.template.content || event.created_at !== review.template.created_at ||
          JSON.stringify(event.tags) !== JSON.stringify(review.template.tags)) throw Error('Signer returned an invalid or changed public event.');
        const signedBody = JSON.stringify(event);
        const reviewedDestinations = JSON.stringify([...review.destinations].sort());
        saving = true; emit({ phase: 'saving', message: 'Saving signed event. Nothing has been sent.' });
        const record = await outbox.enqueue(event, review.destinations, { type: 'authored-public', principal: review.principal });
        // A late save is retained honestly. It never becomes an authorized send.
        try { assertReview(review); } catch { throw Error('Signed event was saved after review changed. Inspect history and review its exact saved event before sending.'); }
        // The borrowed outbox keeps existing events and merges destinations for
        // duplicate IDs. A fresh draft review cannot authorize that older union.
        const storedEvent = verifiedNostrEvent(record.event);
        if (!storedEvent || record.id !== event.id || JSON.stringify(storedEvent) !== signedBody ||
          JSON.stringify(Object.keys(record.relays).sort()) !== reviewedDestinations) {
          throw Error('Signed event was saved with a different body or destination set. Inspect history and review the exact saved event and all destinations before sending.');
        }
        savedReview = recordReview(record); reviewed = undefined; recordVersion++;
        emit({ phase: 'ready', review: undefined, readyId: record.id, records: [record, ...state.records.filter(value => value.id !== record.id)],
          message: 'Signed event saved. Send is a separate action.' });
        return record;
      } catch (failure) {
        invalidate(saving ? 'Save did not complete under the current review. Refresh history before retrying; any saved event requires review.' : 'Signing cancelled, changed or failed. Draft preserved.');
        const detail = failure instanceof Error ? failure.message : '';
        // Do not expose arbitrary signer diagnostics, which may contain credentials.
        throw Error(saving ? `Save failed or review changed. ${detail.startsWith('Signed event was saved') ? detail : 'Draft preserved; inspect history.'}` : 'Signing cancelled or review changed; no event saved.');
      } finally { emit({ busy: false }); }
    },
    async reviewSaved(id: string) {
      alive(); if (state.busy) throw Error('Wait for the current operation.');
      invalidate(''); const binding = bind();
      const records = await refresh();
      if (!matches(binding)) throw Error('Saved review changed.');
      const record = records.find(value => value.id === id);
      if (!record) throw Error('Saved public event not found.');
      savedReview = recordReview(record);
      emit({ phase: 'ready', readyId: id, message: 'Review the exact saved public event, account and per-relay destinations below. Send retries only this ID.' });
    },
    async send(id: string) {
      const review = savedReview; assertSaved(review, id);
      if (state.busy) throw Error('Wait for the current operation.');
      const controller = new AbortController(); sending = controller;
      emit({ busy: true, phase: 'sending', message: 'Sending the saved event. Missing acknowledgement remains uncertain.' });
      try {
        const principal = await host.signer.getPublicKey(); assertSaved(review, id);
        if (principal !== host.identity.principal) throw Error('Signer account changed.');
        const record = (await outbox.list()).find(value => value.id === id); assertSaved(review, id);
        authorizeSaved(review, id, record, []);
        const delivered = await outbox.send(id, { signal: controller.signal,
          authorize: (current, targets) => authorizeSaved(review, id, current, targets),
        });
        recordVersion++;
        if (!disposed) emit({ records: [delivered, ...state.records.filter(value => value.id !== id)], message: 'Delivery outcomes saved. Uncertain destinations may already have the event; retry this exact ID.' });
        return delivered;
      } catch { emit({ message: 'Delivery could not finish. Refresh saved outcomes before retrying the exact ID.' }); throw Error('Delivery failed or review changed. Inspect saved outcomes.'); }
      finally {
        sending = undefined; savedReview = undefined;
        emit({ busy: false, readyId: undefined, phase: 'editing' });
      }
    },
    dispose() { if (disposed) return; invalidate(); disposed = true; unsubscribe(); listeners.clear(); },
  };
}
export type PublicationFlow = ReturnType<typeof createPublicationFlow>;
