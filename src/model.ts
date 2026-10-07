import { createHash } from 'node:crypto';
import { z } from 'zod';

function text(max: number): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      // The class is the ASCII controls this field rejects.
      // eslint-disable-next-line no-control-regex
      s => !/[\u0000-\u0008\v\f\u000E-\u001F]/.test(s),
      'control characters are not allowed',
    );
}
const detailSchema = z.object({ label: text(40), value: text(160) }).strict();
export type JsonValue
  = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

export const createSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z0-9][\w.:=-]*$/i),
    action: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9._-]*$/),
    title: text(100),
    description: text(1000),
    details: z.array(detailSchema).max(10).default([]),
    expiresInSeconds: z.number().int().min(60).max(86400),
    metadata: z.record(jsonValue).default({}),
  })
  .strict()
  .refine(v => Buffer.byteLength(JSON.stringify(v.metadata)) <= 2048, {
    path: ['metadata'],
    message: 'metadata exceeds 2048 bytes',
  })
  .refine(
    v =>
      [v.title, v.description, v.action, ...v.details.flatMap(d => [d.label, d.value])].reduce(
        (sum, s) =>
          sum
          + s
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .length,
        0,
      ) <= 3000,
    { path: ['details'], message: 'display text is too long for Telegram' },
  );

export type CreateInput = z.output<typeof createSchema>;
export type CreateRequestInput = z.input<typeof createSchema>;
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ExecutionStatus = 'unclaimed' | 'claimed' | 'succeeded' | 'failed';
export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed';
export interface Detail { label: string; value: string }
export interface RequestView {
  id: string;
  clientId: string;
  action: string;
  title: string;
  description: string;
  details: Detail[];
  metadata: Record<string, JsonValue>;
  createdAt: string;
  expiresAt: string;
  status: DecisionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  executionStatus: ExecutionStatus;
  claimedAt: string | null;
  resultSummary: string | null;
  resultAt: string | null;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  deliveryError: string | null;
}

export interface ListRequestsQuery {
  status?: DecisionStatus;
  deliveryStatus?: DeliveryStatus;
  executionStatus?: ExecutionStatus;
  claimedBefore?: string;
  expiresBefore?: string;
  limit?: number;
  cursor?: string;
}
export interface ListRequestsPage { items: RequestView[]; nextCursor: string | null }
export type RequestEventType
  = | 'request.created'
    | 'delivery.retry_scheduled'
    | 'delivery.failed'
    | 'delivery.delivered'
    | 'delivery.requeued'
    | 'decision.approved'
    | 'decision.rejected'
    | 'decision.expired'
    | 'decision.cancelled'
    | 'execution.claimed'
    | 'execution.succeeded'
    | 'execution.failed';
export interface RequestEvent {
  sequence: number;
  type: RequestEventType;
  occurredAt: string;
  actorId: string | null;
  attempt: number | null;
}
export interface RequestEventsQuery { limit?: number; cursor?: string }
export interface RequestEventsPage { items: RequestEvent[]; nextCursor: string | null }

export const clientKeyScopes = [
  'requests:create',
  'requests:read',
  'requests:cancel',
  'requests:claim',
  'requests:result',
] as const;
export type ClientKeyScope = (typeof clientKeyScopes)[number];
export interface ClientKeyView {
  id: string;
  clientId: string;
  label: string;
  scopes: ClientKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
export type IssuedClientKey = ClientKeyView & { key: string };
export interface ListClientKeysPage { items: ClientKeyView[]; nextCursor: string | null }
export interface CreateClientKeyInput { label: string; scopes: ClientKeyScope[]; expiresAt?: string }
export interface ListClientKeysQuery { limit?: number; cursor?: string }
export type AuditEventType
  = | 'key.issued'
    | 'key.revoked'
    | 'request.created'
    | 'execution.claimed'
    | 'execution.succeeded'
    | 'execution.failed';
export interface AuditEvent {
  id: number;
  type: AuditEventType;
  occurredAt: string;
  actor: 'bootstrap' | 'issued_key';
  actorKeyId: string | null;
  requestId: string | null;
  subjectKeyId: string | null;
}
export interface ListAuditEventsQuery {
  limit?: number;
  cursor?: string;
  requestId?: string;
  keyId?: string;
}
export interface ListAuditEventsPage { items: AuditEvent[]; nextCursor: string | null }

function stable(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function canonicalContent(input: CreateInput): string {
  return JSON.stringify(stable(input));
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
