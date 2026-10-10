export const consoleKeyScopes = [
  'requests:create',
  'requests:read',
  'requests:cancel',
  'requests:claim',
  'requests:result',
] as const;

export type ConsoleKeyScope = (typeof consoleKeyScopes)[number];

export const scopeLabels: Record<ConsoleKeyScope, string> = {
  'requests:create': 'Create requests',
  'requests:read': 'Read requests',
  'requests:cancel': 'Cancel requests',
  'requests:claim': 'Claim approvals',
  'requests:result': 'Report results',
};
