import { z } from 'zod';

const configSchema = z.object({
  CLIENT_KEYS: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(10).refine((v) => v !== 'replace-with-dedicated-bot-token'),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/),
  TELEGRAM_APPROVER_IDS: z.string().regex(/^\d+(,\d+)*$/),
  DATABASE_PATH: z.string().default('./data/gateway.sqlite'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3080),
});

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
  const { CLIENT_KEYS, ...config } = configSchema.parse(env);
  return { ...config, clientKeys: parseClientKeys(CLIENT_KEYS) };
}
