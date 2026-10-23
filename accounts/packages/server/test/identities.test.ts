import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as server from "../src/index.ts";
import { baseURL, origin, password, returnURL } from "./fixtures.ts";

type CustodyConfig = server.CustodyConfiguration;
const api = server;
const unavailable = (error: unknown) => error instanceof server.AccountError && error.code === "IDENTITY_UNAVAILABLE" && error.status === 503;
async function setup() {
  assert.equal(typeof api.initializeIdentityInventory, "function", "explicit custody initialization is required");
  const directory = await mkdtemp(join(tmpdir(), "identity-test-"));
  const databasePath = join(directory, "private.sqlite"), inventoryPath = join(directory, "assignments");
  const config: CustodyConfig = { installationId: "fixture-installation", inventoryPath, encryption: { activeKid: "key-1", keys: { "key-1": new Uint8Array(32).fill(7) } } };
  api.initializeAccountDatabase(databasePath); api.initializeIdentityInventory(inventoryPath, config.installationId); api.initializeAccountCustody(databasePath, config);
  const db = new Database(databasePath); db.pragma("foreign_keys = ON");
  const addAccount = (id: string, verified = true) => db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, 0, 0)').run(id, "Fixture", `${id}@example.test`, verified ? 1 : 0);
  addAccount("account-a"); addAccount("account-b");
  return { directory, databasePath, inventoryPath, config, db, addAccount, store: api.createIdentityStore(db, config), close: async () => { db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("concurrent provisioning commits one encrypted identity and durable independent assignment", async () => {
  const f = await setup();
  try {
    const other = api.createIdentityStore(f.db, f.config);
    const identities = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? f.store : other).getOrCreate("account-a")));
    assert.equal(new Set(identities.map((identity) => identity.publicKey)).size, 1);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM author_identity').get() as { count: number }).count, 1);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM identity_assignment').get() as { count: number }).count, 1);
    const bytes = await f.store.withSecret("account-a", (secret) => { assert.equal(getPublicKey(secret), identities[0]!.publicKey); return secret.slice(); });
    const row = f.db.prepare('SELECT encrypted_secret FROM author_identity').get() as { encrypted_secret: string };
    assert.equal(row.encrypted_secret.split(".").length, 5);
    const inventory = (await Promise.all((await readdir(f.inventoryPath)).map((file) => readFile(join(f.inventoryPath, file), "utf8")))).join("");
    assert.ok(inventory.includes(identities[0]!.publicKey)); assert.ok(!inventory.includes(Buffer.from(bytes).toString("hex"))); assert.ok(!inventory.includes("@example.test"));
    assert.deepEqual(await api.createIdentityStore(f.db, f.config).getOrCreate("account-a"), identities[0]);
  } finally { await f.close(); }
});

test("provisioning requires a verified account and never provisions absent accounts", async () => {
  const f = await setup();
  try {
    f.addAccount("unverified", false);
    await assert.rejects(f.store.getOrCreate("unverified"), (error: unknown) => error instanceof server.AccountError && error.code === "EMAIL_UNVERIFIED");
    await assert.rejects(f.store.getOrCreate("absent"), unavailable);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM author_identity').get() as { count: number }).count, 0);
  } finally { await f.close(); }
});
for (const damage of ["tamper", "swap", "assignment", "missing-row", "missing-marker", "wrong-secret", "missing-inventory-record"] as const) {
  test(`assigned identity fails closed after ${damage}`, async () => {
    const f = await setup();
    try {
      await f.store.getOrCreate("account-a"); await f.store.getOrCreate("account-b");
      if (damage === "tamper") f.db.prepare("UPDATE author_identity SET encrypted_secret = encrypted_secret || 'x' WHERE account_id = ?").run("account-a");
      if (damage === "swap") f.db.prepare("UPDATE author_identity SET encrypted_secret = (SELECT encrypted_secret FROM author_identity WHERE account_id = ?) WHERE account_id = ?").run("account-b", "account-a");
      if (damage === "assignment") f.db.prepare("UPDATE identity_assignment SET public_key = ? WHERE account_id = ?").run(getPublicKey(generateSecretKey()), "account-a");
      if (damage === "missing-row") f.db.prepare("DELETE FROM author_identity WHERE account_id = ?").run("account-a");
      if (damage === "missing-marker") f.db.prepare("DELETE FROM identity_assignment WHERE account_id = ?").run("account-a");
      if (damage === "wrong-secret") f.db.prepare("UPDATE author_identity SET encrypted_secret = ? WHERE account_id = ?").run(await api.createKeyEncryption({ ...f.config.encryption, installationId: f.config.installationId }).encrypt(generateSecretKey(), "account-a", "author-secret"), "account-a");
      if (damage === "missing-inventory-record") await unlink(join(f.inventoryPath, `${Buffer.from("account-a").toString("base64url")}.json`));
      const before = f.db.prepare("SELECT * FROM author_identity ORDER BY account_id").all();
      await assert.rejects(f.store.getOrCreate("account-a"), unavailable);
      await assert.rejects(f.store.withSecret("account-a", () => assert.fail("must not reveal a secret")), unavailable);
      assert.deepEqual(f.db.prepare("SELECT * FROM author_identity ORDER BY account_id").all(), before);
    } finally { await f.close(); }
  });
}
test("JWE authenticates installation, immutable account, purpose and format version", async () => {
  assert.equal(typeof api.createKeyEncryption, "function", "a library-backed JWE encryption adapter is required");
  const config = { installationId: "installation-a", activeKid: "key-1", keys: { "key-1": new Uint8Array(32).fill(9) } };
  const encryption = api.createKeyEncryption(config), secret = generateSecretKey();
  const ciphertext = await encryption.encrypt(secret, "account-a", "author-secret");
  assert.deepEqual(await encryption.decrypt(ciphertext, "account-a", "author-secret"), secret);
  await assert.rejects(encryption.decrypt(ciphertext, "account-b", "author-secret"), unavailable);
  await assert.rejects(encryption.decrypt(ciphertext, "account-a", "outbox"), unavailable);
  await assert.rejects(api.createKeyEncryption({ ...config, installationId: "installation-b" }).decrypt(ciphertext, "account-a", "author-secret"), unavailable);
  const { CompactEncrypt } = await import("jose");
  const invalidVersion = await new CompactEncrypt(secret).setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "key-1", installation: "installation-a", account: "account-a", purpose: "author-secret", version: 2 }).encrypt(config.keys["key-1"]);
  await assert.rejects(encryption.decrypt(invalidVersion, "account-a", "author-secret"), unavailable);
  const loadedKey = Buffer.alloc(32, 14);
  const copiedKeyring = api.createKeyEncryption({ installationId: "buffer-fixture", activeKid: "buffer", keys: { buffer: loadedKey } });
  const beforeMutation = await copiedKeyring.encrypt(secret, "account-a", "author-secret");
  loadedKey.fill(0);
  assert.deepEqual(await copiedKeyring.decrypt(beforeMutation, "account-a", "author-secret"), secret);

});
test("rotation encrypts new identities with active key and requires retained old keys", async () => {
  const f = await setup();
  try {
    const original = await f.store.getOrCreate("account-a");
    const config = { ...f.config, encryption: { activeKid: "key-2", keys: { ...f.config.encryption.keys, "key-2": new Uint8Array(32).fill(8) } } };
    const rotated = api.createIdentityStore(f.db, config);
    assert.deepEqual(await rotated.getOrCreate("account-a"), original); await rotated.getOrCreate("account-b");
    const rows = f.db.prepare("SELECT encrypted_secret FROM author_identity ORDER BY account_id").all() as Array<{ encrypted_secret: string }>;
    assert.deepEqual(rows.map((row) => JSON.parse(Buffer.from(row.encrypted_secret.split(".")[0]!, "base64url").toString()).kid), ["key-1", "key-2"]);
    const missing = api.createIdentityStore(f.db, { ...config, encryption: { activeKid: "key-2", keys: { "key-2": config.encryption.keys["key-2"] } } });
    await assert.rejects(missing.getOrCreate("account-a"), unavailable); await assert.rejects(missing.assertReady(), unavailable);
    assert.throws(() => api.createKeyEncryption({ installationId: "test", activeKid: "missing", keys: {} }));
    assert.throws(() => api.createKeyEncryption({ installationId: "test", activeKid: "bad", keys: { bad: new Uint8Array(31) } }));
  } finally { await f.close(); }
});
test("retry reconciles the committed database winner without generating a replacement", async () => {
  const f = await setup();
  try {
    const encryption = api.createKeyEncryption({ ...f.config.encryption, installationId: f.config.installationId });
    const secret = generateSecretKey(), publicKey = getPublicKey(secret);
    // A process could exit between the database commit and independent file persistence.
    f.db.transaction(() => {
      f.db.prepare("INSERT INTO identity_assignment (account_id, public_key) VALUES (?, ?)").run("account-a", publicKey);
      f.db.prepare("INSERT INTO author_identity (account_id, public_key, encrypted_secret) VALUES (?, ?, ?)").run("account-a", publicKey, "placeholder");
    })();
    f.db.prepare("UPDATE author_identity SET encrypted_secret = ? WHERE account_id = ?").run(await encryption.encrypt(secret, "account-a", "author-secret"), "account-a");
    assert.deepEqual(await f.store.getOrCreate("account-a"), { publicKey });
    const recordPath = join(f.inventoryPath, `${Buffer.from("account-a").toString("base64url")}.json`);
    assert.ok((await readFile(recordPath, "utf8")).includes(publicKey));
    await writeFile(recordPath, JSON.stringify({ version: 1, installationId: f.config.installationId, accountId: "account-a", publicKey: getPublicKey(generateSecretKey()) }));
    await assert.rejects(f.store.getOrCreate("account-b"), unavailable);
    assert.equal(f.db.prepare("SELECT account_id FROM author_identity WHERE account_id = ?").get("account-b"), undefined);
    await unlink(recordPath);
  } finally { await f.close(); }
});
test("missing or conflicting independent inventory fails closed", async () => {
  const f = await setup();
  try {
    await f.store.getOrCreate("account-a");
    const recordPath = join(f.inventoryPath, `${Buffer.from("account-a").toString("base64url")}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, publicKey: getPublicKey(generateSecretKey()) }));
    await assert.rejects(f.store.assertReady(), unavailable); await assert.rejects(f.store.getOrCreate("account-b"), unavailable);
    await rm(f.inventoryPath, { recursive: true });
    await assert.rejects(f.store.getOrCreate("account-a"), unavailable); assert.throws(() => api.createIdentityStore(f.db, f.config));
  } finally { await f.close(); }
});
test("actual signup quarantines a backup missing an entire inventoried account and rejects omitted custody config", async () => {
  const f = await setup(); let app: ReturnType<typeof server.createAccountServer> | undefined;
  try {
    await f.store.getOrCreate("account-a");
    const config = { databasePath: f.databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], mail: { send: async () => {} } };
    assert.throws(() => server.createAccountServer(config), /custody/i);
    app = server.createAccountServer({ ...config, custody: f.config });
    f.db.prepare("DELETE FROM user WHERE id = ?").run("account-a");
    await assert.rejects(f.store.getOrCreate("account-b"), unavailable);
    const response = await app.handler(new Request(`${baseURL}/v1/auth/sign-up/email`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "new-reader@example.test", password, name: "Reader" }) }));
    assert.equal(response.status, 503); assert.equal(((await response.json()) as { error: { code: string } }).error.code, "IDENTITY_UNAVAILABLE");
    assert.equal(f.db.prepare("SELECT id FROM user WHERE email = ?").get("new-reader@example.test"), undefined);
  } finally { app?.close(); await f.close(); }
});

test("inventory write failure after SQL commit never exposes or replaces the winning identity", async () => {
  const f = await setup();
  try {
    const interruptedPath = join(f.directory, "interrupted-inventory");
    f.db.function("interrupt_inventory", () => { renameSync(f.inventoryPath, interruptedPath); return 1; });
    f.db.exec("CREATE TRIGGER interrupt_inventory AFTER INSERT ON author_identity BEGIN SELECT interrupt_inventory(); END");
    await assert.rejects(f.store.getOrCreate("account-a"), unavailable);
    const winner = f.db.prepare("SELECT public_key FROM author_identity WHERE account_id = ?").get("account-a") as { public_key: string };
    assert.ok(winner);
    assert.equal((f.db.prepare("SELECT inventory_committed FROM identity_assignment WHERE account_id = ?").get("account-a") as { inventory_committed: number }).inventory_committed, 0);
    renameSync(interruptedPath, f.inventoryPath); f.db.exec("DROP TRIGGER interrupt_inventory");
    await f.store.withSecret("account-a", async (secret) => {
      assert.equal(getPublicKey(secret), winner.public_key);
      assert.ok(existsSync(join(f.inventoryPath, `${Buffer.from("account-a").toString("base64url")}.json`)), "durable assignment must exist before a secret callback");
    });
    assert.deepEqual(await f.store.getOrCreate("account-a"), { publicKey: winner.public_key });
    assert.equal((f.db.prepare("SELECT inventory_committed FROM identity_assignment WHERE account_id = ?").get("account-a") as { inventory_committed: number }).inventory_committed, 1);
  } finally { await f.close(); }
});
test("already durable identities do not rewrite assignment state on ordinary access", async () => {
  const f = await setup();
  try {
    await f.store.getOrCreate("account-a");
    f.db.exec("CREATE TRIGGER no_rewrite BEFORE UPDATE ON identity_assignment BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END");
    await f.store.getOrCreate("account-a");
    await f.store.withSecret("account-a", (secret) => assert.equal(secret.byteLength, 32));
    await f.store.assertReady();
  } finally { await f.close(); }
});
test("private-route custody uses only a live verified login before provisioning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "identity-auth-test-"));
  const databasePath = join(directory, "private.sqlite"), inventoryPath = join(directory, "inventory");
  const config: CustodyConfig = { installationId: "real-auth-fixture", inventoryPath, encryption: { activeKid: "fixture", keys: { fixture: new Uint8Array(32).fill(11) } } };
  assert.equal(typeof api.initializeIdentityInventory, "function");
  api.initializeAccountDatabase(databasePath); api.initializeIdentityInventory(inventoryPath, config.installationId); api.initializeAccountCustody(databasePath, config);
  const mail: Array<{ url: string }> = [];
  const app = server.createAccountServer({ databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], mail: { send: async (message) => { mail.push(message); } }, custody: config,
    privateRoutes: [{ path: "/private/identity", method: "POST", handle: async (context) => {
      assert.ok(context.identity, "custody context is provided only by the server");
      return Response.json(await context.identity.getOrCreate());
    } }],
  });
  let cookie = "";
  const request = (path: string, body: unknown) => app.handler(new Request(`${baseURL}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  try {
    await app.ready();
    assert.equal((await request("/private/identity", {})).status, 401);
    await request("/v1/auth/sign-up/email", { email: "reader@example.test", password, name: "Reader" });
    assert.equal((await request("/v1/auth/sign-in/email", { email: "reader@example.test", password })).status, 403);
    const db = new Database(databasePath);
    try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM author_identity").get() as { count: number }).count, 0); } finally { db.close(); }
    await app.mailOutbox!.drain();
    await app.handler(new Request(mail[0]!.url));
    const login = await request("/v1/auth/sign-in/email", { email: "reader@example.test", password });
    cookie = login.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0]!;
    const first = await request("/private/identity", { accountId: "substituted-account" });
    assert.equal(first.status, 200); const identity = await first.json();
    assert.deepEqual(await (await request("/private/identity", {})).json(), identity);
    await request("/v1/auth/sign-out", {});
    assert.equal((await request("/private/identity", {})).status, 401);
  } finally { app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("configured readiness and HTTP both reject a missing persisted decryption key", async () => {
  const f = await setup(); let app: ReturnType<typeof server.createAccountServer> | undefined;
  try {
    await f.store.getOrCreate("account-a");
    app = server.createAccountServer({ databasePath: f.databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], mail: { send: async () => {} }, custody: { ...f.config, encryption: { activeKid: "replacement", keys: { replacement: new Uint8Array(32).fill(12) } } } });
    await assert.rejects(app.ready(), unavailable);
    const response = await app.handler(new Request(`${baseURL}/v1/auth/get-session`, { headers: { origin } }));
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "IDENTITY_UNAVAILABLE");
  } finally { app?.close(); await f.close(); }
});
