import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { decodeJwt } from "jose";
import type { AccountMail, MailAdapter } from "./mail.ts";
export type { AccountMail, MailAdapter } from "./mail.ts";
import type { BetterAuthOptions } from "better-auth";
import type Database from "better-sqlite3";
import { createCapacity, withDeadline } from "./limits.ts";

export interface AuthConfiguration {
  baseURL: string;
  basePath?: string;
  secret: string;
  trustedOrigins: readonly string[];
  returnURLs: readonly string[];
  mail?: MailAdapter;
  mailTimeoutMs?: number;
}

export function createAuthentication(config: AuthConfiguration, database: Database.Database, enqueue?: (message: AccountMail) => Promise<void>): ReturnType<typeof betterAuth> {
  const hashCapacity = createCapacity(2);
  const mailCapacity = createCapacity(8);
  const scheduleDelivery = async (message: AccountMail): Promise<void> => {
    if (enqueue) { await enqueue(message); return; }
    if (!config.mail) return;
    const mail = config.mail;
    const timeout = config.mailTimeoutMs ?? 5000;
    const signal = AbortSignal.timeout(timeout);
    // Auth-only compatibility mode. Full custody uses awaited local enqueue above.
    // Provider completion never participates in the public authentication response.
    void withDeadline(mailCapacity(() => mail.send(message, signal)), timeout).catch(() => {
      // Provider errors and capacity/deadline failures must not expose eligibility or mail data.
    });
  };
  const auth = betterAuth<BetterAuthOptions>({
    baseURL: config.baseURL, basePath: config.basePath ?? "/v1/auth", secret: config.secret,
    trustedOrigins: [...config.trustedOrigins], database,
    logger: { disabled: true },
    // Unknown failures must reach our sanitized boundary, not the router console fallback.
    onAPIError: { throw: true },
    // The outer limiter uses only trusted transport context, never forwarding headers.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: true,
      ipAddress: { disableIpTracking: true, ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    },
    session: { expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
    verification: { storeInDatabase: true, storeIdentifier: "hashed" },
    emailAndPassword: {
      enabled: true, autoSignIn: false, requireEmailVerification: true,
      minPasswordLength: 12, maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 3600,
      password: {
        hash: (password) => hashCapacity(() => hash(password, {
          algorithm: 2, version: 1, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32,
        })),
        verify: ({ hash: encoded, password }) => hashCapacity(() => verify(encoded, password)),
      },
      sendResetPassword: async ({ user, token, url }) => {
        const callback = new URL(url).searchParams.get("callbackURL");
        const target = new URL(callback && config.returnURLs.includes(callback) ? callback : config.returnURLs[0]!);
        target.searchParams.set("token", token);
        // Reuse the pinned native identifier hashing and its exact persisted expiry.
        const stored = await (await auth.$context).internalAdapter.findVerificationValue(`reset-password:${token}`);
        if (!stored) return;
        await scheduleDelivery({ kind: "password-reset", email: user.email, token, url: target.href, expiresAt: stored.expiresAt.getTime() });
      },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url, token }) => scheduleDelivery({ kind: "verification", email: user.email, url, token, expiresAt: decodeJwt(token).exp! * 1000 }),
    },
  });
  return auth;
}
