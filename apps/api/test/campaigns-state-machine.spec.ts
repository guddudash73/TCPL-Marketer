import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_STATES,
  canTransitionCampaign,
  requireCampaignTransition,
  type CampaignState,
} from '../src/campaigns/campaign-state-machine.js';

const expectedTransitions: Record<CampaignState, CampaignState[]> = {
  DRAFT: ['STARTING', 'STOPPED'],
  STARTING: ['RUNNING', 'FAILED', 'STOPPED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'STOPPED', 'FAILED'],
  PAUSED: ['RUNNING', 'STOPPED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: ['STARTING', 'STOPPED'],
};

describe('campaign state machine', () => {
  it('permits only the documented lifecycle transitions', () => {
    for (const from of CAMPAIGN_STATES) {
      for (const to of CAMPAIGN_STATES) {
        expect(canTransitionCampaign(from, to), `${from} -> ${to}`).toBe(expectedTransitions[from].includes(to));
      }
    }
  });

  it('rejects self-transitions and terminal-state transitions', () => {
    for (const state of CAMPAIGN_STATES) {
      expect(() => requireCampaignTransition(state, state)).toThrow(`Campaign cannot transition from ${state} to ${state}`);
    }
    expect(() => requireCampaignTransition('COMPLETED', 'RUNNING')).toThrow();
    expect(() => requireCampaignTransition('STOPPED', 'STARTING')).toThrow();
  });

  it('accepts valid pause and resume transitions', () => {
    expect(() => requireCampaignTransition('RUNNING', 'PAUSED')).not.toThrow();
    expect(() => requireCampaignTransition('PAUSED', 'RUNNING')).not.toThrow();
  });
});
