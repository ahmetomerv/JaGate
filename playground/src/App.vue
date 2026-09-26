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

const clients = computed(() => mode.value === 'simulated' ? bootstrap.value?.simulatedClients ?? [] : bootstrap.value?.liveClients ?? []);
const selected = computed(() => history.value.find((item) => item.id === requestId.value));
const latest = computed(() => entries.value[0]);

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
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span>JaGate / Playground</span></div>
      <span class="local-tag">LOCAL DEVELOPMENT TOOL</span>
    </header>

    <main>
      <section class="intro">
        <p class="eyebrow">TEST THE APPROVAL LIFECYCLE</p>
        <h1>Every state, in one place.</h1>
        <p>Create a request, decide it, claim it, and inspect the exact response. Use simulated Telegram for fast edge cases or connect to your running gateway.</p>
      </section>

      <div v-if="error" class="notice" role="alert">{{ error }}</div>

      <div class="mode-row">
        <div class="segmented" aria-label="Playground mode">
          <button :class="{ active: mode === 'simulated' }" :aria-pressed="mode === 'simulated'" @click="changeMode('simulated')">Simulated Telegram</button>
          <button :class="{ active: mode === 'live' }" :aria-pressed="mode === 'live'" @click="changeMode('live')">Real gateway</button>
        </div>
        <p v-if="mode === 'simulated'">Separate SQLite file · no bot required</p>
        <p v-else>Calls {{ bootstrap?.gatewayUrl }} · approve in Telegram</p>
      </div>

      <div v-if="mode === 'live' && !clients.length" class="notice">Live mode needs valid <code>CLIENT_KEYS</code> in your local <code>.env</code>. Start the gateway separately.</div>

      <div class="workspace">
        <aside class="ledger panel">
          <div class="section-heading"><div><p class="eyebrow">01 / REQUESTS</p><h2>Recent requests</h2></div><button class="text-button" @click="refreshHistory">Refresh</button></div>
          <p class="hint">Select a request, then switch clients to check ownership.</p>
          <div v-if="!history.length" class="empty">No requests yet. Create one to begin.</div>
          <button v-for="item in history" :key="item.id" class="request-row" :class="{ selected: requestId === item.id }" :aria-pressed="requestId === item.id" @click="requestId = item.id">
            <span class="row-top"><strong>{{ item.title }}</strong><span class="status">{{ item.status }}</span></span>
            <span class="row-meta">{{ item.clientId }} · {{ item.id.slice(0, 8) }}</span>
          </button>
          <div class="ledger-foot">Simulated history lives in <code>data/playground.sqlite</code>. Live request IDs are saved in this browser.</div>
        </aside>

        <div class="main-column">
          <section class="panel settings-panel">
            <div class="section-heading"><div><p class="eyebrow">02 / CONTEXT</p><h2>Choose a client</h2></div></div>
            <div class="field-grid context-grid">
              <label>Client ID<select v-model="clientId" :disabled="!clients.length"><option v-for="id in clients" :key="id" :value="id">{{ id }}</option></select></label>
              <label>Authorization<select v-model="auth"><option value="valid">Valid key</option><option value="missing">Missing key</option><option value="invalid">Invalid key</option></select></label>
            </div>
            <div class="quick-actions"><button class="secondary" :disabled="busy || !clientId" @click="execute('health')">Check /health</button><button class="secondary" :disabled="busy || !clientId" @click="execute('ready')">Check /ready</button></div>
            <p class="hint">Health and readiness are public. The authorization choice applies to <code>/v1</code> actions below.</p>
          </section>

          <section class="panel">
            <div class="section-heading"><div><p class="eyebrow">03 / CREATE</p><h2>New approval</h2></div><span class="step-note">POST /v1/requests</span></div>
            <div class="field-grid">
              <label>Idempotency key<input v-model="key" maxlength="128" /></label>
              <label>Action<input v-model="action" maxlength="64" /></label>
              <label class="wide">Title<input v-model="title" maxlength="100" /></label>
              <label class="wide">Description<textarea v-model="description" rows="2" maxlength="1000" /></label>
              <label>Expires in seconds<input v-model.number="expiresInSeconds" type="number" min="60" max="86400" /></label>
              <span class="field-note">Repeat with the same key and identical content for HTTP 200. Change any field to see a 409 conflict.</span>
              <label class="wide">Details · JSON array<textarea v-model="detailsText" rows="2" spellcheck="false" class="code-input" /></label>
              <label class="wide">Metadata · JSON object<textarea v-model="metadataText" rows="2" spellcheck="false" class="code-input" /></label>
            </div>
            <div class="action-row"><button class="primary" :disabled="busy || !clientId" @click="execute('create')">Create / repeat request <span>↗</span></button><button class="text-button" @click="key = `playground:${Date.now()}`">New key</button></div>
          </section>

          <section class="panel">
            <div class="section-heading"><div><p class="eyebrow">04 / LIFECYCLE</p><h2>Inspect and decide</h2></div><span v-if="selected" class="status">{{ selected.status }}</span></div>
            <label>Request ID<input v-model="requestId" placeholder="Select a request or paste its UUID" /></label>
            <div v-if="selected" class="facts">
              <div><span>Decision</span><strong>{{ selected.status }}</strong></div><div><span>Delivery</span><strong>{{ selected.deliveryStatus }}</strong></div>
              <div><span>Execution</span><strong>{{ selected.executionStatus }}</strong></div><div><span>Expires</span><strong>{{ new Date(selected.expiresAt).toLocaleString() }}</strong></div>
            </div>
            <div class="quick-actions"><button class="secondary" :disabled="busy || !requestId" @click="execute('get')">Get request</button><button class="secondary" :disabled="busy || !requestId" @click="execute('cancel')">Cancel pending</button></div>
            <div v-if="mode === 'simulated'" class="simulation-tools">
              <p class="tool-label">SIMULATED TELEGRAM</p>
              <div class="tool-row"><select v-model="actor" aria-label="Decision actor"><option value="allowed">Allowlisted approver</option><option value="outsider">Outsider</option></select><button class="secondary" :disabled="busy || !requestId" @click="decide('approve')">Approve</button><button class="secondary" :disabled="busy || !requestId" @click="decide('reject')">Reject</button></div>
              <p class="tool-label">TEST EXPIRY</p>
              <div class="tool-row"><input v-model.number="advanceSeconds" type="number" min="1" max="86400" aria-label="Seconds to advance" /><span>seconds</span><button class="secondary" :disabled="busy" @click="advanceTime">Advance clock</button></div>
            </div>
            <p v-else class="hint live-hint">Use the buttons in your configured Telegram chat to approve or reject. Then choose “Get request” to refresh its state.</p>
          </section>

          <section class="panel">
            <div class="section-heading"><div><p class="eyebrow">05 / EXECUTION</p><h2>Claim and report</h2></div></div>
            <div class="quick-actions"><button class="secondary" :disabled="busy || !requestId" @click="execute('claim')">Claim approval</button><span class="hint">Claim only once after approval.</span></div>
            <div class="field-grid result-grid">
              <label class="wide">Claim token<div class="token-input"><input v-model="claimToken" :type="showClaimToken ? 'text' : 'password'" autocomplete="off" placeholder="Filled after a successful claim" /><button class="text-button" @click="showClaimToken = !showClaimToken">{{ showClaimToken ? 'Hide' : 'Show' }}</button></div></label>
              <label>Result<select v-model="resultStatus"><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
              <label>Summary<input v-model="resultSummary" maxlength="300" /></label>
            </div>
            <div class="action-row"><button class="primary" :disabled="busy || !requestId || !claimToken" @click="execute('result')">Report result <span>↗</span></button></div>
            <p class="hint">The playground records a result; it does not execute the action described in the approval.</p>
          </section>
        </div>

        <aside class="response-panel panel">
          <div class="section-heading"><div><p class="eyebrow">06 / OUTPUT</p><h2>HTTP responses</h2></div></div>
          <p class="hint">Status and body from the latest operation.</p>
          <div v-if="latest" class="response-current"><div class="response-meta"><strong>{{ latest.label }}</strong><span :class="latest.status >= 400 ? 'bad' : 'good'">HTTP {{ latest.status }}</span></div><time>{{ latest.time }}</time><pre>{{ JSON.stringify(latest.body, null, 2) }}</pre></div>
          <div v-else class="empty">Responses will appear here.</div>
          <details v-if="entries.length > 1" class="older"><summary>Earlier responses ({{ entries.length - 1 }})</summary><div v-for="entry in entries.slice(1)" :key="`${entry.time}-${entry.label}`" class="older-entry"><strong>{{ entry.label }} · HTTP {{ entry.status }}</strong><pre>{{ JSON.stringify(entry.body, null, 2) }}</pre></div></details>
        </aside>
      </div>
      <footer>JaGate playground · Development only · Usage guide: <code>docs/guide/playground.md</code></footer>
    </main>
  </div>
</template>
