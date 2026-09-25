CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  content_json TEXT NOT NULL,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  details_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decision_status TEXT NOT NULL CHECK (decision_status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by TEXT,
  decided_at TEXT,
  execution_status TEXT NOT NULL DEFAULT 'unclaimed' CHECK (execution_status IN ('unclaimed','claimed','succeeded','failed')),
  claimed_at TEXT,
  claim_id TEXT,
  claim_token_hash TEXT,
  result_summary TEXT,
  result_at TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','retrying','delivered','failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_delivery_at TEXT NOT NULL,
  delivery_error TEXT,
  callback_ref TEXT NOT NULL UNIQUE,
  delivery_message_id TEXT,
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX requests_delivery ON requests(delivery_status, next_delivery_at);
CREATE INDEX requests_expiry ON requests(decision_status, expires_at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
