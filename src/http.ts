import { timingSafeEqual } from 'node:crypto';
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

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function createHttpServer(core: GatewayCore, apiKey: string, telegramReady: () => boolean): FastifyInstance {
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
    v1.addHook('onRequest', async (request, reply) => {
      if (!authorized(request.headers.authorization, apiKey)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'valid bearer API key required' } });
    });
    v1.post('/requests', async (request, reply) => {
      if (!core.storageReady() || !telegramReady()) throw new GatewayError('not_ready', 503, 'gateway is not ready to accept requests');
      const { request: created, created: isNew } = core.create(createSchema.parse(request.body));
      return reply.code(isNew ? 201 : 200).send(created);
    });
    v1.get('/requests/:id', async (request) => core.get(idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/cancel', async (request) => core.cancel(idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/claim', async (request) => core.claim(idSchema.parse((request.params as { id: string }).id)));
    v1.post('/requests/:id/result', async (request) => {
      const id = idSchema.parse((request.params as { id: string }).id);
      const body = resultSchema.parse(request.body);
      return core.report(id, body.claimToken, body.status, body.summary);
    });
  }, { prefix: '/v1' });
  return app;
}
