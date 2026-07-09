/**
 * Refunds preset - auto-approve below a ceiling, escalate above it.
 *
 * A support agent that can issue customer refunds: anything at/above the
 * auto-approve ceiling escalates to a human; a daily total caps blast radius;
 * an optional hard cap blocks absurd amounts outright.
 */

import { defaultPolicyMandate, type PolicyMandate } from "../generic/mandate.js";

export interface RefundsPresetOptions {
  /** Refunds at/above this amount escalate to a human. */
  autoApproveCeilingUsd?: number;
  /** Hard block on any single refund above this amount. */
  hardCapUsd?: number;
  maxDailyTotalUsd?: number;
}

/** Factory: a refunds policy preset (generic model). */
export function refundsPresetMandate(options: RefundsPresetOptions = {}): PolicyMandate {
  const ceiling = options.autoApproveCeilingUsd ?? 100;
  return defaultPolicyMandate({
    mandateId: `refunds-preset-${Date.now()}`,
    allowedActionTypes: ["refund"],
    maxSingleActionUsd: options.hardCapUsd ?? 2000,
    maxDailyTotalUsd: options.maxDailyTotalUsd ?? 5000,
    // Everything at/above the ceiling escalates rather than auto-executes.
    humanApprovalThresholdUsd: ceiling,
    perActionType: { refund: { humanApprovalThresholdUsd: ceiling } },
    requireApprovalForNewCounterparty: false,
    rateLimit: { maxActions: 60, windowSeconds: 60 },
  });
}
