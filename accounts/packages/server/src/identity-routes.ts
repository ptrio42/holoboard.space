import { finalizeEvent, getEventHash, verifyEvent } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import type { Event, EventTemplate } from "nostr-tools/pure";
import type { PrivateAccountRoute } from "./account-routes.ts";
import { AccountError } from "./limits.ts";
import { createSigningPolicy, exactObject } from "./policy.ts";
import type { SigningPolicy } from "./policy.ts";

export function createIdentityRoutes(policy: SigningPolicy, exportEnabled: boolean): readonly PrivateAccountRoute[] {
  const signing = createSigningPolicy(policy);
  const capabilities = { allowedKinds: signing.allowedKinds, exportEnabled };
  return [
    { path: "/v1/identity", method: "GET", handle: async ({ identity, account }) => {
      if (!identity) throw new AccountError("IDENTITY_UNAVAILABLE", 503);
      return Response.json({ ...await identity.getOrCreate(), accountId: account.user.id, capabilities });
    } },
    { path: "/v1/identity/sign", method: "POST", handle: async ({ body, identity }) => {
      const input = exactObject(body, ["template"]);
      const template = signing.validate(input.template);
      if (!identity) throw new AccountError("IDENTITY_UNAVAILABLE", 503);
      const { publicKey } = await identity.getOrCreate();
      const event = await identity.withSecret((secret) => {
        const signed = finalizeEvent({ ...template, tags: template.tags.map((tag) => [...tag]) }, secret);
        // Build a fresh plain event: nostr-tools caches verification on a mutable symbol property.
        const plain: Event = { kind: signed.kind, created_at: signed.created_at, content: signed.content,
          tags: signed.tags.map((tag) => [...tag]), pubkey: signed.pubkey, id: signed.id, sig: signed.sig };
        if (plain.pubkey !== publicKey || getEventHash(plain) !== plain.id || !sameTemplate(plain, template) || !verifyEvent(plain)) {
          throw new AccountError("IDENTITY_UNAVAILABLE", 503);
        }
        return plain;
      });
      return Response.json(event);
    } },
    { path: "/v1/identity/export", method: "POST", handle: async ({ body, identity, verifyPassword }) => {
      if (!exportEnabled) throw new AccountError("PERMISSION_DENIED", 403);
      const { password } = exactObject(body, ["password"]);
      if (typeof password !== "string" || !password || password.length > 128) throw new AccountError("INVALID_INPUT", 400);
      if (!await verifyPassword(password)) throw new AccountError("PERMISSION_DENIED", 403);
      if (!identity) throw new AccountError("IDENTITY_UNAVAILABLE", 503);
      const { publicKey } = await identity.getOrCreate();
      const nsec = await identity.withSecret((secret) => nsecEncode(secret));
      return Response.json({ publicKey, nsec });
    } },
  ];
}

function sameTemplate(event: Event, template: EventTemplate): boolean {
  return event.kind === template.kind && event.created_at === template.created_at && event.content === template.content &&
    JSON.stringify(event.tags) === JSON.stringify(template.tags);
}
