import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

/** Explicit first-install operation. Existing files are never migrated or replaced. */
export function initializeAccountDatabase(path: string): void {
  closeSync(openSync(path, "wx", 0o600));
  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    db.pragma("foreign_keys = ON");
    const sql = readFileSync(new URL("../migrations/0001.sql", import.meta.url), "utf8");
    db.transaction(() => db!.exec(sql))();
  } catch (error) {
    db?.close();
    unlinkSync(path);
    throw error;
  } finally { if (db?.open) db.close(); }
}

export function openAccountDatabase(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true, timeout: 1000 });
  try {
    db.pragma("foreign_keys = ON");
    const row = db.prepare("SELECT version FROM account_schema").get() as { version?: number } | undefined;
    if (row?.version !== 1) throw new Error("Unsupported account database schema");
    return db;
  } catch (error) { db.close(); throw error; }
}
