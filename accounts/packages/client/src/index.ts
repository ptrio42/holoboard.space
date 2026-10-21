import type { Event, EventTemplate } from "nostr-tools/pure";

/** An account-backed signer never publishes events or sends payments. */
export interface AccountSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}
