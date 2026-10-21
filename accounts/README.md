# Accounts workspace

Private TypeScript packages for an embeddable account handler and future service
and client SDK. The server implements email registration, verification, login,
fixed seven-day database sessions, logout and password recovery through Better
Auth. Custody, signing, the runnable service and client transport remain pending.
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
files to limit native hashing memory. Builds emit ESM and declarations to each
package's `dist`. The server package also includes `migrations/0001.sql`, loaded
relative to either source or emitted JavaScript.

| Package | Responsibility | Runtime dependencies |
| --- | --- | --- |
| `@holoboard/accounts-server` | Account handler, private persistence and future custody | Better Auth, SQLite, Argon2, JOSE, Nostr |
| `@holoboard/accounts-client` | Signer types; transport and SDK pending | `nostr-tools` only |
| `@holoboard/accounts-service` | Configuration and HTTP lifecycle pending | Server package only |

The client has no server-package, database, password, key-storage, React or
browser-global dependency. Its separate installation boundary was checked during
scaffolding. No existing web, curator or Go dependency graph is changed.

## Embedding and HTTP

Call `initializeAccountDatabase(path)` explicitly for a new installation. It
creates a mode-0600 file and refuses existing paths. `createAccountServer(config)`
opens an existing schema without applying migrations. Keep its directory private
and backups separate from public caches. Drain requests before `close()`.

The factory accepts `databasePath`, HTTPS origin `baseURL`, optional `basePath`
(default `/v1/auth`), a random authentication `secret` of at least 32 characters,
exact HTTPS `trustedOrigins`, fixed trusted `returnURLs`, and a private `mail`
adapter. The mail adapter receives `{ kind, email, url, token }` and an AbortSignal;
it must avoid logging message data and honor cancellation. External delivery runs
in the background, with a five-second maximum deadline and eight retained provider
slots even if an adapter ignores its signal. Provider errors, deadlines and full
capacity never enter authentication responses or logs. `mailTimeoutMs` can shorten
the deadline. This slice has no durable mail outbox: messages may be lost on process
exit or when capacity is full, and acceptance does not promise delivery. The
durable outbox must await local enqueue before acceptance while keeping external
provider completion independent. Retry/outbox acceptance is pending.

Mount only `server.handler(request, { peerAddress })`. Supply the peer from the
transport socket, never forwarding headers. The handler validates its configured
URL origin; a future HTTP adapter must construct URLs from trusted configuration,
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
See [the exact wire and error boundary](../docs/accounts-design.md#implemented-authentication-slice).

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
endpoint. `privateRoutes` extends the same protected ingress for future identity
routes, passing only session-derived authority; each extension must validate its
own body fields and signing policy.

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
Email verification itself uses signed expiring JWTs and can be repeated without
creating a session. Atomic reset under injected failure and concurrency remains
separate acceptance. Native password change recreates a session, so it stays
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
