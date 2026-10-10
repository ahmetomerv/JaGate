import { ApiError } from '../../src/client.js';

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function visibleError(error: unknown): string | null {
  if (isAbort(error))
    return null;
  if (error instanceof ApiError) {
    if (error.status === 401)
      return null;
    if (error.status === 404)
      return 'This was not found for the signed-in client.';
    return error.message;
  }
  return 'The gateway could not be reached.';
}
