import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "./testlib.js";

import { enforce } from "../src/enforce.js";
import { buildGenericAgenticEvent } from "../src/generic/forge.js";
import { enforceAction } from "../src/generic/enforce.js";
import {
  defaultPolicyMandate,
  parsePolicyMandate,
  signPolicyMandate,
  validatePolicyMandate,
  verifyPolicyMandateSignature,
} from "../src/generic/mandate.js";
import type { ForgeConfig } from "../src/forge.js";
import { generateMandateKeypair, defaultMandate } from "../src/mandate.js";
import {
  paymentsPresetMandate,
  refundsPresetMandate,
  tradingPresetMandate,
  tradingToPolicyMandate,
} from "../src/presets/index.js";

const NOW = new Date("2026-07-08T12:00:00Z");
const examplesDir = resolve(process.cwd(), "src/presets/examples");

const forgeConfig: ForgeConfig = {
  baseUrl: "https://forgeorbital.com",
  apiKey: "fi_test",
  recordMode: "required",
  tenantId: "tenant-x",
  agentId: "agent-x",
};

describe("presets validate and sign", () => {
  it("every preset factory produces a valid policy mandate", () => {
    expect(validatePolicyMandate(tradingPresetMandate())).toEqual([]);
    expect(validatePolicyMandate(paymentsPresetMandate())).toEqual([]);
    expect(validatePolicyMandate(refundsPresetMandate())).toEqual([]);
  });

  it("policy mandates sign and verify with the shared ed25519 helpers", () => {
    const { privateKeyPem } = generateMandateKeypair();
    const signed = signPolicyMandate(paymentsPresetMandate(), privateKeyPem);
    expect(verifyPolicyMandateSignature(signed)).toBe(true);
    const tampered = { ...signed, maxSingleActionUsd: 9_999_999 };
    expect(verifyPolicyMandateSignature(tampered)).toBe(false);
  });

  it("example mandate JSON files parse and validate", () => {
    for (const name of ["trading", "payments", "refunds"]) {
      const text = readFileSync(resolve(examplesDir, `${name}.mandate.json`), "utf8");
      const parsed = parsePolicyMandate(text);
      expect(validatePolicyMandate(parsed)).toEqual([]);
    }
  });
});

describe("trading interop with the generic model", () => {
  it("compiles a trading mandate to an equivalent policy mandate", () => {
    const trading = defaultMandate({
      venueWhitelist: ["kalshi"],
      maxOrderNotionalUsd: 100,
      maxTotalOpenExposureUsd: 1000,
      humanApprovalThresholdUsd: 250,
    });
    const policy = tradingToPolicyMandate(trading);
    expect(policy.allowedActionTypes).toEqual(["trade"]);
    expect(policy.resourceAllowlist).toEqual(["kalshi"]);
    expect(policy.maxSingleActionUsd).toBe(100);
    expect(policy.maxDailyTotalUsd).toBe(1000);
    expect(policy.humanApprovalThresholdUsd).toBe(250);
    expect(validatePolicyMandate(policy)).toEqual([]);
  });

  it("the compiled trading policy and native engine agree on a clean trade allow", () => {
    const trading = defaultMandate({ venueWhitelist: ["kalshi"], humanApprovalThresholdUsd: 0 });
    const nativeDecision = enforce({
      mandate: trading,
      order: { venue: "kalshi", marketId: "MKT-1", action: "buy", side: "yes", count: 10, limitPriceUsd: 0.5 },
      account: { positions: [], totalOpenExposureUsd: 0, dailyRealizedPnlUsd: 0 },
      now: NOW,
    });
    const genericDecision = enforceAction({
      mandate: tradingToPolicyMandate(defaultMandate({ venueWhitelist: ["kalshi"], humanApprovalThresholdUsd: 0 })),
      action: { actionType: "trade", amountUsd: 5, resource: "kalshi", counterparty: "kalshi" },
      activity: { dailyTotalUsd: 0 },
      now: NOW,
    });
    expect(nativeDecision.disposition).toBe("allow");
    expect(genericDecision.disposition).toBe("allow");
  });
});

describe("payments & refunds behavior", () => {
  it("payments preset escalates a brand-new payee", () => {
    const d = enforceAction({
      mandate: paymentsPresetMandate(),
      action: { actionType: "transfer", amountUsd: 500, counterparty: "brand-new-llc" },
      activity: { dailyTotalUsd: 0, knownCounterparties: ["known-vendor"] },
      now: NOW,
    });
    expect(d.disposition).toBe("escalate");
  });

  it("refunds preset auto-approves below the ceiling and escalates at/above it", () => {
    const mandate = refundsPresetMandate({ autoApproveCeilingUsd: 100 });
    const below = enforceAction({
      mandate,
      action: { actionType: "refund", amountUsd: 40, counterparty: "cust-1" },
      activity: { dailyTotalUsd: 0 },
      now: NOW,
    });
    const atCeiling = enforceAction({
      mandate,
      action: { actionType: "refund", amountUsd: 100, counterparty: "cust-2" },
      activity: { dailyTotalUsd: 0 },
      now: NOW,
    });
    expect(below.disposition).toBe("allow");
    expect(atCeiling.disposition).toBe("escalate");
  });
});

describe("generic Forge payload", () => {
  it("builds a pre_action_gate event with an actionType:target label and no secrets", () => {
    const mandate = paymentsPresetMandate();
    const action = { actionType: "transfer" as const, amountUsd: 500, counterparty: "vendor-x" };
    const decision = enforceAction({ mandate, action, activity: { dailyTotalUsd: 0 }, now: NOW });
    const event = buildGenericAgenticEvent({ config: forgeConfig, mandate, action, decision });
    expect(event.integration_mode).toBe("pre_action_gate");
    expect(event.proposed_action).toBe("transfer:vendor-x");
    expect(event.human_approval_state.action_magnitude_usd).toBe(500);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/fi_test/);
    expect(serialized).not.toMatch(/PRIVATE KEY/);
    expect(event.data_provenance.raw_credentials_sent_to_forge).toBe(false);
  });
});
