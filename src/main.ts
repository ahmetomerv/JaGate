import { parseConfig } from './config.js';
import { openDatabase } from './storage.js';
import { GatewayCore } from './core.js';
import { createHttpServer } from './http.js';
import { HttpTelegramTransport, TelegramGateway } from './telegram.js';

const config = parseConfig(process.env);

const db = openDatabase(config.DATABASE_PATH);
const core = new GatewayCore(db);
const telegram = new TelegramGateway(core,
  new HttpTelegramTransport(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID),
  config.TELEGRAM_CHAT_ID, new Set(config.TELEGRAM_APPROVER_IDS.split(',')),
  (message) => console.error(message));
const app = createHttpServer(core, config.API_KEY, () => telegram.isReady());

try {
  await telegram.start();
  await app.listen({ host: config.HOST, port: config.PORT });
  console.info(`JaGate listening on ${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  await telegram.stop();
  db.close();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void (async () => { await app.close(); await telegram.stop(); db.close(); })(); });
}
