import type { ProviderCallContext } from "@tcpl-marketer/provider-contracts";

/**
 * The gateway-issued proof that a provider call is budgeted and audited (PH1-03c).
 * A context can only come from `issueProviderCallContext`, which only the gateway
 * (and the standalone gateway used by manual live scripts) imports. Adapters call
 * `requireProviderCallContext` first, so a call made outside the gateway fails
 * before any request leaves the process. The source-scanning bypass test keeps the
 * set of importers of this file closed.
 */
export class ProviderBypassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBypassError";
  }
}

export interface IssuedProviderCallContext extends ProviderCallContext {
  /** Requests the adapter counted so far. Read by the gateway when it settles. */
  readonly requests: number;
}

const issued = new WeakSet<object>();

export function issueProviderCallContext(provider: string, operation: string): IssuedProviderCallContext {
  let requests = 0;
  const context = {
    provider,
    operation,
    recordRequest(count = 1): void {
      if (Number.isInteger(count) && count > 0) requests += count;
    },
    get requests(): number {
      return requests;
    },
  };
  issued.add(context);
  return context;
}

/** Throws unless `context` was issued by the gateway for this provider. */
export function requireProviderCallContext(context: unknown, provider: string): ProviderCallContext {
  if (typeof context !== "object" || context === null || !issued.has(context)) {
    throw new ProviderBypassError(`A ${provider} call was attempted outside the provider gateway`);
  }
  const issuedContext = context as ProviderCallContext;
  if (issuedContext.provider !== provider) {
    throw new ProviderBypassError(`A ${issuedContext.provider} context was used for a ${provider} call`);
  }
  return issuedContext;
}
