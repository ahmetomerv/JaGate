import type { FastifyInstance } from 'fastify';
import type { GatewayCore } from './core.js';
import type { ClientKeyScope } from './model.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { applySecurityHeaders, registerConsole } from './console-host.js';
import { GatewayError } from './errors.js';
import { clientKeyScopes, createSchema } from './model.js';

const idSchema = z.string().uuid();
const utcTimestampSchema = z
  .string()
  .max(24)
  .datetime()
  .regex(/(?:\.\d{1,3})?Z$/)
  .refine(
    value =>
      !Number.isNaN(Date.parse(value))
      && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    'invalid UTC date',
  )
  .transform(value => new Date(value).toISOString());
const listQuerySchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional(),
    deliveryStatus: z.enum(['pending', 'retrying', 'delivered', 'failed']).optional(),
    executionStatus: z.enum(['unclaimed', 'claimed', 'succeeded', 'failed']).optional(),
    claimedBefore: utcTimestampSchema.optional(),
    expiresBefore: utcTimestampSchema.optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .default('20'),
    cursor: z
      .string()
      .max(256)
      .regex(/^[\w-]+$/)
      .optional(),
  })
  .strict();
const cursorSchema = z.tuple([z.string().datetime(), idSchema]);
const eventsQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .default('50'),
    cursor: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(15)
      .optional(),
  })
  .strict();

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor)
    return undefined;
  try {
    const [createdAt, id] = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { createdAt, id };
  }
  catch {
    throw new GatewayError('invalid_input', 400, 'invalid pagination cursor');
  }
}
const resultSchema = z
  .object({
    claimToken: z.string().regex(/^[\w-]{43}$/),
    status: z.enum(['succeeded', 'failed']),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(300)
      // eslint-disable-next-line no-control-regex -- reject ASCII control characters
      .refine(s => !/[\u0000-\u001F]/.test(s)),
  })
  .strict();
const issueKeySchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      // eslint-disable-next-line no-control-regex -- reject ASCII control characters
      .refine(value => !/[\u0000-\u001F]/.test(value)),
    scopes: z
      .array(z.enum(clientKeyScopes))
      .min(1)
      .max(clientKeyScopes.length)
      .refine(values => new Set(values).size === values.length, 'scopes must be unique'),
    expiresAt: utcTimestampSchema.optional(),
  })
  .strict();
const keyListQuerySchema = listQuerySchema.pick({ limit: true, cursor: true });
const auditQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .default('20'),
    cursor: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(15)
      .optional(),
    requestId: idSchema.optional(),
    keyId: idSchema.optional(),
  })
  .strict();

declare module 'fastify' {
  interface FastifyRequest {
    clientId: string;
    clientScopes: ReadonlySet<ClientKeyScope> | null;
    isBootstrapKey: boolean;
    issuedKeyId: string | null;
  }
}

function requireScope(
  request: { clientScopes: ReadonlySet<ClientKeyScope> | null; isBootstrapKey: boolean },
  scope: ClientKeyScope,
): void {
  if (!request.isBootstrapKey && !request.clientScopes?.has(scope))
    throw new GatewayError('insufficient_scope', 403, `client key requires ${scope} scope`);
}

function requireBootstrapKey(request: { isBootstrapKey: boolean }): void {
  if (!request.isBootstrapKey)
    throw new GatewayError('insufficient_scope', 403, 'bootstrap client key required');
}

function clientIdFor(
  header: string | undefined,
  clientKeys: ReadonlyMap<string, string>,
): string | undefined {
  if (!header?.startsWith('Bearer ') || header.length > 256)
    return undefined;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  let clientId: string | undefined;
  for (const [id, key] of clientKeys) {
    const expected = createHash('sha256').update(key).digest();
    if (timingSafeEqual(supplied, expected))
      clientId = id;
  }
  return clientId;
}

export function createHttpServer(
  core: GatewayCore,
  clientKeys: ReadonlyMap<string, string>,
  telegramReady: () => boolean,
  options: { consoleRoot?: string } = {},
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 12_000 });
  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply);
    const path = request.url.split('?')[0] ?? '/';
    if (!path.startsWith('/assets/'))
      reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'request validation failed',
          issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
        },
      });
    }
    if (
      error instanceof Error
      && 'statusCode' in error
      && typeof error.statusCode === 'number'
      && error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: 'invalid_input', message: 'invalid request body' } });
    }
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'internal server error' } });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    let storage = false;
    try {
      storage = core.storageReady();
    }
    catch {
      /* unavailable */
    }
    const telegram = telegramReady();
    return reply
      .code(storage && telegram ? 200 : 503)
      .send({ ready: storage && telegram, storage, telegram });
  });
  app.register(
    async (v1) => {
      v1.decorateRequest('clientId', '');
      v1.decorateRequest('clientScopes', null);
      v1.decorateRequest('isBootstrapKey', false);
      v1.decorateRequest('issuedKeyId', null);
      v1.addHook('onRequest', async (request, reply) => {
        const clientId = clientIdFor(request.headers.authorization, clientKeys);
        if (clientId) {
          request.clientId = clientId;
          request.isBootstrapKey = true;
          return;
        }
        const header = request.headers.authorization;
        const key = header?.startsWith('Bearer ') && header.length <= 256 ? header.slice(7) : '';
        const stored = /^jgk_[\w-]{43}$/.test(key)
          ? core.authenticateClientKey(key)
          : undefined;
        if (!stored || !clientKeys.has(stored.clientId)) {
          return reply
            .code(401)
            .send({ error: { code: 'unauthorized', message: 'valid client bearer key required' } });
        }
        request.clientId = stored.clientId;
        request.issuedKeyId = stored.id;
        request.clientScopes = new Set(stored.scopes);
      });
      v1.post('/requests', async (request, reply) => {
        requireScope(request, 'requests:create');
        if (!core.storageReady() || !telegramReady())
          throw new GatewayError('not_ready', 503, 'gateway is not ready to accept requests');
        const { request: created, created: isNew } = core.create(
          request.clientId,
          createSchema.parse(request.body),
          request.issuedKeyId,
        );
        return reply.code(isNew ? 201 : 200).send(created);
      });
      v1.get('/requests', async (request) => {
        requireScope(request, 'requests:read');
        const { cursor, ...filters } = listQuerySchema.parse(request.query);
        const before = decodeCursor(cursor);
        return core.list(request.clientId, {
          limit: filters.limit,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.deliveryStatus ? { deliveryStatus: filters.deliveryStatus } : {}),
          ...(filters.executionStatus ? { executionStatus: filters.executionStatus } : {}),
          ...(filters.claimedBefore ? { claimedBefore: filters.claimedBefore } : {}),
          ...(filters.expiresBefore ? { expiresBefore: filters.expiresBefore } : {}),
          ...(before ? { before } : {}),
        });
      });
      v1.get('/requests/:id', async (request) => {
        requireScope(request, 'requests:read');
        return core.get(request.clientId, idSchema.parse((request.params as { id: string }).id));
      });
      v1.get('/requests/:id/events', async (request) => {
        requireScope(request, 'requests:read');
        const id = idSchema.parse((request.params as { id: string }).id);
        const { limit, cursor } = eventsQuerySchema.parse(request.query);
        return core.events(request.clientId, id, {
          limit,
          ...(cursor ? { after: Number(cursor) } : {}),
        });
      });
      v1.post('/requests/:id/cancel', async (request) => {
        requireScope(request, 'requests:cancel');
        return core.cancel(request.clientId, idSchema.parse((request.params as { id: string }).id));
      });
      v1.post('/requests/:id/claim', async (request) => {
        requireScope(request, 'requests:claim');
        return core.claim(
          request.clientId,
          idSchema.parse((request.params as { id: string }).id),
          request.issuedKeyId,
        );
      });
      v1.post('/requests/:id/result', async (request) => {
        requireScope(request, 'requests:result');
        const id = idSchema.parse((request.params as { id: string }).id);
        const body = resultSchema.parse(request.body);
        return core.report(
          request.clientId,
          id,
          body.claimToken,
          body.status,
          body.summary,
          request.issuedKeyId,
        );
      });
      v1.post('/client-keys', async (request, reply) => {
        requireBootstrapKey(request);
        const { label, scopes, expiresAt } = issueKeySchema.parse(request.body);
        return reply
          .code(201)
          .send(core.issueClientKey(request.clientId, label, scopes, expiresAt));
      });
      v1.get('/client-keys', async (request) => {
        requireBootstrapKey(request);
        const { limit, cursor } = keyListQuerySchema.parse(request.query);
        const before = decodeCursor(cursor);
        return core.listClientKeys(request.clientId, { limit, ...(before ? { before } : {}) });
      });
      v1.post('/client-keys/:id/revoke', async (request) => {
        requireBootstrapKey(request);
        return core.revokeClientKey(
          request.clientId,
          idSchema.parse((request.params as { id: string }).id),
        );
      });
      v1.get('/audit-events', async (request) => {
        requireBootstrapKey(request);
        const { limit, cursor, requestId, keyId } = auditQuerySchema.parse(request.query);
        return core.listAuditEvents(request.clientId, {
          limit,
          ...(cursor ? { before: Number(cursor) } : {}),
          ...(requestId ? { requestId } : {}),
          ...(keyId ? { keyId } : {}),
        });
      });
    },
    { prefix: '/v1' },
  );
  if (options.consoleRoot)
    registerConsole(app, options.consoleRoot);
  return app;
}
