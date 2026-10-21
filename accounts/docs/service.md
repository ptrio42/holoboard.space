# Run the local account service

Build first, then create a fresh private installation. Commands below run from
`accounts/` and require `openssl`. Choose an unused loopback port. The setup helper
creates separate random auth/encryption secrets and a seven-day self-signed TLS
certificate; `serve` never generates secrets or initializes storage.

```sh
npm run build
node examples/local-setup.mjs /private/tmp/accounts-local 3443
node apps/service/dist/main.js init /private/tmp/accounts-local/config.json
node apps/service/dist/main.js serve /private/tmp/accounts-local/config.json
```

Stop with Ctrl-C. For the minimal embedded host, use the same initialized
configuration with `node examples/embedded.mjs /private/tmp/accounts-local/config.json`
instead of `serve`. Run one writer per installation. Both examples import the
built public server package, use the same bounded Node TLS adapter, and expose
only the implemented account/identity paths. No public capabilities or mailbox
endpoint is mounted. Verification redirects to the configured page; a web return
page is separate application work.

The local helper explicitly enables export and a development mail capture adapter.
Messages, including verification/recovery links, are appended to the private
mode-0600 `mail.jsonl` file, capped at 1 MiB. Inspect that file privately to open
a verification link; links are never printed automatically. Do not serve this file.
The default service has no mail provider when `developmentCapturePath` is absent.
Generic acceptance never proves delivery. Local capture writes are fsynced; it is
not an external delivery or production retention solution.

The private mode-0600 JSON configuration has this shape (all file paths absolute):

```json
{
  "databasePath": "/private/tmp/accounts-local/accounts.sqlite",
  "baseURL": "https://127.0.0.1:3443",
  "trustedOrigins": ["https://127.0.0.1:3443"],
  "returnURLs": ["https://127.0.0.1:3443/complete"],
  "installationId": "local-installation",
  "inventoryPath": "/private/tmp/accounts-local/inventory",
  "authSecretPath": "/private/tmp/accounts-local/auth-secret",
  "keyringPath": "/private/tmp/accounts-local/keyring.json",
  "tls": {
    "keyPath": "/private/tmp/accounts-local/tls-key.pem",
    "certPath": "/private/tmp/accounts-local/tls-cert.pem"
  },
  "listenHost": "127.0.0.1",
  "port": 3443,
  "explicitExportEnabled": false,
  "mailIntervalMs": 1000,
  "shutdownTimeoutMs": 10000
}
```

The auth-secret file contains at least 32 characters. The separate keyring JSON
contains `{ "activeKid": "local", "keys": { "local": "64-lowercase-hex-digits" } }`,
with an actual independently generated 32-byte key in place of that description.
Key, secret, certificate and configuration files must be owner-only regular files;
symlinks and oversized files are rejected. Optional `basePath` changes only the
authentication prefix. `developmentCapturePath` explicitly enables local capture.
TLS listen addresses are limited to `127.0.0.1` and `::1`, matching `baseURL` and
port. Public TLS termination and trusted-proxy support remain unimplemented.

For isolated end-to-end checks, create two fresh installations on different ports
and initialize each as above, then run:

```sh
node examples/check-local.mjs /private/tmp/accounts-local/config.json standalone
# With a separately initialized installation:
node examples/check-local.mjs /private/tmp/accounts-embedded/config.json embedded
```

Each check starts and stops its own child process. It uses `.test` recipients,
reads only the private capture file, pins the local certificate, and exercises
registration, verification, login, exact signing, export, reset and logout via
the SDK. Use fresh installations for repeated checks. Neither helper sends mail,
publishes an event or contacts a relay or wallet. For manual browser use, explicitly
trust the generated local certificate in a development profile; never disable TLS
verification globally. Native application cookie persistence remains unverified.

The bridge pins Host to the configured authority, constructs URLs from that origin,
ignores forwarding headers, and passes only the socket peer address. It limits
headers to 8 KiB, bodies to 64 KiB of actual streamed bytes, body reads to five
seconds, requests to 15 seconds and connections to 32. Oversized streamed bodies
receive a bounded 413 response before connection closure. All `Set-Cookie` headers
survive. Shutdown stops admissions and new mail drains, waits for existing requests,
underlying database work and the current worker within the configured deadline,
then closes storage. An unresolved worker reports incomplete shutdown and never
claims a clean database close. CLI logs contain fixed lifecycle codes and the
configured URL, never request payloads, mail or credentials.

