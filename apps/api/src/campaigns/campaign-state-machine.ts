export const CAMPAIGN_STATES = [
  "DRAFT",
  "STARTING",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "STOPPED",
  "FAILED",
] as const;

export type CampaignState = (typeof CAMPAIGN_STATES)[number];

const transitions: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  DRAFT: ["STARTING", "STOPPED"],
  STARTING: ["RUNNING", "FAILED", "STOPPED"],
  RUNNING: ["PAUSED", "COMPLETED", "STOPPED", "FAILED"],
  PAUSED: ["RUNNING", "STOPPED"],
  COMPLETED: [],
  STOPPED: [],
  FAILED: ["STARTING", "STOPPED"],
};

export function canTransitionCampaign(
  from: CampaignState,
  to: CampaignState,
): boolean {
  return transitions[from].includes(to);
}

export function requireCampaignTransition(
  from: CampaignState,
  to: CampaignState,
): void {
  if (!canTransitionCampaign(from, to)) {
    throw new Error(`Campaign cannot transition from ${from} to ${to}`);
  }
}
