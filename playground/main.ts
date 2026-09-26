import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { createPlayground, loadLiveClientKeys } from './server.js';

if (existsSync('.env')) loadEnvFile('.env');

const app = createPlayground({
  databasePath: resolve('data/playground.sqlite'),
  liveClientKeys: loadLiveClientKeys(process.env),
  gatewayUrl: process.env.GATEWAY_URL ?? 'http://127.0.0.1:3080',
});

await app.listen({ host: '127.0.0.1', port: 3081 });
let vite: Awaited<ReturnType<typeof createServer>>;
try {
  vite = await createServer({ configFile: resolve('playground/vite.config.ts') });
  await vite.listen();
} catch (error) {
  await app.close();
  throw error;
}

console.info('JaGate playground: http://127.0.0.1:5173');
console.info(`Live gateway: ${process.env.GATEWAY_URL ?? 'http://127.0.0.1:3080'}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  await app.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close(); });
