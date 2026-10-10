import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundledConsoleRoot, securityHeaderValues } from '../src/console-host.js';
import { GatewayCore } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import { openDatabase } from '../src/storage.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function consoleFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-console-'));
  dirs.push(dir);
  const root = join(dir, 'console');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>JaGate console</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, '.secret'), 'hidden');
  writeFileSync(join(dir, 'outside.txt'), 'outside');
  return root;
}

test('security headers are present and scripts stay limited to this origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-console-db-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'db.sqlite'));
  const app = createHttpServer(new GatewayCore(db), new Map(), () => true);
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  const csp = String(response.headers['content-security-policy']);
  assert.equal(csp, securityHeaderValues['content-security-policy']);
  assert.match(csp, /script-src 'self'/);
  assert.equal(csp.includes('script-src \'unsafe-inline\''), false);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store');
  await app.close();
  db.close();
});

test('the built console is served for navigation and refused for hidden files', async () => {
  const root = consoleFixture();
  const dir = mkdtempSync(join(tmpdir(), 'jagate-console-db-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'db.sqlite'));
  const app = createHttpServer(new GatewayCore(db), new Map([['website', 'a'.repeat(32)]]), () => true, {
    consoleRoot: root,
  });
  const page = await app.inject({ method: 'GET', url: '/inbox' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /JaGate console/);
  assert.equal(page.headers['cache-control'], 'no-store');

  const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(asset.statusCode, 200);
  assert.match(String(asset.headers['cache-control']), /immutable/);

  const hidden = await app.inject({ method: 'GET', url: '/.secret' });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.body.includes('hidden'), false);

  const escaped = await app.inject({ method: 'GET', url: '/../outside.txt' });
  assert.equal(escaped.statusCode, 404);
  assert.equal(escaped.body.includes('outside'), false);

  const api = await app.inject({ method: 'GET', url: '/v1/requests' });
  assert.equal(api.statusCode, 401);
  assert.equal(api.headers['content-type']?.includes('application/json'), true);
  assert.equal(api.body.includes('JaGate console'), false);
  await app.close();
  db.close();
});

test('source checkout does not serve the console source tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-console-src-'));
  dirs.push(dir);
  const source = join(dir, 'src', 'main.ts');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'console'), { recursive: true });
  writeFileSync(source, '');
  writeFileSync(join(dir, 'console', 'index.html'), 'source');
  assert.equal(bundledConsoleRoot(pathToFileURL(source).href), undefined);

  const built = join(dir, 'dist', 'src', 'main.js');
  mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'console'), { recursive: true });
  writeFileSync(built, '');
  writeFileSync(join(dir, 'dist', 'console', 'index.html'), 'built');
  assert.equal(bundledConsoleRoot(pathToFileURL(built).href), join(dir, 'dist', 'console'));
});
