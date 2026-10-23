import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import * as server from "../src/index.ts";
import { origin, password, returnURL } from "./fixtures.ts";

interface Cookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number }
/** Test-only cookie jar: exercises multiple cookies, host/path scope, expiry and deletion. */
export class TestCookieJar {
  private cookies = new Map<string, Cookie>();
  accept(url: URL, values: readonly string[], now = Date.now()) {
    for (const value of values) {
      const [pair, ...parts] = value.split(";");
      const equal = pair!.indexOf("="); if (equal < 1) continue;
      const name = pair!.slice(0, equal).trim(), cookieValue = pair!.slice(equal + 1).trim();
      const attrs = new Map(parts.map((part) => { const [key, ...rest] = part.trim().split("="); return [key!.toLowerCase(), rest.join("=")]; }));
      const domain = (attrs.get("domain") ?? url.hostname).replace(/^\./, "").toLowerCase();
      if (domain !== url.hostname && !url.hostname.endsWith(`.${domain}`)) continue;
      const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
      const path = attrs.get("path")?.startsWith("/") ? attrs.get("path")! : defaultPath;
      let expires = attrs.has("expires") ? Date.parse(attrs.get("expires")!) : Infinity;
      if (!Number.isFinite(expires)) expires = Infinity;
      if (/^-?\d+$/.test(attrs.get("max-age") ?? "")) expires = now + Number(attrs.get("max-age")) * 1000;
      const key = `${domain}\n${path}\n${name}`;
      if (expires <= now) this.cookies.delete(key);
      else this.cookies.set(key, { name, value: cookieValue, domain, hostOnly: !attrs.has("domain"), path, secure: attrs.has("secure"), expires });
    }
  }
  header(url: URL, now = Date.now()): string {
    return [...this.cookies.values()].filter((cookie) => cookie.expires > now && (!cookie.secure || url.protocol === "https:") &&
      (url.hostname === cookie.domain || (!cookie.hostOnly && url.hostname.endsWith(`.${cookie.domain}`))) &&
      (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)))
      .sort((a, b) => b.path.length - a.path.length).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
}

/** A test transport, not the production adapter or native mobile acceptance. */
export async function httpsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "account-https-test-"));
  const keyPath = join(directory, "tls-key.pem"), certificatePath = join(directory, "tls-cert.pem");
  const opensslConfig = join(directory, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", opensslConfig], { stdio: "ignore" });
  const certificate = await readFile(certificatePath);
  let app: ReturnType<typeof server.createAccountServer>;
  let baseURL: string;
  const listener = createServer({ key: await readFile(keyPath), cert: certificate }, async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Buffer));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const result = await app.handler(new Request(`${baseURL}${incoming.url!}`, { method: incoming.method!, headers,
        ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) }), { peerAddress: incoming.socket.remoteAddress! });
      outgoing.statusCode = result.status;
      for (const [key, value] of result.headers) if (key !== "set-cookie") outgoing.setHeader(key, value);
      const cookies = result.headers.getSetCookie(); if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.statusCode = 500; outgoing.end("fixture transport failed"); }
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  baseURL = `https://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const databasePath = join(directory, "accounts.sqlite"), inventoryPath = join(directory, "inventory");
  const custody = { installationId: "https-fixture", inventoryPath, encryption: { activeKid: "fixture", keys: { fixture: new Uint8Array(32).fill(39) } } };
  server.initializeAccountDatabase(databasePath); server.initializeIdentityInventory(inventoryPath, custody.installationId); server.initializeAccountCustody(databasePath, custody);
  const mail: server.AccountMail[] = [];
  const config = { databasePath, baseURL, secret: "test-only-auth-secret-not-for-any-installation-42", trustedOrigins: [origin], returnURLs: [returnURL], custody,
    signingPolicy: { allowedKinds: [1] }, requestLimit: { maxRequests: 1000, windowMs: 60000 }, sensitiveLimit: { maxRequests: 100, windowMs: 60000 },
    mail: { send: async (message: server.AccountMail) => { mail.push(message); } } };
  app = server.createAccountServer(config); await app.ready();
  const db = new Database(databasePath);
  function client() {
    const jar = new TestCookieJar();
    async function request(path: string, body?: unknown, extraHeaders: Record<string, string | undefined> = {}) {
      const url = new URL(path, baseURL); assert.equal(url.origin, baseURL, "the fixture never requests public domains");
      const headers: Record<string, string> = { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) };
      const cookie = jar.header(url); if (cookie) headers.cookie = cookie;
      for (const [key, value] of Object.entries(extraHeaders)) { if (value === undefined) delete headers[key]; else headers[key] = value; }
      return new Promise<Response>((resolve, reject) => {
        const req = httpsRequest(url, { ca: certificate, method: body === undefined ? "GET" : "POST", headers, agent: false }, (res) => {
          const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("error", reject);
          res.on("end", () => {
            jar.accept(url, res.headers["set-cookie"] ?? []);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) { if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item); else if (value !== undefined) responseHeaders.append(key, value); }
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: responseHeaders }));
          });
        });
        req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
      });
    }
    return { jar, request,
      login: (currentPassword = password) => request("/v1/auth/sign-in/email", { email: "reader@example.test", password: currentPassword }) };
  }
  const first = client(), second = client();
  async function register() {
    assert.equal((await first.request("/v1/auth/sign-up/email", { email: "reader@example.test", password, name: "Reader" })).status, 202);
    assert.equal(mail.length, 0);
    await app.mailOutbox!.drain();
    assert.equal((await first.request(mail[0]!.url)).status, 302);
    assert.equal((await first.login()).status, 200); assert.equal((await second.login()).status, 200);
  }
  async function recovery() {
    assert.equal((await first.request("/v1/auth/request-password-reset", { email: "reader@example.test", redirectTo: returnURL })).status, 202);
    await app.mailOutbox!.drain();
    return mail.findLast((message) => message.kind === "password-reset")!;
  }
  return { first, second, client, register, recovery, db, mail, baseURL, get app() { return app; },
    processRestart: async (template: unknown) => {
      app.close();
      const child = fork(new URL("./restart-child.ts", import.meta.url), [], { execArgv: ["--experimental-strip-types"], serialization: "advanced", stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const { mail: _transport, ...privateConfig } = config;
      let result: { pid: number; messages: server.AccountMail[]; status: number; signed: { pubkey: string } } | undefined;
      let outputBytes = 0;
      child.stdout!.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
      child.stderr!.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
      child.once("message", (value) => { result = value as typeof result; });
      const timeout = setTimeout(() => child.kill(), 10000);
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Restart fixture process failed")));
          child.send({ config: privateConfig, cookie: first.jar.header(new URL(baseURL)), template });
        });
        assert.equal(outputBytes, 0, "the restart process must not print private data");
        assert.ok(result);
        return result;
      } finally { clearTimeout(timeout); app = server.createAccountServer(config); await app.ready(); }
    },
    restart: async () => { app.close(); app = server.createAccountServer(config); await app.ready(); },
    close: async () => { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); app.close(); db.close(); await rm(directory, { recursive: true, force: true }); } };
}
