import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import { AccountClientError } from './transport.ts';
import type { AccountClient } from './index.ts';
export function snapshotTemplate(template: EventTemplate): EventTemplate {
  if (!template || Reflect.ownKeys(template).length !== 4 || Reflect.ownKeys(template).some(key => typeof key !== 'string' || !['kind', 'created_at', 'content', 'tags'].includes(key)) || !Number.isSafeInteger(template.kind) || template.kind < 0 || !Number.isSafeInteger(template.created_at) || template.created_at < 0 || typeof template.content !== 'string' || !template.content.isWellFormed() || !Array.isArray(template.tags) || template.tags.some(tag => !Array.isArray(tag) || tag.some(item => typeof item !== 'string' || !item.isWellFormed())))
    throw new AccountClientError('INVALID_INPUT');
  return { kind: template.kind, created_at: template.created_at, content: template.content, tags: template.tags.map(tag => [...tag]) };
}
/** Reconstruct first: never trust nostr-tools' cached verifiedSymbol on received objects. */
export function validateSignedEvent(value: unknown, template: EventTemplate, publicKey: string): Event {
  try {
    const e = value as Event;
    if (!e || !Array.isArray(e.tags) || e.tags.some(tag => !Array.isArray(tag) || tag.some(item => typeof item !== 'string')))
      throw new Error();
    const fresh: Event = { kind: e.kind, created_at: e.created_at, content: e.content, tags: e.tags.map(tag => [...tag]), pubkey: e.pubkey, id: e.id, sig: e.sig };
    if (fresh.kind !== template.kind || fresh.created_at !== template.created_at || fresh.content !== template.content || JSON.stringify(fresh.tags) !== JSON.stringify(template.tags) || fresh.pubkey !== publicKey || !/^[a-f0-9]{64}$/.test(fresh.id) || !/^[a-f0-9]{128}$/.test(fresh.sig) || getEventHash(fresh) !== fresh.id || !verifyEvent(fresh))
      throw new Error();
    return fresh;
  }
  catch {
    throw new AccountClientError('INVALID_SIGNATURE');
  }
}
/** An account-backed signer never publishes events or sends payments. */
export class AccountSigner {
  private readonly client: AccountClient;
  constructor(client: AccountClient) {
    this.client = client;
  }
  async getPublicKey(): Promise<string> {
    return (await this.client.getIdentity()).publicKey;
  }
  async signEvent(template: EventTemplate): Promise<Event> {
    const snapshot = snapshotTemplate(template), state = this.client.captureAuth();
    const identity = await this.client.getIdentity();
    this.client.assertAuth(state);
    const response = await this.client.request('/v1/identity/sign', { template: snapshot });
    this.client.assertAuth(state);
    return validateSignedEvent(response, snapshot, identity.publicKey);
  }
}
