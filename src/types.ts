/**
 * Shared decision types for the enforcement engine and the Forge proof layer.
 *
 * The enforcement engine is the safety-critical core. It is a set of pure
 * functions that never touch the network, the filesystem, or venue keys.
 */

/** Final disposition for a proposed write action. */
export type Disposition = "allow" | "block" | "escalate";

/** Per-constraint status, shaped to flow into Forge's `constraint_results`. */
export type ConstraintStatus = "pass" | "fail" | "escalate";

/**
 * One evaluated mandate constraint. The shape is intentionally compatible with
 * the Forge agentic-event `constraint_results` field (which reads `name` /
 * `constraint` and `passed` / `status`) so the exact facts the local engine
 * enforced also appear in the proof trail.
 */
export interface ConstraintResult {
  /** Stable machine name of the constraint, e.g. "max_order_notional". */
  constraint: string;
  /** true when the constraint is satisfied (allow) - false for fail or escalate. */
  passed: boolean;
  /** pass | fail | escalate. `fail` blocks; `escalate` routes to a human. */
  status: ConstraintStatus;
  /** Human-readable explanation with the concrete numbers that were compared. */
  detail: string;
}

/** Deterministic output of the enforcement engine. */
export interface Decision {
  disposition: Disposition;
  /** Reasons that drove a block or escalate (empty when allowed). */
  reasons: string[];
  /** Every constraint that was evaluated, in a fixed order. */
  constraintResults: ConstraintResult[];
}
