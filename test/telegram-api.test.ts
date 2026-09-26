import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpTelegramTransport, TelegramApiError, formatMessage } from '../src/telegram.js';
import type { DeliveryJob } from '../src/core.js';

const job: DeliveryJob = {
  id: '123e4567-e89b-42d3-a456-426614174000', callbackRef: 'AbCdEf0123456789', attempts: 0,
  view: {
    id: '123e4567-e89b-42d3-a456-426614174000', clientId: 'publisher', action: 'publish', title: '<Publish & review>',
    description: 'Publish <draft> after review', details: [{ label: 'Owner & team', value: 'A < B' }],
    metadata: { privateValue: 'must-not-appear' }, createdAt: '2026-09-24T12:00:00.000Z',
    expiresAt: '2026-09-24T12:15:00.000Z', status: 'pending', decidedBy: null, decidedAt: null,
    executionStatus: 'unclaimed', claimedAt: null, resultSummary: null, resultAt: null,
    deliveryStatus: 'pending', deliveryAttempts: 0, deliveryError: null,
  },
};

test('Telegram adapter sends escaped content with opaque callbacks and removes buttons on edit', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const result = method === 'getWebhookInfo' ? { url: '' } : method === 'sendMessage' ? { message_id: 321 } : method === 'getUpdates' ? [] : true;
    return Response.json({ ok: true, result });
  };
  const telegram = new HttpTelegramTransport('test-token-not-real', fetcher);
  await telegram.check(new Set(['-100']));
  const messageId = await telegram.send(job, '-100');
  assert.equal(messageId, '321');
  await telegram.answer('callback-1', 'Approved.');
  await telegram.edit(job, '-100', messageId, 'approved');
  const updates = await telegram.poll(42, new AbortController().signal);
  assert.deepEqual(updates, []);
  assert.deepEqual(calls.map((c) => c.method), ['getMe', 'getWebhookInfo', 'getChat', 'getUpdates', 'sendMessage', 'answerCallbackQuery', 'editMessageText', 'getUpdates']);
  assert.deepEqual(calls[2]?.body, { chat_id: '-100' });
  const sent = calls[4]!.body;
  assert.equal(sent.chat_id, '-100');
  assert.equal(sent.parse_mode, 'HTML');
  const text = String(sent.text);
  assert.match(text, /&lt;Publish &amp; review&gt;/);
  assert.match(text, /Publish &lt;draft&gt; after review/);
  assert.match(text, /Owner &amp; team/);
  assert.match(text, /Client: <code>publisher<\/code>/);
  assert.match(text, /A &lt; B/);
  assert.match(text, /123e4567/);
  assert.match(text, /2026-09-24T12:15:00.000Z/);
  assert.doesNotMatch(text, /must-not-appear/);
  const markup = sent.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  assert.deepEqual(markup.inline_keyboard.map((row) => row.map((button) => button.callback_data)), [[
    'a:AbCdEf0123456789', 'r:AbCdEf0123456789',
  ]]);
  assert.doesNotMatch(JSON.stringify(markup), /Publish|draft|privateValue/);
  assert.deepEqual(calls[6]?.body.reply_markup, { inline_keyboard: [] });
  assert.match(String(calls[6]?.body.text), /Status: <b>approved<\/b>/);
  assert.deepEqual(calls[7]?.body, { offset: 42, timeout: 20, limit: 50, allowed_updates: ['callback_query'] });
  assert.doesNotMatch(formatMessage(job), /must-not-appear/);
});

test('Telegram adapter classifies API and network failures without exposing the bot token', async () => {
  for (const [status, kind] of [[403, 'permanent'], [429, 'transient'], [503, 'transient'], [409, 'conflict']] as const) {
    const fetcher: typeof fetch = async () => Response.json({ ok: false, description: 'sensitive response' }, { status });
    const transport = new HttpTelegramTransport('private-test-token', fetcher);
    await assert.rejects(transport.send(job, '-100'), (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /private-test-token|sensitive response/);
      return true;
    });
  }
  const network: typeof fetch = async () => { throw new Error('network failure with private-test-token'); };
  await assert.rejects(new HttpTelegramTransport('private-test-token', network).send(job, '-100'), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.kind, 'transient');
    assert.doesNotMatch(error.message, /private-test-token/);
    return true;
  });
});

test('Telegram preflight gives a specific error when the configured chat is inaccessible', async () => {
  const checked: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getChat') {
      checked.push(method);
      return Response.json({ ok: false }, { status: 400 });
    }
    return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: '' } : {} });
  };
  await assert.rejects(new HttpTelegramTransport('test-token', fetcher).check(new Set(['-100'])), /Check its numeric ID and add the bot/);
  assert.deepEqual(checked, ['getChat']);
});

test('Telegram preflight checks every distinct destination before polling', async () => {
  const checked: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getChat') {
      const chatId = String((JSON.parse(String(init?.body)) as { chat_id: string }).chat_id);
      checked.push(chatId);
      if (chatId === '-200') return Response.json({ ok: false }, { status: 400 });
    }
    return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: '' } : [] });
  };
  await assert.rejects(new HttpTelegramTransport('test-token', fetcher).check(new Set(['-100', '-200'])), /configured chat -200/);
  assert.deepEqual(checked, ['-100', '-200']);
});
