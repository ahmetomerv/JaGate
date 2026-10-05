CREATE TABLE client_keys (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX client_keys_client_created ON client_keys(client_id, created_at DESC, id DESC);
