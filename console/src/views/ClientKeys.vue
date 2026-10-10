<script setup lang="ts">
import type { ClientKeyView } from '../../../src/client.js';
import { computed, onMounted, ref } from 'vue';
import { useConsole, useRequestScope } from '../context.js';
import { visibleError } from '../errors.js';
import { keyStatus } from '../policy.js';
import { consoleKeyScopes, scopeLabels } from '../scopes.js';

const { api, session } = useConsole();
const signal = useRequestScope();
const keys = ref<ClientKeyView[]>([]);
const cursor = ref<string | null>(null);
const error = ref('');
const loading = ref(false);
const label = ref('');
const scopes = ref<string[]>(['requests:read']);
const expiresAt = ref<string | null>(null);
const copied = ref(false);
const now = ref(new Date());
const secret = computed(() => session.state.revealedKey);

async function load(append: boolean): Promise<void> {
  if (signal.aborted || !session.state.key)
    return;
  loading.value = true;
  try {
    const page = await api.listClientKeys({
      limit: 20,
      ...(append && cursor.value ? { cursor: cursor.value } : {}),
    }, signal);
    keys.value = append ? [...keys.value, ...page.items] : page.items;
    cursor.value = page.nextCursor;
    const clientId = page.items[0]?.clientId;
    if (clientId)
      session.noteClient(clientId);
    now.value = new Date();
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

async function issue(): Promise<void> {
  const trimmed = label.value.trim();
  if (!trimmed || scopes.value.length === 0)
    return;
  error.value = '';
  try {
    let expires: string | undefined;
    if (expiresAt.value) {
      const parsed = new Date(expiresAt.value);
      if (Number.isNaN(parsed.getTime())) {
        error.value = 'Enter a valid expiry.';
        return;
      }
      expires = parsed.toISOString();
    }
    const issued = await api.createClientKey({
      label: trimmed,
      scopes: scopes.value.filter((scope): scope is typeof consoleKeyScopes[number] =>
        (consoleKeyScopes as readonly string[]).includes(scope)),
      ...(expires ? { expiresAt: expires } : {}),
    }, signal);
    session.holdSecret(issued.key);
    copied.value = false;
    label.value = '';
    expiresAt.value = null;
    await load(false);
  }
  catch (caught) {
    const message = visibleError(caught);
    if (message)
      error.value = message;
  }
}

async function copySecret(): Promise<void> {
  const value = session.readSecret();
  if (!value)
    return;
  try {
    await navigator.clipboard.writeText(value);
    copied.value = true;
  }
  catch {
    copied.value = false;
    error.value = 'The browser did not copy the key. Select it in the dialog.';
  }
}

function closeSecret(): void {
  session.discardSecret();
  copied.value = false;
}

async function revoke(id: string): Promise<void> {
  try {
    await api.revokeClientKey(id, signal);
    await load(false);
  }
  catch (caught) {
    const message = visibleError(caught);
    if (message)
      error.value = message;
  }
}

onMounted(() => {
  void load(false);
});
</script>

<template>
  <div class="console-stack">
    <div>
      <h1>Keys</h1>
      <p class="console-muted">
        Create, claim, and result scopes belong on a worker. This console reads requests, and cancels only when the signed-in key allows it.
        The bootstrap key cannot be revoked here.
      </p>
    </div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" />
    <el-card>
      <template #header>
        Issue a key
      </template>
      <el-form class="console-stack" @submit.prevent="issue">
        <el-form-item label="Label">
          <el-input v-model="label" maxlength="80" />
        </el-form-item>
        <el-form-item label="Scopes">
          <el-checkbox-group v-model="scopes">
            <el-checkbox v-for="scope in consoleKeyScopes" :key="scope" :value="scope">
              {{ scopeLabels[scope] }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="Expiry">
          <el-date-picker
            v-model="expiresAt"
            type="datetime"
            placeholder="No expiry"
            value-format="YYYY-MM-DDTHH:mm:ss"
          />
        </el-form-item>
        <el-button native-type="submit" type="primary" :disabled="label.trim().length === 0 || scopes.length === 0">
          Issue key
        </el-button>
      </el-form>
    </el-card>
    <el-card>
      <template #header>
        Issued keys
      </template>
      <el-table v-loading="loading" class="console-table" :data="keys" :fit="false" empty-text="No issued keys.">
        <el-table-column prop="label" label="Label" width="160" />
        <el-table-column label="Scopes" width="220">
          <template #default="{ row }">
            {{ row.scopes.join(', ') }}
          </template>
        </el-table-column>
        <el-table-column label="Status" width="110">
          <template #default="{ row }">
            {{ keyStatus(row, now) }}
          </template>
        </el-table-column>
        <el-table-column prop="expiresAt" label="Expires" width="220" />
        <el-table-column label="" width="120">
          <template #default="{ row }">
            <el-popconfirm
              v-if="keyStatus(row, now) === 'active'"
              title="Revoke this key? The next request that uses it will be rejected."
              confirm-button-text="Revoke"
              @confirm="revoke(row.id)"
            >
              <template #reference>
                <el-button link type="danger">
                  Revoke
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
      <el-button v-if="cursor" @click="load(true)">
        Load more
      </el-button>
    </el-card>
    <el-dialog
      :model-value="secret !== null"
      title="Copy this key now"
      :close-on-click-modal="false"
      @close="closeSecret"
    >
      <div class="console-stack">
        <p>
          This is the only time the key is shown. Closing this dialog drops it from memory.
          Sign out and paste it to use the console with this key.
        </p>
        <el-input :model-value="secret ?? ''" readonly />
        <el-button @click="copySecret">
          {{ copied ? 'Copied' : 'Copy' }}
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>
