CREATE TABLE request_events (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL CHECK (type IN (
    'request.created', 'delivery.retry_scheduled', 'delivery.failed',
    'delivery.delivered', 'delivery.requeued', 'decision.approved', 'decision.rejected',
    'decision.expired', 'decision.cancelled', 'execution.claimed',
    'execution.succeeded', 'execution.failed'
  )),
  occurred_at TEXT NOT NULL,
  actor_id TEXT,
  attempt INTEGER CHECK (attempt IS NULL OR attempt > 0),
  PRIMARY KEY (request_id, sequence)
);
