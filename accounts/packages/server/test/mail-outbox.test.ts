import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as server from "../src/index.ts";
import { baseURL, origin, password, returnURL } from "./fixtures.ts";

async function setup(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mail-outbox-test-"));
  const databasePath = join(directory, "private.sqlite"), inventoryPath = join(directory, "inventory");
  const custody = { installationId: "mail-fixture", inventoryPath, encryption: { activeKid: "fixture", keys: { fixture: new Uint8Array(32).fill(29) } } };
  server.initializeAccountDatabase(databasePath);
  server.initializeIdentityInventory(inventoryPath, custody.installationId);
  server.initializeAccountCustody(databasePath, custody);
  const messages: server.AccountMail[] = [];
  const config = { databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], custody,
    requestLimit: { maxRequests: 1000, windowMs: 60000 }, sensitiveLimit: { maxRequests: 100, windowMs: 60000 },
    mail: { send: async (message: server.AccountMail) => { messages.push(message); } }, ...options };
  let app = server.createAccountServer(config);
  const db = new Database(databasePath);
  const request = (path: string, body: unknown) => app.handler(new Request(`${baseURL}/v1/auth${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { get app() { return app; }, db, messages, custody, request,
    register: (email = "reader@example.test") => request("/sign-up/email", { email, password, name: "Reader" }),
    restart: () => { app.close(); app = server.createAccountServer(config); },
    close: async () => { app.close(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("custody commits encrypted mail before acceptance and delivers only through its explicit worker after restart", async () => {
  const f = await setup();
  try {
    assert.ok(f.app.mailOutbox, "custody requires a durable encrypted outbox worker");
    assert.equal((await f.register()).status, 202);
    assert.equal(f.messages.length, 0);
    const row = f.db.prepare("SELECT * FROM account_mail_outbox").get() as { id: string; payload: string };
    assert.ok(row);
    assert.ok(!JSON.stringify(row).includes("reader@example.test"));
    const encryption = server.createKeyEncryption({ installationId: f.custody.installationId, ...f.custody.encryption });
    const decoded = JSON.parse(Buffer.from(await encryption.decrypt(row.payload, row.id, "account-mail")).toString());
    assert.equal(decoded.email, "reader@example.test"); assert.equal(decoded.kind, "verification");
    await assert.rejects(encryption.decrypt(row.payload, "other-id", "account-mail"));
    await assert.rejects(encryption.decrypt(row.payload, row.id, "nostr-author"));
    f.restart();
    await f.app.mailOutbox!.drain();
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0]!.token, decoded.token);
    assert.equal(f.app.mailOutbox!.status().queued, 0);
  } finally { await f.close(); }
});

test("delivery failure retains ciphertext with bounded retry state and retry delivers without private diagnostics", async () => {
  let calls = 0;
  const delivered: server.AccountMail[] = [];
  const f = await setup({ mail: { send: async (message: server.AccountMail) => { if (++calls === 1) throw new Error(`secret provider error ${message.email} ${message.token}`); delivered.push(message); } } });
  try {
    assert.ok(f.app.mailOutbox);
    assert.equal((await f.register()).status, 202);
    await f.app.mailOutbox!.drain();
    const row = f.db.prepare("SELECT * FROM account_mail_outbox").get() as { attempts: number; available_at: number; last_error: string };
    assert.equal(row.attempts, 1); assert.equal(row.last_error, "DELIVERY_FAILED"); assert.ok(row.available_at > Date.now());
    assert.ok(!JSON.stringify(f.app.mailOutbox!.status()).includes("reader@example.test"));
    await f.app.mailOutbox!.drain(); assert.equal(calls, 1);
    f.db.exec("UPDATE account_mail_outbox SET available_at = 0");
    await f.app.mailOutbox!.drain(); assert.equal(delivered.length, 1);
    assert.equal(f.app.mailOutbox!.status().queued, 0);
  } finally { await f.close(); }
});

test("expired and tampered mail fail closed without reaching the transport", async () => {
  const f = await setup();
  try {
    assert.ok(f.app.mailOutbox);
    await f.register();
    f.db.exec("UPDATE account_mail_outbox SET expires_at = 0");
    await f.app.mailOutbox!.drain(); assert.equal(f.messages.length, 0); assert.equal(f.app.mailOutbox!.status().queued, 0);
    await f.request("/send-verification-email", { email: "reader@example.test" });
    f.db.exec("UPDATE account_mail_outbox SET payload = substr(payload, 1, length(payload) - 5) || 'xxxxx'");
    await f.app.mailOutbox!.drain(); assert.equal(f.messages.length, 0);
    assert.equal(f.app.mailOutbox!.status().failed, 1);
  } finally { await f.close(); }
});

test("queue full and local enqueue failure preserve generic responses for eligible and unknown addresses", async () => {
  const f = await setup({ mailOutbox: { maxMessages: 1 } });
  try {
    assert.ok(f.app.mailOutbox);
    await f.register();
    for (const email of ["reader@example.test", "unknown@example.test"]) {
      for (const path of ["/request-password-reset", "/send-verification-email"]) {
        const response = await f.request(path, { email }); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
      }
    }
    assert.equal(f.app.mailOutbox!.status().queued, 1);
    await f.app.mailOutbox!.drain();
    f.db.exec("CREATE TRIGGER reject_mail BEFORE INSERT ON account_mail_outbox BEGIN SELECT RAISE(ABORT, 'private storage failure'); END");
    for (const email of ["reader@example.test", "unknown@example.test"]) {
      const response = await f.request("/request-password-reset", { email }); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
    }
    assert.equal((await f.request("/request-password-reset", { email: "invalid" })).status, 400);
  } finally { await f.close(); }
});

test("each recovery message expires with its own native reset record", async () => {
  const f = await setup();
  try {
    await f.register(); await f.app.mailOutbox!.drain();
    await f.request("/request-password-reset", { email: "reader@example.test" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.request("/request-password-reset", { email: "reader@example.test" });
    await f.app.mailOutbox!.drain();
    const expiries = (f.db.prepare("SELECT expiresAt FROM verification ORDER BY expiresAt").all() as { expiresAt: string }[]).map((row) => Date.parse(row.expiresAt));
    assert.deepEqual(f.messages.filter((message) => message.kind === "password-reset").map((message) => message.expiresAt).sort(), expiries);
  } finally { await f.close(); }
});

test("byte bounds reject excess ciphertext independently of message count", async () => {
  const f = await setup({ mailOutbox: { maxMessages: 100, maxBytes: 4096 } });
  try {
    for (let i = 0; i < 6; i++) assert.equal((await f.register(`reader${i}@example.test`)).status, 202);
    const status = f.app.mailOutbox!.status();
    assert.ok(status.bytes <= 4096); assert.ok(status.queued < 6); assert.ok(status.enqueueFailures > 0);
  } finally { await f.close(); }
});

test("abandoned leases wait for expiry and retry exhaustion stops delivery until message expiry", async () => {
  let attempts = 0;
  const f = await setup({ mail: { send: async () => { attempts++; throw new Error("private provider response"); } } });
  try {
    await f.register();
    f.db.prepare("UPDATE account_mail_outbox SET lease_id = 'abandoned', lease_until = ?").run(Date.now() + 60000);
    f.restart(); await f.app.mailOutbox!.drain(); assert.equal(attempts, 0);
    f.db.exec("UPDATE account_mail_outbox SET lease_until = 0");
    for (let i = 0; i < 5; i++) { f.db.exec("UPDATE account_mail_outbox SET available_at = 0"); await f.app.mailOutbox!.drain(); }
    assert.equal(attempts, 5); assert.equal(f.app.mailOutbox!.status().failed, 1);
    f.db.exec("UPDATE account_mail_outbox SET available_at = 0"); await f.app.mailOutbox!.drain(); assert.equal(attempts, 5);
    f.db.exec("UPDATE account_mail_outbox SET expires_at = 0"); await f.app.mailOutbox!.drain(); assert.equal(f.app.mailOutbox!.status().queued, 0);
  } finally { await f.close(); }
});

test("ciphertext transplanted from another purpose never reaches mail transport", async () => {
  const f = await setup();
  try {
    await f.register(); const row = f.db.prepare("SELECT id FROM account_mail_outbox").get() as { id: string };
    const encryption = server.createKeyEncryption({ installationId: f.custody.installationId, ...f.custody.encryption });
    const payload = await encryption.encrypt(Buffer.from("private-key-material"), row.id, "nostr-author");
    f.db.prepare("UPDATE account_mail_outbox SET payload = ?").run(payload);
    await f.app.mailOutbox!.drain(); assert.equal(f.messages.length, 0); assert.equal(f.app.mailOutbox!.status().failed, 1);
  } finally { await f.close(); }
});

test("an installation without external transport still purges expired private mail", async () => {
  const f = await setup({ mail: undefined });
  try {
    await f.register(); assert.equal(f.app.mailOutbox!.status().transportConfigured, false);
    f.db.exec("UPDATE account_mail_outbox SET expires_at = 0");
    await f.app.mailOutbox!.drain(); assert.equal(f.app.mailOutbox!.status().queued, 0);
  } finally { await f.close(); }
});

test("a blocked provider keeps one worker slot without blocking public acceptance", async () => {
  let release!: () => void, started!: () => void, calls = 0;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await setup({ mail: { send: async () => { calls++; started(); await blocked; } } });
  let drain: Promise<void> | undefined;
  try {
    await f.register(); drain = f.app.mailOutbox!.drain(); await ready;
    assert.throws(() => f.app.close(), /Drain account mail/);
    await f.app.mailOutbox!.drain(); assert.equal(calls, 1);
    const response = await f.request("/request-password-reset", { email: "reader@example.test" }); assert.equal(response.status, 202);
    assert.equal(f.app.mailOutbox!.status().queued, 2);
  } finally { release(); await drain; await f.close(); }
});
