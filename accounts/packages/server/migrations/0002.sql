-- Reviewed custody schema for explicit fresh initialization only.
DROP TABLE account_schema;
CREATE TABLE account_schema (version INTEGER NOT NULL CHECK (version = 2));
INSERT INTO account_schema VALUES (2);
CREATE TABLE custody_installation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installation_id TEXT NOT NULL UNIQUE
);
CREATE TABLE identity_assignment (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  inventory_committed INTEGER NOT NULL DEFAULT 0 CHECK (inventory_committed IN (0, 1))
);
CREATE TABLE author_identity (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  encrypted_secret TEXT NOT NULL
);
