import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { parseClientKeys, type TelegramRoute } from '../src/config.js';
import { GatewayCore } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import type { CreateRequestInput } from '../src/model.js';
import { openDatabase } from '../src/storage.js';
import { TelegramGateway, type TelegramTransport, type Update } from '../src/telegram.js';

const clients = ['ci-pipeline', 'cloud-ops', 'billing-service'] as const;
type ClientId = typeof clients[number];
const clientSchema = z.enum(clients);
const simulatedExamples: Record<ClientId, { label: string; scenario: string; request: CreateRequestInput }> = {
  'ci-pipeline': {
    label: 'CI/CD pipeline', scenario: 'deploy a new API release to production',
    request: { idempotencyKey: 'deploy:release-1-8-0', action: 'deploy', title: 'Deploy API to production',
      description: 'The deployment pipeline is ready to release API version 1.8.0 to production.',
      details: [{ label: 'Environment', value: 'production' }, { label: 'Release', value: 'v1.8.0' }],
      metadata: { source: 'ci-pipeline', repository: 'acme/api' }, expiresInSeconds: 900 },
  },
  'cloud-ops': {
    label: 'Cloud operations', scenario: 'delete an old database snapshot',
    request: { idempotencyKey: 'snapshot:db-prod-2026-08-01', action: 'delete-snapshot', title: 'Delete old database snapshot',
      description: 'The cloud operations tool is ready to remove a database snapshot after retention review.',
      details: [{ label: 'Snapshot', value: 'db-prod-2026-08-01' }, { label: 'Region', value: 'eu-central-1' }],
      metadata: { source: 'cloud-ops', ticket: 'OPS-124' }, expiresInSeconds: 900 },
  },
  'billing-service': {
    label: 'Billing service', scenario: 'issue a high-value customer refund',
    request: { idempotencyKey: 'refund:INV-2048', action: 'issue-refund', title: 'Issue customer refund',
      description: 'The billing service is ready to issue a EUR 1,200 refund for a customer invoice.',
      details: [{ label: 'Invoice', value: 'INV-2048' }, { label: 'Amount', value: 'EUR 1,200' }],
      metadata: { source: 'billing-service', invoiceId: 'INV-2048' }, expiresInSeconds: 900 },
  },
};
const idSchema = z.string().uuid();
const modeSchema = z.enum(['simulated', 'live']);
const commandSchema = z.object({
  mode: modeSchema,
  clientId: z.string().min(1).max(32),
  operation: z.enum(['create', 'list', 'get', 'events', 'cancel', 'claim', 'result', 'keyCreate', 'keyList', 'keyRevoke', 'audit', 'health', 'ready']),
  auth: z.enum(['valid', 'scoped', 'missing', 'invalid']).default('valid'),
  scopedKey: z.string().max(128).optional(),
  requestId: z.string().max(128).optional(),
  keyId: z.string().max(128).optional(),
  filters: z.object({
    status: z.string().max(32).optional(),
    deliveryStatus: z.string().max(32).optional(),
    executionStatus: z.string().max(32).optional(),
    claimedBefore: z.string().max(64).optional(),
    expiresBefore: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(256).optional(),
  }).strict().optional(),
  eventPage: z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(15).optional() }).strict().optional(),
  keyPage: z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(256).optional() }).strict().optional(),
  auditPage: z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(15).optional(),
    requestId: idSchema.optional(), keyId: idSchema.optional() }).strict().optional(),
  payload: z.unknown().optional(),
}).strict();

const routes: ReadonlyMap<ClientId, TelegramRoute> = new Map([
  ['ci-pipeline', { chatId: '-1001', approverIds: new Set(['101']) }],
  ['cloud-ops', { chatId: '-1002', approverIds: new Set(['202']) }],
  ['billing-service', { chatId: '-1003', approverIds: new Set(['303']) }],
]);

class SimulatedTelegram implements TelegramTransport {
  private nextMessageId: number;
  readonly answers = new Map<string, string>();
  constructor(lastMessageId: number) { this.nextMessageId = lastMessageId + 1; }
  async check(): Promise<void> {}
  async send(...args: Parameters<TelegramTransport['send']>): Promise<string> { void args; return String(this.nextMessageId++); }
  async poll(...args: Parameters<TelegramTransport['poll']>): Promise<Update[]> { void args; return []; }
  async answer(id: string, message: string): Promise<void> { this.answers.set(id, message); }
  async edit(): Promise<void> {}
}

export type PlaygroundOptions = {
  databasePath: string;
  liveClientKeys?: ReadonlyMap<string, string> | undefined;
  gatewayUrl?: string;
  fetcher?: typeof fetch;
};

export function loadLiveClientKeys(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> | undefined {
  if (!env.CLIENT_KEYS) return undefined;
  try { return parseClientKeys(env.CLIENT_KEYS); }
  catch { return undefined; }
}

export function createPlayground(options: PlaygroundOptions) {
  const db = openDatabase(options.databasePath);
  const savedOffset = db.prepare("SELECT value FROM settings WHERE key = 'playground_clock_offset_ms'").get() as { value: string } | undefined;
  let clockOffsetMs = Number(savedOffset?.value ?? 0);
  const core = new GatewayCore(db, () => new Date(Date.now() + clockOffsetMs));
  const simulatedKeys = new Map<ClientId, string>(clients.map((id) => [id, randomBytes(32).toString('base64url')]));
  const simulatedApi = createHttpServer(core, simulatedKeys, () => true);
  const lastMessage = db.prepare('SELECT MAX(CAST(delivery_message_id AS INTEGER)) AS id FROM requests').get() as { id: number | null };
  const transport = new SimulatedTelegram(lastMessage.id ?? 0);
  const telegram = new TelegramGateway(core, transport, routes);
  const app = Fastify({ logger: false, bodyLimit: 16_000 });
  const accessToken = randomBytes(32).toString('base64url');
  const liveKeys = options.liveClientKeys;
  const liveUrl = options.gatewayUrl ?? 'http://127.0.0.1:3080';
  const fetcher = options.fetcher ?? fetch;

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/bootstrap') return;
    if (request.headers['x-playground-token'] !== accessToken)
      return reply.code(403).send({ error: 'Playground session token required' });
  });

  app.get('/api/bootstrap', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({
    token: accessToken,
    simulatedClients: clients,
    simulatedExamples,
    liveClients: liveKeys ? [...liveKeys.keys()] : [],
    gatewayUrl: liveUrl,
    simulatedNow: new Date(Date.now() + clockOffsetMs).toISOString(),
  }));

  app.post('/api/execute', async (request, reply) => {
    const parsed = commandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid playground command' });
    const { mode, clientId, operation, auth, scopedKey, requestId, keyId, filters, eventPage, keyPage, auditPage, payload } = parsed.data;
    if (mode === 'simulated' ? !clientSchema.safeParse(clientId).success : !liveKeys?.has(clientId))
      return reply.code(400).send({ error: 'Unknown client for this mode' });
    if (['get', 'events', 'cancel', 'claim', 'result'].includes(operation) && !requestId)
      return reply.code(400).send({ error: 'Select or enter a request ID' });
    if (operation === 'keyRevoke' && !keyId) return reply.code(400).send({ error: 'Select or enter a client key ID' });
    if (auth === 'scoped' && !scopedKey) return reply.code(400).send({ error: 'Enter an issued client key' });
    const path = operation === 'health' || operation === 'ready' ? `/${operation}`
      : operation === 'create' || operation === 'list' ? '/v1/requests'
        : operation === 'audit' ? '/v1/audit-events'
        : operation === 'keyCreate' || operation === 'keyList' ? '/v1/client-keys'
          : operation === 'keyRevoke' ? `/v1/client-keys/${encodeURIComponent(keyId!)}/revoke`
        : `/v1/requests/${encodeURIComponent(requestId!)}` + (operation === 'get' ? '' : `/${operation}`);
    const query = new URLSearchParams();
    if (operation === 'list' && filters) for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
    if (operation === 'events' && eventPage) for (const [key, value] of Object.entries(eventPage)) if (value !== undefined && value !== '') query.set(key, String(value));
    if (operation === 'keyList' && keyPage) for (const [key, value] of Object.entries(keyPage)) if (value !== undefined && value !== '') query.set(key, String(value));
    if (operation === 'audit' && auditPage) for (const [key, value] of Object.entries(auditPage)) if (value !== undefined && value !== '') query.set(key, String(value));
    const url = `${path}${query.size ? `?${query}` : ''}`;
    const method = ['list', 'get', 'events', 'keyList', 'audit', 'health', 'ready'].includes(operation) ? 'GET' : 'POST';
    const key = mode === 'simulated' ? simulatedKeys.get(clientId as ClientId)! : liveKeys!.get(clientId)!;
    const authorization = auth === 'missing' ? undefined : `Bearer ${auth === 'invalid' ? 'invalid-playground-key' : auth === 'scoped' ? scopedKey : key}`;
    const headers = { ...(authorization ? { authorization } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
    const body = operation === 'create' || operation === 'result' || operation === 'keyCreate' ? payload : {};

    if (mode === 'simulated') {
      const result = await simulatedApi.inject({ method, url, headers, ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}) });
      if (operation === 'create' && result.statusCode === 201) await telegram.deliverDue();
      return { status: result.statusCode, body: result.json() as unknown };
    }
    try {
      const response = await fetcher(new URL(url, liveUrl), {
        method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() as unknown };
    } catch {
      return { status: 502, body: { error: { code: 'gateway_unreachable', message: 'Could not reach the configured gateway' } } };
    }
  });

  app.post('/api/decide', async (request, reply) => {
    const parsed = z.object({ requestId: idSchema, clientId: clientSchema,
      decision: z.enum(['approve', 'reject']), actor: z.enum(['allowed', 'outsider']) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid simulated decision' });
    const { requestId, clientId, decision, actor } = parsed.data;
    const row = db.prepare('SELECT callback_ref, delivery_chat_id, delivery_message_id FROM requests WHERE id = ? AND client_id = ?')
      .get(requestId, clientId) as { callback_ref: string; delivery_chat_id: string | null; delivery_message_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'Request not found for this client' });
    if (!row.delivery_chat_id || !row.delivery_message_id) return reply.code(409).send({ error: 'Request has not been delivered' });
    const route = routes.get(clientId)!;
    const callbackId = randomUUID();
    await telegram.process({ update_id: 0, callback_query: {
      id: callbackId, data: `${decision === 'approve' ? 'a' : 'r'}:${row.callback_ref}`,
      from: { id: actor === 'allowed' ? Number([...route.approverIds][0]) : 999 },
      message: { chat: { id: Number(row.delivery_chat_id) }, message_id: Number(row.delivery_message_id) },
    } });
    return { message: transport.answers.get(callbackId), request: core.get(clientId, requestId) };
  });

  app.post('/api/advance-time', async (request, reply) => {
    const parsed = z.object({ seconds: z.number().int().min(1).max(86_400) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Seconds must be between 1 and 86400' });
    clockOffsetMs += parsed.data.seconds * 1000;
    db.prepare("INSERT INTO settings(key,value) VALUES ('playground_clock_offset_ms',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(clockOffsetMs));
    return { now: new Date(Date.now() + clockOffsetMs).toISOString(), expired: core.expire() };
  });

  app.addHook('onClose', async () => { await simulatedApi.close(); db.close(); });
  return app;
}
