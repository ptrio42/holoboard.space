import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";
import { httpsFixture, TestCookieJar } from "./https-fixture.ts";
import { origin, password, returnURL } from "./fixtures.ts";
const newPassword = "replacement recovery password fixture";
const template = { kind: 1, created_at: 1700000000, content: "recovered exact event", tags: [] };

test("TLS clients recover across service restart, revoke both sessions and retain the signing public key", async () => {
  const f = await httpsFixture();
  try {
    await f.register();
    const identity = await (await f.first.request("/v1/identity")).json() as { publicKey: string };
    const event = await (await f.first.request("/v1/identity/sign", { template })).json() as Event; assert.equal(verifyEvent(event), true); assert.equal(event.pubkey, identity.publicKey);
    assert.equal((await f.second.request("/v1/identity/sign", { template })).status, 200);
    assert.equal((await f.first.request("/v1/auth/request-password-reset", { email: "reader@example.test" })).status, 202);
    await f.restart();
    assert.equal((await f.second.request("/v1/identity/sign", { template })).status, 200);
    await f.app.mailOutbox!.drain();
    const message = f.mail.findLast((message) => message.kind === "password-reset")!;
    const link = new URL(message.url); assert.equal(link.origin + link.pathname, returnURL); assert.equal(link.searchParams.get("token"), message.token);
    const verification = f.db.prepare("SELECT * FROM verification").all();
    assert.ok(!JSON.stringify(verification).includes(message.token), "raw reset token must not be stored in SQLite");
    assert.equal((await f.first.request("/v1/auth/reset-password", { token: link.searchParams.get("token"), newPassword })).status, 200);
    for (const client of [f.first, f.second]) assert.equal((await client.request("/v1/identity/sign", { template })).status, 401);
    assert.equal((await f.first.login(password)).status, 401);
    assert.equal((await f.first.request("/v1/auth/reset-password", { token: message.token, newPassword })).status, 400);
    assert.equal((await f.first.login(newPassword)).status, 200);
    const recovered = await (await f.first.request("/v1/identity/sign", { template })).json() as Event;
    assert.equal(recovered.pubkey, identity.publicKey); assert.equal(verifyEvent(recovered), true);
    await f.restart();
    assert.equal((await (await f.first.request("/v1/identity")).json() as { publicKey: string }).publicKey, identity.publicKey);
  } finally { await f.close(); }
});

test("concurrent TLS use of one reset link has exactly one winner", async () => {
  const f = await httpsFixture();
  try {
    await f.register(); const message = await f.recovery();
    const results = await Promise.all([f.first, f.second].map((client) => client.request("/v1/auth/reset-password", { token: message.token, newPassword })));
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 400]);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM session").get() as { n: number }).n, 0);
    assert.equal((await f.first.login(newPassword)).status, 200);
  } finally { await f.close(); }
});

test("a real SQLite credential failure rolls back token consumption, password and session revocation together", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const f = await httpsFixture();
  try {
    await f.register(); const message = await f.recovery();
    const credentials = f.db.prepare("SELECT * FROM account").all(), tokens = f.db.prepare("SELECT * FROM verification").all(), sessions = f.db.prepare("SELECT * FROM session ORDER BY id").all();
    f.db.exec("CREATE TRIGGER reject_password BEFORE UPDATE OF password ON account BEGIN SELECT RAISE(ABORT, 'injected private credential failure'); END");
    const failed = await f.first.request("/v1/auth/reset-password", { token: message.token, newPassword }); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("injected"));
    assert.equal(errors.mock.callCount(), 0, "database errors must not reach console logs");
    assert.deepEqual(f.db.prepare("SELECT * FROM account").all(), credentials);
    assert.deepEqual(f.db.prepare("SELECT * FROM verification").all(), tokens);
    assert.deepEqual(f.db.prepare("SELECT * FROM session ORDER BY id").all(), sessions);
    for (const client of [f.first, f.second]) assert.equal((await client.request("/v1/identity/sign", { template })).status, 200);
    assert.equal((await f.client().login(newPassword)).status, 401); assert.equal((await f.client().login(password)).status, 200);
    f.db.exec("DROP TRIGGER reject_password");
    assert.equal((await f.first.request("/v1/auth/reset-password", { token: message.token, newPassword })).status, 200);
    for (const client of [f.first, f.second]) assert.equal((await client.request("/v1/identity/sign", { template })).status, 401);
    assert.equal((await f.first.login(password)).status, 401); assert.equal((await f.first.login(newPassword)).status, 200);
  } finally { await f.close(); }
});

test("TLS routes enforce exact origins and return pages without requesting a callback domain", async () => {
  const f = await httpsFixture();
  try {
    await f.register();
    for (const badOrigin of [undefined, "https://attacker.example.test", `${origin}.attacker.example.test`]) assert.equal((await f.first.request("/v1/auth/request-password-reset", { email: "reader@example.test" }, { origin: badOrigin })).status, 403);
    for (const redirectTo of ["https://attacker.example.test/return", `${returnURL}/sibling`, `${returnURL}?x=1`]) assert.equal((await f.first.request("/v1/auth/request-password-reset", { email: "reader@example.test", redirectTo })).status, 400);
    const message = await f.recovery();
    assert.equal((await f.first.request(`/v1/auth/reset-password/${message.token}?callbackURL=${encodeURIComponent(returnURL)}`)).status, 404);
    const token = f.db.prepare("SELECT token FROM session LIMIT 1").get() as { token: string };
    assert.equal((await f.client().request("/v1/identity/sign", { template }, { cookie: `__Secure-better-auth.session_token=${token.token}` })).status, 401);
    assert.equal((await f.first.request("/v1/auth/sign-out", {})).status, 200);
    assert.equal(f.first.jar.header(new URL(f.baseURL)), "");
    assert.equal((await f.first.request("/v1/identity/sign", { template })).status, 401);
  } finally { await f.close(); }
});

test("fixture cookie jars retain all cookies and respect host/path/secure/expiry and deletion", () => {
  const jar = new TestCookieJar(), url = new URL("https://accounts.test/v1/auth/login");
  jar.accept(url, ["first=a; Path=/; Secure", "second=b; Path=/v1; Max-Age=10", "expired=x; Max-Age=0", "old=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT"], 1000);
  assert.equal(jar.header(url, 1001), "second=b; first=a");
  assert.equal(jar.header(new URL("https://sub.accounts.test/v1"), 1001), "");
  assert.equal(jar.header(new URL("http://accounts.test/v1"), 1001), "second=b");
  assert.equal(jar.header(new URL("https://accounts.test/v10"), 1001), "first=a");
  assert.equal(jar.header(url, 11001), "first=a");
  jar.accept(url, ["first=; Path=/; Max-Age=0", "second=; Path=/v1; Max-Age=0"], 2000);
  assert.equal(jar.header(url, 2001), "");
});


test("a separate Node process resumes the persisted session, identity and encrypted mail without secret logs", async () => {
  const f = await httpsFixture();
  try {
    await f.register();
    const before = await (await f.first.request("/v1/identity")).json() as { publicKey: string };
    await f.first.request("/v1/auth/request-password-reset", { email: "reader@example.test" });
    const resumed = await f.processRestart(template);
    assert.notEqual(resumed.pid, process.pid); assert.equal(resumed.status, 200); assert.equal(resumed.signed.pubkey, before.publicKey);
    assert.equal(resumed.messages.length, 1); assert.equal(resumed.messages[0]!.kind, "password-reset");
    assert.equal(f.app.mailOutbox!.status().queued, 0);
    assert.equal((await f.first.request("/v1/auth/reset-password", { token: resumed.messages[0]!.token, newPassword })).status, 200);
    assert.equal((await f.second.request("/v1/identity/sign", { template })).status, 401);
  } finally { await f.close(); }
});
