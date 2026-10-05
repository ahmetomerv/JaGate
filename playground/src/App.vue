<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

type Mode = 'simulated' | 'live';
type Operation = 'create' | 'list' | 'get' | 'events' | 'cancel' | 'claim' | 'result' | 'keyCreate' | 'keyList' | 'keyRevoke' | 'health' | 'ready';
type ClientKeyScope = 'requests:create' | 'requests:read' | 'requests:cancel' | 'requests:claim' | 'requests:result';
type ClientKeyView = { id: string; clientId: string; label: string; scopes: ClientKeyScope[]; createdAt: string; revokedAt: string | null };
type KeyPage = { items: ClientKeyView[]; nextCursor: string | null };
type RequestView = {
  id: string; clientId: string; title: string; action: string; status: string; executionStatus: string;
  deliveryStatus: string; deliveryAttempts: number; createdAt: string; expiresAt: string; claimedAt: string | null; resultSummary: string | null;
};
type ListPage = { items: RequestView[]; nextCursor: string | null };
type RequestEvent = { sequence: number; type: string; occurredAt: string; actorId: string | null; attempt: number | null };
type EventPage = { items: RequestEvent[]; nextCursor: string | null };
type Entry = { time: string; label: string; status: number; body: unknown };
type Bootstrap = { token: string; simulatedClients: string[]; liveClients: string[]; gatewayUrl: string; simulatedNow: string };

const bootstrap = ref<Bootstrap | null>(null);
const mode = ref<Mode>('simulated');
const clientId = ref('website');
const auth = ref<'valid' | 'scoped' | 'missing' | 'invalid'>('valid');
const scopedKey = ref('');
const showScopedKey = ref(false);
const keyId = ref('');
const keyLabel = ref('Local worker');
const keyScopes = ref<ClientKeyScope[]>(['requests:create', 'requests:read']);
const availableKeyScopes: ClientKeyScope[] = ['requests:create', 'requests:read', 'requests:cancel', 'requests:claim', 'requests:result'];
const keyPage = ref<KeyPage | null>(null);
const keyLimit = ref(20);
const keyCursor = ref('');
const keyCursorStack = ref<string[]>([]);
const requestId = ref('');
const history = ref<RequestView[]>([]);
const listPage = ref<ListPage | null>(null);
const listStatus = ref('');
const listDeliveryStatus = ref('');
const listExecutionStatus = ref('');
const listClaimedBefore = ref('');
const listExpiresBefore = ref('');
const attentionMinutes = ref(10);
const simulatedClockOffset = ref(0);
const listLimit = ref(20);
const listCursor = ref('');
const listCursorStack = ref<string[]>([]);
const eventPage = ref<EventPage | null>(null);
const eventLimit = ref(20);
const eventCursor = ref('');
const eventCursorStack = ref<string[]>([]);
const entries = ref<Entry[]>([]);
const busy = ref(false);
const error = ref('');
const key = ref(`playground:${Date.now()}`);
const action = ref('test-action');
const title = ref('Test a local approval');
const description = ref('A harmless request made from the JaGate playground.');
const expiresInSeconds = ref(900);
const detailsText = ref('[{"label":"Environment","value":"local"}]');
const metadataText = ref('{"source":"playground"}');
const actor = ref<'allowed' | 'outsider'>('allowed');
const advanceSeconds = ref(61);
const claimToken = ref('');
const showClaimToken = ref(false);
const resultStatus = ref<'succeeded' | 'failed'>('succeeded');
const resultSummary = ref('Local test completed');
const operation = ref<Operation>('create');
const requestTab = ref<'body' | 'preview'>('body');
const responseTab = ref<'body' | 'history'>('body');
const activeEntry = ref<number | null>(null);
const copied = ref(false);

const endpoints: Array<{ operation: Operation; method: 'GET' | 'POST'; label: string; path: string }> = [
  { operation: 'create', method: 'POST', label: 'Create request', path: '/v1/requests' },
  { operation: 'list', method: 'GET', label: 'List requests', path: '/v1/requests' },
  { operation: 'get', method: 'GET', label: 'Get request', path: '/v1/requests/:id' },
  { operation: 'events', method: 'GET', label: 'Request timeline', path: '/v1/requests/:id/events' },
  { operation: 'cancel', method: 'POST', label: 'Cancel request', path: '/v1/requests/:id/cancel' },
  { operation: 'claim', method: 'POST', label: 'Claim approval', path: '/v1/requests/:id/claim' },
  { operation: 'result', method: 'POST', label: 'Report result', path: '/v1/requests/:id/result' },
  { operation: 'keyCreate', method: 'POST', label: 'Create client key', path: '/v1/client-keys' },
  { operation: 'keyList', method: 'GET', label: 'List client keys', path: '/v1/client-keys' },
  { operation: 'keyRevoke', method: 'POST', label: 'Revoke client key', path: '/v1/client-keys/:id/revoke' },
  { operation: 'health', method: 'GET', label: 'Health', path: '/health' },
  { operation: 'ready', method: 'GET', label: 'Readiness', path: '/ready' },
];
const requestEndpoints = endpoints.filter((item) => !item.operation.startsWith('key') && !['health', 'ready'].includes(item.operation));
const keyEndpoints = endpoints.filter((item) => item.operation.startsWith('key'));
const utilityEndpoints = endpoints.filter((item) => ['health', 'ready'].includes(item.operation));

const clients = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedClients ?? [] : bootstrap.value?.liveClients ?? []);
const selected = computed(() => [...history.value, ...(listPage.value?.items ?? [])].find((item) => item.id === requestId.value));
const visibleEntry = computed(() => activeEntry.value === null ? undefined : entries.value[activeEntry.value]);
const endpoint = computed(() => endpoints.find((item) => item.operation === operation.value)!);
const listFilters = computed(() => ({
  ...(listStatus.value ? { status: listStatus.value } : {}),
  ...(listDeliveryStatus.value ? { deliveryStatus: listDeliveryStatus.value } : {}),
  ...(listExecutionStatus.value ? { executionStatus: listExecutionStatus.value } : {}),
  ...(listClaimedBefore.value ? { claimedBefore: listClaimedBefore.value } : {}),
  ...(listExpiresBefore.value ? { expiresBefore: listExpiresBefore.value } : {}),
  limit: Number(listLimit.value),
  ...(listCursor.value ? { cursor: listCursor.value } : {}),
}));
const eventFilters = computed(() => ({ limit: Number(eventLimit.value), ...(eventCursor.value ? { cursor: eventCursor.value } : {}) }));
const keyFilters = computed(() => ({ limit: Number(keyLimit.value), ...(keyCursor.value ? { cursor: keyCursor.value } : {}) }));
const requestPath = computed(() => {
  const path = endpoint.value.path.replace(':id', operation.value === 'keyRevoke' ? keyId.value || ':id' : requestId.value || ':id');
  const query = operation.value === 'list' ? listFilters.value : operation.value === 'events' ? eventFilters.value : operation.value === 'keyList' ? keyFilters.value : null;
  return query ? `${path}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()}` : path;
});
const needsRequestId = computed(() => ['get', 'events', 'cancel', 'claim', 'result'].includes(operation.value));
const needsKeyId = computed(() => operation.value === 'keyRevoke');
const previewBody = computed(() => operation.value === 'create' ? {
  idempotencyKey: key.value, action: action.value, title: title.value, description: description.value,
  details: parsePreview(detailsText.value), metadata: parsePreview(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
} : operation.value === 'result' ? {
  claimToken: claimToken.value, status: resultStatus.value, summary: resultSummary.value,
} : operation.value === 'keyCreate' ? { label: keyLabel.value, scopes: keyScopes.value }
  : operation.value === 'list' ? listFilters.value : operation.value === 'events' ? eventFilters.value : operation.value === 'keyList' ? keyFilters.value : {});

watch([listStatus, listDeliveryStatus, listExecutionStatus, listClaimedBefore, listExpiresBefore, listLimit, clientId, mode], () => {
  listCursor.value = '';
  listCursorStack.value = [];
  listPage.value = null;
});

function applyAttention(kind: 'all' | 'delivery' | 'claimed' | 'expiry') {
  const minutes = Number(attentionMinutes.value);
  if (kind !== 'all' && kind !== 'delivery' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
    error.value = 'Choose a window from 1 to 1440 minutes.';
    return;
  }
  error.value = '';
  const now = Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0);
  listStatus.value = kind === 'delivery' || kind === 'expiry' ? 'pending' : kind === 'claimed' ? 'approved' : '';
  listDeliveryStatus.value = kind === 'delivery' ? 'failed' : '';
  listExecutionStatus.value = kind === 'claimed' ? 'claimed' : '';
  listClaimedBefore.value = kind === 'claimed' ? new Date(now - minutes * 60_000).toISOString() : '';
  listExpiresBefore.value = kind === 'expiry' ? new Date(now + minutes * 60_000).toISOString() : '';
}
watch([clientId, mode], () => {
  clearDisplayedResponse();
  error.value = '';
  history.value = [];
  void refreshHistory();
});
watch([requestId, clientId, mode, eventLimit], () => {
  eventPage.value = null;
  eventCursor.value = '';
  eventCursorStack.value = [];
});
watch([clientId, mode, keyLimit], () => {
  keyPage.value = null;
  keyCursor.value = '';
  keyCursorStack.value = [];
});
watch([clientId, mode], () => {
  scopedKey.value = '';
  keyId.value = '';
  auth.value = 'valid';
});

function parsePreview(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function clearDisplayedResponse() {
  activeEntry.value = null;
  responseTab.value = 'body';
  copied.value = false;
}

function selectOperation(next: Operation) {
  if (next !== operation.value) {
    clearDisplayedResponse();
    eventPage.value = null;
    eventCursor.value = '';
    eventCursorStack.value = [];
    keyPage.value = null;
    keyCursor.value = '';
    keyCursorStack.value = [];
  }
  operation.value = next;
  requestTab.value = 'body';
  error.value = '';
}

function selectRequest(item: RequestView) {
  if (requestId.value !== item.id) {
    claimToken.value = '';
    clearDisplayedResponse();
  }
  requestId.value = item.id;
  selectOperation('get');
}

function remember(item: RequestView) {
  history.value = [item, ...history.value.filter((existing) => existing.id !== item.id)].slice(0, 100);
}

async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-playground-token': bootstrap.value!.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Playground error ${response.status}`);
  return data;
}

function record(label: string, status: number, body: unknown, show = true) {
  entries.value = [{ time: new Date().toLocaleTimeString(), label, status, body }, ...entries.value].slice(0, 20);
  if (show) {
    activeEntry.value = 0;
    responseTab.value = 'body';
    copied.value = false;
  } else if (activeEntry.value !== null) {
    activeEntry.value = activeEntry.value + 1 < entries.value.length ? activeEntry.value + 1 : null;
  }
}

async function copyResponse() {
  if (!visibleEntry.value) return;
  await navigator.clipboard.writeText(JSON.stringify(visibleEntry.value.body, null, 2));
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1800);
}

async function refreshHistory() {
  if (!bootstrap.value || !clientId.value) { history.value = []; return; }
  const currentMode = mode.value;
  const currentClient = clientId.value;
  try {
    const response = await api('/api/execute', { mode: currentMode, clientId: currentClient, operation: 'list', auth: 'valid', filters: { limit: 20 } }) as { status: number; body: ListPage };
    if (currentMode === mode.value && currentClient === clientId.value) history.value = response.status === 200 ? response.body.items : [];
  } catch { if (currentMode === mode.value && currentClient === clientId.value) history.value = []; }
}

function changeMode(next: Mode) {
  mode.value = next;
  clientId.value = clients.value[0] ?? '';
  requestId.value = '';
  claimToken.value = '';
  scopedKey.value = '';
  error.value = '';
}

async function execute(sentOperation: Operation) {
  if (!bootstrap.value || busy.value) return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  const sentKeyId = keyId.value;
  let payload: unknown;
  try {
    if (sentOperation === 'create') payload = {
      idempotencyKey: key.value, action: action.value, title: title.value, description: description.value,
      details: JSON.parse(detailsText.value), metadata: JSON.parse(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
    };
    if (sentOperation === 'result') payload = { claimToken: claimToken.value, status: resultStatus.value, summary: resultSummary.value };
    if (sentOperation === 'keyCreate') payload = { label: keyLabel.value, scopes: keyScopes.value };
    busy.value = true;
    const response = await api('/api/execute', {
      mode: sentMode, clientId: sentClient, operation: sentOperation, auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}), requestId: requestId.value, keyId: keyId.value,
      ...(sentOperation === 'list' ? { filters: listFilters.value } : {}),
      ...(sentOperation === 'events' ? { eventPage: eventFilters.value } : {}),
      ...(sentOperation === 'keyList' ? { keyPage: keyFilters.value } : {}), payload,
    }) as { status: number; body: Record<string, unknown> };
    const current = sentMode === mode.value && sentClient === clientId.value && sentOperation === operation.value &&
      (sentOperation !== 'events' || sentRequestId === requestId.value) && (sentOperation !== 'keyRevoke' || sentKeyId === keyId.value);
    record(`${sentOperation.toUpperCase()} · ${sentClient} · ${sentMode}`, response.status, response.body, current);
    if (!current) return;
    if (sentOperation === 'list') listPage.value = response.status === 200 ? response.body as unknown as ListPage : null;
    if (sentOperation === 'events') eventPage.value = response.status === 200 ? response.body as unknown as EventPage : null;
    if (sentOperation === 'keyList') keyPage.value = response.status === 200 ? response.body as unknown as KeyPage : null;
    if (sentOperation === 'keyCreate' && response.status === 201) {
      keyId.value = String(response.body.id);
      scopedKey.value = String(response.body.key);
      keyPage.value = null;
    }
    if (sentOperation === 'keyRevoke' && response.status === 200) keyPage.value = null;
    const view = sentOperation === 'claim' ? response.body.request : response.body;
    if (['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation) && view && typeof view === 'object' && 'id' in view) {
      const item = view as RequestView;
      if (requestId.value !== item.id && sentOperation !== 'claim') claimToken.value = '';
      remember(item);
      requestId.value = item.id;
    }
    if (sentOperation === 'claim' && typeof response.body.claimToken === 'string') claimToken.value = response.body.claimToken;
    if (['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation)) await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value && sentOperation === operation.value)
      error.value = cause instanceof Error ? cause.message : 'Request failed';
  }
  finally { busy.value = false; }
}

async function nextPage() {
  if (!listPage.value?.nextCursor || busy.value) return;
  listCursorStack.value.push(listCursor.value);
  listCursor.value = listPage.value.nextCursor;
  await execute('list');
}

async function previousPage() {
  if (!listCursorStack.value.length || busy.value) return;
  listCursor.value = listCursorStack.value.pop()!;
  await execute('list');
}

async function nextEventPage() {
  if (!eventPage.value?.nextCursor || busy.value) return;
  eventCursorStack.value.push(eventCursor.value);
  eventCursor.value = eventPage.value.nextCursor;
  await execute('events');
}

async function previousEventPage() {
  if (!eventCursorStack.value.length || busy.value) return;
  eventCursor.value = eventCursorStack.value.pop()!;
  await execute('events');
}

async function nextKeyPage() {
  if (!keyPage.value?.nextCursor || busy.value) return;
  keyCursorStack.value.push(keyCursor.value);
  keyCursor.value = keyPage.value.nextCursor;
  await execute('keyList');
}

async function previousKeyPage() {
  if (!keyCursorStack.value.length || busy.value) return;
  keyCursor.value = keyCursorStack.value.pop()!;
  await execute('keyList');
}

function selectClientKey(item: ClientKeyView) {
  keyId.value = item.id;
  selectOperation('keyRevoke');
}

function eventLabel(type: string): string {
  return ({
    'request.created': 'Request created',
    'delivery.retry_scheduled': 'Delivery retry scheduled', 'delivery.failed': 'Delivery failed',
    'delivery.delivered': 'Delivered to Telegram', 'delivery.requeued': 'Delivery requeued',
    'decision.approved': 'Approved', 'decision.rejected': 'Rejected',
    'decision.expired': 'Expired', 'decision.cancelled': 'Cancelled',
    'execution.claimed': 'Execution claimed', 'execution.succeeded': 'Result reported: succeeded',
    'execution.failed': 'Result reported: failed',
  } as Record<string, string>)[type] ?? type;
}

async function decide(decision: 'approve' | 'reject') {
  if (busy.value || !requestId.value) return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  const sentOperation = operation.value;
  try {
    busy.value = true;
    const response = await api('/api/decide', { requestId: sentRequestId, clientId: sentClient, decision, actor: actor.value }) as { message: string; request: RequestView };
    const current = sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value && sentOperation === operation.value;
    record(`${decision.toUpperCase()} · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current) return;
    remember(response.request);
    eventPage.value = null;
    await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value && sentOperation === operation.value)
      error.value = cause instanceof Error ? cause.message : 'Decision failed';
  }
  finally { busy.value = false; }
}

async function advanceTime() {
  if (busy.value) return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentOperation = operation.value;
  try {
    busy.value = true;
    const response = await api('/api/advance-time', { seconds: Number(advanceSeconds.value) });
    if (typeof (response as { now?: unknown }).now === 'string') simulatedClockOffset.value = Date.parse((response as { now: string }).now) - Date.now();
    const current = sentMode === mode.value && sentClient === clientId.value && sentOperation === operation.value;
    record(`ADVANCE CLOCK · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current) return;
    eventPage.value = null;
    await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value && sentOperation === operation.value)
      error.value = cause instanceof Error ? cause.message : 'Clock change failed';
  }
  finally { busy.value = false; }
}

onMounted(async () => {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('Could not start the playground');
    bootstrap.value = await response.json() as Bootstrap;
    const simulatedNow = Date.parse(bootstrap.value.simulatedNow);
    simulatedClockOffset.value = Number.isFinite(simulatedNow) ? simulatedNow - Date.now() : 0;
    clientId.value = bootstrap.value.simulatedClients[0] ?? '';
    await refreshHistory();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start the playground'; }
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand"><img class="brand-mark" src="/logo.svg" alt="" width="28" height="28" /><span>JaGate <span class="brand-divider">/</span> Playground</span><span class="dev-badge">LOCAL</span></div>
      <div class="header-right"><span class="header-caption">Approval API workbench</span><a href="https://github.com/ahmetomerv/JaGate/blob/main/docs/guide/playground.md" target="_blank" rel="noreferrer">Usage guide ↗</a></div>
    </header>

    <div class="environment-bar">
      <div class="environment-left">
        <span class="environment-label">ENVIRONMENT</span>
        <div class="mode-switch" aria-label="Playground mode">
          <button :class="{ active: mode === 'simulated' }" :aria-pressed="mode === 'simulated'" @click="changeMode('simulated')">Simulated Telegram</button>
          <button :class="{ active: mode === 'live' }" :aria-pressed="mode === 'live'" @click="changeMode('live')">Real gateway</button>
        </div>
        <span class="environment-address">{{ mode === 'simulated' ? 'Local simulator · isolated database' : bootstrap?.gatewayUrl }}</span>
      </div>
      <div class="environment-right">
        <label class="inline-field">Client <select v-model="clientId" :disabled="!clients.length"><option v-for="id in clients" :key="id" :value="id">{{ id }}</option></select></label>
        <label class="inline-field">Auth <select v-model="auth"><option value="valid">Bootstrap key</option><option value="scoped">Issued key</option><option value="missing">Missing key</option><option value="invalid">Invalid key</option></select></label>
        <label v-if="auth === 'scoped'" class="inline-field issued-key-field">Issued key <input v-model="scopedKey" :type="showScopedKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="Paste the key returned once" /><button class="subtle-button" @click="showScopedKey = !showScopedKey">{{ showScopedKey ? 'Hide' : 'Show' }}</button></label>
      </div>
    </div>

    <div v-if="error" class="global-notice" role="alert">{{ error }}</div>
    <div v-if="mode === 'live' && !clients.length" class="global-notice">Live mode needs CLIENT_KEYS in your local .env and a running gateway.</div>

    <main class="workspace">
      <aside class="sidebar">
        <div class="sidebar-section">
          <div class="sidebar-heading"><span>REQUESTS</span><span class="count">{{ requestEndpoints.length }}</span></div>
          <button v-for="item in requestEndpoints" :key="item.operation" class="endpoint-item" :class="{ active: operation === item.operation }" @click="selectOperation(item.operation)">
            <span class="method" :class="item.method.toLowerCase()">{{ item.method }}</span><span class="endpoint-label">{{ item.label }}</span>
          </button>
        </div>
        <div class="sidebar-section key-section">
          <div class="sidebar-heading"><span>CLIENT KEYS</span><span class="count">{{ keyEndpoints.length }}</span></div>
          <button v-for="item in keyEndpoints" :key="item.operation" class="endpoint-item" :class="{ active: operation === item.operation }" @click="selectOperation(item.operation)">
            <span class="method" :class="item.method.toLowerCase()">{{ item.method }}</span><span class="endpoint-label">{{ item.label }}</span>
          </button>
        </div>
        <div class="sidebar-section utility-section">
          <div class="sidebar-heading"><span>STATUS</span></div>
          <button v-for="item in utilityEndpoints" :key="item.operation" class="endpoint-item" :class="{ active: operation === item.operation }" @click="selectOperation(item.operation)">
            <span class="method" :class="item.method.toLowerCase()">{{ item.method }}</span><span class="endpoint-label">{{ item.label }}</span>
          </button>
        </div>
        <div class="sidebar-section recent-section">
          <div class="sidebar-heading"><span>RECENT · {{ clientId }}</span><button class="icon-button" title="Refresh recent requests" aria-label="Refresh recent requests" @click="refreshHistory">↻</button></div>
          <p v-if="!history.length" class="sidebar-empty">Create a request to see it here.</p>
          <button v-for="item in history" :key="item.id" class="recent-item" :class="{ active: requestId === item.id }" :aria-pressed="requestId === item.id" @click="selectRequest(item)">
            <span class="recent-title">{{ item.title }}</span>
            <span class="recent-meta"><span>{{ item.clientId }} · {{ item.id.slice(0, 8) }}</span><span class="state-dot" :class="item.status"></span></span>
          </button>
        </div>
        <div class="sidebar-footer"><span class="footer-dot"></span>Development only<span class="footer-version">v0.1</span></div>
      </aside>

      <div class="workbench">
        <div class="document-tab"><span class="tab-method" :class="endpoint.method.toLowerCase()">{{ endpoint.method }}</span>{{ endpoint.label }}<span class="tab-dot"></span></div>
        <section class="request-section">
          <div class="section-title-row"><div><p class="kicker">REQUEST BUILDER</p><h1>{{ endpoint.label }}</h1></div><span class="scope-label">{{ mode === 'simulated' ? 'SIMULATION' : 'LIVE GATEWAY' }}</span></div>
          <div class="request-bar">
            <span class="request-method" :class="endpoint.method.toLowerCase()">{{ endpoint.method }}<span class="chevron">⌄</span></span>
            <div class="url-field"><span class="url-origin">{{ mode === 'simulated' ? 'simulated://jagate' : bootstrap?.gatewayUrl }}</span><strong>{{ requestPath }}</strong></div>
            <button class="send-button" :disabled="busy || !clientId || (needsRequestId && !requestId) || (needsKeyId && !keyId) || (auth === 'scoped' && !scopedKey)" @click="execute(operation)">{{ busy ? 'Sending…' : 'Send' }} <span>➜</span></button>
          </div>
          <div class="request-tabs" role="tablist" aria-label="Request editor">
            <button role="tab" :aria-selected="requestTab === 'body'" :class="{ active: requestTab === 'body' }" @click="requestTab = 'body'">{{ needsRequestId || needsKeyId ? 'Params & body' : operation === 'create' || operation === 'keyCreate' ? 'Body' : operation === 'list' || operation === 'keyList' ? 'Filters' : 'Overview' }}</button>
            <button role="tab" :aria-selected="requestTab === 'preview'" :class="{ active: requestTab === 'preview' }" @click="requestTab = 'preview'">JSON preview</button>
            <span class="tabs-spacer"></span><span class="auth-summary">Authorization <strong>{{ auth === 'valid' ? 'Bootstrap key' : auth === 'scoped' ? 'Issued key' : auth === 'missing' ? 'None' : 'Invalid key' }}</strong></span>
          </div>

          <div v-if="requestTab === 'preview'" class="editor-body preview-body">
            <div class="editor-caption"><span>{{ operation === 'list' || operation === 'events' || operation === 'keyList' ? 'QUERY PARAMETERS' : 'REQUEST BODY' }}</span><span>Read only preview</span></div>
            <pre>{{ JSON.stringify(previewBody, null, 2) }}</pre>
            <p v-if="operation === 'create' || operation === 'result' || operation === 'keyCreate'" class="help-text">Edit values in the {{ needsRequestId ? 'Params & body' : 'Body' }} tab.</p>
            <p v-else-if="operation !== 'list' && operation !== 'events' && operation !== 'keyList'" class="help-text">This endpoint does not require a request body.</p>
          </div>

          <div v-else class="editor-body">
            <template v-if="operation === 'create'">
              <div class="editor-caption"><span>APPLICATION / JSON</span><span>Approval payload</span></div>
              <div class="form-grid">
                <label>Idempotency key<input v-model="key" maxlength="128" /></label>
                <label>Action<input v-model="action" maxlength="64" /></label>
                <label class="span-2">Title<input v-model="title" maxlength="100" /></label>
                <label class="span-2">Description<textarea v-model="description" rows="2" maxlength="1000" /></label>
                <label>Expires in seconds<input v-model.number="expiresInSeconds" type="number" min="60" max="86400" /></label>
                <div class="field-aside"><button class="subtle-button" @click="key = 'playground:' + Date.now()">↻ Generate new key</button><span>Reuse the key to test idempotency.</span></div>
                <label class="span-2">Details <span class="label-type">JSON array</span><textarea v-model="detailsText" rows="2" spellcheck="false" class="code-input" /></label>
                <label class="span-2">Metadata <span class="label-type">JSON object</span><textarea v-model="metadataText" rows="2" spellcheck="false" class="code-input" /></label>
              </div>
            </template>
            <template v-else-if="operation === 'list'">
              <div class="editor-caption"><span>QUERY PARAMETERS</span><span>Only the selected client's requests</span></div>
              <div class="attention-shortcuts" role="group" aria-label="Requests needing attention">
                <strong>Requests needing attention</strong>
                <div class="attention-actions">
                  <button type="button" class="utility-button" :disabled="busy" @click="applyAttention('delivery')">Failed delivery</button>
                  <button type="button" class="utility-button" :disabled="busy" @click="applyAttention('claimed')">Old claims</button>
                  <button type="button" class="utility-button" :disabled="busy" @click="applyAttention('expiry')">Expiring soon</button>
                  <button type="button" class="utility-button" :disabled="busy" @click="applyAttention('all')">Clear filters</button>
                </div>
                <label>Window (minutes)<input v-model.number="attentionMinutes" type="number" min="1" max="1440" /></label>
              </div>
              <div class="form-grid list-filter-grid">
                <label>Decision status<select v-model="listStatus"><option value="">Any</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label>
                <label>Delivery status<select v-model="listDeliveryStatus"><option value="">Any</option><option value="pending">Pending</option><option value="retrying">Retrying</option><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label>
                <label>Execution status<select v-model="listExecutionStatus"><option value="">Any</option><option value="unclaimed">Unclaimed</option><option value="claimed">Claimed</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
                <label>Page size<input v-model.number="listLimit" type="number" min="1" max="100" /></label>
                <label>Claimed before <span class="label-type">UTC ISO 8601</span><input v-model.trim="listClaimedBefore" type="text" placeholder="2026-10-05T12:00:00.000Z" spellcheck="false" /></label>
                <label>Expires before <span class="label-type">UTC ISO 8601</span><input v-model.trim="listExpiresBefore" type="text" placeholder="2026-10-05T12:00:00.000Z" spellcheck="false" /></label>
              </div>
              <p class="help-text">Shortcuts set fixed UTC cutoffs using the selected clock. Send to load a page; keep those cutoffs when paging. Old claims need reconciliation before any retry.</p>
            </template>
            <template v-else-if="operation === 'keyCreate'">
              <div class="editor-caption"><span>APPLICATION / JSON</span><span>Bootstrap key required</span></div>
              <div class="form-grid"><label class="span-2">Key label<input v-model="keyLabel" maxlength="80" placeholder="Name the app or worker" /></label></div>
              <fieldset class="scope-fieldset"><legend>Allowed request operations</legend><label v-for="scope in availableKeyScopes" :key="scope" class="scope-option"><input v-model="keyScopes" type="checkbox" :value="scope" />{{ scope }}</label></fieldset>
              <p class="help-text">The new key appears only in the creation response. It also fills the Issued key field for this browser session; copy it before leaving.</p>
            </template>
            <template v-else-if="operation === 'keyList'">
              <div class="editor-caption"><span>QUERY PARAMETERS</span><span>Bootstrap key required</span></div>
              <div class="form-grid"><label>Page size<input v-model.number="keyLimit" type="number" min="1" max="100" /></label></div>
              <p class="help-text">Lists this client's issued keys, including revoked keys. Secret values are never returned here.</p>
            </template>
            <template v-else-if="operation === 'keyRevoke'">
              <div class="editor-caption"><span>PATH PARAMETERS</span><span>Bootstrap key required</span></div>
              <div class="form-grid"><label class="span-2">Client key ID<input v-model="keyId" placeholder="Select a listed key or paste its UUID" spellcheck="false" /></label></div>
              <p class="help-text">Revocation takes effect on the next API request. The configured bootstrap key is rotated in .env, not here.</p>
            </template>
            <template v-else-if="needsRequestId">
              <div class="editor-caption"><span>PATH PARAMETERS</span><span>Required</span></div>
              <div class="form-grid"><label class="span-2">Request ID<input v-model="requestId" placeholder="Select a recent request or paste its UUID" spellcheck="false" /></label></div>
              <div v-if="operation === 'events'" class="form-grid timeline-options"><label>Page size<input v-model.number="eventLimit" type="number" min="1" max="100" /></label><p class="help-text">Oldest events first. Each event records a gateway state change; no action is executed here.</p></div>
              <template v-if="operation === 'result'">
                <div class="editor-caption body-caption"><span>APPLICATION / JSON</span><span>Execution result</span></div>
                <div class="form-grid">
                  <label class="span-2">Claim token<div class="token-field"><input v-model="claimToken" :type="showClaimToken ? 'text' : 'password'" autocomplete="off" placeholder="Filled after a successful claim" /><button class="subtle-button" @click="showClaimToken = !showClaimToken">{{ showClaimToken ? 'Hide' : 'Show' }}</button></div></label>
                  <label>Result<select v-model="resultStatus"><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
                  <label>Summary<input v-model="resultSummary" maxlength="300" /></label>
                </div>
                <p class="help-text">This reports an outcome. The playground does not execute the proposed action.</p>
              </template>
              <div v-else-if="selected" class="request-facts">
                <div><span>DECISION</span><strong>{{ selected.status }}</strong></div><div><span>DELIVERY</span><strong>{{ selected.deliveryStatus }}</strong></div>
                <div><span>EXECUTION</span><strong>{{ selected.executionStatus }}</strong></div><div><span>EXPIRES</span><strong>{{ new Date(selected.expiresAt).toLocaleString() }}</strong></div>
              </div>
              <p v-if="operation === 'claim'" class="help-text">Claim an approved request once. The token appears in the response and fills the report form.</p>
              <p v-if="operation === 'cancel'" class="help-text">Cancels a pending approval. The request cannot be decided afterward.</p>
            </template>
            <template v-else>
              <div class="overview-state"><span class="overview-icon">↗</span><div><strong>{{ operation === 'health' ? 'Gateway health' : 'Gateway readiness' }}</strong><p>This public endpoint does not require authorization or a request body. Click Send to inspect its response.</p></div></div>
            </template>
          </div>
        </section>

        <section v-if="operation === 'events' && eventPage" class="timeline-results" aria-label="Request timeline">
          <div class="list-results-heading"><strong>Request timeline</strong><span>{{ eventPage.items.length }} shown</span></div>
          <p v-if="!eventPage.items.length" class="list-empty">No more events for this request.</p>
          <ol v-else class="timeline-list">
            <li v-for="event in eventPage.items" :key="event.sequence" class="timeline-event">
              <span class="timeline-marker" aria-hidden="true"></span>
              <div class="timeline-event-content"><strong>{{ eventLabel(event.type) }}</strong><span class="timeline-meta">#{{ event.sequence }} · <time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time><template v-if="event.actorId"> · Approver {{ event.actorId }}</template><template v-if="event.attempt"> · Attempt {{ event.attempt }}</template></span></div>
            </li>
          </ol>
          <div class="list-pagination"><span>Page {{ eventCursorStack.length + 1 }}</span><div class="list-pagination-actions"><button class="utility-button" :disabled="busy || !eventCursorStack.length" @click="previousEventPage">← Previous</button><button class="utility-button" :disabled="busy || !eventPage.nextCursor" @click="nextEventPage">Next →</button></div></div>
        </section>

        <section v-if="operation === 'list' && listPage" class="list-results" aria-label="Listed requests">
          <div class="list-results-heading"><strong>Requests in this page</strong><span>{{ listPage.items.length }} shown</span></div>
          <p v-if="!listPage.items.length" class="list-empty">No requests match these filters.</p>
          <button v-for="item in listPage.items" :key="item.id" class="list-result" @click="selectRequest(item)">
            <span><strong>{{ item.title }}</strong><small>{{ item.id }} · {{ new Date(item.createdAt).toLocaleString() }}</small><small>Delivery: {{ item.deliveryStatus }} · Execution: {{ item.executionStatus }}<template v-if="item.claimedAt"> · Claimed: {{ new Date(item.claimedAt).toLocaleString() }}</template><template v-if="item.status === 'pending'"> · Expires: {{ new Date(item.expiresAt).toLocaleString() }}</template></small></span>
            <span class="list-result-status">{{ item.status }} <span aria-hidden="true">→</span></span>
          </button>
          <div class="list-pagination"><span>Page {{ listCursorStack.length + 1 }}</span><div class="list-pagination-actions"><button class="utility-button" :disabled="busy || !listCursorStack.length" @click="previousPage">← Previous</button><button class="utility-button" :disabled="busy || !listPage.nextCursor" @click="nextPage">Next →</button></div></div>
        </section>

        <section v-if="operation === 'keyList' && keyPage" class="list-results" aria-label="Listed client keys">
          <div class="list-results-heading"><strong>Client keys in this page</strong><span>{{ keyPage.items.length }} shown</span></div>
          <p v-if="!keyPage.items.length" class="list-empty">No issued keys on this page.</p>
          <button v-for="item in keyPage.items" :key="item.id" class="list-result" @click="selectClientKey(item)">
            <span><strong>{{ item.label }}</strong><small>{{ item.id }} · {{ item.scopes.join(', ') }}</small></span>
            <span class="list-result-status">{{ item.revokedAt ? 'Revoked' : 'Active' }} <span aria-hidden="true">→</span></span>
          </button>
          <div class="list-pagination"><span>Page {{ keyCursorStack.length + 1 }}</span><div class="list-pagination-actions"><button class="utility-button" :disabled="busy || !keyCursorStack.length" @click="previousKeyPage">← Previous</button><button class="utility-button" :disabled="busy || !keyPage.nextCursor" @click="nextKeyPage">Next →</button></div></div>
        </section>

        <section v-if="mode === 'simulated'" class="simulation-strip">
          <div class="simulation-intro"><span class="simulation-icon">◎</span><div><strong>Simulation controls</strong><span>Drive the Telegram decision and time locally.</span></div></div>
          <div class="simulation-controls"><select v-model="actor" aria-label="Decision actor"><option value="allowed">Allowlisted approver</option><option value="outsider">Outsider</option></select><button class="utility-button" :disabled="busy || !requestId" @click="decide('approve')">Approve</button><button class="utility-button" :disabled="busy || !requestId" @click="decide('reject')">Reject</button><div class="control-divider"></div><input v-model.number="advanceSeconds" type="number" min="1" max="86400" aria-label="Seconds to advance" /><span class="seconds-label">sec</span><button class="utility-button" :disabled="busy" @click="advanceTime">Advance clock</button></div>
        </section>
        <section v-else class="simulation-strip live-strip"><span class="simulation-icon">↗</span><span>Approve or reject in your configured Telegram chat, then send <strong>Get request</strong> to refresh its state.</span></section>

        <section class="response-section">
          <div class="response-heading"><div><p class="kicker">RESPONSE</p><h2>Output</h2></div><div v-if="visibleEntry" class="response-summary"><span class="http-status" :class="visibleEntry.status >= 400 ? 'error' : 'success'">HTTP {{ visibleEntry.status }}</span><span>{{ visibleEntry.time }}</span></div></div>
          <div class="response-tabs" role="tablist" aria-label="Response view"><button role="tab" :aria-selected="responseTab === 'body'" :class="{ active: responseTab === 'body' }" @click="responseTab = 'body'">Body</button><button role="tab" :aria-selected="responseTab === 'history'" :class="{ active: responseTab === 'history' }" @click="responseTab = 'history'">History <span class="history-count">{{ entries.length }}</span></button><span class="tabs-spacer"></span><button v-if="visibleEntry && responseTab === 'body'" class="copy-button" @click="copyResponse">{{ copied ? 'Copied' : 'Copy JSON' }}</button></div>
          <div v-if="responseTab === 'body'" class="response-body"><div v-if="visibleEntry" class="response-code"><div class="response-code-header"><span>{{ visibleEntry.label }}</span><span>JSON</span></div><pre>{{ JSON.stringify(visibleEntry.body, null, 2) }}</pre></div><div v-else class="response-empty"><span>↳</span><strong>Waiting for a request</strong><p>Send the selected request to see its response.<template v-if="entries.length"> Previous responses remain in History.</template></p></div></div>
          <div v-else class="history-body"><div v-if="!entries.length" class="response-empty">No responses in this session yet.</div><button v-for="(entry, index) in entries" :key="index" class="history-item" :class="{ active: activeEntry === index }" @click="activeEntry = index; responseTab = 'body'"><span class="history-status" :class="entry.status >= 400 ? 'error' : 'success'">{{ entry.status }}</span><strong>{{ entry.label }}</strong><time>{{ entry.time }}</time><span>→</span></button></div>
        </section>
      </div>
    </main>
  </div>
</template>
