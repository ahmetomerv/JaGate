import type { CreateRequestInput, RequestView } from './model.js';

export type { CreateRequestInput, RequestView } from './model.js';
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export class WaitTimeoutError extends Error { constructor() { super('client-side wait timed out before a decision'); } }

export class ApprovalClient {
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; pollIntervalMs?: number }) {}
  private async call<T>(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.baseUrl), {
      method, headers: { authorization: `Bearer ${this.options.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const data = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new ApiError(response.status, data.error?.code ?? 'unknown_error', data.error?.message ?? 'request failed');
    return data;
  }
  createRequest(input: CreateRequestInput, signal?: AbortSignal): Promise<RequestView> { return this.call('/v1/requests', 'POST', input, signal); }
  getRequest(id: string, signal?: AbortSignal): Promise<RequestView> { return this.call(`/v1/requests/${encodeURIComponent(id)}`, 'GET', undefined, signal); }
  cancel(id: string, signal?: AbortSignal): Promise<RequestView> { return this.call(`/v1/requests/${encodeURIComponent(id)}/cancel`, 'POST', {}, signal); }
  claim(id: string, signal?: AbortSignal): Promise<{ claimId: string; claimToken: string; request: RequestView }> { return this.call(`/v1/requests/${encodeURIComponent(id)}/claim`, 'POST', {}, signal); }
  reportResult(id: string, input: { claimToken: string; status: 'succeeded' | 'failed'; summary: string }, signal?: AbortSignal): Promise<RequestView> {
    return this.call(`/v1/requests/${encodeURIComponent(id)}/result`, 'POST', input, signal);
  }
  async waitForDecision(id: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RequestView> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new RangeError('timeoutMs must be nonnegative');
    const deadline = Date.now() + options.timeoutMs;
    const interval = this.options.pollIntervalMs ?? 2000;
    if (!Number.isFinite(interval) || interval < 10) throw new RangeError('pollIntervalMs must be at least 10');
    for (;;) {
      options.signal?.throwIfAborted();
      if (Date.now() > deadline) throw new WaitTimeoutError();
      const controller = new AbortController();
      const remaining = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => controller.abort(new WaitTimeoutError()), remaining);
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        const request = await this.getRequest(id, controller.signal);
        if (request.status !== 'pending') return request;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (controller.signal.aborted) throw new WaitTimeoutError();
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
      const wait = Math.min(interval, deadline - Date.now());
      if (wait <= 0) throw new WaitTimeoutError();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolve(); }, wait);
        const onAbort = () => { clearTimeout(timer); reject(options.signal?.reason); };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}
