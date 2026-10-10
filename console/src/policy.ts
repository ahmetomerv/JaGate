export type ConsoleRole = 'bootstrap' | 'issued';

export function shouldOfferCancel(status: string, cancelDenied: boolean): boolean {
  return status === 'pending' && !cancelDenied;
}

export function isUnknownOutcome(request: {
  status: string;
  executionStatus: string;
  resultAt: string | null;
}): boolean {
  return request.status === 'approved'
    && request.executionStatus === 'claimed'
    && request.resultAt === null;
}

export function cutoffIso(now: Date, windowMs: number, direction: 'past' | 'future'): string {
  const delta = direction === 'past' ? -windowMs : windowMs;
  return new Date(now.getTime() + delta).toISOString();
}

export function keyStatus(key: {
  expiresAt: string | null;
  revokedAt: string | null;
}, now: Date): 'revoked' | 'expired' | 'active' {
  if (key.revokedAt)
    return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime())
    return 'expired';
  return 'active';
}
