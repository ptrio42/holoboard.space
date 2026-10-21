CREATE TABLE account_schema (version INTEGER NOT NULL CHECK (version = 1));
INSERT INTO account_schema VALUES (1);
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL, expiresAt INTEGER NOT NULL, token TEXT UNIQUE NOT NULL,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_userId ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT,
  accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  UNIQUE(providerId, accountId)
);
CREATE INDEX account_userId ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX verification_identifier ON verification(identifier);
