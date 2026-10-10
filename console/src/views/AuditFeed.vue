<script setup lang="ts">
import type { AuditEvent } from '../../../src/client.js';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useConsole, useRequestScope } from '../context.js';
import { visibleError } from '../errors.js';

const router = useRouter();
const { api } = useConsole();
const signal = useRequestScope();
const events = ref<AuditEvent[]>([]);
const cursor = ref<string | null>(null);
const requestId = ref('');
const keyId = ref('');
const error = ref('');
const loading = ref(false);

async function load(append: boolean): Promise<void> {
  if (signal.aborted)
    return;
  loading.value = true;
  try {
    const page = await api.listAuditEvents({
      limit: 20,
      ...(append && cursor.value ? { cursor: cursor.value } : {}),
      ...(requestId.value.trim() ? { requestId: requestId.value.trim() } : {}),
      ...(keyId.value.trim() ? { keyId: keyId.value.trim() } : {}),
    }, signal);
    events.value = append ? [...events.value, ...page.items] : page.items;
    cursor.value = page.nextCursor;
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

function openRequest(id: string | null): void {
  if (id)
    void router.push(`/requests/${id}`);
}

onMounted(() => {
  void load(false);
});
</script>

<template>
  <div class="console-stack">
    <div>
      <h1>Audit</h1>
      <p class="console-muted">
        These rows record ids and times for creates, claims, reported results, and key changes.
        They do not include request text, keys, or claim tokens.
      </p>
    </div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" />
    <el-form class="console-row" @submit.prevent="load(false)">
      <el-form-item label="Request id">
        <el-input v-model="requestId" />
      </el-form-item>
      <el-form-item label="Key id">
        <el-input v-model="keyId" />
      </el-form-item>
      <el-button native-type="submit" type="primary">
        Apply
      </el-button>
    </el-form>
    <el-table v-loading="loading" class="console-table" :data="events" :fit="false" empty-text="No audit events.">
      <el-table-column prop="occurredAt" label="When" width="220" />
      <el-table-column prop="type" label="Type" width="180" />
      <el-table-column prop="actor" label="Actor" width="120" />
      <el-table-column prop="actorKeyId" label="Actor key" width="180" />
      <el-table-column label="Request" width="280">
        <template #default="{ row }">
          <el-button v-if="row.requestId" link type="primary" @click="openRequest(row.requestId)">
            {{ row.requestId }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column prop="subjectKeyId" label="Subject key" width="280" />
    </el-table>
    <el-button v-if="cursor" @click="load(true)">
      Load more
    </el-button>
  </div>
</template>
