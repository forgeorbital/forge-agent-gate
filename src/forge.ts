/**
 * Forge client - the accountability / moat layer.
 *
 * Every local decision (allow AND block AND escalate) is posted to the Forge
 * decision API as an agentic event. Forge returns a replayable proof-trail
 * result for the customer's archive. The Forge call NEVER relaxes a
 * local block; it only produces the proof trail. The one way Forge affects
 * execution is fail-closed record mode: if `recordMode` is "required" and the
 * record cannot be written, the gate converts an allow into a block.
 *
 * The request shape matches the Forge `AgenticEventRequest` contract exactly
 * (see docs/openapi.latest.json → components.schemas.AgenticEventRequest and
 * core/decision_engine/agentic_event_packet.py in the Forge repo).
 */

import { sha256HexOfJson } from "./canonical.js";
import type { Mandate } from "./mandate.js";
import type { Decision } from "./types.js";
import type { ProposedOrder } from "./venues/types.js";
import { orderNotionalUsd } from "./enforce.js";

export type RecordMode = "required" | "best_effort";

export interface ForgeConfig {
  baseUrl: string;
  /** X-API-Key value (fi_...). One of apiKey / bearerToken is required. */
  apiKey?: string;
  /** Authorization: Bearer <jwt> value. */
  bearerToken?: string;
  recordMode: RecordMode;
  timeoutMs?: number;
  tenantId: string;
  agentId: string;
  agentVersion?: string;
}

/** A single mandate constraint result, in Forge's constraint_results shape. */
export interface ForgeConstraintResult {
  constraint: string;
  passed: boolean;
  status: string;
  detail: string;
}

/** A policy check, in Forge's policy_checks shape. */
export interface ForgePolicyCheck {
  name: string;
  passed: boolean;
  detail: string;
  requires_human_approval?: boolean;
  approval_present?: boolean;
}

/** The exact body posted to POST /v1/agentic/events/evaluate. */
export interface AgenticEvent {
  agent_id: string;
  agent_version: string;
  tenant_id: string;
  client_id: string;
  integration_mode: "pre_action_gate";
  proposed_action: string;
  task: string;
  decision_question: string;
  decision_options: string[];
  workflow_type: string;
  policy_checks: ForgePolicyCheck[];
  constraint_results: ForgeConstraintResult[];
  required_approvals: string[];
  missing_required_approval: string[];
  blocked_actions: string[];
  human_approval_state: Record<string, unknown>;
  tools_called: Array<Record<string, unknown>>;
  data_provenance: Record<string, unknown>;
  learning_rights: Record<string, unknown>;
}

const PROCEED_FAMILIES = new Set(["proceed", "approve", "allow", "accept", "continue"]);

/**
 * Build the agentic event for a proposed order and the local decision.
 *
 * Only non-secret facts leave the machine: venue, market id, category, side,
 * count, and USD notional. Venue credentials and private keys are never
 * included. The order details are additionally hashed into data_provenance.
 */
export function buildAgenticEvent(args: {
  config: ForgeConfig;
  mandate: Mandate;
  order: ProposedOrder;
  decision: Decision;
}): AgenticEvent {
  const { config, mandate, order, decision } = args;
  const notional = orderNotionalUsd(order);
  const proposedAction = `place_order:${order.venue}:${order.action}_${order.side}`;

  const constraintResults: ForgeConstraintResult[] = decision.constraintResults.map((r) => ({
    constraint: r.constraint,
    passed: r.passed,
    status: r.status,
    detail: r.detail,
  }));

  const policyChecks: ForgePolicyCheck[] = decision.constraintResults.map((r) => ({
    name: r.constraint,
    passed: r.passed,
    detail: r.detail,
    ...(r.constraint === "human_approval_threshold"
      ? { requires_human_approval: r.status === "escalate", approval_present: false }
      : {}),
  }));

  const missingRequiredApproval =
    decision.disposition === "escalate" ? ["human_reviewer_approval"] : [];
  const blockedActions = decision.disposition === "block" ? [proposedAction] : [];

  return {
    agent_id: config.agentId,
    agent_version: config.agentVersion ?? "unknown",
    tenant_id: config.tenantId,
    client_id: config.tenantId,
    integration_mode: "pre_action_gate",
    proposed_action: proposedAction,
    task: "Gate a real-money prediction-market order against the customer risk mandate.",
    decision_question: "Should this prediction-market order be allowed, blocked, or escalated?",
    decision_options: ["allow", "escalate", "block"],
    workflow_type: "agent_pre_action_gate",
    policy_checks: policyChecks,
    constraint_results: constraintResults,
    required_approvals: mandate.humanApprovalThresholdUsd > 0 ? ["human_reviewer_approval"] : [],
    missing_required_approval: missingRequiredApproval,
    blocked_actions: blockedActions,
    human_approval_state: {
      threshold_usd: mandate.humanApprovalThresholdUsd,
      order_notional_usd: notional,
      approval_required: decision.disposition === "escalate",
      approval_present: false,
    },
    tools_called: [
      {
        tool: `venue:${order.venue}`,
        detail: `${order.action} ${order.side} x${order.count} on ${order.marketId} @ $${order.limitPriceUsd.toFixed(
          2,
        )} (notional $${notional.toFixed(2)})`,
      },
    ],
    data_provenance: {
      local_decision: decision.disposition,
      mandate_id: mandate.mandateId,
      venue: order.venue,
      market_id: order.marketId,
      order_notional_usd: notional,
      order_sha256: sha256HexOfJson({
        venue: order.venue,
        marketId: order.marketId,
        action: order.action,
        side: order.side,
        count: order.count,
        limitPriceUsd: order.limitPriceUsd,
      }),
      raw_credentials_sent_to_forge: false,
    },
    learning_rights: {
      learning_mode: "evaluation_metrics_only",
      raw_payload_retention: "none",
    },
  };
}

export interface ForgeRecordResult {
  ok: boolean;
  recordId: string | null;
  selectedAction: string | null;
  /** True if the returned selected action is in the proceed/allow family. */
  forgeAgreesProceed: boolean | null;
  signaturePresent: boolean;
  status: number | null;
  error?: string;
  raw?: unknown;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Extract record id / selected action / signature presence from a response. */
export function extractForgeRecord(response: unknown): {
  recordId: string | null;
  selectedAction: string | null;
  signaturePresent: boolean;
} {
  const root = asRecord(response);
  const record = asRecord(root.record);
  const partner = asRecord(root.partner_response);
  const recordId = firstString(record.record_id, root.record_id, record.id);
  const selectedAction = firstString(
    record.selected_action,
    record.disposition,
    partner.selected_action,
    partner.disposition,
    root.selected_action,
    root.disposition,
  );
  const signaturePresent = Boolean(
    record.signature ||
      record.signature_b64 ||
      asRecord(record.envelope).signature ||
      root.signature,
  );
  return {
    recordId,
    selectedAction: selectedAction ? selectedAction.toLowerCase() : null,
    signaturePresent,
  };
}

function isProceedFamily(action: string | null): boolean | null {
  if (!action) return null;
  const slug = action.trim().toLowerCase().replace(/-/g, "_");
  if (PROCEED_FAMILIES.has(slug)) return true;
  return slug.startsWith("proceed") || slug.startsWith("allow") || slug.startsWith("approve");
}

/**
 * Post an agentic event to Forge and return the proof-trail result.
 * Never throws: any transport or HTTP error becomes `ok: false` so callers can
 * apply the fail-closed record-mode policy.
 */
export async function postAgenticEvent(
  config: ForgeConfig,
  event: AgenticEvent,
): Promise<ForgeRecordResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/agentic/events/evaluate`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "forge-agent-gate/0.1.0",
  };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  else if (config.bearerToken) headers["authorization"] = `Bearer ${config.bearerToken}`;
  else {
    return {
      ok: false,
      recordId: null,
      selectedAction: null,
      forgeAgreesProceed: null,
      signaturePresent: false,
      status: null,
      error: "no Forge credential configured (FORGE_API_KEY or FORGE_BEARER_TOKEN)",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      return {
        ok: false,
        recordId: null,
        selectedAction: null,
        forgeAgreesProceed: null,
        signaturePresent: false,
        status: res.status,
        error: `Forge returned HTTP ${res.status}: ${text.slice(0, 500)}`,
        raw: parsed,
      };
    }
    const extracted = extractForgeRecord(parsed);
    return {
      ok: true,
      recordId: extracted.recordId,
      selectedAction: extracted.selectedAction,
      forgeAgreesProceed: isProceedFamily(extracted.selectedAction),
      signaturePresent: extracted.signaturePresent,
      status: res.status,
      raw: parsed,
    };
  } catch (err) {
    return {
      ok: false,
      recordId: null,
      selectedAction: null,
      forgeAgreesProceed: null,
      signaturePresent: false,
      status: null,
      error: `Forge unreachable: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
