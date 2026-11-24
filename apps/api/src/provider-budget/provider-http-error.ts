/**
 * A provider answered with an error status. The adapter keeps it as the `cause` of
 * the NestJS exception it throws, so the shared outcome mapper can read the
 * provider's own status, any error code and its Retry-After header (PH1-03c).
 * It never holds the response body.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly headers: Headers | undefined,
    readonly code?: string,
    /** A wait the provider stated in its error body, for when it sends no Retry-After header. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`${provider} answered with status ${status}`);
    this.name = "ProviderHttpError";
  }
}
