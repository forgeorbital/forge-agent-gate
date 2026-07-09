/**
 * Trading preset - expresses the trading vertical in the generic model.
 *
 * The native trading path (`src/enforce.ts` + venue adapters) remains the
 * authoritative engine for venue-specific exposure math. This preset is the
 * category-level PROJECTION of a trading mandate onto the generic
 * `PolicyMandate`, so trading interops with payments, refunds, and every other
 * vertical under one firewall and one proof-trail contract.
 */

import type { Mandate } from "../mandate.js";
import { defaultPolicyMandate, type PolicyMandate } from "../generic/mandate.js";

/**
 * Compile a trading `Mandate` down to a generic `PolicyMandate`.
 *
 * Mapping:
 *  - actionType is `trade` only
 *  - per-order notional cap  → maxSingleActionUsd
 *  - total open-exposure cap → maxDailyTotalUsd (category-level daily ceiling)
 *  - venue whitelist         → resourceAllowlist (venues are the resource)
 *  - trading hours           → allowedHours
 *  - approval threshold, kill switch carry over 1:1
 */
export function tradingToPolicyMandate(m: Mandate): PolicyMandate {
  return defaultPolicyMandate({
    mandateId: `trading:${m.mandateId}`,
    createdAt: m.createdAt,
    allowedActionTypes: ["trade"],
    resourceAllowlist: [...m.venueWhitelist],
    maxSingleActionUsd: m.maxOrderNotionalUsd,
    maxDailyTotalUsd: m.maxTotalOpenExposureUsd,
    perActionType: {
      trade: { maxSingleActionUsd: m.maxOrderNotionalUsd },
    },
    allowedHours: m.tradingHours,
    humanApprovalThresholdUsd: m.humanApprovalThresholdUsd,
    requireApprovalForNewCounterparty: false,
    killSwitch: m.killSwitch,
  });
}

/** Factory: a stand-alone trading policy preset (generic model). */
export function tradingPresetMandate(overrides: Partial<PolicyMandate> = {}): PolicyMandate {
  return defaultPolicyMandate({
    mandateId: `trading-preset-${Date.now()}`,
    allowedActionTypes: ["trade"],
    resourceAllowlist: ["kalshi"],
    maxSingleActionUsd: 100,
    maxDailyTotalUsd: 1000,
    perActionType: { trade: { maxSingleActionUsd: 100 } },
    humanApprovalThresholdUsd: 250,
    requireApprovalForNewCounterparty: false,
    rateLimit: { maxActions: 30, windowSeconds: 60 },
    ...overrides,
  });
}
