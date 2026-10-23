# Account key custody and signing

Status: source-backed design research for [native accounts](accounts-design.md).
This is not a security audit or runtime verification. Better Auth remains the
account component candidate for the reusable TypeScript library. Divine Keycast
is a headless-service alternative if that packaging requirement changes;
key custody and Nostr transport are separate responsibilities.

## Separate the mechanisms

| Mechanism | Responsibility |
| --- | --- |
| Email/password account | Authenticate the person and issue/revoke application sessions |
| Custody provider | Generate/import, encrypt, recover and use a stable author key |
| Signing policy | Decide which account or client may request which operation |
| Direct HTTPS API | Carry first-party account/signing requests using application authentication |
| NIP-46 | Carry remote-signing requests and replies between authorized Nostr clients and a signer |

A bunker can use NIP-46. Choosing server-side custody does not choose a transport,
and NIP-46 does not specify encryption at rest, password recovery or database
backups. It permits the signer to be a server or a device; see
[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md).

`nsec` is a user-facing encoding, not encryption. Store encrypted key bytes,
not an unprotected `nsec` string. See
[NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md).
[NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) separately
specifies password-encrypted `ncryptsec`; it does not by itself supply recovery
when the password is lost or authorization for a remote signer.

## Existing implementations inspected

The revision IDs below pin the source used for this review. A checked-in test or
README assertion was not treated as an executed test. Live deployments were not
logged into, and no user or production keys were requested.

| Project and source revision | Observed custody/signing model | Fit for our requirements |
| --- | --- | --- |
| [Divine Keycast](https://github.com/divinevideo/keycast/tree/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0) | Server-side encrypted keys; HTTP and NIP-46 signing paths | Closest architectural comparison for recoverable email accounts; a Rust service with its own accounts and operational dependencies, not a drop-in TypeScript library |
| [Marmot Keycast](https://github.com/marmot-protocol/keycast/tree/6c5a2fee187f326a13e5e04c72e5cc28670362d0) | Self-hosted NIP-46 signer, private encrypted storage, explicit grants and policies | Useful custody/isolation reference; external signed administration does not itself provide ordinary email/password onboarding |
| [nsec.app / Noauth](https://github.com/nostrband/noauth/tree/4d3f9a12ed036f6fea6965fc8a303c779ea1bd16) | Browser/service-worker signing and password-encrypted cloud key storage, according to its README | Different custody/recovery model; not a direct substitute for server-recoverable accounts |
| [NDK NIP-46 backend](https://github.com/nostr-dev-kit/ndk/tree/4b86acd13fe3c1284fddcb81a7f0d63e491db64a/core/src/signers/nip46/backend) | TypeScript protocol handler with a signing permission callback | A transport candidate, not encrypted storage or an account system; review the pinned release and its signer restrictions before reuse |
| [Original nsecbunkerd](https://github.com/kind-0/nsecbunkerd/tree/4ca87a50419a79ef1c0fd8f55d918c120bfcd985) | The inspected current tree contains only README.md | Historical security descriptions cannot establish a current usable implementation |

### Divine Keycast

The inspected
[file key manager](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/core/src/encryption/file_key_manager.rs)
uses AES-256-GCM with random nonces and returns decrypted bytes to its process.
Its [GCP manager](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/core/src/encryption/gcp_key_manager.rs)
uses KMS encrypt/decrypt operations and also receives plaintext on decryption.
This is not evidence that Nostr author keys never enter application memory.
The selected file implementation loads a build-relative `master.key`; do not
assume every README configuration option is honored by that exact path without
checking the actual startup factory.

The [HTTP handler](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/api/src/handlers/http_rpc_handler.rs)
checks authorization and permission state before signing. It has its own cache
semantics and a permissive empty-policy case, so direct reuse would require
review against our live-revocation and default-deny requirements. Existing code
is a reference, not proof that all its defaults match our contract.

The [headless handlers](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/api/src/api/http/headless.rs)
provide `/api/headless/register`, `/api/headless/login` and authorization/PIN
operations without a hosted login screen. Registration leads through verification
and a code exchange; login returns an authorization code for the token endpoint.
An application-owned UI therefore does not inherently require replacing Keycast.
The earlier popup/Divine theme was a property of the selected integration flow.
This finding does not establish a tested Holoboard integration.

The inspected registration handler generates or imports the author key before
verification, defaults an omitted scope to `policy:full`, and includes email
addresses in some informational log messages. These defaults need review or
changes to satisfy our provisioning, least-privilege and log-privacy contract.
The headless/token flow also needs a deliberate web-session adapter rather than
placing its bearer credentials into browser storage.

The [password-reset handler](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/api/src/api/http/auth.rs#L3158)
and [repository operation](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/core/src/repositories/user.rs#L1103)
change the password and clear its reset token without replacing the personal key.
Those inspected operations do not revoke existing authorizations. Token lookup
and the subsequent password update are separate calls; they do not establish
our required atomic single-use reset plus revocation guarantee. Separately, the
[HTTP RPC cache](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/api/src/api/http/nostr_rpc.rs#L979)
rechecks OAuth authorization at a five-second interval. Neither path demonstrates
the contract's live-session checks. These are source-level integration gaps,
not the result of an executed attack or an audit of a deployed service.

### Marmot Keycast

The inspected
[envelope implementation](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/core/src/v2/envelope.rs)
uses authenticated AES-256-GCM and binds team, record, public key and purpose as
associated data. In the
[protocol handler](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/signer/src/protocol.rs),
signing checks the session and policy, then decrypts the stored key and finalizes
the event. Its
[security model](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/docs/security.md)
explicitly describes host trust and separates the public API from the signer.
Its [audit status](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/AUDIT.md)
states that no independent security audit has been completed. This is a separate
project from Divine Keycast, despite the shared name and historical ancestry.

Its reviewed [management routes](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/signer/src/management/api/http/routes.rs)
manage teams, stored keys, policies, grants and invitations. The
[lifecycle interface](https://github.com/marmot-protocol/keycast/blob/6c5a2fee187f326a13e5e04c72e5cc28670362d0/core/src/v2/control.rs)
accepts secret material for `SealStoredKey`; it does not expose signer-side user
key generation or individual secret export. No direct HTTP event-signing route
was found in those inspected interfaces. Reuse would require an account-to-grant
bridge and additions for our generation/export/direct-signing contract, or a
different contract. Whole-installation encrypted backup/restore is distinct from
an individual user's password-confirmed key export.

### Noauth and NDK

Noauth's README describes a client-held signing model. Inference for that model:
if only a forgotten password can decrypt the remaining backup and no unlocked
copy or additional recovery secret exists, an email reset alone cannot recover
the author key. A separate recovery path would be required to promise our account
behavior. This is not a claim that every Noauth mode has been audited.

The reviewed [key helper](https://github.com/nostrband/noauth/blob/4d3f9a12ed036f6fea6965fc8a303c779ea1bd16/packages/common/src/keys.ts)
contains legacy CBC/password-derived storage and a Safari local-encryption bypass.
Do not copy those implementation choices into the proposed account service.

NDK exposes `NDKNip46Backend` and a permission callback. Its reviewed constructor
advertises a generic signer overload but accepts narrower concrete signer types
in its implementation. The protocol handler also emits request/response debug
information. Confirm behavior in a pinned release, redact private payloads and
verify compatibility with our custody boundary before choosing it. Its presence
does not remove pairing, grant persistence, revocation or recovery work.

## Proposed model for our account library

The operation-level comparison gives the following result. Entries describe the
public source at the revisions above, not runtime acceptance.

| Required operation | Divine Keycast | Marmot Keycast |
| --- | --- | --- |
| Own email/password UI | Headless account endpoints and token exchange exist | Email/password accounts are outside the inspected signer interfaces |
| Create a stable author key | Registration generates a key; admin preload also generates one | Reviewed lifecycle seals a supplied key |
| Sign an event | Direct HTTP and NIP-46 paths exist | NIP-46 path exists; no direct HTTP sign operation in reviewed routes |
| Revoke access | Session/grant operations exist; HTTP OAuth cache rechecks periodically | Grant revocation exists; account-session bridging remains our work |
| Explicit user export | Password-confirmed `/api/user/export-key` uses Keycast's own account credentials | No individual secret-export operation in reviewed interfaces |
| Recover after password loss | Password reset preserves the key; atomic reset/revocation contract still needs changes and tests | Email recovery must be supplied by the account integration |

There are three distinct adoption choices:

1. Use Divine Keycast for both accounts and signing behind our UI. This avoids a
   second account framework and the popup. It adopts a Rust service with its own
   account/token model, PostgreSQL and Redis/Valkey dependencies. Session, policy,
   reset and privacy differences still need adaptation and runtime verification.
2. Keep Better Auth and use a Keycast only for custody. This is possible with
   additional integration, but neither reviewed service is a drop-in provider
   for the complete library contract. Divine's
   [admin preload interface](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/api/src/api/http/admin.rs#L210)
   creates unclaimed, Vine-oriented accounts and privileged signing tokens. It
   does not supply ordinary Better Auth password-confirmed export; its reviewed
   preloaded HTTP handler has no per-authorization policy. Do not use that
   migration path as an implicit substitute for account-scoped authorization or
   synchronize users' passwords into a second account database to avoid an adapter.
3. Keep Better Auth and implement our custody orchestration using established
   encryption/signing libraries. This best matches the requested embeddable
   TypeScript library and first-party session contract. It leaves key lifecycle,
   policy, recovery and operational verification under our maintenance.

Our recommendation remains option 3 **because of interface and packaging fit**.
This comparison does not prove it cheaper, safer or easier to maintain than a
complete Keycast deployment. If the priority becomes one ready account/signing
service rather than an embeddable library, option 1 deserves a local integration
test before building a replacement. Better Auth plus a shadow Keycast account
system is not the recommended default.

Keep Better Auth responsible for account authentication. A separate custody and
signing module owns the encrypted key records and allowed cryptographic actions.
Both direct HTTP and a future NIP-46 adapter should call the same policy and
signing core. Transport adapters must never bypass authorization or decrypt raw
keys merely to forward them to a client.

For the first implementation, retain the small TypeScript custody proposal in
[the account contract](accounts-design.md#stable-identity-custody-and-recovery):
established JWE encryption through `jose`, independent server encryption keys,
and Nostr signing through `nostr-tools`. This is a proposed implementation using
existing cryptographic libraries, not a new cipher or a promise of an audited
vault. A key-encryption adapter can later use KMS without changing the public
account/signer interface. The next implementation evidence is one real local
register/verify/login/sign/reset/sign flow with two sessions, the same public key
after reset and rejection of the old sessions. Use the public handlers, an
isolated database and captured mail. Do not activate Holoboard accounts or claim
production readiness from this first flow.

For one sign request:

1. Authenticate the live application session, or the explicitly approved NIP-46
   client grant when that transport exists.
2. Resolve the permitted account and immutable identity from trusted server
   state; validate the complete event and applicable limits/policy.
3. Decrypt the account key inside the custody module, verify its assigned public
   key and sign the exact canonical event through the Nostr library. Nostr uses
   Schnorr signatures as specified in
   [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).
4. Return the verified signed event. Signing does not publish or send funds.
   Retain no plaintext-key cache initially and avoid key strings where possible;
   do not promise guaranteed memory erasure in a managed runtime.

The normal client gets the public key and signed events. Explicit export is a
separate, password-confirmed action. Revoking a session or grant prevents future
operations; it cannot retract an existing signature or an already exported key.

## Protection and its limits

Database encryption with a secret kept outside the database protects a stolen
ciphertext-only database or backup. A Fly secret on the same running host is
not isolation from a full host/process compromise. A correctly scoped KMS can
separate storage and decryption authority, but a compromised authorized signer
may still request decryption or signatures. Do not label ordinary KMS-backed
storage as non-exportable hardware Schnorr signing.

A user-password-only encryption design needs an additional recovery mechanism
to preserve identity after password loss. Our proposed independent encryption
key permits recoverable accounts but makes the operator a custodian. Explain
that trust accurately. Keep account reset, encryption-key rotation and Nostr
identity replacement distinct.

Before activation, verify record swapping/tampering rejection, concurrent
provisioning, exact signatures, unauthorized requests, reset and grant/session
revocation, explicit export, missing encryption keys, rotation and restore.
Restore must compare against an independently preserved identity inventory and
block new registration/provisioning while assigned account/key records are
missing. A stale backup can omit an entire account, not merely its secret key.
Decide the production secret/KMS configuration and backup recovery objective
before deployment. Neither a protocol name nor another project's README closes
those checks.
