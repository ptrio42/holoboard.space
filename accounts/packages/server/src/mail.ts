export interface AccountMail {
  kind: "verification" | "password-reset";
  email: string;
  url: string;
  token: string;
  expiresAt: number;
}
export interface MailAdapter {
  /** Private data. Honor cancellation; never log recipients, links or provider errors. */
  send(message: AccountMail, signal: AbortSignal): Promise<void>;
}
export const MAIL_PURPOSE = "account-mail";
export const MAX_MAIL_BYTES = 16384;

export function validateMail(value: unknown): AccountMail {
  if (!value || typeof value !== "object") throw new Error("INVALID_MAIL");
  const mail = value as AccountMail;
  if (!["verification", "password-reset"].includes(mail.kind) || typeof mail.email !== "string" || !mail.email || mail.email.length > 254 ||
      typeof mail.url !== "string" || mail.url.length > 8192 || typeof mail.token !== "string" || !mail.token || mail.token.length > 4096 ||
      !Number.isSafeInteger(mail.expiresAt) || mail.expiresAt <= 0 || new URL(mail.url).protocol !== "https:") throw new Error("INVALID_MAIL");
  return mail;
}
