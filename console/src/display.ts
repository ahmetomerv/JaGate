import type { RequestView } from '../../src/client.js';
import { isUnknownOutcome } from './policy.js';

export function decisionTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'approved' || status === 'succeeded' || status === 'delivered')
    return 'success';
  if (status === 'pending' || status === 'retrying' || status === 'claimed' || status === 'unclaimed')
    return 'warning';
  if (status === 'rejected' || status === 'expired' || status === 'failed' || status === 'cancelled')
    return 'danger';
  return 'info';
}

export function executionLabel(request: RequestView): string {
  if (isUnknownOutcome(request))
    return 'Unknown outcome';
  return request.executionStatus;
}
