import { z } from 'zod';

const configSchema = z.object({
  API_KEY: z.string().min(32).refine((v) => v !== 'replace-with-a-long-random-secret'),
  TELEGRAM_BOT_TOKEN: z.string().min(10).refine((v) => v !== 'replace-with-dedicated-bot-token'),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/),
  TELEGRAM_APPROVER_IDS: z.string().regex(/^\d+(,\d+)*$/),
  DATABASE_PATH: z.string().default('./data/gateway.sqlite'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3080),
});

export function parseConfig(env: NodeJS.ProcessEnv) {
  return configSchema.parse(env);
}
