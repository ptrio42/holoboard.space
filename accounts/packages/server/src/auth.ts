import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import type Database from "better-sqlite3";
import { createCapacity, withDeadline } from "./limits.ts";

export interface AccountMail {
  kind: "verification" | "password-reset";
  email: string;
  url: string;
  token: string;
}
export interface MailAdapter {
  /** Keep message data private; respect the deadline and never log message contents. */
  send(message: AccountMail, signal: AbortSignal): Promise<void>;
}
export interface AuthConfiguration {
  baseURL: string;
  basePath?: string;
  secret: string;
  trustedOrigins: readonly string[];
  returnURLs: readonly string[];
  mail: MailAdapter;
  mailTimeoutMs?: number;
}

export function createAuthentication(config: AuthConfiguration, database: Database.Database): ReturnType<typeof betterAuth> {
  const hashCapacity = createCapacity(2);
  const mailCapacity = createCapacity(8);
  const send = async (message: AccountMail) => {
    const timeout = config.mailTimeoutMs ?? 5000;
    const signal = AbortSignal.timeout(timeout);
    await withDeadline(mailCapacity(() => config.mail.send(message, signal)), timeout);
  };
  return betterAuth<BetterAuthOptions>({
    baseURL: config.baseURL, basePath: config.basePath ?? "/v1/auth", secret: config.secret,
    trustedOrigins: [...config.trustedOrigins], database,
    logger: { disabled: true },
    // The outer limiter uses only trusted transport context, never forwarding headers.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: true,
      ipAddress: { disableIpTracking: true, ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    },
    session: { expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
    verification: { storeInDatabase: true },
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
        await send({ kind: "password-reset", email: user.email, token, url: target.href });
      },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url, token }) => send({ kind: "verification", email: user.email, url, token }),
    },
  });
}
