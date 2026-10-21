# Accounts workspace

Private, independent TypeScript packages for an embeddable account service and
client SDK. This scaffold defines package boundaries only. Account routes,
storage, mail, custody and HTTP startup are not implemented. The service entry
point is intentionally inert. See the [account contract](../docs/accounts-design.md)
for required behavior and remaining acceptance.

Use Node.js **24.22.1** and npm **11.19.1**, pinned in `.nvmrc`, `engines` and
`packageManager`. Node 24 is an LTS line in the
[official support schedule](https://github.com/nodejs/Release#release-schedule).
The selected patch is listed in the [official release index](https://nodejs.org/dist/index.json).
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

`check` checks each package independently. `build` emits declarations and ESM to
separate package-local `dist` directories. `test` discovers `test/*.test.ts` in
each package and runs native Node tests with
`node --experimental-strip-types --test test/*.test.ts`. Until behavioral tests
exist, it explicitly reports their absence and does not manufacture passing
cases. A successful scaffold command is not account acceptance.

| Package | Responsibility | Runtime dependencies |
| --- | --- | --- |
| `@holoboard/accounts-server` | Shared HTTP handler boundary, future account and custody implementation | Better Auth, SQLite, Argon2, JOSE, Nostr |
| `@holoboard/accounts-client` | Shared signer boundary, future transport and SDK | `nostr-tools` only |
| `@holoboard/accounts-service` | Future configuration and HTTP lifecycle around the server library | Server package only |

The client compiles with ES2024 libraries and no Node or DOM ambient types. Its
current emitted JavaScript has no imports; its declaration imports only event
types from `nostr-tools/pure`. It has no server-package, database, password,
key-storage, React or browser-global dependency. It currently exposes types,
not a working account client. Workspace hoisting does not define the consumer's
dependency graph: install the client artifact separately when checking this
boundary. No existing web, curator or Go dependency graph is changed.

Scaffold verification on the pinned macOS x64 runtime: workspace `check` and
`build` completed successfully. `test` completed with **zero behavioral tests**,
explicitly reported for all three packages. Native dependency imports and an
in-memory SQLite query succeeded. A locally packed client was installed in a
separate temporary npm project, using the package cache and no install scripts;
its import succeeded and its locked dependency graph contained no server,
Better Auth, SQLite, Argon2 or JOSE packages. These checks do not verify an
account flow, browser transport or native cookie storage.

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

## Better Auth 1.7.12 integration findings

The following are source findings from the installed release, not tested account
behavior. Paths below are relative to `accounts`; npm hoisting may move files
on a future install. Public imports must use supported package exports instead
of these implementation paths.

- **Sessions:** `packages/server/node_modules/better-auth/dist/api/routes/session.mjs`
  reads the database when cookie cache is disabled.
  `session.disableSessionRefresh: true`, `expiresIn: 604800` and
  `cookieCache.enabled: false` express the fixed seven-day policy. Do not
  configure secondary storage. Sensitive middleware performs an authoritative
  session read. Account status must still be checked by our identity routes.
- **Reset transaction:** `dist/api/routes/password.mjs` calls
  `dist/utils/password.mjs`'s `resetCredentialPassword`, which wraps token
  consumption, optional session deletion and credential update in
  `runWithTransaction`. Enable `emailAndPassword.revokeSessionsOnPasswordReset`.
  Database verification records and database sessions are required for rollback;
  secondary-storage token consumption cannot roll back. The `onPasswordReset`
  callback runs after the helper completes and must not own critical revocation.
- **SQLite transactions:** `node_modules/@better-auth/kysely-adapter/dist/index.mjs`
  detects a raw `better-sqlite3` instance through its `aggregate` method and sets
  `transaction: true`. `dist/db/adapter-kysely.mjs` passes that to the adapter.
  If supplying a `{ db, type }` or `{ dialect, type }` configuration instead,
  explicitly set `transaction: true`; those forms propagate the configured flag.
  Kysely runs the callback on its transaction object. Failure injection and
  concurrent reset-token tests are still required before claiming atomic reset.
- **Mail and passwords:** `node_modules/@better-auth/core/dist/types/init-options.d.mts`
  declares `emailVerification.sendVerificationEmail` and
  `emailAndPassword.sendResetPassword` callbacks with `{ user, url, token }` and
  an optional Request. `emailAndPassword.password.hash/verify` supports an
  Argon2id adapter. No mail transport or hash parameters are configured yet.
  Set `autoSignIn: false`, `requireEmailVerification: true` and verification's
  `autoSignInAfterVerification: false` during integration.
- **Export password verification:** `dist/api/routes/password.mjs` defines
  `verifyPassword` with `metadata.scope: "server"` and sensitive-session middleware.
  The supported server API is `auth.api.verifyPassword({ body: { password }, headers })`.
  It checks the credential hash belonging to the live session user through the
  configured verifier. Keep it behind our private export adapter and limits;
  never add `/verify-password` to the public route allowlist.
- **Response privacy:** `dist/api/routes/sign-in.mjs` returns the session token
  in JSON as well as a cookie; session-list/read responses also need review.
  `dist/api/dispatch.mjs` lets after-hooks replace `context.returned` while
  preserving accumulated response headers. Plugin `onResponse` in
  `dist/api/index.mjs` can also replace the final Response. Redact credentials
  through a narrow integration hook, preserve every `Set-Cookie` header, and
  retain expiration/deletion attributes. `dist/cookies/index.mjs` sets HttpOnly,
  SameSite=Lax and conditional Secure; cross-subdomain cookies are opt-in.
  Configure secure, host-only cookies for HTTPS. No redaction is implemented yet.
- **Ingress:** the HTTP router applies its request limiter in `dist/api/index.mjs`;
  direct `auth.api` dispatch does not pass through that limiter. Our public chain
  still needs body limits, exact origin policy, JSON-only mutations, no-store,
  error mapping and independent limits for internal sensitive calls. Mount only
  reviewed routes, preserving framework origin and CSRF checks.
- **Password change mismatch:** `dist/api/routes/update-user.mjs` revokes sessions
  and changes the password transactionally when `revokeOtherSessions` is true,
  then creates a replacement session and returns its token/cookie. This does not
  meet the account contract's all-sessions-revoked/relogin requirement. Keep
  `/change-password` outside the initial allowlist until adapted and tested.

Other `dist/...` paths above are under the installed `better-auth` directory.
See upstream [sessions](https://better-auth.com/docs/concepts/session-management),
[password reset](https://better-auth.com/docs/authentication/email-password#revoking-sessions-on-password-reset)
and [rate limits](https://better-auth.com/docs/concepts/rate-limit).
The first implementation must test these settings through the actual public
handler, without exposing unreviewed framework routes.
