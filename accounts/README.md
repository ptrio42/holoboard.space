# Holoboard email accounts

Holoboard uses an isolated, self-hosted [Keycast](https://github.com/divinevideo/keycast)
service for email/password registration, verification, password recovery and
remote signing. Guest posts and invoice payments do not require this service.
The application adapter and build source are pinned to
`fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0`.

Keys stay in Keycast, encrypted by its key manager. Holoboard receives a scoped
OAuth access token through PKCE, checks callback origin, window and state, and
verifies every signature against the requested content and account. The app
keeps access credentials in the browser tab's session storage. Expired sessions
require another sign-in. Emails and passwords never enter Holoboard events.
The dedicated `/account/callback.html` entry only returns the authorization
response to its original tab. It does not start board reads, restore payments
or connect a signer, and the service worker excludes it from SPA navigation.

## Prepare a dedicated service

1. Run `python3 accounts/prepare-source.py --app-origin https://holoboard.example`.
   This downloads the pinned source into ignored `output/keycast/source` and
   adds the same-origin session-revocation page. It starts no services.
2. Copy `.env.example` outside the repository and set its explicit paths and
   origins. Use a new database password and a new account-service identity.
   `KEYCAST_SECRETS_FILE` is a private mode-600 environment file with `SERVER_NSEC`
   and `SENDGRID_API_KEY`. Add independent `KEYCAST_RETENTION_DIGEST_KEYS` roots
   following the pinned Keycast configuration. Never reuse the relay's key,
   receiving-wallet credentials, database or production account data.
3. Create a separate encryption key with `openssl rand -base64 32` in a private
   mode-600 file and set `KEYCAST_MASTER_KEY_FILE`. Back up the database and this
   key together using the chosen hosting environment's secret management.
   Compose mounts it at `/app/master.key`, the fixed path used by the pinned
   file key manager, which does not read `MASTER_KEY_PATH` when loading the key.
4. Build sequentially with `docker compose --env-file /private/path/accounts.env
   -f accounts/compose.yml build keycast`. Start only `postgres redis`, then use
   `run --rm migrate` for the **new dedicated database**. Upgrading existing data
   requires separate migration approval.
5. Run `bootstrap.sql` through `psql` against that database, supplying exact
   `tenant_domain`, `client_id` and `callback_uri` variables. The callback is
   `https://holoboard.example/account/callback.html`. The bootstrap registers the
   `holoboard` policy for kinds 1, 1111 and 9734. It does not grant encryption,
   wallet, profile or account-management permissions to the app token.
6. Start `keycast`. Its single HTTP listener is bound to loopback port 3100 by
   default. Put the configured HTTPS account origin in front of it, preserving
   Host and cookie headers. Keep PostgreSQL and Redis private.

Enable `VITE_ENABLE_EMAIL_ACCOUNTS=true` and set `VITE_KEYCAST_URL` and
`VITE_KEYCAST_CLIENT_ID` in an ordinary opt-in frontend build. Creation separately
needs `VITE_ENABLE_POST_CREATION=true` and backend `ENABLE_POST_CREATION=true`.
The approved Pages production build keeps the new features off. Enabling or
hosting them in production needs a separate release decision.

## Sign-out and recovery

The pinned Keycast version's `/api/auth/logout` only clears its cookie. An OAuth
signing token cannot call `/api/user/sessions/revoke`. The injected
`holoboard-session.html` instead asks the user to revoke the specific authorization
using Keycast's own first-party session. Only a confirmed revocation clears the
local Holoboard account. Failure retains the connection and offers a retry or
account management. The wallet connection is independent. Key export and session
management use Keycast's existing account/security screens.

The popup keeps the live editor and payment choices intact. Unpaid signed posts
are already held by their invoices, so settlement and publishing do not need an
active login or open browser. Anonymous guest keys live only in memory, with an
optional `nsec` export. Account creation never claims earlier guest posts.

## Local verification and release limits

Use fictional addresses and identities, local relays, mock invoice payments and
isolated volumes. In development, Keycast's existing captured mail sender and
`ENABLE_DEV_EMAIL_INBOX=true` expose `/api/dev/emails` for verification/reset
fixtures. Keep that route on loopback with fictional accounts only. Do
not point a local service at a production database or mail provider.

`web/tests/boardCreation.spec.ts` covers the app's OAuth/PKCE protocol against a
local intercepted service, exact signing and explicit revocation. It does not
establish Keycast's real database, email or hosting behavior. Verify registration,
email links, reset, export and revocation against a running isolated service
before enabling accounts for users. Keycast's pinned
[security document](https://github.com/divinevideo/keycast/blob/fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0/docs/SECURITY.md)
states that a formal application audit has not been completed.
