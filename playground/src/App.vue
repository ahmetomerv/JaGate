<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

type Mode = 'simulated' | 'live';
type View = 'approval' | 'list' | 'keys' | 'gateway';
type Operation
  = | 'create'
    | 'list'
    | 'get'
    | 'events'
    | 'cancel'
    | 'claim'
    | 'result'
    | 'keyCreate'
    | 'keyList'
    | 'keyRevoke'
    | 'audit'
    | 'health'
    | 'ready';
type ClientKeyScope
  = 'requests:create' | 'requests:read' | 'requests:cancel' | 'requests:claim' | 'requests:result';
interface ClientKeyView {
  id: string;
  clientId: string;
  label: string;
  scopes: ClientKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
interface KeyPage { items: ClientKeyView[]; nextCursor: string | null }
interface AuditEvent {
  id: number;
  type: string;
  occurredAt: string;
  actor: 'bootstrap' | 'issued_key';
  actorKeyId: string | null;
  requestId: string | null;
  subjectKeyId: string | null;
}
interface AuditPage { items: AuditEvent[]; nextCursor: string | null }
interface Detail { label: string; value: string }
interface RequestView {
  id: string;
  clientId: string;
  title: string;
  action: string;
  description?: string;
  details?: Detail[];
  status: string;
  executionStatus: string;
  deliveryStatus: string;
  deliveryAttempts: number;
  deliveryError?: string | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  resultSummary: string | null;
  resultAt?: string | null;
}
interface ListPage { items: RequestView[]; nextCursor: string | null }
interface RequestEvent {
  sequence: number;
  type: string;
  occurredAt: string;
  actorId: string | null;
  attempt: number | null;
}
interface EventPage { items: RequestEvent[]; nextCursor: string | null }
interface Entry { time: string; label: string; status: number; body: unknown }
interface ExampleRequest {
  idempotencyKey: string;
  action: string;
  title: string;
  description: string;
  details: Detail[];
  metadata: Record<string, unknown>;
  expiresInSeconds: number;
}
interface SimulatedExample { label: string; scenario: string; request: ExampleRequest }
interface Bootstrap {
  token: string;
  simulatedClients: string[];
  simulatedExamples: Record<string, SimulatedExample>;
  liveClients: string[];
  gatewayUrl: string;
  simulatedNow: string;
  failNextDelivery?: boolean;
}
interface Executed { status: number; body: Record<string, unknown> }

const defaultRequest: ExampleRequest = {
  idempotencyKey: 'playground:local-test',
  action: 'test-action',
  title: 'Test a local approval',
  description: 'A harmless request made from the JaGate playground.',
  details: [{ label: 'Environment', value: 'local' }],
  metadata: { source: 'playground' },
  expiresInSeconds: 900,
};
const availableKeyScopes: ClientKeyScope[] = [
  'requests:create',
  'requests:read',
  'requests:cancel',
  'requests:claim',
  'requests:result',
];
const scopeLabels: Record<ClientKeyScope, string> = {
  'requests:create': 'Ask for approval',
  'requests:read': 'Read requests',
  'requests:cancel': 'Cancel a request',
  'requests:claim': 'Claim an approval',
  'requests:result': 'Report a result',
};

const bootstrap = ref<Bootstrap | null>(null);
const mode = ref<Mode>('simulated');
const view = ref<View>('approval');
const sidebarSelection = ref('');
const clientId = ref('');
const auth = ref<'valid' | 'scoped' | 'missing' | 'invalid'>('valid');
const scopedKey = ref('');
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
const listStatus = ref('any');
const listDeliveryStatus = ref('any');
const listExecutionStatus = ref('any');
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
const detailRows = ref<Detail[]>(defaultRequest.details.map(item => ({ ...item })));
const metadataText = ref(JSON.stringify(defaultRequest.metadata, null, 2));
const actor = ref<'allowed' | 'outsider'>('allowed');
const advanceSeconds = ref(61);
const claimToken = ref('');
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

const clients = computed(() =>
  mode.value === 'simulated'
    ? (bootstrap.value?.simulatedClients ?? [])
    : (bootstrap.value?.liveClients ?? []),
);
const simulatedExample = computed(() =>
  mode.value === 'simulated' ? bootstrap.value?.simulatedExamples[clientId.value] : undefined,
);
const selected = computed(() =>
  [...history.value, ...(listPage.value?.items ?? [])].find(item => item.id === requestId.value),
);
const visibleEntry = computed(() =>
  activeEntry.value === null ? undefined : entries.value[activeEntry.value],
);
const clientOptions = computed(() =>
  clients.value.map(id => ({
    value: id,
    label: mode.value === 'simulated' ? (bootstrap.value?.simulatedExamples[id]?.label ?? id) : id,
  })),
);
const simulatedNowLabel = computed(() =>
  new Date(Date.now() + simulatedClockOffset.value).toLocaleString(),
);
const phase = computed(() => {
  const item = selected.value;
  if (!item || item.status === 'pending')
    return 'decide';
  if (
    item.status === 'approved'
    && (item.executionStatus === 'unclaimed' || item.executionStatus === 'claimed')
  ) {
    return 'act';
  }
  return 'record';
});
const listFilters = computed(() => ({
  ...(listStatus.value !== 'any' ? { status: listStatus.value } : {}),
  ...(listDeliveryStatus.value !== 'any' ? { deliveryStatus: listDeliveryStatus.value } : {}),
  ...(listExecutionStatus.value !== 'any' ? { executionStatus: listExecutionStatus.value } : {}),
  ...(listClaimedBefore.value ? { claimedBefore: listClaimedBefore.value } : {}),
  ...(listExpiresBefore.value ? { expiresBefore: listExpiresBefore.value } : {}),
  limit: Number(listLimit.value),
  ...(listCursor.value ? { cursor: listCursor.value } : {}),
}));
const eventFilters = computed(() => ({
  limit: Number(eventLimit.value),
  ...(eventCursor.value ? { cursor: eventCursor.value } : {}),
}));
const keyFilters = computed(() => ({
  limit: Number(keyLimit.value),
  ...(keyCursor.value ? { cursor: keyCursor.value } : {}),
}));
const auditFilters = computed(() => ({
  limit: Number(auditLimit.value),
  ...(auditRequestId.value ? { requestId: auditRequestId.value } : {}),
  ...(auditKeyId.value ? { keyId: auditKeyId.value } : {}),
  ...(auditCursor.value ? { cursor: auditCursor.value } : {}),
}));
const requestPreview = computed(() => ({
  idempotencyKey: idempotencyKey.value,
  action: action.value,
  title: title.value,
  description: description.value,
  details: cleanDetails(),
  metadata: parsePreview(metadataText.value),
  expiresInSeconds: Number(expiresInSeconds.value),
}));

watch(
  [
    listStatus,
    listDeliveryStatus,
    listExecutionStatus,
    listClaimedBefore,
    listExpiresBefore,
    listLimit,
    clientId,
    mode,
  ],
  () => {
    listCursor.value = '';
    listCursorStack.value = [];
    listPage.value = null;
  },
);
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
  if (keepOpen)
    storyLoading.value = true;
  void refreshHistory().then(() => {
    if (keepOpen && requestId.value === openId && !composing.value)
      void openCurrent();
  });
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
  detailRows.value = example.details.map(item => ({ ...item }));
  metadataText.value = JSON.stringify(example.metadata, null, 2);
}
function cleanDetails(): Detail[] {
  return detailRows.value
    .filter(row => row.label.trim() || row.value.trim())
    .map(row => ({ label: row.label.trim(), value: row.value.trim() }));
}
function addDetail() {
  if (detailRows.value.length >= 10)
    return;
  detailRows.value.push({ label: '', value: '' });
}
function removeDetail(index: number) {
  detailRows.value.splice(index, 1);
}
function parsePreview(value: string) {
  try {
    return JSON.parse(value) as unknown;
  }
  catch {
    return value;
  }
}
function clearDisplayedResponse() {
  activeEntry.value = null;
  responseTab.value = 'body';
  copied.value = false;
}
function applyAttention(kind: 'all' | 'delivery' | 'claimed' | 'expiry') {
  const minutes = Number(attentionMinutes.value);
  if (
    kind !== 'all'
    && kind !== 'delivery'
    && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
  ) {
    error.value = 'Choose a window from 1 to 1440 minutes.';
    return;
  }
  error.value = '';
  const now = Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0);
  listStatus.value
    = kind === 'delivery' || kind === 'expiry' ? 'pending' : kind === 'claimed' ? 'approved' : 'any';
  listDeliveryStatus.value = kind === 'delivery' ? 'failed' : 'any';
  listExecutionStatus.value = kind === 'claimed' ? 'claimed' : 'any';
  listClaimedBefore.value
    = kind === 'claimed' ? new Date(now - minutes * 60_000).toISOString() : '';
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
  keyExpiresAt.value = new Date(
    Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0) + 3_600_000,
  ).toISOString();
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
  if (place < here)
    return 'done';
  if (place === here)
    return 'current';
  return 'upcoming';
}
function remember(item: RequestView) {
  history.value = [item, ...history.value.filter(existing => existing.id !== item.id)].slice(
    0,
    100,
  );
}
function gatewayMessage(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'error' in body) {
    const cause = (body as { error: unknown }).error;
    if (typeof cause === 'string')
      return cause;
    if (
      cause
      && typeof cause === 'object'
      && 'message' in cause
      && typeof (cause as { message: unknown }).message === 'string'
    ) {
      return (cause as { message: string }).message;
    }
  }
  return `The gateway returned HTTP ${status}.`;
}
async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-playground-token': bootstrap.value!.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : `Playground error ${response.status}`,
    );
  }
  return data;
}
function record(label: string, status: number, body: unknown, show = true) {
  entries.value = [
    { time: new Date().toLocaleTimeString(), label, status, body },
    ...entries.value,
  ].slice(0, 20);
  if (show) {
    activeEntry.value = 0;
    responseTab.value = 'body';
    copied.value = false;
  }
  else if (activeEntry.value !== null) {
    activeEntry.value = activeEntry.value + 1 < entries.value.length ? activeEntry.value + 1 : null;
  }
}
async function copyResponse() {
  if (!visibleEntry.value)
    return;
  await navigator.clipboard.writeText(JSON.stringify(visibleEntry.value.body, null, 2));
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1800);
}
async function refreshHistory() {
  if (!bootstrap.value || !clientId.value) {
    history.value = [];
    return;
  }
  const currentMode = mode.value;
  const currentClient = clientId.value;
  try {
    const response = (await api('/api/execute', {
      mode: currentMode,
      clientId: currentClient,
      operation: 'list',
      auth: 'valid',
      filters: { limit: 20 },
    })) as { status: number; body: ListPage };
    if (currentMode === mode.value && currentClient === clientId.value)
      history.value = response.status === 200 ? response.body.items : [];
  }
  catch {
    if (currentMode === mode.value && currentClient === clientId.value)
      history.value = [];
  }
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
async function execute(
  sentOperation: Operation,
  options?: { show?: boolean },
): Promise<Executed | null> {
  if (!bootstrap.value || busy.value)
    return null;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  const sentKeyId = keyId.value;
  let payload: unknown;
  if (sentOperation === 'create') {
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText.value) as unknown;
    }
    catch {
      error.value = 'Metadata must be a JSON object.';
      return null;
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      error.value = 'Metadata must be a JSON object.';
      return null;
    }
    payload = {
      idempotencyKey: idempotencyKey.value,
      action: action.value,
      title: title.value,
      description: description.value,
      details: cleanDetails(),
      metadata,
      expiresInSeconds: Number(expiresInSeconds.value),
    };
  }
  if (sentOperation === 'keyCreate') {
    payload = {
      label: keyLabel.value,
      scopes: keyScopes.value,
      ...(keyExpiresAt.value ? { expiresAt: keyExpiresAt.value } : {}),
    };
  }
  const show = options?.show !== false;
  try {
    busy.value = true;
    const response = (await api('/api/execute', {
      mode: sentMode,
      clientId: sentClient,
      operation: sentOperation,
      auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}),
      requestId: requestId.value,
      keyId: keyId.value,
      ...(sentOperation === 'list' ? { filters: listFilters.value } : {}),
      ...(sentOperation === 'events' ? { eventPage: eventFilters.value } : {}),
      ...(sentOperation === 'keyList' ? { keyPage: keyFilters.value } : {}),
      payload,
      ...(sentOperation === 'audit' ? { auditPage: auditFilters.value } : {}),
    })) as { status: number; body: Record<string, unknown> };
    const current
      = sentMode === mode.value
        && sentClient === clientId.value
        && (!['get', 'events', 'cancel', 'claim', 'result'].includes(sentOperation)
          || sentRequestId === requestId.value)
        && (sentOperation !== 'keyRevoke' || sentKeyId === keyId.value);
    record(
      `${sentOperation.toUpperCase()} · ${sentClient} · ${sentMode}`,
      response.status,
      response.body,
      show && current,
    );
    if (!current)
      return null;
    if (response.status >= 400)
      error.value = gatewayMessage(response.body, response.status);
    if (sentOperation === 'list')
      listPage.value = response.status === 200 ? (response.body as unknown as ListPage) : null;
    if (sentOperation === 'events')
      eventPage.value = response.status === 200 ? (response.body as unknown as EventPage) : null;
    if (sentOperation === 'keyList')
      keyPage.value = response.status === 200 ? (response.body as unknown as KeyPage) : null;
    if (sentOperation === 'audit')
      auditPage.value = response.status === 200 ? (response.body as unknown as AuditPage) : null;
    if (sentOperation === 'keyCreate' && response.status === 201) {
      keyId.value = String(response.body.id);
      scopedKey.value = String(response.body.key);
      keyPage.value = null;
      auditPage.value = null;
    }
    if (sentOperation === 'keyRevoke' && response.status === 200) {
      keyPage.value = null;
      auditPage.value = null;
    }
    const viewBody = sentOperation === 'claim' ? response.body.request : response.body;
    const armedDelivery
      = failNextDelivery.value
        && sentMode === 'simulated'
        && sentOperation === 'create'
        && response.status === 201;
    if (armedDelivery)
      failNextDelivery.value = false;
    if (
      ['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation)
      && viewBody
      && typeof viewBody === 'object'
      && 'id' in viewBody
    ) {
      const item = viewBody as RequestView;
      if (requestId.value !== item.id && sentOperation !== 'claim')
        claimToken.value = '';
      remember(item);
      requestId.value = item.id;
      if (sentOperation === 'create' && (response.status === 200 || response.status === 201)) {
        composing.value = false;
        unavailable.value = false;
        blocked.value = false;
        view.value = 'approval';
        createNotice.value
          = response.status === 200
            ? 'This idempotency key already exists for this client, so JaGate returned the original request.'
            : '';
      }
      if (sentOperation === 'get') {
        unavailable.value = false;
        blocked.value = false;
      }
    }
    if (sentOperation === 'get' && response.status !== 200) {
      unavailable.value = true;
      blocked.value = response.status === 401 || response.status === 403;
    }
    if (sentOperation === 'claim' && typeof response.body.claimToken === 'string')
      claimToken.value = response.body.claimToken;
    if (['create', 'get', 'cancel', 'claim', 'result'].includes(sentOperation))
      await refreshHistory();
    return { status: response.status, body: response.body };
  }
  catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value)
      error.value = cause instanceof Error ? cause.message : 'Request failed';
    return null;
  }
  finally {
    busy.value = false;
  }
}
async function loadEvents() {
  if (!requestId.value)
    return;
  eventCursor.value = '';
  eventCursorStack.value = [];
  await execute('events', { show: false });
}
function reloadEvents() {
  if (requestId.value && !composing.value)
    void loadEvents();
}
async function openCurrent() {
  const ticket = ++openTicket;
  const id = requestId.value;
  const known = selected.value?.id === id;
  if (!known)
    storyLoading.value = true;
  while (busy.value) {
    if (ticket !== openTicket)
      break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (ticket !== openTicket || requestId.value !== id)
    return;
  const result = await execute('get', { show: false });
  if (ticket !== openTicket || requestId.value !== id)
    return;
  storyLoading.value = false;
  if (result?.status === 200)
    await loadEvents();
}
function selectFromInbox(item: RequestView) {
  sidebarSelection.value = item.id;
  void openRequest(item);
}
function clearSidebarSelection(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest('.inbox-list'))
    return;
  sidebarSelection.value = '';
}
async function openRequest(item: RequestView) {
  if (requestId.value !== item.id)
    claimToken.value = '';
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
  if (!composing.value && requestId.value)
    await loadEvents();
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
  if (!bootstrap.value || busy.value)
    return;
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  try {
    busy.value = true;
    error.value = '';
    const response = (await api('/api/execute', {
      mode: sentMode,
      clientId: sentClient,
      operation: 'result',
      auth: auth.value,
      ...(auth.value === 'scoped' ? { scopedKey: scopedKey.value } : {}),
      requestId: sentRequestId,
      payload: { claimToken: claimToken.value, status, summary: resultSummary.value },
    })) as { status: number; body: Record<string, unknown> };
    const current
      = sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value;
    record(`RESULT · ${sentClient} · ${sentMode}`, response.status, response.body, current);
    if (!current)
      return;
    if (response.status >= 400)
      error.value = gatewayMessage(response.body, response.status);
    if (response.body && typeof response.body === 'object' && 'id' in response.body) {
      remember(response.body as RequestView);
      requestId.value = String(response.body.id);
    }
    await refreshHistory();
  }
  catch (cause) {
    if (
      sentMode === mode.value
      && sentClient === clientId.value
      && sentRequestId === requestId.value
    ) {
      error.value = cause instanceof Error ? cause.message : 'Request failed';
    }
  }
  finally {
    busy.value = false;
  }
  await loadEvents();
}
async function nextPage() {
  if (!listPage.value?.nextCursor || busy.value)
    return;
  listCursorStack.value.push(listCursor.value);
  listCursor.value = listPage.value.nextCursor;
  await execute('list');
}
async function previousPage() {
  if (!listCursorStack.value.length || busy.value)
    return;
  listCursor.value = listCursorStack.value.pop()!;
  await execute('list');
}
async function nextEventPage() {
  if (!eventPage.value?.nextCursor || busy.value)
    return;
  eventCursorStack.value.push(eventCursor.value);
  eventCursor.value = eventPage.value.nextCursor;
  await execute('events');
}
async function previousEventPage() {
  if (!eventCursorStack.value.length || busy.value)
    return;
  eventCursor.value = eventCursorStack.value.pop()!;
  await execute('events');
}
async function showKeys() {
  keyCursor.value = '';
  keyCursorStack.value = [];
  await execute('keyList');
}
async function nextKeyPage() {
  if (!keyPage.value?.nextCursor || busy.value)
    return;
  keyCursorStack.value.push(keyCursor.value);
  keyCursor.value = keyPage.value.nextCursor;
  await execute('keyList');
}
async function previousKeyPage() {
  if (!keyCursorStack.value.length || busy.value)
    return;
  keyCursor.value = keyCursorStack.value.pop()!;
  await execute('keyList');
}
async function issueKey() {
  const result = await execute('keyCreate');
  if (result?.status === 201)
    await execute('keyList', { show: false });
}
async function revokeKey(id: string) {
  keyId.value = id;
  const result = await execute('keyRevoke');
  if (result?.status === 200)
    await execute('keyList', { show: false });
}
async function showAudit() {
  auditCursor.value = '';
  auditCursorStack.value = [];
  await execute('audit');
}
async function nextAuditPage() {
  if (!auditPage.value?.nextCursor || busy.value)
    return;
  auditCursorStack.value.push(auditCursor.value);
  auditCursor.value = auditPage.value.nextCursor;
  await execute('audit');
}
async function previousAuditPage() {
  if (!auditCursorStack.value.length || busy.value)
    return;
  auditCursor.value = auditCursorStack.value.pop()!;
  await execute('audit');
}
function useIssuedKey() {
  auth.value = 'scoped';
}
function eventLabel(type: string): string {
  return (
    (
      {
        'request.created': 'Request created',
        'delivery.retry_scheduled': 'Delivery retry scheduled',
        'delivery.failed': 'Delivery failed',
        'delivery.delivered': 'Delivered to Telegram',
        'delivery.requeued': 'Delivery requeued',
        'decision.approved': 'Approved',
        'decision.rejected': 'Rejected',
        'decision.expired': 'Expired',
        'decision.cancelled': 'Cancelled',
        'execution.claimed': 'Claimed by the application',
        'execution.succeeded': 'Application reported success',
        'execution.failed': 'Application reported failure',
      } as Record<string, string>
    )[type] ?? type
  );
}
function auditLabel(type: string): string {
  return (
    (
      {
        'key.issued': 'Key issued',
        'key.revoked': 'Key revoked',
        'request.created': 'Request created',
        'execution.claimed': 'Approval claimed',
        'execution.succeeded': 'Result reported: succeeded',
        'execution.failed': 'Result reported: failed',
      } as Record<string, string>
    )[type] ?? type
  );
}
async function decide(decision: 'approve' | 'reject') {
  if (busy.value || !requestId.value)
    return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const sentRequestId = requestId.value;
  try {
    busy.value = true;
    const response = (await api('/api/decide', {
      requestId: sentRequestId,
      clientId: sentClient,
      decision,
      actor: actor.value,
    })) as { message?: string; request: RequestView };
    const current
      = sentMode === mode.value && sentClient === clientId.value && sentRequestId === requestId.value;
    record(`${decision.toUpperCase()} · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current)
      return;
    telegramReply.value = response.message ?? '';
    if (response.request)
      remember(response.request);
    await refreshHistory();
  }
  catch (cause) {
    if (
      sentMode === mode.value
      && sentClient === clientId.value
      && sentRequestId === requestId.value
    ) {
      error.value = cause instanceof Error ? cause.message : 'Decision failed';
    }
  }
  finally {
    busy.value = false;
  }
  await loadEvents();
}
async function advanceTime() {
  if (busy.value)
    return;
  error.value = '';
  const sentMode = mode.value;
  const sentClient = clientId.value;
  const openId = requestId.value;
  try {
    busy.value = true;
    const response = await api('/api/advance-time', { seconds: Number(advanceSeconds.value) });
    if (typeof (response as { now?: unknown }).now === 'string')
      simulatedClockOffset.value = Date.parse((response as { now: string }).now) - Date.now();
    const current = sentMode === mode.value && sentClient === clientId.value;
    record(`ADVANCE CLOCK · ${sentClient} · ${sentMode}`, 200, response, current);
    if (!current)
      return;
    await refreshHistory();
  }
  catch (cause) {
    if (sentMode === mode.value && sentClient === clientId.value)
      error.value = cause instanceof Error ? cause.message : 'Clock change failed';
  }
  finally {
    busy.value = false;
  }
  if (openId && requestId.value === openId && !composing.value)
    await openCurrent();
}
async function armDeliveryFailure() {
  if (busy.value || failNextDelivery.value)
    return;
  error.value = '';
  try {
    busy.value = true;
    const response = (await api('/api/fail-next-delivery', {})) as { armed: boolean };
    failNextDelivery.value = response.armed;
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not arm the delivery failure';
  }
  finally {
    busy.value = false;
  }
}
function statusClass(status: string) {
  if (
    status === 'approved'
    || status === 'succeeded'
    || status.includes('succeeded')
    || status.includes('approved')
    || status.includes('delivered')
  ) {
    return 'ok';
  }
  if (
    status === 'rejected'
    || status === 'failed'
    || status === 'cancelled'
    || status.includes('failed')
    || status.includes('rejected')
    || status.includes('cancelled')
  ) {
    return 'bad';
  }
  if (status === 'pending' || status.includes('retry'))
    return 'wait';
  if (status === 'expired' || status.includes('expired'))
    return 'expired';
  return 'idle';
}
function keyState(item: ClientKeyView) {
  if (item.revokedAt)
    return 'Revoked';
  const now = Date.now() + (mode.value === 'simulated' ? simulatedClockOffset.value : 0);
  if (item.expiresAt && Date.parse(item.expiresAt) <= now)
    return 'Expired';
  return 'Active';
}
function deliveryLine(item: RequestView) {
  if (item.deliveryStatus === 'delivered')
    return 'Delivered to this client’s Telegram chat.';
  if (item.deliveryStatus === 'failed')
    return item.deliveryError || 'Delivery failed, so a decision cannot be recorded yet.';
  if (item.deliveryStatus === 'retrying')
    return 'Delivery is retrying.';
  return 'Waiting for Telegram delivery.';
}

onMounted(async () => {
  document.addEventListener('pointerdown', clearSidebarSelection);
  document.addEventListener('focusin', clearSidebarSelection);
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok)
      throw new Error('Could not start the playground');
    bootstrap.value = (await response.json()) as Bootstrap;
    const simulatedNow = Date.parse(bootstrap.value.simulatedNow);
    simulatedClockOffset.value = Number.isFinite(simulatedNow) ? simulatedNow - Date.now() : 0;
    failNextDelivery.value = bootstrap.value.failNextDelivery === true;
    clientId.value = bootstrap.value.simulatedClients[0] ?? '';
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not start the playground';
  }
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
          <img src="/logo.svg" alt="" width="28" height="28">
          JaGate <span>Playground</span>
        </div>
        <div class="top-links">
          <el-link
            href="https://github.com/ahmetomerv/JaGate/blob/main/docs/guide/playground.md"
            target="_blank"
            rel="noreferrer"
          >
            Usage guide
          </el-link>
        </div>
      </div>
      <div class="environment">
        <label class="environment-field">
          <span class="field-label">Environment
            <span class="mode-note">{{
              mode === 'simulated' ? 'Local simulator · isolated database' : bootstrap?.gatewayUrl
            }}</span></span>
          <el-select v-model="modeSelection" aria-label="Environment">
            <el-option label="Simulated Telegram" value="simulated" />
            <el-option label="Real gateway" value="live" />
          </el-select>
        </label>
        <label>
          Client
          <el-select v-model="clientId" :disabled="!clients.length" aria-label="Client">
            <el-option
              v-for="option in clientOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </label>
        <label>
          Calling as
          <el-select v-model="auth" aria-label="Calling as">
            <el-option label="Bootstrap key" value="valid" />
            <el-option label="Issued key" value="scoped" />
            <el-option label="Missing key" value="missing" />
            <el-option label="Invalid key" value="invalid" />
          </el-select>
        </label>
      </div>
      <div v-if="auth === 'scoped'" class="issued-key">
        <label for="issued-key">Issued key
          <el-input
            id="issued-key"
            v-model="scopedKey"
            type="password"
            show-password
            autocomplete="off"
            spellcheck="false"
            placeholder="Paste the key returned once"
          />
        </label>
      </div>
      <nav class="view-nav" aria-label="Playground sections">
        <el-button :type="view === 'approval' ? 'primary' : 'default'" link @click="view = 'approval'">
          This approval
        </el-button>
        <el-button :type="view === 'list' ? 'primary' : 'default'" link @click="view = 'list'">
          All requests
        </el-button>
        <el-button :type="view === 'keys' ? 'primary' : 'default'" link @click="view = 'keys'">
          Keys
        </el-button>
        <el-button :type="view === 'gateway' ? 'primary' : 'default'" link @click="view = 'gateway'">
          Gateway
        </el-button>
      </nav>
      <el-alert v-if="error" class="notice" type="error" :closable="false" :title="error" />
      <el-alert
        v-if="mode === 'live' && !clients.length"
        class="notice"
        type="warning"
        :closable="false"
        title="Live mode needs CLIENT_KEYS in your local .env and a running gateway."
      />
    </header>

    <div class="workbench" :class="{ 'with-inbox': view === 'approval' }">
      <aside v-if="view === 'approval'" class="inbox">
        <div class="inbox-head">
          <span>This client</span>
          <el-button link :disabled="busy" @click="refreshHistory">
            Refresh
          </el-button>
        </div>
        <el-button class="new-approval" @click="newApproval">
          New approval
        </el-button>
        <p v-if="!history.length" class="hint">
          Approvals for this client will show up here.
        </p>
        <div class="inbox-list">
          <el-button
            v-for="item in history"
            :key="item.id"
            :type="sidebarSelection === item.id ? 'primary' : 'default'"
            plain
            :aria-pressed="sidebarSelection === item.id"
            @click="selectFromInbox(item)"
          >
            <span class="inbox-title">{{ item.title }}</span>
            <span class="inbox-meta"><span class="dot" :class="statusClass(item.status)" /><span class="inbox-id">{{ item.id.slice(0, 8) }}</span><span class="status-word">{{ item.status }}</span></span>
          </el-button>
        </div>
      </aside>

      <main class="workspace">
        <p v-if="simulatedExample" class="intro">
          <strong>{{ simulatedExample.label }}</strong> asks JaGate before it can
          {{ simulatedExample.scenario }}. JaGate stores the request and the person’s decision. The
          application performs the action.
        </p>
        <p v-else-if="clientId" class="intro">
          This client calls <code>{{ bootstrap?.gatewayUrl }}</code>. A person decides in its Telegram chat, then the application claims the approval and
          reports what it did.
        </p>

        <template v-if="view === 'approval'">
          <section v-if="composing" class="card">
            <h1>Ask for approval</h1>
            <p class="lead">
              Describe the action the application wants a person to approve. The same text is what
              that person sees in Telegram.
            </p>
            <div class="fields">
              <label class="span-2">Title<el-input v-model="title" maxlength="100" /></label>
              <label class="span-2">Description
                <el-input v-model="description" type="textarea" :rows="3" maxlength="1000" />
              </label>
              <label>Action<el-input v-model="action" maxlength="64" spellcheck="false" /></label>
              <label>Open for (seconds)
                <el-input-number v-model="expiresInSeconds" :min="60" :max="86400" :step="1" />
              </label>
            </div>
            <div class="detail-block">
              <div class="section-row">
                <h2>Details the approver sees</h2>
                <el-button :disabled="detailRows.length >= 10" @click="addDetail">
                  Add detail
                </el-button>
              </div>
              <div v-for="(row, index) in detailRows" :key="index" class="detail-row">
                <label>Label<el-input v-model="row.label" maxlength="40" /></label>
                <label>Value<el-input v-model="row.value" maxlength="160" /></label>
                <el-button link type="danger" @click="removeDetail(index)">
                  Remove
                </el-button>
              </div>
            </div>
            <div class="key-line">
              <label for="idempotency-key">Idempotency key
                <el-input
                  id="idempotency-key"
                  v-model="idempotencyKey"
                  maxlength="128"
                  spellcheck="false"
                />
              </label>
              <el-button @click="idempotencyKey = `playground:${Date.now()}`">
                New key
              </el-button>
              <p class="hint">
                Ask again with the same key and the same text to get the original request. Change
                the text and that key is rejected.
              </p>
            </div>
            <details class="extra">
              <summary>Metadata, stored with the request and omitted from Telegram</summary>
              <label>Metadata JSON
                <el-input v-model="metadataText" type="textarea" :rows="3" spellcheck="false" />
              </label>
              <pre><code>{{ JSON.stringify(requestPreview, null, 2) }}</code></pre>
            </details>
            <div v-if="mode === 'simulated'" class="try-row">
              <el-button
                :type="failNextDelivery ? 'warning' : 'default'"
                :disabled="busy || failNextDelivery"
                @click="armDeliveryFailure"
              >
                {{ failNextDelivery ? 'Next message will fail' : 'Make the next message fail' }}
              </el-button>
              <p class="hint">
                The request is still saved. Telegram delivery is marked failed, so nobody can
                approve it until a message is delivered.
              </p>
            </div>
            <el-button
              type="primary"
              :aria-busy="busy"
              :loading="busy"
              :disabled="!clientId || (auth === 'scoped' && !scopedKey)"
              @click="ask"
            >
              Ask for approval
            </el-button>
          </section>

          <section v-else-if="!selected && (storyLoading || !unavailable)" class="card">
            <p class="hint">
              Loading this approval…
            </p>
          </section>

          <section v-else-if="unavailable || !selected" class="card">
            <h1>
              {{ blocked ? 'This call was rejected' : 'This client cannot see that request' }}
            </h1>
            <p v-if="blocked" class="lead">
              The credential in Calling as cannot read this approval. Health and readiness stay
              available under Gateway.
            </p>
            <p v-else class="lead">
              Each client only reads the approvals it created. Switch back to the owning client, or
              start another approval.
            </p>
            <el-button type="primary" @click="newApproval">
              New approval
            </el-button>
          </section>

          <template v-else>
            <section class="card story-head">
              <div class="story-title">
                <h1>{{ selected.title }}</h1>
                <code>{{ selected.id.slice(0, 8) }}</code>
              </div>
              <p v-if="createNotice" class="hint">
                {{ createNotice }}
              </p>
              <div class="facts">
                <span><small>Decision</small><el-tag effect="plain">{{ selected.status }}</el-tag></span>
                <span><small>Delivery</small><el-tag effect="plain">{{ selected.deliveryStatus }}</el-tag></span>
                <span><small>Application</small><el-tag effect="plain">{{ selected.executionStatus }}</el-tag></span>
              </div>
            </section>

            <div class="stages">
              <section class="stage done">
                <div class="stage-rail">
                  <span>1</span>
                </div>
                <div class="stage-body">
                  <h2>The application asked</h2>
                  <p>{{ selected.description }}</p>
                  <dl v-if="selected.details?.length" class="details">
                    <template v-for="detail in selected.details" :key="detail.label + detail.value">
                      <dt>{{ detail.label }}</dt>
                      <dd>{{ detail.value }}</dd>
                    </template>
                  </dl>
                  <p class="hint">
                    Action <code>{{ selected.action }}</code> · open until
                    {{ new Date(selected.expiresAt).toLocaleString() }}
                  </p>
                  <el-button
                    v-if="selected.status === 'pending'"
                    type="danger"
                    :disabled="busy"
                    @click="cancelRequest"
                  >
                    Cancel this request
                  </el-button>
                </div>
              </section>

              <section class="stage" :class="stageClass('decide')">
                <div class="stage-rail">
                  <span>2</span>
                </div>
                <div class="stage-body">
                  <h2>A person decides in Telegram</h2>
                  <div class="chat" aria-label="Simulated chat">
                    <div class="chat-head">
                      <strong>JaGate</strong><span>{{ clientId }}</span>
                    </div>
                    <div class="thread">
                      <p v-if="selected.deliveryStatus !== 'delivered'" class="chat-system">
                        {{ deliveryLine(selected) }}
                      </p>
                      <div
                        class="message"
                        :class="{ undelivered: selected.deliveryStatus !== 'delivered' }"
                      >
                        <span class="sender">JaGate</span>
                        <div class="bubble">
                          <strong>{{ selected.title }}</strong>
                          <p>{{ selected.description }}</p>
                          <p v-for="detail in selected.details" :key="detail.label + detail.value">
                            <b>{{ detail.label }}:</b> {{ detail.value }}
                          </p>
                          <p class="message-meta">
                            Client {{ selected.clientId }} · {{ selected.action }} ·
                            {{ selected.id.slice(0, 8) }}<br>Expires
                            {{ new Date(selected.expiresAt).toLocaleString()
                            }}<template v-if="selected.status !== 'pending'">
                              <br>Status {{ selected.status }}
                            </template>
                          </p>
                        </div>
                        <div
                          v-if="mode === 'simulated' && selected.deliveryStatus === 'delivered'"
                          class="keyboard"
                        >
                          <el-button
                            type="success"
                            :disabled="busy || !requestId"
                            @click="decide('approve')"
                          >
                            Approve
                          </el-button>
                          <el-button
                            type="danger"
                            :disabled="busy || !requestId"
                            @click="decide('reject')"
                          >
                            Reject
                          </el-button>
                        </div>
                      </div>
                      <div v-if="telegramReply" class="message">
                        <span class="sender">JaGate</span>
                        <p class="bubble reply" aria-live="polite">
                          {{ telegramReply }}
                        </p>
                      </div>
                    </div>
                    <div v-if="mode === 'simulated'" class="pressing">
                      <label>Pressing as
                        <el-select v-model="actor" aria-label="Who presses the button">
                          <el-option label="Allowlisted approver" value="allowed" />
                          <el-option label="Someone else" value="outsider" />
                        </el-select>
                      </label>
                    </div>
                    <div v-else class="pressing">
                      <p class="hint">
                        Approve or reject in this client’s Telegram chat, then refresh.
                      </p>
                      <el-button :disabled="busy" @click="openCurrent">
                        Refresh
                      </el-button>
                    </div>
                  </div>
                  <div v-if="mode === 'simulated'" class="clock">
                    <p class="hint">
                      Simulated time {{ simulatedNowLabel }}. A pending request expires when the
                      clock passes its deadline. An approval already recorded stays approved.
                    </p>
                    <div class="clock-row">
                      <label>Seconds
                        <el-input-number
                          v-model="advanceSeconds"
                          :min="1"
                          :max="86400"
                          :step="1"
                          aria-label="Seconds to move the clock"
                        />
                      </label>
                      <el-button :disabled="busy" @click="advanceTime">
                        Move the clock forward
                      </el-button>
                    </div>
                  </div>
                </div>
              </section>

              <section class="stage" :class="stageClass('act')">
                <div class="stage-rail">
                  <span>3</span>
                </div>
                <div class="stage-body">
                  <h2>The application continues</h2>
                  <template v-if="selected.status !== 'approved'">
                    <p>
                      The application waits. It claims an approval only after the decision is
                      approved.
                    </p>
                  </template>
                  <template v-else-if="selected.executionStatus === 'unclaimed'">
                    <p>
                      Claim this approval once. The application then performs the action itself and
                      reports what happened.
                    </p>
                    <el-button type="primary" :disabled="busy" @click="claimApproval">
                      Claim this approval
                    </el-button>
                  </template>
                  <template v-else>
                    <p v-if="selected.resultAt">
                      Reported {{ selected.executionStatus
                      }}<template v-if="selected.resultSummary">
                        : {{ selected.resultSummary }}
                      </template>.
                    </p>
                    <p v-else>
                      Claimed. The application performs the action, then reports succeeded or
                      failed.
                    </p>
                    <div class="inline-field">
                      <label for="claim-token">Claim token
                        <el-input
                          id="claim-token"
                          v-model="claimToken"
                          type="password"
                          show-password
                          autocomplete="off"
                          placeholder="Filled after a successful claim"
                        />
                      </label>
                    </div>
                    <label>Summary<el-input v-model="resultSummary" maxlength="300" /></label>
                    <div class="chat-actions">
                      <el-button
                        type="success"
                        :disabled="busy || !claimToken"
                        @click="report('succeeded')"
                      >
                        Report succeeded
                      </el-button>
                      <el-button
                        type="danger"
                        :disabled="busy || !claimToken"
                        @click="report('failed')"
                      >
                        Report failed
                      </el-button>
                      <el-button :disabled="busy" @click="claimApproval">
                        Claim again
                      </el-button>
                    </div>
                    <p class="hint">
                      The token is returned once. Change it to see a rejected report. Claiming again
                      conflicts, because the approval is already claimed.
                    </p>
                  </template>
                </div>
              </section>

              <section class="stage" :class="stageClass('record')">
                <div class="stage-rail">
                  <span>4</span>
                </div>
                <div class="stage-body">
                  <h2>Request history</h2>
                  <p v-if="!eventPage" class="hint">
                    Loading the timeline…
                  </p>
                  <p v-else-if="!eventPage.items.length" class="hint">
                    No events on this page.
                  </p>
                  <el-timeline v-else>
                    <el-timeline-item
                      v-for="event in eventPage.items"
                      :key="event.sequence"
                      :timestamp="new Date(event.occurredAt).toLocaleString()"
                    >
                      <strong>{{ eventLabel(event.type) }}</strong>
                      <div class="muted">
                        #{{ event.sequence }}
                        <template v-if="event.actorId">
                          · Approver {{ event.actorId }}
                        </template>
                        <template v-if="event.attempt">
                          · Attempt {{ event.attempt }}
                        </template>
                      </div>
                    </el-timeline-item>
                  </el-timeline>
                  <div class="pager">
                    <label>Events per page
                      <el-input-number
                        v-model="eventLimit"
                        :min="1"
                        :max="100"
                        :step="1"
                        @change="reloadEvents"
                      />
                    </label>
                    <span>Page {{ eventCursorStack.length + 1 }}</span>
                    <div class="chat-actions">
                      <el-button :disabled="busy || !eventCursorStack.length" @click="previousEventPage">
                        Previous
                      </el-button>
                      <el-button :disabled="busy || !eventPage?.nextCursor" @click="nextEventPage">
                        Next
                      </el-button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </template>
        </template>

        <section v-else-if="view === 'list'" class="card">
          <h1>All requests</h1>
          <p class="lead">
            Every row belongs to the selected client. Open one to continue its approval.
          </p>
          <div class="attention" role="group" aria-label="Requests needing attention">
            <el-button :disabled="busy" @click="applyAttention('delivery')">
              Failed delivery
            </el-button>
            <el-button :disabled="busy" @click="applyAttention('claimed')">
              Old claims
            </el-button>
            <el-button :disabled="busy" @click="applyAttention('expiry')">
              Expiring soon
            </el-button>
            <el-button :disabled="busy" @click="applyAttention('all')">
              Clear filters
            </el-button>
            <label>Window (minutes)
              <el-input-number
                v-model="attentionMinutes"
                :min="1"
                :max="1440"
                :step="1"
                aria-label="Attention window in minutes"
              />
            </label>
          </div>
          <p class="hint">
            Failed delivery lists pending requests whose Telegram message failed. Old claims are
            approvals still claimed, with no result, before the cutoff. Expiring soon lists pending
            requests that reach their deadline inside the window. The cutoff stays fixed while you
            page.
          </p>
          <div class="fields">
            <label>Decision
              <el-select v-model="listStatus" aria-label="Decision">
                <el-option label="Any" value="any" />
                <el-option label="Pending" value="pending" />
                <el-option label="Approved" value="approved" />
                <el-option label="Rejected" value="rejected" />
                <el-option label="Expired" value="expired" />
                <el-option label="Cancelled" value="cancelled" />
              </el-select>
            </label>
            <label>Delivery
              <el-select v-model="listDeliveryStatus" aria-label="Delivery">
                <el-option label="Any" value="any" />
                <el-option label="Pending" value="pending" />
                <el-option label="Retrying" value="retrying" />
                <el-option label="Delivered" value="delivered" />
                <el-option label="Failed" value="failed" />
              </el-select>
            </label>
            <label>Application
              <el-select v-model="listExecutionStatus" aria-label="Application">
                <el-option label="Any" value="any" />
                <el-option label="Unclaimed" value="unclaimed" />
                <el-option label="Claimed" value="claimed" />
                <el-option label="Succeeded" value="succeeded" />
                <el-option label="Failed" value="failed" />
              </el-select>
            </label>
            <label>Page size<el-input-number v-model="listLimit" :min="1" :max="100" :step="1" /></label>
            <label>Claimed before <span class="muted">UTC</span>
              <el-input v-model.trim="listClaimedBefore" placeholder="UTC timestamp" spellcheck="false" />
            </label>
            <label>Expires before <span class="muted">UTC</span>
              <el-input v-model.trim="listExpiresBefore" placeholder="UTC timestamp" spellcheck="false" />
            </label>
          </div>
          <el-button type="primary" :disabled="busy || !clientId" @click="showRequests">
            Show these requests
          </el-button>
          <div v-if="listPage" class="result-list">
            <p v-if="!listPage.items.length" class="hint">
              No requests match these filters.
            </p>
            <el-button
              v-for="item in listPage.items"
              :key="item.id"
              class="row-button"
              @click="openRequest(item)"
            >
              <span class="row-copy"><strong>{{ item.title }}</strong><small>{{ item.status }} · {{ item.deliveryStatus }} · {{ item.executionStatus }}</small><small>{{ new Date(item.createdAt).toLocaleString() }}</small></span>
            </el-button>
            <div class="pager">
              <span>Page {{ listCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <el-button :disabled="busy || !listCursorStack.length" @click="previousPage">
                  Previous
                </el-button>
                <el-button :disabled="busy || !listPage.nextCursor" @click="nextPage">
                  Next
                </el-button>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="view === 'keys'" class="card">
          <h1>Keys</h1>
          <p class="lead">
            The bootstrap key issues keys for this client. An issued key can call only the
            operations you allow, and it cannot issue keys or read the audit log.
          </p>
          <div class="fields">
            <label class="span-2">Name
              <el-input v-model="keyLabel" maxlength="80" placeholder="Name the app or worker" />
            </label>
            <label class="span-2">Expires at <span class="muted">optional UTC</span>
              <el-input
                v-model.trim="keyExpiresAt"
                placeholder="Leave empty for no expiry"
                spellcheck="false"
              />
            </label>
          </div>
          <div class="chat-actions">
            <el-button @click="setKeyExpiryOneHour">
              Expire in 1 hour
            </el-button>
            <el-button @click="keyExpiresAt = ''">
              No expiry
            </el-button>
          </div>
          <fieldset>
            <legend>This key may</legend>
            <el-checkbox-group v-model="keyScopes" class="scopes">
              <el-checkbox v-for="scope in availableKeyScopes" :key="scope" :value="scope">
                {{ scopeLabels[scope] }} <span class="muted">{{ scope }}</span>
              </el-checkbox>
            </el-checkbox-group>
          </fieldset>
          <el-button type="primary" :disabled="busy || !clientId || auth !== 'valid'" @click="issueKey">
            Issue key
          </el-button>
          <div v-if="scopedKey" class="callout">
            <p>
              A key is held for this browser session. It is shown once. Copy it, then call as that
              key.
            </p>
            <div class="inline-field">
              <label for="session-key">Issued key
                <el-input
                  id="session-key"
                  v-model="scopedKey"
                  type="password"
                  show-password
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
            </div>
            <el-button @click="useIssuedKey">
              Call as this key
            </el-button>
          </div>
          <div class="section-row">
            <h2>Issued keys</h2>
            <el-button :disabled="busy || !clientId" @click="showKeys">
              Show keys
            </el-button>
          </div>
          <p class="hint">
            Secret values are never listed. Revocation takes effect on the next call. The bootstrap
            key is rotated in .env.
          </p>
          <label>Page size
            <el-input-number
              v-model="keyLimit"
              :min="1"
              :max="100"
              :step="1"
              aria-label="Key page size"
            />
          </label>
          <div v-if="keyPage" class="result-list">
            <p v-if="!keyPage.items.length" class="hint">
              No issued keys on this page.
            </p>
            <div v-for="item in keyPage.items" :key="item.id" class="key-row">
              <span class="row-copy"><strong>{{ item.label }}</strong><small>{{ item.scopes.join(', ') }}</small><small>{{
                item.expiresAt
                  ? `Expires ${new Date(item.expiresAt).toLocaleString()}`
                  : 'No expiry'
              }}</small></span>
              <span class="muted">{{ keyState(item) }}</span>
              <el-button
                type="danger"
                link
                :disabled="busy || !!item.revokedAt"
                @click="revokeKey(item.id)"
              >
                Revoke
              </el-button>
            </div>
            <div class="pager">
              <span>Page {{ keyCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <el-button :disabled="busy || !keyCursorStack.length" @click="previousKeyPage">
                  Previous
                </el-button>
                <el-button :disabled="busy || !keyPage.nextCursor" @click="nextKeyPage">
                  Next
                </el-button>
              </div>
            </div>
          </div>
          <div class="section-row">
            <h2>Audit</h2>
            <el-button :disabled="busy || !clientId || auth !== 'valid'" @click="showAudit">
              Show audit
            </el-button>
          </div>
          <p class="hint">
            Newest first. Rows name key ids, never the secret or the claim token. An issued key
            cannot read this list.
          </p>
          <div class="fields">
            <label>Page size
              <el-input-number
                v-model="auditLimit"
                :min="1"
                :max="100"
                :step="1"
                aria-label="Audit page size"
              />
            </label>
            <label>Request id
              <el-input v-model.trim="auditRequestId" placeholder="Filter by request" spellcheck="false" />
            </label>
            <label class="span-2">Key id
              <el-input v-model.trim="auditKeyId" placeholder="Actor or affected key" spellcheck="false" />
            </label>
          </div>
          <div v-if="auditPage" class="result-list">
            <p v-if="!auditPage.items.length" class="hint">
              No audit events match these filters.
            </p>
            <div v-for="event in auditPage.items" :key="event.id" class="row-copy audit-row">
              <strong>{{ auditLabel(event.type) }}</strong>
              <small><time :datetime="event.occurredAt">{{
                new Date(event.occurredAt).toLocaleString()
              }}</time>
                ·
                {{
                  event.actor === 'bootstrap' ? 'Bootstrap key' : `Issued key ${event.actorKeyId}`
                }}</small>
              <small v-if="event.requestId">Request {{ event.requestId }}</small>
              <small v-if="event.subjectKeyId">Key {{ event.subjectKeyId }}</small>
            </div>
            <div class="pager">
              <span>Page {{ auditCursorStack.length + 1 }}</span>
              <div class="chat-actions">
                <el-button :disabled="busy || !auditCursorStack.length" @click="previousAuditPage">
                  Previous
                </el-button>
                <el-button :disabled="busy || !auditPage.nextCursor" @click="nextAuditPage">
                  Next
                </el-button>
              </div>
            </div>
          </div>
        </section>

        <section v-else class="card">
          <h1>Gateway</h1>
          <p class="lead">
            Health and readiness are public. They answer even when Calling as is missing or invalid.
          </p>
          <div class="gateway-actions">
            <el-button type="primary" :disabled="busy" @click="execute('health')">
              Check health
            </el-button>
            <el-button :disabled="busy" @click="execute('ready')">
              Check readiness
            </el-button>
          </div>
          <p class="hint">
            Readiness needs working storage and, on a real gateway, a live Telegram connection. The
            simulator reports ready without a bot.
          </p>
        </section>

        <details v-if="visibleEntry || entries.length" class="api-panel">
          <summary>
            <span class="summary-label">API response</span>
            <span class="summary-aside">
              <strong
                v-if="visibleEntry"
                :class="visibleEntry.status >= 400 ? 'status-bad' : 'status-ok'"
              >HTTP {{ visibleEntry.status }}</strong>
              <span class="disclosure"><span class="when-closed">Show</span><span class="when-open">Hide</span></span>
            </span>
          </summary>
          <div class="editor-bar">
            <el-radio-group v-model="responseTab" aria-label="Response view">
              <el-radio-button value="body">
                Body
              </el-radio-button>
              <el-radio-button value="history">
                History ({{ entries.length }})
              </el-radio-button>
            </el-radio-group>
            <el-button v-if="visibleEntry && responseTab === 'body'" @click="copyResponse">
              {{ copied ? 'Copied' : 'Copy JSON' }}
            </el-button>
          </div>
          <div v-if="responseTab === 'body'">
            <template v-if="visibleEntry">
              <p class="hint">
                {{ visibleEntry.label }} · {{ visibleEntry.time }}
              </p>
              <pre><code>{{ JSON.stringify(visibleEntry.body, null, 2) }}</code></pre>
            </template>
          </div>
          <div v-else class="result-list">
            <el-button
              v-for="(entry, index) in entries"
              :key="index"
              class="row-button"
              :type="activeEntry === index ? 'primary' : 'default'"
              plain
              :aria-pressed="activeEntry === index"
              @click="
                activeEntry = index;
                responseTab = 'body';
              "
            >
              <span class="meta" :class="entry.status >= 400 ? 'status-bad' : 'status-ok'">{{
                entry.status
              }}</span>
              <strong class="row-copy">{{ entry.label }}</strong>
              <time class="muted">{{ entry.time }}</time>
            </el-button>
          </div>
        </details>
      </main>
    </div>
  </div>
</template>
