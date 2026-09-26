import { z } from 'zod';

const configSchema = z.object({
  CLIENT_KEYS: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(10).refine((v) => v !== 'replace-with-dedicated-bot-token'),
  TELEGRAM_ROUTES: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?[1-9]\d*$/).optional(),
  TELEGRAM_APPROVER_IDS: z.string().regex(/^[1-9]\d*(,[1-9]\d*)*$/).optional(),
  DATABASE_PATH: z.string().default('./data/gateway.sqlite'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3080),
});

export type TelegramRoute = { chatId: string; approverIds: ReadonlySet<string> };
const routeSchema = z.object({
  chatId: z.string().regex(/^-?[1-9]\d*$/),
  approverIds: z.array(z.string().regex(/^[1-9]\d*$/)).min(1),
}).strict();

export function parseClientKeys(raw: string): ReadonlyMap<string, string> {
  const entries = raw.split(',');
  if (entries.length > 32) throw new Error('CLIENT_KEYS supports at most 32 clients');
  const keys = new Map<string, string>();
  const seenSecrets = new Set<string>();
  for (const entry of entries) {
    const match = /^([a-z][a-z0-9_-]{0,31}):([A-Za-z0-9_-]{32,128})$/.exec(entry);
    if (!match || match[2] === 'replace-with-a-long-random-secret' || keys.has(match[1]!) || seenSecrets.has(match[2]!))
      throw new Error('CLIENT_KEYS must contain unique client IDs and unique random keys in clientId:key format');
    keys.set(match[1]!, match[2]!);
    seenSecrets.add(match[2]!);
  }
  return keys;
}

export function parseConfig(env: NodeJS.ProcessEnv) {
  const { CLIENT_KEYS, TELEGRAM_ROUTES, TELEGRAM_CHAT_ID, TELEGRAM_APPROVER_IDS, ...config } = configSchema.parse(env);
  const clientKeys = parseClientKeys(CLIENT_KEYS);
  const routes = new Map<string, TelegramRoute>();
  const seenChats = new Set<string>();
  if (TELEGRAM_ROUTES !== undefined) {
    if (TELEGRAM_CHAT_ID || TELEGRAM_APPROVER_IDS) throw new Error('Use TELEGRAM_ROUTES instead of the legacy global Telegram settings');
    let parsed: unknown;
    try { parsed = JSON.parse(TELEGRAM_ROUTES); }
    catch { throw new Error('TELEGRAM_ROUTES must be a JSON object keyed by client ID'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TELEGRAM_ROUTES must be a JSON object keyed by client ID');
    const entries = Object.entries(parsed);
    if (entries.length !== clientKeys.size || entries.some(([id]) => !clientKeys.has(id)))
      throw new Error('TELEGRAM_ROUTES must contain exactly one route for each CLIENT_KEYS client ID');
    for (const [id, value] of entries) {
      const route = routeSchema.parse(value);
      const approverIds = new Set(route.approverIds);
      if (approverIds.size !== route.approverIds.length) throw new Error(`TELEGRAM_ROUTES has duplicate approver IDs for client ${id}`);
      if (seenChats.has(route.chatId)) throw new Error('TELEGRAM_ROUTES must use a distinct chat ID for each client');
      seenChats.add(route.chatId);
      routes.set(id, { chatId: route.chatId, approverIds });
    }
  } else {
    if (clientKeys.size !== 1) throw new Error('Multiple clients require TELEGRAM_ROUTES with a destination and approvers for each client');
    if (!TELEGRAM_CHAT_ID || !TELEGRAM_APPROVER_IDS) throw new Error('Configure TELEGRAM_ROUTES or both legacy TELEGRAM_CHAT_ID and TELEGRAM_APPROVER_IDS');
    const approverIds = TELEGRAM_APPROVER_IDS.split(',');
    if (new Set(approverIds).size !== approverIds.length) throw new Error('TELEGRAM_APPROVER_IDS must not contain duplicates');
    routes.set(clientKeys.keys().next().value!, { chatId: TELEGRAM_CHAT_ID, approverIds: new Set(approverIds) });
  }
  return { ...config, clientKeys, routes };
}
