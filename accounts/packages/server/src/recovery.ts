import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { getPublicKey } from 'nostr-tools/pure';
import { openAccountDatabase } from './database.ts';
import { createRecoveryIdentityStore } from './identities.ts';
import type { CustodyConfiguration } from './identities.ts';
import { createKeyEncryption } from './key-encryption.ts';
import { MAIL_PURPOSE, validateMail } from './mail.ts';

const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex');
function validSecret(secret: string): void { if (secret.length < 32) throw new Error('Authentication secret must have at least 32 characters'); }
/** Configuration binding only; authentication remains the pinned Better Auth protocol. */
export function bindAuthenticationSecret(db: Database.Database, secret: string): void {
  validSecret(secret);
  const binding = db.prepare('SELECT auth_fingerprint, quarantined FROM account_restore WHERE singleton = 1').get() as { auth_fingerprint: string; quarantined: number } | undefined;
  if (binding && binding.auth_fingerprint !== fingerprint(secret)) throw new Error('Restored authentication secret does not match');
  if (binding?.quarantined) throw new Error('Account restore is quarantined');
  db.prepare('INSERT OR IGNORE INTO account_auth_secret_history VALUES (?)').run(fingerprint(secret));
}
function sync(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
async function isolatedCopy(source: string, target: string, prepare?: (db: Database.Database) => void): Promise<void> {
  const db = openAccountDatabase(source);
  const temporary = join(dirname(target), `.account-maintenance-${randomUUID()}`);
  try {
    closeSync(openSync(temporary, 'wx', 0o600));
    // SQLite's online backup API produces a consistent snapshot, including WAL state.
    await db.backup(temporary);
    if (prepare) { const copy = openAccountDatabase(temporary); try { prepare(copy); } finally { copy.close(); } }
    sync(temporary); linkSync(temporary, target); sync(dirname(target));
  } finally { db.close(); try { unlinkSync(temporary); } catch {} }
}
/** Offline, trusted single-writer maintenance. Never overwrites any existing path. */
export async function backupAccountDatabase(sourcePath: string, targetPath: string): Promise<void> {
  await isolatedCopy(sourcePath, targetPath);
}
export interface RestoreAccountConfiguration {
  backupPath: string;
  targetPath: string;
  currentAuthSecret: string;
  newAuthSecret: string;
  /** Independently preserved assignment inventory, never rolled back with the database. */
  custody: CustodyConfiguration;
}
/** Restores only a new isolated target; a failed reconciliation leaves durable quarantine. */
export async function restoreAccountDatabase(config: RestoreAccountConfiguration): Promise<{ ready: boolean }> {
  validSecret(config.currentAuthSecret); validSecret(config.newAuthSecret);
  const next = fingerprint(config.newAuthSecret), current = fingerprint(config.currentAuthSecret);
  if (next === current) throw new Error('Restore requires a fresh authentication secret');
  await isolatedCopy(config.backupPath, config.targetPath, (db) => {
    if (db.prepare('SELECT 1 FROM account_auth_secret_history WHERE fingerprint = ?').get(next)) throw new Error('Restore requires a fresh authentication secret');
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO account_auth_secret_history VALUES (?)').run(current);
      db.prepare('INSERT INTO account_auth_secret_history VALUES (?)').run(next);
      db.prepare('INSERT OR REPLACE INTO account_restore VALUES (1, ?, 1)').run(next);
      db.exec("DELETE FROM session; DELETE FROM verification; DELETE FROM account_mail_outbox; UPDATE account SET password = NULL WHERE providerId = 'credential'");
    })();
  });
  try { await reconcileAccountRestore(config.targetPath, config.custody); return { ready: true }; }
  catch { return { ready: false }; }
}
/** Requires recovered original records and keys. Does not remove inventory or mint identities. */
export async function reconcileAccountRestore(databasePath: string, custody: CustodyConfiguration): Promise<void> {
  const db = openAccountDatabase(databasePath);
  try {
    if (!db.prepare('SELECT 1 FROM account_restore WHERE singleton = 1').get()) throw new Error('Not a restored database');
    await createRecoveryIdentityStore(db, custody).assertReady();
    db.prepare('UPDATE account_restore SET quarantined = 0 WHERE singleton = 1').run();
  } finally { db.close(); }
}
/** Rewrap every current secret and queued mail, staging crypto before one synchronous transaction. */
export async function rotateAccountStorageKey(databasePath: string, custody: CustodyConfiguration): Promise<void> {
  const db = openAccountDatabase(databasePath);
  try {
    await createRecoveryIdentityStore(db, custody).assertReady();
    const encryption = createKeyEncryption({ ...custody.encryption, installationId: custody.installationId });
    const identities = db.prepare('SELECT account_id, public_key, encrypted_secret FROM author_identity ORDER BY account_id').all() as { account_id: string; public_key: string; encrypted_secret: string }[];
    const messages = db.prepare('SELECT id, payload, expires_at FROM account_mail_outbox ORDER BY id').all() as { id: string; payload: string; expires_at: number }[];
    const stagedIdentities: { account: string; before: string; after: string }[] = [];
    const stagedMessages: { id: string; before: string; after: string }[] = [];
    for (const row of identities) {
      const plaintext = await encryption.decrypt(row.encrypted_secret, row.account_id, 'author-secret');
      try {
        if (getPublicKey(plaintext) !== row.public_key) throw new Error('Identity mismatch');
        stagedIdentities.push({ account: row.account_id, before: row.encrypted_secret, after: await encryption.encrypt(plaintext, row.account_id, 'author-secret') });
      } finally { plaintext.fill(0); }
    }
    for (const row of messages) {
      const plaintext = await encryption.decrypt(row.payload, row.id, MAIL_PURPOSE);
      try {
        const message = validateMail(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
        if (message.expiresAt !== row.expires_at) throw new Error('Mail binding mismatch');
        stagedMessages.push({ id: row.id, before: row.payload, after: await encryption.encrypt(plaintext, row.id, MAIL_PURPOSE) });
      } finally { plaintext.fill(0); }
    }
    db.transaction(() => {
      // Detect a writer during crypto staging, though offline operation remains required.
      if (JSON.stringify(db.prepare('SELECT account_id, public_key, encrypted_secret FROM author_identity ORDER BY account_id').all()) !== JSON.stringify(identities) ||
          JSON.stringify(db.prepare('SELECT id, payload, expires_at FROM account_mail_outbox ORDER BY id').all()) !== JSON.stringify(messages)) throw new Error('Concurrent account maintenance');
      for (const row of stagedIdentities) db.prepare('UPDATE author_identity SET encrypted_secret = ? WHERE account_id = ? AND encrypted_secret = ?').run(row.after, row.account, row.before);
      for (const row of stagedMessages) db.prepare('UPDATE account_mail_outbox SET payload = ?, payload_bytes = ? WHERE id = ? AND payload = ?').run(row.after, Buffer.byteLength(row.after), row.id, row.before);
    }).immediate();
  } finally { db.close(); }
}
