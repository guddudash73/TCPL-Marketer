export const ORCHESTRATION_GATEWAY = Symbol("ORCHESTRATION_GATEWAY");

export interface OrchestrationEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Trace identifier carried to n8n as a header so one run can be followed end to end. */
  correlationId?: string | undefined;
}

export interface PublishResult {
  externalRunId?: string;
}

export interface OrchestrationGateway {
  publish(event: OrchestrationEvent): Promise<PublishResult>;
  schedule(
    event: OrchestrationEvent,
    executeAt: Date,
  ): Promise<PublishResult>;
  cancel(reference: string): Promise<void>;
}

/** The gateway has no route for this event type. Retrying cannot help. */
export class UnroutableOrchestrationEventError extends Error {
  constructor(eventType: string) {
    super(`No orchestration route is configured for event type ${eventType}`);
    this.name = "UnroutableOrchestrationEventError";
  }
}

export * from "./service-auth.js";
export * from "./stages.js";
