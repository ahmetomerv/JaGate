import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'control characters are not allowed');
const detailSchema = z.object({ label: text(40), value: text(160) }).strict();
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue), z.record(jsonValue),
]));

export const createSchema = z.object({
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:=-]*$/),
  action: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/),
  title: text(100),
  description: text(1000),
  details: z.array(detailSchema).max(10).default([]),
  expiresInSeconds: z.number().int().min(60).max(86400),
  metadata: z.record(jsonValue).default({}),
}).strict()
  .refine((v) => Buffer.byteLength(JSON.stringify(v.metadata)) <= 2048, { path: ['metadata'], message: 'metadata exceeds 2048 bytes' })
  .refine((v) => [v.title, v.description, v.action, ...v.details.flatMap((d) => [d.label, d.value])]
    .reduce((sum, s) => sum + s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').length, 0) <= 3000,
  { path: ['details'], message: 'display text is too long for Telegram' });

export type CreateInput = z.output<typeof createSchema>;
export type CreateRequestInput = z.input<typeof createSchema>;
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ExecutionStatus = 'unclaimed' | 'claimed' | 'succeeded' | 'failed';
export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed';
export type Detail = { label: string; value: string };
export type RequestView = {
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
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

export function canonicalContent(input: CreateInput): string {
  return JSON.stringify(stable(input));
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
