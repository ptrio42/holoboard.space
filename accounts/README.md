# Accounts workspace

Private TypeScript packages for an embeddable account handler, a loopback TLS
service and a transport-independent client SDK. The server implements email registration, verification, login,
fixed seven-day database sessions, logout and password recovery through Better
Auth, plus optional encrypted stable author identities, bounded kind-1 signing
and explicit password-confirmed key export. Custody installations include a
durable encrypted mail outbox with an explicit delivery worker. The service and embedded example share the same handler and HTTP bridge.
See the [account contract](../docs/accounts-design.md).

Use Node.js **24.22.1** and npm **11.19.1**, pinned in `.nvmrc`, `engines` and
`packageManager`. Node 24 is an LTS line in the
[official support schedule](https://github.com/nodejs/Release#release-schedule).
Changing runtime or native dependencies requires another packaging check.

```sh
cd accounts
nvm install
nvm use
npm ci
npm run check
npm test
npm run build
```

Tests use temporary private SQLite files and captured mail, with serial Node test
files to limit native hashing memory. Recovery tests use real loopback HTTPS,
separate cookie jars, an ephemeral OpenSSL certificate pinned by each client, and
a separate Node process for persistence checks. They require `openssl` and local
listen permission. They do not send external mail or establish native mobile
compatibility. Builds emit ESM and declarations to each
package's `dist`. The server package also includes reviewed migrations `0001.sql` through `0003.sql`, loaded
relative to either source or emitted JavaScript.

| Package | Responsibility | Runtime dependencies |
| --- | --- | --- |
| `@holoboard/accounts-server` | Account handler, private custody and scoped signing | Better Auth, SQLite, Argon2, JOSE, Nostr |
| `@holoboard/accounts-client` | Account operations, web transport and verified signer | `nostr-tools` only |
| `@holoboard/accounts-service` | Private configuration, local TLS and bounded lifecycle | Server package only |

The client has no server-package, database, password, key-storage, React or
browser-global dependency. An independent tarball was installed offline and imported with only the
`nostr-tools` dependency graph. Better Auth, SQLite, Argon2 and JOSE were absent. No existing web, curator or Go dependency graph is changed.

## Run locally

Build, explicitly create a fresh private installation, then start the TLS service:

```sh
npm run build
node examples/local-setup.mjs /private/tmp/accounts-local 3443
node apps/service/dist/main.js init /private/tmp/accounts-local/config.json
node apps/service/dist/main.js serve /private/tmp/accounts-local/config.json
```

Stop with Ctrl-C. Use `node examples/embedded.mjs /private/tmp/accounts-local/config.json`
for the embedded host instead of `serve`. Both use the public server package and
shared bounded TLS bridge. The explicit local setup requires OpenSSL and creates
separate secrets, a self-signed certificate and a private mail capture file. No
external mail is sent. Serving requires existing storage and owner-only config/key
files. It never initializes storage or generates missing secrets. Only loopback
TLS is implemented; public TLS termination and proxies remain future work.

See [configuration, local verification and shutdown](docs/service.md) for the
exact JSON shape, private capture workflow and isolated end-to-end helper.

## Client SDK

`createAccountClient({ baseURL, transport? })` exposes registration, verification,
login, session, logout, recovery, identity and explicit key export. Its `signer`
provides `getPublicKey()` and exact verified `signEvent(template)`. The default web
transport uses credentialed fetch; native hosts supply their own cookie transport.
Pending work is bound to the account and auth epoch. Events are never published
and exports never retried or stored. See [SDK usage and actual wire mapping](docs/client.md).

## Embedding and HTTP

Call `initializeAccountDatabase(path)` explicitly for a new installation. It
creates a mode-0600 file and refuses existing paths. `createAccountServer(config)`
opens an existing schema without applying migrations. Keep its directory private
and backups separate from public caches. Stop admissions and new worker drains, await `whenIdle()` and the active mail
worker, then call `close()`. Closing active database work is rejected.

The factory accepts `databasePath`, HTTPS origin `baseURL`, optional `basePath`
(default `/v1/auth`), a random authentication `secret` of at least 32 characters,
exact HTTPS `trustedOrigins`, fixed trusted `returnURLs`, and an optional private
`mail` adapter. No external provider is configured by default. The adapter receives
`{ kind, email, url, token, expiresAt }` and an AbortSignal; it must avoid logging
message data or raw provider errors and honor cancellation. `mailTimeoutMs`
defaults to 5000 and can shorten the provider deadline.

Custody automatically enables the encrypted outbox. Authentication callbacks await
local enqueue before returning, while external delivery only happens through
`await server.mailOutbox.drain()`. Schedule this private worker regularly, including
when no transport is configured so expired rows are removed. The worker processes
at most 16 messages per call, one provider call at a time. An adapter that ignores
cancellation retains that single slot until it settles. Stop accepting work and
drain the worker before `server.close()`; close rejects while delivery is active.
The library does not start a timer or expose a public mailbox endpoint.

Each message has a unique immutable ID and a JWE payload containing its recipient,
kind, token, URL and exact link expiry. Encryption reuses the independently supplied
custody keyring with the distinct `account-mail` purpose and installation/message
binding. Neither password changes nor recovery change encryption keys. Keep old
keys until their queued messages and retained backups no longer need them. Plaintext
is confined to bounded transient work; JavaScript cannot guarantee zeroization.

`mailOutbox: { maxMessages, maxBytes }` optionally lowers or raises the default
1024-message, 4 MiB ciphertext limits (maximum 10000 messages and 16 MiB). Individual
plaintext messages are limited to 16 KiB. Failures retry with exponential backoff
starting at one second, capped at one minute, for at most five attempts. Claims use
persisted leases lasting the provider deadline plus one second; a crashed worker's
lease must expire before retry. Delivery is at least once: a crash after provider
acceptance and before local deletion can produce a duplicate. Invalid ciphertext
and exhausted retries remain encrypted until link expiry, then are purged. This is
a single-server/writer design, not a distributed delivery queue.

`server.mailOutbox.status()` returns only private operator counts, byte totals,
transport availability and a process-local enqueue-failure count. Per-message
retry records contain fixed error codes, never provider text. Keep these diagnostics
behind operator access, outside anonymous APIs. Queue saturation or local enqueue
failure preserves eligibility-neutral `202 { accepted: true }` responses and
increments that private failure count. Acceptance is neither proof of local queue
commit nor a delivery guarantee. Operators must monitor failures; users can retry
the generic verification or recovery request. Malformed requests still return 400.

Without custody, the earlier auth-only compatibility mode remains bounded
best-effort delivery with eight provider slots and no restart guarantee. Full account
service integrations must configure custody and use its encrypted outbox.

Mount only `server.handler(request, { peerAddress })`. Supply the peer from the
transport socket, never forwarding headers. The handler validates its configured
URL origin; the Node adapter constructs URLs from trusted configuration,
without trusting Host or forwarded protocol headers. Secure cookies require HTTPS.
Native clients use a cookie jar and explicitly send the configured web Origin for
mutations. The server does not accept a missing mutation Origin.

| Actual path, relative to `/v1/auth` | Method and native fields | Result |
| --- | --- | --- |
| `/sign-up/email` | POST `email`, `password`, `name`, optional `callbackURL` | `202 { accepted: true }`, no session |
| `/send-verification-email` | POST `email`, optional `callbackURL` | Generic `202` |
| `/verify-email` | GET `token`, optional `callbackURL` | Verification result or redirect, no automatic login |
| `/sign-in/email` | POST `email`, `password`, optional `callbackURL` | Native user and redirect fields, session only in cookie |
| `/get-session` | GET with cookie | Native `{ user, session }` or `null`, session token removed |
| `/request-password-reset` | POST `email`, optional `redirectTo` | Generic `202` |
| `/reset-password` | POST `token`, `newPassword` | Native `{ status: true }`, revoke sessions |
| `/sign-out` | POST `{}` with cookie | Native success and all deletion cookies |

Return URLs match the entire configured URL, including path; extra query strings
and sibling paths are rejected. Missing return URLs use the first configured page.
Recovery mail links directly to that page with a token; the native reset callback
route is not public. Application pages must remove consumed tokens from navigation.
See [the exact wire and error boundary](../docs/accounts-design.md#implemented-account-and-signing-slice).

`requestLimit` defaults to 60 requests per minute globally and per trusted peer;
`sensitiveLimit` defaults to five password checks per account per minute and five
attempts per normalized email per authentication operation per minute. Email
limiter keys are HMAC digests and remain bounded in memory. Both
are bounded in-memory limits per factory instance, not a distributed quota. The
handler bounds input to 64 KiB, headers and URLs to 8 KiB, eight concurrent
requests and a 15-second response deadline. Body reads have a five-second deadline.
Argon2id uses 19 MiB, two passes, one lane and at most two concurrent hashes or
verifications, without an unbounded queue. These are initial operator parameters,
not deployment benchmarks. Requests admitted before a timeout may still complete;
capacity remains occupied until the underlying operation settles.

The server-only `requireAccount(request)` returns our minimal `AccountSession`
from a live database session. `verifyPassword(request, password)` applies its own
account limit before the supported Better Auth verifier. Neither is a public
endpoint. `privateRoutes` extends the same protected ingress used by identity
routes, passing only session-derived authority; each extension must validate its
own body fields and signing policy.

## Private author identity storage

For a fresh custody installation, explicitly call
`initializeIdentityInventory(inventoryPath, installationId)`, then
`initializeAccountCustody(databasePath, { installationId, inventoryPath })`.
Both refuse an existing initialized installation. Pass matching `custody`
configuration to the server: `{ installationId, inventoryPath, encryption:
{ activeKid, keys } }`, where `keys` maps local key IDs to independently supplied
32-byte encryption keys. No setup operation generates or loads secrets for you.
Keep these keys separate from the database, auth secret, relay and wallet keys.
A database marked for custody refuses startup without custody configuration,
even before the first author identity is assigned.

Await `server.ready()` before accepting traffic. The first handler call also
checks initial readiness if the embedding application omitted that call. Full
readiness authenticates every persisted key and reconciles pending assignments.
Use the explicit readiness check again after isolated restore. Structural checks
before registration and provisioning compare every independent assignment with
its immutable account, assignment marker and encrypted-key row. A missing account
in an older backup therefore quarantines registration and provisioning. Missing
storage, unavailable encryption keys and corrupt assigned identities fail startup
or return `503 IDENTITY_UNAVAILABLE` at runtime, never a replacement identity.

Private routes receive `context.identity`, scoped to the current live verified
account, with `getOrCreate()` and `withSecret(callback)`. The trusted low-level
store requires a session-derived account ID
when exposed through HTTP. Its synchronous transaction assigns one public key,
encrypted secret and separate marker; concurrent first calls reuse its winner.
The independent mode-0700 inventory contains only installation/account IDs and
public keys. It publishes mode-0600 files without overwriting, then fsyncs the
file and directory before exposing a public key or invoking a secret callback.
If inventory persistence fails after the SQL commit, retry reconciles that same
winner. A previously durable missing/conflicting record fails closed. Inventory
creation is an explicit first-install action, never automatic missing-file repair.
Keep this inventory on separately durable storage with its own backup; local
files alone do not establish a production recovery guarantee.

Encryption uses [JOSE Compact JWE](https://www.rfc-editor.org/rfc/rfc7516.html)
with fixed `dir`/`A256GCM`, library-generated randomness and authenticated
installation, account, purpose and version binding. Decryption checks the derived
Nostr public key against the immutable assignment. New records use `activeKid`;
retain older decryption keys for existing records and supported backups. Rotation
does not rewrite existing ciphertext. Plaintext keys are not cached; byte buffers
are cleared after use where possible, without promising JavaScript zeroization.

Custody-enabled handlers serialize database operations through a bounded process
lifecycle; body reads remain outside that critical section. Use one server/writer
per database and drain all admitted work before closing. Separate processes and
shared-network-filesystem writers are unsupported. Ordinary access decrypts only
the requested identity and does not rewrite durable assignment state. Global
structural inventory scans are not a measured production scaling guarantee.

## Scoped signing and export

Pass `signingPolicy: { allowedKinds: [1] }` alongside `custody` to mount the
identity routes below. Omitting the policy mounts none; `allowedKinds: []`
permits no signatures. The policy is snapshotted at server creation. This slice
implements only kind 1; configuring other kinds fails startup. Discussion,
zap and media authorization policies remain follow-up work. Set
`explicitExportEnabled: true` separately to allow export; its default is false.

| Path | Request | Success |
| --- | --- | --- |
| `GET /v1/identity` | Live verified session cookie | `{ accountId, publicKey, capabilities: { allowedKinds, exportEnabled } }` |
| `POST /v1/identity/sign` | Cookie, `{ template: { kind, created_at, content, tags } }` | Complete signed Nostr event |
| `POST /v1/identity/export` | Cookie, `{ password }` | `{ publicKey, nsec }` |

These paths are fixed independently of the configurable auth prefix. They use
the same origin checks, 64 KiB ingress limit, live session lookup, no-store
responses and error envelope as authentication. The account comes solely from
the session. Unknown envelope or template fields, including `accountId`,
`pubkey`, `id` and `sig`, are rejected. Kind and timestamp must be nonnegative
safe integers. Content is limited to 16 KiB in UTF-8, with at most 256 tags,
32 strings per tag and 2048 UTF-8 bytes per string. Content and tag strings must
contain well-formed Unicode. Validation preserves all content, timestamps,
duplicates and tag order.

Private route responses have a separate 128 KiB bound, leaving room for signature
fields on an accepted event. An oversized internal response fails with
`503 TEMPORARILY_UNAVAILABLE`; oversized requests still return `413 REQUEST_TOO_LARGE`.

Signing explicitly provisions or reuses the committed identity, decrypts only
inside its account-bound callback and returns the event after recomputing its
ID, checking the exact template and public key and verifying its signature on
a fresh object without the library's cached verification marker. Neither signing
nor export fetches caller URLs, publishes events or accesses wallets. Requests
admitted after logout, expiry or password-reset revocation fail. A signature
already produced before revocation cannot be retracted.

Every export requires the current password through the bounded private auth
verifier, including repeated exports in the same session. A wrong password or
disabled export returns `403 PERMISSION_DENIED`. The native password-verification
route stays unexposed. Ordinary identity, signing and session responses contain
no author secret; only the explicit export response contains `nsec`. Applications
must keep that response out of caches, telemetry and automatic retries.

## Better Auth integration review

Only the eight reviewed native routes above are mounted. Better Auth origin and
CSRF checks remain enabled. The narrow response adapter removes JSON session
tokens, maps errors and registration/recovery responses, and preserves every
`Set-Cookie` header. Cookies are Secure, HttpOnly, SameSite=Lax and host-only.
Session refresh and cookie cache are disabled; no secondary storage is configured.

The pinned source review covers `api/routes/session`, `password`, `sign-up`,
`email-verification`, `update-user`, `cookies`, `utils/password` and the Kysely
adapter in Better Auth 1.7.12. Its raw better-sqlite3 adapter enables transactions;
reset consumes its database verification record, updates credentials and revokes
sessions within `runWithTransaction` when `revokeSessionsOnPasswordReset` is set.
Reset identifiers use native `verification.storeIdentifier: "hashed"`; raw reset
tokens are absent from verification rows. The pinned native adapter supplies the
exact reset-record expiry for queued mail. Tests prove one concurrent reset winner
and inject a SQLite credential-update failure to check rollback of token
consumption, password update and all-session revocation, then reuse the same link
successfully. Unknown framework errors are rethrown into the sanitized facade,
preventing the router console fallback from printing private database errors.
Email verification itself uses signed expiring JWTs and can be repeated without
creating a session. Native password change recreates a session, so it stays
unexposed until adapted to the all-sessions-revoked contract. The supported
server-only `auth.api.verifyPassword` is not mounted. No internal npm file imports
are used. See upstream [sessions](https://better-auth.com/docs/concepts/session-management)
and [password reset](https://better-auth.com/docs/authentication/email-password#revoking-sessions-on-password-reset).

## Pinned dependencies and platforms

Versions, engine constraints and license declarations were checked against the
official npm registry on 2026-10-21. Direct dependencies use exact versions;
`package-lock.json` also pins resolved transitive versions and integrity hashes.
TypeScript 5.9.3 matches the repository's existing compiler line.

| Package metadata | Version | Declared license |
| --- | --- | --- |
| [better-auth](https://registry.npmjs.org/better-auth/1.7.12) | 1.7.12 | MIT |
| [better-sqlite3](https://registry.npmjs.org/better-sqlite3/13.0.3) | 13.0.3 | MIT |
| [@node-rs/argon2](https://registry.npmjs.org/@node-rs/argon2/2.2.2) | 2.2.2 | MIT |
| [jose](https://registry.npmjs.org/jose/6.2.13) | 6.2.13 | MIT |
| [nostr-tools](https://registry.npmjs.org/nostr-tools/2.25.2) | 2.25.2 | Unlicense |
| [typescript](https://registry.npmjs.org/typescript/5.9.3) | 5.9.3 | Apache-2.0 |
| [@types/node](https://registry.npmjs.org/@types/node/24.19.2) | 24.19.2 | MIT |
| [@types/better-sqlite3](https://registry.npmjs.org/@types/better-sqlite3/9.6.0) | 9.6.0 | MIT |

The lockfile's dependency license declarations are MIT, Apache-2.0 and Unlicense,
with none missing. This records package metadata, not a legal opinion or a full
review of bundled native source licenses. Retain upstream notices when distributing.

The validated development platform is **macOS x64, Node 24.22.1**. Native module
loading succeeded, and an in-memory SQLite query reported **SQLite 3.53.4**.
`better-sqlite3` declares Node >=22 and provides native binaries or a source-build
fallback; `@node-rs/argon2` lists platform-specific optional native packages.
Their [SQLite installation guidance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
and [Argon2 platform packages](https://registry.npmjs.org/@node-rs/argon2/2.2.2)
determine installation prerequisites. Linux x64/arm64, macOS arm64 and Windows
are not yet validated by this workspace. Linux deployment and native mobile
cookie-storage acceptance remain separate checks. The SDK does not run Node or
native server modules on a phone.

`npm audit --json` reported **0 known vulnerabilities** for the locked graph on
2026-10-21. Also reviewed upstream advisory listings for
[Better Auth](https://github.com/better-auth/better-auth/security/advisories),
[JOSE](https://github.com/panva/jose/security/advisories),
[SQLite](https://github.com/WiseLibs/better-sqlite3/security/advisories),
[Argon2](https://github.com/napi-rs/node-rs/security/advisories) and
[Nostr tools](https://github.com/nbd-wtf/nostr-tools/security/advisories).
Better Auth's recent
[OAuth/Magic Link advisory](https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm)
and [OAuth Proxy advisory](https://github.com/better-auth/better-auth/security/advisories/GHSA-r4xp-prcw-77qf)
are patched in 1.7.7, before this pin. These plugins are outside the initial flow.
An advisory check is time-bound evidence, not a security audit.
