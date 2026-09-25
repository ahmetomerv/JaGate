import type { GatewayCore, DeliveryJob } from './core.js';

export type Callback = {
  id: string;
  data?: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
};
export type Update = { update_id: number; callback_query?: Callback };
export type TelegramTransport = {
  check(): Promise<void>;
  send(job: DeliveryJob): Promise<string>;
  poll(offset: number, signal: AbortSignal): Promise<Update[]>;
  answer(id: string, text: string): Promise<void>;
  edit(job: DeliveryJob, messageId: string, status: string): Promise<void>;
};

export class TelegramApiError extends Error {
  constructor(public readonly kind: 'conflict' | 'transient' | 'permanent' | 'webhook', message: string) { super(message); }
  get retryable(): boolean { return this.kind === 'transient'; }
}

const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function formatMessage(job: DeliveryJob, status?: string): string {
  const { view } = job;
  const details = view.details.map(({ label, value }) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`).join('\n');
  return `<b>${escapeHtml(view.title)}</b>\n${escapeHtml(view.description)}${details ? `\n\n${details}` : ''}\n\nClient: <code>${escapeHtml(view.clientId)}</code>\nAction: <code>${escapeHtml(view.action)}</code>\nRequest: <code>${view.id.slice(0, 8)}</code>\nExpires: ${escapeHtml(view.expiresAt)}${status ? `\nStatus: <b>${escapeHtml(status)}</b>` : ''}`;
}

export class HttpTelegramTransport implements TelegramTransport {
  constructor(private readonly token: string, private readonly chatId: string, private readonly fetcher: typeof fetch = fetch) {}
  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(method === 'getUpdates' ? 30_000 : 10_000);
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw new DOMException('Polling stopped', 'AbortError');
      throw new TelegramApiError('transient', 'Telegram network request failed');
    }
    let payload: { ok?: boolean; result?: T } = {};
    try { payload = await response.json() as typeof payload; } catch { /* classified below */ }
    if (!response.ok || !payload.ok) {
      const kind = response.status === 409 ? 'conflict' : response.status === 429 || response.status >= 500 ? 'transient' : 'permanent';
      throw new TelegramApiError(kind, `Telegram ${method} returned HTTP ${response.status}`);
    }
    return payload.result as T;
  }
  async check(): Promise<void> {
    await this.call('getMe', {});
    const info = await this.call<{ url?: string }>('getWebhookInfo', {});
    if (info.url) throw new TelegramApiError('webhook', 'Bot has an active webhook. Remove it explicitly or use a dedicated bot token.');
    try { await this.call('getChat', { chat_id: this.chatId }); }
    catch (error) {
      if (error instanceof TelegramApiError && error.kind === 'permanent')
        throw new TelegramApiError('permanent', 'Bot cannot access TELEGRAM_CHAT_ID. Check the numeric ID and start or add the bot in that chat.');
      throw error;
    }
    try { await this.call('getUpdates', { timeout: 0, limit: 1, allowed_updates: ['callback_query'] }); }
    catch (error) {
      if (error instanceof TelegramApiError && error.kind === 'conflict') throw new TelegramApiError('conflict', 'Another poller is using this bot token. Stop it or use a dedicated bot.');
      throw error;
    }
  }
  async send(job: DeliveryJob): Promise<string> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId, text: formatMessage(job), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[
        { text: 'Approve', callback_data: `a:${job.callbackRef}` },
        { text: 'Reject', callback_data: `r:${job.callbackRef}` },
      ]] },
    });
    return String(result.message_id);
  }
  poll(offset: number, signal: AbortSignal): Promise<Update[]> {
    return this.call<Update[]>('getUpdates', { offset, timeout: 20, limit: 50, allowed_updates: ['callback_query'] }, signal);
  }
  async answer(id: string, text: string): Promise<void> { await this.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 180) }); }
  async edit(job: DeliveryJob, messageId: string, status: string): Promise<void> {
    await this.call('editMessageText', { chat_id: this.chatId, message_id: Number(messageId), text: formatMessage(job, status), parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  }
}

export class TelegramGateway {
  private pollReady = false;
  private deliveryReady = false;
  private delivering = false;
  private stopped = false;
  private controller: AbortController | null = null;
  private pollTask: Promise<void> | null = null;
  private deliveryTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly core: GatewayCore, private readonly transport: TelegramTransport,
    private readonly chatId: string, private readonly approvers: ReadonlySet<string>,
    private readonly onError: (message: string) => void = () => {}) {}

  isReady(): boolean { return this.pollReady && this.deliveryReady; }
  async start(): Promise<void> {
    await this.transport.check();
    this.stopped = false;
    this.pollReady = true;
    this.deliveryReady = true;
    this.deliveryTimer = setInterval(() => { void this.deliverDue().catch(() => this.onError('Delivery worker failed')); }, 1000);
    this.pollTask = this.pollLoop();
    await this.deliverDue();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.pollReady = false;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.controller?.abort();
    await this.pollTask;
  }
  async deliverDue(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const job of this.core.dueDeliveries()) {
        try {
          const messageId = await this.transport.send(job);
          this.core.deliverySucceeded(job.id, messageId);
          this.deliveryReady = true;
        } catch (error) {
          this.deliveryReady = false;
          const retryable = !(error instanceof TelegramApiError) || error.retryable;
          const reason = error instanceof TelegramApiError ? error.message : 'Telegram network request failed';
          this.core.deliveryFailed(job.id, retryable, reason);
          this.onError(`Telegram delivery failed for request ${job.id}: ${reason}`);
        }
      }
    } finally { this.delivering = false; }
  }
  async process(update: Update): Promise<void> {
    const callback = update.callback_query;
    if (!callback) return;
    const answer = async (message: string) => { try { await this.transport.answer(callback.id, message); } catch { this.onError('Could not answer Telegram callback'); } };
    const match = /^([ar]):([A-Za-z0-9_-]{16})$/.exec(callback.data ?? '');
    if (!match || !callback.message) { await answer('This button is no longer available.'); return; }
    if (String(callback.message.chat.id) !== this.chatId || !this.approvers.has(String(callback.from.id))) {
      await answer('You are not authorized to decide this request.'); return;
    }
    const result = this.core.decide(match[2]!, String(callback.message.message_id), String(callback.from.id), match[1] === 'a' ? 'approved' : 'rejected');
    await answer(result.outcome);
    if (result.request && (result.outcome === 'Approved.' || result.outcome === 'Rejected.')) {
      const job = { id: result.request.id, callbackRef: match[2]!, view: result.request, attempts: 0 };
      try { await this.transport.edit(job, String(callback.message.message_id), result.request.status); }
      catch { this.onError('Could not update Telegram decision message'); }
    }
  }
  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const updates = await this.transport.poll(this.core.getOffset(), this.controller.signal);
        this.pollReady = true;
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          if (update.update_id < this.core.getOffset()) continue;
          await this.process(update);
          this.core.saveOffset(update.update_id + 1);
        }
      } catch (error) {
        if (this.stopped || error instanceof Error && error.name === 'AbortError') break;
        this.pollReady = false;
        if (error instanceof TelegramApiError && error.kind === 'conflict') {
          this.onError('Another poller is using this bot token. Stop it or use a dedicated bot.');
          break;
        }
        this.onError(error instanceof TelegramApiError ? `Telegram polling failed (${error.kind})` : 'Telegram polling failed');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally { this.controller = null; }
    }
  }
}
