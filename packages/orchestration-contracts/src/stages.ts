/**
 * Phase 1 stage catalogue, event types and the stage run transition table.
 *
 * NestJS owns every state transition; n8n only schedules and calls protected
 * endpoints. Each transition below names exactly one owner. Later phases extend
 * this catalogue in their own tasks (outreach, follow-up, reply, assignment).
 */

export const PIPELINE_STAGES = [
  "DISCOVERY",
  "CRAWL",
  "RESEARCH",
  "EXTERNAL_INTELLIGENCE",
  "SCORING",
  "PEOPLE",
  "CONTACT",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REVIEW_REQUIRED",
  "CANCELLED",
  "SKIPPED",
] as const;
export type StageRunStatus = (typeof STAGE_RUN_STATUSES)[number];

/** Statuses from which a run needs no further automatic work. */
export const TERMINAL_STAGE_RUN_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "REVIEW_REQUIRED",
  "CANCELLED",
  "SKIPPED",
] as const satisfies readonly StageRunStatus[];

export function isTerminalStageRunStatus(status: StageRunStatus): boolean {
  return (TERMINAL_STAGE_RUN_STATUSES as readonly string[]).includes(status);
}

export const ORCHESTRATION_EVENT_TYPES = [
  "CAMPAIGN_STARTED",
  "CANDIDATE_READY",
  "CRAWL_COMPLETED",
  "RESEARCH_COMPLETED",
  "EXTERNAL_INTELLIGENCE_COMPLETED",
  "LEAD_QUALIFIED",
  "PEOPLE_SELECTED",
  "CONTACT_STAGE_COMPLETED",
] as const;
export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

export interface StageDefinition {
  stage: PipelineStage;
  /** Kind of entity the stage runs against (the key with entityId). */
  entityType: "campaign" | "lead_candidate";
  /** Event that asks for this stage to run. */
  requestEvent: OrchestrationEventType;
  /** Event emitted when the stage finishes successfully. */
  completionEvent: OrchestrationEventType;
  /** The single domain service allowed to finish a run of this stage. */
  domainOwner: string;
}

export const STAGE_DEFINITIONS: Readonly<Record<PipelineStage, StageDefinition>> = {
  DISCOVERY: {
    stage: "DISCOVERY",
    entityType: "campaign",
    requestEvent: "CAMPAIGN_STARTED",
    completionEvent: "CANDIDATE_READY",
    domainOwner: "SearchService",
  },
  CRAWL: {
    stage: "CRAWL",
    entityType: "lead_candidate",
    requestEvent: "CANDIDATE_READY",
    completionEvent: "CRAWL_COMPLETED",
    domainOwner: "CrawlStageService",
  },
  RESEARCH: {
    stage: "RESEARCH",
    entityType: "lead_candidate",
    requestEvent: "CRAWL_COMPLETED",
    completionEvent: "RESEARCH_COMPLETED",
    domainOwner: "CompanyIntelligenceService",
  },
  EXTERNAL_INTELLIGENCE: {
    stage: "EXTERNAL_INTELLIGENCE",
    entityType: "lead_candidate",
    requestEvent: "RESEARCH_COMPLETED",
    completionEvent: "EXTERNAL_INTELLIGENCE_COMPLETED",
    domainOwner: "ExternalIntelligenceService",
  },
  SCORING: {
    stage: "SCORING",
    entityType: "lead_candidate",
    requestEvent: "EXTERNAL_INTELLIGENCE_COMPLETED",
    completionEvent: "LEAD_QUALIFIED",
    domainOwner: "OpportunityScoringService",
  },
  PEOPLE: {
    stage: "PEOPLE",
    entityType: "lead_candidate",
    requestEvent: "LEAD_QUALIFIED",
    completionEvent: "PEOPLE_SELECTED",
    domainOwner: "PeopleSelectionWorkflowService",
  },
  CONTACT: {
    stage: "CONTACT",
    entityType: "lead_candidate",
    requestEvent: "PEOPLE_SELECTED",
    completionEvent: "CONTACT_STAGE_COMPLETED",
    domainOwner: "ContactReadinessService",
  },
};

/** Generic owners; the stage's own domain service is the owner of "STAGE_DOMAIN" transitions. */
export const STAGE_RUNTIME_OWNER = "StageRuntime";
export const CAMPAIGN_LIFECYCLE_OWNER = "CampaignLifecycleService";
export const OPERATOR_RETRY_OWNER = "OperatorRetryService";
export const STAGE_DOMAIN_OWNER = "STAGE_DOMAIN";

export type StageTransitionOwner =
  | typeof STAGE_RUNTIME_OWNER
  | typeof CAMPAIGN_LIFECYCLE_OWNER
  | typeof OPERATOR_RETRY_OWNER
  | typeof STAGE_DOMAIN_OWNER;

export interface StageTransitionRule {
  from: StageRunStatus;
  to: StageRunStatus;
  owner: StageTransitionOwner;
}

/**
 * The complete, closed set of allowed transitions. Anything not listed is
 * rejected. Exactly one owner per (from, to) pair.
 */
export const STAGE_TRANSITIONS: readonly StageTransitionRule[] = [
  // The runtime claims work under a lease and recovers abandoned work.
  { from: "PENDING", to: "RUNNING", owner: STAGE_RUNTIME_OWNER },
  { from: "RUNNING", to: "PENDING", owner: STAGE_RUNTIME_OWNER },
  // The stage's own domain service decides how its run ended.
  { from: "RUNNING", to: "SUCCEEDED", owner: STAGE_DOMAIN_OWNER },
  { from: "RUNNING", to: "FAILED", owner: STAGE_DOMAIN_OWNER },
  { from: "RUNNING", to: "REVIEW_REQUIRED", owner: STAGE_DOMAIN_OWNER },
  { from: "RUNNING", to: "SKIPPED", owner: STAGE_DOMAIN_OWNER },
  // Campaign lifecycle controls (pause/stop) cancel work that has not finished.
  { from: "PENDING", to: "CANCELLED", owner: CAMPAIGN_LIFECYCLE_OWNER },
  { from: "RUNNING", to: "CANCELLED", owner: CAMPAIGN_LIFECYCLE_OWNER },
  // An authorized operator retries failed or reviewed work.
  { from: "FAILED", to: "PENDING", owner: OPERATOR_RETRY_OWNER },
  { from: "REVIEW_REQUIRED", to: "PENDING", owner: OPERATOR_RETRY_OWNER },
  { from: "CANCELLED", to: "PENDING", owner: OPERATOR_RETRY_OWNER },
];

export function findStageTransition(
  from: StageRunStatus,
  to: StageRunStatus,
): StageTransitionRule | undefined {
  return STAGE_TRANSITIONS.find((rule) => rule.from === from && rule.to === to);
}

/** The actor name that is allowed to perform the transition for this stage, or undefined if none. */
export function stageTransitionOwnerFor(
  stage: PipelineStage,
  from: StageRunStatus,
  to: StageRunStatus,
): string | undefined {
  const rule = findStageTransition(from, to);
  if (!rule) return undefined;
  return rule.owner === STAGE_DOMAIN_OWNER
    ? STAGE_DEFINITIONS[stage].domainOwner
    : rule.owner;
}

export class StageTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageTransitionError";
  }
}

export function requireStageTransition(
  stage: PipelineStage,
  from: StageRunStatus,
  to: StageRunStatus,
  actor: string,
): void {
  const owner = stageTransitionOwnerFor(stage, from, to);
  if (!owner) {
    throw new StageTransitionError(
      `Stage ${stage} cannot transition from ${from} to ${to}`,
    );
  }
  if (owner !== actor) {
    throw new StageTransitionError(
      `Stage ${stage} transition ${from} to ${to} is owned by ${owner}, not ${actor}`,
    );
  }
}

/** Read-only view of campaign state used when a stage run is claimed. */
export const CAMPAIGN_STATE_READER = Symbol("CAMPAIGN_STATE_READER");

/**
 * DISPATCHABLE: work may run. HOLD: keep the work and check again later.
 * TERMINAL: the campaign will not run this work. MISSING: no such campaign.
 */
export type CampaignDispatchState = "DISPATCHABLE" | "HOLD" | "TERMINAL" | "MISSING";

export interface CampaignStateReader {
  /** True only while work for the campaign may be dispatched. */
  isDispatchable(campaignId: string): Promise<boolean>;
  getDispatchState(campaignId: string): Promise<CampaignDispatchState>;
}
