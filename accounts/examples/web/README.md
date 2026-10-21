# Developer web example

This small form application uses the **built** account client package and the same
server factory, TLS bridge and lifecycle as the standalone service. It does not
change Holoboard's frontend, flags, relay access or wallet behavior.

From `accounts/`, with the pinned Node/npm toolchain:

```sh
npm ci
npm run build
npm run build:web
node examples/local-setup.mjs /private/tmp/account-form-example 3443
node apps/service/dist/main.js init /private/tmp/account-form-example/config.json
node examples/web/server.mjs /private/tmp/account-form-example/config.json
```

Open `https://127.0.0.1:3443`. The generated certificate is only for local testing;
the automated browser check trusts its ephemeral public-key fingerprint without
changing OS trust or disabling certificate checks globally. Interactive use needs
an explicit temporary certificate exception in an isolated developer profile.
Stop the server with Ctrl-C before maintenance or deleting its private directory.

Register, read the private mode-0600 `mail.jsonl` capture locally, and open
`https://127.0.0.1:3443/complete?token=<verification-token>` using the captured
verification token. Click Verify, then sign in. The direct native mail URL also
verifies and returns to `/complete`; there is no automatic sign-in. Recovery mail
already points to the form page with its token. Click Reset password after choosing
a new password, then sign in again. Both paths immediately remove tokens from the
address/history entry, retaining them only in page memory. Reload before consumption
requires opening the private link again. Do not publish captures or tokens.

The example provides registration, resend, verification, sign-in, session refresh,
unpublished kind-1 signing, recovery, reset, explicit password-confirmed key export
and logout. Export deliberately displays the key only after its explicit action;
Clear result, another action, navigation or reload removes it. JavaScript cannot
promise memory zeroization. User values use `textContent`. There is no telemetry,
web storage, IndexedDB, service worker, export cache or automatic mutation retry.
The only persisted browser authority is the server's HttpOnly cookie.

The static handler exposes exactly `/`, `/complete`, `/app.js` and `/runtime.json`.
Runtime configuration contains only the public API origin and route prefix.
Private configuration, captured mail, source, node_modules and arbitrary paths are
never served. API and example responses use `Cache-Control: no-store`.

For the browser check, install a local Chrome and set `ACCOUNTS_CHROME_PATH` when
its executable differs from the macOS default used by the test. No browser download
is performed by this workspace.

```sh
npm run build
npm run build:web
npm run test:web
```

The test uses an ephemeral installation, certificate and isolated browser contexts.
It exercises forms, exact signatures, export, reload, recovery with remote-session
revocation, SameSite/HttpOnly/Secure host-only cookies, same-site cross-origin API
access, a hostile `localhost` origin, private asset rejection and empty browser
storage/cache/service-worker state. All test listeners and browsers close in cleanup.
This is browser evidence only. See [native acceptance](../native/README.md) for
outstanding device checks.
