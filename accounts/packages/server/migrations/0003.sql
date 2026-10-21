-- Reviewed durable encrypted mail schema. Applied only by explicit fresh initialization.
DROP TABLE account_schema;
CREATE TABLE account_schema (version INTEGER NOT NULL CHECK (version = 3));
INSERT INTO account_schema VALUES (3);
CREATE TABLE account_mail_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  expires_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT CHECK (last_error IN ('DELIVERY_FAILED', 'INVALID_PAYLOAD', 'ATTEMPTS_EXHAUSTED'))
);
CREATE INDEX account_mail_available ON account_mail_outbox(available_at);
