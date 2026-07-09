/**
 * The enforcement engine - the safety-critical core.
 *
 * `enforce()` and `enforceCancel()` are PURE functions: no network, no
 * filesystem, no clocks of their own. Given a mandate, a proposed order, a
 * live account snapshot, and the current instant, they return a deterministic
 * {@link Decision}. Enforcement is LOCAL and authoritative - the customer is
 * protecting themselves from their own agent. The Forge proof trail is
 * produced separately and never relaxes a local block.
 *
 * Precedence: any constraint with status `fail` blocks. If nothing fails but a
 * constraint escalates, the disposition is `escalate`. Otherwise `allow`.
 */

import type { Mandate } from "./mandate.js";
import { isWithinAnyWindow, localTimeInZone } from "./time.js";
import type { ConstraintResult, Decision } from "./types.js";
import type { AccountState, ProposedOrder } from "./venues/types.js";

export interface EnforceInput {
  mandate: Mandate;
  order: ProposedOrder;
  account: AccountState;
  /** The current instant. Injected so the engine stays pure and testable. */
  now: Date;
  /**
   * True if the filesystem kill-file is present. The engine treats it exactly
   * like `mandate.killSwitch === true`. Passed in so the engine does no I/O.
   */
  killFileEngaged?: boolean;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Worst-case USD notional of an order (explicit override or count*price). */
export function orderNotionalUsd(order: ProposedOrder): number {
  if (typeof order.notionalUsd === "number") return order.notionalUsd;
  return order.count * order.limitPriceUsd;
}

function currentMarketExposure(account: AccountState, marketId: string): number {
  let total = 0;
  for (const position of account.positions) {
    if (position.marketId === marketId) total += position.exposureUsd;
  }
  return total;
}

class DecisionBuilder {
  private readonly results: ConstraintResult[] = [];
  private readonly reasons: string[] = [];

  pass(constraint: string, detail: string): void {
    this.results.push({ constraint, passed: true, status: "pass", detail });
  }

  fail(constraint: string, detail: string): void {
    this.results.push({ constraint, passed: false, status: "fail", detail });
    this.reasons.push(detail);
  }

  escalate(constraint: string, detail: string): void {
    this.results.push({ constraint, passed: false, status: "escalate", detail });
    this.reasons.push(detail);
  }

  build(): Decision {
    const hasFail = this.results.some((r) => r.status === "fail");
    const hasEscalate = this.results.some((r) => r.status === "escalate");
    const disposition = hasFail ? "block" : hasEscalate ? "escalate" : "allow";
    return {
      disposition,
      reasons: [...this.reasons],
      constraintResults: [...this.results],
    };
  }
}

/**
 * Evaluate a proposed order against the mandate. Every mandate field is
 * covered. All constraints are evaluated so the proof trail is complete;
 * the disposition is chosen by precedence (fail > escalate > allow).
 */
export function enforce(input: EnforceInput): Decision {
  const { mandate, order, account, now } = input;
  const b = new DecisionBuilder();

  // 1. Order is well-formed (fail-closed on any malformed field).
  const notional = orderNotionalUsd(order);
  const wellFormed =
    typeof order.venue === "string" &&
    order.venue.trim() !== "" &&
    typeof order.marketId === "string" &&
    order.marketId.trim() !== "" &&
    Number.isFinite(order.count) &&
    order.count > 0 &&
    Number.isInteger(order.count) &&
    Number.isFinite(order.limitPriceUsd) &&
    order.limitPriceUsd >= 0 &&
    Number.isFinite(notional) &&
    notional >= 0 &&
    (order.action === "buy" || order.action === "sell");
  if (wellFormed) {
    b.pass("order_well_formed", `Order is structurally valid (notional ${usd(notional)}).`);
  } else {
    b.fail("order_well_formed", "Order is malformed or has non-finite / non-positive fields.");
  }

  // 2. Kill switch (mandate flag OR filesystem kill-file) hard-blocks all writes.
  const killEngaged = mandate.killSwitch === true || input.killFileEngaged === true;
  if (killEngaged) {
    const via = mandate.killSwitch === true ? "mandate.killSwitch" : "kill-file";
    b.fail("kill_switch", `Kill switch engaged (${via}); all writes are blocked.`);
  } else {
    b.pass("kill_switch", "Kill switch not engaged.");
  }

  // 3. Venue whitelist.
  const venue = String(order.venue || "").toLowerCase();
  const whitelist = mandate.venueWhitelist.map((v) => v.toLowerCase());
  if (whitelist.includes(venue)) {
    b.pass("venue_whitelist", `Venue "${venue}" is whitelisted.`);
  } else {
    b.fail(
      "venue_whitelist",
      `Venue "${venue}" is not in the mandate whitelist [${whitelist.join(", ")}].`,
    );
  }

  // 4. Market category allow-list (if set, category must be present).
  const category = order.marketCategory?.trim();
  const allow = mandate.marketCategoryFilters.allow ?? [];
  if (allow.length === 0) {
    b.pass("market_category_allow", "No category allow-list configured.");
  } else if (category && allow.includes(category)) {
    b.pass("market_category_allow", `Category "${category}" is in the allow-list.`);
  } else {
    b.fail(
      "market_category_allow",
      `Category "${category ?? "unknown"}" is not in the allow-list [${allow.join(", ")}].`,
    );
  }

  // 5. Market category deny-list.
  const deny = mandate.marketCategoryFilters.deny ?? [];
  if (category && deny.includes(category)) {
    b.fail("market_category_deny", `Category "${category}" is in the deny-list.`);
  } else {
    b.pass("market_category_deny", "Category is not deny-listed.");
  }

  // 6. Per-order notional ceiling.
  if (notional <= mandate.maxOrderNotionalUsd) {
    b.pass(
      "max_order_notional",
      `Order notional ${usd(notional)} <= limit ${usd(mandate.maxOrderNotionalUsd)}.`,
    );
  } else {
    b.fail(
      "max_order_notional",
      `Order notional ${usd(notional)} exceeds limit ${usd(mandate.maxOrderNotionalUsd)}.`,
    );
  }

  // Buys increase exposure; sells reduce a position. The exposure ceilings
  // only gate risk-increasing (buy) orders - a sell is never blocked for
  // exceeding an exposure limit.
  const isBuy = order.action === "buy";

  // 7. Per-market open-exposure ceiling (projected after this order).
  if (!isBuy) {
    b.pass("max_position_per_market", "Sell order does not increase market exposure.");
  } else {
    const projectedMarket = currentMarketExposure(account, order.marketId) + notional;
    if (projectedMarket <= mandate.maxPositionPerMarketUsd) {
      b.pass(
        "max_position_per_market",
        `Projected market exposure ${usd(projectedMarket)} <= limit ${usd(mandate.maxPositionPerMarketUsd)}.`,
      );
    } else {
      b.fail(
        "max_position_per_market",
        `Projected market exposure ${usd(projectedMarket)} exceeds limit ${usd(mandate.maxPositionPerMarketUsd)}.`,
      );
    }
  }

  // 8. Total open-exposure ceiling (projected after this order).
  if (!isBuy) {
    b.pass("max_total_open_exposure", "Sell order does not increase total exposure.");
  } else {
    const projectedTotal = account.totalOpenExposureUsd + notional;
    if (projectedTotal <= mandate.maxTotalOpenExposureUsd) {
      b.pass(
        "max_total_open_exposure",
        `Projected total exposure ${usd(projectedTotal)} <= limit ${usd(mandate.maxTotalOpenExposureUsd)}.`,
      );
    } else {
      b.fail(
        "max_total_open_exposure",
        `Projected total exposure ${usd(projectedTotal)} exceeds limit ${usd(mandate.maxTotalOpenExposureUsd)}.`,
      );
    }
  }

  // 9. Daily realized-loss circuit breaker. Once the day's realized loss
  //    reaches the limit, new orders are blocked regardless of side.
  const realizedLoss = Math.max(0, -account.dailyRealizedPnlUsd);
  if (realizedLoss < mandate.maxDailyRealizedLossUsd) {
    b.pass(
      "max_daily_realized_loss",
      `Today's realized loss ${usd(realizedLoss)} < limit ${usd(mandate.maxDailyRealizedLossUsd)}.`,
    );
  } else {
    b.fail(
      "max_daily_realized_loss",
      `Daily realized loss ${usd(realizedLoss)} has reached limit ${usd(mandate.maxDailyRealizedLossUsd)}; blocking new orders.`,
    );
  }

  // 10. Trading hours.
  if (!mandate.tradingHours || mandate.tradingHours.windows.length === 0) {
    b.pass("trading_hours", "No trading-hours restriction configured.");
  } else {
    try {
      const local = localTimeInZone(now, mandate.tradingHours.tz);
      if (isWithinAnyWindow(local, mandate.tradingHours.windows)) {
        b.pass(
          "trading_hours",
          `Current time is within an allowed window (${mandate.tradingHours.tz}).`,
        );
      } else {
        b.fail(
          "trading_hours",
          `Current time is outside all allowed trading windows (${mandate.tradingHours.tz}).`,
        );
      }
    } catch (err) {
      // Fail-closed on any timezone / evaluation error.
      b.fail("trading_hours", `Could not evaluate trading hours: ${(err as Error).message}.`);
    }
  }

  // 11. Human-approval threshold (escalate, not block).
  const threshold = mandate.humanApprovalThresholdUsd;
  if (threshold > 0 && notional >= threshold) {
    b.escalate(
      "human_approval_threshold",
      `Order notional ${usd(notional)} is at/above the human-approval threshold ${usd(threshold)}; requires human approval.`,
    );
  } else {
    b.pass(
      "human_approval_threshold",
      threshold > 0
        ? `Order notional ${usd(notional)} is below the human-approval threshold ${usd(threshold)}.`
        : "Human-approval threshold disabled.",
    );
  }

  return b.build();
}

export interface EnforceCancelInput {
  mandate: Mandate;
  venue: string;
  now: Date;
  killFileEngaged?: boolean;
}

/**
 * Enforcement for cancel orders. Cancels reduce risk, so they are not subject
 * to notional/exposure limits - but the kill switch still hard-blocks all
 * writes and the venue must be whitelisted.
 */
export function enforceCancel(input: EnforceCancelInput): Decision {
  const b = new DecisionBuilder();

  const killEngaged = input.mandate.killSwitch === true || input.killFileEngaged === true;
  if (killEngaged) {
    const via = input.mandate.killSwitch === true ? "mandate.killSwitch" : "kill-file";
    b.fail("kill_switch", `Kill switch engaged (${via}); all writes are blocked.`);
  } else {
    b.pass("kill_switch", "Kill switch not engaged.");
  }

  const venue = String(input.venue || "").toLowerCase();
  const whitelist = input.mandate.venueWhitelist.map((v) => v.toLowerCase());
  if (whitelist.includes(venue)) {
    b.pass("venue_whitelist", `Venue "${venue}" is whitelisted.`);
  } else {
    b.fail("venue_whitelist", `Venue "${venue}" is not in the mandate whitelist.`);
  }

  return b.build();
}
