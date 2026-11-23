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

describe("company research, scoring and people-selection workflow", () => {
  it("orchestrates qualified-only protected NestJS calls without owning business logic", async () => {
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
      "Qualified for People Selection?",
      "Prepare People Selection Request",
      "Sign People Selection Request",
      "Select Decision Makers in NestJS",
      "Confirm Research with People",
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
    const peoplePreparation = workflow.nodes.find(
      ({ name }) => name === "Prepare People Selection Request",
    );
    const peopleSignature = workflow.nodes.find(
      ({ name }) => name === "Sign People Selection Request",
    );
    const peopleRequest = workflow.nodes.find(
      ({ name }) => name === "Select Decision Makers in NestJS",
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
    expect(JSON.stringify(request?.parameters)).toContain(
      "x-f001-diagnostic-run-id",
    );
    expect(JSON.stringify(request?.parameters)).toContain(
      "x-f001-input-hash",
    );
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
    expect(JSON.stringify(scoringRequest?.parameters)).toContain(
      "x-f001-diagnostic-run-id",
    );
    expect(JSON.stringify(scoringRequest?.parameters)).toContain(
      "x-f001-input-hash",
    );
    expect(JSON.stringify(peoplePreparation?.parameters)).toContain(
      "/decision-makers",
    );
    expect(peopleSignature?.parameters).toMatchObject({
      action: "hmac",
      type: "SHA256",
      value: "={{ $json.peopleTimestamp + '\\nPOST\\n' + $json.peoplePath }}",
      secret: "={{ $env.N8N_SERVICE_SECRET }}",
    });
    expect(peopleRequest?.parameters).toMatchObject({
      method: "POST",
      url: "={{ $env.TCPL_API_URL + $json.peoplePath }}",
    });
    expect(JSON.stringify(peopleRequest?.parameters)).toContain(
      "x-f001-diagnostic-run-id",
    );
    expect(JSON.stringify(peopleRequest?.parameters)).toContain(
      "x-f001-input-hash",
    );

    expect(
      workflow.connections["Company Research Requested"]?.main[0]?.[0]?.node,
    ).toBe("Prepare Research Request");
    expect(
      workflow.connections["Research Company in NestJS"]?.main[0]?.[0]?.node,
    ).toBe("Prepare Scoring Request");
    expect(
      workflow.connections["Score Candidate in NestJS"]?.main[0]?.[0]?.node,
    ).toBe("Qualified for People Selection?");
    expect(
      workflow.connections["Qualified for People Selection?"]?.main[0]?.[0]
        ?.node,
    ).toBe("Prepare People Selection Request");
    expect(
      workflow.connections["Qualified for People Selection?"]?.main[1]?.[0]
        ?.node,
    ).toBe("Confirm Research");
    expect(
      workflow.connections["Select Decision Makers in NestJS"]?.main[0]?.[0]
        ?.node,
    ).toBe("Confirm Research with People");
    expect(
      workflow.nodes.some(({ type }) =>
        /openai|postgres|prisma|database/i.test(type),
      ),
    ).toBe(false);
  });
});
