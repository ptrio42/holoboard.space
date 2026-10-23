import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { fixture, password, returnURL } from "./fixtures.ts";
import { initializeAccountDatabase, createAccountServer } from "../src/index.ts";
import { stat } from "node:fs/promises";

test("registration is generic, requires verification and never creates a session", async () => {
  const f = await fixture();
  try {
    const first = await f.register();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true });
    assert.equal(first.headers.getSetCookie().length, 0);
    assert.deepEqual(await (await f.register()).json(), { accepted: true });
    const denied = await f.login();
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "EMAIL_UNVERIFIED");
    assert.equal((await f.request("/get-session")).status, 200);
    assert.equal(await (await f.request("/get-session")).json(), null);
    assert.equal((await f.verify()).status, 302);
    assert.equal((await f.register()).status, 202);
    assert.equal(await (await f.request("/get-session")).json(), null);
    assert.equal((await f.login()).status, 200);
  } finally { await f.close(); }
});

test("real cookies are secure and host-only, all cookies survive token redaction", async () => {
  const f = await fixture();
  try {
    await f.register(); await f.verify();
    const loginStartedAt = Date.now();
    const login = await f.login();
    const loginFinishedAt = Date.now();
    const cookies = login.headers.getSetCookie();
    assert.ok(cookies.length >= 1);
    const sessionCookie = cookies.find((value) => value.startsWith("__Secure-better-auth.session_token="))!;
    assert.match(sessionCookie, /HttpOnly/i); assert.match(sessionCookie, /Secure/i);
    assert.match(sessionCookie, /SameSite=Lax/i); assert.match(sessionCookie, /Max-Age=604800/i);
    assert.doesNotMatch(sessionCookie, /Domain=/i);
    assert.equal("token" in ((await login.json()) as object), false);
    const session = await (await f.request("/get-session")).json() as {
      user: { emailVerified: boolean }; session: { createdAt: string; expiresAt: string; token?: string };
    };
    assert.equal(session.user.emailVerified, true);
    assert.equal("token" in session.session, false);
    // Better Auth reads the expiry and creation clocks separately.
    const expiresAt = Date.parse(session.session.expiresAt);
    assert.ok(expiresAt >= loginStartedAt + 604800000 && expiresAt <= loginFinishedAt + 604800000);
    const db = new Database(f.databasePath);
    const stored = db.prepare('SELECT password FROM account').get() as { password: string };
    assert.match(stored.password, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const before = db.prepare('SELECT expiresAt FROM session').get();
    await f.request("/get-session");
    assert.deepEqual(db.prepare('SELECT expiresAt FROM session').get(), before);
    db.prepare('UPDATE session SET expiresAt = ?').run(Date.now() - 1000);
    assert.equal(await (await f.request("/get-session")).json(), null);
    db.close();
    const logout = await f.request("/sign-out", {});
    assert.ok(logout.headers.getSetCookie().length >= 2, "all deletion cookies survive the response wrapper");
  } finally { await f.close(); }
});

test("password recovery is generic and reset consumes its token and revokes every session", async () => {
  const f = await fixture();
  try {
    await f.register(); await f.verify(); await f.login();
    const existing = await f.request("/request-password-reset", { email: "reader@example.test", redirectTo: returnURL });
    const absent = await f.request("/request-password-reset", { email: "absent@example.test", redirectTo: returnURL });
    assert.equal(existing.status, 202); assert.equal(absent.status, 202);
    assert.deepEqual(await existing.json(), await absent.json());
    const reset = f.mail.findLast((message) => message.kind === "password-reset")!;
    assert.equal(new URL(reset.url).origin, new URL(returnURL).origin);
    const changed = await f.request("/reset-password", { token: reset.token, newPassword: `${password} new` });
    assert.equal(changed.status, 200);
    assert.equal(await (await f.request("/get-session")).json(), null);
    assert.equal((await f.request("/reset-password", { token: reset.token, newPassword: `${password} again` })).status, 400);
    assert.equal((await f.login()).status, 401);
    assert.equal((await f.request("/sign-in/email", { email: "reader@example.test", password: `${password} new` })).status, 200);
  } finally { await f.close(); }
});

test("protected server APIs derive the user from the live session and limit password checks", async () => {
  const f = await fixture({ sensitiveLimit: { maxRequests: 2, windowMs: 60000 } });
  try {
    await f.register(); await f.verify(); const login = await f.login();
    const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const request = new Request("https://accounts.test/private", { headers: { cookie } });
    const account = await f.app.requireAccount(request);
    assert.equal(account.user.email, "reader@example.test");
    assert.equal("token" in account.session, false);
    assert.equal(await f.app.verifyPassword(request, password), true);
    assert.equal(await f.app.verifyPassword(request, "incorrect password"), false);
    await assert.rejects(f.app.verifyPassword(request, password), /RATE_LIMITED/);
    await f.request("/sign-out", {});
    await assert.rejects(f.app.requireAccount(request), /UNAUTHENTICATED/);
  } finally { await f.close(); }
});

test("mail has a bounded deadline even when its adapter ignores cancellation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timer = setTimeout(release, 5000);
  let deliveries = 0;
  const f = await fixture({ mailTimeoutMs: 50, mail: { send: async () => { deliveries++; await gate; } } });
  try {
    const start = Date.now();
    assert.equal((await f.register()).status, 202);
    assert.ok(Date.now() - start < 1000, "an ignored abort signal must not leave the handler waiting for the provider");
    for (let index = 0; index < 10; index++) assert.equal((await f.register(`blocked${index}@example.test`)).status, 202);
    assert.equal(deliveries, 8, "timed-out ignored cancellation still holds its provider capacity slot");
  } finally { release(); clearTimeout(timer); await f.close(); }
});

test("mail failures do not reveal whether signup or recovery found an account", async () => {
  const f = await fixture({ mail: { send: async () => { throw new Error("private transport failure"); } } });
  try {
    const fresh = await f.register();
    const duplicate = await f.register();
    assert.equal(fresh.status, 202); assert.equal(duplicate.status, 202);
    assert.deepEqual(await fresh.json(), await duplicate.json());
    const known = await f.request("/request-password-reset", { email: "reader@example.test", redirectTo: returnURL });
    const unknown = await f.request("/request-password-reset", { email: "absent@example.test", redirectTo: returnURL });
    assert.equal(known.status, 202); assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), await unknown.json());
  } finally { await f.close(); }
});

test("verification resend is generic for absent, unverified and verified addresses when delivery fails", async () => {
  let failing = false;
  let providerCalls = 0;
  const f = await fixture({ mail: { send: async () => { providerCalls++; if (failing) throw new Error("private delivery failure"); } } });
  try {
    await f.register();
    const db = new Database(f.databasePath);
    db.prepare('UPDATE user SET emailVerified = 1').run();
    db.close();
    await f.register("pending@example.test");
    failing = true;
    const before = providerCalls;
    for (const email of ["absent@example.test", "pending@example.test", "reader@example.test"]) {
      const response = await f.request("/send-verification-email", { email });
      assert.equal(response.status, 202, email);
      assert.deepEqual(await response.json(), { accepted: true });
    }
    assert.equal(providerCalls - before, 1, "only eligible mail is scheduled");
    assert.equal((await f.request("/send-verification-email", { email: "invalid" })).status, 400);
  } finally { await f.close(); }
});

test("blocked delivery does not delay generic signup, recovery or verification responses", async () => {
  let blocked = false;
  const pending: Array<() => void> = [];
  const calls: number[] = [];
  const f = await fixture({ mailTimeoutMs: 2000, mail: { send: async () => {
    calls.push(Date.now());
    if (blocked) await new Promise<void>((resolve) => { pending.push(resolve); });
  } } });
  try {
    await f.register();
    const db = new Database(f.databasePath);
    db.prepare('UPDATE user SET emailVerified = 1').run();
    db.close();
    await f.register("pending@example.test");
    blocked = true;
    const before = calls.length;
    const outcomes: Array<{ path: string; email: string; elapsed: number; status: number }> = [];
    for (const path of ["/sign-up/email", "/request-password-reset", "/send-verification-email"]) {
      for (const email of [path === "/sign-up/email" ? "new@example.test" : "absent@example.test", "pending@example.test", "reader@example.test"]) {
        const start = Date.now();
        const response = await f.request(path, { email, password, name: "Reader" });
        outcomes.push({ path, email, elapsed: Date.now() - start, status: response.status });
      }
    }
    assert.ok(calls.length > before, "the test exercised an eligible blocked provider");
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 202, `${outcome.path} ${outcome.email}`);
      assert.ok(outcome.elapsed < 1000, `${outcome.path} must not await its 2000ms provider deadline`);
      if (outcome.path === "/send-verification-email") assert.ok(outcome.elapsed >= 450, "native resend privacy floor is preserved");
    }
    assert.ok(pending.length <= 8, "ignored provider cancellation must retain bounded capacity");
  } finally { for (const release of pending) release(); await f.close(); }
});

test("database initialization is explicit, private and refuses an existing file", async () => {
  const f = await fixture();
  try {
    assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
    assert.throws(() => initializeAccountDatabase(f.databasePath), /EEXIST/);
    assert.throws(() => createAccountServer({ databasePath: `${f.databasePath}.absent`, baseURL: "https://accounts.test", secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: ["https://web.accounts.test"], returnURLs: [returnURL], mail: { send: async () => {} } }));
  } finally { await f.close(); }
});
