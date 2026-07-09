/**
 * forge-agent-gate - a local, deterministic mandate gate / risk firewall for AI
 * agents that can take economically consequential actions: spend, transfer,
 * approve, refund, procure, trade, submit, escalate, and more. Every decision
 * (allow AND block) is also sent to Forge for a verifiable proof trail.
 *
 * Trading against prediction-market venues is the first fully-wired vertical;
 * the generic layer below covers the rest of the category.
 *
 * This is a risk-control gateway. It never gives trading advice, never takes
 * custody of funds, and never holds venue keys anywhere but the local process.
 */

export * from "./types.js";
export * from "./enforce.js";
export * from "./mandate.js";
export * from "./forge.js";
export * from "./gate.js";
export * from "./config.js";
export { isKillFileEngaged } from "./killswitch.js";
export { DecisionBuilder } from "./decision.js";
export * from "./time.js";
export * from "./venues/index.js";

// Generic, action-type-agnostic category layer + vertical presets.
export * as generic from "./generic/index.js";
export * as presets from "./presets/index.js";
