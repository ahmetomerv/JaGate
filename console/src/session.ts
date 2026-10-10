import type { ConsoleRole } from './policy.js';
import { reactive } from 'vue';

export interface SessionState {
  key: string | null;
  role: ConsoleRole | null;
  cancelDenied: boolean;
  clientId: string | null;
  revealedKey: string | null;
}

export interface ConsoleSession {
  state: SessionState;
  signIn: (key: string, role: ConsoleRole) => void;
  signOut: () => void;
  denyCancel: () => void;
  noteClient: (clientId: string) => void;
  openScope: () => AbortController;
  release: (controller: AbortController) => void;
  holdSecret: (key: string) => void;
  discardSecret: () => void;
  readSecret: () => string | null;
}

export function createConsoleSession(): ConsoleSession {
  const state = reactive<SessionState>({
    key: null,
    role: null,
    cancelDenied: false,
    clientId: null,
    revealedKey: null,
  });
  const controllers = new Set<AbortController>();

  function clearSecret(): void {
    state.revealedKey = null;
  }

  return {
    state,
    signIn(key: string, role: ConsoleRole): void {
      state.key = key;
      state.role = role;
      state.cancelDenied = false;
      state.clientId = null;
      clearSecret();
    },
    signOut(): void {
      state.key = null;
      state.role = null;
      state.cancelDenied = false;
      state.clientId = null;
      clearSecret();
      for (const controller of controllers)
        controller.abort();
      controllers.clear();
    },
    denyCancel(): void {
      state.cancelDenied = true;
    },
    noteClient(clientId: string): void {
      state.clientId = clientId;
    },
    openScope(): AbortController {
      const controller = new AbortController();
      controllers.add(controller);
      return controller;
    },
    release(controller: AbortController): void {
      controllers.delete(controller);
    },
    holdSecret(key: string): void {
      state.revealedKey = key;
    },
    discardSecret(): void {
      clearSecret();
    },
    readSecret(): string | null {
      return state.revealedKey;
    },
  };
}
