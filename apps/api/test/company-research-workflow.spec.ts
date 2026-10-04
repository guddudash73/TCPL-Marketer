import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type Workflow = {
  nodes: Array<{
    name: string;
    type: string;
    parameters: Record<string, unknown>;
  }>;
  connections: Record<
    string,
    { main: Array<Array<{ node: string; type: string; index: number }>> }
  >;
};

describe("company research and scoring workflow", () => {
  it("orchestrates protected NestJS research and scoring without owning business logic", async () => {
    const workflow = JSON.parse(
      await readFile(
        new URL(
          "../../../automation/n8n/workflows/company-research.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Workflow;

    expect(workflow.nodes.map(({ name }) => name)).toEqual([
      "Company Research Requested",
      "Prepare Research Request",
      "Sign Research Request",
      "Research Company in NestJS",
      "Prepare Scoring Request",
      "Sign Scoring Request",
      "Score Candidate in NestJS",
      "Confirm Research",
    ]);

    const preparation = workflow.nodes.find(
      ({ name }) => name === "Prepare Research Request",
    );
    const signature = workflow.nodes.find(
      ({ name }) => name === "Sign Research Request",
    );
    const request = workflow.nodes.find(
      ({ name }) => name === "Research Company in NestJS",
    );
    const scoringPreparation = workflow.nodes.find(
      ({ name }) => name === "Prepare Scoring Request",
    );
    const scoringSignature = workflow.nodes.find(
      ({ name }) => name === "Sign Scoring Request",
    );
    const scoringRequest = workflow.nodes.find(
      ({ name }) => name === "Score Candidate in NestJS",
    );
    expect(JSON.stringify(preparation?.parameters)).toContain(
      "/internal/lead-candidates/",
    );
    expect(signature?.parameters).toMatchObject({
      action: "hmac",
      type: "SHA256",
      secret: "={{ $env.N8N_SERVICE_SECRET }}",
    });
    expect(request?.parameters).toMatchObject({
      method: "POST",
      url: "={{ $env.TCPL_API_URL + $json.researchPath }}",
    });
    expect(JSON.stringify(scoringPreparation?.parameters)).toContain(
      "/internal/lead-candidates/",
    );
    expect(JSON.stringify(scoringPreparation?.parameters)).toContain("/score");
    expect(scoringSignature?.parameters).toMatchObject({
      action: "hmac",
      type: "SHA256",
      secret: "={{ $env.N8N_SERVICE_SECRET }}",
    });
    expect(scoringRequest?.parameters).toMatchObject({
      method: "POST",
      url: "={{ $env.TCPL_API_URL + $json.scoringPath }}",
    });

    expect(
      workflow.connections["Company Research Requested"]?.main[0]?.[0]?.node,
    ).toBe("Prepare Research Request");
    expect(
      workflow.connections["Research Company in NestJS"]?.main[0]?.[0]?.node,
    ).toBe("Prepare Scoring Request");
    expect(
      workflow.connections["Score Candidate in NestJS"]?.main[0]?.[0]?.node,
    ).toBe("Confirm Research");
    expect(
      workflow.nodes.some(({ type }) =>
        /openai|postgres|prisma|database/i.test(type),
      ),
    ).toBe(false);
  });
});
