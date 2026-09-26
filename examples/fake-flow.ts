import { openDatabase } from '../src/storage.js';
import { GatewayCore, type DeliveryJob } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import { ApprovalClient } from '../src/client.js';
import { TelegramGateway, type TelegramTransport, type Update } from '../src/telegram.js';

const db = openDatabase(':memory:');
const core = new GatewayCore(db);
const key = 'x'.repeat(32);
const app = createHttpServer(core, new Map([['example', key]]), () => true);
const sent: DeliveryJob[] = [];
const transport: TelegramTransport = {
  async check() {},
  async send(job) { sent.push(job); return '101'; },
  async poll(): Promise<Update[]> { return []; },
  async answer(_id, message) { console.log(`Bot answer: ${message}`); },
  async edit(_job, _chatId, _messageId, status) { console.log(`Bot message updated: ${status}`); },
};
const telegram = new TelegramGateway(core, transport, new Map([['example', { chatId: '-100', approverIds: new Set(['7']) }]]));
const fetcher: typeof fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  const result = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path,
    headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
  return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
};
const client = new ApprovalClient({ baseUrl: 'http://fake.local', apiKey: key, fetch: fetcher, pollIntervalMs: 10 });

try {
  const request = await client.createRequest({ idempotencyKey: 'fake-demo-1', action: 'local-demo', title: 'Approve a harmless message',
    description: 'Print one local line after approval', details: [], expiresInSeconds: 600, metadata: {} });
  console.log(`Created ${request.id}: ${request.status}, delivery ${request.deliveryStatus}`);
  await telegram.deliverDue();
  const job = sent[0]!;
  console.log(`Delivered mock Telegram message: ${job.view.title}`);
  await telegram.process({ update_id: 1, callback_query: { id: 'mock-callback', data: `a:${job.callbackRef}`, from: { id: 7 }, message: { chat: { id: -100 }, message_id: 101 } } });
  const decision = await client.waitForDecision(request.id, { timeoutMs: 1000 });
  console.log(`Decision: ${decision.status}`);
  const { claimToken } = await client.claim(request.id);
  console.log('Harmless local action completed.');
  const result = await client.reportResult(request.id, { claimToken, status: 'succeeded', summary: 'Local message printed' });
  console.log(`Execution: ${result.executionStatus}`);
} finally {
  await app.close();
  db.close();
}
