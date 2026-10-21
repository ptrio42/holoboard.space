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
    const login = await f.login();
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
    assert.equal(Date.parse(session.session.expiresAt) - Date.parse(session.session.createdAt), 604800000);
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
  const timer = setTimeout(release, 1500);
  const f = await fixture({ mailTimeoutMs: 50, mail: { send: async () => gate } });
  try {
    const start = Date.now();
    assert.equal((await f.register()).status, 202);
    assert.ok(Date.now() - start < 1000, "an ignored abort signal must not leave the handler waiting for the provider");
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

test("database initialization is explicit, private and refuses an existing file", async () => {
  const f = await fixture();
  try {
    assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
    assert.throws(() => initializeAccountDatabase(f.databasePath), /EEXIST/);
    assert.throws(() => createAccountServer({ databasePath: `${f.databasePath}.absent`, baseURL: "https://accounts.test", secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: ["https://web.accounts.test"], returnURLs: [returnURL], mail: { send: async () => {} } }));
  } finally { await f.close(); }
});
