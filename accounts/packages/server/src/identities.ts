import type Database from "better-sqlite3";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { openAccountDatabase } from "./database.ts";
import { openIdentityInventory } from "./identity-inventory.ts";
import type { AssignmentRecord } from "./identity-inventory.ts";
import { createKeyEncryption, identityUnavailable } from "./key-encryption.ts";
import type { KeyEncryptionConfiguration } from "./key-encryption.ts";
import { AccountError, createCapacity } from "./limits.ts";

export interface CustodyConfiguration {
  installationId: string;
  inventoryPath: string;
  encryption: Omit<KeyEncryptionConfiguration, "installationId">;
}
export interface AccountIdentity { publicKey: string }
export interface IdentityStore {
  getOrCreate(accountId: string): Promise<AccountIdentity>;
  withSecret<T>(accountId: string, use: (secret: Uint8Array) => T | Promise<T>): Promise<T>;
  assertReady(): Promise<void>;
  assertProvisioningReady(): Promise<void>;
}
/** Bounded process-local lifecycle, including asynchronous auth transactions. */
export function createSerialExecutor(maximum = 8) {
  const capacity = createCapacity(maximum);
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => capacity(() => {
    const next = tail.then(operation);
    tail = next.then(() => {}, () => {});
    return next;
  });
}
export function custodyInstallation(db: Database.Database): string | undefined {
  return (db.prepare("SELECT installation_id FROM custody_installation WHERE singleton = 1").get() as { installation_id: string } | undefined)?.installation_id;
}
/** Explicit setup after independent inventory initialization, never startup migration. */
export function initializeAccountCustody(databasePath: string, config: Pick<CustodyConfiguration, "installationId" | "inventoryPath">): void {
  const inventory = openIdentityInventory(config.inventoryPath, config.installationId);
  const db = openAccountDatabase(databasePath);
  try {
    if (inventory.records().length || custodyInstallation(db)) throw new Error("Custody initialization requires a new installation");
    db.prepare("INSERT INTO custody_installation (singleton, installation_id) VALUES (1, ?)").run(config.installationId);
  } finally { db.close(); }
}
interface IdentityRow { account_id: string; public_key: string; encrypted_secret: string }
interface AssignmentRow { account_id: string; public_key: string; inventory_committed: number }

/** Trusted server library only. Public callers must use a live session-derived ID. */
export function createIdentityStore(db: Database.Database, config: CustodyConfiguration): IdentityStore {
  const installation = custodyInstallation(db);
  if (!installation || installation !== config.installationId) throw new Error("Custody installation must be explicitly initialized and match configuration");
  const encryption = createKeyEncryption({ ...config.encryption, installationId: config.installationId });
  const inventory = openIdentityInventory(config.inventoryPath, config.installationId);
  const serial = createSerialExecutor(16);
  function snapshot() {
    if (custodyInstallation(db) !== installation) throw identityUnavailable();
    const assignments = db.prepare("SELECT account_id, public_key, inventory_committed FROM identity_assignment").all() as AssignmentRow[];
    const identities = db.prepare("SELECT account_id, public_key, encrypted_secret FROM author_identity").all() as IdentityRow[];
    const records = inventory.records();
    const accounts = new Set((db.prepare("SELECT id FROM user").all() as Array<{ id: string }>).map((row) => row.id));
    const assigned = new Map(assignments.map((row) => [row.account_id, row]));
    const secrets = new Map(identities.map((row) => [row.account_id, row]));
    const inventoried = new Map(records.map((record) => [record.accountId, record]));
    for (const record of records) {
      if (!accounts.has(record.accountId) || assigned.get(record.accountId)?.public_key !== record.publicKey || secrets.get(record.accountId)?.public_key !== record.publicKey) throw identityUnavailable();
    }
    for (const assignment of assignments) {
      const record = inventoried.get(assignment.account_id);
      if (!accounts.has(assignment.account_id) || !/^[a-f0-9]{64}$/.test(assignment.public_key) || secrets.get(assignment.account_id)?.public_key !== assignment.public_key ||
        (record && record.publicKey !== assignment.public_key) || (!record && assignment.inventory_committed !== 0)) throw identityUnavailable();
    }
    for (const identity of identities) if (assigned.get(identity.account_id)?.public_key !== identity.public_key) throw identityUnavailable();
    return { assignments, secrets };
  }
  // Structural errors fail startup. Cryptographic readiness is checked before use/signup.
  snapshot();
  async function decrypt(row: IdentityRow): Promise<Uint8Array> {
    const secret = await encryption.decrypt(row.encrypted_secret, row.account_id, "author-secret");
    try {
      if (secret.byteLength !== 32 || getPublicKey(secret) !== row.public_key) throw identityUnavailable();
      return secret;
    } catch { secret.fill(0); throw identityUnavailable(); }
  }
  function recordAssignment(row: AssignmentRow): void {
    const record: AssignmentRecord = { version: 1, installationId: installation!, accountId: row.account_id, publicKey: row.public_key };
    inventory.persist(record);
    db.prepare("UPDATE identity_assignment SET inventory_committed = 1 WHERE account_id = ? AND public_key = ?").run(row.account_id, row.public_key);
  }
  async function ready(): Promise<void> {
    try {
      const state = snapshot();
      // Reconcile every independently recorded assignment, even an absent account.
      // No plaintext identity cache is retained between operations.
      for (const row of state.secrets.values()) {
        const secret = await decrypt(row); secret.fill(0);
      }
      snapshot();
      for (const row of state.assignments) if (row.inventory_committed === 0) recordAssignment(row);
    } catch { throw identityUnavailable(); }
  }
  function verifiedAccount(accountId: string): void {
    const user = db.prepare("SELECT emailVerified FROM user WHERE id = ?").get(accountId) as { emailVerified: number } | undefined;
    if (!user || Buffer.byteLength(accountId) > 120) throw identityUnavailable();
    if (user.emailVerified !== 1) throw new AccountError("EMAIL_UNVERIFIED", 403);
  }
  async function provision(accountId: string): Promise<AccountIdentity> {
    verifiedAccount(accountId);
    snapshot();
    let row = db.prepare("SELECT account_id, public_key, encrypted_secret FROM author_identity WHERE account_id = ?").get(accountId) as IdentityRow | undefined;
    if (!row) {
      const secret = generateSecretKey();
      let encrypted: string, publicKey: string;
      try { publicKey = getPublicKey(secret); encrypted = await encryption.encrypt(secret, accountId, "author-secret"); }
      finally { secret.fill(0); }
      // Never span an await with a raw SQLite transaction, or nest inside auth.
      if (db.inTransaction) throw identityUnavailable();
      row = db.transaction(() => {
        verifiedAccount(accountId); snapshot();
        const winner = db.prepare("SELECT account_id, public_key, encrypted_secret FROM author_identity WHERE account_id = ?").get(accountId) as IdentityRow | undefined;
        if (winner) return winner;
        db.prepare("INSERT INTO identity_assignment (account_id, public_key) VALUES (?, ?)").run(accountId, publicKey);
        db.prepare("INSERT INTO author_identity (account_id, public_key, encrypted_secret) VALUES (?, ?, ?)").run(accountId, publicKey, encrypted);
        return { account_id: accountId, public_key: publicKey, encrypted_secret: encrypted };
      }).immediate();
    }
    const secret = await decrypt(row); secret.fill(0);
    // Persistence failure leaves the committed winner for explicit retry/reconciliation.
    const assignment = db.prepare("SELECT inventory_committed FROM identity_assignment WHERE account_id = ?").get(accountId) as AssignmentRow;
    if (assignment.inventory_committed === 0) recordAssignment({ ...assignment, account_id: row.account_id, public_key: row.public_key });
    return { publicKey: row.public_key };
  }
  return {
    assertReady: () => serial(ready),
    assertProvisioningReady: () => serial(async () => { try { snapshot(); } catch { throw identityUnavailable(); } }),
    getOrCreate: (accountId) => serial(async () => {
      try { return await provision(accountId); }
      catch (error) { if (error instanceof AccountError && error.code === "EMAIL_UNVERIFIED") throw error; throw identityUnavailable(); }
    }),
    withSecret: (accountId, use) => serial(async () => {
      // Does not create identities. Call getOrCreate explicitly before first use.
      verifiedAccount(accountId); snapshot();
      const row = db.prepare("SELECT account_id, public_key, encrypted_secret FROM author_identity WHERE account_id = ?").get(accountId) as IdentityRow | undefined;
      if (!row) throw identityUnavailable();
      const secret = await decrypt(row);
      try {
        const assignment = db.prepare("SELECT inventory_committed FROM identity_assignment WHERE account_id = ?").get(accountId) as AssignmentRow;
        if (assignment.inventory_committed === 0) recordAssignment({ ...assignment, account_id: accountId, public_key: row.public_key });
        return await use(secret);
      } finally { secret.fill(0); }
    }),
  };
}
