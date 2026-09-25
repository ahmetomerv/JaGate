export class GatewayError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
  }
}
