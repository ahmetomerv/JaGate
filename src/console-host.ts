import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';

export const securityHeaderValues = {
  'content-security-policy': [
    'default-src \'self\'',
    'script-src \'self\'',
    'style-src \'self\'',
    'style-src-attr \'unsafe-inline\'',
    'img-src \'self\' data:',
    'font-src \'self\'',
    'connect-src \'self\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'frame-ancestors \'none\'',
    'form-action \'self\'',
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const;

export function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(securityHeaderValues))
    reply.header(name, value);
}

export function bundledConsoleRoot(moduleUrl: string = import.meta.url): string | undefined {
  const parent = dirname(fileURLToPath(moduleUrl));
  if (!dirname(parent).endsWith(`${sep}dist`))
    return undefined;
  const root = join(parent, '..', 'console');
  return existsSync(join(root, 'index.html')) ? root : undefined;
}

export function registerConsole(app: FastifyInstance, root: string): void {
  const resolved = resolve(root);
  if (!existsSync(join(resolved, 'index.html')))
    throw new Error('Console build is missing index.html');
  void app.register(fastifyStatic, {
    root: resolved,
    prefix: '/',
    wildcard: false,
    index: 'index.html',
    dotfiles: 'deny',
    list: false,
    redirect: false,
    decorateReply: true,
    schemaHide: true,
    cacheControl: false,
    setHeaders(reply, filePath) {
      reply.header(
        'cache-control',
        filePath.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-store',
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const document = request.method === 'GET'
      && !path.startsWith('/v1')
      && path !== '/health'
      && path !== '/ready'
      && !path.includes('.');
    if (document)
      return reply.type('text/html; charset=utf-8').sendFile('index.html', resolved);
    return reply.code(404).send({ error: { code: 'not_found', message: 'not found' } });
  });
}
