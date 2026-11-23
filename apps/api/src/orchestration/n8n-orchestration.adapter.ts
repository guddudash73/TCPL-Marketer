import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  UnroutableOrchestrationEventError,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationGateway,
  type PublishResult,
} from "@tcpl-marketer/orchestration-contracts";

/** Each event type needs an explicit webhook; later stages add theirs in their own tasks. */
const EVENT_WEBHOOKS: Partial<Record<OrchestrationEventType, string>> = {
  CAMPAIGN_STARTED: "campaign-start",
};

@Injectable()
export class N8nOrchestrationAdapter implements OrchestrationGateway {
  async publish(event: OrchestrationEvent): Promise<PublishResult> {
    const webhookPath = EVENT_WEBHOOKS[event.eventType as OrchestrationEventType];
    if (!webhookPath) {
      throw new UnroutableOrchestrationEventError(event.eventType);
    }
    return this.post(webhookPath, { event }, { "x-idempotency-key": event.id });
  }

  schedule(
    event: OrchestrationEvent,
    executeAt: Date,
  ): Promise<PublishResult> {
    return this.post("orchestration-schedule", {
      event,
      executeAt: executeAt.toISOString(),
    });
  }

  async cancel(reference: string): Promise<void> {
    await this.post("orchestration-cancel", { reference });
  }

  private async post(
    webhookPath: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<PublishResult> {
    const baseUrl = process.env.N8N_BASE_URL;
    const secret = process.env.N8N_SERVICE_SECRET;
    if (!baseUrl || !secret) {
      throw new ServiceUnavailableException(
        "n8n orchestration is not configured",
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/webhook/${webhookPath}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            ...extraHeaders,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(n8nRequestTimeoutMilliseconds()),
        },
      );
    } catch {
      throw new BadGatewayException("n8n orchestration request failed");
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `n8n orchestration returned HTTP ${response.status}`,
      );
    }

    const result = (await response.json().catch(() => ({}))) as {
      executionId?: unknown;
    };
    return {
      externalRunId:
        typeof result.executionId === "string"
          ? result.executionId
          : undefined,
    };
  }
}

function n8nRequestTimeoutMilliseconds(): number {
  const configured = Number(process.env.N8N_REQUEST_TIMEOUT_MS ?? 120_000);
  if (!Number.isInteger(configured) || configured < 1_000 || configured > 300_000) {
    throw new ServiceUnavailableException(
      "N8N_REQUEST_TIMEOUT_MS must be an integer between 1000 and 300000",
    );
  }
  return configured;
}
