# Offline account backup, restore and storage-key rotation

These operations are public server-library exports and runnable through
`examples/maintenance.mjs` after `npm run build`. They require a stopped service,
no active mail drain and one trusted writer on a local filesystem. They are not
distributed locks or a production backup scheduler. Back up private configuration,
keyrings and the independent identity inventory separately. Never place them in a
public web root or cache.

Schema 4 is applied only by explicit fresh initialization. Startup does not migrate
schema 1, 2 or 3. Existing installations require separately reviewed compatible
migration tooling; do not delete their files or run initialization to upgrade them.

## Consistent backup

```sh
node examples/maintenance.mjs backup /absolute/current-config.json /absolute/new-backup.sqlite
```

`backupAccountDatabase(sourcePath, targetPath)` uses better-sqlite3's
[SQLite backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backuppath-options---promise),
which includes committed WAL data. It stages a private snapshot and publishes it
with an atomic no-overwrite link. Existing destinations, including the source, fail.
This is not an ordinary database-file copy. The source is never reset or restored
in place. Backup contains sensitive credentials and encrypted custody material;
store it privately with retention and access controls.

## Isolated restore

Prepare a private target configuration with an unused database path, the preserved
installation ID and independent inventory, all required old storage keys, and a
fresh independently generated authentication secret. Do not initialize this target.
Keep the source/current config available to identify the operator's current auth
secret even when restoring an older snapshot.

```sh
node examples/maintenance.mjs restore /absolute/current-config.json /absolute/backup.sqlite /absolute/target-config.json
```

`restoreAccountDatabase({ backupPath, targetPath, currentAuthSecret, newAuthSecret,
custody })` refuses an existing target and rejects reuse of either the current auth
secret or any auth secret fingerprint recorded by that backup. It atomically binds
the isolated database to the new secret, records a durable quarantine, deletes
restored sessions, password-reset records and queued mail, and sets credential
passwords to NULL. Better Auth's native email recovery remains supported. Existing
users must recover their password before signing in, preserving their assigned
Nostr key. This prevents an old backup from reviving an obsolete password hash.
The source and backup remain unchanged.

Deleting reset records does not revoke stateless verification JWTs. A fresh auth
secret is therefore enforced by the actual restored database/factory binding.
Old verification links fail, while freshly requested links work. Auth secrets and
Nostr storage keys are separate. SHA-256 fingerprints here constrain local
configuration; they do not replace Better Auth's authentication protocol. Further
auth-secret rotation on this bound target requires explicit maintenance design;
changing the config alone fails closed.

Restore then checks **every** preserved inventory assignment against the recovered
account, assignment marker, encrypted identity and derived public key using the
provided keyring. An account absent entirely from a stale backup still fails.
Missing keys, mismatches and missing assignments leave the target quarantined and
return `{ ready: false }` (CLI exit 2). The factory and identity store refuse use
across restarts, blocking signup and provisioning. Never erase inventory or mint
replacement identities to clear that condition. Recover the original account/key
records from an appropriate backup and preserve all assignments, then run:

```sh
node examples/maintenance.mjs reconcile /absolute/target-config.json
```

`reconcileAccountRestore(databasePath, custody)` clears quarantine only after full
cryptographic reconciliation. The normal factory still rechecks readiness before
traffic. A restored database must never be started with a rolled-back copy of the
independent inventory: the local library cannot detect inventory records that the
operator also lost. Separately durable production inventory, verified RPO/RTO,
backup retention, off-host loss and operator recovery procedures remain activation
gaps. Local tests establish behavior under preserved inventory, not production
recoverability.

## Actual storage-key rotation

Stop service and mail workers. Preserve a consistent backup and its old keys. Add a
fresh 32-byte storage key to the private keyring, retain the old keys and select the
new `activeKid`, then run:

```sh
node examples/maintenance.mjs rotate /absolute/current-config.json
```

`rotateAccountStorageKey(databasePath, custody)` decrypts and validates all current
author identities and queued mail, stages JWE encryption with the selected active
key outside SQL transactions, then updates both tables in one synchronous atomic
transaction. It verifies derived public keys, installation/account/purpose bindings,
mail IDs and exact expiry. It detects changes to the staged rows, but the supported
operational contract still requires no concurrent writer. A crypto or SQL failure
leaves current ciphertext unchanged. Readiness may reconcile an already committed
pending inventory assignment before rewrapping; it never creates a new identity.

Ordinary keyring configuration only selects the key for newly encrypted records.
This operation also rewraps existing ciphertext. It keeps account identities,
passwords, sessions and queued mail semantics. Retain old decryption keys for every
supported backup even after all current rows use the new key. Plaintext buffers are
short-lived and cleared where possible; JavaScript offers no zeroization guarantee.
There is no custom cipher or plaintext cache.
