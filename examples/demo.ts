import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalClient } from '../src/client.js';

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('Set API_KEY in the environment');
const client = new ApprovalClient({ baseUrl: process.env.GATEWAY_URL ?? 'http://127.0.0.1:3080', apiKey });
const request = await client.createRequest({
  idempotencyKey: `local-demo:${Date.now()}`,
  action: 'write-local-demo-file',
  title: 'Create a harmless local demo file',
  description: 'Write one text file to the operating system temporary directory after approval.',
  details: [{ label: 'Directory', value: tmpdir() }],
  expiresInSeconds: 600,
  metadata: {},
});
console.log(`Request ${request.id} is ${request.status}; delivery is ${request.deliveryStatus}. Approve it in Telegram.`);
const decision = await client.waitForDecision(request.id, { timeoutMs: 610_000 });
if (decision.status !== 'approved') {
  console.log(`No file written: ${decision.status}`);
  process.exit(0);
}
const { claimToken } = await client.claim(request.id);
const file = join(tmpdir(), `jagate-demo-${request.id}.txt`);
try {
  await writeFile(file, 'Approved local demo action.\n', { flag: 'wx' });
} catch (error) {
  await client.reportResult(request.id, { claimToken, status: 'failed', summary: 'Local demo file could not be written' });
  throw error;
}
await client.reportResult(request.id, { claimToken, status: 'succeeded', summary: 'Local demo file written' });
console.log(`Wrote ${file}`);
