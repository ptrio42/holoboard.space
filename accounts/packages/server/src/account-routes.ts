import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AuthConfiguration } from "./auth.ts";
import { createAuthentication } from "./auth.ts";
import { openAccountDatabase } from "./database.ts";
import { AccountError, createCapacity, createLimiter, readBoundedBody, withDeadline } from "./limits.ts";
import type { RequestLimit } from "./limits.ts";
import { createIdentityStore, createSerialExecutor, custodyInstallation } from "./identities.ts";
import type { CustodyConfiguration, IdentityStore } from "./identities.ts";
import { createIdentityRoutes } from "./identity-routes.ts";
import type { SigningPolicy } from "./policy.ts";

export interface AccountServerConfiguration extends AuthConfiguration {
  databasePath: string;
  custody?: CustodyConfiguration;
  signingPolicy?: SigningPolicy;
  explicitExportEnabled?: boolean;
  requestLimit?: RequestLimit;
  sensitiveLimit?: RequestLimit;
  privateRoutes?: readonly PrivateAccountRoute[];
}
export interface AccountSession {
  user: { id: string; email: string; emailVerified: boolean; name: string };
  session: { id: string; createdAt: Date; expiresAt: Date };
}
export interface PrivateAccountRoute {
  path: string;
  method: "GET" | "POST";
  /** Apply route-specific field/policy validation before using body. */
  handle(context: {
    request: Request; body: unknown; account: AccountSession;
    verifyPassword(password: string): Promise<boolean>;
    /** Scoped to the current live, verified account. Never uses a client account ID. */
    identity?: { getOrCreate(): ReturnType<IdentityStore["getOrCreate"]>; withSecret<T>(use: (secret: Uint8Array) => T | Promise<T>): Promise<T> };
  }): Promise<Response>;
}
/** Supplied by the embedding transport from its socket, never from HTTP headers. */
export interface AccountRequestContext { peerAddress?: string }
export type AccountRequestHandler = (request: Request, context?: AccountRequestContext) => Promise<Response>;

const routes: Record<string, string> = {
  "/sign-up/email": "POST", "/sign-in/email": "POST", "/send-verification-email": "POST",
  "/verify-email": "GET", "/request-password-reset": "POST", "/reset-password": "POST",
  "/sign-out": "POST", "/get-session": "GET",
};
const genericRoutes = new Set(["/sign-up/email", "/send-verification-email", "/request-password-reset"]);

function validateConfiguration(config: AccountServerConfiguration) {
  if (config.secret.length < 32) throw new Error("Account auth secret must have at least 32 characters");
  if (config.mailTimeoutMs !== undefined && (!Number.isInteger(config.mailTimeoutMs) || config.mailTimeoutMs < 50 || config.mailTimeoutMs > 5000)) throw new Error("Invalid account mail timeout");
  const base = new URL(config.baseURL);
  if (base.protocol !== "https:" || base.origin !== config.baseURL) throw new Error("Account baseURL must be an HTTPS origin");
  if (!/^\/[a-zA-Z0-9/-]+$/.test(config.basePath ?? "/v1/auth") || (config.basePath?.endsWith("/") ?? false)) throw new Error("Invalid account basePath");
  if (!config.trustedOrigins.length || !config.returnURLs.length) throw new Error("Explicit account origins and return URLs are required");
  for (const value of config.trustedOrigins) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error("Account trusted origins must be exact HTTPS origins");
  }
  for (const value of config.returnURLs) {
    const url = new URL(value);
    if (!config.trustedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash) throw new Error("Account return URLs must be fixed trusted HTTPS pages");
  }
}

function errorResponse(error: unknown): Response {
  const known = error instanceof AccountError ? error : new AccountError("TEMPORARILY_UNAVAILABLE", 503);
  return Response.json({ error: { code: known.code, message: known.code, retryable: known.status === 429 || known.status === 503 }, requestId: randomUUID() }, {
    status: known.status, headers: known.status === 429 ? { "retry-after": "60" } : {},
  });
}

export function createAccountServer(config: AccountServerConfiguration) {
  validateConfiguration(config);
  if ((config.signingPolicy || config.explicitExportEnabled) && !config.custody) throw new Error("Identity routes require custody configuration");
  const identityRoutes = config.custody && config.signingPolicy ? createIdentityRoutes(config.signingPolicy, config.explicitExportEnabled === true) : [];
  const ingress = createLimiter(config.requestLimit ?? { maxRequests: 60, windowMs: 60000 });
  const sensitive = createLimiter(config.sensitiveLimit ?? { maxRequests: 5, windowMs: 60000 });
  const capacity = createCapacity(8);
  const db = openAccountDatabase(config.databasePath);
  let identities: IdentityStore | undefined;
  try {
    if (!config.custody && custodyInstallation(db)) throw new Error("Custody configuration is required for this installation");
    if (config.custody) identities = createIdentityStore(db, config.custody);
  } catch (error) { db.close(); throw error; }
  const serial = config.custody ? createSerialExecutor() : <T>(operation: () => Promise<T>) => operation();
  const auth = createAuthentication(config, db);
  let initialReadiness: Promise<void> | undefined;
  const ensureInitialReadiness = (): Promise<void> => {
    initialReadiness ??= identities?.assertReady().catch((error: unknown) => { initialReadiness = undefined; throw error; }) ?? Promise.resolve();
    return initialReadiness;
  };
  const basePath = config.basePath ?? "/v1/auth";
  const privateRoutes = new Map<string, PrivateAccountRoute>();
  for (const route of [...identityRoutes, ...config.privateRoutes ?? []]) {
    if (!/^\/[a-zA-Z0-9/-]+$/.test(route.path) || route.path.startsWith(basePath) || privateRoutes.has(route.path)) {
      db.close(); throw new Error("Invalid private account route");
    }
    privateRoutes.set(route.path, route);
  }

  async function requireAccount(request: Request): Promise<AccountSession> {
    const account = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!account) throw new AccountError("UNAUTHENTICATED", 401);
    if (!account.user.emailVerified) throw new AccountError("EMAIL_UNVERIFIED", 403);
    return {
      user: { id: account.user.id, email: account.user.email, emailVerified: account.user.emailVerified, name: account.user.name },
      session: { id: account.session.id, createdAt: account.session.createdAt, expiresAt: account.session.expiresAt },
    };
  }

  async function verifyPassword(request: Request, password: string): Promise<boolean> {
    const account = await requireAccount(request);
    sensitive(`password:${account.user.id}`);
    if (password.length > 128 || !password) throw new AccountError("INVALID_INPUT", 400);
    try { return (await auth.api.verifyPassword({ headers: request.headers, body: { password } })).status; }
    catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 400) return false;
      throw error;
    }
  }

  const handler: AccountRequestHandler = async (request, context) => {
    const origin = request.headers.get("origin");
    let response: Response;
    try {
      response = await withDeadline(capacity(async () => {
        ingress("global");
        let headerBytes = 0;
        for (const [key, value] of request.headers) headerBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        if (headerBytes > 8192) throw new AccountError("REQUEST_HEADERS_TOO_LARGE", 431);
        if (context?.peerAddress) {
          if (!isIP(context.peerAddress)) throw new AccountError("INVALID_INPUT", 400);
          ingress(`peer:${context.peerAddress}`);
        }
        const url = new URL(request.url);
        if (url.origin !== config.baseURL || url.href.length > 8192) throw new AccountError("INVALID_INPUT", 400);
        const path = url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : "";
        const privateRoute = privateRoutes.get(url.pathname);
        const method = privateRoute?.method ?? routes[path];
        if (!method) throw new AccountError("NOT_FOUND", 404);
        if ((origin !== null && !config.trustedOrigins.includes(origin)) || (request.method !== "GET" && !origin)) throw new AccountError("PERMISSION_DENIED", 403);
        if (request.method === "OPTIONS") {
          if (request.headers.get("access-control-request-method") !== method ||
              (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").some((value) => value.trim() && value.trim() !== "content-type")) throw new AccountError("PERMISSION_DENIED", 403);
          return new Response(null, { status: 204, headers: { "access-control-allow-methods": method, "access-control-allow-headers": "Content-Type" } });
        }
        if (request.method !== method) throw new AccountError("NOT_FOUND", 404);
        for (const key of ["callbackURL", "redirectTo"]) for (const value of url.searchParams.getAll(key)) {
          if (!config.returnURLs.includes(value)) throw new AccountError("INVALID_INPUT", 400);
        }
        let forwarded = request;
        let body: Record<string, unknown> | undefined;
        if (request.method === "POST") {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new AccountError("UNSUPPORTED_MEDIA_TYPE", 415);
          const declaredLength = request.headers.get("content-length");
          if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 65536)) throw new AccountError("REQUEST_TOO_LARGE", 413);
          try {
            const parsed: unknown = JSON.parse(await readBoundedBody(request.body));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            body = parsed as Record<string, unknown>;
          } catch (error) { if (error instanceof AccountError) throw error; throw new AccountError("INVALID_INPUT", 400); }
          if (!privateRoute) {
            for (const [key, value] of Object.entries(body)) {
              if (typeof value !== "string" && typeof value !== "boolean") throw new AccountError("INVALID_INPUT", 400);
              const maximum = key === "password" || key === "newPassword" ? 128 : key === "email" ? 254 : key === "name" ? 100 : 4096;
              if (typeof value === "string" && value.length > maximum) throw new AccountError("INVALID_INPUT", 400);
            }
            for (const key of ["callbackURL", "redirectTo"]) {
              if (body[key] !== undefined && !config.returnURLs.includes(String(body[key]))) throw new AccountError("INVALID_INPUT", 400);
            }
            if (path === "/sign-up/email" || path === "/send-verification-email") body.callbackURL ??= config.returnURLs[0]!;
            if (path === "/request-password-reset") body.redirectTo ??= config.returnURLs[0]!;
            if (body.rememberMe === false) throw new AccountError("INVALID_INPUT", 400);
            if (["/sign-up/email", "/sign-in/email", "/request-password-reset", "/send-verification-email"].includes(path) && typeof body.email === "string") {
              const accountKey = createHmac("sha256", config.secret).update(body.email.toLowerCase()).digest("hex");
              sensitive(`auth:${path}:${accountKey}`);
            }
            const headers = new Headers(request.headers);
            headers.delete("content-length");
            forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
          }
        }
        return serial(async () => {
          await ensureInitialReadiness();
          if (privateRoute) {
            const account = await requireAccount(request);
            const result = await privateRoute.handle({ request, body, account, verifyPassword: (password) => verifyPassword(request, password),
              ...(identities ? { identity: { getOrCreate: () => identities!.getOrCreate(account.user.id), withSecret: <T>(use: (secret: Uint8Array) => T | Promise<T>) => identities!.withSecret(account.user.id, use) } } : {}),
            });
            let text: string;
            try { text = await readBoundedBody(result.body, 131072); }
            catch { throw new AccountError("TEMPORARILY_UNAVAILABLE", 503); }
            return new Response(text || null, { status: result.status, headers: copyHeaders(result.headers) });
          }
          if (path === "/sign-up/email" && identities) await identities.assertProvisioningReady();
          const native = await auth.handler(forwarded);
          if (native.status >= 400) {
            const json = await readBoundedBody(native.body);
            let code: string | undefined;
            try { code = (JSON.parse(json) as { code?: string }).code; } catch { /* Do not expose dependency errors. */ }
            const mapped = code === "EMAIL_NOT_VERIFIED" ? new AccountError("EMAIL_UNVERIFIED", 403) :
              native.status === 401 ? new AccountError("UNAUTHENTICATED", 401) :
              native.status === 403 ? new AccountError("PERMISSION_DENIED", 403) :
              native.status >= 500 ? new AccountError("TEMPORARILY_UNAVAILABLE", 503) : new AccountError("INVALID_INPUT", 400);
            const safe = errorResponse(mapped);
            copyCookies(native.headers, safe.headers);
            return safe;
          }
          if (genericRoutes.has(path)) {
            void native.body?.cancel().catch(() => {});
            const safe = Response.json({ accepted: true }, { status: 202 });
            copyCookies(native.headers, safe.headers);
            return safe;
          }
          if (native.status >= 200 && native.status < 300 && native.headers.get("content-type")?.includes("application/json")) {
            const data = JSON.parse(await readBoundedBody(native.body)) as Record<string, unknown> | null;
            if (data && typeof data === "object") {
              delete data.token;
              if (data.session && typeof data.session === "object") delete (data.session as Record<string, unknown>).token;
            }
            const safe = Response.json(data, { status: native.status, headers: copyHeaders(native.headers) });
            return safe;
          }
          return new Response(native.body, { status: native.status, headers: copyHeaders(native.headers) });
        });
      }), 15000);
    } catch (error) { response = errorResponse(error); }
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.append("vary", "Origin");
    if (origin && config.trustedOrigins.includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("access-control-allow-credentials", "true");
    }
    return response;
  };

  return {
    handler,
    /** Full cryptographic reconciliation before accepting transport traffic/after restore. */
    ready: () => serial(async () => { await identities?.assertReady(); initialReadiness = Promise.resolve(); }),
    requireAccount: (request: Request) => serial(() => requireAccount(request)),
    verifyPassword: (request: Request, password: string) => serial(() => verifyPassword(request, password)),
    close() { db.close(); },
  };
}

function copyCookies(source: Headers, target: Headers) {
  for (const value of source.getSetCookie()) target.append("set-cookie", value);
}
function copyHeaders(source: Headers): Headers {
  const target = new Headers(source);
  target.delete("set-cookie"); target.delete("content-length");
  copyCookies(source, target);
  return target;
}
