import {
  CAMPAIGN_LIFECYCLE_OWNER,
  OPERATOR_RETRY_OWNER,
  PIPELINE_STAGES,
  STAGE_DEFINITIONS,
  STAGE_RUN_STATUSES,
  STAGE_RUNTIME_OWNER,
  STAGE_TRANSITIONS,
  StageTransitionError,
  isTerminalStageRunStatus,
  requireStageTransition,
  stageTransitionOwnerFor,
} from "@tcpl-marketer/orchestration-contracts";
import { describe, expect, it } from "vitest";

import { canonicalJson, computeStageInputHash } from "../src/orchestration/stage-input-hash.js";

const allActors = [
  STAGE_RUNTIME_OWNER,
  CAMPAIGN_LIFECYCLE_OWNER,
  OPERATOR_RETRY_OWNER,
  ...PIPELINE_STAGES.map((stage) => STAGE_DEFINITIONS[stage].domainOwner),
  "SomeOtherService",
];

describe("stage catalogue and transition table", () => {
  it("allows exactly the listed transitions, for the listed owner only", () => {
    let allowed = 0;
    for (const stage of PIPELINE_STAGES) {
      for (const from of STAGE_RUN_STATUSES) {
        for (const to of STAGE_RUN_STATUSES) {
          const expectedOwner = stageTransitionOwnerFor(stage, from, to);
          for (const actor of allActors) {
            const attempt = () => requireStageTransition(stage, from, to, actor);
            if (expectedOwner !== undefined && actor === expectedOwner) {
              expect(attempt).not.toThrow();
              allowed += 1;
            } else {
              expect(attempt).toThrow(StageTransitionError);
            }
          }
        }
      }
    }
    // Every table row is allowed for exactly one actor per stage.
    expect(allowed).toBe(STAGE_TRANSITIONS.length * PIPELINE_STAGES.length);
  });

  it("has exactly one owner per (from, to) pair and no self transitions", () => {
    const seen = new Set<string>();
    for (const rule of STAGE_TRANSITIONS) {
      const key = `${rule.from}>${rule.to}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it("never leaves SUCCEEDED or SKIPPED, and only operators reopen other terminal states", () => {
    for (const rule of STAGE_TRANSITIONS) {
      expect(["SUCCEEDED", "SKIPPED"]).not.toContain(rule.from);
      if (isTerminalStageRunStatus(rule.from)) {
        expect(rule.owner).toBe(OPERATOR_RETRY_OWNER);
        expect(rule.to).toBe("PENDING");
      }
    }
  });

  it("only the stage domain owner can finish a run of that stage", () => {
    for (const stage of PIPELINE_STAGES) {
      for (const to of ["SUCCEEDED", "FAILED", "REVIEW_REQUIRED", "SKIPPED"] as const) {
        expect(() =>
          requireStageTransition(stage, "RUNNING", to, STAGE_DEFINITIONS[stage].domainOwner),
        ).not.toThrow();
        expect(() =>
          requireStageTransition(stage, "RUNNING", to, STAGE_RUNTIME_OWNER),
        ).toThrow(StageTransitionError);
        for (const other of PIPELINE_STAGES.filter((s) => s !== stage)) {
          expect(() =>
            requireStageTransition(stage, "RUNNING", to, STAGE_DEFINITIONS[other].domainOwner),
          ).toThrow(StageTransitionError);
        }
      }
    }
  });

  it("chains each stage's completion event to the next stage's request event", () => {
    for (let index = 0; index < PIPELINE_STAGES.length - 1; index += 1) {
      const current = STAGE_DEFINITIONS[PIPELINE_STAGES[index]];
      const next = STAGE_DEFINITIONS[PIPELINE_STAGES[index + 1]];
      expect(current.completionEvent).toBe(next.requestEvent);
    }
    expect(STAGE_DEFINITIONS.DISCOVERY.requestEvent).toBe("CAMPAIGN_STARTED");
    const owners = PIPELINE_STAGES.map((stage) => STAGE_DEFINITIONS[stage].domainOwner);
    expect(new Set(owners).size).toBe(PIPELINE_STAGES.length);
  });

  it("names the owner in the rejection message", () => {
    expect(() =>
      requireStageTransition("CRAWL", "RUNNING", "SUCCEEDED", "SearchService"),
    ).toThrow(/owned by CrawlStageService, not SearchService/);
    expect(() =>
      requireStageTransition("CRAWL", "SUCCEEDED", "PENDING", OPERATOR_RETRY_OWNER),
    ).toThrow(/cannot transition/);
  });
});

describe("stage input hash", () => {
  it("is independent of object key order and sensitive to value changes", () => {
    const a = computeStageInputHash({ b: 1, a: { y: [1, 2], x: "q" } });
    const b = computeStageInputHash({ a: { x: "q", y: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStageInputHash({ a: { x: "q", y: [2, 1] }, b: 1 })).not.toBe(a);
    expect(computeStageInputHash({ a: 1 })).not.toBe(computeStageInputHash({ a: "1" }));
  });

  it("ignores undefined properties and canonicalizes primitives", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson([3, { b: 1, a: 2 }])).toBe('[3,{"a":2,"b":1}]');
  });
});
