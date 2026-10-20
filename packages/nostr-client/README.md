# Shared Nostr client

`@ptrio42/nostr-client` contains the maintained note editor, note renderer, content
parsers, bounded thread graph and public publication primitives. Holoboard keeps
its product UI and adapters. nest-rel consumes a versioned archive and owns its
own application. Neither consumer needs the other application at runtime.

This private source package has three exports:

- `@ptrio42/nostr-client/core`: verification, parsing, threads, reply preparation,
  transport, cache/storage/outbox factories and the review/sign/save/send flow.
  This entrypoint imports no React code.
- `@ptrio42/nostr-client/react`: `ClientProvider`, `NoteEditor`, `NoteContent`,
  their inferred/exported props and shared presentation primitives.
- `@ptrio42/nostr-client/styles.css`: compiled, scoped component styles, including
  the hidden file input and lightbox styles. No consumer Tailwind scan is needed.

## Build and verify

Use the checked-in lockfile with Node.js 22.12 or newer and npm:

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
node scripts/verify-packed.mjs ./ptrio42-nostr-client-0.1.0.tgz > /tmp/nostr-client-packed.log
node scripts/verify-packed-browser.mjs /tmp/nostr-client-packed.log
```

The dependency versions come from the reviewed Holoboard lockfile. React and
React DOM are peers; the development versions match that reviewed lock. Building
uses only this package and its installed dependencies. The archive includes ESM
and declarations, not source-checkout aliases. Install the resulting archive as
an exact `file:` dependency and commit its lockfile integrity in each external
consumer. Holoboard's local `file:` link and compatibility entrypoints resolve to
this same canonical source after the web prebuild step.

## Explicit host services

Construction does not open a socket, restore a signer or open IndexedDB. Bind
`ClientIdentity`, `ContentPolicy`, `AuthorSigner`, media, storage and navigation
ports explicitly. `createContentTransport` takes a configured relay list and a
policy. It accepts canonical `wss:` production URLs and explicitly configured
`ws:` local URLs; canonical syntax is not permission. The policy checks every
dial, query and send. Its anonymous read pool and authenticated author pool are
separate. The author pool requires an exact NIP-42 challenge proof acknowledged
on that same socket before an event can be sent. The author channel has a
separate 120-second approval budget (configurable up to 180 seconds), then the
short EVENT acknowledgement deadline starts after the actual send. Connection
setup remains bounded separately. The legacy anonymous publication adapter
retains its previous global 8-second default and 15-second maximum. Cancellation
invalidates late signing and authorization completions.

Identity and signer lifetime belong to the host. Recreate the scoped transport,
cache, outbox and publication flow when the principal or signer changes. Supply
`AuthorSigner.onChange` when available to close authenticated sockets immediately;
all sends also check signer generation. Policy changes cancel reads, reconcile
sockets and invalidate publication consent without starting new requests.

Mount views under `<ClientProvider services={services}>`. `ClientServices`
requires explicit connection, media and navigation adapters, an instance-owned
`createMediaPresentation()` result and capability values for profiles, quotes
and link previews. An unavailable capability has
`{ available: false, reason: '...' }`; it renders that state and never uses a
fallback provider. Available capabilities bind the host's existing components
and read hooks. Keep those capability bindings stable during a mounted scope.
Media upload, GIF search and all provider endpoints are supplied by the host;
`createMediaUploader()` provides the original explicit one-upload implementation
without selecting a server. An upload never authorizes publishing or payment.

Import the compiled CSS once. Its base normalization and zero-specificity utility
selectors stay inside the component scope, below consumer utilities. Set `--nostr-font-label`, `--nostr-font-body`,
`--nostr-background`, `--nostr-panel`, `--nostr-accent`, `--nostr-danger` and
`--nostr-gold` on a host ancestor to supply the host theme. No font or image asset
is fetched by package construction. The default auxiliary palette uses Tailwind
cyan tokens from the original components. A light host theme should override the
relevant `--color-cyan-*` values on its `.nostr-client` scopes for readable contrast.
`NoteEditor` accepts optional `textLabel`, `placeholder` and `toolbarLabel` props
for root-note wording while preserving the original reply defaults. Media embedding checks the supplied media
policy, including video posters. Denied media retains safe, explicit source
links, including image-only notes and tag-only attachments, without automatic
media requests. An unavailable upload capability rejects file pick, paste and
drop before creating object URLs or blocking review. Hosts retain their own CSP; this package does
not broaden it. The existing gallery/lightbox uses element style attributes for
geometry, which a strict CSP may block; hosts may keep media unavailable.

## Public data and receipt ownership

`createPublicReadTransport({ relays, policy })` and `createPublicCache` accept
an anonymous reader without a signer or synthetic author key. Supply a
`PublicReadIdentity` with app ID and local relay, omitting `principal`; its
anonymous cache namespace is separate from account scopes. This transport has
no publication method. Outboxes always require a real `ClientIdentity` principal.

`createPublicCache` requires explicit public-source provenance and keeps each
source in a separate partition. Private/authenticated sources cannot become
anonymous public data by their event kind. Policy-blocked partitions cannot
replace or delete visible local events. Core `NostrCache` is a lower-level
verified-event store; persistent use requires an explicit database name.

`createPublicOutbox` requires app/principal/relay scope and authored-public intent.
Enqueue, list, reload and review do not publish. Storage names and scoped metadata
are explicit; the Holoboard adapters retain its existing database names and
record format. There is no existing-data migration.

`send(id, { signal, authorize })` optionally runs synchronous authorization after
the last storage await and immediately before calling the publisher. The callback
receives separately owned, deeply frozen snapshots of the actual saved record
and selected retry targets. Retaining those snapshots cannot mutate storage,
the publisher arguments or later receipts. The callback must throw to reject;
it must not return a promise. With no callback, delivery retains the previous
outbox behavior. The publication flow binds signed body, full saved destination
set, retry targets, principal and review/signer/policy generations. Merged same-ID
destinations require a fresh review.

Await `dispose()` on the scoped public outbox before closing its storage. It
rejects new operations immediately, cancels active delivery, drains known receipt
writes, then closes an injected store through its optional `dispose` port.
Persistence failures and the bounded shutdown timeout reject the returned
promise. A page-unload handler cannot prove that draining completed.

See [NOTICE.md](NOTICE.md) and the [source inventory](provenance/inventory.json)
for provenance and license boundaries. This artifact is private and is not a
public package publication or a grant of a new upstream license.
