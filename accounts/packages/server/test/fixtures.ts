import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as server from "../src/index.ts";

export const origin = "https://web.accounts.test";
export const baseURL = "https://accounts.test";
export const returnURL = `${origin}/account/complete`;
export const password = "correct horse battery fixture";

export async function fixture(options: Record<string, unknown> = {}) {
  assert.equal(typeof server.createAccountServer, "function", "a real account handler factory is required");
  const directory = await mkdtemp(join(tmpdir(), "accounts-test-"));
  const databasePath = join(directory, "private.sqlite");
  const mail: Array<{ kind: string; email: string; url: string; token: string }> = [];
  server.initializeAccountDatabase(databasePath);
  const app = server.createAccountServer({
    databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42",
    trustedOrigins: [origin], returnURLs: [returnURL],
    mail: { send: async (message) => { mail.push(message); } },
    ...options,
  });
  let cookie = "";
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await app.handler(new Request(`${baseURL}/v1/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0]!;
      if (pair.startsWith("__Secure-better-auth.session_token=")) cookie = pair;
    }
    return response;
  }
  async function register(email = "reader@example.test") {
    return request("/sign-up/email", { email, password, name: "Reader", callbackURL: returnURL });
  }
  async function verify() {
    const message = mail.findLast((message) => message.kind === "verification")!;
    assert.ok(message);
    return app.handler(new Request(message.url));
  }
  async function login(email = "reader@example.test") {
    return request("/sign-in/email", { email, password });
  }
  return { app, mail, request, register, verify, login, databasePath,
    close: async () => { app.close(); await rm(directory, { recursive: true, force: true }); } };
}
