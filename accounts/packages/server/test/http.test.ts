import assert from "node:assert/strict";
import test from "node:test";
import { baseURL, fixture, origin, password } from "./fixtures.ts";

test("actual ingress rejects hostile and missing origins, non-JSON mutations and unknown routes", async () => {
  const f = await fixture();
  try {
    for (const originValue of ["https://evil.test", `${origin}.evil.test`, "null", ""]) {
      assert.equal((await f.request("/sign-in/email", { email: "reader@example.test", password }, { origin: originValue })).status, 403);
    }
    assert.equal((await f.app.handler(new Request(`${baseURL}/v1/auth/sign-out`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status, 403);
    assert.equal((await f.request("/sign-out", {}, { "content-type": "text/plain" })).status, 415);
    for (const route of ["/verify-password", "/change-password", "/list-sessions", "/update-user", "/delete-user", "/sign-in/social", "/reset-password/hidden"]) {
      assert.equal((await f.request(route, {})).status, 404, route);
    }
  } finally { await f.close(); }
});

test("body limits count streamed bytes, reject malformed input and exact callback violations", async () => {
  const f = await fixture();
  try {
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      produced += 1; controller.enqueue(new Uint8Array(16384)); if (produced === 10) controller.close();
    } });
    const response = await f.app.handler(new Request(`${baseURL}/v1/auth/sign-up/email`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body, duplex: "half",
    }));
    assert.equal(response.status, 413); assert.ok(produced < 10);
    assert.equal((await f.app.handler(new Request(`${baseURL}/v1/auth/sign-out`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" }))).status, 400);
    for (const callbackURL of [`${origin}/evil`, `${origin}/account/complete?next=evil`, "https://evil.test/"]) {
      assert.equal((await f.request("/sign-up/email", { email: "reader@example.test", password, name: "Reader", callbackURL })).status, 400);
    }
    assert.equal(f.mail.length, 0);
  } finally { await f.close(); }
});

test("responses are private and CORS permits only the exact credentialed origin", async () => {
  const f = await fixture();
  try {
    for (const response of [await f.request("/get-session"), await f.request("/missing")]) {
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.match(response.headers.get("vary")!, /Origin/);
    }
    const rejected = await f.request("/get-session", undefined, { origin: "https://evil.test" });
    assert.equal(rejected.status, 403); assert.equal(rejected.headers.get("access-control-allow-origin"), null);
    const preflight = await f.app.handler(new Request(`${baseURL}/v1/auth/sign-out`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }));
    assert.equal(preflight.status, 204);
  } finally { await f.close(); }
});

test("ingress limits cannot be bypassed with client-supplied forwarding headers", async () => {
  const f = await fixture({ requestLimit: { maxRequests: 2, windowMs: 60000 } });
  try {
    assert.equal((await f.request("/get-session", undefined, { "x-forwarded-for": "192.0.2.1" })).status, 200);
    assert.equal((await f.request("/get-session", undefined, { "x-forwarded-for": "192.0.2.2" })).status, 200);
    const limited = await f.request("/get-session", undefined, { "x-forwarded-for": "192.0.2.3" });
    assert.equal(limited.status, 429); assert.ok(limited.headers.has("retry-after"));
  } finally { await f.close(); }
});

test("ingress rejects oversized headers and limits all admitted work while mail is blocked", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  let blocking = false;
  let count = 0;
  const f = await fixture({ sensitiveLimit: { maxRequests: 20, windowMs: 60000 }, mail: { send: async () => { if (blocking) { if (++count === 8) entered(); await gate; } } } });
  try {
    assert.equal((await f.request("/get-session", undefined, { cookie: "x".repeat(9000) })).status, 431);
    await f.register();
    blocking = true;
    const registrations = Array.from({ length: 8 }, () => f.request("/send-verification-email", { email: "reader@example.test" }));
    await sending;
    const pending = await f.request("/get-session");
    assert.equal(pending.status, 503);
    release();
    await Promise.all(registrations);
  } finally { release(); await f.close(); }
});

test("account-operation limits survive changing trusted peer addresses and email case", async () => {
  const f = await fixture({ sensitiveLimit: { maxRequests: 2, windowMs: 60000 } });
  try {
    for (const path of ["/sign-in/email", "/sign-up/email", "/request-password-reset", "/send-verification-email"]) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await f.app.handler(new Request(`${baseURL}/v1/auth${path}`, {
          method: "POST", headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email: attempt === 2 ? "READER@example.test" : "reader@example.test", password, name: "Reader" }),
        }), { peerAddress: `192.0.2.${attempt}` });
        assert.equal(response.status === 429, attempt === 3, `${path}: attempt ${attempt}`);
      }
    }
  } finally { await f.close(); }
});

test("private extension routes share ingress and receive only session-derived account authority", async () => {
  let received: unknown;
  const f = await fixture({ privateRoutes: [{ path: "/v1/identity-test", method: "POST", handle: async (context: unknown) => {
    received = context; return Response.json({ status: true });
  } }] });
  try {
    const call = (cookie = "", requestOrigin = origin) => f.app.handler(new Request(`${baseURL}/v1/identity-test`, { method: "POST", headers: { cookie, origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify({ accountId: "another-account", template: { content: "private" } }) }));
    assert.equal((await call()).status, 401);
    await f.register(); await f.verify(); const login = await f.login();
    const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    assert.equal((await call(cookie, "https://evil.test")).status, 403);
    const response = await call(cookie);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const context = received as { account: { user: { id: string } }; body: { accountId: string } };
    assert.notEqual(context.account.user.id, context.body.accountId);
  } finally { await f.close(); }
});

test("oversized private extension responses fail as service errors without changing the request body limit", async () => {
  const f = await fixture({ privateRoutes: [{ path: "/v1/response-boundary", method: "POST", handle: async () => new Response("x".repeat(131073)) }] });
  try {
    await f.register(); await f.verify(); const login = await f.login();
    const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const request = (body: unknown) => f.app.handler(new Request(`${baseURL}/v1/response-boundary`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const response = await request({});
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "TEMPORARILY_UNAVAILABLE");
    assert.equal((await request({ content: "x".repeat(65536) })).status, 413);
  } finally { await f.close(); }
});
