<script setup lang="ts">
import type { RequestEvent, RequestView } from '../../../src/client.js';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError } from '../../../src/client.js';
import { useConsole, useRequestScope } from '../context.js';
import { decisionTone, executionLabel } from '../display.js';
import { visibleError } from '../errors.js';
import { isUnknownOutcome, shouldOfferCancel } from '../policy.js';

const route = useRoute();
const { api, session } = useConsole();
const signal = useRequestScope();
const request = ref<RequestView | null>(null);
const events = ref<RequestEvent[]>([]);
const eventCursor = ref<string | null>(null);
const error = ref('');
const loading = ref(true);
const cancelling = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const requestId = computed(() => {
  const id = route.params.id;
  return typeof id === 'string' ? id : '';
});
const metadataText = computed(() => JSON.stringify(request.value?.metadata ?? {}, null, 2));
const canCancel = computed(() =>
  request.value ? shouldOfferCancel(request.value.status, session.state.cancelDenied) : false,
);

async function load(): Promise<void> {
  if (signal.aborted || !session.state.key || !requestId.value)
    return;
  try {
    const [nextRequest, nextEvents] = await Promise.all([
      api.getRequest(requestId.value, signal),
      api.getRequestEvents(requestId.value, { limit: 50 }, signal),
    ]);
    request.value = nextRequest;
    events.value = nextEvents.items;
    eventCursor.value = nextEvents.nextCursor;
    session.noteClient(nextRequest.clientId);
    error.value = '';
  }
  catch (caught) {
    const message = visibleError(caught);
    if (message)
      error.value = message;
  }
  finally {
    loading.value = false;
  }
}

async function moreEvents(): Promise<void> {
  if (!eventCursor.value || !session.state.key)
    return;
  const page = await api.getRequestEvents(requestId.value, {
    limit: 50,
    cursor: eventCursor.value,
  }, signal);
  events.value = [...events.value, ...page.items];
  eventCursor.value = page.nextCursor;
}

async function cancel(): Promise<void> {
  if (!request.value || cancelling.value)
    return;
  cancelling.value = true;
  try {
    request.value = await api.cancel(request.value.id, signal);
    await load();
  }
  catch (caught) {
    if (caught instanceof ApiError && caught.status === 403)
      session.denyCancel();
    const message = visibleError(caught);
    if (message)
      error.value = message;
  }
  finally {
    cancelling.value = false;
  }
}

function schedule(): void {
  if (timer)
    clearTimeout(timer);
  if (signal.aborted)
    return;
  timer = setTimeout(() => {
    void load().finally(schedule);
  }, 5000);
}

onMounted(() => {
  void load().finally(schedule);
});

onUnmounted(() => {
  if (timer)
    clearTimeout(timer);
});
</script>

<template>
  <div v-loading="loading" class="console-stack">
    <div>
      <h1>Request</h1>
      <p class="console-muted">
        The proposal below is what was stored. A decision still happens in Telegram.
      </p>
    </div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" />
    <template v-if="request">
      <el-alert
        v-if="isUnknownOutcome(request)"
        type="warning"
        :closable="false"
        show-icon
        title="This approval was claimed and no result was reported. The caller may already have performed the action. Reconcile the target system before starting another request. This console cannot retry it."
      />
      <el-alert
        v-if="request.deliveryStatus === 'failed' && request.deliveryError"
        type="error"
        :closable="false"
        :title="request.deliveryError"
      />
      <el-descriptions :column="1" border>
        <el-descriptions-item label="Title">
          {{ request.title }}
        </el-descriptions-item>
        <el-descriptions-item label="Action">
          {{ request.action }}
        </el-descriptions-item>
        <el-descriptions-item label="Description">
          {{ request.description }}
        </el-descriptions-item>
        <el-descriptions-item label="Client">
          {{ request.clientId }}
        </el-descriptions-item>
        <el-descriptions-item label="Decision">
          <el-tag :type="decisionTone(request.status)" effect="plain">
            {{ request.status }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="Decided by">
          {{ request.decidedBy ?? '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="Decided at">
          {{ request.decidedAt ?? '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="Delivery">
          {{ request.deliveryStatus }}
          <span v-if="request.deliveryAttempts"> ({{ request.deliveryAttempts }} attempts)</span>
        </el-descriptions-item>
        <el-descriptions-item label="Execution">
          {{ executionLabel(request) }}
        </el-descriptions-item>
        <el-descriptions-item label="Reported result">
          {{ request.resultSummary ?? '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="Created">
          {{ request.createdAt }}
        </el-descriptions-item>
        <el-descriptions-item label="Expires">
          {{ request.expiresAt }}
        </el-descriptions-item>
        <el-descriptions-item v-for="(detail, index) in request.details" :key="`${detail.label}-${index}`" :label="detail.label">
          {{ detail.value }}
        </el-descriptions-item>
      </el-descriptions>
      <el-card>
        <template #header>
          Metadata
        </template>
        <p class="console-muted">
          Metadata is stored for this client and was not shown in Telegram. It can contain secrets.
        </p>
        <pre class="console-pre">{{ metadataText }}</pre>
      </el-card>
      <el-popconfirm
        v-if="canCancel"
        title="Cancel this pending request? The action will not run."
        confirm-button-text="Cancel request"
        cancel-button-text="Keep it"
        @confirm="cancel"
      >
        <template #reference>
          <el-button type="danger" :loading="cancelling">
            Cancel request
          </el-button>
        </template>
      </el-popconfirm>
      <p v-else-if="request.status === 'pending' && session.state.cancelDenied" class="console-muted">
        This key cannot cancel requests.
      </p>
      <el-card>
        <template #header>
          Timeline
        </template>
        <el-timeline>
          <el-timeline-item v-for="event in events" :key="event.sequence" :timestamp="event.occurredAt">
            {{ event.type }}
            <span v-if="event.actorId"> · {{ event.actorId }}</span>
            <span v-if="event.attempt != null"> · attempt {{ event.attempt }}</span>
          </el-timeline-item>
        </el-timeline>
        <el-button v-if="eventCursor" @click="moreEvents">
          Load more
        </el-button>
      </el-card>
    </template>
  </div>
</template>
