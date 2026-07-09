import { describe, expect, it } from "./testlib.js";

import type { AgentAction, ActionType } from "../src/generic/action.js";
import { enforceAction, type ActivitySnapshot } from "../src/generic/enforce.js";
import { defaultPolicyMandate, type PolicyMandate } from "../src/generic/mandate.js";
import { localTimeInZone } from "../src/time.js";
import type { Decision } from "../src/types.js";

const NOW = new Date("2026-07-08T12:00:00Z"); // Wed 12:00 UTC

function baseMandate(overrides: Partial<PolicyMandate> = {}): PolicyMandate {
  return defaultPolicyMandate({
    mandateId: "policy-test",
    allowedActionTypes: [], // empty = allow all types
    counterpartyAllowlist: [],
    counterpartyDenylist: [],
    resourceAllowlist: [],
    resourceDenylist: [],
    maxSingleActionUsd: 1000,
    maxDailyTotalUsd: 10000,
    humanApprovalThresholdUsd: 5000,
    requireApprovalForNewCounterparty: false,
    rateLimit: null,
    ...overrides,
  });
}

function baseActivity(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return { dailyTotalUsd: 0, recentActionTimestampsMs: [], knownCounterparties: [], ...overrides };
}

function baseAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return { actionType: "transfer", amountUsd: 100, counterparty: "vendor-a", ...overrides };
}

function run(
  m: Partial<PolicyMandate> = {},
  o: Partial<AgentAction> = {},
  a: Partial<ActivitySnapshot> = {},
  now: Date = NOW,
  killFileEngaged = false,
): Decision {
  return enforceAction({
    mandate: baseMandate(m),
    action: baseAction(o),
    activity: baseActivity(a),
    now,
    killFileEngaged,
  });
}

function constraint(d: Decision, name: string) {
  const found = d.constraintResults.find((r) => r.constraint === name);
  if (!found) throw new Error(`no constraint result for ${name}`);
  return found;
}

const ALL_CONSTRAINTS = [
  "action_well_formed",
  "kill_switch",
  "action_type_allowed",
  "counterparty_allow",
  "counterparty_deny",
  "resource_allow",
  "resource_deny",
  "max_single_action",
  "max_daily_total",
  "rate_limit",
  "allowed_hours",
  "new_counterparty_approval",
  "human_approval_threshold",
];

describe("generic enforce — happy path", () => {
  it("allows a clean action under all constraints", () => {
    const d = run();
    expect(d.disposition).toBe("allow");
    expect(d.reasons).toEqual([]);
  });

  it("always evaluates every constraint (record completeness)", () => {
    const d = run();
    for (const name of ALL_CONSTRAINTS) expect(constraint(d, name)).toBeTruthy();
    expect(d.constraintResults.every((r) => r.passed)).toBe(true);
  });

  it("non-financial action with no amount passes the money caps", () => {
    const d = run({}, { actionType: "approve", amountUsd: undefined, counterparty: undefined });
    expect(d.disposition).toBe("allow");
    expect(constraint(d, "max_single_action").passed).toBe(true);
  });
});

describe("generic enforce — kill switch", () => {
  it("blocks on mandate.killSwitch", () => {
    const d = run({ killSwitch: true });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "kill_switch").detail).toMatch(/mandate.killSwitch/);
  });
  it("blocks on the kill-file", () => {
    const d = run({}, {}, {}, NOW, true);
    expect(d.disposition).toBe("block");
    expect(constraint(d, "kill_switch").detail).toMatch(/kill-file/);
  });
});

describe("generic enforce — action type", () => {
  it("blocks a type outside a non-empty allow-list", () => {
    const d = run({ allowedActionTypes: ["refund"] }, { actionType: "transfer" });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "action_type_allowed").status).toBe("fail");
  });
  it("allows a type in the allow-list", () => {
    const d = run({ allowedActionTypes: ["transfer", "spend"] }, { actionType: "transfer" });
    expect(constraint(d, "action_type_allowed").passed).toBe(true);
  });
  it("blocks an explicitly disallowed type even if the allow-list is empty", () => {
    const d = run({ perActionType: { transfer: { disallowed: true } } }, { actionType: "transfer" });
    expect(d.disposition).toBe("block");
  });
});

describe("generic enforce — counterparty & resource filters", () => {
  it("blocks a counterparty outside the allow-list", () => {
    const d = run({ counterpartyAllowlist: ["vendor-a"] }, { counterparty: "vendor-b" });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "counterparty_allow").status).toBe("fail");
  });
  it("fails closed when an allow-list is set but the action has no counterparty", () => {
    const d = run({ counterpartyAllowlist: ["vendor-a"] }, { counterparty: undefined });
    expect(constraint(d, "counterparty_allow").status).toBe("fail");
  });
  it("blocks a deny-listed counterparty", () => {
    const d = run({ counterpartyDenylist: ["vendor-a"] });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "counterparty_deny").status).toBe("fail");
  });
  it("blocks a resource outside the allow-list and a deny-listed resource", () => {
    const outside = run({ resourceAllowlist: ["db-prod"] }, { resource: "db-staging" });
    expect(constraint(outside, "resource_allow").status).toBe("fail");
    const denied = run({ resourceDenylist: ["prod-firewall"] }, { resource: "prod-firewall" });
    expect(constraint(denied, "resource_deny").status).toBe("fail");
  });
});

describe("generic enforce — single-action cap", () => {
  it("allows at exactly the cap (boundary)", () => {
    const d = run({ maxSingleActionUsd: 100 }, { amountUsd: 100 });
    expect(constraint(d, "max_single_action").passed).toBe(true);
    expect(d.disposition).toBe("allow");
  });
  it("blocks one cent over the cap", () => {
    const d = run({ maxSingleActionUsd: 100 }, { amountUsd: 100.01 });
    expect(d.disposition).toBe("block");
  });
  it("applies a tighter per-action-type override", () => {
    const d = run({ perActionType: { transfer: { maxSingleActionUsd: 50 } } }, { amountUsd: 100 });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_single_action").detail).toMatch(/\$50\.00/);
  });
});

describe("generic enforce — daily total cap", () => {
  it("allows at exactly the cap (boundary)", () => {
    const d = run({ maxDailyTotalUsd: 1000 }, { amountUsd: 100 }, { dailyTotalUsd: 900 });
    expect(constraint(d, "max_daily_total").passed).toBe(true);
  });
  it("blocks over the cap", () => {
    const d = run({ maxDailyTotalUsd: 1000 }, { amountUsd: 101 }, { dailyTotalUsd: 900 });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_daily_total").status).toBe("fail");
  });
});

describe("generic enforce — rate limit", () => {
  const limit = { maxActions: 3, windowSeconds: 60 };
  it("allows below the limit", () => {
    const ts = [NOW.getTime() - 1000, NOW.getTime() - 2000];
    const d = run({ rateLimit: limit }, {}, { recentActionTimestampsMs: ts });
    expect(constraint(d, "rate_limit").passed).toBe(true);
  });
  it("blocks at the limit within the window", () => {
    const ts = [NOW.getTime() - 1000, NOW.getTime() - 2000, NOW.getTime() - 3000];
    const d = run({ rateLimit: limit }, {}, { recentActionTimestampsMs: ts });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "rate_limit").status).toBe("fail");
  });
  it("ignores timestamps older than the window", () => {
    const ts = [
      NOW.getTime() - 1000, // in window
      NOW.getTime() - 120000, // 2 min ago, outside 60s window
      NOW.getTime() - 130000,
    ];
    const d = run({ rateLimit: limit }, {}, { recentActionTimestampsMs: ts });
    expect(constraint(d, "rate_limit").passed).toBe(true);
  });
});

describe("generic enforce — allowed hours", () => {
  const hours = { tz: "UTC", windows: [{ start: "09:00", end: "17:00" }] };
  it("no restriction => pass", () => {
    expect(constraint(run(), "allowed_hours").passed).toBe(true);
  });
  it("inside the window => allow", () => {
    const d = run({ allowedHours: hours }, {}, {}, new Date("2026-07-08T12:00:00Z"));
    expect(constraint(d, "allowed_hours").passed).toBe(true);
  });
  it("outside the window => block", () => {
    const d = run({ allowedHours: hours }, {}, {}, new Date("2026-07-08T20:00:00Z"));
    expect(d.disposition).toBe("block");
  });
  it("fails closed on an invalid timezone", () => {
    const d = run({ allowedHours: { tz: "Not/AZone", windows: [{ start: "00:00", end: "23:59" }] } });
    expect(constraint(d, "allowed_hours").status).toBe("fail");
  });
  it("fails closed on a malformed window", () => {
    const d = run({ allowedHours: { tz: "UTC", windows: [{ start: "9", end: "17" }] } });
    expect(constraint(d, "allowed_hours").status).toBe("fail");
  });
});

describe("generic enforce — new counterparty", () => {
  it("escalates an unknown counterparty when approval is required", () => {
    const d = run({ requireApprovalForNewCounterparty: true }, { counterparty: "new-vendor" }, { knownCounterparties: ["vendor-a"] });
    expect(d.disposition).toBe("escalate");
    expect(constraint(d, "new_counterparty_approval").status).toBe("escalate");
  });
  it("allows a known counterparty", () => {
    const d = run({ requireApprovalForNewCounterparty: true }, { counterparty: "vendor-a" }, { knownCounterparties: ["vendor-a"] });
    expect(d.disposition).toBe("allow");
  });
  it("does not escalate when the flag is off", () => {
    const d = run({ requireApprovalForNewCounterparty: false }, { counterparty: "totally-new" });
    expect(constraint(d, "new_counterparty_approval").passed).toBe(true);
  });
});

describe("generic enforce — human approval threshold", () => {
  it("escalates at exactly the threshold (boundary)", () => {
    const d = run({ humanApprovalThresholdUsd: 100 }, { amountUsd: 100 });
    expect(d.disposition).toBe("escalate");
  });
  it("allows just below the threshold", () => {
    const d = run({ humanApprovalThresholdUsd: 100.01 }, { amountUsd: 100 });
    expect(d.disposition).toBe("allow");
  });
  it("0 disables escalation", () => {
    const d = run({ humanApprovalThresholdUsd: 0, maxSingleActionUsd: 1e9, maxDailyTotalUsd: 1e9 }, { amountUsd: 999999 });
    expect(d.disposition).toBe("allow");
  });
  it("applies a per-action-type threshold override", () => {
    const d = run({ humanApprovalThresholdUsd: 5000, perActionType: { transfer: { humanApprovalThresholdUsd: 50 } } }, { amountUsd: 100 });
    expect(d.disposition).toBe("escalate");
  });
});

describe("generic enforce — precedence", () => {
  it("a block wins over an escalate", () => {
    const d = run({ maxSingleActionUsd: 10, humanApprovalThresholdUsd: 10 }, { amountUsd: 100 });
    expect(d.disposition).toBe("block");
  });
  it("escalate only when nothing fails", () => {
    const d = run({ humanApprovalThresholdUsd: 10 }, { amountUsd: 100 });
    expect(d.disposition).toBe("escalate");
    expect(d.constraintResults.some((r) => r.status === "fail")).toBe(false);
  });
});

describe("generic enforce — malformed input fails closed", () => {
  it("unknown action type", () => {
    const d = run({}, { actionType: "frobnicate" as ActionType });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "action_well_formed").status).toBe("fail");
  });
  it("negative amount", () => {
    expect(run({}, { amountUsd: -1 }).disposition).toBe("block");
  });
  it("NaN amount", () => {
    const d = run({}, { amountUsd: Number.NaN });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "action_well_formed").status).toBe("fail");
  });
});

describe("generic enforce — weekday-scoped hours", () => {
  it("blocks a matching time on a disallowed weekday", () => {
    const local = localTimeInZone(NOW, "UTC");
    const otherDay = (local.weekday + 1) % 7;
    const d = run({ allowedHours: { tz: "UTC", windows: [{ days: [otherDay], start: "00:00", end: "23:59" }] } });
    expect(constraint(d, "allowed_hours").status).toBe("fail");
  });
});
