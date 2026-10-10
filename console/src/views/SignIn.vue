<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../../../src/client.js';
import { classifyKey, createConsoleApi } from '../api.js';
import { useConsole } from '../context.js';

const router = useRouter();
const { session, baseUrl } = useConsole();
const draft = ref('');
const error = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  const key = draft.value.trim();
  if (!key || submitting.value)
    return;
  submitting.value = true;
  error.value = '';
  const probe = createConsoleApi({
    baseUrl,
    getKey: () => key,
    onUnauthorized: () => {},
  });
  try {
    const role = await classifyKey(() => probe.listClientKeys({ limit: 1 }));
    session.signIn(key, role);
    draft.value = '';
    await router.replace('/inbox');
  }
  catch (caught) {
    session.signOut();
    error.value = caught instanceof ApiError && caught.status === 401
      ? 'This key was not accepted.'
      : 'The gateway could not be reached.';
  }
  finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-card>
    <template #header>
      JaGate console
    </template>
    <div class="console-stack">
      <p>
        Paste one client key. An issued key with Read requests opens the inbox.
        Add Cancel requests only if this browser should cancel pending approvals.
        The bootstrap key also opens Keys and Audit.
      </p>
      <p class="console-muted">
        The key stays in memory for this tab. It is not saved in the browser.
        Approve and reject stay in Telegram.
      </p>
      <el-alert v-if="error" type="error" :closable="false" :title="error" />
      <el-form @submit.prevent="submit">
        <el-form-item label="Client key">
          <el-input
            v-model="draft"
            type="password"
            show-password
            name="jagate-client-key"
            autocomplete="off"
            spellcheck="false"
          />
        </el-form-item>
        <el-button native-type="submit" type="primary" :loading="submitting">
          Sign in
        </el-button>
      </el-form>
    </div>
  </el-card>
</template>
