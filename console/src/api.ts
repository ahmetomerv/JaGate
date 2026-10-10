import type {
  ClientKeyView,
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
} from '../../src/client.js';
import type { ConsoleKeyScope } from './scopes.js';
import { ApiError, ApprovalClient } from '../../src/client.js';
import { consoleKeyScopes } from './scopes.js';

export type ConsoleRole = 'bootstrap' | 'issued';

export const consoleApiMethodNames = [
  'listRequests',
  'getRequest',
  'getRequestEvents',
  'cancel',
  'listClientKeys',
  'createClientKey',
  'revokeClientKey',
  'listAuditEvents',
] as const;

const hiddenApiMethods = ['createRequest', 'claim', 'reportResult', 'waitForDecision'] as const;

export interface ConsoleApi {
  listRequests: (query?: ListRequestsQuery, signal?: AbortSignal) => Promise<ListRequestsPage>;
  getRequest: (id: string, signal?: AbortSignal) => Promise<RequestView>;
  getRequestEvents: (
    id: string,
    query?: RequestEventsQuery,
    signal?: AbortSignal,
  ) => Promise<RequestEventsPage>;
  cancel: (id: string, signal?: AbortSignal) => Promise<RequestView>;
  listClientKeys: (query?: ListClientKeysQuery, signal?: AbortSignal) => Promise<ListClientKeysPage>;
  createClientKey: (
    input: { label: string; scopes: ConsoleKeyScope[]; expiresAt?: string },
    signal?: AbortSignal,
  ) => Promise<IssuedClientKey>;
  revokeClientKey: (id: string, signal?: AbortSignal) => Promise<ClientKeyView>;
  listAuditEvents: (query?: ListAuditEventsQuery, signal?: AbortSignal) => Promise<ListAuditEventsPage>;
}

export function createConsoleApi(options: {
  baseUrl: string;
  getKey: () => string;
  fetch?: typeof fetch;
  onUnauthorized: () => void;
}): ConsoleApi {
  async function call<T>(run: (client: ApprovalClient) => Promise<T>): Promise<T> {
    try {
      return await run(new ApprovalClient({
        baseUrl: options.baseUrl,
        apiKey: options.getKey(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }));
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401)
        options.onUnauthorized();
      throw error;
    }
  }

  const api: ConsoleApi = {
    listRequests: (query, signal) => call(client => client.listRequests(query, signal)),
    getRequest: (id, signal) => call(client => client.getRequest(id, signal)),
    getRequestEvents: (id, query, signal) => call(client => client.getRequestEvents(id, query, signal)),
    cancel: (id, signal) => call(client => client.cancel(id, signal)),
    listClientKeys: (query, signal) => call(client => client.listClientKeys(query, signal)),
    createClientKey: (input, signal) => call(client => client.createClientKey(input, signal)),
    revokeClientKey: (id, signal) => call(client => client.revokeClientKey(id, signal)),
    listAuditEvents: (query, signal) => call(client => client.listAuditEvents(query, signal)),
  };
  for (const method of hiddenApiMethods) {
    if (method in api)
      throw new Error(`console API must not expose ${method}`);
  }
  return api;
}

export async function classifyKey(listKeys: () => Promise<unknown>): Promise<ConsoleRole> {
  try {
    await listKeys();
    return 'bootstrap';
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 403)
      return 'issued';
    throw error;
  }
}

export function assertScopeList(scopes: readonly string[]): ConsoleKeyScope[] {
  const allowed = new Set<string>(consoleKeyScopes);
  if (scopes.length === 0 || scopes.some(scope => !allowed.has(scope)))
    throw new Error('scopes must be known console key scopes');
  return scopes as ConsoleKeyScope[];
}
