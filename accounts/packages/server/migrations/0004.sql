-- Explicit fresh initialization only. Existing installations require reviewed maintenance.
DROP TABLE account_schema;
CREATE TABLE account_schema (version INTEGER NOT NULL CHECK (version = 4));
INSERT INTO account_schema VALUES (4);
CREATE TABLE account_auth_secret_history (fingerprint TEXT PRIMARY KEY NOT NULL);
CREATE TABLE account_restore (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  auth_fingerprint TEXT NOT NULL,
  quarantined INTEGER NOT NULL CHECK (quarantined IN (0, 1))
);
