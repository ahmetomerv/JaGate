<script setup lang="ts">
import type { ListRequestsQuery, RequestView } from '../../../src/client.js';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import RequestTable from '../components/RequestTable.vue';
import { useConsole, useRequestScope } from '../context.js';
import { visibleError } from '../errors.js';
import { cutoffIso } from '../policy.js';

interface Bucket {
  items: RequestView[];
  cursor: string | null;
  loading: boolean;
}

const { api, session } = useConsole();
const signal = useRequestScope();
const windowMinutes = ref(15);
const status = ref('');
const deliveryStatus = ref('');
const executionStatus = ref('');
const error = ref('');
const failed = ref<Bucket>({ items: [], cursor: null, loading: false });
const claimed = ref<Bucket>({ items: [], cursor: null, loading: false });
const expiring = ref<Bucket>({ items: [], cursor: null, loading: false });
const all = ref<Bucket>({ items: [], cursor: null, loading: false });
const statuses = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];
const deliveries = ['pending', 'retrying', 'delivered', 'failed'];
const executions = ['unclaimed', 'claimed', 'succeeded', 'failed'];
let timer: ReturnType<typeof setTimeout> | undefined;

function windowMs(): number {
  return windowMinutes.value * 60 * 1000;
}

function note(items: RequestView[]): void {
  const clientId = items[0]?.clientId;
  if (clientId)
    session.noteClient(clientId);
}

async function load(
  bucket: Bucket,
  query: ListRequestsQuery,
  append: boolean,
): Promise<void> {
  if (signal.aborted || !session.state.key)
    return;
  if (bucket.items.length === 0)
    bucket.loading = true;
  try {
    const page = await api.listRequests(query, signal);
    bucket.items = append ? [...bucket.items, ...page.items] : page.items;
    bucket.cursor = page.nextCursor;
    note(page.items);
    error.value = '';
  }
  catch (caught) {
    const message = visibleError(caught);
    if (message)
      error.value = message;
  }
  finally {
    bucket.loading = false;
  }
}

function attentionQuery(kind: 'failed' | 'claimed' | 'expiring', cursor?: string | null): ListRequestsQuery {
  const now = new Date();
  const query: ListRequestsQuery = { limit: 20 };
  if (kind === 'failed') {
    query.status = 'pending';
    query.deliveryStatus = 'failed';
  }
  else if (kind === 'claimed') {
    query.status = 'approved';
    query.executionStatus = 'claimed';
    query.claimedBefore = cutoffIso(now, windowMs(), 'past');
  }
  else {
    query.status = 'pending';
    query.expiresBefore = cutoffIso(now, windowMs(), 'future');
  }
  if (cursor)
    query.cursor = cursor;
  return query;
}

function allQuery(cursor?: string | null): ListRequestsQuery {
  const query: ListRequestsQuery = { limit: 20 };
  if (status.value === 'pending' || status.value === 'approved' || status.value === 'rejected' || status.value === 'expired' || status.value === 'cancelled')
    query.status = status.value;
  if (deliveryStatus.value === 'pending' || deliveryStatus.value === 'retrying' || deliveryStatus.value === 'delivered' || deliveryStatus.value === 'failed')
    query.deliveryStatus = deliveryStatus.value;
  if (executionStatus.value === 'unclaimed' || executionStatus.value === 'claimed' || executionStatus.value === 'succeeded' || executionStatus.value === 'failed')
    query.executionStatus = executionStatus.value;
  if (cursor)
    query.cursor = cursor;
  return query;
}

async function refresh(): Promise<void> {
  await Promise.all([
    load(failed.value, attentionQuery('failed'), false),
    load(claimed.value, attentionQuery('claimed'), false),
    load(expiring.value, attentionQuery('expiring'), false),
    load(all.value, allQuery(), false),
  ]);
}

function schedule(): void {
  if (timer)
    clearTimeout(timer);
  if (signal.aborted)
    return;
  timer = setTimeout(() => {
    void refresh().finally(schedule);
  }, 5000);
}

onMounted(() => {
  void refresh().finally(schedule);
});

onUnmounted(() => {
  if (timer)
    clearTimeout(timer);
});

watch(windowMinutes, () => {
  void Promise.all([
    load(claimed.value, attentionQuery('claimed'), false),
    load(expiring.value, attentionQuery('expiring'), false),
  ]);
});

async function applyFilters(): Promise<void> {
  await load(all.value, allQuery(), false);
}
</script>

<template>
  <div class="console-stack">
    <div>
      <h1>Inbox</h1>
      <p class="console-muted">
        Approve and reject happen in Telegram. This console cannot claim an approval or report an outcome.
      </p>
    </div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" />
    <el-form class="console-row" @submit.prevent>
      <el-form-item label="Attention window">
        <el-select v-model="windowMinutes" style="width: 180px">
          <el-option :value="15" label="15 minutes" />
          <el-option :value="60" label="1 hour" />
          <el-option :value="1440" label="24 hours" />
        </el-select>
      </el-form-item>
    </el-form>
    <el-card>
      <template #header>
        Telegram delivery failed
      </template>
      <RequestTable :items="failed.items" :loading="failed.loading" />
      <el-button v-if="failed.cursor" @click="load(failed, attentionQuery('failed', failed.cursor), true)">
        Load more
      </el-button>
    </el-card>
    <el-card>
      <template #header>
        Claimed without a reported result
      </template>
      <p class="console-muted">
        A claimed request may already have changed the outside system. Reconcile that system before starting another request.
      </p>
      <RequestTable :items="claimed.items" :loading="claimed.loading" />
      <el-button v-if="claimed.cursor" @click="load(claimed, attentionQuery('claimed', claimed.cursor), true)">
        Load more
      </el-button>
    </el-card>
    <el-card>
      <template #header>
        Pending requests nearing expiry
      </template>
      <RequestTable :items="expiring.items" :loading="expiring.loading" />
      <el-button v-if="expiring.cursor" @click="load(expiring, attentionQuery('expiring', expiring.cursor), true)">
        Load more
      </el-button>
    </el-card>
    <el-card>
      <template #header>
        All requests
      </template>
      <el-form class="console-row" @submit.prevent="applyFilters">
        <el-form-item label="Decision">
          <el-select v-model="status" clearable placeholder="Any" style="width: 160px">
            <el-option v-for="item in statuses" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="Delivery">
          <el-select v-model="deliveryStatus" clearable placeholder="Any" style="width: 160px">
            <el-option v-for="item in deliveries" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="Execution">
          <el-select v-model="executionStatus" clearable placeholder="Any" style="width: 160px">
            <el-option v-for="item in executions" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-button native-type="submit" type="primary">
          Apply
        </el-button>
      </el-form>
      <RequestTable :items="all.items" :loading="all.loading" />
      <el-button v-if="all.cursor" @click="load(all, allQuery(all.cursor), true)">
        Load more
      </el-button>
    </el-card>
  </div>
</template>
