/**
 * Gate orchestrator - the impure boundary that wires the pure enforcement
 * engine to live venues and the Forge proof layer.
 *
 * Trust model: enforcement is LOCAL and authoritative. Reads pass through
 * untouched. Writes run through `enforce()`; only an `allow` executes. Every
 * decision - allow, block, or escalate - is posted to Forge for a
 * verifiable proof trail. In `required` record mode, an allow that cannot be
 * recorded is downgraded to a block (fail-closed).
 */

import { enforce, enforceCancel } from "./enforce.js";
import type { AgenticEvent, ForgeConfig, ForgeRecordResult } from "./forge.js";
import { buildAgenticEvent, postAgenticEvent } from "./forge.js";
import { isKillFileEngaged } from "./killswitch.js";
import type { Mandate } from "./mandate.js";
import type { ConstraintResult, Disposition } from "./types.js";
import type {
  ProposedOrder,
  VenueAdapter,
  VenueCancelResult,
  VenueMarket,
  VenueOrderResult,
  VenuePosition,
} from "./venues/types.js";

export interface GateForgeSummary {
  ok: boolean;
  recordId: string | null;
  signaturePresent: boolean;
  selectedAction: string | null;
  recordMode: ForgeConfig["recordMode"];
  error?: string;
}

export interface GateResult {
  action: "place_order" | "cancel_order";
  executed: boolean;
  disposition: Disposition;
  reasons: string[];
  constraintResults: ConstraintResult[];
  forge: GateForgeSummary;
  order?: VenueOrderResult;
  cancel?: VenueCancelResult;
}

export interface GateEngineOptions {
  mandate: Mandate;
  forge: ForgeConfig;
  killFilePath: string;
  adapters: VenueAdapter[];
  /** Injectable clock for testing; defaults to Date.now(). */
  now?: () => Date;
}

export class GateEngine {
  private readonly mandate: Mandate;
  private readonly forge: ForgeConfig;
  private readonly killFilePath: string;
  private readonly adapters = new Map<string, VenueAdapter>();
  private readonly now: () => Date;

  constructor(options: GateEngineOptions) {
    this.mandate = options.mandate;
    this.forge = options.forge;
    this.killFilePath = options.killFilePath;
    this.now = options.now ?? (() => new Date());
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.venue.toLowerCase(), adapter);
    }
  }

  get mandateRef(): Mandate {
    return this.mandate;
  }

  killEngaged(): boolean {
    return this.mandate.killSwitch === true || isKillFileEngaged(this.killFilePath);
  }

  private adapterFor(venue: string): VenueAdapter | undefined {
    return this.adapters.get(venue.toLowerCase());
  }

  // ---- Reads (safe passthrough) -------------------------------------------

  async getMarkets(venue: string, query?: Record<string, string | number>): Promise<VenueMarket[]> {
    return this.requireAdapter(venue).getMarkets(query);
  }

  async getMarket(venue: string, marketId: string): Promise<VenueMarket> {
    return this.requireAdapter(venue).getMarket(marketId);
  }

  async getPositions(venue: string): Promise<VenuePosition[]> {
    return this.requireAdapter(venue).getPositions();
  }

  private requireAdapter(venue: string): VenueAdapter {
    const adapter = this.adapterFor(venue);
    if (!adapter) {
      throw new Error(
        `no adapter configured for venue "${venue}". Configured: [${[...this.adapters.keys()].join(", ")}]`,
      );
    }
    return adapter;
  }

  // ---- Writes (gated) ------------------------------------------------------

  /** Evaluate an order without executing it (useful for dry-runs / previews). */
  async evaluateOrder(order: ProposedOrder): Promise<GateResult> {
    return this.runOrder(order, { execute: false });
  }

  /** Enforce, record, and - only on allow - execute the order. */
  async placeOrder(order: ProposedOrder): Promise<GateResult> {
    return this.runOrder(order, { execute: true });
  }

  private async runOrder(order: ProposedOrder, opts: { execute: boolean }): Promise<GateResult> {
    const adapter = this.adapterFor(order.venue);

    // Resolve category and account state up front. Any failure is fail-closed.
    let resolvedOrder = order;
    let accountState;
    try {
      if (adapter) {
        if (order.marketCategory === undefined) {
          const market = await adapter.getMarket(order.marketId).catch(() => undefined);
          if (market?.category) resolvedOrder = { ...order, marketCategory: market.category };
        }
        accountState = await adapter.getAccountState();
      }
    } catch (err) {
      return this.failClosed(order, `could not fetch account state: ${(err as Error).message}`);
    }

    if (!adapter) {
      return this.failClosed(order, `no adapter configured for venue "${order.venue}"`);
    }
    if (!accountState) {
      return this.failClosed(order, "account state unavailable");
    }

    const decision = enforce({
      mandate: this.mandate,
      order: resolvedOrder,
      account: accountState,
      now: this.now(),
      killFileEngaged: isKillFileEngaged(this.killFilePath),
    });

    const event = buildAgenticEvent({
      config: this.forge,
      mandate: this.mandate,
      order: resolvedOrder,
      decision,
    });
    const forgeResult = await postAgenticEvent(this.forge, event);

    // Fail-closed record mode: an allow we cannot record becomes a block.
    if (
      decision.disposition === "allow" &&
      opts.execute &&
      !forgeResult.ok &&
      this.forge.recordMode === "required"
    ) {
      return {
        action: "place_order",
        executed: false,
        disposition: "block",
        reasons: [
          `Forge proof trail could not be written and record mode is "required" (fail-closed): ${forgeResult.error ?? "unknown error"}`,
        ],
        constraintResults: decision.constraintResults,
        forge: this.summarize(forgeResult),
      };
    }

    const result: GateResult = {
      action: "place_order",
      executed: false,
      disposition: decision.disposition,
      reasons: decision.reasons,
      constraintResults: decision.constraintResults,
      forge: this.summarize(forgeResult),
    };

    if (decision.disposition === "allow" && opts.execute) {
      result.order = await adapter.placeOrder(resolvedOrder);
      result.executed = true;
    }
    return result;
  }

  /** Enforce, record, and - only on allow - execute a cancel. */
  async cancelOrder(venue: string, orderId: string): Promise<GateResult> {
    const adapter = this.adapterFor(venue);
    const decision = enforceCancel({
      mandate: this.mandate,
      venue,
      now: this.now(),
      killFileEngaged: isKillFileEngaged(this.killFilePath),
    });

    const event: AgenticEvent = {
      agent_id: this.forge.agentId,
      agent_version: this.forge.agentVersion ?? "unknown",
      tenant_id: this.forge.tenantId,
      client_id: this.forge.tenantId,
      integration_mode: "pre_action_gate",
      proposed_action: `cancel_order:${venue}:${orderId}`,
      task: "Gate a prediction-market order cancellation against the customer risk mandate.",
      decision_question: "Should this order cancellation be allowed or blocked?",
      decision_options: ["allow", "block"],
      workflow_type: "agent_pre_action_gate",
      policy_checks: decision.constraintResults.map((r) => ({
        name: r.constraint,
        passed: r.passed,
        detail: r.detail,
      })),
      constraint_results: decision.constraintResults.map((r) => ({
        constraint: r.constraint,
        passed: r.passed,
        status: r.status,
        detail: r.detail,
      })),
      required_approvals: [],
      missing_required_approval: [],
      blocked_actions: decision.disposition === "block" ? [`cancel_order:${venue}:${orderId}`] : [],
      human_approval_state: {},
      tools_called: [{ tool: `venue:${venue}`, detail: `cancel order ${orderId}` }],
      data_provenance: { local_decision: decision.disposition, venue, order_id: orderId },
      learning_rights: { learning_mode: "evaluation_metrics_only", raw_payload_retention: "none" },
    };
    const forgeResult = await postAgenticEvent(this.forge, event);

    if (
      decision.disposition === "allow" &&
      !forgeResult.ok &&
      this.forge.recordMode === "required"
    ) {
      return {
        action: "cancel_order",
        executed: false,
        disposition: "block",
        reasons: [
          `Forge proof trail could not be written and record mode is "required" (fail-closed): ${forgeResult.error ?? "unknown error"}`,
        ],
        constraintResults: decision.constraintResults,
        forge: this.summarize(forgeResult),
      };
    }

    const result: GateResult = {
      action: "cancel_order",
      executed: false,
      disposition: decision.disposition,
      reasons: decision.reasons,
      constraintResults: decision.constraintResults,
      forge: this.summarize(forgeResult),
    };

    if (decision.disposition === "allow") {
      if (!adapter) {
        return this.failClosed(
          { venue } as ProposedOrder,
          `no adapter configured for venue "${venue}"`,
          "cancel_order",
        );
      }
      result.cancel = await adapter.cancelOrder(orderId);
      result.executed = true;
    }
    return result;
  }

  private summarize(forgeResult: ForgeRecordResult): GateForgeSummary {
    const summary: GateForgeSummary = {
      ok: forgeResult.ok,
      recordId: forgeResult.recordId,
      signaturePresent: forgeResult.signaturePresent,
      selectedAction: forgeResult.selectedAction,
      recordMode: this.forge.recordMode,
    };
    if (forgeResult.error) summary.error = forgeResult.error;
    return summary;
  }

  private failClosed(
    order: ProposedOrder,
    reason: string,
    action: "place_order" | "cancel_order" = "place_order",
  ): GateResult {
    return {
      action,
      executed: false,
      disposition: "block",
      reasons: [`fail-closed: ${reason}`],
      constraintResults: [
        {
          constraint: "precondition",
          passed: false,
          status: "fail",
          detail: reason,
        },
      ],
      forge: {
        ok: false,
        recordId: null,
        signaturePresent: false,
        selectedAction: null,
        recordMode: this.forge.recordMode,
        error: "not attempted (blocked before evaluation)",
      },
    };
  }
}
