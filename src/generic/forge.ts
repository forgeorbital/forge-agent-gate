/**
 * Build the Forge agentic-event payload for a generic agent action, reusing
 * the same `/v1/agentic/events/evaluate` contract and the same transport
 * (`postAgenticEvent`) as the trading path. No secrets ever leave the machine:
 * only the action type, counterparty, resource, USD magnitude, and a SHA-256
 * of the action are recorded.
 */

import { sha256HexOfJson } from "../canonical.js";
import type { AgenticEvent, ForgeConfig } from "../forge.js";
import { postAgenticEvent } from "../forge.js";
import type { Decision } from "../types.js";
import type { AgentAction } from "./action.js";
import type { PolicyMandate } from "./mandate.js";

export { postAgenticEvent } from "../forge.js";

/** Compose `proposed_action` as "<actionType>:<counterparty|resource>". */
export function proposedActionLabel(action: AgentAction): string {
  const target = action.counterparty ?? action.resource ?? "unspecified";
  return `${action.actionType}:${target}`;
}

/** Build the agentic event for a generic action + local decision. */
export function buildGenericAgenticEvent(args: {
  config: ForgeConfig;
  mandate: PolicyMandate;
  action: AgentAction;
  decision: Decision;
}): AgenticEvent {
  const { config, mandate, action, decision } = args;
  const amount = action.amountUsd ?? 0;
  const proposedAction = proposedActionLabel(action);

  const constraintResults = decision.constraintResults.map((r) => ({
    constraint: r.constraint,
    passed: r.passed,
    status: r.status,
    detail: r.detail,
  }));

  const policyChecks = decision.constraintResults.map((r) => ({
    name: r.constraint,
    passed: r.passed,
    detail: r.detail,
    ...(r.constraint === "human_approval_threshold" || r.constraint === "new_counterparty_approval"
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
    task: "Gate a consequential AI-agent action against the customer risk mandate.",
    decision_question: "Should this agent action be allowed, blocked, or escalated?",
    decision_options: ["allow", "escalate", "block"],
    workflow_type: "agent_pre_action_gate",
    policy_checks: policyChecks,
    constraint_results: constraintResults,
    required_approvals:
      mandate.humanApprovalThresholdUsd > 0 || mandate.requireApprovalForNewCounterparty
        ? ["human_reviewer_approval"]
        : [],
    missing_required_approval: missingRequiredApproval,
    blocked_actions: blockedActions,
    human_approval_state: {
      threshold_usd: mandate.humanApprovalThresholdUsd,
      action_magnitude_usd: amount,
      approval_required: decision.disposition === "escalate",
      approval_present: false,
    },
    tools_called: [
      {
        tool: `action:${action.actionType}`,
        detail: `${action.actionType}${action.counterparty ? ` -> ${action.counterparty}` : ""}${
          action.resource ? ` [${action.resource}]` : ""
        } magnitude $${amount.toFixed(2)}`,
      },
    ],
    data_provenance: {
      local_decision: decision.disposition,
      mandate_id: mandate.mandateId,
      action_type: action.actionType,
      counterparty: action.counterparty ?? null,
      resource: action.resource ?? null,
      action_magnitude_usd: amount,
      action_sha256: sha256HexOfJson({
        actionType: action.actionType,
        amountUsd: action.amountUsd ?? null,
        counterparty: action.counterparty ?? null,
        resource: action.resource ?? null,
      }),
      raw_credentials_sent_to_forge: false,
    },
    learning_rights: {
      learning_mode: "evaluation_metrics_only",
      raw_payload_retention: "none",
    },
  };
}

/** Convenience: build the event and post it to Forge in one call. */
export async function recordGenericAction(
  config: ForgeConfig,
  mandate: PolicyMandate,
  action: AgentAction,
  decision: Decision,
) {
  const event = buildGenericAgenticEvent({ config, mandate, action, decision });
  return postAgenticEvent(config, event);
}
