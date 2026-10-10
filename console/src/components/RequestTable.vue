<script setup lang="ts">
import type { RequestView } from '../../../src/client.js';
import { useRouter } from 'vue-router';
import { decisionTone, executionLabel } from '../display.js';

defineProps<{
  items: RequestView[];
  loading: boolean;
}>();

const router = useRouter();

function open(row: RequestView): void {
  void router.push(`/requests/${row.id}`);
}
</script>

<template>
  <el-table
    v-loading="loading"
    class="console-table console-request-table"
    :data="items"
    :fit="false"
    empty-text="Nothing in this list."
    @row-click="open"
  >
    <el-table-column prop="title" label="Title" width="180" />
    <el-table-column prop="action" label="Action" width="140" />
    <el-table-column label="Decision" width="120">
      <template #default="{ row }">
        <el-tag :type="decisionTone(row.status)" effect="plain">
          {{ row.status }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="Delivery" width="120">
      <template #default="{ row }">
        <el-tag :type="decisionTone(row.deliveryStatus)" effect="plain">
          {{ row.deliveryStatus }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="Execution" width="160">
      <template #default="{ row }">
        <el-tag :type="decisionTone(executionLabel(row) === 'Unknown outcome' ? 'failed' : row.executionStatus)" effect="plain">
          {{ executionLabel(row) }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="expiresAt" label="Expires" width="220" />
  </el-table>
</template>
