import ElementPlus from 'element-plus';
import { createApp } from 'vue';
import { createConsoleApi } from './api.js';
import App from './App.vue';
import { consoleKey } from './context.js';
import { createConsoleRouter } from './router.js';
import { createConsoleSession } from './session.js';
import './style.css';

const session = createConsoleSession();
const router = createConsoleRouter();
const baseUrl = window.location.origin;

router.beforeEach((to) => {
  const signedIn = session.state.key !== null;
  if (to.meta.public) {
    if (signedIn)
      return '/inbox';
    return true;
  }
  if (!signedIn)
    return '/';
  if (to.meta.bootstrap && session.state.role !== 'bootstrap')
    return '/inbox';
  return true;
});

const api = createConsoleApi({
  baseUrl,
  getKey: () => {
    const key = session.state.key;
    if (!key)
      throw new Error('signed out');
    return key;
  },
  onUnauthorized: () => {
    session.signOut();
    if (router.currentRoute.value.path !== '/')
      void router.replace('/');
  },
});

createApp(App)
  .use(ElementPlus)
  .use(router)
  .provide(consoleKey, { session, api, baseUrl })
  .mount('#app');
