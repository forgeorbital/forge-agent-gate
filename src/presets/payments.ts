/**
 * Payments preset - transfer/spend caps with new-payee approval.
 *
 * Proves the category is bigger than trading: an agent that can move money
 * (bill pay, vendor payout, payroll top-up) gated by per-transfer caps, a daily
 * ceiling, a payee allow/deny list, and mandatory human approval for any payee
 * it has never paid before.
 */

import { defaultPolicyMandate, type PolicyMandate } from "../generic/mandate.js";

export interface PaymentsPresetOptions {
  maxSingleTransferUsd?: number;
  maxDailyTotalUsd?: number;
  humanApprovalThresholdUsd?: number;
  payeeAllowlist?: string[];
  payeeDenylist?: string[];
}

/** Factory: a payments policy preset (generic model). */
export function paymentsPresetMandate(options: PaymentsPresetOptions = {}): PolicyMandate {
  return defaultPolicyMandate({
    mandateId: `payments-preset-${Date.now()}`,
    allowedActionTypes: ["transfer", "spend"],
    counterpartyAllowlist: options.payeeAllowlist ?? [],
    counterpartyDenylist: options.payeeDenylist ?? [],
    maxSingleActionUsd: options.maxSingleTransferUsd ?? 5000,
    maxDailyTotalUsd: options.maxDailyTotalUsd ?? 25000,
    humanApprovalThresholdUsd: options.humanApprovalThresholdUsd ?? 2500,
    // The defining trait of this preset: never pay a brand-new payee unattended.
    requireApprovalForNewCounterparty: true,
    rateLimit: { maxActions: 20, windowSeconds: 60 },
  });
}
