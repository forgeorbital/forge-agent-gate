import type { ConstraintResult, Decision } from "./types.js";

/**
 * Accumulates constraint results and resolves a disposition by precedence:
 * any `fail` → block, else any `escalate` → escalate, else allow.
 *
 * The trading engine keeps its own inline copy of this logic (so the trading
 * path stays byte-for-byte unchanged); the generic engine uses this shared one.
 */
export class DecisionBuilder {
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
