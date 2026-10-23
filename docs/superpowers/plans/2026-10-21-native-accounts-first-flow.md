# Native Accounts First Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use subagent-driven-development (if subagents are available) or executing-plans to implement this plan. Steps use checkbox syntax for tracking. Reviewers advise on the implementation; their approval is not a security audit.

**Goal:** Deliver a locally runnable account-to-signature flow with stable Nostr identity, verified recovery, explicit export and backup restoration, using Better Auth for account mechanics.

**Architecture:** An independent npm workspace contains a TypeScript server library, a browser-safe client package and a small Node HTTP service. Better Auth serves reviewed ordinary account routes; our library supplies custody, policy and identity routes. Holoboard's Go backend continues accepting signed events and anonymous payments independently.

**Tech Stack:** One pinned supported Node.js LTS runtime, TypeScript, Better Auth, better-sqlite3, Argon2id through @node-rs/argon2, jose and nostr-tools. Resolve and pin compatible versions during Task 1; documentation/source review alone is not version compatibility evidence.

## Scope and evidence

Read [the account contract](../../accounts-design.md) and
[custody research](../../accounts-custody.md). Preserve the user's own UI, stable
identity after reset, anonymous invoices, external signers and independent wallet.
The account contract's table describes logical operations. It does not require
implementing a parallel authentication framework or a facade for every endpoint.

The custody comparison found Divine Keycast headless account endpoints, so an
owned UI alone is not a reason to replace it. This plan retains Better Auth and
our custody orchestration because the requested result is an embeddable
TypeScript library with the specified session/recovery behavior. Do not add a
second Keycast account database or describe this choice as proven safer or
cheaper. Source review is complete enough to attempt the first local flow; the
integration tests below must supply the missing runtime evidence.

This plan covers the first complete account/signature flow. Full per-device
management UI, every Holoboard signing policy, production deployment and NIP-46
hosting remain follow-up work from the account contract; do not report the entire
account feature complete after this slice. No real mail, public relay publication,
spending, production migrations or deployment is authorized by this plan.

Use @holoboard-verify-change to select bounded checks for each delta. Use
@holoboard-ui before integrating account forms into the actual Holoboard UI.
Run builds and tests natively. Do not start Docker or a full existing browser
matrix for the new isolated account package.

The existing Android project is a Bubblewrap/TWA wrapper of the website. Its
browser-session checks are useful but do not establish native Swift/Kotlin or
React Native cookie storage. Native acceptance below is a distinct gate.

## File responsibilities

| Area | Planned files | Responsibility |
| --- | --- | --- |
| Workspace | accounts/package.json, accounts/package-lock.json, accounts/tsconfig.base.json, accounts/.gitignore, accounts/README.md | Separate dependency graph, pinned tools, native checks, no committed runtime secrets |
| Server package | accounts/packages/server/package.json, accounts/packages/server/tsconfig.json, accounts/packages/server/src/index.ts | Public account-handler factory and configuration |
| Auth integration | accounts/packages/server/src/auth.ts, accounts/packages/server/src/account-routes.ts | Configure Better Auth; mount reviewed native routes; narrow response/privacy hooks where needed |
| Persistence | accounts/packages/server/src/database.ts, accounts/packages/server/migrations/0001.sql | Private database, explicit migrations and transaction boundaries |
| Custody | accounts/packages/server/src/key-encryption.ts, accounts/packages/server/src/identities.ts | Established JWE, immutable account mapping and concurrency-safe provisioning |
| Recovery | accounts/packages/server/src/identity-inventory.ts, accounts/packages/server/src/recovery.ts | Independent durable assignment records, consistent backup, quarantine and restore reconciliation |
| Signing | accounts/packages/server/src/policy.ts, accounts/packages/server/src/identity-routes.ts | Live authorization, exact-event policy, signatures and password-confirmed export |
| Mail | accounts/packages/server/src/mail.ts, accounts/packages/server/src/mail-outbox.ts | Configurable delivery and bounded encrypted outbox; tests capture links privately |
| Server tests | accounts/packages/server/test/fixtures.ts, auth.test.ts, identities.test.ts, signing.test.ts, recovery.test.ts, restore.test.ts, http.test.ts | Real package integration with isolated temporary databases and test-only keys |
| Client package | accounts/packages/client/package.json, accounts/packages/client/tsconfig.json, accounts/packages/client/src/index.ts, transport.ts, signer.ts | Browser-safe SDK without server, React or DOM dependencies in its core |
| Client tests | accounts/packages/client/test/client.test.ts, signer.test.ts | Exact-event verification, session errors and late-response rejection |
| Service | accounts/apps/service/package.json, accounts/apps/service/src/main.ts, config.ts | Environment loading, HTTP adapter, startup/shutdown and explicit local migration command |
| Web example | accounts/examples/web/index.html, app.js, README.md | Minimal own-brand account forms and one signing action using the built client |
| Embedded example | accounts/examples/embedded.mjs | Mount the built server library in a minimal Node HTTP application |
| Native evidence | accounts/examples/native/README.md | Reproducible native-client setup and actual device/simulator evidence; source API calls alone are insufficient |

New package names are private implementation names, not permission to publish.
The client must build independently for web consumption; installing it must not
pull native server dependencies into the browser application. Extend ignore rules
for node_modules, dist, private state, databases and test output before installs.

## Task 1: Establish the isolated package boundary

- [x] Record the selected Node version, exact dependency versions and supported platforms in accounts/README.md after checking official package metadata, advisories and licenses. Inspect the pinned Better Auth APIs used for sessions, reset transactions, mail, password verification and response shaping.
- [x] Create the three private workspace packages and TypeScript configurations. Follow curator's native Node test approach where applicable. Define workspace scripts: check runs package type checks; test runs focused package tests; build emits separate client/server outputs.
- [x] Install only inside accounts with an exact-version lockfile. Do not update web/package-lock.json, curator/package-lock.json or the Go dependency graph.
- [x] Run npm run check, npm test and npm run build from accounts. Confirm that the built client import graph contains no server/native database or key-storage implementation. A test runner finding no behavior tests is not acceptance of accounts.
- [x] Commit the scoped package/configuration change after metadata and diff review. Do not push.

## Task 2: Configure account mechanics and real HTTP protections

- [x] Add auth.test.ts and http.test.ts using a temporary SQLite database, configured test origins and a private mail-capture adapter. Require verification before login; reject a hostile origin and excessive input on actual public handlers.
- [x] Run the focused files from accounts/packages/server with node --experimental-strip-types --test test/auth.test.ts test/http.test.ts. Establish the failing behavior assertions before implementing the handlers.
- [x] Configure the pinned Better Auth instance: no signup auto-login, verified-email gate, Argon2id hash adapter, database-backed sessions and reset verification, fixed bounded session expiry, no session cache/secondary store, explicit reset revocation and transactional database support.
- [x] Mount reviewed ordinary auth routes directly. Use narrow response hooks/middleware for required secret redaction and generic errors instead of recreating auth flows. Write the exact native wire paths and response mapping into accounts/README.md and align docs/accounts-design.md. Do not expose raw session tokens in browser JSON or unreviewed native management routes.
- [x] Apply public request limits, trusted-proxy handling, origin/CSRF checks, no-store responses and log redaction at the actual ingress. Server-side auth.api calls need their own limits. Keep application links on configured allowlists and remove consumed tokens from navigation.
- [x] Rerun both focused files plus the server type check. Inspect actual Set-Cookie and error responses, including multiple cookie headers. Commit only after the public chain is covered.

## Task 3: Implement stable encrypted identity provisioning

- [x] Add identities.test.ts for concurrent provisioning, swapped/tampered ciphertext, account substitution, missing encryption keys and a deleted key row for a previously assigned identity. Run it and establish the failures.
- [x] Implement the JWE provider with fixed dir/A256GCM algorithms, library-generated randomness, configured key IDs and authenticated installation/account/purpose/version binding. The provider resolves only local configured keys. Do not implement encryption primitives or custom ciphertext framing.
- [x] Add the private identity schema and a transaction that creates the encrypted key, public key and assignment marker together. Provision only after verified authentication. Retry reuses the committed winner; known missing/corrupt identities fail unavailable.
- [x] Implement identity-inventory.ts with a durable assignment record per immutable account ID and public key, separate from the restorable database. For the local provider use a separate private directory with atomic writes and durability checks. Persist/reconcile the assignment after the key transaction commits and before any public key/signature is exposed. A crash/retry reuses the committed identity; a conflicting or unavailable inventory fails closed. Do not record email addresses or private keys in this inventory.
- [x] Use test-only generated keys through nostr-tools, never existing relay/user credentials. Verify assignment against the decrypted key's derived public key. Keep encryption secrets separate from the database and auth secret.
- [x] Run identities.test.ts and the server type check. Record the configured storage format and rotation behavior, then commit the scoped custody change.

## Task 4: Connect exact signing and explicit export

The client-facing signer interface is deliberately small:

```typescript
import type { Event, EventTemplate } from "nostr-tools/pure";

export interface AccountSigner {
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
}
```

- [x] Add signing.test.ts covering a permitted kind-1 event, unauthorized kinds, another account's key, revoked sessions, supplied id/sig/pubkey, changed content/tags/timestamp and an explicit export requiring the current password.
- [x] Implement identity routes and a default-deny policy. Authenticate live state before choosing an identity; validate the exact bounded template; decrypt/sign inside the custody module and verify the resulting public key/event before returning it.
- [x] Implement export through the pinned server-side password verifier, with rate limits and no caching/logging. Export has a separate explicit action and returns nsec only for that action. If the supported verifier API cannot meet the contract, fix/replace the adapter rather than expose framework internals or silently weaken authentication.
- [x] Run signing.test.ts and server checks. Verify that the test process made no public relay connection, publication or wallet request. Commit this signing slice without enabling production entry points.

## Task 5: Prove reset and recovery invariants

The integration fixture must support this complete assertion sequence:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFixture } from "./fixtures.ts";

test("reset preserves identity and revokes both devices", async (t) => {
    const fixture = await accountFixture(t);
    const first = await fixture.registerVerifyAndLogin();
    const second = await fixture.loginOnAnotherDevice();
    const before = await first.signer.getPublicKey();
    const link = await fixture.requestRecovery();
    await fixture.completeRecovery(link);
    await assert.rejects(first.sign(), { code: "UNAUTHENTICATED" });
    await assert.rejects(second.sign(), { code: "UNAUTHENTICATED" });
    await fixture.assertOldPasswordRejected();
    await fixture.assertRecoveryLinkSpent(link);
    const recovered = await fixture.loginWithRecoveredPassword();
    assert.equal(await recovered.signer.getPublicKey(), before);
});
```

- [x] Implement the fixture as actual HTTP clients with separate cookie jars and captured test mail. Do not mock session revocation or the identity store.
- [x] Add concurrent use of one reset token and injected transaction failure. Verify token consumption, credential change and revocation succeed/fail together. Exercise recovery after process restart and reject callbacks outside configured return URLs.
- [x] Run recovery.test.ts from accounts/packages/server. Fix configuration/integration boundaries until the real transaction satisfies these assertions. Do not move critical revocation into a post-reset callback.
- [x] Queue token-bearing email payloads through the bounded encrypted test outbox; verify expiry/retry behavior without sending external mail. Keep generic public responses independent of delivery eligibility.
- [x] Commit the verified recovery flow, documenting the tested runtime/adapter and remaining native/operational acceptance.

## Task 6: Build the browser-safe SDK and runnable service

- [x] Add client/signing tests with tampered responses and account-switch/logout races. Snapshot expected templates, verify cryptographic signatures and reject late results; do not silently retry exports or change event timestamps.
- [x] Implement configurable account transport and AccountSigner. Map reviewed native auth responses into stable SDK results/errors; keep HTTP usable without the SDK. Expose capabilities rather than claim every Nostr operation is supported.
- [x] Implement the small service wrapper, explicit private-database initialization command and startup checks for configured secrets and inventory. Missing production-mode keys fail startup; never generate replacement secrets automatically. Preserve graceful shutdown and secret-free logs. Create accounts/examples/embedded.mjs with the same handler, mail-capture adapter and isolated state; document node examples/embedded.mjs from accounts as its command.
- [x] Run the workspace check/test/build commands. Start the service locally with isolated test state and the mail-capture transport, exercising the same handler as the embedded Node example. Stop the service after verification unless the user requests it remain running.
- [x] Commit SDK/service changes and document exact local commands without including generated credentials.

## Task 7: Verify browser, native storage and restoration

Restoration invalidates restored credentials as well as sessions. Require native
email password recovery before login so an older password hash cannot regain
access. Email verification links are stateless signed JWTs in the pinned Better
Auth version; enforce a fresh auth secret on the restored target rather than
relying on deleting verification rows. This secret is separate from the retained
Nostr encryption keyring.

- [x] Add the minimal web example with own forms for verification, login, signing, recovery and export. Test cookie behavior on reviewed same-site origins and a rejected cross-site origin. PWA caches must exclude account responses.
- [ ] Exercise one actual native client with platform-protected session persistence: login, restart, sign, expiry, logout and revocation from a second client. Record exact device/runtime and checks in accounts/examples/native/README.md. Do not count curl, a desktop cookie jar, Expo documentation or the existing TWA wrapper as proof of a native storage adapter.
- [x] Implement recovery.ts using a consistent SQLite backup, explicit restore into an isolated target, restored-session/token invalidation and comparison against the independently preserved identity inventory. Keep registration and identity provisioning quarantined until every inventoried assignment is reconciled with the recovered account/key records. Missing accounts in a stale backup must also keep the gate closed, preventing re-registration under a new account ID from silently producing a replacement key. Unrecoverable records require explicit recovery handling, not automatic removal from the inventory. This behavior belongs in the service/library, not only a test fixture.
- [x] Add restore.test.ts that invokes those real backup/restore operations with independent inventory and encryption-key stores. Verify the same public key, rotation, missing keys, a backup preceding key assignment, a backup preceding account registration and restart while reconciliation is incomplete. Assert that registration/provisioning stay blocked for unreconciled records. Separately durable production inventory storage and the supported recovery point remain activation requirements.
- [x] If required device tooling is unavailable, report native acceptance as outstanding. Continue server/SDK/restore work; do not claim native support verified or start installing large device toolchains without considering machine constraints.
- [x] Run only the relevant package/browser checks for changes made. Update account documentation with measured results and limitations, and commit scoped changes. No production activation is implied.

Native acceptance remains open because Android tooling and Xcode's simulator are
unavailable on the development machine. The
[native acceptance note](../../../accounts/examples/native/README.md) records the
required device checks. The local preview satisfies the tooling exception above;
it does not establish native mobile compatibility or production readiness.

## Handoff and follow-up scope

Before connecting to Holoboard's actual UI, review the library/SDK boundary,
custody/recovery evidence and dependency extension points. Then add disabled-by-
default account configuration and the account signer through ConnectedSigner,
using the existing modal and connection behavior. Select web verification from
the actual diff. Preserve the current Pages production profile and payment state.

Remaining first-version acceptance includes Holoboard's enabled reply/zap/upload
policies, per-device management, feature rollback, resource measurements and
mail/deployment configuration. NIP-46 hosting is a separate transport project;
NDK's backend is a candidate requiring its own pairing, grant and release review.
Better Auth configuration, custody and NIP-46 must not become a single untestable
module. An implementation issue may justify a focused design adjustment; routine
adapter work does not require reopening the entire architecture.
