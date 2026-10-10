import type { InjectionKey } from 'vue';
import type { ConsoleApi } from './api.js';
import type { ConsoleSession } from './session.js';
import { inject, onUnmounted } from 'vue';

export interface ConsoleContext {
  session: ConsoleSession;
  api: ConsoleApi;
  baseUrl: string;
}

export const consoleKey: InjectionKey<ConsoleContext> = Symbol('jagate-console');

export function useConsole(): ConsoleContext {
  const context = inject(consoleKey);
  if (!context)
    throw new Error('console context is missing');
  return context;
}

export function useRequestScope(): AbortSignal {
  const { session } = useConsole();
  const controller = session.openScope();
  onUnmounted(() => {
    controller.abort();
    session.release(controller);
  });
  return controller.signal;
}
