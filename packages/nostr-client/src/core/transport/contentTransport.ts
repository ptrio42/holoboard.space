import { createNostrTransport } from './nostrTransport';
import { createPublicReadTransport, relayAdmission } from './publicReadTransport';
import type { AuthorSigner, ContentPolicy } from '../ports';
import { socketAuthorization } from './transportAuth';

export interface ContentTransportOptions {
  principal: string;
  signer: AuthorSigner;
  /** Explicit destinations admitted by the host policy. */
  relays: readonly string[];
  policy: ContentPolicy;
  /** Bounded author approval window, independent of the short EVENT ACK deadline. */
  authorizationTimeout?: number;
  relayAllowed?: (url: string, purpose: 'anonymous-read' | 'author-content') => boolean;
}
/** Each host owns independent anonymous and author pools and disposes both. */
export function createContentTransport(options: ContentTransportOptions) {
  if (!/^[0-9a-f]{64}$/.test(options.principal)) throw new TypeError('Invalid transport principal.');
  const { signer, principal } = options;
  const generation = signer.generation;
  const reads = createPublicReadTransport({ ...options, relayAllowed: url => options.relayAllowed?.(url, 'anonymous-read') ?? true });
  const author = createNostrTransport({
    candidates: relayAdmission({ ...options, relayAllowed: url => options.relayAllowed?.(url, 'author-content') ?? true }),
    requireAuthorization: true,
    authorizationTimeout: options.authorizationTimeout ?? 120_000,
    guard: () => { if (signer.generation !== generation) throw new Error('AUTH: Signer generation changed.'); },
    onSocket: (url, socket) => socketAuthorization(url, socket, principal, signer, generation),
  });
  let policyGeneration = options.policy.generation;
  const reconcile = () => {
    if (policyGeneration !== options.policy.generation || signer.generation !== generation) {
      author.invalidate(); policyGeneration = options.policy.generation;
    }
    reads.reconcile(); author.reconcile();
  };
  const unsubscribe = options.policy.onChange(reconcile);
  const unsubscribeSigner = signer.onChange?.(reconcile);
  return {
    queryNostr: reads.queryNostr,
    monitorRelay: reads.monitorRelay,
    publishSignedEvent: author.publishSignedEvent,
    reconcile,
    dispose() { unsubscribe(); unsubscribeSigner?.(); reads.dispose(); author.dispose(); },
  };
}
