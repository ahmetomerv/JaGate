import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type { GatewayCore } from './core.js';
import { GatewayError } from './errors.js';
import { createSchema } from './model.js';

const idSchema = z.string().uuid();
const resultSchema = z.object({
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  status: z.enum(['succeeded', 'failed']),
  summary: z.string().trim().min(1).max(300).refine((s) => !/[\u0000-\u001f]/.test(s)),
}).strict();

declare module 'fastify' {
  interface FastifyRequest { clientId: string }
}

function clientIdFor(header: string | undefined, clientKeys: ReadonlyMap<string, string>): string | undefined {
  if (!header?.startsWith('Bearer ') || header.length > 256) return undefined;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  let clientId: string | undefined;
  for (const [id, key] of clientKeys) {
    const expected = createHash('sha256').update(key).digest();
    if (timingSafeEqual(supplied, expected)) clientId = id;
  }
  return clientId;
}

export function createHttpServer(core: GatewayCore, clientKeys: ReadonlyMap<string, string>, telegramReady: () => boolean): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 12_000 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: 'request validation failed', issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) } });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: { code: 'invalid_input', message: 'invalid request body' } });
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal server error' } });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    let storage = false;
    try { storage = core.storageReady(); } catch { /* unavailable */ }
    const telegram = telegramReady();
    return reply.code(storage && telegram ? 200 : 503).send({ ready: storage && telegram, storage, telegram });
  });
  app.register(async (v1) => {
    v1.decorateRequest('clientId', '');
    v1.addHook('onRequest', async (request, reply) => {
      const clientId = clientIdFor(request.headers.authorization, clientKeys);
      if (!clientId) return reply.code(401).send({ error: { code: 'unauthorized', message: 'valid client bearer key required' } });
      request.clientId = clientId;
    });
    v1.post('/requests', async (request, reply) => {
      if (!core.storageReady() || !telegramReady()) throw new GatewayError('not_ready', 503, 'gateway is not ready to accept requests');
      const { request: created, created: isNew } = core.create(request.clientId, createSchema.parse(request.body));
      return reply.code(isNew ? 201 : 200).send(created);
    });
    v1.get('/requests/:id', async (request) => core.get(request.clientId, idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/cancel', async (request) => core.cancel(request.clientId, idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/claim', async (request) => core.claim(request.clientId, idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/result', async (request) => {
      const id = idSchema.parse((request.params as { id: string }).id);
      const body = resultSchema.parse(request.body);
      return core.report(request.clientId, id, body.claimToken, body.status, body.summary);
    });
  }, { prefix: '/v1' });
  return app;
}
