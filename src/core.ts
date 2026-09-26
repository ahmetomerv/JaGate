import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './storage.js';
import { GatewayError } from './errors.js';
import { canonicalContent, hash, type CreateInput, type DecisionStatus, type RequestView } from './model.js';

type Row = {
  id: string; client_id: string; idempotency_key: string; fingerprint: string; action: string; title: string;
  description: string; details_json: string; metadata_json: string; created_at: string; expires_at: string;
  decision_status: DecisionStatus; decided_by: string | null; decided_at: string | null;
  execution_status: RequestView['executionStatus']; claimed_at: string | null; claim_id: string | null;
  claim_token_hash: string | null; result_summary: string | null; result_at: string | null;
  delivery_status: RequestView['deliveryStatus']; delivery_attempts: number; next_delivery_at: string;
  delivery_error: string | null;
  callback_ref: string; delivery_message_id: string | null; delivery_chat_id: string | null;
};

export type DeliveryJob = { id: string; callbackRef: string; view: RequestView; attempts: number };

export class GatewayCore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  private iso(): string { return this.now().toISOString(); }
  private row(id: string): Row | undefined { return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined; }
  private view(row: Row): RequestView {
    return {
      id: row.id, clientId: row.client_id, action: row.action, title: row.title, description: row.description,
      details: JSON.parse(row.details_json) as RequestView['details'],
      metadata: JSON.parse(row.metadata_json) as RequestView['metadata'],
      createdAt: row.created_at, expiresAt: row.expires_at, status: row.decision_status,
      decidedBy: row.decided_by, decidedAt: row.decided_at, executionStatus: row.execution_status,
      claimedAt: row.claimed_at, resultSummary: row.result_summary, resultAt: row.result_at,
      deliveryStatus: row.delivery_status, deliveryAttempts: row.delivery_attempts, deliveryError: row.delivery_error,
    };
  }

  expire(): number {
    return this.db.prepare("UPDATE requests SET decision_status = 'expired', decided_at = ? WHERE decision_status = 'pending' AND expires_at <= ?")
      .run(this.iso(), this.iso()).changes;
  }

  create(clientId: string, input: CreateInput): { request: RequestView; created: boolean } {
    const content = canonicalContent(input);
    const fingerprint = hash(content);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM requests WHERE client_id = ? AND idempotency_key = ?').get(clientId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new GatewayError('idempotency_conflict', 409, 'idempotency key already belongs to different request content');
        this.expire();
        return { request: this.view(this.row(existing.id)!), created: false };
      }
      const id = randomUUID();
      const createdAt = this.iso();
      const expiresAt = new Date(this.now().getTime() + input.expiresInSeconds * 1000).toISOString();
      const ref = randomBytes(12).toString('base64url');
      this.db.prepare(`INSERT INTO requests
        (id,client_id,idempotency_key,fingerprint,content_json,action,title,description,details_json,metadata_json,created_at,expires_at,decision_status,execution_status,delivery_status,next_delivery_at,callback_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending','unclaimed','pending',?,?)`)
        .run(id,clientId,input.idempotencyKey,fingerprint,content,input.action,input.title,input.description,JSON.stringify(input.details),JSON.stringify(input.metadata),createdAt,expiresAt,createdAt,ref);
      return { request: this.view(this.row(id)!), created: true };
    })();
  }

  private getInternal(id: string): RequestView {
    this.expire();
    const row = this.row(id);
    if (!row) throw new GatewayError('not_found', 404, 'request not found');
    return this.view(row);
  }

  get(clientId: string, id: string): RequestView {
    this.expire();
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ? AND client_id = ?').get(id, clientId) as Row | undefined;
    if (!row) throw new GatewayError('not_found', 404, 'request not found');
    return this.view(row);
  }

  cancel(clientId: string, id: string): RequestView {
    this.expire();
    const changed = this.db.prepare("UPDATE requests SET decision_status = 'cancelled', decided_at = ? WHERE id = ? AND client_id = ? AND decision_status = 'pending' AND expires_at > ?")
      .run(this.iso(), id, clientId, this.iso()).changes;
    if (!changed) { this.get(clientId, id); throw new GatewayError('invalid_state', 409, 'only a pending request can be cancelled'); }
    return this.get(clientId, id);
  }

  callbackClient(ref: string): string | undefined {
    return (this.db.prepare('SELECT client_id FROM requests WHERE callback_ref = ?').get(ref) as { client_id: string } | undefined)?.client_id;
  }

  decide(ref: string, chatId: string, messageId: string, actorId: string, decision: 'approved' | 'rejected'): { outcome: string; request?: RequestView } {
    this.expire();
    const row = this.db.prepare('SELECT * FROM requests WHERE callback_ref = ?').get(ref) as Row | undefined;
    if (!row || row.delivery_chat_id !== chatId || row.delivery_message_id !== messageId)
      return { outcome: 'This button does not belong to an active request message.' };
    const changed = this.db.prepare(`UPDATE requests SET decision_status = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND decision_status = 'pending' AND expires_at > ? AND delivery_status = 'delivered' AND delivery_chat_id = ? AND delivery_message_id = ?`)
      .run(decision, actorId, this.iso(), row.id, this.iso(), chatId, messageId).changes;
    const current = this.getInternal(row.id);
    return { outcome: changed ? (decision === 'approved' ? 'Approved.' : 'Rejected.') : `Already ${current.status}.`, request: current };
  }

  claim(clientId: string, id: string): { claimId: string; claimToken: string; request: RequestView } {
    this.expire();
    const claimId = randomUUID();
    const claimToken = randomBytes(32).toString('base64url');
    const changed = this.db.prepare(`UPDATE requests SET execution_status = 'claimed', claimed_at = ?, claim_id = ?, claim_token_hash = ?
      WHERE id = ? AND client_id = ? AND decision_status = 'approved' AND execution_status = 'unclaimed'`)
      .run(this.iso(), claimId, hash(claimToken), id, clientId).changes;
    if (!changed) { this.get(clientId, id); throw new GatewayError('not_claimable', 409, 'request is not approved and unclaimed'); }
    return { claimId, claimToken, request: this.get(clientId, id) };
  }

  report(clientId: string, id: string, token: string, status: 'succeeded' | 'failed', summary: string): RequestView {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ? AND client_id = ?').get(id, clientId) as Row | undefined;
    if (!row) throw new GatewayError('not_found', 404, 'request not found');
    const candidate = Buffer.from(hash(token), 'hex');
    const saved = Buffer.from(row.claim_token_hash ?? '0'.repeat(64), 'hex');
    if (!timingSafeEqual(candidate, saved) || !row.claim_token_hash) throw new GatewayError('invalid_claim_token', 403, 'invalid claim token');
    const changed = this.db.prepare(`UPDATE requests SET execution_status = ?, result_summary = ?, result_at = ?
      WHERE id = ? AND client_id = ? AND execution_status = 'claimed' AND claim_token_hash = ?`)
      .run(status, summary, this.iso(), id, clientId, row.claim_token_hash).changes;
    if (!changed) throw new GatewayError('invalid_state', 409, 'result already reported');
    return this.get(clientId, id);
  }

  dueDeliveries(limit = 10): DeliveryJob[] {
    this.expire();
    const rows = this.db.prepare(`SELECT * FROM requests WHERE decision_status = 'pending'
      AND delivery_status IN ('pending','retrying') AND next_delivery_at <= ? ORDER BY created_at LIMIT ?`)
      .all(this.iso(), limit) as Row[];
    return rows.map((r) => ({ id: r.id, callbackRef: r.callback_ref, view: this.view(r), attempts: r.delivery_attempts }));
  }

  deliverySucceeded(id: string, chatId: string, messageId: string): void {
    this.db.prepare(`UPDATE requests SET delivery_status = 'delivered', delivery_attempts = delivery_attempts + 1,
      delivery_chat_id = ?, delivery_message_id = ?, delivery_error = NULL
      WHERE id = ? AND delivery_status IN ('pending','retrying')`).run(chatId, messageId, id);
  }

  requeueMovedDestinations(destinations: ReadonlyMap<string, string>): number {
    return this.db.transaction(() => {
      this.expire();
      const rows = this.db.prepare(`SELECT id, client_id, delivery_chat_id FROM requests
        WHERE decision_status = 'pending' AND delivery_status = 'delivered'`).all() as Array<{ id: string; client_id: string; delivery_chat_id: string | null }>;
      let changed = 0;
      for (const row of rows) {
        const destination = destinations.get(row.client_id);
        if (!destination || destination === row.delivery_chat_id) continue;
        changed += this.db.prepare(`UPDATE requests SET delivery_status = 'pending', delivery_attempts = 0,
          next_delivery_at = ?, delivery_error = NULL, delivery_chat_id = NULL, delivery_message_id = NULL, callback_ref = ?
          WHERE id = ? AND decision_status = 'pending' AND delivery_status = 'delivered'`)
          .run(this.iso(), randomBytes(12).toString('base64url'), row.id).changes;
      }
      return changed;
    })();
  }

  deliveryFailed(id: string, retryable: boolean, reason: string): void {
    const row = this.row(id);
    if (!row || !['pending', 'retrying'].includes(row.delivery_status)) return;
    const attempts = row.delivery_attempts + 1;
    const retry = retryable && attempts < 5 && row.decision_status === 'pending' && row.expires_at > this.iso();
    const delay = Math.min(60_000, 2000 * 2 ** (attempts - 1));
    this.db.prepare(`UPDATE requests SET delivery_status = ?, delivery_attempts = ?, next_delivery_at = ?, delivery_error = ? WHERE id = ?`)
      .run(retry ? 'retrying' : 'failed', attempts, new Date(this.now().getTime() + delay).toISOString(), reason.slice(0, 160), id);
  }

  getOffset(): number { return Number((this.db.prepare("SELECT value FROM settings WHERE key = 'telegram_offset'").get() as { value: string } | undefined)?.value ?? 0); }
  saveOffset(offset: number): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES ('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER)").run(String(offset));
  }
  storageReady(): boolean { return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1; }
}
