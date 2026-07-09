import { describe, expect, it } from "./testlib.js";

import { enforce, enforceCancel, orderNotionalUsd } from "../src/enforce.js";
import type { Mandate } from "../src/mandate.js";
import { localTimeInZone } from "../src/time.js";
import type { Decision } from "../src/types.js";
import type { AccountState, ProposedOrder } from "../src/venues/types.js";

const NOW = new Date("2026-07-08T12:00:00Z"); // Wed 12:00 UTC

function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    schemaVersion: 1,
    mandateId: "m-test",
    createdAt: "2026-07-08T00:00:00Z",
    venueWhitelist: ["kalshi"],
    marketCategoryFilters: {},
    maxOrderNotionalUsd: 100,
    maxPositionPerMarketUsd: 250,
    maxTotalOpenExposureUsd: 1000,
    maxDailyRealizedLossUsd: 200,
    tradingHours: null,
    humanApprovalThresholdUsd: 1000,
    killSwitch: false,
    ...overrides,
  };
}

function baseAccount(overrides: Partial<AccountState> = {}): AccountState {
  return { positions: [], totalOpenExposureUsd: 0, dailyRealizedPnlUsd: 0, ...overrides };
}

function baseOrder(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    venue: "kalshi",
    marketId: "MKT-1",
    action: "buy",
    side: "yes",
    count: 60,
    limitPriceUsd: 0.5, // notional = $30
    ...overrides,
  };
}

function run(
  m: Partial<Mandate> = {},
  o: Partial<ProposedOrder> = {},
  a: Partial<AccountState> = {},
  now: Date = NOW,
  killFileEngaged = false,
): Decision {
  return enforce({
    mandate: baseMandate(m),
    order: baseOrder(o),
    account: baseAccount(a),
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
  "order_well_formed",
  "kill_switch",
  "venue_whitelist",
  "market_category_allow",
  "market_category_deny",
  "max_order_notional",
  "max_position_per_market",
  "max_total_open_exposure",
  "max_daily_realized_loss",
  "trading_hours",
  "human_approval_threshold",
];

describe("enforce — happy path", () => {
  it("allows a clean order under all limits", () => {
    const d = run();
    expect(d.disposition).toBe("allow");
    expect(d.reasons).toEqual([]);
  });

  it("always evaluates every constraint (record completeness)", () => {
    const d = run();
    for (const name of ALL_CONSTRAINTS) {
      expect(constraint(d, name)).toBeTruthy();
    }
    expect(d.constraintResults.every((r) => r.passed)).toBe(true);
  });

  it("emits Forge-shaped constraint results", () => {
    const c = constraint(run(), "max_order_notional");
    expect(c).toMatchObject({
      constraint: "max_order_notional",
      passed: true,
      status: "pass",
    });
    expect(typeof c.detail).toBe("string");
  });
});

describe("enforce — kill switch", () => {
  it("blocks when mandate.killSwitch is true", () => {
    const d = run({ killSwitch: true });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "kill_switch").status).toBe("fail");
    expect(d.reasons.join(" ")).toMatch(/mandate.killSwitch/);
  });

  it("blocks when the kill-file is engaged", () => {
    const d = run({}, {}, {}, NOW, true);
    expect(d.disposition).toBe("block");
    expect(constraint(d, "kill_switch").detail).toMatch(/kill-file/);
  });

  it("passes kill switch when neither is engaged", () => {
    expect(constraint(run(), "kill_switch").passed).toBe(true);
  });
});

describe("enforce — venue whitelist", () => {
  it("blocks an off-whitelist venue", () => {
    const d = run({ venueWhitelist: ["kalshi"] }, { venue: "polymarket" });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "venue_whitelist").status).toBe("fail");
  });

  it("is case-insensitive", () => {
    const d = run({ venueWhitelist: ["Kalshi"] }, { venue: "KALSHI" });
    expect(constraint(d, "venue_whitelist").passed).toBe(true);
  });
});

describe("enforce — market category filters", () => {
  it("blocks when an allow-list is set and the category is missing", () => {
    const d = run({ marketCategoryFilters: { allow: ["politics"] } }, { marketCategory: undefined });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "market_category_allow").status).toBe("fail");
  });

  it("allows a category present in the allow-list", () => {
    const d = run(
      { marketCategoryFilters: { allow: ["politics", "econ"] } },
      { marketCategory: "econ" },
    );
    expect(d.disposition).toBe("allow");
  });

  it("blocks a category present in the deny-list", () => {
    const d = run({ marketCategoryFilters: { deny: ["crypto"] } }, { marketCategory: "crypto" });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "market_category_deny").status).toBe("fail");
  });

  it("no filters configured => both category checks pass", () => {
    const d = run({}, { marketCategory: "anything" });
    expect(constraint(d, "market_category_allow").passed).toBe(true);
    expect(constraint(d, "market_category_deny").passed).toBe(true);
  });
});

describe("enforce — max order notional", () => {
  it("allows at exactly the limit (boundary)", () => {
    const d = run({ maxOrderNotionalUsd: 30 }); // notional == 30
    expect(constraint(d, "max_order_notional").passed).toBe(true);
    expect(d.disposition).toBe("allow");
  });

  it("blocks one cent over the limit", () => {
    const d = run({ maxOrderNotionalUsd: 29.99 });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_order_notional").status).toBe("fail");
  });

  it("honors an explicit notionalUsd override", () => {
    const o = baseOrder({ notionalUsd: 500 });
    expect(orderNotionalUsd(o)).toBe(500);
    const d = enforce({ mandate: baseMandate({ maxOrderNotionalUsd: 100 }), order: o, account: baseAccount(), now: NOW });
    expect(d.disposition).toBe("block");
  });
});

describe("enforce — per-market exposure", () => {
  it("allows when current + order is at the limit (boundary)", () => {
    const d = run(
      { maxPositionPerMarketUsd: 100 },
      { count: 70, limitPriceUsd: 1 }, // notional 70
      { positions: [{ marketId: "MKT-1", exposureUsd: 30 }] },
    );
    expect(constraint(d, "max_position_per_market").passed).toBe(true);
  });

  it("blocks when current + order exceeds the limit", () => {
    const d = run(
      { maxPositionPerMarketUsd: 100 },
      { count: 71, limitPriceUsd: 1 }, // notional 71
      { positions: [{ marketId: "MKT-1", exposureUsd: 30 }] },
    );
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_position_per_market").status).toBe("fail");
  });

  it("only counts exposure on the same market", () => {
    const d = run(
      { maxPositionPerMarketUsd: 50 },
      { count: 40, limitPriceUsd: 1 }, // notional 40
      { positions: [{ marketId: "OTHER", exposureUsd: 9999 }] },
    );
    expect(constraint(d, "max_position_per_market").passed).toBe(true);
  });

  it("never blocks a sell for exposure, even when already over-limit", () => {
    const d = run(
      { maxPositionPerMarketUsd: 50 },
      { action: "sell", count: 40, limitPriceUsd: 1 },
      { positions: [{ marketId: "MKT-1", exposureUsd: 9999 }] },
    );
    expect(constraint(d, "max_position_per_market").passed).toBe(true);
    expect(d.disposition).toBe("allow");
  });
});

describe("enforce — total open exposure", () => {
  it("allows at exactly the limit (boundary)", () => {
    const d = run(
      { maxTotalOpenExposureUsd: 100 },
      { count: 40, limitPriceUsd: 1 },
      { totalOpenExposureUsd: 60 },
    );
    expect(constraint(d, "max_total_open_exposure").passed).toBe(true);
  });

  it("blocks over the limit", () => {
    const d = run(
      { maxTotalOpenExposureUsd: 100 },
      { count: 41, limitPriceUsd: 1 },
      { totalOpenExposureUsd: 60 },
    );
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_total_open_exposure").status).toBe("fail");
  });

  it("does not block a sell for total exposure", () => {
    const d = run(
      { maxTotalOpenExposureUsd: 100 },
      { action: "sell", count: 999, limitPriceUsd: 1 },
      { totalOpenExposureUsd: 100 },
    );
    expect(constraint(d, "max_total_open_exposure").passed).toBe(true);
  });
});

describe("enforce — daily realized loss circuit breaker", () => {
  it("allows when the loss is below the limit", () => {
    const d = run({ maxDailyRealizedLossUsd: 200 }, {}, { dailyRealizedPnlUsd: -199.99 });
    expect(constraint(d, "max_daily_realized_loss").passed).toBe(true);
  });

  it("blocks at exactly the limit (breaker trips at the boundary)", () => {
    const d = run({ maxDailyRealizedLossUsd: 200 }, {}, { dailyRealizedPnlUsd: -200 });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "max_daily_realized_loss").status).toBe("fail");
  });

  it("blocks past the limit", () => {
    const d = run({ maxDailyRealizedLossUsd: 200 }, {}, { dailyRealizedPnlUsd: -500 });
    expect(d.disposition).toBe("block");
  });

  it("a profitable day never trips the breaker", () => {
    const d = run({ maxDailyRealizedLossUsd: 200 }, {}, { dailyRealizedPnlUsd: 5000 });
    expect(constraint(d, "max_daily_realized_loss").passed).toBe(true);
  });
});

describe("enforce — trading hours", () => {
  const hours = { tz: "UTC", windows: [{ start: "09:00", end: "17:00" }] };

  it("no restriction configured => pass", () => {
    expect(constraint(run(), "trading_hours").passed).toBe(true);
  });

  it("empty windows => pass", () => {
    const d = run({ tradingHours: { tz: "UTC", windows: [] }, humanApprovalThresholdUsd: 0 });
    expect(constraint(d, "trading_hours").passed).toBe(true);
  });

  it("inside the window => allow", () => {
    const d = run({ tradingHours: hours, humanApprovalThresholdUsd: 0 }, {}, {}, new Date("2026-07-08T12:00:00Z"));
    expect(constraint(d, "trading_hours").passed).toBe(true);
    expect(d.disposition).toBe("allow");
  });

  it("outside the window => block", () => {
    const d = run({ tradingHours: hours }, {}, {}, new Date("2026-07-08T20:00:00Z"));
    expect(d.disposition).toBe("block");
    expect(constraint(d, "trading_hours").status).toBe("fail");
  });

  it("wrap-around window (22:00-02:00) includes 23:00 and excludes 12:00", () => {
    const wrap = { tz: "UTC", windows: [{ start: "22:00", end: "02:00" }] };
    const inside = run({ tradingHours: wrap, humanApprovalThresholdUsd: 0 }, {}, {}, new Date("2026-07-08T23:00:00Z"));
    const outside = run({ tradingHours: wrap }, {}, {}, new Date("2026-07-08T12:00:00Z"));
    expect(constraint(inside, "trading_hours").passed).toBe(true);
    expect(constraint(outside, "trading_hours").passed).toBe(false);
  });

  it("weekday filter blocks a matching time on a disallowed day", () => {
    const local = localTimeInZone(NOW, "UTC");
    const otherDay = (local.weekday + 1) % 7;
    const d = run(
      { tradingHours: { tz: "UTC", windows: [{ days: [otherDay], start: "00:00", end: "23:59" }] } },
      {},
      {},
      NOW,
    );
    expect(constraint(d, "trading_hours").status).toBe("fail");
  });

  it("weekday filter allows a matching time on an allowed day", () => {
    const local = localTimeInZone(NOW, "UTC");
    const d = run(
      {
        tradingHours: { tz: "UTC", windows: [{ days: [local.weekday], start: "00:00", end: "23:59" }] },
        humanApprovalThresholdUsd: 0,
      },
      {},
      {},
      NOW,
    );
    expect(constraint(d, "trading_hours").passed).toBe(true);
  });

  it("fails closed when the timezone is invalid", () => {
    const d = run({ tradingHours: { tz: "Not/AZone", windows: [{ start: "00:00", end: "23:59" }] } });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "trading_hours").status).toBe("fail");
  });

  it("fails closed when a window has malformed bounds", () => {
    const d = run({ tradingHours: { tz: "UTC", windows: [{ start: "9am", end: "5pm" }] } });
    expect(constraint(d, "trading_hours").status).toBe("fail");
  });
});

describe("enforce — human approval threshold", () => {
  it("escalates at exactly the threshold (boundary)", () => {
    const d = run({ humanApprovalThresholdUsd: 30 }); // notional == 30
    expect(d.disposition).toBe("escalate");
    expect(constraint(d, "human_approval_threshold").status).toBe("escalate");
  });

  it("allows just below the threshold", () => {
    const d = run({ humanApprovalThresholdUsd: 30.01 });
    expect(d.disposition).toBe("allow");
  });

  it("threshold of 0 disables escalation", () => {
    const d = run(
      {
        humanApprovalThresholdUsd: 0,
        maxOrderNotionalUsd: 1e9,
        maxPositionPerMarketUsd: 1e9,
        maxTotalOpenExposureUsd: 1e9,
      },
      { count: 1000, limitPriceUsd: 0.99 }, // notional 990
    );
    expect(d.disposition).toBe("allow");
    expect(constraint(d, "human_approval_threshold").passed).toBe(true);
  });
});

describe("enforce — precedence", () => {
  it("a hard block wins over an escalate", () => {
    // Over notional (block) AND over approval threshold (escalate) -> block.
    const d = run({ maxOrderNotionalUsd: 10, humanApprovalThresholdUsd: 10 });
    expect(d.disposition).toBe("block");
  });

  it("escalate only when nothing fails", () => {
    const d = run({ humanApprovalThresholdUsd: 10 });
    expect(d.disposition).toBe("escalate");
    expect(d.constraintResults.some((r) => r.status === "fail")).toBe(false);
  });
});

describe("enforce — malformed orders fail closed", () => {
  it("count of zero", () => {
    expect(run({}, { count: 0 }).disposition).toBe("block");
  });
  it("negative price", () => {
    expect(run({}, { limitPriceUsd: -1 }).disposition).toBe("block");
  });
  it("non-integer count", () => {
    expect(run({}, { count: 1.5 }).disposition).toBe("block");
  });
  it("NaN notional override", () => {
    const d = enforce({ mandate: baseMandate(), order: baseOrder({ notionalUsd: Number.NaN }), account: baseAccount(), now: NOW });
    expect(d.disposition).toBe("block");
    expect(constraint(d, "order_well_formed").status).toBe("fail");
  });
  it("empty market id", () => {
    expect(run({}, { marketId: "" }).disposition).toBe("block");
  });
});

describe("enforceCancel", () => {
  it("allows a cancel on a whitelisted venue when kill switch is off", () => {
    const d = enforceCancel({ mandate: baseMandate(), venue: "kalshi", now: NOW });
    expect(d.disposition).toBe("allow");
  });

  it("blocks a cancel when the kill switch is engaged", () => {
    const d = enforceCancel({ mandate: baseMandate({ killSwitch: true }), venue: "kalshi", now: NOW });
    expect(d.disposition).toBe("block");
  });

  it("blocks a cancel when the kill-file is engaged", () => {
    const d = enforceCancel({ mandate: baseMandate(), venue: "kalshi", now: NOW, killFileEngaged: true });
    expect(d.disposition).toBe("block");
  });

  it("blocks a cancel on an off-whitelist venue", () => {
    const d = enforceCancel({ mandate: baseMandate(), venue: "polymarket", now: NOW });
    expect(d.disposition).toBe("block");
  });
});
