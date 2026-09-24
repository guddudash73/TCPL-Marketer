import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  OrchestrationEvent,
  OrchestrationGateway,
  PublishResult,
} from "@tcpl-marketer/orchestration-contracts";

@Injectable()
export class N8nOrchestrationAdapter implements OrchestrationGateway {
  publish(event: OrchestrationEvent): Promise<PublishResult> {
    return this.post("campaign-start", { event });
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
