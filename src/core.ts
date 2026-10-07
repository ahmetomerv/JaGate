import type { AuditEvent, AuditEventType, ClientKeyScope, ClientKeyView, CreateInput, DecisionStatus, IssuedClientKey, ListAuditEventsPage, ListClientKeysPage, ListRequestsPage, ListRequestsQuery, RequestEvent, RequestEventsPage, RequestEventType, RequestView } from './model.js';
import type { Db } from './storage.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GatewayError } from './errors.js';
import {

  canonicalContent,

  hash,

} from './model.js';

interface Row {
  id: string;
  client_id: string;
  idempotency_key: string;
  fingerprint: string;
  action: string;
  title: string;
  description: string;
  details_json: string;
  metadata_json: string;
  created_at: string;
  expires_at: string;
  decision_status: DecisionStatus;
  decided_by: string | null;
  decided_at: string | null;
  execution_status: RequestView['executionStatus'];
  claimed_at: string | null;
  claim_id: string | null;
  claim_token_hash: string | null;
  result_summary: string | null;
  result_at: string | null;
  delivery_status: RequestView['deliveryStatus'];
  delivery_attempts: number;
  next_delivery_at: string;
  delivery_error: string | null;
  callback_ref: string;
  delivery_message_id: string | null;
  delivery_chat_id: string | null;
}

interface ClientKeyRow {
  id: string;
  client_id: string;
  label: string;
  key_hash: string;
  scopes_json: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}
interface AuditRow {
  id: number;
  type: AuditEventType;
  occurred_at: string;
  actor: AuditEvent['actor'];
  actor_key_id: string | null;
  request_id: string | null;
  subject_key_id: string | null;
}

export interface DeliveryJob { id: string; callbackRef: string; view: RequestView; attempts: number }

export class GatewayCore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
  }

  private keyView(row: ClientKeyRow): ClientKeyView {
    return {
      id: row.id,
      clientId: row.client_id,
      label: row.label,
      scopes: JSON.parse(row.scopes_json) as ClientKeyScope[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  private appendAudit(
    clientId: string,
    type: AuditEventType,
    actorKeyId: string | null,
    requestId: string | null = null,
    subjectKeyId: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(client_id,type,occurred_at,actor,actor_key_id,request_id,subject_key_id)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        clientId,
        type,
        this.iso(),
        actorKeyId === null ? 'bootstrap' : 'issued_key',
        actorKeyId,
        requestId,
        subjectKeyId,
      );
  }

  listAuditEvents(
    clientId: string,
    options: { limit: number; before?: number; requestId?: string; keyId?: string },
  ): ListAuditEventsPage {
    const conditions = ['client_id = ?'];
    const values: Array<string | number> = [clientId];
    if (options.before !== undefined) {
      conditions.push('id < ?');
      values.push(options.before);
    }
    if (options.requestId) {
      conditions.push('request_id = ?');
      values.push(options.requestId);
    }
    if (options.keyId) {
      conditions.push('(actor_key_id = ? OR subject_key_id = ?)');
      values.push(options.keyId, options.keyId);
    }
    const rows = this.db
      .prepare(
        `SELECT id,type,occurred_at,actor,actor_key_id,request_id,subject_key_id
      FROM audit_events WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      )
      .all(...values, options.limit + 1) as AuditRow[];
    const page = rows.slice(0, options.limit);
    return {
      items: page.map(row => ({
        id: row.id,
        type: row.type,
        occurredAt: row.occurred_at,
        actor: row.actor,
        actorKeyId: row.actor_key_id,
        requestId: row.request_id,
        subjectKeyId: row.subject_key_id,
      })),
      nextCursor: rows.length > options.limit ? String(page.at(-1)!.id) : null,
    };
  }

  authenticateClientKey(
    key: string,
  ): { id: string; clientId: string; scopes: ClientKeyScope[] } | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM client_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
      )
      .get(hash(key), this.iso()) as ClientKeyRow | undefined;
    return row
      ? { id: row.id, clientId: row.client_id, scopes: this.keyView(row).scopes }
      : undefined;
  }

  issueClientKey(
    clientId: string,
    label: string,
    scopes: ClientKeyScope[],
    expiresAt?: string,
  ): IssuedClientKey {
    const id = randomUUID();
    const key = `jgk_${randomBytes(32).toString('base64url')}`;
    const now = this.iso();
    if (expiresAt !== undefined && expiresAt <= now)
      throw new GatewayError('invalid_input', 400, 'key expiry must be in the future');
    return this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO client_keys(id,client_id,label,key_hash,scopes_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, clientId, label, hash(key), JSON.stringify(scopes), now, expiresAt ?? null);
      this.appendAudit(clientId, 'key.issued', null, null, id);
      return {
        id,
        clientId,
        label,
        scopes,
        createdAt: now,
        expiresAt: expiresAt ?? null,
        revokedAt: null,
        key,
      };
    })();
  }

  listClientKeys(
    clientId: string,
    options: { limit: number; before?: { createdAt: string; id: string } },
  ): ListClientKeysPage {
    const limit = options.limit;
    const rows = options.before
      ? (this.db
          .prepare(
            `SELECT * FROM client_keys WHERE client_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(
            clientId,
            options.before.createdAt,
            options.before.createdAt,
            options.before.id,
            limit + 1,
          ) as ClientKeyRow[])
      : (this.db
          .prepare(
            'SELECT * FROM client_keys WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          )
          .all(clientId, limit + 1) as ClientKeyRow[]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(row => this.keyView(row)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
          : null,
    };
  }

  revokeClientKey(clientId: string, id: string): ClientKeyView {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          'UPDATE client_keys SET revoked_at = ? WHERE id = ? AND client_id = ? AND revoked_at IS NULL',
        )
        .run(this.iso(), id, clientId)
        .changes;
      const row = this.db
        .prepare('SELECT * FROM client_keys WHERE id = ? AND client_id = ?')
        .get(id, clientId) as ClientKeyRow | undefined;
      if (!row)
        throw new GatewayError('not_found', 404, 'client key not found');
      if (changed)
        this.appendAudit(clientId, 'key.revoked', null, null, id);
      return this.keyView(row);
    })();
  }

  private appendEvent(
    id: string,
    type: RequestEventType,
    occurredAt: string,
    actorId: string | null = null,
    attempt: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO request_events(request_id, sequence, type, occurred_at, actor_id, attempt)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ? FROM request_events WHERE request_id = ?`,
      )
      .run(id, type, occurredAt, actorId, attempt, id);
  }

  private view(row: Row): RequestView {
    return {
      id: row.id,
      clientId: row.client_id,
      action: row.action,
      title: row.title,
      description: row.description,
      details: JSON.parse(row.details_json) as RequestView['details'],
      metadata: JSON.parse(row.metadata_json) as RequestView['metadata'],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.decision_status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      executionStatus: row.execution_status,
      claimedAt: row.claimed_at,
      resultSummary: row.result_summary,
      resultAt: row.result_at,
      deliveryStatus: row.delivery_status,
      deliveryAttempts: row.delivery_attempts,
      deliveryError: row.delivery_error,
    };
  }

  expire(): number {
    return this.db.transaction(() => {
      const now = this.iso();
      const rows = this.db
        .prepare(
          'UPDATE requests SET decision_status = \'expired\', decided_at = ? WHERE decision_status = \'pending\' AND expires_at <= ? RETURNING id',
        )
        .all(now, now) as Array<{ id: string }>;
      for (const row of rows) this.appendEvent(row.id, 'decision.expired', now);
      return rows.length;
    })();
  }

  create(
    clientId: string,
    input: CreateInput,
    actorKeyId: string | null = null,
  ): { request: RequestView; created: boolean } {
    const content = canonicalContent(input);
    const fingerprint = hash(content);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM requests WHERE client_id = ? AND idempotency_key = ?')
        .get(clientId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new GatewayError(
            'idempotency_conflict',
            409,
            'idempotency key already belongs to different request content',
          );
        }
        this.expire();
        return { request: this.view(this.row(existing.id)!), created: false };
      }
      const id = randomUUID();
      const createdAt = this.iso();
      const expiresAt = new Date(
        this.now().getTime() + input.expiresInSeconds * 1000,
      ).toISOString();
      const ref = randomBytes(12).toString('base64url');
      this.db
        .prepare(
          `INSERT INTO requests
        (id,client_id,idempotency_key,fingerprint,content_json,action,title,description,details_json,metadata_json,created_at,expires_at,decision_status,execution_status,delivery_status,next_delivery_at,callback_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending','unclaimed','pending',?,?)`,
        )
        .run(
          id,
          clientId,
          input.idempotencyKey,
          fingerprint,
          content,
          input.action,
          input.title,
          input.description,
          JSON.stringify(input.details),
          JSON.stringify(input.metadata),
          createdAt,
          expiresAt,
          createdAt,
          ref,
        );
      this.appendEvent(id, 'request.created', createdAt);
      this.appendAudit(clientId, 'request.created', actorKeyId, id);
      return { request: this.view(this.row(id)!), created: true };
    })();
  }

  private getInternal(id: string): RequestView {
    this.expire();
    const row = this.row(id);
    if (!row)
      throw new GatewayError('not_found', 404, 'request not found');
    return this.view(row);
  }

  get(clientId: string, id: string): RequestView {
    this.expire();
    const row = this.db
      .prepare('SELECT * FROM requests WHERE id = ? AND client_id = ?')
      .get(id, clientId) as Row | undefined;
    if (!row)
      throw new GatewayError('not_found', 404, 'request not found');
    return this.view(row);
  }

  events(
    clientId: string,
    id: string,
    options: { limit?: number; after?: number },
  ): RequestEventsPage {
    this.get(clientId, id);
    const limit = options.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT sequence, type, occurred_at, actor_id, attempt FROM request_events
      WHERE request_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      )
      .all(id, options.after ?? 0, limit + 1) as Array<{
      sequence: number;
      type: RequestEventType;
      occurred_at: string;
      actor_id: string | null;
      attempt: number | null;
    }>;
    const page = rows.slice(0, limit);
    const items: RequestEvent[] = page.map(row => ({
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      actorId: row.actor_id,
      attempt: row.attempt,
    }));
    return { items, nextCursor: rows.length > limit ? String(page.at(-1)!.sequence) : null };
  }

  list(
    clientId: string,
    options: Omit<ListRequestsQuery, 'cursor'> & { before?: { createdAt: string; id: string } },
  ): ListRequestsPage {
    this.expire();
    const conditions = ['client_id = ?'];
    const values: Array<string | number> = [clientId];
    if (options.status) {
      conditions.push('decision_status = ?');
      values.push(options.status);
    }
    if (options.deliveryStatus) {
      conditions.push('delivery_status = ?');
      values.push(options.deliveryStatus);
    }
    if (options.executionStatus) {
      conditions.push('execution_status = ?');
      values.push(options.executionStatus);
    }
    if (options.claimedBefore) {
      conditions.push('claimed_at < ?');
      values.push(options.claimedBefore);
    }
    if (options.expiresBefore) {
      conditions.push('expires_at < ?');
      values.push(options.expiresBefore);
    }
    if (options.before) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      values.push(options.before.createdAt, options.before.createdAt, options.before.id);
    }
    const limit = options.limit ?? 20;
    const rows = this.db
      .prepare(
        `SELECT * FROM requests WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...values, limit + 1) as Row[];
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(row => this.view(row)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
          : null,
    };
  }

  cancel(clientId: string, id: string): RequestView {
    this.expire();
    return this.db.transaction(() => {
      const now = this.iso();
      const changed = this.db
        .prepare(
          'UPDATE requests SET decision_status = \'cancelled\', decided_at = ? WHERE id = ? AND client_id = ? AND decision_status = \'pending\' AND expires_at > ?',
        )
        .run(now, id, clientId, now)
        .changes;
      if (!changed) {
        this.get(clientId, id);
        throw new GatewayError('invalid_state', 409, 'only a pending request can be cancelled');
      }
      this.appendEvent(id, 'decision.cancelled', now);
      return this.get(clientId, id);
    })();
  }

  callbackClient(ref: string): string | undefined {
    return (
      this.db.prepare('SELECT client_id FROM requests WHERE callback_ref = ?').get(ref) as
        { client_id: string } | undefined
    )?.client_id;
  }

  decide(
    ref: string,
    chatId: string,
    messageId: string,
    actorId: string,
    decision: 'approved' | 'rejected',
  ): { outcome: string; request?: RequestView } {
    this.expire();
    const row = this.db.prepare('SELECT * FROM requests WHERE callback_ref = ?').get(ref) as
      Row | undefined;
    if (!row || row.delivery_chat_id !== chatId || row.delivery_message_id !== messageId)
      return { outcome: 'This button does not belong to an active request message.' };
    return this.db.transaction(() => {
      const now = this.iso();
      const changed = this.db
        .prepare(
          `UPDATE requests SET decision_status = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND decision_status = 'pending' AND expires_at > ? AND delivery_status = 'delivered' AND delivery_chat_id = ? AND delivery_message_id = ?`,
        )
        .run(decision, actorId, now, row.id, now, chatId, messageId)
        .changes;
      if (changed)
        this.appendEvent(row.id, `decision.${decision}`, now, actorId);
      const current = this.getInternal(row.id);
      return {
        outcome: changed
          ? decision === 'approved'
            ? 'Approved.'
            : 'Rejected.'
          : `Already ${current.status}.`,
        request: current,
      };
    })();
  }

  claim(
    clientId: string,
    id: string,
    actorKeyId: string | null = null,
  ): { claimId: string; claimToken: string; request: RequestView } {
    this.expire();
    const claimId = randomUUID();
    const claimToken = randomBytes(32).toString('base64url');
    return this.db.transaction(() => {
      const now = this.iso();
      const changed = this.db
        .prepare(
          `UPDATE requests SET execution_status = 'claimed', claimed_at = ?, claim_id = ?, claim_token_hash = ?
        WHERE id = ? AND client_id = ? AND decision_status = 'approved' AND execution_status = 'unclaimed'`,
        )
        .run(now, claimId, hash(claimToken), id, clientId)
        .changes;
      if (!changed) {
        this.get(clientId, id);
        throw new GatewayError('not_claimable', 409, 'request is not approved and unclaimed');
      }
      this.appendEvent(id, 'execution.claimed', now);
      this.appendAudit(clientId, 'execution.claimed', actorKeyId, id);
      return { claimId, claimToken, request: this.get(clientId, id) };
    })();
  }

  report(
    clientId: string,
    id: string,
    token: string,
    status: 'succeeded' | 'failed',
    summary: string,
    actorKeyId: string | null = null,
  ): RequestView {
    const row = this.db
      .prepare('SELECT * FROM requests WHERE id = ? AND client_id = ?')
      .get(id, clientId) as Row | undefined;
    if (!row)
      throw new GatewayError('not_found', 404, 'request not found');
    const candidate = Buffer.from(hash(token), 'hex');
    const saved = Buffer.from(row.claim_token_hash ?? '0'.repeat(64), 'hex');
    if (!timingSafeEqual(candidate, saved) || !row.claim_token_hash)
      throw new GatewayError('invalid_claim_token', 403, 'invalid claim token');
    return this.db.transaction(() => {
      const now = this.iso();
      const changed = this.db
        .prepare(
          `UPDATE requests SET execution_status = ?, result_summary = ?, result_at = ?
        WHERE id = ? AND client_id = ? AND execution_status = 'claimed' AND claim_token_hash = ?`,
        )
        .run(status, summary, now, id, clientId, row.claim_token_hash)
        .changes;
      if (!changed)
        throw new GatewayError('invalid_state', 409, 'result already reported');
      this.appendEvent(id, `execution.${status}`, now);
      this.appendAudit(clientId, `execution.${status}`, actorKeyId, id);
      return this.get(clientId, id);
    })();
  }

  dueDeliveries(limit = 10): DeliveryJob[] {
    this.expire();
    const rows = this.db
      .prepare(
        `SELECT * FROM requests WHERE decision_status = 'pending'
      AND delivery_status IN ('pending','retrying') AND next_delivery_at <= ? ORDER BY created_at LIMIT ?`,
      )
      .all(this.iso(), limit) as Row[];
    return rows.map(r => ({
      id: r.id,
      callbackRef: r.callback_ref,
      view: this.view(r),
      attempts: r.delivery_attempts,
    }));
  }

  deliverySucceeded(id: string, chatId: string, messageId: string): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE requests SET delivery_status = 'delivered', delivery_attempts = delivery_attempts + 1,
        delivery_chat_id = ?, delivery_message_id = ?, delivery_error = NULL
        WHERE id = ? AND delivery_status IN ('pending','retrying') RETURNING delivery_attempts`,
        )
        .get(chatId, messageId, id) as { delivery_attempts: number } | undefined;
      if (row)
        this.appendEvent(id, 'delivery.delivered', this.iso(), null, row.delivery_attempts);
    })();
  }

  requeueMovedDestinations(destinations: ReadonlyMap<string, string>): number {
    return this.db.transaction(() => {
      this.expire();
      const rows = this.db
        .prepare(
          `SELECT id, client_id, delivery_chat_id FROM requests
        WHERE decision_status = 'pending' AND delivery_status = 'delivered'`,
        )
        .all() as Array<{ id: string; client_id: string; delivery_chat_id: string | null }>;
      let changed = 0;
      for (const row of rows) {
        const destination = destinations.get(row.client_id);
        if (!destination || destination === row.delivery_chat_id)
          continue;
        const updated = this.db
          .prepare(
            `UPDATE requests SET delivery_status = 'pending', delivery_attempts = 0,
          next_delivery_at = ?, delivery_error = NULL, delivery_chat_id = NULL, delivery_message_id = NULL, callback_ref = ?
          WHERE id = ? AND decision_status = 'pending' AND delivery_status = 'delivered'`,
          )
          .run(this.iso(), randomBytes(12).toString('base64url'), row.id)
          .changes;
        if (updated)
          this.appendEvent(row.id, 'delivery.requeued', this.iso());
        changed += updated;
      }
      return changed;
    })();
  }

  deliveryFailed(id: string, retryable: boolean, reason: string): void {
    this.db.transaction(() => {
      const row = this.row(id);
      if (!row || !['pending', 'retrying'].includes(row.delivery_status))
        return;
      const now = this.iso();
      const attempts = row.delivery_attempts + 1;
      const retry
        = retryable && attempts < 5 && row.decision_status === 'pending' && row.expires_at > now;
      const delay = Math.min(60_000, 2000 * 2 ** (attempts - 1));
      this.db
        .prepare(
          `UPDATE requests SET delivery_status = ?, delivery_attempts = ?, next_delivery_at = ?, delivery_error = ? WHERE id = ?`,
        )
        .run(
          retry ? 'retrying' : 'failed',
          attempts,
          new Date(this.now().getTime() + delay).toISOString(),
          reason.slice(0, 160),
          id,
        );
      this.appendEvent(
        id,
        retry ? 'delivery.retry_scheduled' : 'delivery.failed',
        now,
        null,
        attempts,
      );
    })();
  }

  getOffset(): number {
    return Number(
      (
        this.db.prepare('SELECT value FROM settings WHERE key = \'telegram_offset\'').get() as
          { value: string } | undefined
      )?.value ?? 0,
    );
  }

  saveOffset(offset: number): void {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES (\'telegram_offset\',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER)',
      )
      .run(String(offset));
  }

  storageReady(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }
}
