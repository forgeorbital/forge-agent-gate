/**
 * Generic enforcement engine - the action-agnostic sibling of the trading
 * `enforce.ts`, held to the same discipline:
 *
 *  - PURE: no network, no filesystem, no ambient clock.
 *  - Evaluates EVERY constraint so the proof trail is complete.
 *  - Precedence: any `fail` → block, else any `escalate` → escalate, else allow.
 *  - Fail-closed on malformed input.
 *
 * Enforcement is LOCAL and authoritative; the Forge record is produced
 * separately and never relaxes a local block.
 */

import { DecisionBuilder } from "../decision.js";
import { isWithinAnyWindow, localTimeInZone } from "../time.js";
import type { Decision } from "../types.js";
import type { AgentAction, ActionType } from "./action.js";
import { isActionType } from "./action.js";
import type { PolicyMandate } from "./mandate.js";

/** Live activity snapshot used by the generic engine. */
export interface ActivitySnapshot {
  /** Cumulative USD magnitude of consequential actions already taken today. */
  dailyTotalUsd: number;
  /** Epoch-ms timestamps of recent actions, for the rate-limit window. */
  recentActionTimestampsMs?: number[];
  /** Counterparties already seen/approved (for new-counterparty detection). */
  knownCounterparties?: string[];
}

export interface GenericEnforceInput {
  mandate: PolicyMandate;
  action: AgentAction;
  activity: ActivitySnapshot;
  /** The current instant. Injected so the engine stays pure and testable. */
  now: Date;
  /** True if the filesystem kill-file is present (engine does no I/O itself). */
  killFileEngaged?: boolean;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function effectiveSingleCap(mandate: PolicyMandate, type: ActionType): number {
  const override = mandate.perActionType?.[type]?.maxSingleActionUsd;
  return typeof override === "number" ? override : mandate.maxSingleActionUsd;
}

function effectiveApprovalThreshold(mandate: PolicyMandate, type: ActionType): number {
  const override = mandate.perActionType?.[type]?.humanApprovalThresholdUsd;
  return typeof override === "number" ? override : mandate.humanApprovalThresholdUsd;
}

/** Evaluate a proposed agent action against the generic policy mandate. */
export function enforceAction(input: GenericEnforceInput): Decision {
  const { mandate, action, activity, now } = input;
  const b = new DecisionBuilder();

  // 1. Action is well-formed (fail-closed on any malformed field).
  const amount = action.amountUsd ?? 0;
  const wellFormed =
    isActionType(action.actionType) &&
    (action.amountUsd === undefined ||
      (Number.isFinite(action.amountUsd) && action.amountUsd >= 0)) &&
    (action.counterparty === undefined || typeof action.counterparty === "string") &&
    (action.resource === undefined || typeof action.resource === "string");
  if (wellFormed) {
    b.pass("action_well_formed", `Action is structurally valid (magnitude ${usd(amount)}).`);
  } else {
    b.fail("action_well_formed", "Action is malformed or has non-finite / negative fields.");
  }

  // 2. Kill switch (mandate flag OR filesystem kill-file).
  const killEngaged = mandate.killSwitch === true || input.killFileEngaged === true;
  if (killEngaged) {
    const via = mandate.killSwitch === true ? "mandate.killSwitch" : "kill-file";
    b.fail("kill_switch", `Kill switch engaged (${via}); all actions are blocked.`);
  } else {
    b.pass("kill_switch", "Kill switch not engaged.");
  }

  // 3. Action type allowed.
  const type = action.actionType;
  const typeDisallowed = mandate.perActionType?.[type]?.disallowed === true;
  const allowList = mandate.allowedActionTypes ?? [];
  if (typeDisallowed) {
    b.fail("action_type_allowed", `Action type "${type}" is explicitly disallowed.`);
  } else if (allowList.length > 0 && !allowList.includes(type)) {
    b.fail(
      "action_type_allowed",
      `Action type "${type}" is not in the allow-list [${allowList.join(", ")}].`,
    );
  } else {
    b.pass("action_type_allowed", `Action type "${type}" is permitted.`);
  }

  // 4/5. Counterparty allow / deny.
  const counterparty = action.counterparty?.trim();
  const cpAllow = mandate.counterpartyAllowlist ?? [];
  if (cpAllow.length === 0) {
    b.pass("counterparty_allow", "No counterparty allow-list configured.");
  } else if (counterparty && cpAllow.includes(counterparty)) {
    b.pass("counterparty_allow", `Counterparty "${counterparty}" is allow-listed.`);
  } else {
    b.fail(
      "counterparty_allow",
      `Counterparty "${counterparty ?? "unknown"}" is not in the allow-list.`,
    );
  }
  const cpDeny = mandate.counterpartyDenylist ?? [];
  if (counterparty && cpDeny.includes(counterparty)) {
    b.fail("counterparty_deny", `Counterparty "${counterparty}" is deny-listed.`);
  } else {
    b.pass("counterparty_deny", "Counterparty is not deny-listed.");
  }

  // 6/7. Resource allow / deny.
  const resource = action.resource?.trim();
  const resAllow = mandate.resourceAllowlist ?? [];
  if (resAllow.length === 0) {
    b.pass("resource_allow", "No resource allow-list configured.");
  } else if (resource && resAllow.includes(resource)) {
    b.pass("resource_allow", `Resource "${resource}" is allow-listed.`);
  } else {
    b.fail("resource_allow", `Resource "${resource ?? "unknown"}" is not in the allow-list.`);
  }
  const resDeny = mandate.resourceDenylist ?? [];
  if (resource && resDeny.includes(resource)) {
    b.fail("resource_deny", `Resource "${resource}" is deny-listed.`);
  } else {
    b.pass("resource_deny", "Resource is not deny-listed.");
  }

  // 8. Single-action magnitude cap (with per-type override).
  const singleCap = effectiveSingleCap(mandate, type);
  if (amount <= singleCap) {
    b.pass("max_single_action", `Action magnitude ${usd(amount)} <= cap ${usd(singleCap)}.`);
  } else {
    b.fail("max_single_action", `Action magnitude ${usd(amount)} exceeds cap ${usd(singleCap)}.`);
  }

  // 9. Daily cumulative cap.
  const projectedDaily = activity.dailyTotalUsd + amount;
  if (projectedDaily <= mandate.maxDailyTotalUsd) {
    b.pass(
      "max_daily_total",
      `Projected daily total ${usd(projectedDaily)} <= cap ${usd(mandate.maxDailyTotalUsd)}.`,
    );
  } else {
    b.fail(
      "max_daily_total",
      `Projected daily total ${usd(projectedDaily)} exceeds cap ${usd(mandate.maxDailyTotalUsd)}.`,
    );
  }

  // 10. Rate limit over a rolling window.
  if (!mandate.rateLimit) {
    b.pass("rate_limit", "No rate limit configured.");
  } else {
    const windowStart = now.getTime() - mandate.rateLimit.windowSeconds * 1000;
    const inWindow = (activity.recentActionTimestampsMs ?? []).filter((ts) => ts >= windowStart);
    if (inWindow.length < mandate.rateLimit.maxActions) {
      b.pass(
        "rate_limit",
        `${inWindow.length} action(s) in the last ${mandate.rateLimit.windowSeconds}s < limit ${mandate.rateLimit.maxActions}.`,
      );
    } else {
      b.fail(
        "rate_limit",
        `Rate limit reached: ${inWindow.length} action(s) in the last ${mandate.rateLimit.windowSeconds}s >= limit ${mandate.rateLimit.maxActions}.`,
      );
    }
  }

  // 11. Allowed hours (reuses the tz-aware time helpers).
  if (!mandate.allowedHours || mandate.allowedHours.windows.length === 0) {
    b.pass("allowed_hours", "No time-of-day restriction configured.");
  } else {
    try {
      const local = localTimeInZone(now, mandate.allowedHours.tz);
      if (isWithinAnyWindow(local, mandate.allowedHours.windows)) {
        b.pass("allowed_hours", `Current time is within an allowed window (${mandate.allowedHours.tz}).`);
      } else {
        b.fail("allowed_hours", `Current time is outside all allowed windows (${mandate.allowedHours.tz}).`);
      }
    } catch (err) {
      b.fail("allowed_hours", `Could not evaluate allowed hours: ${(err as Error).message}.`);
    }
  }

  // 12. New-counterparty approval (escalate, not block).
  if (mandate.requireApprovalForNewCounterparty && counterparty) {
    const known = activity.knownCounterparties ?? [];
    if (known.includes(counterparty)) {
      b.pass("new_counterparty_approval", `Counterparty "${counterparty}" is already known.`);
    } else {
      b.escalate(
        "new_counterparty_approval",
        `Counterparty "${counterparty}" has not been seen before; requires human approval.`,
      );
    }
  } else {
    b.pass("new_counterparty_approval", "New-counterparty approval not required.");
  }

  // 13. Human-approval threshold (escalate, with per-type override).
  const threshold = effectiveApprovalThreshold(mandate, type);
  if (threshold > 0 && amount >= threshold) {
    b.escalate(
      "human_approval_threshold",
      `Action magnitude ${usd(amount)} is at/above the human-approval threshold ${usd(threshold)}.`,
    );
  } else {
    b.pass(
      "human_approval_threshold",
      threshold > 0
        ? `Action magnitude ${usd(amount)} is below the human-approval threshold ${usd(threshold)}.`
        : "Human-approval threshold disabled.",
    );
  }

  return b.build();
}
