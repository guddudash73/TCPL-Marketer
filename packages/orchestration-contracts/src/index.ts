export const ORCHESTRATION_GATEWAY = Symbol("ORCHESTRATION_GATEWAY");

export interface OrchestrationEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
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
