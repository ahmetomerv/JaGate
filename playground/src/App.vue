<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

type Mode = 'simulated' | 'live';
type View = 'approval' | 'list' | 'keys' | 'gateway';
type Operation = 'create' | 'list' | 'get' | 'events' | 'cancel' | 'claim' | 'result' | 'keyCreate' | 'keyList' | 'keyRevoke' | 'audit' | 'health' | 'ready';
type ClientKeyScope = 'requests:create' | 'requests:read' | 'requests:cancel' | 'requests:claim' | 'requests:result';
type ClientKeyView = { id: string; clientId: string; label: string; scopes: ClientKeyScope[]; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type KeyPage = { items: ClientKeyView[]; nextCursor: string | null };
type AuditEvent = { id: number; type: string; occurredAt: string; actor: 'bootstrap' | 'issued_key'; actorKeyId: string | null; requestId: string | null; subjectKeyId: string | null };
type AuditPage = { items: AuditEvent[]; nextCursor: string | null };
type Detail = { label: string; value: string };
type RequestView = {
  id: string; clientId: string; title: string; action: string; description?: string; details?: Detail[];
  status: string; executionStatus: string; deliveryStatus: string; deliveryAttempts: number; deliveryError?: string | null;
  createdAt: string; expiresAt: string; claimedAt: string | null; resultSummary: string | null; resultAt?: string | null;
};
type ListPage = { items: RequestView[]; nextCursor: string | null };
type RequestEvent = { sequence: number; type: string; occurredAt: string; actorId: string | null; attempt: number | null };
type EventPage = { items: RequestEvent[]; nextCursor: string | null };
type Entry = { time: string; label: string; status: number; body: unknown };
type ExampleRequest = { idempotencyKey: string; action: string; title: string; description: string; details: Detail[]; metadata: Record<string, unknown>; expiresInSeconds: number };
type SimulatedExample = { label: string; scenario: string; request: ExampleRequest };
type Bootstrap = { token: string; simulatedClients: string[]; simulatedExamples: Record<string, SimulatedExample>;
  liveClients: string[]; gatewayUrl: string; simulatedNow: string; failNextDelivery?: boolean };
type Executed = { status: number; body: Record<string, unknown> };

const defaultRequest: ExampleRequest = { idempotencyKey: 'playground:local-test', action: 'test-action',
  title: 'Test a local approval', description: 'A harmless request made from the JaGate playground.',
  details: [{ label: 'Environment', value: 'local' }], metadata: { source: 'playground' }, expiresInSeconds: 900 };
const availableKeyScopes: ClientKeyScope[] = ['requests:create', 'requests:read', 'requests:cancel', 'requests:claim', 'requests:result'];
const scopeLabels: Record<ClientKeyScope, string> = {
  'requests:create': 'Ask for approval', 'requests:read': 'Read requests', 'requests:cancel': 'Cancel a request',
  'requests:claim': 'Claim an approval', 'requests:result': 'Report a result',
};

const bootstrap = ref<Bootstrap | null>(null);
const mode = ref<Mode>('simulated');
const view = ref<View>('approval');
const sidebarSelection = ref('');
const clientId = ref('');
const auth = ref<'valid' | 'scoped' | 'missing' | 'invalid'>('valid');
const scopedKey = ref('');
const showScopedKey = ref(false);
const keyId = ref('');
const keyLabel = ref('Local worker');
const keyExpiresAt = ref('');
const keyScopes = ref<ClientKeyScope[]>(['requests:create', 'requests:read']);
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
const failNextDelivery = ref(false);
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
const idempotencyKey = ref(defaultRequest.idempotencyKey);
const action = ref(defaultRequest.action);
const title = ref(defaultRequest.title);
const description = ref(defaultRequest.description);
const expiresInSeconds = ref(defaultRequest.expiresInSeconds);
const detailRows = ref<Detail[]>(defaultRequest.details.map((item) => ({ ...item })));
const metadataText = ref(JSON.stringify(defaultRequest.metadata, null, 2));
const actor = ref<'allowed' | 'outsider'>('allowed');
const advanceSeconds = ref(61);
const claimToken = ref('');
const showClaimToken = ref(false);
const resultSummary = ref('Completed in the calling application');
const composing = ref(true);
const storyLoading = ref(false);
const unavailable = ref(false);
const blocked = ref(false);
const createNotice = ref('');
const telegramReply = ref('');
const activeEntry = ref<number | null>(null);
const copied = ref(false);
const responseTab = ref<'body' | 'history'>('body');
let openTicket = 0;

const clients = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedClients ?? [] : bootstrap.value?.liveClients ?? []);
const simulatedExample = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedExamples[clientId.value] : undefined);
const selected = computed(() => [...history.value, ...(listPage.value?.items ?? [])].find((item) => item.id === requestId.value));
const visibleEntry = computed(() => activeEntry.value === null ? undefined : entries.value[activeEntry.value]);
const clientOptions = computed(() => clients.value.map((id) => ({ value: id, label: mode.value === 'simulated' ? bootstrap.value?.simulatedExamples[id]?.label ?? id : id })));
const simulatedNowLabel = computed(() => new Date(Date.now() + simulatedClockOffset.value).toLocaleString());
const phase = computed(() => {
  const item = selected.value;
  if (!item || item.status === 'pending') return 'decide';
  if (item.status === 'approved' && (item.executionStatus === 'unclaimed' || item.executionStatus === 'claimed')) return 'act';
  return 'record';
});
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
const requestPreview = computed(() => ({
  idempotencyKey: idempotencyKey.value, action: action.value, title: title.value, description: description.value,
  details: cleanDetails(), metadata: parsePreview(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
}));

watch([listStatus, listDeliveryStatus, listExecutionStatus, listClaimedBefore, listExpiresBefore, listLimit, clientId, mode], () => {
  listCursor.value = '';
  listCursorStack.value = [];
  listPage.value = null;
});
watch([clientId, mode], () => {
  clearDisplayedResponse();
  error.value = '';
  createNotice.value = '';
  telegramReply.value = '';
  claimToken.value = '';
  unavailable.value = false;
  blocked.value = false;
  history.value = [];
  scopedKey.value = '';
  keyId.value = '';
  auth.value = 'valid';
  applyExample(simulatedExample.value?.request ?? defaultRequest);
  const openId = requestId.value;
  const keepOpen = !composing.value && openId.length > 0;
  if (keepOpen) storyLoading.value = true;
  void refreshHistory().then(() => { if (keepOpen && requestId.value === openId && !composing.value) void openCurrent(); });
});
watch([requestId, clientId, mode], () => {
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

function applyExample(example: ExampleRequest) {
  idempotencyKey.value = example.idempotencyKey;
  action.value = example.action;
  title.value = example.title;
  description.value = example.description;
  expiresInSeconds.value = example.expiresInSeconds;
  detailRows.value = example.details.map((item) => ({ ...item }));
  metadataText.value = JSON.stringify(example.metadata, null, 2);
}
function cleanDetails(): Detail[] {
  return detailRows.value.filter((row) => row.label.trim() || row.value.trim()).map((row) => ({ label: row.label.trim(), value: row.value.trim() }));
}
function addDetail() {
  if (detailRows.value.length >= 10) return;
  detailRows.value.push({ label: '', value: '' });
}
function removeDetail(index: number) { detailRows.value.splice(index, 1); }
function parsePreview(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
function clearDisplayedResponse() {
  activeEntry.value = null;
  responseTab.value = 'body';
  copied.value = false;
}
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
  listCursor.value = '';
  listCursorStack.value = [];
  void execute('list');
}
async function showRequests() {
  listCursor.value = '';
  listCursorStack.value = [];
  await execute('list');
}
function setKeyExpiryOneHour() {
  keyExpiresAt.value = new Date(Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0) + 3_600_000).toISOString();
}
function newApproval() {
  composing.value = true;
  storyLoading.value = false;
  requestId.value = '';
  unavailable.value = false;
  blocked.value = false;
  createNotice.value = '';
  telegramReply.value = '';
  claimToken.value = '';
  view.value = 'approval';
  idempotencyKey.value = `playground:${Date.now()}`;
}
function stageClass(name: 'decide' | 'act' | 'record') {
  const order = ['decide', 'act', 'record'];
  const current = phase.value === 'decide' ? 'decide' : phase.value === 'act' ? 'act' : 'record';
  const place = order.indexOf(name);
  const here = order.indexOf(current);
  if (place < here) return 'done';
  if (place === here) return 'current';
  return 'upcoming';
}
function remember(item: RequestView) {
  history.value = [item, ...history.value.filter((existing) => existing.id !== item.id)].slice(0, 100);
}
function gatewayMessage(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'error' in body) {
    const cause = (body as { error: unknown }).error;
    if (typeof cause === 'string') return cause;
    if (cause && typeof cause === 'object' && 'message' in cause && typeof (cause as { message: unknown }).message === 'string')
      return (cause as { message: string }).message;
  }
  return `The gateway returned HTTP ${status}.`;
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
  requestId.value = '';
  composing.value = true;
  claimToken.value = '';
  scopedKey.value = '';
  error.value = '';
  mode.value = next;
  clientId.value = clients.value[0] ?? '';
}
const modeSelection = computed({
  get: () => mode.value,
  set: (next: Mode) => changeMode(next),
});
async function execute(sentOperation: Operation, options?: { show?: boolean }): Promise<Executed | null> {
  if (!bootstrap.value || busy.value) return null;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  const sentKeyId = keyId.value;
  let payload: unknown;
  if (sentOperation === 'create') {
    let metadata: unknown;
    try { metadata = JSON.parse(metadataText.value) as unknown; }
    catch { error.value = 'Metadata must be a JSON object.'; return null; }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      error.value = 'Metadata must be a JSON object.';
      return null;
    }
    payload = {
      idempotencyKey: idempotencyKey.value, action: action.value, title: title.value, description: description.value,
      details: cleanDetails(), metadata, expiresInSeconds: Number(expiresInSeconds.value),
    };
  }
  if (sentOperation === 'keyCreate') payload = { label: keyLabel.value, scopes: keyScopes.value, ...(keyExpiresAt.value ? { expiresAt: keyExpiresAt.value } : {}) };
  const show = options?.show !== false;
  try {
    busy.value = true;
    const response = await api('/api/execute', {
      mode: sentMode, clientId: sentClient, operation: sentOperation, auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}), requestId: requestId.value, keyId: keyId.value,
      ...(sentOperation === 'list' ? { filters: listFilters.value } : {}),
      ...(sentOperation === 'events' ? { eventPage: eventFilters.value } : {}),
      ...(sentOperation === 'keyList' ? { keyPage: keyFilters.value } : {}), payload,
      ...(sentOperation === 'audit' ? { auditPage: auditFilters.value } : {}),
    }) as { status: number; body: Record<string, unknown> };
    const current = sentMode === mode.value && sentClient === clientId.value
      && (!['get', 'events', 'cancel', 'claim', 'result'].includes(sentOperation) || sentRequestId === requestId.value)
      && (sentOperation !== 'keyRevoke' || sentKeyId === keyId.value);
    record(`${sentOperation.toUpperCase()} · ${sentClient} · ${sentMode}`, response.status, response.body, show && current);
    if (!current) return null;
    if (response.status >= 400) error.value = gatewayMessage(response.body, response.status);
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
    const viewBody = sentOperation === 'claim' ? response.body.request : response.body;
    const armedDelivery = failNextDelivery.value && sentMode === 'simulated' && sentOperation === 'create' && response.status === 201;
    if (armedDelivery) failNextDelivery.value = false;
    if (['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation) && viewBody && typeof viewBody === 'object' && 'id' in viewBody) {
      const item = viewBody as RequestView;
      if (requestId.value !== item.id && sentOperation !== 'claim') claimToken.value = '';
      remember(item);
      requestId.value = item.id;
      if (sentOperation === 'create' && (response.status === 200 || response.status === 201)) {
        composing.value = false;
        unavailable.value = false;
        blocked.value = false;
        view.value = 'approval';
        createNotice.value = response.status === 200
          ? 'This idempotency key already exists for this client, so JaGate returned the original request.'
          : '';
      }
      if (sentOperation === 'get') { unavailable.value = false; blocked.value = false; }
    }
    if (sentOperation === 'get' && response.status !== 200) {
      unavailable.value = true;
      blocked.value = response.status === 401 || response.status === 403;
    }
    if (sentOperation === 'claim' && typeof response.body.claimToken === 'string') claimToken.value = response.body.claimToken;
    if (['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation)) await refreshHistory();
    return { status: response.status, body: response.body };
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value)
      error.value = cause instanceof Error ? cause.message : 'Request failed';
    return null;
  } finally { busy.value = false; }
}
async function loadEvents() {
  if (!requestId.value) return;
  eventCursor.value = '';
  eventCursorStack.value = [];
  await execute('events', { show: false });
}
function reloadEvents() {
  if (requestId.value && !composing.value) void loadEvents();
}
async function openCurrent() {
  const ticket = ++openTicket;
  const id = requestId.value;
  const known = selected.value?.id === id;
  if (!known) storyLoading.value = true;
  while (busy.value && ticket === openTicket) await new Promise((resolve) => setTimeout(resolve, 20));
  if (ticket !== openTicket || requestId.value !== id) return;
  const result = await execute('get', { show: false });
  if (ticket !== openTicket || requestId.value !== id) return;
  storyLoading.value = false;
  if (result?.status === 200) await loadEvents();
}
function selectFromInbox(item: RequestView) {
  sidebarSelection.value = item.id;
  void openRequest(item);
}
function clearSidebarSelection(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest('.inbox-list')) return;
  sidebarSelection.value = '';
}
async function openRequest(item: RequestView) {
  if (requestId.value !== item.id) claimToken.value = '';
  requestId.value = item.id;
  composing.value = false;
  unavailable.value = false;
  createNotice.value = '';
  telegramReply.value = '';
  view.value = 'approval';
  await openCurrent();
}
async function ask() {
  telegramReply.value = '';
  await execute('create');
  if (!composing.value && requestId.value) await loadEvents();
}
async function cancelRequest() {
  telegramReply.value = '';
  await execute('cancel');
  await loadEvents();
}
async function claimApproval() {
  await execute('claim');
  await loadEvents();
}
async function report(status: 'succeeded' | 'failed') {
  if (!bootstrap.value || busy.value) return;
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  try {
    busy.value = true;
    error.value = '';
    const response = await api('/api/execute', {
      mode: sentMode, clientId: sentClient, operation: 'result', auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}), requestId: sentRequestId,
      payload: { claimToken: claimToken.value, status, summary: resultSummary.value },
    }) as { status: number; body: Record<string, unknown> };
    const current = sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value;
    record(`RESULT · ${sentClient} · ${sentMode}`, response.status, response.body, current);
    if (!current) return;
    if (response.status >= 400) error.value = gatewayMessage(response.body, response.status);
    if (response.body && typeof response.body === 'object' && 'id' in response.body) {
      remember(response.body as RequestView);
      requestId.value = String(response.body.id);
    }
    await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value)
      error.value = cause instanceof Error ? cause.message : 'Request failed';
  } finally { busy.value = false; }
  await loadEvents();
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
async function showKeys() {
  keyCursor.value = '';
  keyCursorStack.value = [];
  await execute('keyList');
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
async function issueKey() {
  const result = await execute('keyCreate');
  if (result?.status === 201) await execute('keyList', { show: false });
}
async function revokeKey(id: string) {
  keyId.value = id;
  const result = await execute('keyRevoke');
  if (result?.status === 200) await execute('keyList', { show: false });
}
async function showAudit() {
  auditCursor.value = '';
  auditCursorStack.value = [];
  await execute('audit');
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
function useIssuedKey() { auth.value = 'scoped'; }
function eventLabel(type: string): string {
  return ({
    'request.created': 'Request created',
    'delivery.retry_scheduled': 'Delivery retry scheduled', 'delivery.failed': 'Delivery failed',
    'delivery.delivered': 'Delivered to Telegram', 'delivery.requeued': 'Delivery requeued',
    'decision.approved': 'Approved', 'decision.rejected': 'Rejected',
    'decision.expired': 'Expired', 'decision.cancelled': 'Cancelled',
    'execution.claimed': 'Claimed by the application', 'execution.succeeded': 'Application reported success',
    'execution.failed': 'Application reported failure',
  } as Record<string, string>)[type] ?? type;
}
function auditLabel(type: string): string {
  return ({
    'key.issued': 'Key issued', 'key.revoked': 'Key revoked', 'request.created': 'Request created',
    'execution.claimed': 'Approval claimed', 'execution.succeeded': 'Result reported: succeeded',
    'execution.failed': 'Result reported: failed',
  } as Record<string, string>)[type] ?? type;
}
async function decide(decision: 'approve' | 'reject') {
  if (busy.value || !requestId.value) return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  try {
    busy.value = true;
    const response = await api('/api/decide', { requestId: sentRequestId, clientId: sentClient, decision, actor: actor.value }) as { message?: string; request: RequestView };
    const current = sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value;
    record(`${decision.toUpperCase()} · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current) return;
    telegramReply.value = response.message ?? '';
    if (response.request) remember(response.request);
    await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value)
      error.value = cause instanceof Error ? cause.message : 'Decision failed';
  } finally { busy.value = false; }
  await loadEvents();
}
async function advanceTime() {
  if (busy.value) return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const openId = requestId.value;
  try {
    busy.value = true;
    const response = await api('/api/advance-time', { seconds: Number(advanceSeconds.value) });
    if (typeof (response as { now?: unknown }).now === 'string') simulatedClockOffset.value = Date.parse((response as { now: string }).now) - Date.now();
    const current = sentMode === mode.value && sentClient === clientId.value;
    record(`ADVANCE CLOCK · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current) return;
    await refreshHistory();
  } catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value)
      error.value = cause instanceof Error ? cause.message : 'Clock change failed';
  } finally { busy.value = false; }
  if (openId && requestId.value === openId && !composing.value) await openCurrent();
}
async function armDeliveryFailure() {
  if (busy.value || failNextDelivery.value) return;
  error.value = '';
  try {
    busy.value = true;
    const response = await api('/api/fail-next-delivery', {}) as { armed: boolean };
    failNextDelivery.value = response.armed;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not arm the delivery failure';
  } finally { busy.value = false; }
}
function onScopeChange(scope: ClientKeyScope, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  keyScopes.value = target.checked
    ? [...new Set([...keyScopes.value, scope])]
    : keyScopes.value.filter((item) => item !== scope);
}
function statusClass(status: string) {
  if (status === 'approved' || status === 'succeeded' || status.includes('succeeded') || status.includes('approved') || status.includes('delivered')) return 'ok';
  if (status === 'rejected' || status === 'failed' || status === 'cancelled' || status.includes('failed') || status.includes('rejected') || status.includes('cancelled')) return 'bad';
  if (status === 'pending' || status.includes('retry')) return 'wait';
  if (status === 'expired' || status.includes('expired')) return 'expired';
  return 'idle';
}
function keyState(item: ClientKeyView) {
  if (item.revokedAt) return 'Revoked';
  const now = Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0);
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return 'Expired';
  return 'Active';
}
function deliveryLine(item: RequestView) {
  if (item.deliveryStatus === 'delivered') return 'Delivered to this client’s Telegram chat.';
  if (item.deliveryStatus === 'failed') return item.deliveryError || 'Delivery failed, so a decision cannot be recorded yet.';
  if (item.deliveryStatus === 'retrying') return 'Delivery is retrying.';
  return 'Waiting for Telegram delivery.';
}

onMounted(async () => {
  document.addEventListener('pointerdown', clearSidebarSelection);
  document.addEventListener('focusin', clearSidebarSelection);
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('Could not start the playground');
    bootstrap.value = await response.json() as Bootstrap;
    const simulatedNow = Date.parse(bootstrap.value.simulatedNow);
    simulatedClockOffset.value = Number.isFinite(simulatedNow) ? simulatedNow - Date.now() : 0;
    failNextDelivery.value = bootstrap.value.failNextDelivery === true;
    clientId.value = bootstrap.value.simulatedClients[0] ?? '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start the playground'; }
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', clearSidebarSelection);
  document.removeEventListener('focusin', clearSidebarSelection);
});
</script>

<template>
  <div class="shell">
    <header class="chrome">
      <div class="topbar">
        <div class="brand">
          <img src="/logo.svg" alt="" width="28" height="28" />
          JaGate <span>Playground</span>
        </div>
        <div class="top-links">
          <a href="https://github.com/ahmetomerv/JaGate/blob/main/docs/guide/playground.md" target="_blank" rel="noreferrer">Usage guide</a>
        </div>
      </div>
      <div class="environment">
        <label class="environment-field">
          <span class="field-label">Environment <span class="mode-note">{{ mode === 'simulated' ? 'Local simulator · isolated database' : bootstrap?.gatewayUrl }}</span></span>
          <select v-model="modeSelection" aria-label="Environment">
            <option value="simulated">Simulated Telegram</option>
            <option value="live">Real gateway</option>
          </select>
        </label>
        <label>
          Client
          <select v-model="clientId" :disabled="!clients.length" aria-label="Client">
            <option v-for="option in clientOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>
          Calling as
          <select v-model="auth" aria-label="Calling as">
            <option value="valid">Bootstrap key</option>
            <option value="scoped">Issued key</option>
            <option value="missing">Missing key</option>
            <option value="invalid">Invalid key</option>
          </select>
        </label>
      </div>
      <div v-if="auth === 'scoped'" class="issued-key">
        <div class="inline-field">
          <label for="issued-key">Issued key</label>
          <input id="issued-key" v-model="scopedKey" :type="showScopedKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="Paste the key returned once" />
          <button type="button" :aria-label="showScopedKey ? 'Hide issued key' : 'Show issued key'" @click="showScopedKey = !showScopedKey">{{ showScopedKey ? 'Hide' : 'Show' }}</button>
        </div>
      </div>
      <nav class="view-nav" aria-label="Playground sections">
        <button type="button" :aria-pressed="view === 'approval'" @click="view = 'approval'">This approval</button>
        <button type="button" :aria-pressed="view === 'list'" @click="view = 'list'">All requests</button>
        <button type="button" :aria-pressed="view === 'keys'" @click="view = 'keys'">Keys</button>
        <button type="button" :aria-pressed="view === 'gateway'" @click="view = 'gateway'">Gateway</button>
      </nav>
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
      <p v-if="mode === 'live' && !clients.length" class="notice warn">Live mode needs CLIENT_KEYS in your local .env and a running gateway.</p>
    </header>

    <div class="workbench" :class="{ 'with-inbox': view === 'approval' }">
      <aside v-if="view === 'approval'" class="inbox">
        <div class="inbox-head">
          <span>This client</span>
          <button type="button" :disabled="busy" @click="refreshHistory">Refresh</button>
        </div>
        <button type="button" class="new-approval" @click="newApproval">New approval</button>
        <p v-if="!history.length" class="hint">Approvals for this client will show up here.</p>
        <div class="inbox-list">
          <button v-for="item in history" :key="item.id" type="button" :aria-pressed="sidebarSelection === item.id" @click="selectFromInbox(item)">
            <span class="inbox-title">{{ item.title }}</span>
            <span class="inbox-meta"><span class="dot" :class="statusClass(item.status)"></span><span class="inbox-id">{{ item.id.slice(0, 8) }}</span><span class="status-word">{{ item.status }}</span></span>
          </button>
        </div>
      </aside>

      <main class="workspace">
        <p v-if="simulatedExample" class="intro"><strong>{{ simulatedExample.label }}</strong> asks JaGate before it can {{ simulatedExample.scenario }}. JaGate stores the request and the person’s decision. The application performs the action.</p>
        <p v-else-if="clientId" class="intro">This client calls <code>{{ bootstrap?.gatewayUrl }}</code>. A person decides in its Telegram chat, then the application claims the approval and reports what it did.</p>

        <template v-if="view === 'approval'">
          <section v-if="composing" class="card">
            <h1>Ask for approval</h1>
            <p class="lead">Describe the action the application wants a person to approve. The same text is what that person sees in Telegram.</p>
            <div class="fields">
              <label class="span-2">Title<input v-model="title" maxlength="100" /></label>
              <label class="span-2">Description<textarea v-model="description" rows="3" maxlength="1000"></textarea></label>
              <label>Action<input v-model="action" maxlength="64" spellcheck="false" /></label>
              <label>Open for (seconds)<input v-model.number="expiresInSeconds" type="number" min="60" max="86400" /></label>
            </div>
            <div class="detail-block">
              <div class="section-row"><h2>Details the approver sees</h2><button type="button" :disabled="detailRows.length >= 10" @click="addDetail">Add detail</button></div>
              <div v-for="(row, index) in detailRows" :key="index" class="detail-row">
                <label>Label<input v-model="row.label" maxlength="40" /></label>
                <label>Value<input v-model="row.value" maxlength="160" /></label>
                <button type="button" @click="removeDetail(index)">Remove</button>
              </div>
            </div>
            <div class="fields">
              <label>Idempotency key<input v-model="idempotencyKey" maxlength="128" spellcheck="false" /></label>
              <div class="field-actions">
                <button type="button" @click="idempotencyKey = 'playground:' + Date.now()">New key</button>
                <p class="hint">Ask again with the same key and the same text to get the original request. Change the text and that key is rejected.</p>
              </div>
            </div>
            <details class="extra">
              <summary>Metadata, stored with the request and omitted from Telegram</summary>
              <label>Metadata JSON<textarea v-model="metadataText" rows="3" spellcheck="false"></textarea></label>
              <pre><code>{{ JSON.stringify(requestPreview, null, 2) }}</code></pre>
            </details>
            <div v-if="mode === 'simulated'" class="try-row">
              <button type="button" :disabled="busy || failNextDelivery" @click="armDeliveryFailure">{{ failNextDelivery ? 'Next message will fail' : 'Make the next message fail' }}</button>
              <p class="hint">The request is still saved. Telegram delivery is marked failed, so nobody can approve it until a message is delivered.</p>
            </div>
            <button type="button" :aria-busy="busy" :disabled="busy || !clientId || (auth === 'scoped' && !scopedKey)" @click="ask">{{ busy ? 'Asking…' : 'Ask for approval' }}</button>
          </section>

          <section v-else-if="!selected && (storyLoading || !unavailable)" class="card"><p class="hint">Loading this approval…</p></section>

          <section v-else-if="unavailable || !selected" class="card">
            <h1>{{ blocked ? 'This call was rejected' : 'This client cannot see that request' }}</h1>
            <p v-if="blocked" class="lead">The credential in Calling as cannot read this approval. Health and readiness stay available under Gateway.</p>
            <p v-else class="lead">Each client only reads the approvals it created. Switch back to the owning client, or start another approval.</p>
            <button type="button" @click="newApproval">New approval</button>
          </section>

          <template v-else>
            <section class="card story-head">
              <div class="story-title">
                <h1>{{ selected.title }}</h1>
                <code>{{ selected.id.slice(0, 8) }}</code>
              </div>
              <p v-if="createNotice" class="hint">{{ createNotice }}</p>
              <div class="facts">
                <span><small>Decision</small>{{ selected.status }}</span>
                <span><small>Delivery</small>{{ selected.deliveryStatus }}</span>
                <span><small>Application</small>{{ selected.executionStatus }}</span>
              </div>
            </section>

            <div class="stages">
              <section class="stage done">
                <div class="stage-rail"><span>1</span></div>
                <div class="stage-body">
                  <h2>The application asked</h2>
                  <p>{{ selected.description }}</p>
                  <dl v-if="selected.details?.length" class="details">
                    <template v-for="detail in selected.details" :key="detail.label + detail.value">
                      <dt>{{ detail.label }}</dt>
                      <dd>{{ detail.value }}</dd>
                    </template>
                  </dl>
                  <p class="hint">Action <code>{{ selected.action }}</code> · open until {{ new Date(selected.expiresAt).toLocaleString() }}</p>
                  <button v-if="selected.status === 'pending'" type="button" :disabled="busy" @click="cancelRequest">Cancel this request</button>
                </div>
              </section>

              <section class="stage" :class="stageClass('decide')">
                <div class="stage-rail"><span>2</span></div>
                <div class="stage-body">
                  <h2>A person decides in Telegram</h2>
                  <div class="chat" aria-label="Simulated chat">
                    <div class="chat-head"><strong>JaGate</strong><span>{{ clientId }}</span></div>
                    <div class="thread">
                      <p v-if="selected.deliveryStatus !== 'delivered'" class="chat-system">{{ deliveryLine(selected) }}</p>
                      <div class="message" :class="{ undelivered: selected.deliveryStatus !== 'delivered' }">
                        <span class="sender">JaGate</span>
                        <div class="bubble">
                          <strong>{{ selected.title }}</strong>
                          <p>{{ selected.description }}</p>
                          <p v-for="detail in selected.details" :key="detail.label + detail.value"><b>{{ detail.label }}:</b> {{ detail.value }}</p>
                          <p class="message-meta">Client {{ selected.clientId }} · {{ selected.action }} · {{ selected.id.slice(0, 8) }}<br>Expires {{ new Date(selected.expiresAt).toLocaleString() }}<template v-if="selected.status !== 'pending'"><br>Status {{ selected.status }}</template></p>
                        </div>
                        <div v-if="mode === 'simulated' && selected.deliveryStatus === 'delivered'" class="keyboard">
                          <button type="button" :disabled="busy || !requestId" @click="decide('approve')">Approve</button>
                          <button type="button" :disabled="busy || !requestId" @click="decide('reject')">Reject</button>
                        </div>
                      </div>
                      <div v-if="telegramReply" class="message">
                        <span class="sender">JaGate</span>
                        <p class="bubble reply" aria-live="polite">{{ telegramReply }}</p>
                      </div>
                    </div>
                    <div v-if="mode === 'simulated'" class="pressing">
                      <label>Pressing as
                        <select v-model="actor" aria-label="Who presses the button">
                          <option value="allowed">Allowlisted approver</option>
                          <option value="outsider">Someone else</option>
                        </select>
                      </label>
                    </div>
                    <div v-else class="pressing">
                      <p class="hint">Approve or reject in this client’s Telegram chat, then refresh.</p>
                      <button type="button" :disabled="busy" @click="openCurrent">Refresh</button>
                    </div>
                  </div>
                  <div v-if="mode === 'simulated'" class="clock">
                    <p class="hint">Simulated time {{ simulatedNowLabel }}. A pending request expires when the clock passes its deadline. An approval already recorded stays approved.</p>
                    <div class="clock-row">
                      <label>Seconds<input v-model.number="advanceSeconds" type="number" min="1" max="86400" aria-label="Seconds to move the clock" /></label>
                      <button type="button" :disabled="busy" @click="advanceTime">Move the clock forward</button>
                    </div>
                  </div>
                </div>
              </section>

              <section class="stage" :class="stageClass('act')">
                <div class="stage-rail"><span>3</span></div>
                <div class="stage-body">
                  <h2>The application continues</h2>
                  <template v-if="selected.status !== 'approved'">
                    <p>The application waits. It claims an approval only after the decision is approved.</p>
                  </template>
                  <template v-else-if="selected.executionStatus === 'unclaimed'">
                    <p>Claim this approval once. The application then performs the action itself and reports what happened.</p>
                    <button type="button" :disabled="busy" @click="claimApproval">Claim this approval</button>
                  </template>
                  <template v-else>
                    <p v-if="selected.resultAt">Reported {{ selected.executionStatus }}<template v-if="selected.resultSummary">: {{ selected.resultSummary }}</template>.</p>
                    <p v-else>Claimed. The application performs the action, then reports succeeded or failed.</p>
                    <div class="inline-field">
                      <label for="claim-token">Claim token</label>
                      <input id="claim-token" v-model="claimToken" :type="showClaimToken ? 'text' : 'password'" autocomplete="off" placeholder="Filled after a successful claim" />
                      <button type="button" :aria-label="showClaimToken ? 'Hide claim token' : 'Show claim token'" @click="showClaimToken = !showClaimToken">{{ showClaimToken ? 'Hide' : 'Show' }}</button>
                    </div>
                    <label>Summary<input v-model="resultSummary" maxlength="300" /></label>
                    <div class="chat-actions">
                      <button type="button" :disabled="busy || !claimToken" @click="report('succeeded')">Report succeeded</button>
                      <button type="button" :disabled="busy || !claimToken" @click="report('failed')">Report failed</button>
                      <button type="button" :disabled="busy" @click="claimApproval">Claim again</button>
                    </div>
                    <p class="hint">The token is returned once. Change it to see a rejected report. Claiming again conflicts, because the approval is already claimed.</p>
                  </template>
                </div>
              </section>

              <section class="stage" :class="stageClass('record')">
                <div class="stage-rail"><span>4</span></div>
                <div class="stage-body">
                  <h2>Request history</h2>
                  <p v-if="!eventPage" class="hint">Loading the timeline…</p>
                  <p v-else-if="!eventPage.items.length" class="hint">No events on this page.</p>
                  <ol v-else class="timeline">
                    <li v-for="event in eventPage.items" :key="event.sequence">
                      <span class="dot" :class="statusClass(event.type)"></span>
                      <div>
                        <strong>{{ eventLabel(event.type) }}</strong>
                        <small>#{{ event.sequence }} · <time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time><template v-if="event.actorId"> · Approver {{ event.actorId }}</template><template v-if="event.attempt"> · Attempt {{ event.attempt }}</template></small>
                      </div>
                    </li>
                  </ol>
                  <div class="pager">
                    <label>Events per page<input v-model.number="eventLimit" type="number" min="1" max="100" @change="reloadEvents" /></label>
                    <span>Page {{ eventCursorStack.length + 1 }}</span>
                    <div class="chat-actions">
                      <button type="button" :disabled="busy || !eventCursorStack.length" @click="previousEventPage">Previous</button>
                      <button type="button" :disabled="busy || !eventPage?.nextCursor" @click="nextEventPage">Next</button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </template>
        </template>

        <section v-else-if="view === 'list'" class="card">
          <h1>All requests</h1>
          <p class="lead">Every row belongs to the selected client. Open one to continue its approval.</p>
          <div class="attention" role="group" aria-label="Requests needing attention">
            <button type="button" :disabled="busy" @click="applyAttention('delivery')">Failed delivery</button>
            <button type="button" :disabled="busy" @click="applyAttention('claimed')">Old claims</button>
            <button type="button" :disabled="busy" @click="applyAttention('expiry')">Expiring soon</button>
            <button type="button" :disabled="busy" @click="applyAttention('all')">Clear filters</button>
            <label>Window (minutes)<input v-model.number="attentionMinutes" type="number" min="1" max="1440" aria-label="Attention window in minutes" /></label>
          </div>
          <p class="hint">Failed delivery lists pending requests whose Telegram message failed. Old claims are approvals still claimed, with no result, before the cutoff. Expiring soon lists pending requests that reach their deadline inside the window. The cutoff stays fixed while you page.</p>
          <div class="fields">
            <label>Decision
              <select v-model="listStatus" aria-label="Decision">
                <option value="">Any</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label>Delivery
              <select v-model="listDeliveryStatus" aria-label="Delivery">
                <option value="">Any</option><option value="pending">Pending</option><option value="retrying">Retrying</option><option value="delivered">Delivered</option><option value="failed">Failed</option>
              </select>
            </label>
            <label>Application
              <select v-model="listExecutionStatus" aria-label="Application">
                <option value="">Any</option><option value="unclaimed">Unclaimed</option><option value="claimed">Claimed</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option>
              </select>
            </label>
            <label>Page size<input v-model.number="listLimit" type="number" min="1" max="100" /></label>
            <label>Claimed before <span class="muted">UTC</span><input v-model.trim="listClaimedBefore" placeholder="UTC timestamp" spellcheck="false" /></label>
            <label>Expires before <span class="muted">UTC</span><input v-model.trim="listExpiresBefore" placeholder="UTC timestamp" spellcheck="false" /></label>
          </div>
          <button type="button" :disabled="busy || !clientId" @click="showRequests">Show these requests</button>
          <div v-if="listPage" class="result-list">
            <p v-if="!listPage.items.length" class="hint">No requests match these filters.</p>
            <button v-for="item in listPage.items" :key="item.id" type="button" class="row-button" @click="openRequest(item)">
              <span class="row-copy"><strong>{{ item.title }}</strong><small>{{ item.status }} · {{ item.deliveryStatus }} · {{ item.executionStatus }}</small><small>{{ new Date(item.createdAt).toLocaleString() }}</small></span>
            </button>
            <div class="pager">
              <span>Page {{ listCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <button type="button" :disabled="busy || !listCursorStack.length" @click="previousPage">Previous</button>
                <button type="button" :disabled="busy || !listPage.nextCursor" @click="nextPage">Next</button>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="view === 'keys'" class="card">
          <h1>Keys</h1>
          <p class="lead">The bootstrap key issues keys for this client. An issued key can call only the operations you allow, and it cannot issue keys or read the audit log.</p>
          <div class="fields">
            <label class="span-2">Name<input v-model="keyLabel" maxlength="80" placeholder="Name the app or worker" /></label>
            <label class="span-2">Expires at <span class="muted">optional UTC</span><input v-model.trim="keyExpiresAt" placeholder="Leave empty for no expiry" spellcheck="false" /></label>
          </div>
          <div class="chat-actions">
            <button type="button" @click="setKeyExpiryOneHour">Expire in 1 hour</button>
            <button type="button" @click="keyExpiresAt = ''">No expiry</button>
          </div>
          <fieldset>
            <legend>This key may</legend>
            <div class="scopes">
              <label v-for="scope in availableKeyScopes" :key="scope"><input type="checkbox" :checked="keyScopes.includes(scope)" @change="onScopeChange(scope, $event)" />{{ scopeLabels[scope] }} <span class="muted">{{ scope }}</span></label>
            </div>
          </fieldset>
          <button type="button" :disabled="busy || !clientId || auth !== 'valid'" @click="issueKey">Issue key</button>
          <div v-if="scopedKey" class="callout">
            <p>A key is held for this browser session. It is shown once. Copy it, then call as that key.</p>
            <div class="inline-field">
              <label for="session-key">Issued key</label>
              <input id="session-key" v-model="scopedKey" :type="showScopedKey ? 'text' : 'password'" autocomplete="off" spellcheck="false" />
              <button type="button" :aria-label="showScopedKey ? 'Hide issued key' : 'Show issued key'" @click="showScopedKey = !showScopedKey">{{ showScopedKey ? 'Hide' : 'Show' }}</button>
            </div>
            <button type="button" @click="useIssuedKey">Call as this key</button>
          </div>
          <div class="section-row"><h2>Issued keys</h2><button type="button" :disabled="busy || !clientId" @click="showKeys">Show keys</button></div>
          <p class="hint">Secret values are never listed. Revocation takes effect on the next call. The bootstrap key is rotated in .env.</p>
          <label>Page size<input v-model.number="keyLimit" type="number" min="1" max="100" aria-label="Key page size" /></label>
          <div v-if="keyPage" class="result-list">
            <p v-if="!keyPage.items.length" class="hint">No issued keys on this page.</p>
            <div v-for="item in keyPage.items" :key="item.id" class="key-row">
              <span class="row-copy"><strong>{{ item.label }}</strong><small>{{ item.scopes.join(', ') }}</small><small>{{ item.expiresAt ? 'Expires ' + new Date(item.expiresAt).toLocaleString() : 'No expiry' }}</small></span>
              <span class="muted">{{ keyState(item) }}</span>
              <button type="button" :disabled="busy || !!item.revokedAt" @click="revokeKey(item.id)">Revoke</button>
            </div>
            <div class="pager">
              <span>Page {{ keyCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <button type="button" :disabled="busy || !keyCursorStack.length" @click="previousKeyPage">Previous</button>
                <button type="button" :disabled="busy || !keyPage.nextCursor" @click="nextKeyPage">Next</button>
              </div>
            </div>
          </div>
          <div class="section-row"><h2>Audit</h2><button type="button" :disabled="busy || !clientId || auth !== 'valid'" @click="showAudit">Show audit</button></div>
          <p class="hint">Newest first. Rows name key ids, never the secret or the claim token. An issued key cannot read this list.</p>
          <div class="fields">
            <label>Page size<input v-model.number="auditLimit" type="number" min="1" max="100" aria-label="Audit page size" /></label>
            <label>Request id<input v-model.trim="auditRequestId" placeholder="Filter by request" spellcheck="false" /></label>
            <label class="span-2">Key id<input v-model.trim="auditKeyId" placeholder="Actor or affected key" spellcheck="false" /></label>
          </div>
          <div v-if="auditPage" class="result-list">
            <p v-if="!auditPage.items.length" class="hint">No audit events match these filters.</p>
            <div v-for="event in auditPage.items" :key="event.id" class="row-copy audit-row">
              <strong>{{ auditLabel(event.type) }}</strong>
              <small><time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time> · {{ event.actor === 'bootstrap' ? 'Bootstrap key' : 'Issued key ' + event.actorKeyId }}</small>
              <small v-if="event.requestId">Request {{ event.requestId }}</small>
              <small v-if="event.subjectKeyId">Key {{ event.subjectKeyId }}</small>
            </div>
            <div class="pager">
              <span>Page {{ auditCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <button type="button" :disabled="busy || !auditCursorStack.length" @click="previousAuditPage">Previous</button>
                <button type="button" :disabled="busy || !auditPage.nextCursor" @click="nextAuditPage">Next</button>
              </div>
            </div>
          </div>
        </section>

        <section v-else class="card">
          <h1>Gateway</h1>
          <p class="lead">Health and readiness are public. They answer even when Calling as is missing or invalid.</p>
          <div class="gateway-actions">
            <button type="button" :disabled="busy" @click="execute('health')">Check health</button>
            <button type="button" :disabled="busy" @click="execute('ready')">Check readiness</button>
          </div>
          <p class="hint">Readiness needs working storage and, on a real gateway, a live Telegram connection. The simulator reports ready without a bot.</p>
        </section>

        <details v-if="visibleEntry || entries.length" class="api-panel">
          <summary>
            <span class="summary-label">API response</span>
            <span class="summary-aside">
              <strong v-if="visibleEntry" :class="visibleEntry.status >= 400 ? 'status-bad' : 'status-ok'">HTTP {{ visibleEntry.status }}</strong>
              <span class="disclosure"><span class="when-closed">Show</span><span class="when-open">Hide</span></span>
            </span>
          </summary>
          <div class="editor-bar">
            <div class="tabs" role="tablist" aria-label="Response view">
              <button type="button" role="tab" :aria-selected="responseTab === 'body'" @click="responseTab = 'body'">Body</button>
              <button type="button" role="tab" :aria-selected="responseTab === 'history'" @click="responseTab = 'history'">History ({{ entries.length }})</button>
            </div>
            <button v-if="visibleEntry && responseTab === 'body'" type="button" @click="copyResponse">{{ copied ? 'Copied' : 'Copy JSON' }}</button>
          </div>
          <div v-if="responseTab === 'body'">
            <template v-if="visibleEntry">
              <p class="hint">{{ visibleEntry.label }} · {{ visibleEntry.time }}</p>
              <pre><code>{{ JSON.stringify(visibleEntry.body, null, 2) }}</code></pre>
            </template>
          </div>
          <div v-else class="result-list">
            <button v-for="(entry, index) in entries" :key="index" type="button" class="row-button" :aria-pressed="activeEntry === index" @click="activeEntry = index; responseTab = 'body'">
              <span class="meta" :class="entry.status >= 400 ? 'status-bad' : 'status-ok'">{{ entry.status }}</span>
              <strong class="row-copy">{{ entry.label }}</strong>
              <time class="muted">{{ entry.time }}</time>
            </button>
          </div>
        </details>
      </main>
    </div>
  </div>
</template>
