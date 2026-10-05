<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

type Mode = 'simulated' | 'live';
type Operation = 'create' | 'list' | 'get' | 'events' | 'cancel' | 'claim' | 'result' | 'keyCreate' | 'keyList' | 'keyRevoke' | 'audit' | 'health' | 'ready';
type ClientKeyScope = 'requests:create' | 'requests:read' | 'requests:cancel' | 'requests:claim' | 'requests:result';
type ClientKeyView = { id: string; clientId: string; label: string; scopes: ClientKeyScope[]; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type KeyPage = { items: ClientKeyView[]; nextCursor: string | null };
type AuditEvent = { id: number; type: string; occurredAt: string; actor: 'bootstrap' | 'issued_key'; actorKeyId: string | null; requestId: string | null; subjectKeyId: string | null };
type AuditPage = { items: AuditEvent[]; nextCursor: string | null };
type RequestView = {
  id: string; clientId: string; title: string; action: string; status: string; executionStatus: string;
  deliveryStatus: string; deliveryAttempts: number; createdAt: string; expiresAt: string; claimedAt: string | null; resultSummary: string | null;
};
type ListPage = { items: RequestView[]; nextCursor: string | null };
type RequestEvent = { sequence: number; type: string; occurredAt: string; actorId: string | null; attempt: number | null };
type EventPage = { items: RequestEvent[]; nextCursor: string | null };
type Entry = { time: string; label: string; status: number; body: unknown };
type ExampleRequest = { idempotencyKey: string; action: string; title: string; description: string;
  details: Array<{ label: string; value: string }>; metadata: Record<string, unknown>; expiresInSeconds: number };
type SimulatedExample = { label: string; scenario: string; request: ExampleRequest };
type Bootstrap = { token: string; simulatedClients: string[]; simulatedExamples: Record<string, SimulatedExample>;
  liveClients: string[]; gatewayUrl: string; simulatedNow: string };
const defaultRequest: ExampleRequest = { idempotencyKey: 'playground:local-test', action: 'test-action',
  title: 'Test a local approval', description: 'A harmless request made from the JaGate playground.',
  details: [{ label: 'Environment', value: 'local' }], metadata: { source: 'playground' }, expiresInSeconds: 900 };

const bootstrap = ref<Bootstrap | null>(null);
const mode = ref<Mode>('simulated');
const clientId = ref('');
const auth = ref<'valid' | 'scoped' | 'missing' | 'invalid'>('valid');
const scopedKey = ref('');
const showScopedKey = ref(false);
const keyId = ref('');
const keyLabel = ref('Local worker');
const keyExpiresAt = ref('');
const keyScopes = ref<ClientKeyScope[]>(['requests:create', 'requests:read']);
const availableKeyScopes: ClientKeyScope[] = ['requests:create', 'requests:read', 'requests:cancel', 'requests:claim', 'requests:result'];
const keyPage = ref<KeyPage | null>(null);
const keyLimit = ref(20);
const keyCursor = ref('');
const keyCursorStack = ref<string[]>([]);
const auditPage = ref<AuditPage | null>(null);
const auditLimit = ref(20);
const auditRequestId = ref('');
const auditKeyId = ref('');
const auditCursor = ref('');
const auditCursorStack = ref<string[]>([]);
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
const key = ref(defaultRequest.idempotencyKey);
const action = ref(defaultRequest.action);
const title = ref(defaultRequest.title);
const description = ref(defaultRequest.description);
const expiresInSeconds = ref(defaultRequest.expiresInSeconds);
const detailsText = ref(JSON.stringify(defaultRequest.details));
const metadataText = ref(JSON.stringify(defaultRequest.metadata));
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
  { operation: 'audit', method: 'GET', label: 'Audit events', path: '/v1/audit-events' },
  { operation: 'health', method: 'GET', label: 'Health', path: '/health' },
  { operation: 'ready', method: 'GET', label: 'Readiness', path: '/ready' },
];
const requestEndpoints = endpoints.filter((item) => !item.operation.startsWith('key') && !['health', 'ready', 'audit'].includes(item.operation));
const keyEndpoints = endpoints.filter((item) => item.operation.startsWith('key') || item.operation === 'audit');
const utilityEndpoints = endpoints.filter((item) => ['health', 'ready'].includes(item.operation));

const clients = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedClients ?? [] : bootstrap.value?.liveClients ?? []);
const simulatedExample = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedExamples[clientId.value] : undefined);
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
const auditFilters = computed(() => ({ limit: Number(auditLimit.value), ...(auditRequestId.value ? { requestId: auditRequestId.value } : {}),
  ...(auditKeyId.value ? { keyId: auditKeyId.value } : {}), ...(auditCursor.value ? { cursor: auditCursor.value } : {}) }));
const requestPath = computed(() => {
  const path = endpoint.value.path.replace(':id', operation.value === 'keyRevoke' ? keyId.value || ':id' : requestId.value || ':id');
  const query = operation.value === 'list' ? listFilters.value : operation.value === 'events' ? eventFilters.value : operation.value === 'keyList' ? keyFilters.value : operation.value === 'audit' ? auditFilters.value : null;
  return query ? `${path}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()}` : path;
});
const needsRequestId = computed(() => ['get', 'events', 'cancel', 'claim', 'result'].includes(operation.value));
const needsKeyId = computed(() => operation.value === 'keyRevoke');
const requestTabLabel = computed(() => needsRequestId.value || needsKeyId.value ? 'Params & body' : ['create', 'keyCreate'].includes(operation.value) ? 'Body' : ['list', 'keyList', 'audit'].includes(operation.value) ? 'Filters' : 'Overview');
const authSummary = computed(() => auth.value === 'valid' ? 'Bootstrap key' : auth.value === 'scoped' ? 'Issued key' : auth.value === 'missing' ? 'None' : 'Invalid key');
const clientOptions = computed(() => clients.value.map((id) => ({ value: id, label: mode.value === 'simulated' ? bootstrap.value?.simulatedExamples[id]?.label ?? id : id })));
const previewBody = computed(() => operation.value === 'create' ? {
  idempotencyKey: key.value, action: action.value, title: title.value, description: description.value,
  details: parsePreview(detailsText.value), metadata: parsePreview(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
} : operation.value === 'result' ? {
  claimToken: claimToken.value, status: resultStatus.value, summary: resultSummary.value,
} : operation.value === 'keyCreate' ? { label: keyLabel.value, scopes: keyScopes.value }
  : operation.value === 'list' ? listFilters.value : operation.value === 'events' ? eventFilters.value : operation.value === 'keyList' ? keyFilters.value : operation.value === 'audit' ? auditFilters.value : {});

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
function setKeyExpiryOneHour() {
  keyExpiresAt.value = new Date(Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0) + 3_600_000).toISOString();
}
watch([clientId, mode], () => {
  clearDisplayedResponse();
  error.value = '';
  history.value = [];
  const example = simulatedExample.value?.request ?? defaultRequest;
  key.value = example.idempotencyKey;
  action.value = example.action;
  title.value = example.title;
  description.value = example.description;
  expiresInSeconds.value = example.expiresInSeconds;
  detailsText.value = JSON.stringify(example.details);
  metadataText.value = JSON.stringify(example.metadata);
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
watch([clientId, mode, auditLimit, auditRequestId, auditKeyId], () => {
  auditPage.value = null;
  auditCursor.value = '';
  auditCursorStack.value = [];
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
    auditPage.value = null;
    auditCursor.value = '';
    auditCursorStack.value = [];
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

const modeSelection = computed({
  get: () => mode.value,
  set: (next: Mode) => changeMode(next),
});

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
    if (sentOperation === 'keyCreate') payload = { label: keyLabel.value, scopes: keyScopes.value,
      ...(keyExpiresAt.value ? { expiresAt: keyExpiresAt.value } : {}) };
    busy.value = true;
    const response = await api('/api/execute', {
      mode: sentMode, clientId: sentClient, operation: sentOperation, auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}), requestId: requestId.value, keyId: keyId.value,
      ...(sentOperation === 'list' ? { filters: listFilters.value } : {}),
      ...(sentOperation === 'events' ? { eventPage: eventFilters.value } : {}),
      ...(sentOperation === 'keyList' ? { keyPage: keyFilters.value } : {}), payload,
      ...(sentOperation === 'audit' ? { auditPage: auditFilters.value } : {}),
    }) as { status: number; body: Record<string, unknown> };
    const current = sentMode === mode.value && sentClient === clientId.value && sentOperation === operation.value &&
      (sentOperation !== 'events' || sentRequestId === requestId.value) && (sentOperation !== 'keyRevoke' || sentKeyId === keyId.value);
    record(`${sentOperation.toUpperCase()} · ${sentClient} · ${sentMode}`, response.status, response.body, current);
    if (!current) return;
    if (sentOperation === 'list') listPage.value = response.status === 200 ? response.body as unknown as ListPage : null;
    if (sentOperation === 'events') eventPage.value = response.status === 200 ? response.body as unknown as EventPage : null;
    if (sentOperation === 'keyList') keyPage.value = response.status === 200 ? response.body as unknown as KeyPage : null;
    if (sentOperation === 'audit') auditPage.value = response.status === 200 ? response.body as unknown as AuditPage : null;
    if (sentOperation === 'keyCreate' && response.status === 201) {
      keyId.value = String(response.body.id);
      scopedKey.value = String(response.body.key);
      keyPage.value = null;
      auditPage.value = null;
    }
    if (sentOperation === 'keyRevoke' && response.status === 200) { keyPage.value = null; auditPage.value = null; }
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

async function nextAuditPage() {
  if (!auditPage.value?.nextCursor || busy.value) return;
  auditCursorStack.value.push(auditCursor.value);
  auditCursor.value = auditPage.value.nextCursor;
  await execute('audit');
}

async function previousAuditPage() {
  if (!auditCursorStack.value.length || busy.value) return;
  auditCursor.value = auditCursorStack.value.pop()!;
  await execute('audit');
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

function onScopeChange(scope: ClientKeyScope, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  keyScopes.value = target.checked
    ? [...new Set([...keyScopes.value, scope])]
    : keyScopes.value.filter((item) => item !== scope);
}
function statusClass(status: string) {
  if (status === 'approved' || status === 'succeeded') return 'ok';
  if (status === 'rejected' || status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'pending') return 'wait';
  return 'idle';
}
function keyState(item: ClientKeyView) {
  if (item.revokedAt) return 'Revoked';
  const now = Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0);
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return 'Expired';
  return 'Active';
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
  <div class="shell">
    <header class="chrome">
    <div class="topbar">
      <div class="brand">
        <img src="/logo.svg" alt="" width="28" height="28" />
        JaGate <span>Playground [local]</span>
      </div>
      <div class="top-links">
        <span class="hide-narrow">Approval API workbench</span>
        <a href="https://github.com/ahmetomerv/JaGate/blob/main/docs/guide/playground.md" target="_blank" rel="noreferrer">Usage guide</a>
      </div>
    </div>

    <div class="environment">
      <div class="environment-group">
        <label class="environment-field">
          <span class="field-label">Environment <span class="mode-note">{{ mode === 'simulated' ? 'Local simulator · isolated database' : bootstrap?.gatewayUrl }}</span></span>
          <select v-model="modeSelection" aria-label="Environment">
            <option value="simulated">Simulated Telegram</option>
            <option value="live">Real gateway</option>
          </select>
        </label>
      </div>
      <div class="environment-group">
        <label>Client
          <select v-model="clientId" :disabled="!clients.length" aria-label="Client">
            <option v-for="option in clientOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>Auth
          <select v-model="auth" aria-label="Authorization">
            <option value="valid">Bootstrap key</option>
            <option value="scoped">Issued key</option>
            <option value="missing">Missing key</option>
            <option value="invalid">Invalid key</option>
          </select>
        </label>
        <div v-if="auth === 'scoped'" class="inline-field">
          <label for="issued-key">Issued key</label>
          <input id="issued-key" v-model="scopedKey" :type="showScopedKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="Paste the key returned once" />
          <button type="button" class="outline" :aria-label="showScopedKey ? 'Hide issued key' : 'Show issued key'" @click="showScopedKey = !showScopedKey">{{ showScopedKey ? 'Hide' : 'Show' }}</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="mode === 'live' && !clients.length" class="notice warn">Live mode needs CLIENT_KEYS in your local .env and a running gateway.</p>
    </header>

    <div class="workbench">
      <aside class="sidebar">
        <section class="nav-block">
          <div class="nav-heading"><span>Requests</span><span>{{ requestEndpoints.length }}</span></div>
          <div class="nav-list">
            <button v-for="item in requestEndpoints" :key="item.operation" type="button" :aria-pressed="operation === item.operation" @click="selectOperation(item.operation)">
              <span class="method" :class="{ post: item.method === 'POST' }">{{ item.method }}</span>{{ item.label }}
            </button>
          </div>
        </section>
        <section class="nav-block">
          <div class="nav-heading"><span>Client keys</span><span>{{ keyEndpoints.length }}</span></div>
          <div class="nav-list">
            <button v-for="item in keyEndpoints" :key="item.operation" type="button" :aria-pressed="operation === item.operation" @click="selectOperation(item.operation)">
              <span class="method" :class="{ post: item.method === 'POST' }">{{ item.method }}</span>{{ item.label }}
            </button>
          </div>
        </section>
        <section class="nav-block">
          <div class="nav-heading">Status</div>
          <div class="nav-list">
            <button v-for="item in utilityEndpoints" :key="item.operation" type="button" :aria-pressed="operation === item.operation" @click="selectOperation(item.operation)">
              <span class="method">{{ item.method }}</span>{{ item.label }}
            </button>
          </div>
        </section>
        <section class="nav-block recent">
          <div class="nav-heading">
            <span>Recent · {{ clientId }}</span>
            <button type="button" class="outline" title="Refresh recent requests" aria-label="Refresh recent requests" @click="refreshHistory">Refresh</button>
          </div>
          <p v-if="!history.length" class="hint">Create a request to see it here.</p>
          <div class="nav-list">
            <button v-for="item in history" :key="item.id" type="button" class="recent-item" :aria-pressed="requestId === item.id" @click="selectRequest(item)">
              <span>{{ item.title }}</span>
              <span class="recent-meta"><span>{{ item.clientId }} · {{ item.id.slice(0, 8) }}</span><span class="dot" :class="statusClass(item.status)"></span></span>
            </button>
          </div>
        </section>
        <div class="sidebar-foot"><span class="dot ok"></span>Development only<span class="meta">v0.1</span></div>
      </aside>

      <main class="workspace">
        <p v-if="simulatedExample" class="context"><strong>{{ simulatedExample.label }}</strong> (<code>{{ clientId }}</code>) is a client: an application or automation that asks JaGate for approval before it can {{ simulatedExample.scenario }}. Each client has its own requests, keys, Telegram chat, and approver. Selecting another client loads its sample request.</p>
        <article>
          <header class="panel-head">
            <h1>{{ endpoint.label }}</h1>
          </header>
          <div class="request-line">
            <span class="method" :class="{ post: endpoint.method === 'POST' }">{{ endpoint.method }}</span>
            <code>{{ mode === 'simulated' ? 'simulated://jagate' : bootstrap?.gatewayUrl }}{{ requestPath }}</code>
            <button type="button" :aria-busy="busy" :disabled="busy || !clientId || (needsRequestId && !requestId) || (needsKeyId && !keyId) || (auth === 'scoped' && !scopedKey)" @click="execute(operation)">{{ busy ? 'Sending…' : 'Send' }}</button>
          </div>

          <div class="editor-bar">
            <div class="tabs" role="tablist" aria-label="Request editor">
              <button type="button" role="tab" :aria-selected="requestTab === 'body'" @click="requestTab = 'body'">{{ requestTabLabel }}</button>
              <button type="button" role="tab" :aria-selected="requestTab === 'preview'" @click="requestTab = 'preview'">JSON preview</button>
            </div>
            <span class="muted">Authorization <strong>{{ authSummary }}</strong></span>
          </div>

          <div v-if="requestTab === 'preview'">
            <p class="section-label"><span>{{ operation === 'list' || operation === 'events' || operation === 'keyList' || operation === 'audit' ? 'Query parameters' : 'Request body' }}</span><span>Read only preview</span></p>
            <pre><code>{{ JSON.stringify(previewBody, null, 2) }}</code></pre>
            <p v-if="operation === 'create' || operation === 'result' || operation === 'keyCreate'" class="hint">Edit values in the {{ needsRequestId ? 'Params & body' : 'Body' }} tab.</p>
            <p v-else-if="operation !== 'list' && operation !== 'events' && operation !== 'keyList' && operation !== 'audit'" class="hint">This endpoint does not require a request body.</p>
          </div>

          <div v-else>
            <template v-if="operation === 'create'">
              <p class="section-label"><span>Application / JSON</span><span>Approval payload</span></p>
              <div class="fields">
                <label>Idempotency key<input v-model="key" maxlength="128" /></label>
                <label>Action<input v-model="action" maxlength="64" /></label>
                <label class="span-2">Title<input v-model="title" maxlength="100" /></label>
                <label class="span-2">Description<textarea v-model="description" rows="2" maxlength="1000"></textarea></label>
                <label>Expires in seconds<input v-model.number="expiresInSeconds" type="number" min="60" max="86400" /></label>
                <div>
                  <button type="button" class="outline" @click="key = 'playground:' + Date.now()">Generate new key</button>
                  <p class="hint">Reuse the key to test idempotency.</p>
                </div>
                <label class="span-2">Details <span class="muted">JSON array</span><textarea v-model="detailsText" rows="2" spellcheck="false"></textarea></label>
                <label class="span-2">Metadata <span class="muted">JSON object</span><textarea v-model="metadataText" rows="2" spellcheck="false"></textarea></label>
              </div>
            </template>
            <template v-else-if="operation === 'list'">
              <p class="section-label"><span>Query parameters</span><span>Only the selected client's requests</span></p>
              <div class="attention" role="group" aria-label="Requests needing attention">
                <strong>Requests needing attention</strong>
                <button type="button" class="outline" :disabled="busy" @click="applyAttention('delivery')">Failed delivery</button>
                <button type="button" class="outline" :disabled="busy" @click="applyAttention('claimed')">Old claims</button>
                <button type="button" class="outline" :disabled="busy" @click="applyAttention('expiry')">Expiring soon</button>
                <button type="button" class="outline" :disabled="busy" @click="applyAttention('all')">Clear filters</button>
                <label for="attention-window">Window (minutes)<input id="attention-window" v-model.number="attentionMinutes" type="number" min="1" max="1440" /></label>
              </div>
              <div class="fields">
                <label>Decision status
                  <select v-model="listStatus" aria-label="Decision status">
                    <option value="">Any</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label>Delivery status
                  <select v-model="listDeliveryStatus" aria-label="Delivery status">
                    <option value="">Any</option><option value="pending">Pending</option><option value="retrying">Retrying</option><option value="delivered">Delivered</option><option value="failed">Failed</option>
                  </select>
                </label>
                <label>Execution status
                  <select v-model="listExecutionStatus" aria-label="Execution status">
                    <option value="">Any</option><option value="unclaimed">Unclaimed</option><option value="claimed">Claimed</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option>
                  </select>
                </label>
                <label>Page size<input v-model.number="listLimit" type="number" min="1" max="100" /></label>
                <label>Claimed before <span class="muted">UTC ISO 8601</span><input v-model.trim="listClaimedBefore" placeholder="2026-10-05T12:00:00.000Z" spellcheck="false" /></label>
                <label>Expires before <span class="muted">UTC ISO 8601</span><input v-model.trim="listExpiresBefore" placeholder="2026-10-05T12:00:00.000Z" spellcheck="false" /></label>
              </div>
              <p class="hint">Shortcuts set fixed UTC cutoffs using the selected clock. Send to load a page; keep those cutoffs when paging. Old claims need reconciliation before any retry.</p>
            </template>
            <template v-else-if="operation === 'keyCreate'">
              <p class="section-label"><span>Application / JSON</span><span>Bootstrap key required</span></p>
              <div class="fields">
                <label class="span-2">Key label<input v-model="keyLabel" maxlength="80" placeholder="Name the app or worker" /></label>
                <label class="span-2">Expires at <span class="muted">optional UTC ISO 8601</span><input v-model.trim="keyExpiresAt" placeholder="2026-10-05T22:00:00.000Z" spellcheck="false" /></label>
              </div>
              <div class="actions">
                <button type="button" class="outline" @click="setKeyExpiryOneHour">Set 1 hour from now</button>
                <button type="button" class="outline" @click="keyExpiresAt = ''">No expiry</button>
              </div>
              <fieldset>
                <legend>Allowed request operations</legend>
                <div class="scopes">
                  <label v-for="scope in availableKeyScopes" :key="scope"><input type="checkbox" :checked="keyScopes.includes(scope)" @change="onScopeChange(scope, $event)" />{{ scope }}</label>
                </div>
              </fieldset>
              <p class="hint">The new key appears only in the creation response. An optional expiry blocks later requests at that time. It also fills the Issued key field for this browser session; copy it before leaving.</p>
            </template>
            <template v-else-if="operation === 'keyList'">
              <p class="section-label"><span>Query parameters</span><span>Bootstrap key required</span></p>
              <label>Page size<input v-model.number="keyLimit" type="number" min="1" max="100" /></label>
              <p class="hint">Lists this client's issued keys, including revoked keys. Secret values are never returned here.</p>
            </template>
            <template v-else-if="operation === 'keyRevoke'">
              <p class="section-label"><span>Path parameters</span><span>Bootstrap key required</span></p>
              <label>Client key ID<input v-model="keyId" placeholder="Select a listed key or paste its UUID" spellcheck="false" /></label>
              <p class="hint">Revocation takes effect on the next API request. The configured bootstrap key is rotated in .env, not here.</p>
            </template>
            <template v-else-if="operation === 'audit'">
              <p class="section-label"><span>Query parameters</span><span>Bootstrap key required · selected client only</span></p>
              <div class="fields">
                <label>Page size<input v-model.number="auditLimit" type="number" min="1" max="100" /></label>
                <label>Request ID <span class="muted">optional</span><input v-model.trim="auditRequestId" placeholder="Filter by request UUID" spellcheck="false" /></label>
                <label class="span-2">Client key ID <span class="muted">optional</span><input v-model.trim="auditKeyId" placeholder="Actor or affected key UUID" spellcheck="false" /></label>
              </div>
              <p class="hint">Newest first. Records successful request creation, claims, results, key issuance, and revocation. Only key IDs are stored; secrets never appear here.</p>
            </template>
            <template v-else-if="needsRequestId">
              <p class="section-label"><span>Path parameters</span><span>Required</span></p>
              <label>Request ID<input v-model="requestId" placeholder="Select a recent request or paste its UUID" spellcheck="false" /></label>
              <label v-if="operation === 'events'">Page size<input v-model.number="eventLimit" type="number" min="1" max="100" /></label>
              <p v-if="operation === 'events'" class="hint">Oldest events first. Each event records a gateway state change; no action is executed here.</p>
              <template v-if="operation === 'result'">
                <p class="section-label"><span>Application / JSON</span><span>Execution result</span></p>
                <div class="fields">
                  <div class="span-2 inline-field">
                    <label for="claim-token">Claim token</label>
                    <input id="claim-token" v-model="claimToken" :type="showClaimToken ? 'text' : 'password'" autocomplete="off" placeholder="Filled after a successful claim" />
                    <button type="button" class="outline" :aria-label="showClaimToken ? 'Hide claim token' : 'Show claim token'" @click="showClaimToken = !showClaimToken">{{ showClaimToken ? 'Hide' : 'Show' }}</button>
                  </div>
                  <label>Result
                    <select v-model="resultStatus" aria-label="Result">
                      <option value="succeeded">Succeeded</option>
                      <option value="failed">Failed</option>
                    </select>
                  </label>
                  <label>Summary<input v-model="resultSummary" maxlength="300" /></label>
                </div>
                <p class="hint">This reports an outcome. The playground does not execute the proposed action.</p>
              </template>
              <div v-else-if="selected" class="facts">
                <div><small>DECISION</small><strong>{{ selected.status }}</strong></div>
                <div><small>DELIVERY</small><strong>{{ selected.deliveryStatus }}</strong></div>
                <div><small>EXECUTION</small><strong>{{ selected.executionStatus }}</strong></div>
                <div><small>EXPIRES</small><strong>{{ new Date(selected.expiresAt).toLocaleString() }}</strong></div>
              </div>
              <p v-if="operation === 'claim'" class="hint">Claim an approved request once. The token appears in the response and fills the report form.</p>
              <p v-if="operation === 'cancel'" class="hint">Cancels a pending approval. The request cannot be decided afterward.</p>
            </template>
            <template v-else>
              <p><strong>{{ operation === 'health' ? 'Gateway health' : 'Gateway readiness' }}</strong></p>
              <p class="hint">This public endpoint does not require authorization or a request body. Click Send to inspect its response.</p>
            </template>
          </div>
        </article>

        <article v-if="operation === 'events' && eventPage" aria-label="Request timeline">
          <header class="panel-head"><h1>Request timeline</h1><span class="muted">{{ eventPage.items.length }} shown</span></header>
          <p v-if="!eventPage.items.length" class="hint">No more events for this request.</p>
          <ol v-else class="timeline">
            <li v-for="event in eventPage.items" :key="event.sequence">
              <span class="dot" :class="statusClass(event.type)"></span>
              <div><strong>{{ eventLabel(event.type) }}</strong><small>#{{ event.sequence }} · <time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time><template v-if="event.actorId"> · Approver {{ event.actorId }}</template><template v-if="event.attempt"> · Attempt {{ event.attempt }}</template></small></div>
            </li>
          </ol>
          <div class="pager"><span>Page {{ eventCursorStack.length + 1 }}</span><div class="actions"><button type="button" class="outline" :disabled="busy || !eventCursorStack.length" @click="previousEventPage">Previous</button><button type="button" class="outline" :disabled="busy || !eventPage.nextCursor" @click="nextEventPage">Next</button></div></div>
        </article>

        <article v-if="operation === 'list' && listPage" aria-label="Listed requests">
          <header class="panel-head"><h1>Requests in this page</h1><span class="muted">{{ listPage.items.length }} shown</span></header>
          <p v-if="!listPage.items.length" class="hint">No requests match these filters.</p>
          <button v-for="item in listPage.items" :key="item.id" type="button" class="row-button" @click="selectRequest(item)">
            <span class="row-copy"><strong>{{ item.title }}</strong><small>{{ item.id }} · {{ new Date(item.createdAt).toLocaleString() }}</small><small>Delivery: {{ item.deliveryStatus }} · Execution: {{ item.executionStatus }}<template v-if="item.claimedAt"> · Claimed: {{ new Date(item.claimedAt).toLocaleString() }}</template><template v-if="item.status === 'pending'"> · Expires: {{ new Date(item.expiresAt).toLocaleString() }}</template></small></span>
            <span class="muted">{{ item.status }}</span>
          </button>
          <div class="pager"><span>Page {{ listCursorStack.length + 1 }}</span><div class="actions"><button type="button" class="outline" :disabled="busy || !listCursorStack.length" @click="previousPage">Previous</button><button type="button" class="outline" :disabled="busy || !listPage.nextCursor" @click="nextPage">Next</button></div></div>
        </article>

        <article v-if="operation === 'keyList' && keyPage" aria-label="Listed client keys">
          <header class="panel-head"><h1>Client keys in this page</h1><span class="muted">{{ keyPage.items.length }} shown</span></header>
          <p v-if="!keyPage.items.length" class="hint">No issued keys on this page.</p>
          <button v-for="item in keyPage.items" :key="item.id" type="button" class="row-button" @click="selectClientKey(item)">
            <span class="row-copy"><strong>{{ item.label }}</strong><small>{{ item.id }} · {{ item.scopes.join(', ') }}</small><small>{{ item.expiresAt ? 'Expires: ' + new Date(item.expiresAt).toLocaleString() : 'No expiry' }}</small></span>
            <span class="muted">{{ keyState(item) }}</span>
          </button>
          <div class="pager"><span>Page {{ keyCursorStack.length + 1 }}</span><div class="actions"><button type="button" class="outline" :disabled="busy || !keyCursorStack.length" @click="previousKeyPage">Previous</button><button type="button" class="outline" :disabled="busy || !keyPage.nextCursor" @click="nextKeyPage">Next</button></div></div>
        </article>

        <article v-if="operation === 'audit' && auditPage" aria-label="Audit events">
          <header class="panel-head"><h1>Client audit events</h1><span class="muted">{{ auditPage.items.length }} shown</span></header>
          <p v-if="!auditPage.items.length" class="hint">No audit events match these filters.</p>
          <div v-for="event in auditPage.items" :key="event.id" class="row-copy">
            <strong>{{ event.type }}</strong>
            <small>#{{ event.id }} · <time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time> · {{ event.actor === 'bootstrap' ? 'Bootstrap key' : 'Issued key ' + event.actorKeyId }}</small>
            <small v-if="event.requestId">Request {{ event.requestId }}</small>
            <small v-if="event.subjectKeyId">Client key {{ event.subjectKeyId }}</small>
          </div>
          <div class="pager"><span>Page {{ auditCursorStack.length + 1 }}</span><div class="actions"><button type="button" class="outline" :disabled="busy || !auditCursorStack.length" @click="previousAuditPage">Previous</button><button type="button" class="outline" :disabled="busy || !auditPage.nextCursor" @click="nextAuditPage">Next</button></div></div>
        </article>

        <article v-if="mode === 'simulated'">
          <header class="panel-head"><h2>Simulation controls</h2></header>
          <div class="simulation">
            <p class="hint">Drive the Telegram decision and time locally.</p>
            <div class="actions">
              <label>Decision actor
                <select v-model="actor" aria-label="Decision actor">
                  <option value="allowed">Allowlisted approver</option>
                  <option value="outsider">Outsider</option>
                </select>
              </label>
              <button type="button" class="outline" :disabled="busy || !requestId" @click="decide('approve')">Approve</button>
              <button type="button" class="outline" :disabled="busy || !requestId" @click="decide('reject')">Reject</button>
              <label>Seconds<input v-model.number="advanceSeconds" type="number" min="1" max="86400" aria-label="Seconds to advance" /></label>
              <button type="button" class="outline" :disabled="busy" @click="advanceTime">Advance clock</button>
            </div>
          </div>
        </article>
        <article v-else><p class="hint">Approve or reject in your configured Telegram chat, then send <strong>Get request</strong> to refresh its state.</p></article>

        <article>
          <header class="response-head">
            <h2>Output</h2>
          </header>
          <div class="editor-bar">
            <div class="tabs" role="tablist" aria-label="Response view">
              <button type="button" role="tab" :aria-selected="responseTab === 'body'" @click="responseTab = 'body'">Body</button>
              <button type="button" role="tab" :aria-selected="responseTab === 'history'" @click="responseTab = 'history'">History ({{ entries.length }})</button>
            </div>
            <button v-if="visibleEntry && responseTab === 'body'" type="button" class="outline" @click="copyResponse">{{ copied ? 'Copied' : 'Copy JSON' }}</button>
          </div>
          <div v-if="responseTab === 'body'" class="output">
            <template v-if="visibleEntry">
              <p class="section-label"><span>{{ visibleEntry.label }}</span><span><strong :class="visibleEntry.status >= 400 ? 'status-bad' : 'status-ok'">HTTP {{ visibleEntry.status }}</strong> {{ visibleEntry.time }}</span></p>
              <pre><code>{{ JSON.stringify(visibleEntry.body, null, 2) }}</code></pre>
            </template>
            <div v-else class="empty"><strong>Waiting for a request</strong><p>Send the selected request to see its response.<template v-if="entries.length"> Previous responses remain in History.</template></p></div>
          </div>
          <div v-else>
            <p v-if="!entries.length" class="empty">No responses in this session yet.</p>
            <button v-for="(entry, index) in entries" :key="index" type="button" class="row-button" :aria-pressed="activeEntry === index" @click="activeEntry = index; responseTab = 'body'">
              <span class="meta" :class="entry.status >= 400 ? 'status-bad' : 'status-ok'">{{ entry.status }}</span>
              <strong class="row-copy">{{ entry.label }}</strong>
              <time class="muted">{{ entry.time }}</time>
            </button>
          </div>
        </article>
      </main>
    </div>
  </div>
</template>
