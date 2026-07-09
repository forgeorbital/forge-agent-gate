/**
 * Action-type-agnostic representation of an economically consequential thing an
 * AI agent is about to do. Trading is one `actionType` among many - the same
 * shape covers payments, refunds, procurement, underwriting, claims, account
 * actions, security actions, and workflow approvals.
 */

export type ActionType =
  | "spend"
  | "transfer"
  | "approve"
  | "refund"
  | "procure"
  | "submit"
  | "trade"
  | "escalate"
  | "isolate"
  | "custom";

/** The full set of recognized action types (for validation / iteration). */
export const ACTION_TYPES: readonly ActionType[] = [
  "spend",
  "transfer",
  "approve",
  "refund",
  "procure",
  "submit",
  "trade",
  "escalate",
  "isolate",
  "custom",
];

/**
 * A proposed agent action. `amountUsd` is the economic magnitude when the
 * action moves money; non-financial actions (approve/isolate/submit) may omit
 * it. `counterparty` is who/what is on the other side (payee, vendor, venue,
 * account); `resource` is the thing being acted on (endpoint, host, ticket).
 */
export interface AgentAction {
  actionType: ActionType;
  amountUsd?: number;
  counterparty?: string;
  resource?: string;
  /** Free-form, non-secret context. Never put credentials here. */
  metadata?: Record<string, unknown>;
}

/** True if `value` is a recognized ActionType. */
export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}
