<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import logoUrl from '../../assets/logo.svg';
import { useConsole } from './context.js';

interface ReadyState {
  ready: boolean;
  storage: boolean;
  telegram: boolean;
}

const route = useRoute();
const router = useRouter();
const { session, baseUrl } = useConsole();
const ready = ref<ReadyState | null>(null);
const readyController = new AbortController();
const signedIn = computed(() => session.state.key !== null);
const inboxActive = computed(() => route.path === '/inbox' || route.path.startsWith('/requests/'));
let timer: ReturnType<typeof setTimeout> | undefined;

const readyTitle = computed(() => {
  if (!ready.value || ready.value.ready)
    return '';
  if (!ready.value.storage)
    return 'Storage is unavailable. The console cannot load requests.';
  if (!ready.value.telegram)
    return 'Telegram is not ready. New requests cannot be delivered. Existing requests can still be read.';
  return 'The gateway is not ready for new requests.';
});

async function pollReady(): Promise<void> {
  if (readyController.signal.aborted)
    return;
  try {
    const response = await fetch(new URL('/ready', baseUrl), { signal: readyController.signal });
    ready.value = await response.json() as ReadyState;
  }
  catch {
    // Keep the last banner. Signing out must not stop this public check.
  }
  if (!readyController.signal.aborted)
    timer = setTimeout(() => void pollReady(), 10000);
}

function signOut(): void {
  session.signOut();
  void router.replace('/');
}

function go(path: string): void {
  void router.push(path);
}

onMounted(() => {
  void pollReady();
});

onUnmounted(() => {
  readyController.abort();
  if (timer)
    clearTimeout(timer);
});
</script>

<template>
  <div class="console-shell">
    <header v-if="signedIn" class="console-header">
      <div class="console-brand">
        <img class="console-logo" :src="logoUrl" alt="" width="28" height="28">
        <div class="console-brand-text">
          <strong>JaGate</strong>
          <span v-if="session.state.clientId" class="console-muted">{{ session.state.clientId }}</span>
        </div>
      </div>
      <nav class="console-nav">
        <el-button :type="inboxActive ? 'primary' : 'default'" link @click="go('/inbox')">
          Inbox
        </el-button>
        <el-button
          v-if="session.state.role === 'bootstrap'"
          :type="route.path === '/keys' ? 'primary' : 'default'"
          link
          @click="go('/keys')"
        >
          Keys
        </el-button>
        <el-button
          v-if="session.state.role === 'bootstrap'"
          :type="route.path === '/audit' ? 'primary' : 'default'"
          link
          @click="go('/audit')"
        >
          Audit
        </el-button>
      </nav>
      <el-button @click="signOut">
        Sign out
      </el-button>
    </header>
    <main :class="signedIn ? 'console-main' : 'console-sign-in'">
      <div class="console-stack">
        <el-alert
          v-if="readyTitle"
          type="warning"
          :closable="false"
          show-icon
          :title="readyTitle"
        />
        <router-view />
      </div>
    </main>
  </div>
</template>
