import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createKeyEncryption } from "./key-encryption.ts";
import type { KeyEncryptionConfiguration } from "./key-encryption.ts";
import { withDeadline } from "./limits.ts";
import { MAIL_PURPOSE, MAX_MAIL_BYTES, validateMail } from "./mail.ts";
import type { AccountMail, MailAdapter } from "./mail.ts";

export interface MailOutboxConfiguration { maxMessages?: number; maxBytes?: number }
export interface MailOutboxStatus { queued: number; bytes: number; failed: number; leased: number; enqueueFailures: number; transportConfigured: boolean }
export interface MailOutboxWorker {
  /** Bounded batch, one provider call at a time. Transport failure is private retry state. */
  drain(): Promise<void>;
  /** Private operator diagnostics only. Never expose these counts to anonymous clients. */
  status(): MailOutboxStatus;
}
interface Row { id: string; payload: string; expires_at: number; attempts: number; lease_id: string }

export function createMailOutbox(db: Database.Database, encryptionConfig: KeyEncryptionConfiguration, serial: <T>(operation: () => Promise<T>) => Promise<T>,
  config: MailOutboxConfiguration = {}, transport?: MailAdapter, timeout = 5000) {
  const maxMessages = config.maxMessages ?? 1024, maxBytes = config.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000 || !Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16 * 1024 * 1024) throw new Error("Invalid mail outbox limits");
  const encryption = createKeyEncryption(encryptionConfig);
  let enqueueFailures = 0, active = false;
  const purge = () => db.prepare("DELETE FROM account_mail_outbox WHERE expires_at <= ?").run(Date.now());
  const totals = () => db.prepare("SELECT count(*) AS queued, coalesce(sum(payload_bytes), 0) AS bytes, coalesce(sum(last_error IN ('INVALID_PAYLOAD', 'ATTEMPTS_EXHAUSTED')), 0) AS failed, coalesce(sum(lease_until > ?), 0) AS leased FROM account_mail_outbox").get(Date.now()) as Omit<MailOutboxStatus, "enqueueFailures" | "transportConfigured">;
  const worker: MailOutboxWorker = {
    status: () => ({ ...totals(), enqueueFailures, transportConfigured: !!transport }),
    async drain() {
      if (active) return;
      active = true;
      const operation = (async () => {
        await serial(async () => { purge(); });
        if (!transport) return;
        for (let i = 0; i < 16; i++) {
          const row = await serial(async () => db.transaction(() => {
            purge();
            const now = Date.now();
            const next = db.prepare("SELECT * FROM account_mail_outbox WHERE available_at <= ? AND lease_until <= ? AND attempts < 5 AND (last_error IS NULL OR last_error = 'DELIVERY_FAILED') ORDER BY available_at, id LIMIT 1").get(now, now) as Row | undefined;
            if (!next) return;
            next.lease_id = randomUUID(); next.attempts++;
            db.prepare("UPDATE account_mail_outbox SET lease_id = ?, lease_until = ?, attempts = ? WHERE id = ?").run(next.lease_id, now + timeout + 1000, next.attempts, next.id);
            return next;
          })());
          if (!row) break;
          let message: AccountMail;
          try {
            const plaintext = await encryption.decrypt(row.payload, row.id, MAIL_PURPOSE);
            try {
              if (plaintext.byteLength > MAX_MAIL_BYTES) throw new Error("INVALID_MAIL");
              message = validateMail(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
              if (message.expiresAt !== row.expires_at) throw new Error("INVALID_MAIL");
            } finally { plaintext.fill(0); }
          } catch {
            await serial(async () => { db.prepare("UPDATE account_mail_outbox SET last_error = 'INVALID_PAYLOAD', lease_id = NULL, lease_until = 0 WHERE id = ? AND lease_id = ?").run(row.id, row.lease_id); });
            continue;
          }
          if (message.expiresAt <= Date.now()) {
            await serial(async () => { db.prepare("DELETE FROM account_mail_outbox WHERE id = ? AND lease_id = ?").run(row.id, row.lease_id); }); continue;
          }
          try {
            // No Promise.race here: an uncooperative provider retains the single slot.
            await transport.send(message, AbortSignal.timeout(Math.max(1, Math.min(timeout, message.expiresAt - Date.now()))));
            await serial(async () => { db.prepare("DELETE FROM account_mail_outbox WHERE id = ? AND lease_id = ?").run(row.id, row.lease_id); });
          } catch {
            await serial(async () => { db.prepare("UPDATE account_mail_outbox SET last_error = ?, available_at = ?, lease_id = NULL, lease_until = 0 WHERE id = ? AND lease_id = ?")
              .run(row.attempts >= 5 ? "ATTEMPTS_EXHAUSTED" : "DELIVERY_FAILED", Date.now() + Math.min(60000, 1000 * 2 ** (row.attempts - 1)), row.id, row.lease_id); });
          }
        }
      })().finally(() => { active = false; });
      // Callers regain control while a stuck adapter still occupies its slot.
      await withDeadline(operation, 16 * (timeout + 1000)).catch(() => {});
    },
  };
  return {
    worker,
    assertIdle() { if (active) throw new Error("Drain account mail before closing"); },
    /** Called within the account lifecycle gate. Local failures never reveal eligibility. */
    async enqueue(input: AccountMail): Promise<void> {
      try {
        const message = validateMail(input), id = randomUUID();
        const plaintext = Buffer.from(JSON.stringify(message));
        let payload: string;
        try {
          if (plaintext.byteLength > MAX_MAIL_BYTES) throw new Error("INVALID_MAIL");
          payload = await encryption.encrypt(plaintext, id, MAIL_PURPOSE);
        } finally { plaintext.fill(0); }
        const bytes = Buffer.byteLength(payload);
        db.transaction(() => {
          purge();
          const current = totals();
          if (current.queued >= maxMessages || current.bytes + bytes > maxBytes || message.expiresAt <= Date.now()) throw new Error("OUTBOX_UNAVAILABLE");
          db.prepare("INSERT INTO account_mail_outbox(id, payload, payload_bytes, expires_at, available_at) VALUES (?, ?, ?, ?, ?)").run(id, payload, bytes, message.expiresAt, Date.now());
        })();
      } catch { enqueueFailures = Math.min(Number.MAX_SAFE_INTEGER, enqueueFailures + 1); }
    },
  };
}
