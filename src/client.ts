import type {
  ClientKeyView,
  CreateClientKeyInput,
  CreateRequestInput,
  IssuedClientKey,
  ListAuditEventsPage,
  ListAuditEventsQuery,
  ListClientKeysPage,
  ListClientKeysQuery,
  ListRequestsPage,
  ListRequestsQuery,
  RequestEventsPage,
  RequestEventsQuery,
  RequestView,
} from './model.js';

export type {
  CreateRequestInput,
  ListRequestsPage,
  ListRequestsQuery,
  RequestEvent,
  RequestEventType,
  RequestEventsPage,
  RequestEventsQuery,
  RequestView,
} from './model.js';
export type {
  ClientKeyScope,
  ClientKeyView,
  CreateClientKeyInput,
  IssuedClientKey,
  ListClientKeysPage,
  ListClientKeysQuery,
} from './model.js';
export type {
  AuditEvent,
  AuditEventType,
  ListAuditEventsPage,
  ListAuditEventsQuery,
} from './model.js';
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class WaitTimeoutError extends Error {
  constructor() {
    super('client-side wait timed out before a decision');
  }
}

export class ApprovalClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetch?: typeof fetch;
      pollIntervalMs?: number;
    },
  ) {}
  private async call<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const data = (await response.json()) as T & { error?: { code: string; message: string } };
    if (!response.ok)
      throw new ApiError(
        response.status,
        data.error?.code ?? 'unknown_error',
        data.error?.message ?? 'request failed',
      );
    return data;
  }
  createRequest(input: CreateRequestInput, signal?: AbortSignal): Promise<RequestView> {
    return this.call('/v1/requests', 'POST', input, signal);
  }
  listRequests(query: ListRequestsQuery = {}, signal?: AbortSignal): Promise<ListRequestsPage> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.deliveryStatus) params.set('deliveryStatus', query.deliveryStatus);
    if (query.executionStatus) params.set('executionStatus', query.executionStatus);
    if (query.claimedBefore) params.set('claimedBefore', query.claimedBefore);
    if (query.expiresBefore) params.set('expiresBefore', query.expiresBefore);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const search = params.toString();
    return this.call(`/v1/requests${search ? `?${search}` : ''}`, 'GET', undefined, signal);
  }
  getRequest(id: string, signal?: AbortSignal): Promise<RequestView> {
    return this.call(`/v1/requests/${encodeURIComponent(id)}`, 'GET', undefined, signal);
  }
  getRequestEvents(
    id: string,
    query: RequestEventsQuery = {},
    signal?: AbortSignal,
  ): Promise<RequestEventsPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const search = params.toString();
    return this.call(
      `/v1/requests/${encodeURIComponent(id)}/events${search ? `?${search}` : ''}`,
      'GET',
      undefined,
      signal,
    );
  }
  createClientKey(input: CreateClientKeyInput, signal?: AbortSignal): Promise<IssuedClientKey> {
    return this.call('/v1/client-keys', 'POST', input, signal);
  }
  listClientKeys(
    query: ListClientKeysQuery = {},
    signal?: AbortSignal,
  ): Promise<ListClientKeysPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const search = params.toString();
    return this.call(`/v1/client-keys${search ? `?${search}` : ''}`, 'GET', undefined, signal);
  }
  listAuditEvents(
    query: ListAuditEventsQuery = {},
    signal?: AbortSignal,
  ): Promise<ListAuditEventsPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.requestId) params.set('requestId', query.requestId);
    if (query.keyId) params.set('keyId', query.keyId);
    const search = params.toString();
    return this.call(`/v1/audit-events${search ? `?${search}` : ''}`, 'GET', undefined, signal);
  }
  revokeClientKey(id: string, signal?: AbortSignal): Promise<ClientKeyView> {
    return this.call(`/v1/client-keys/${encodeURIComponent(id)}/revoke`, 'POST', {}, signal);
  }
  cancel(id: string, signal?: AbortSignal): Promise<RequestView> {
    return this.call(`/v1/requests/${encodeURIComponent(id)}/cancel`, 'POST', {}, signal);
  }
  claim(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ claimId: string; claimToken: string; request: RequestView }> {
    return this.call(`/v1/requests/${encodeURIComponent(id)}/claim`, 'POST', {}, signal);
  }
  reportResult(
    id: string,
    input: { claimToken: string; status: 'succeeded' | 'failed'; summary: string },
    signal?: AbortSignal,
  ): Promise<RequestView> {
    return this.call(`/v1/requests/${encodeURIComponent(id)}/result`, 'POST', input, signal);
  }
  async waitForDecision(
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<RequestView> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
      throw new RangeError('timeoutMs must be nonnegative');
    const deadline = Date.now() + options.timeoutMs;
    const interval = this.options.pollIntervalMs ?? 2000;
    if (!Number.isFinite(interval) || interval < 10)
      throw new RangeError('pollIntervalMs must be at least 10');
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
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, wait);
        const onAbort = () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}
