import type { ClientIdentity } from '../ports';
export function hostNamespace(identity: ClientIdentity): string {
  if (!identity.appId || !/^[0-9a-f]{64}$/.test(identity.principal) || !identity.localRelay) throw new TypeError('Explicit application, principal and relay identity required.');
  return `nostr-client:${JSON.stringify([identity.appId, identity.principal, identity.localRelay])}`;
}

export function publicReadNamespace(identity: import('../ports').PublicReadIdentity): string {
  if (identity.principal !== undefined) return hostNamespace({ ...identity, principal: identity.principal });
  if (!identity.appId || !identity.localRelay) throw new TypeError('Explicit application and relay identity required.');
  return `nostr-client:${JSON.stringify([identity.appId, 'anonymous', identity.localRelay])}`;
}
