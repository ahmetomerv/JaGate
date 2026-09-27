<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

type Mode = 'simulated' | 'live';
type Operation = 'create' | 'get' | 'cancel' | 'claim' | 'result' | 'health' | 'ready';
type RequestView = {
  id: string; clientId: string; title: string; action: string; status: string; executionStatus: string;
  deliveryStatus: string; deliveryAttempts: number; expiresAt: string; resultSummary: string | null;
};
type Entry = { time: string; label: string; status: number; body: unknown };
type Bootstrap = { token: string; simulatedClients: string[]; liveClients: string[]; gatewayUrl: string };

const bootstrap = ref<Bootstrap | null>(null);
const mode = ref<Mode>('simulated');
const clientId = ref('website');
const auth = ref<'valid' | 'missing' | 'invalid'>('valid');
const requestId = ref('');
const history = ref<RequestView[]>([]);
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
const activeEntry = ref(0);
const copied = ref(false);

const endpoints: Array<{ operation: Operation; method: 'GET' | 'POST'; label: string; path: string }> = [
  { operation: 'create', method: 'POST', label: 'Create request', path: '/v1/requests' },
  { operation: 'get', method: 'GET', label: 'Get request', path: '/v1/requests/:id' },
  { operation: 'cancel', method: 'POST', label: 'Cancel request', path: '/v1/requests/:id/cancel' },
  { operation: 'claim', method: 'POST', label: 'Claim approval', path: '/v1/requests/:id/claim' },
  { operation: 'result', method: 'POST', label: 'Report result', path: '/v1/requests/:id/result' },
  { operation: 'health', method: 'GET', label: 'Health', path: '/health' },
  { operation: 'ready', method: 'GET', label: 'Readiness', path: '/ready' },
];

const clients = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedClients ?? [] : bootstrap.value?.liveClients ?? []);
const selected = computed(() => history.value.find((item) => item.id === requestId.value));
const latest = computed(() => entries.value[0]);
const visibleEntry = computed(() => entries.value[activeEntry.value] ?? latest.value);
const endpoint = computed(() => endpoints.find((item) => item.operation === operation.value)!);
const requestPath = computed(() => endpoint.value.path.replace(':id', requestId.value || ':id'));
const needsRequestId = computed(() => !['create', 'health', 'ready'].includes(operation.value));
const previewBody = computed(() => operation.value === 'create' ? {
  idempotencyKey: key.value, action: action.value, title: title.value, description: description.value,
  details: parsePreview(detailsText.value), metadata: parsePreview(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
} : operation.value === 'result' ? {
  claimToken: claimToken.value, status: resultStatus.value, summary: resultSummary.value,
} : {});

function parsePreview(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function selectRequest(item: RequestView) {
  if (requestId.value !== item.id) claimToken.value = '';
  requestId.value = item.id;
  operation.value = 'get';
  requestTab.value = 'body';
}

function remember(item: RequestView) {
  history.value = [item, ...history.value.filter((existing) => existing.id !== item.id)].slice(0, 100);
  if (mode.value === 'live') {
    localStorage.setItem('jagate-playground-live-history', JSON.stringify(history.value));
  }
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

function record(label: string, status: number, body: unknown) {
  entries.value = [{ time: new Date().toLocaleTimeString(), label, status, body }, ...entries.value].slice(0, 20);
  activeEntry.value = 0;
  responseTab.value = 'body';
}

async function copyResponse() {
  if (!visibleEntry.value) return;
  await navigator.clipboard.writeText(JSON.stringify(visibleEntry.value.body, null, 2));
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1800);
}

async function refreshHistory() {
  if (!bootstrap.value) return;
  if (mode.value === 'simulated') history.value = await api('/api/history') as RequestView[];
  else {
    try { history.value = JSON.parse(localStorage.getItem('jagate-playground-live-history') ?? '[]') as RequestView[]; }
    catch { history.value = []; }
  }
}

function changeMode(next: Mode) {
  mode.value = next;
  clientId.value = clients.value[0] ?? '';
  requestId.value = '';
  claimToken.value = '';
  error.value = '';
  void refreshHistory();
}

async function execute(operation: Operation) {
  if (!bootstrap.value || busy.value) return;
  error.value = '';
  let payload: unknown;
  try {
    if (operation === 'create') payload = {
      idempotencyKey: key.value, action: action.value, title: title.value, description: description.value,
      details: JSON.parse(detailsText.value), metadata: JSON.parse(metadataText.value), expiresInSeconds: Number(expiresInSeconds.value),
    };
    if (operation === 'result') payload = { claimToken: claimToken.value, status: resultStatus.value, summary: resultSummary.value };
    busy.value = true;
    const response = await api('/api/execute', {
      mode: mode.value, clientId: clientId.value, operation, auth: auth.value, requestId: requestId.value, payload,
    }) as { status: number; body: Record<string, unknown> };
    record(`${operation.toUpperCase()} · ${clientId.value}`, response.status, response.body);
    const view = operation === 'claim' ? response.body.request : response.body;
    if (view && typeof view === 'object' && 'id' in view) {
      const item = view as RequestView;
      if (requestId.value !== item.id && operation !== 'claim') claimToken.value = '';
      remember(item);
      requestId.value = item.id;
    }
    if (operation === 'claim' && typeof response.body.claimToken === 'string') claimToken.value = response.body.claimToken;
    if (mode.value === 'simulated') await refreshHistory();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Request failed'; }
  finally { busy.value = false; }
}

async function decide(decision: 'approve' | 'reject') {
  if (busy.value || !requestId.value) return;
  error.value = '';
  try {
    busy.value = true;
    const response = await api('/api/decide', { requestId: requestId.value, clientId: clientId.value, decision, actor: actor.value }) as { message: string; request: RequestView };
    record(`${decision.toUpperCase()} · ${actor.value}`, 200, response);
    remember(response.request);
    await refreshHistory();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Decision failed'; }
  finally { busy.value = false; }
}

async function advanceTime() {
  if (busy.value) return;
  error.value = '';
  try {
    busy.value = true;
    const response = await api('/api/advance-time', { seconds: Number(advanceSeconds.value) });
    record('ADVANCE CLOCK', 200, response);
    await refreshHistory();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Clock change failed'; }
  finally { busy.value = false; }
}

onMounted(async () => {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error('Could not start the playground');
    bootstrap.value = await response.json() as Bootstrap;
    clientId.value = bootstrap.value.simulatedClients[0] ?? '';
    await refreshHistory();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start the playground'; }
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand"><span class="brand-mark">J</span><span>JaGate <span class="brand-divider">/</span> Playground</span><span class="dev-badge">LOCAL</span></div>
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
        <label class="inline-field">Auth <select v-model="auth"><option value="valid">Valid key</option><option value="missing">Missing key</option><option value="invalid">Invalid key</option></select></label>
      </div>
    </div>

    <div v-if="error" class="global-notice" role="alert">{{ error }}</div>
    <div v-if="mode === 'live' && !clients.length" class="global-notice">Live mode needs CLIENT_KEYS in your local .env and a running gateway.</div>

    <main class="workspace">
      <aside class="sidebar">
        <div class="sidebar-section">
          <div class="sidebar-heading"><span>REQUESTS</span><span class="count">{{ endpoints.length }}</span></div>
          <button v-for="item in endpoints" :key="item.operation" class="endpoint-item" :class="{ active: operation === item.operation }" @click="operation = item.operation; requestTab = 'body'">
            <span class="method" :class="item.method.toLowerCase()">{{ item.method }}</span><span class="endpoint-label">{{ item.label }}</span>
          </button>
        </div>
        <div class="sidebar-section recent-section">
          <div class="sidebar-heading"><span>RECENT REQUESTS</span><button class="icon-button" title="Refresh recent requests" aria-label="Refresh recent requests" @click="refreshHistory">↻</button></div>
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
            <button class="send-button" :disabled="busy || !clientId || (needsRequestId && !requestId)" @click="execute(operation)">{{ busy ? 'Sending…' : 'Send' }} <span>➜</span></button>
          </div>
          <div class="request-tabs" role="tablist" aria-label="Request editor">
            <button role="tab" :aria-selected="requestTab === 'body'" :class="{ active: requestTab === 'body' }" @click="requestTab = 'body'">{{ needsRequestId ? 'Params & body' : operation === 'create' ? 'Body' : 'Overview' }}</button>
            <button role="tab" :aria-selected="requestTab === 'preview'" :class="{ active: requestTab === 'preview' }" @click="requestTab = 'preview'">JSON preview</button>
            <span class="tabs-spacer"></span><span class="auth-summary">Authorization <strong>{{ auth === 'valid' ? 'Bearer key' : auth === 'missing' ? 'None' : 'Invalid key' }}</strong></span>
          </div>

          <div v-if="requestTab === 'preview'" class="editor-body preview-body">
            <div class="editor-caption"><span>REQUEST BODY</span><span>Read only preview</span></div>
            <pre>{{ JSON.stringify(previewBody, null, 2) }}</pre>
            <p v-if="operation === 'create' || operation === 'result'" class="help-text">Edit values in the {{ needsRequestId ? 'Params & body' : 'Body' }} tab.</p>
            <p v-else class="help-text">This endpoint does not require a request body.</p>
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
            <template v-else-if="needsRequestId">
              <div class="editor-caption"><span>PATH PARAMETERS</span><span>Required</span></div>
              <div class="form-grid"><label class="span-2">Request ID<input v-model="requestId" placeholder="Select a recent request or paste its UUID" spellcheck="false" /></label></div>
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

        <section v-if="mode === 'simulated'" class="simulation-strip">
          <div class="simulation-intro"><span class="simulation-icon">◎</span><div><strong>Simulation controls</strong><span>Drive the Telegram decision and time locally.</span></div></div>
          <div class="simulation-controls"><select v-model="actor" aria-label="Decision actor"><option value="allowed">Allowlisted approver</option><option value="outsider">Outsider</option></select><button class="utility-button" :disabled="busy || !requestId" @click="decide('approve')">Approve</button><button class="utility-button" :disabled="busy || !requestId" @click="decide('reject')">Reject</button><div class="control-divider"></div><input v-model.number="advanceSeconds" type="number" min="1" max="86400" aria-label="Seconds to advance" /><span class="seconds-label">sec</span><button class="utility-button" :disabled="busy" @click="advanceTime">Advance clock</button></div>
        </section>
        <section v-else class="simulation-strip live-strip"><span class="simulation-icon">↗</span><span>Approve or reject in your configured Telegram chat, then send <strong>Get request</strong> to refresh its state.</span></section>

        <section class="response-section">
          <div class="response-heading"><div><p class="kicker">RESPONSE</p><h2>Output</h2></div><div v-if="visibleEntry" class="response-summary"><span class="http-status" :class="visibleEntry.status >= 400 ? 'error' : 'success'">HTTP {{ visibleEntry.status }}</span><span>{{ visibleEntry.time }}</span></div></div>
          <div class="response-tabs" role="tablist" aria-label="Response view"><button role="tab" :aria-selected="responseTab === 'body'" :class="{ active: responseTab === 'body' }" @click="responseTab = 'body'">Body</button><button role="tab" :aria-selected="responseTab === 'history'" :class="{ active: responseTab === 'history' }" @click="responseTab = 'history'">History <span class="history-count">{{ entries.length }}</span></button><span class="tabs-spacer"></span><button v-if="visibleEntry && responseTab === 'body'" class="copy-button" @click="copyResponse">{{ copied ? 'Copied' : 'Copy JSON' }}</button></div>
          <div v-if="responseTab === 'body'" class="response-body"><div v-if="visibleEntry" class="response-code"><div class="response-code-header"><span>{{ visibleEntry.label }}</span><span>JSON</span></div><pre>{{ JSON.stringify(visibleEntry.body, null, 2) }}</pre></div><div v-else class="response-empty"><span>↳</span><strong>Waiting for a request</strong><p>Choose an endpoint, fill in its values, and click Send. The response will appear here.</p></div></div>
          <div v-else class="history-body"><div v-if="!entries.length" class="response-empty">No responses in this session yet.</div><button v-for="(entry, index) in entries" :key="index" class="history-item" :class="{ active: activeEntry === index }" @click="activeEntry = index; responseTab = 'body'"><span class="history-status" :class="entry.status >= 400 ? 'error' : 'success'">{{ entry.status }}</span><strong>{{ entry.label }}</strong><time>{{ entry.time }}</time><span>→</span></button></div>
        </section>
      </div>
    </main>
  </div>
</template>
