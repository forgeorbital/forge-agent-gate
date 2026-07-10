/**
 * MCP server exposing the gateway to MCP-compatible local agent clients.
 *
 *  - Generic write-like actions (gate_action) are checked and recorded, but
 *    never executed by this MCP server. The caller's own system decides what
 *    to do with an allow. Escalate/block stops here.
 *  - Read tools (get_markets, get_market, get_positions) are safe passthroughs.
 *  - Trading write tools (place_order, cancel_order) are GATED: they run the local
 *    enforcement engine, post the Forge proof trail, and only execute on an
 *    `allow`. A block or escalate never touches the venue and is returned as a
 *    tool error so the agent cannot mistake it for a fill.
 *
 * IMPORTANT: stdout is the MCP transport. All diagnostics go to stderr.
 */

import { existsSync, readFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type AppConfig } from "./config.js";
import { GateEngine, type GateResult } from "./gate.js";
import { loadMandate, verifyMandateSignature, type Mandate } from "./mandate.js";
import { isActionType, type AgentAction } from "./generic/action.js";
import { enforceAction, type ActivitySnapshot } from "./generic/enforce.js";
import {
  parsePolicyMandate,
  verifyPolicyMandateSignature,
  type PolicyMandate,
} from "./generic/mandate.js";
import { recordGenericAction } from "./generic/forge.js";
import { tradingToPolicyMandate } from "./presets/index.js";
import type { OrderAction, OrderType, ProposedOrder } from "./venues/types.js";
import { buildAdapters } from "./venues/index.js";

const GENERIC_TOOLS: Tool[] = [
  {
    name: "gate_action",
    description:
      "Check one consequential agent action against the signed mandate and record the Forge proof trail. It returns allow, escalate, or block. It does not execute the action.",
    inputSchema: {
      type: "object",
      properties: {
        actionType: {
          type: "string",
          enum: [
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
          ],
        },
        amountUsd: { type: "number", minimum: 0 },
        counterparty: { type: "string", description: "Payee, customer, vendor, venue, account, or other party." },
        resource: { type: "string", description: "Thing being acted on, such as an invoice, ticket, endpoint, or order." },
        dailyTotalUsd: { type: "number", minimum: 0, description: "Amount already taken by this agent today." },
        knownCounterparties: {
          type: "array",
          items: { type: "string" },
          description: "Counterparties already approved or seen by this workflow.",
        },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "Non-secret context only. Do not put credentials here.",
        },
      },
      required: ["actionType"],
    },
  },
  {
    name: "gate_status",
    description:
      "Report the active mandate summary, allowed action types, kill-switch state, and whether trading venue tools are available.",
    inputSchema: { type: "object", properties: {} },
  },
];

const TRADING_TOOLS: Tool[] = [
  {
    name: "get_markets",
    description:
      "List markets on a venue (read-only passthrough). Does not place any trade.",
    inputSchema: {
      type: "object",
      properties: {
        venue: { type: "string", description: "Venue slug, e.g. 'kalshi'." },
        query: {
          type: "object",
          description: "Optional venue query params (e.g. { status: 'open', limit: 20 }).",
          additionalProperties: { type: ["string", "number"] },
        },
      },
      required: ["venue"],
    },
  },
  {
    name: "get_market",
    description: "Fetch one market by id/ticker (read-only passthrough).",
    inputSchema: {
      type: "object",
      properties: {
        venue: { type: "string" },
        marketId: { type: "string" },
      },
      required: ["venue", "marketId"],
    },
  },
  {
    name: "get_positions",
    description: "List current open positions on a venue (read-only passthrough).",
    inputSchema: {
      type: "object",
      properties: { venue: { type: "string" } },
      required: ["venue"],
    },
  },
  {
    name: "place_order",
    description:
      "Submit an order for evaluation by the local risk mandate. Executes ONLY if the mandate allows it; a block or escalate is returned without touching the venue. Every outcome is recorded to Forge as a verifiable proof trail.",
    inputSchema: {
      type: "object",
      properties: {
        venue: { type: "string" },
        marketId: { type: "string", description: "Market id / ticker." },
        action: { type: "string", enum: ["buy", "sell"] },
        side: { type: "string", description: "Venue side, e.g. 'yes' or 'no'." },
        count: { type: "integer", minimum: 1, description: "Number of contracts." },
        limitPriceUsd: {
          type: "number",
          minimum: 0,
          description: "Per-contract price in USD (a Kalshi 60c yes is 0.60).",
        },
        orderType: { type: "string", enum: ["limit", "market"] },
        marketCategory: { type: "string" },
        clientOrderId: { type: "string" },
      },
      required: ["venue", "marketId", "action", "side", "count", "limitPriceUsd"],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel a resting order. Blocked when the kill switch is engaged or the venue is not whitelisted. Recorded to Forge.",
    inputSchema: {
      type: "object",
      properties: {
        venue: { type: "string" },
        orderId: { type: "string" },
      },
      required: ["venue", "orderId"],
    },
  },
];

function toolsForMode(tradingEnabled: boolean): Tool[] {
  return tradingEnabled ? [...GENERIC_TOOLS, ...TRADING_TOOLS] : GENERIC_TOOLS;
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string, payload?: unknown): CallToolResult {
  const text = payload ? `${message}\n${JSON.stringify(payload, null, 2)}` : message;
  return { content: [{ type: "text", text }], isError: true };
}

function writeResult(result: GateResult): CallToolResult {
  const header =
    result.disposition === "allow" && result.executed
      ? "EXECUTED"
      : result.disposition === "escalate"
        ? "ESCALATED (human approval required - NOT executed)"
        : "BLOCKED (NOT executed)";
  const payload = {
    outcome: header,
    disposition: result.disposition,
    executed: result.executed,
    reasons: result.reasons,
    forgeRecordId: result.forge.recordId,
    forgeSigned: result.forge.signaturePresent,
    forgeRecordMode: result.forge.recordMode,
    forgeError: result.forge.error,
    constraintResults: result.constraintResults,
    order: result.order,
    cancel: result.cancel,
  };
  const body = { content: [{ type: "text" as const, text: `${header}\n${JSON.stringify(payload, null, 2)}` }] };
  // Non-executed writes are surfaced as tool errors so the agent cannot read
  // a block/escalate as a fill.
  return result.executed ? body : { ...body, isError: true };
}

function genericWriteResult(args: {
  decision: ReturnType<typeof enforceAction>;
  forge: Awaited<ReturnType<typeof recordGenericAction>>;
  action: AgentAction;
  recordRequired: boolean;
}): CallToolResult {
  const { decision, forge, action, recordRequired } = args;
  const forgeUnavailableBlock = recordRequired && !forge.ok;
  const disposition = forgeUnavailableBlock ? "block" : decision.disposition;
  const header =
    disposition === "allow"
      ? "ALLOWED (caller may execute)"
      : disposition === "escalate"
        ? "ESCALATED (human approval required - NOT executed)"
        : "BLOCKED (NOT executed)";
  const payload = {
    outcome: header,
    disposition,
    shouldExecute: disposition === "allow",
    action,
    reasons: forgeUnavailableBlock
      ? [
          "Forge record mode is required and the proof trail could not be recorded.",
          ...decision.reasons,
        ]
      : decision.reasons,
    forgeRecordId: forge.recordId,
    forgeSigned: forge.signaturePresent,
    forgeRecordMode: recordRequired ? "required" : "best_effort",
    forgeError: forge.error,
    constraintResults: decision.constraintResults,
  };
  const body = {
    content: [{ type: "text" as const, text: `${header}\n${JSON.stringify(payload, null, 2)}` }],
  };
  return disposition === "allow" ? body : { ...body, isError: true };
}

function toProposedOrder(args: Record<string, unknown>): ProposedOrder {
  const order: ProposedOrder = {
    venue: String(args.venue),
    marketId: String(args.marketId),
    action: String(args.action) as OrderAction,
    side: String(args.side),
    count: Number(args.count),
    limitPriceUsd: Number(args.limitPriceUsd),
  };
  if (args.orderType !== undefined) order.orderType = String(args.orderType) as OrderType;
  if (args.marketCategory !== undefined) order.marketCategory = String(args.marketCategory);
  if (args.clientOrderId !== undefined) order.clientOrderId = String(args.clientOrderId);
  return order;
}

function toAgentAction(args: Record<string, unknown>): AgentAction {
  const actionType = String(args.actionType ?? args.action_type ?? "").trim();
  if (!isActionType(actionType)) {
    throw new Error("actionType must be one of the supported Agent Gate action types");
  }
  const action: AgentAction = { actionType };
  if (args.amountUsd !== undefined) {
    const amount = Number(args.amountUsd);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("amountUsd must be a finite non-negative number");
    }
    action.amountUsd = amount;
  }
  if (args.counterparty !== undefined) action.counterparty = String(args.counterparty);
  if (args.resource !== undefined) action.resource = String(args.resource);
  if (args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) {
    action.metadata = args.metadata as Record<string, unknown>;
  }
  return action;
}

function activityFromArgs(args: Record<string, unknown>): ActivitySnapshot {
  const dailyTotalUsd = Number(args.dailyTotalUsd ?? 0);
  const known = Array.isArray(args.knownCounterparties)
    ? args.knownCounterparties.map((v) => String(v))
    : [];
  return {
    dailyTotalUsd: Number.isFinite(dailyTotalUsd) && dailyTotalUsd >= 0 ? dailyTotalUsd : 0,
    knownCounterparties: known,
  };
}

function mandateSummary(mandate: Mandate, gate: GateEngine): Record<string, unknown> {
  return {
    mandateId: mandate.mandateId,
    schemaVersion: mandate.schemaVersion,
    signatureValid: verifyMandateSignature(mandate),
    killSwitchEngaged: gate.killEngaged(),
    venueWhitelist: mandate.venueWhitelist,
    limits: {
      maxOrderNotionalUsd: mandate.maxOrderNotionalUsd,
      maxPositionPerMarketUsd: mandate.maxPositionPerMarketUsd,
      maxTotalOpenExposureUsd: mandate.maxTotalOpenExposureUsd,
      maxDailyRealizedLossUsd: mandate.maxDailyRealizedLossUsd,
      humanApprovalThresholdUsd: mandate.humanApprovalThresholdUsd,
    },
    tradingHours: mandate.tradingHours,
    marketCategoryFilters: mandate.marketCategoryFilters,
  };
}

function policySummary(args: {
  policy: PolicyMandate;
  config: AppConfig;
  signatureValid: boolean;
  tradingEnabled: boolean;
  tradingMandate?: Mandate;
  gate?: GateEngine;
}): Record<string, unknown> {
  const { policy, config, signatureValid, tradingEnabled, tradingMandate, gate } = args;
  return {
    mandateKind: tradingEnabled ? "trading+generic" : "generic",
    mandateId: policy.mandateId,
    schemaVersion: policy.schemaVersion,
    signatureValid,
    killSwitchEngaged: policy.killSwitch === true || existsSync(config.killFilePath) || Boolean(gate?.killEngaged()),
    allowedActionTypes: policy.allowedActionTypes.length ? policy.allowedActionTypes : "all supported action types",
    limits: {
      maxSingleActionUsd: policy.maxSingleActionUsd,
      maxDailyTotalUsd: policy.maxDailyTotalUsd,
      humanApprovalThresholdUsd: policy.humanApprovalThresholdUsd,
      requireApprovalForNewCounterparty: policy.requireApprovalForNewCounterparty,
      rateLimit: policy.rateLimit,
    },
    forgeRecordMode: config.forge.recordMode,
    tradingToolsAvailable: tradingEnabled,
    trading: tradingMandate && gate ? mandateSummary(tradingMandate, gate) : undefined,
  };
}

function loadMandateSet(path: string): {
  policy: PolicyMandate;
  signatureValid: boolean;
  kind: "generic" | "trading";
  tradingMandate?: Mandate;
} {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (Array.isArray(parsed.allowedActionTypes)) {
    const policy = parsePolicyMandate(raw);
    return {
      policy,
      signatureValid: verifyPolicyMandateSignature(policy),
      kind: "generic",
    };
  }
  const tradingMandate = loadMandate(path);
  return {
    policy: tradingToPolicyMandate(tradingMandate),
    signatureValid: verifyMandateSignature(tradingMandate),
    kind: "trading",
    tradingMandate,
  };
}

/** Build the MCP Server object around a ready mandate set. */
export function buildMcpServer(args: {
  config: AppConfig;
  policy: PolicyMandate;
  signatureValid: boolean;
  tradingMandate?: Mandate;
  gate?: GateEngine;
}): Server {
  const { config, policy, signatureValid, tradingMandate, gate } = args;
  const tradingEnabled = Boolean(tradingMandate && gate);
  const server = new Server(
    { name: "com.forgeorbital/agent-gate", version: "0.1.5" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsForMode(tradingEnabled) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "gate_action": {
          const action = toAgentAction(args);
          const decision = enforceAction({
            mandate: policy,
            action,
            activity: activityFromArgs(args),
            now: new Date(),
            killFileEngaged: existsSync(config.killFilePath),
          });
          const forge = await recordGenericAction(config.forge, policy, action, decision);
          return genericWriteResult({
            decision,
            forge,
            action,
            recordRequired: config.forge.recordMode === "required",
          });
        }
        case "get_markets":
          if (!gate) return err("trading venue tools require a trading mandate");
          return ok(
            await gate.getMarkets(
              String(args.venue),
              args.query as Record<string, string | number> | undefined,
            ),
          );
        case "get_market":
          if (!gate) return err("trading venue tools require a trading mandate");
          return ok(await gate.getMarket(String(args.venue), String(args.marketId)));
        case "get_positions":
          if (!gate) return err("trading venue tools require a trading mandate");
          return ok(await gate.getPositions(String(args.venue)));
        case "place_order":
          if (!gate) return err("trading venue tools require a trading mandate");
          return writeResult(await gate.placeOrder(toProposedOrder(args)));
        case "cancel_order":
          if (!gate) return err("trading venue tools require a trading mandate");
          return writeResult(
            await gate.cancelOrder(String(args.venue), String(args.orderId)),
          );
        case "gate_status":
          return ok(
            policySummary({
              policy,
              config,
              signatureValid,
              tradingEnabled,
              tradingMandate,
              gate,
            }),
          );
        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`tool "${name}" failed: ${(e as Error).message}`);
    }
  });

  return server;
}

export interface StartMcpOptions {
  config?: AppConfig;
  requireSignedMandate?: boolean;
}

/** Load config + mandate + adapters and serve the MCP over stdio. */
export async function startMcpServer(options: StartMcpOptions = {}): Promise<void> {
  const config = options.config ?? loadConfig();
  const mandateSet = loadMandateSet(config.mandatePath);

  const requireSigned = options.requireSignedMandate ?? true;
  const signatureValid = mandateSet.signatureValid;
  if (!signatureValid) {
    if (requireSigned) {
      throw new Error(
        `mandate ${config.mandatePath} is not validly signed. Sign it with \`forge-agent-gate init\` or set AGENT_GATE_REQUIRE_SIGNED_MANDATE=false to override.`,
      );
    }
    console.error(`[forge-agent-gate] WARNING: mandate signature is missing or invalid.`);
  }

  let adapters = [] as ReturnType<typeof buildAdapters>;
  let gate: GateEngine | undefined;
  if (mandateSet.tradingMandate) {
    adapters = buildAdapters(config);
    gate = new GateEngine({
      mandate: mandateSet.tradingMandate,
      forge: config.forge,
      killFilePath: config.killFilePath,
      adapters,
    });
  }

  console.error(
    `[forge-agent-gate] serving MCP over stdio | mandate=${mandateSet.policy.mandateId} | kind=${mandateSet.kind} | venues=[${adapters
      .map((a) => a.venue)
      .join(", ")}] | recordMode=${config.forge.recordMode} | killEngaged=${
      mandateSet.policy.killSwitch === true || existsSync(config.killFilePath) || Boolean(gate?.killEngaged())
    }`,
  );

  const server = buildMcpServer({
    config,
    policy: mandateSet.policy,
    signatureValid,
    tradingMandate: mandateSet.tradingMandate,
    gate,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
