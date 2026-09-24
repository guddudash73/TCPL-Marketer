import { createHash, randomBytes } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";

const database = createPrismaClient();
const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);
const sessionToken = randomBytes(32).toString("base64url");
let sessionId: string | undefined;

try {
  const actor = await database.user.findFirst({
    where: {
      status: "ACTIVE",
      roles: { some: { role: { name: { in: ["ADMIN", "MANAGER"] } } } },
    },
  });
  if (!actor) {
    throw new Error("Seed an ADMIN or MANAGER user before the Day 3 live check");
  }

  const configuration = await database.sector.findUnique({
    where: { slug: "lidar" },
    include: {
      capabilities: { include: { deliverables: true, targetProfiles: true } },
    },
  });
  const capability = configuration?.capabilities[0];
  if (
    !configuration ||
    !capability?.deliverables[0] ||
    !capability.targetProfiles[0]
  ) {
    throw new Error("Seeded LiDAR configuration is required");
  }

  const session = await database.userSession.create({
    data: {
      userId: actor.id,
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  sessionId = session.id;

  const pendingCampaign = await database.campaign.findFirst({
    where: {
      createdByUserId: actor.id,
      name: { startsWith: "Day 3 Closeout " },
      status: "STARTING",
    },
    orderBy: { createdAt: "desc" },
  });
  const campaign =
    pendingCampaign ??
    (await apiRequest<{ id: string }>("/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Day 3 Closeout ${new Date().toISOString()}`,
        sectorId: configuration.id,
        capabilityIds: [capability.id],
        deliverableIds: [capability.deliverables[0].id],
        targetClientProfileIds: [capability.targetProfiles[0].id],
        countries: ["United States"],
        states: [],
        cities: [],
        minimumEmployees: 10,
        maximumEmployees: 500,
        researchDepth: "STANDARD",
        targetLeadCount: 5,
        minimumScore: 70,
        automationMode: "MANUAL_REVIEW",
        dailyEmailLimit: 10,
        sequence: [{ stepNumber: 1, delayDays: 0 }],
      }),
    }));

  const started = await apiRequest<{
    campaign: { status: string };
    event: { status: string };
    automationRun: { externalRunId: string | null; status: string };
  }>(`/campaigns/${campaign.id}/start`, { method: "POST" });

  const candidates = await database.leadCandidate.findMany({
    where: { campaignId: campaign.id },
    include: { organization: true },
    orderBy: { discoveredAt: "asc" },
  });
  if (candidates.length < 2) {
    throw new Error(
      `Day 3 checkpoint requires several persisted organizations; found ${candidates.length}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        campaignId: campaign.id,
        campaignStatus: started.campaign.status,
        outboxStatus: started.event.status,
        automationRun: started.automationRun,
        candidateCount: candidates.length,
        organizations: candidates.map(({ organization }) => ({
          id: organization.id,
          name: organization.name,
          domain: organization.normalizedDomain,
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (sessionId) {
    await database.userSession.deleteMany({ where: { id: sessionId } });
  }
  await database.$disconnect();
}

async function apiRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `tcpl_session=${sessionToken}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `API ${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}
