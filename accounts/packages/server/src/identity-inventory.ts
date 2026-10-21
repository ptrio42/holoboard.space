import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { identityUnavailable } from "./key-encryption.ts";

export interface AssignmentRecord { version: 1; installationId: string; accountId: string; publicKey: string }
const manifestName = "installation.json";
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readPrivateJSON(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw identityUnavailable();
  return JSON.parse(readFileSync(path, "utf8"));
}
function filename(accountId: string): string { return `${Buffer.from(accountId).toString("base64url")}.json`; }
function matches(left: AssignmentRecord, right: AssignmentRecord): boolean {
  return left.version === right.version && left.installationId === right.installationId && left.accountId === right.accountId && left.publicKey === right.publicKey;
}
/** Atomic no-overwrite publication, durable before the caller may expose an identity. */
function persist(path: string, value: unknown): void {
  const directory = dirname(path), temporary = join(directory, `.pending-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Preserve the original error. */ }
  }
}
/** Explicit first-install operation. Never call as missing-storage recovery. */
export function initializeIdentityInventory(path: string, installationId: string): void {
  if (!installationId || installationId.length > 200) throw new Error("Invalid custody installation ID");
  mkdirSync(path, { mode: 0o700 });
  persist(join(path, manifestName), { version: 1, installationId });
  syncDirectory(dirname(path));
}
export function openIdentityInventory(path: string, installationId: string) {
  function records(): AssignmentRecord[] {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw identityUnavailable();
      const manifest = readPrivateJSON(join(path, manifestName)) as { version?: unknown; installationId?: unknown };
      if (manifest.version !== 1 || manifest.installationId !== installationId) throw identityUnavailable();
      const result: AssignmentRecord[] = [];
      for (const name of readdirSync(path)) {
        if (name === manifestName || /^\.pending-[a-f0-9-]+$/.test(name)) continue;
        const record = readPrivateJSON(join(path, name)) as AssignmentRecord;
        if (record.version !== 1 || record.installationId !== installationId || typeof record.accountId !== "string" || !record.accountId || Buffer.byteLength(record.accountId) > 120 || !/^[a-f0-9]{64}$/.test(record.publicKey) || filename(record.accountId) !== name) throw identityUnavailable();
        result.push(record);
      }
      return result;
    } catch { throw identityUnavailable(); }
  }
  records();
  return {
    records,
    persist(record: AssignmentRecord): void {
      try {
        const existing = records().find((item) => item.accountId === record.accountId);
        if (existing && !matches(existing, record)) throw identityUnavailable();
        const target = join(path, filename(record.accountId));
        if (!existing) {
          try { persist(target, record); }
          catch (error) {
            // Another writer may have published the identical committed assignment.
            if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
            const winner = readPrivateJSON(target) as AssignmentRecord;
            if (!matches(winner, record)) throw identityUnavailable();
          }
        }
        const fd = openSync(target, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(path);
      } catch { throw identityUnavailable(); }
    },
  };
}
