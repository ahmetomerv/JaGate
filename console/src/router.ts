import type { RouteRecordRaw } from 'vue-router';
import { createRouter, createWebHistory } from 'vue-router';
import AuditFeed from './views/AuditFeed.vue';
import ClientKeys from './views/ClientKeys.vue';
import RequestDetail from './views/RequestDetail.vue';
import RequestInbox from './views/RequestInbox.vue';
import SignIn from './views/SignIn.vue';

export const routes: RouteRecordRaw[] = [
  { path: '/', component: SignIn, meta: { public: true } },
  { path: '/inbox', component: RequestInbox },
  { path: '/requests/:id', component: RequestDetail },
  { path: '/keys', component: ClientKeys, meta: { bootstrap: true } },
  { path: '/audit', component: AuditFeed, meta: { bootstrap: true } },
];

export function createConsoleRouter(): ReturnType<typeof createRouter> {
  return createRouter({
    history: createWebHistory(),
    routes,
  });
}
