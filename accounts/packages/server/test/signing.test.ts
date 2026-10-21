import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { Event } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import * as server from "../src/index.ts";
import { baseURL, origin, password, returnURL } from "./fixtures.ts";

const template = () => ({ kind: 1, created_at: 1700000123, content: "  exact\r\ncontent 🟣  ", tags: [["p", "b".repeat(64), "wss://relay.example.test"], ["t", "Second"], ["t", "first"], []] });
async function setup(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "signing-test-"));
  const databasePath = join(directory, "private.sqlite"), inventoryPath = join(directory, "inventory");
  const custody = { installationId: "signing-fixture", inventoryPath, encryption: { activeKid: "fixture", keys: { fixture: new Uint8Array(32).fill(19) } } };
  server.initializeAccountDatabase(databasePath);
  server.initializeIdentityInventory(inventoryPath, custody.installationId);
  server.initializeAccountCustody(databasePath, custody);
  const mail: Array<server.AccountMail> = [];
  const app = server.createAccountServer({ databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], custody,
    signingPolicy: { allowedKinds: [1] }, explicitExportEnabled: true,
    requestLimit: { maxRequests: 1000, windowMs: 60000 }, sensitiveLimit: { maxRequests: 50, windowMs: 60000 },
    mail: { send: async (message) => { mail.push(message); } }, ...options,
  });
  const db = new Database(databasePath);
  async function request(path: string, body?: unknown, cookie = "", headers: Record<string, string> = {}) {
    const response = await app.handler(new Request(`${baseURL}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    await app.mailOutbox!.drain();
    return response;
  }
  async function login(email = "reader@example.test", currentPassword = password) {
    const response = await request("/v1/auth/sign-in/email", { email, password: currentPassword });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0]!;
  }
  async function account(email = "reader@example.test") {
    assert.equal((await request("/v1/auth/sign-up/email", { email, password, name: "Reader" })).status, 202);
    const message = mail.findLast((message) => message.kind === "verification" && message.email === email)!;
    assert.ok(message);
    assert.equal((await app.handler(new Request(message.url))).status, 302);
    return login(email);
  }
  await app.ready();
  return { app, db, mail, request, account, login, close: async () => { db.close(); app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json() as { error: { code: string }; requestId: string };
  assert.equal(result.error.code, code); assert.ok(result.requestId);
}

test("protected identity reads are stable and signing preserves the complete exact template without network access", async (t) => {
  const f = await setup();
  try {
    const cookie = await f.account();
    const fetchGuard = t.mock.method(globalThis, "fetch", () => { throw new Error("outbound fetch forbidden"); });
    const socketGuard = t.mock.method(Socket.prototype, "connect", () => { throw new Error("outbound socket forbidden"); });
    const identityResponse = await f.request("/v1/identity", undefined, cookie);
    assert.equal(identityResponse.status, 200);
    const identity = await identityResponse.json() as { publicKey: string; capabilities: { allowedKinds: number[]; exportEnabled: boolean } };
    assert.match(identity.publicKey, /^[0-9a-f]{64}$/);
    assert.deepEqual(identity.capabilities, { allowedKinds: [1], exportEnabled: true });
    assert.deepEqual(await (await f.request("/v1/identity", undefined, cookie)).json(), identity);
    const requested = template();
    const response = await f.request("/v1/identity/sign", { template: requested }, cookie);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const event = await response.json() as Event;
    assert.equal(event.pubkey, identity.publicKey); assert.equal(event.id, getEventHash(event));
    const { pubkey, id, sig, ...signedTemplate } = event;
    assert.deepEqual(signedTemplate, requested);
    assert.deepEqual(Object.keys(event).sort(), ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    assert.equal(verifyEvent(event), true);
    assert.equal(fetchGuard.mock.callCount(), 0); assert.equal(socketGuard.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("installation signing policy defaults to denial and cannot be broadened through mutable configuration", async () => {
  const policy = { allowedKinds: [] as number[] };
  const f = await setup({ signingPolicy: policy });
  try {
    const cookie = await f.account(); policy.allowedKinds.push(1);
    await expectError(await f.request("/v1/identity/sign", { template: template() }, cookie), 403, "PERMISSION_DENIED");
    assert.deepEqual((await (await f.request("/v1/identity", undefined, cookie)).json() as { capabilities: unknown }).capabilities, { allowedKinds: [], exportEnabled: true });
  } finally { await f.close(); }
  const absent = await setup({ signingPolicy: undefined });
  try { await expectError(await absent.request("/v1/identity/sign", { template: template() }), 404, "NOT_FOUND"); }
  finally { await absent.close(); }
});

test("signing rejects every unauthorized kind including caller URL authorization without fetching it", async (t) => {
  const f = await setup();
  try {
    const cookie = await f.account();
    const fetchGuard = t.mock.method(globalThis, "fetch", () => { throw new Error("outbound fetch forbidden"); });
    const socketGuard = t.mock.method(Socket.prototype, "connect", () => { throw new Error("outbound socket forbidden"); });
    for (const kind of [0, 3, 4, 1111, 9734, 24242, 27235, 65535]) {
      await expectError(await f.request("/v1/identity/sign", { template: { ...template(), kind, tags: [["u", "http://127.0.0.1/private"]] } }, cookie), 403, "PERMISSION_DENIED");
    }
    assert.equal(fetchGuard.mock.callCount(), 0); assert.equal(socketGuard.mock.callCount(), 0);
    assert.equal((f.db.prepare("SELECT count(*) AS count FROM author_identity").get() as { count: number }).count, 0);
  } finally { await f.close(); }
});

test("signing rejects caller authority in the envelope and template instead of using another account key", async () => {
  const f = await setup();
  try {
    const first = await f.account(), second = await f.account("other@example.test");
    const identity = await (await f.request("/v1/identity", undefined, second)).json() as { publicKey: string };
    const user = f.db.prepare("SELECT id FROM user WHERE email = ?").get("other@example.test") as { id: string };
    for (const [key, value] of [["accountId", user.id], ["pubkey", identity.publicKey], ["id", "a".repeat(64)], ["sig", "b".repeat(128)], ["operation", "approved"]]) {
      await expectError(await f.request("/v1/identity/sign", { template: template(), [key!]: value }, first), 400, "INVALID_INPUT");
      await expectError(await f.request("/v1/identity/sign", { template: { ...template(), [key!]: value } }, first), 400, "INVALID_INPUT");
    }
    const event = await (await f.request("/v1/identity/sign", { template: template() }, first)).json() as Event;
    assert.notEqual(event.pubkey, identity.publicKey); assert.equal(verifyEvent(event), true);
    assert.equal((await f.request("/v1/identity/export", { password, accountId: user.id }, first)).status, 400);
  } finally { await f.close(); }
});

test("complete unsigned-template validation rejects malformed or excessive fields before provisioning", async () => {
  const f = await setup();
  try {
    const cookie = await f.account();
    const invalid: unknown[] = [null, [], {}, { ...template(), content: 1 }, { ...template(), content: "🟣".repeat(4097) },
      { ...template(), tags: ["t"] }, { ...template(), tags: [["t", 1]] }, { ...template(), tags: Array.from({ length: 257 }, () => []) },
      { ...template(), tags: [Array(33).fill("a")] }, { ...template(), tags: [["t", "a".repeat(2049)]] },
      ...["kind", "created_at"].flatMap((field) => [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map((value) => ({ ...template(), [field]: value })))];
    for (const value of invalid) await expectError(await f.request("/v1/identity/sign", { template: value }, cookie), 400, "INVALID_INPUT");
    await expectError(await f.request("/v1/identity/sign", { template: { ...template(), content: "a".repeat(65536) } }, cookie), 413, "REQUEST_TOO_LARGE");
    assert.equal((f.db.prepare("SELECT count(*) AS count FROM author_identity").get() as { count: number }).count, 0);
  } finally { await f.close(); }
});

test("template boundary values including empty content and ordered duplicate tags survive signing", async () => {
  const f = await setup();
  try {
    const cookie = await f.account();
    for (const value of [{ kind: 1, created_at: 0, content: "", tags: [] }, { ...template(), content: "line\\literal\n\u0000\t\"", tags: [["t", "🟣\n\"\\"]] }, { ...template(), created_at: Number.MAX_SAFE_INTEGER, content: "🟣".repeat(4096), tags: [["t", "duplicate"], ["t", "duplicate"]] }]) {
      const response = await f.request("/v1/identity/sign", { template: value }, cookie); assert.equal(response.status, 200);
      const event = await response.json() as Event;
      assert.equal(verifyEvent(event), true); assert.deepEqual({ kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }, value);
    }
  } finally { await f.close(); }
});

test("signing rejects unpaired UTF-16 surrogates in content and tags before provisioning", async () => {
  const f = await setup();
  try {
    const cookie = await f.account();
    for (const value of [{ ...template(), content: "bad\ud800" }, { ...template(), content: "bad\udfff" }, { ...template(), tags: [["t", "bad\ud800"]] }]) {
      await expectError(await f.request("/v1/identity/sign", { template: value }, cookie), 400, "INVALID_INPUT");
    }
    assert.equal((f.db.prepare("SELECT count(*) AS count FROM author_identity").get() as { count: number }).count, 0);
  } finally { await f.close(); }
});

test("signing returns a complete exact event when the accepted request is near its 64 KiB bound", async () => {
  const f = await setup();
  try {
    const cookie = await f.account();
    const requested = { kind: 1, created_at: 0, content: "", tags: [Array<string>(31).fill("x".repeat(2048)), ["x".repeat(1800)]] };
    const body = { template: requested };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 65536);
    const response = await f.request("/v1/identity/sign", body, cookie);
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.ok(Buffer.byteLength(serialized) > 65536, "signature fields grow the response past the request limit");
    const event = JSON.parse(serialized) as Event;
    assert.deepEqual({ kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }, requested);
    assert.equal(event.id, getEventHash(event)); assert.equal(verifyEvent(event), true);
    const oversized = { template: { ...requested, tags: [...requested.tags, ["x".repeat(2048)]] } };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 65536);
    await expectError(await f.request("/v1/identity/sign", oversized, cookie), 413, "REQUEST_TOO_LARGE");
  } finally { await f.close(); }
});

test("all identity operations require a live verified session and respect shared CSRF ingress", async () => {
  const f = await setup();
  try {
    for (const [path, body] of [["/v1/identity", undefined], ["/v1/identity/sign", { template: template() }], ["/v1/identity/export", { password }]] as const) await expectError(await f.request(path, body), 401, "UNAUTHENTICATED");
    const cookie = await f.account();
    await expectError(await f.request("/v1/identity/sign", { template: template() }, cookie, { origin: "https://evil.example.test" }), 403, "PERMISSION_DENIED");
    f.db.prepare("UPDATE user SET emailVerified = 0").run();
    await expectError(await f.request("/v1/identity/sign", { template: template() }, cookie), 403, "EMAIL_UNVERIFIED");
  } finally { await f.close(); }
});

test("logout and expiry deny new signatures and exports with a previously valid cookie", async () => {
  const f = await setup();
  try {
    let cookie = await f.account();
    assert.equal((await f.request("/v1/identity/sign", { template: template() }, cookie)).status, 200);
    assert.equal((await f.request("/v1/auth/sign-out", {}, cookie)).status, 200);
    for (const path of ["/v1/identity/sign", "/v1/identity/export"]) await expectError(await f.request(path, path.endsWith("sign") ? { template: template() } : { password }, cookie), 401, "UNAUTHENTICATED");
    cookie = await f.login(); f.db.prepare("UPDATE session SET expiresAt = ?").run(Date.now() - 1000);
    await expectError(await f.request("/v1/identity/sign", { template: template() }, cookie), 401, "UNAUTHENTICATED");
    await expectError(await f.request("/v1/identity/export", { password }, cookie), 401, "UNAUTHENTICATED");
  } finally { await f.close(); }
});

test("explicit export verifies the current password each time and returns only the assigned nsec and public key", async (t) => {
  const f = await setup();
  try {
    const cookie = await f.account();
    await expectError(await f.request("/v1/identity/export", {}, cookie), 400, "INVALID_INPUT");
    await expectError(await f.request("/v1/identity/export", { password: "wrong password" }, cookie), 403, "PERMISSION_DENIED");
    const fetchGuard = t.mock.method(globalThis, "fetch", () => { throw new Error("outbound fetch forbidden"); });
    const socketGuard = t.mock.method(Socket.prototype, "connect", () => { throw new Error("outbound socket forbidden"); });
    const response = await f.request("/v1/identity/export", { password }, cookie);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json() as { publicKey: string; nsec: string };
    assert.deepEqual(Object.keys(result).sort(), ["nsec", "publicKey"]);
    const decoded = decode(result.nsec); assert.equal(decoded.type, "nsec");
    assert.equal(getPublicKey(decoded.data as Uint8Array), result.publicKey);
    const hex = Buffer.from(decoded.data as Uint8Array).toString("hex");
    for (const ordinary of [await f.request("/v1/identity", undefined, cookie), await f.request("/v1/identity/sign", { template: template() }, cookie), await f.request("/v1/auth/get-session", undefined, cookie)]) {
      const text = await ordinary.text(); assert.ok(!text.includes(result.nsec)); assert.ok(!text.includes(hex)); assert.ok(!text.includes("session_token"));
    }
    await expectError(await f.request("/v1/identity/export", { password: "wrong password" }, cookie), 403, "PERMISSION_DENIED");
    const otherCookie = await f.account("other@example.test");
    const other = await (await f.request("/v1/identity/export", { password }, otherCookie)).json() as { publicKey: string; nsec: string };
    assert.notEqual(other.publicKey, result.publicKey); assert.notEqual(other.nsec, result.nsec);
    assert.equal(fetchGuard.mock.callCount(), 0); assert.equal(socketGuard.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("export is disabled unless explicitly enabled and private password checks are rate limited", async () => {
  const disabled = await setup({ explicitExportEnabled: undefined });
  try { const cookie = await disabled.account(); await expectError(await disabled.request("/v1/identity/export", { password }, cookie), 403, "PERMISSION_DENIED"); }
  finally { await disabled.close(); }
  const limited = await setup({ sensitiveLimit: { maxRequests: 2, windowMs: 60000 } });
  try {
    const cookie = await limited.account();
    for (let i = 0; i < 2; i++) await expectError(await limited.request("/v1/identity/export", { password: "wrong password" }, cookie), 403, "PERMISSION_DENIED");
    const response = await limited.request("/v1/identity/export", { password }, cookie);
    assert.equal(response.headers.get("retry-after"), "60"); await expectError(response, 429, "RATE_LIMITED");
    await expectError(await limited.request("/v1/auth/verify-password", { password }, cookie), 404, "NOT_FOUND");
  } finally { await limited.close(); }
});

test("password reset revokes both device sessions and preserves identity while rejecting the old export password", async () => {
  const f = await setup();
  try {
    const first = await f.account(), second = await f.login();
    const identity = await (await f.request("/v1/identity", undefined, first)).json() as { publicKey: string };
    await f.request("/v1/auth/request-password-reset", { email: "reader@example.test" });
    const token = f.mail.findLast((message) => message.kind === "password-reset")!.token;
    const newPassword = "new current password fixture";
    assert.equal((await f.request("/v1/auth/reset-password", { token, newPassword })).status, 200);
    for (const cookie of [first, second]) {
      await expectError(await f.request("/v1/identity/sign", { template: template() }, cookie), 401, "UNAUTHENTICATED");
      await expectError(await f.request("/v1/identity/export", { password: newPassword }, cookie), 401, "UNAUTHENTICATED");
    }
    const cookie = await f.login("reader@example.test", newPassword);
    await expectError(await f.request("/v1/identity/export", { password }, cookie), 403, "PERMISSION_DENIED");
    const exported = await (await f.request("/v1/identity/export", { password: newPassword }, cookie)).json() as { publicKey: string };
    assert.equal(exported.publicKey, identity.publicKey);
  } finally { await f.close(); }
});
