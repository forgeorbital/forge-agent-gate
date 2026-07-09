import { describe, expect, it } from "./testlib.js";

import { enforce } from "../src/enforce.js";
import { buildAgenticEvent, extractForgeRecord, postAgenticEvent, type ForgeConfig } from "../src/forge.js";
import { defaultMandate } from "../src/mandate.js";
import type { ProposedOrder } from "../src/venues/types.js";

const config: ForgeConfig = {
  baseUrl: "https://forgeorbital.com",
  apiKey: "fi_test",
  recordMode: "required",
  tenantId: "tenant-x",
  agentId: "agent-x",
  agentVersion: "9.9",
};

const order: ProposedOrder = {
  venue: "kalshi",
  marketId: "MKT-1",
  action: "buy",
  side: "yes",
  count: 100,
  limitPriceUsd: 0.5, // notional 50
};

function decisionFor(mandateOverrides = {}) {
  const mandate = defaultMandate({ venueWhitelist: ["kalshi"], ...mandateOverrides });
  return {
    mandate,
    decision: enforce({
      mandate,
      order,
      account: { positions: [], totalOpenExposureUsd: 0, dailyRealizedPnlUsd: 0 },
      now: new Date("2026-07-08T12:00:00Z"),
    }),
  };
}

describe("buildAgenticEvent — Forge contract", () => {
  it("uses integration_mode pre_action_gate and a proposed_action", () => {
    const { mandate, decision } = decisionFor({ maxOrderNotionalUsd: 1000, humanApprovalThresholdUsd: 0 });
    const event = buildAgenticEvent({ config, mandate, order, decision });
    expect(event.integration_mode).toBe("pre_action_gate");
    expect(event.proposed_action).toBe("place_order:kalshi:buy_yes");
    expect(event.agent_id).toBe("agent-x");
    expect(event.tenant_id).toBe("tenant-x");
    expect(event.client_id).toBe("tenant-x");
    expect(event.workflow_type).toBe("agent_pre_action_gate");
  });

  it("maps constraint results into the Forge constraint_results shape", () => {
    const { mandate, decision } = decisionFor({ maxOrderNotionalUsd: 1000, humanApprovalThresholdUsd: 0 });
    const event = buildAgenticEvent({ config, mandate, order, decision });
    expect(event.constraint_results.length).toBe(decision.constraintResults.length);
    for (const c of event.constraint_results) {
      expect(c).toHaveProperty("constraint");
      expect(c).toHaveProperty("passed");
      expect(c).toHaveProperty("status");
      expect(c).toHaveProperty("detail");
    }
  });

  it("populates blocked_actions on a block", () => {
    const { mandate, decision } = decisionFor({ maxOrderNotionalUsd: 1 }); // notional 50 > 1 -> block
    expect(decision.disposition).toBe("block");
    const event = buildAgenticEvent({ config, mandate, order, decision });
    expect(event.blocked_actions).toEqual(["place_order:kalshi:buy_yes"]);
    expect(event.missing_required_approval).toEqual([]);
  });

  it("populates missing_required_approval on an escalate", () => {
    const { mandate, decision } = decisionFor({ humanApprovalThresholdUsd: 10 }); // notional 50 >= 10 -> escalate
    expect(decision.disposition).toBe("escalate");
    const event = buildAgenticEvent({ config, mandate, order, decision });
    expect(event.missing_required_approval).toEqual(["human_reviewer_approval"]);
    expect(event.human_approval_state.approval_required).toBe(true);
    expect(event.human_approval_state.order_notional_usd).toBe(50);
  });

  it("never includes venue credentials or raw keys", () => {
    const { mandate, decision } = decisionFor();
    const event = buildAgenticEvent({ config, mandate, order, decision });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/PRIVATE KEY/);
    expect(serialized).not.toMatch(/fi_test/);
    expect(event.data_provenance.raw_credentials_sent_to_forge).toBe(false);
    expect(typeof event.data_provenance.order_sha256).toBe("string");
  });
});

describe("extractForgeRecord", () => {
  it("reads record.record_id / selected_action / signature", () => {
    const r = extractForgeRecord({
      record: { record_id: "rec_123", selected_action: "Proceed", signature: "abc" },
    });
    expect(r.recordId).toBe("rec_123");
    expect(r.selectedAction).toBe("proceed");
    expect(r.signaturePresent).toBe(true);
  });

  it("falls back to disposition and partner_response", () => {
    const r = extractForgeRecord({ partner_response: { disposition: "hold" } });
    expect(r.selectedAction).toBe("hold");
    expect(r.recordId).toBeNull();
    expect(r.signaturePresent).toBe(false);
  });
});

describe("postAgenticEvent — fail-closed guards", () => {
  it("returns ok:false when no credential is configured", async () => {
    const noCred: ForgeConfig = { ...config };
    delete (noCred as unknown as Record<string, unknown>).apiKey;
    const { mandate, decision } = decisionFor();
    const event = buildAgenticEvent({ config: noCred, mandate, order, decision });
    const res = await postAgenticEvent(noCred, event);
    expect(res.ok).toBe(false);
    expect(res.recordId).toBeNull();
    expect(res.error).toMatch(/credential/);
  });
});
