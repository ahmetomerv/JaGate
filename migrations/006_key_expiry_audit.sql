ALTER TABLE client_keys ADD COLUMN expires_at TEXT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'key.issued', 'key.revoked', 'request.created', 'execution.claimed',
    'execution.succeeded', 'execution.failed'
  )),
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('bootstrap', 'issued_key')),
  actor_key_id TEXT,
  request_id TEXT,
  subject_key_id TEXT,
  CHECK ((actor = 'bootstrap' AND actor_key_id IS NULL) OR (actor = 'issued_key' AND actor_key_id IS NOT NULL)),
  CHECK ((type IN ('key.issued', 'key.revoked') AND actor = 'bootstrap' AND request_id IS NULL AND subject_key_id IS NOT NULL)
    OR (type IN ('request.created', 'execution.claimed', 'execution.succeeded', 'execution.failed')
      AND request_id IS NOT NULL AND subject_key_id IS NULL))
);
CREATE INDEX audit_events_client_id ON audit_events(client_id, id DESC);
