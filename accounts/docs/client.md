# Account client SDK

```ts
import { createAccountClient } from '@holoboard/accounts-client';

const accounts = createAccountClient({ baseURL: 'https://accounts.example.test' });
await accounts.login('reader@example.test', password);
const publicKey = await accounts.signer.getPublicKey();
const event = await accounts.signer.signEvent({
  kind: 1, created_at: 1700000000, content: 'Exact text', tags: [],
});
```

The default web transport uses credentialed fetch, manual redirects and no-store.
It never reads session cookies or writes browser storage. `transport` is injectable;
a native host must implement the exported `AccountTransport` contract with its own
HTTPS client, cookie jar and platform-protected persistence. Preserve every cookie,
expiry and deletion, and send an allowed configured Origin for mutations. The SDK
has no DOM ambient types, Node, React or server dependency. Browser globals are
used only by the optional web transport; a native host supplies its transport.

| SDK method | Actual operation |
| --- | --- |
| `register({ email, password, name, callbackURL? })` | POST auth `sign-up/email`; generic acceptance, no session |
| `verifyEmail(token)` | GET auth `verify-email` without a callback; requires explicit JSON success, no automatic login |
| `requestVerification(email, callbackURL?)` | POST auth `send-verification-email` |
| `login(email, password)` | POST auth `sign-in/email`, then live `get-session` |
| `getSession()` | GET auth `get-session`, normalized user/session or null |
| `logout()` | Clear local state immediately, then POST auth `sign-out` |
| `requestRecovery(email, redirectTo?)` | POST auth `request-password-reset` |
| `resetPassword(token, newPassword)` | Clear local state, then POST auth `reset-password` |
| `getIdentity()` | GET fixed `/v1/identity`; binds session-derived account ID |
| `exportKey(password)` | POST fixed `/v1/identity/export`, explicit caller action only |

`authBasePath` defaults to `/v1/auth`; identity paths remain fixed at `/v1/identity`.
Login checks the live session against its sign-in account before changing local
state. Session JSON retains only user fields and session ID/expiry, never a credential.
`currentSession` is a defensive in-memory copy. After a page reload, explicitly
call `getSession()` before signing. Account state uses an epoch: logout, reset,
login, a changed session and a current 401 invalidate pending work. Identity reads
also compare the server's session-derived account ID to detect cookie changes
outside the current client instance. Each sign call snapshots all template fields
and rejects extra fields, altered content/tags/time/kind, wrong public key/hash or
signature and a late result after logout, account switching or known expiry.
Verification reconstructs a fresh event before calling `nostr-tools`; cached
verification symbols cannot bypass it. Signing does not publish or adjust timestamps.

`AccountClientError` exposes a fixed `code`, numeric `status`, `retryable` and
optional `retryAfterSeconds`. Dependency messages, server error text and private
values are discarded. Requests are limited to 64 KiB and responses to 128 KiB in
actual UTF-8 bytes. The default deadline is 15 seconds, configurable with
`timeoutMs` (1 to 60000). A custom transport must also bound its I/O to the supplied
limits/deadline; SDK timeout stops result handling but cannot retract a server
signature. Network/timeouts, 429 and 503 errors permit explicit retry after checking
the account. No request retries automatically, including export. Export validates
the NIP-19 checksum and derives the expected public key before returning the raw
`nsec`; it retains no backup. Callers must keep that explicit result out of caches,
telemetry and logs. JavaScript cannot guarantee secret zeroization.


Programmatic verification deliberately omits the native callback URL: native
error links also redirect, and browsers hide redirect status details. The SDK
rejects redirects and accepts only `{ status: true }`, returning `{ verified: true }`.
The host controls navigation after that result.

Login, logout and password reset serialize their cookie-changing requests within a
bounded shared scope (eight admitted mutations, including one active transport).
Logout clears local session state immediately, but returns success only after all
previous admitted login/reset/logout cookie writes and its own server sign-out
complete. A later explicit login can establish a new session. Session reads wait for preceding cookie operations;
pending identity, signing and export work is invalidated by shared auth transitions.

Default browser SDK instances in the same JavaScript realm and with the same API
origin share a scope. Injected clients sharing the exact transport function and API
origin share one too. When separate adapters use one cookie jar, pass the same
`authScope: createAccountAuthScope()` to every client. A host must preserve that scope
when constructing another SDK while requests remain unresolved. This in-memory
coordination does not synchronize unrelated tabs, realms or native processes.
Reloading or replacing the host during an unresolved operation requires the host's
own transport/cookie lifecycle handling; this is not cross-tab revocation storage.

SDK deadlines do not mean an injected transport has stopped. Its slot and cookie
fence remain until the actual transport promise settles. Timed-out queued mutations
never dispatch later. Automatic session restoration remains blocked after uncertain
transport failure, including in a fresh SDK sharing the scope, until an explicit
successful login, logout or reset resolves the state. Callers receive bounded
`REQUEST_TIMEOUT` or `TEMPORARILY_UNAVAILABLE`, with no automatic mutation retry.
A permanently stuck adapter keeps its bounded slots unavailable.

An `AccountTransport` promise must settle only after every cookie write has completed
or been definitively cancelled. Never race an internal timer while detached work can
still update the jar. The SDK itself supplies its deadline around that full lifecycle.
The default web transport aborts browser fetch on timeout; injected fetch replacements
must honor AbortController's cancellation semantics. External cookie writers are
outside this coordinator's guarantee.
