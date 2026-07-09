/**
 * Generic, action-type-agnostic policy mandate.
 *
 * This is the category-level policy: the constraints apply to any consequential
 * agent action, not just trades. Signing reuses the exact ed25519 helpers from
 * `../mandate.js` (one crypto path, no duplication). Trading-hours reuse the
 * tz-aware `TradingHours` shape and `../time.js`.
 */

import {
  type MandateSignature,
  type TradingHours,
  MANDATE_SCHEMA_VERSION,
  signDocument,
  verifyDocumentSignature,
} from "../mandate.js";
import { ACTION_TYPES, isActionType, type ActionType } from "./action.js";

export { MANDATE_SCHEMA_VERSION } from "../mandate.js";

/** Max number of consequential actions allowed within a rolling window. */
export interface RateLimit {
  maxActions: number;
  windowSeconds: number;
}

/** Per-action-type override of the global caps. */
export interface ActionTypePolicy {
  /** Explicitly forbid this action type regardless of the allow-list. */
  disallowed?: boolean;
  /** Override the global single-action USD cap for this type. */
  maxSingleActionUsd?: number;
  /** Override the global human-approval threshold for this type. */
  humanApprovalThresholdUsd?: number;
}

/**
 * Signed, action-agnostic risk policy. Every field is a hard boundary except
 * `humanApprovalThresholdUsd` and `requireApprovalForNewCounterparty`, which
 * escalate to a human instead of blocking.
 */
export interface PolicyMandate {
  schemaVersion: number;
  mandateId: string;
  createdAt: string;
  /** If non-empty, an action's type MUST be in this list. */
  allowedActionTypes: ActionType[];
  /** If non-empty, an action's counterparty MUST be in this list. */
  counterpartyAllowlist?: string[];
  /** A counterparty in this list is blocked. */
  counterpartyDenylist?: string[];
  /** If non-empty, an action's resource MUST be in this list. */
  resourceAllowlist?: string[];
  /** A resource in this list is blocked. */
  resourceDenylist?: string[];
  /** Max USD magnitude of a single action. */
  maxSingleActionUsd: number;
  /** Max cumulative USD across all actions in the current day. */
  maxDailyTotalUsd: number;
  /** Per-action-type overrides of the caps above. */
  perActionType?: Partial<Record<ActionType, ActionTypePolicy>>;
  /** Time-of-day restriction (tz-aware), or null for none. */
  allowedHours: TradingHours | null;
  /** Actions at/above this USD magnitude escalate to a human (0 disables). */
  humanApprovalThresholdUsd: number;
  /** Escalate any action whose counterparty has not been seen before. */
  requireApprovalForNewCounterparty: boolean;
  /** Rate limit on consequential actions, or null for none. */
  rateLimit: RateLimit | null;
  /** Master off switch. When true, every action is blocked. */
  killSwitch: boolean;
  signature?: MandateSignature;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Strictly validate an untyped object as a PolicyMandate. */
export function validatePolicyMandate(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return ["policy mandate must be a JSON object"];
  }
  const m = input as Record<string, unknown>;

  if (m.schemaVersion !== MANDATE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MANDATE_SCHEMA_VERSION}`);
  }
  if (typeof m.mandateId !== "string" || m.mandateId.trim() === "") {
    errors.push("mandateId is required");
  }
  if (typeof m.createdAt !== "string" || m.createdAt.trim() === "") {
    errors.push("createdAt is required");
  }

  if (!Array.isArray(m.allowedActionTypes)) {
    errors.push("allowedActionTypes must be an array (empty array = allow all types)");
  } else if (m.allowedActionTypes.some((t) => !isActionType(t))) {
    errors.push(`allowedActionTypes may only contain: ${ACTION_TYPES.join(", ")}`);
  }

  for (const key of [
    "counterpartyAllowlist",
    "counterpartyDenylist",
    "resourceAllowlist",
    "resourceDenylist",
  ] as const) {
    const list = m[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((v) => typeof v !== "string"))) {
      errors.push(`${key} must be an array of strings`);
    }
  }

  for (const key of ["maxSingleActionUsd", "maxDailyTotalUsd", "humanApprovalThresholdUsd"] as const) {
    if (!isFiniteNonNegative(m[key])) errors.push(`${key} must be a finite number >= 0`);
  }

  if (typeof m.requireApprovalForNewCounterparty !== "boolean") {
    errors.push("requireApprovalForNewCounterparty must be a boolean");
  }
  if (typeof m.killSwitch !== "boolean") {
    errors.push("killSwitch must be a boolean");
  }

  if (m.rateLimit !== null && m.rateLimit !== undefined) {
    const rl = m.rateLimit as Record<string, unknown>;
    if (!isFiniteNonNegative(rl.maxActions) || !Number.isInteger(rl.maxActions)) {
      errors.push("rateLimit.maxActions must be a non-negative integer");
    }
    if (!isFiniteNonNegative(rl.windowSeconds) || rl.windowSeconds === 0) {
      errors.push("rateLimit.windowSeconds must be a positive number");
    }
  }

  if (m.perActionType !== undefined) {
    if (typeof m.perActionType !== "object" || m.perActionType === null) {
      errors.push("perActionType must be an object keyed by action type");
    } else {
      for (const [type, policy] of Object.entries(m.perActionType as Record<string, unknown>)) {
        if (!isActionType(type)) errors.push(`perActionType has unknown action type "${type}"`);
        const p = policy as Record<string, unknown>;
        for (const numKey of ["maxSingleActionUsd", "humanApprovalThresholdUsd"] as const) {
          if (p[numKey] !== undefined && !isFiniteNonNegative(p[numKey])) {
            errors.push(`perActionType.${type}.${numKey} must be a finite number >= 0`);
          }
        }
      }
    }
  }

  const hours = m.allowedHours;
  if (hours !== null && hours !== undefined) {
    if (typeof hours !== "object") {
      errors.push("allowedHours must be null or an object");
    } else {
      const h = hours as Record<string, unknown>;
      if (typeof h.tz !== "string" || !isValidTimezone(h.tz)) {
        errors.push("allowedHours.tz must be a valid IANA timezone");
      }
      if (!Array.isArray(h.windows)) errors.push("allowedHours.windows must be an array");
    }
  }

  return errors;
}

/** Parse + strictly validate raw JSON text into a PolicyMandate. */
export function parsePolicyMandate(text: string): PolicyMandate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`policy mandate is not valid JSON: ${(err as Error).message}`);
  }
  const errors = validatePolicyMandate(parsed);
  if (errors.length > 0) {
    throw new Error(`invalid policy mandate:\n - ${errors.join("\n - ")}`);
  }
  return parsed as PolicyMandate;
}

/** Sign a policy mandate (reuses the shared ed25519 primitive). */
export function signPolicyMandate(mandate: PolicyMandate, privateKeyPem: string): PolicyMandate {
  return signDocument(mandate, privateKeyPem);
}

/** Verify a policy mandate's ed25519 signature. */
export function verifyPolicyMandateSignature(mandate: PolicyMandate): boolean {
  return verifyDocumentSignature(mandate);
}

/** Build a conservative default, unsigned policy mandate. */
export function defaultPolicyMandate(overrides: Partial<PolicyMandate> = {}): PolicyMandate {
  return {
    schemaVersion: MANDATE_SCHEMA_VERSION,
    mandateId: `policy-${Date.now()}`,
    createdAt: new Date().toISOString(),
    allowedActionTypes: [],
    counterpartyAllowlist: [],
    counterpartyDenylist: [],
    resourceAllowlist: [],
    resourceDenylist: [],
    maxSingleActionUsd: 1000,
    maxDailyTotalUsd: 10000,
    perActionType: {},
    allowedHours: null,
    humanApprovalThresholdUsd: 2500,
    requireApprovalForNewCounterparty: false,
    rateLimit: null,
    killSwitch: false,
    ...overrides,
  };
}
