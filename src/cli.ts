#!/usr/bin/env node
/**
 * forge-agent-gate CLI.
 *
 *   forge-agent-gate init     interactive setup: Forge creds, workflow preset,
 *                             first signed mandate, and ready-to-paste MCP
 *                             config for a local MCP-compatible agent client.
 *   forge-agent-gate status   print the active mandate + kill-switch state.
 *   forge-agent-gate serve    run the MCP server over stdio.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { loadConfig } from "./config.js";
import type { ActionType } from "./generic/action.js";
import {
  defaultPolicyMandate,
  parsePolicyMandate,
  signPolicyMandate,
  verifyPolicyMandateSignature,
  type PolicyMandate,
} from "./generic/mandate.js";
import { startMcpServer } from "./mcp.js";
import {
  defaultMandate,
  generateMandateKeypair,
  loadMandate,
  signMandate,
  verifyMandateSignature,
  writeMandate,
  type Mandate,
  type TradingHours,
} from "./mandate.js";
import { paymentsPresetMandate, refundsPresetMandate } from "./presets/index.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  switch (command) {
    case "init":
      await runInit();
      break;
    case "status":
      runStatus();
      break;
    case "serve":
      await startMcpServer({
        requireSignedMandate:
          (process.env.AGENT_GATE_REQUIRE_SIGNED_MANDATE ?? "true").toLowerCase() !== "false",
      });
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(
    [
      "forge-agent-gate - local risk-control MCP gateway for AI agent actions",
      "",
      "Usage:",
      "  forge-agent-gate init      Interactive setup + first signed mandate + MCP config",
      "  forge-agent-gate status    Print the active mandate and kill-switch state",
      "  forge-agent-gate serve     Run the MCP server over stdio",
      "",
      "This is a risk-control gateway. It does not give trading advice, does not",
      "take custody of funds, and never sends venue keys to Forge.",
    ].join("\n"),
  );
}

function runStatus(): void {
  const config = loadConfig();
  const raw = readFileSync(config.mandatePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (Array.isArray(parsed.allowedActionTypes)) {
    const policy = parsePolicyMandate(raw);
    const killEngaged = policy.killSwitch === true || existsSync(config.killFilePath);
    console.log(
      JSON.stringify(
        {
          mandatePath: config.mandatePath,
          mandateKind: "generic",
          mandateId: policy.mandateId,
          signatureValid: verifyPolicyMandateSignature(policy),
          killSwitchEngaged: killEngaged,
          killFilePath: config.killFilePath,
          recordMode: config.forge.recordMode,
          forgeBaseUrl: config.forge.baseUrl,
          allowedActionTypes: policy.allowedActionTypes.length
            ? policy.allowedActionTypes
            : "all supported action types",
          limits: {
            maxSingleActionUsd: policy.maxSingleActionUsd,
            maxDailyTotalUsd: policy.maxDailyTotalUsd,
            humanApprovalThresholdUsd: policy.humanApprovalThresholdUsd,
            requireApprovalForNewCounterparty: policy.requireApprovalForNewCounterparty,
            rateLimit: policy.rateLimit,
          },
          allowedHours: policy.allowedHours,
        },
        null,
        2,
      ),
    );
    return;
  }
  const mandate = loadMandate(config.mandatePath);
  const killEngaged = mandate.killSwitch === true || existsSync(config.killFilePath);
  console.log(
    JSON.stringify(
      {
        mandatePath: config.mandatePath,
        mandateKind: "trading",
        mandateId: mandate.mandateId,
        signatureValid: verifyMandateSignature(mandate),
        killSwitchEngaged: killEngaged,
        killFilePath: config.killFilePath,
        recordMode: config.forge.recordMode,
        forgeBaseUrl: config.forge.baseUrl,
        venueWhitelist: mandate.venueWhitelist,
        limits: {
          maxOrderNotionalUsd: mandate.maxOrderNotionalUsd,
          maxPositionPerMarketUsd: mandate.maxPositionPerMarketUsd,
          maxTotalOpenExposureUsd: mandate.maxTotalOpenExposureUsd,
          maxDailyRealizedLossUsd: mandate.maxDailyRealizedLossUsd,
          humanApprovalThresholdUsd: mandate.humanApprovalThresholdUsd,
        },
        tradingHours: mandate.tradingHours,
      },
      null,
      2,
    ),
  );
}

type InitWorkflow = "refunds" | "payments" | "procurement" | "approvals" | "trading";

function normalizeWorkflow(raw: string): InitWorkflow {
  const value = raw.trim().toLowerCase();
  if (["payment", "payments", "pay"].includes(value)) return "payments";
  if (["refund", "refunds"].includes(value)) return "refunds";
  if (["procure", "procurement", "purchase", "purchasing"].includes(value)) return "procurement";
  if (["approval", "approvals", "approve"].includes(value)) return "approvals";
  if (["trade", "trading", "kalshi"].includes(value)) return "trading";
  return "refunds";
}

async function runInit(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    const suffix = def !== undefined ? ` [${def}]` : "";
    const answer = (await rl.question(`${q}${suffix}: `)).trim();
    return answer === "" && def !== undefined ? def : answer;
  };
  const askNum = async (q: string, def: number): Promise<number> => {
    const raw = await ask(q, String(def));
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  const askYesNo = async (q: string, def = false): Promise<boolean> => {
    const raw = (await ask(q, def ? "y" : "n")).toLowerCase();
    return raw.startsWith("y");
  };

  try {
    console.log("\nForge Agent Gate - setup\n=========================\n");
    console.log("This wizard writes .env, a signed mandate, and prints MCP config.\n");

    // --- Forge accountability layer ---
    console.log("1) Forge accountability layer (produces the proof trails)\n");
    const forgeApiKey = await ask("Forge API key (fi_...)");
    const forgeBaseUrl = await ask("Forge API base URL", "https://forgeorbital.com");
    const tenantId = await ask("Forge tenant id");
    const recordMode = (await askYesNo("Fail-closed record mode (block if Forge can't sign)?", true))
      ? "required"
      : "best_effort";
    const workflow = normalizeWorkflow(
      await ask("Workflow preset (refunds, payments, procurement, approvals, trading)", "refunds"),
    );
    const agentId = await ask("Agent id (label for this agent)", `${workflow}-agent-prod-1`);

    if (workflow !== "trading") {
      console.log("\n2) Generic mandate (no venue credentials needed)\n");
      let policy: PolicyMandate;
      if (workflow === "refunds") {
        const ceiling = await askNum("Auto-approve refunds below (USD)", 100);
        const hardCap = await askNum("Hard block any refund above (USD)", 2000);
        const daily = await askNum("Max daily refund total (USD)", 5000);
        policy = refundsPresetMandate({
          autoApproveCeilingUsd: ceiling,
          hardCapUsd: hardCap,
          maxDailyTotalUsd: daily,
        });
      } else if (workflow === "payments") {
        const single = await askNum("Max single payment or transfer (USD)", 5000);
        const daily = await askNum("Max daily payment total (USD)", 25000);
        const approval = await askNum("Human-approval threshold (USD)", 2500);
        const allowRaw = await ask("Known payees / counterparties (comma-separated, blank for none)", "");
        const payeeAllowlist = allowRaw
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== "");
        policy = paymentsPresetMandate({
          maxSingleTransferUsd: single,
          maxDailyTotalUsd: daily,
          humanApprovalThresholdUsd: approval,
          payeeAllowlist,
        });
      } else {
        const actionTypes: ActionType[] = workflow === "procurement" ? ["procure"] : ["approve"];
        const single = await askNum("Max single action value (USD)", workflow === "procurement" ? 5000 : 1000);
        const daily = await askNum("Max daily total (USD)", workflow === "procurement" ? 25000 : 10000);
        const approval = await askNum("Human-approval threshold (USD)", workflow === "procurement" ? 2500 : 500);
        const requireNew = await askYesNo("Escalate first-time counterparty/vendor/account?", true);
        policy = defaultPolicyMandate({
          mandateId: `${workflow}-preset-${Date.now()}`,
          allowedActionTypes: actionTypes,
          maxSingleActionUsd: single,
          maxDailyTotalUsd: daily,
          humanApprovalThresholdUsd: approval,
          requireApprovalForNewCounterparty: requireNew,
          rateLimit: { maxActions: 60, windowSeconds: 60 },
        });
      }

      const keypair = generateMandateKeypair();
      const signed = signPolicyMandate(policy, keypair.privateKeyPem);
      const cwd = process.cwd();
      const mandatePath = resolve(cwd, "policy_mandate.json");
      const signingKeyPath = resolve(cwd, "mandate_signing_key.pem");
      const killFilePath = resolve(cwd, ".forge-agent-gate.kill");
      writeFileSync(mandatePath, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
      writeFileSync(signingKeyPath, keypair.privateKeyPem, { mode: 0o600 });

      const envLines = [
        `FORGE_API_KEY=${forgeApiKey}`,
        `FORGE_API_BASE_URL=${forgeBaseUrl}`,
        `FORGE_TENANT_ID=${tenantId}`,
        `FORGE_RECORD_MODE=${recordMode}`,
        `AGENT_GATE_AGENT_ID=${agentId}`,
        `AGENT_GATE_MANDATE_PATH=${mandatePath}`,
        `AGENT_GATE_KILL_FILE=${killFilePath}`,
      ];
      const envPath = resolve(cwd, ".env");
      writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });

      const mcpConfig = {
        mcpServers: {
          "forge-agent-gate": {
            command: "npx",
            args: ["-y", "forge-agent-gate", "serve"],
            env: {
              FORGE_API_KEY: forgeApiKey,
              FORGE_API_BASE_URL: forgeBaseUrl,
              FORGE_TENANT_ID: tenantId,
              FORGE_RECORD_MODE: recordMode,
              AGENT_GATE_AGENT_ID: agentId,
              AGENT_GATE_MANDATE_PATH: mandatePath,
              AGENT_GATE_KILL_FILE: killFilePath,
            },
          },
        },
      };

      console.log("\nDone.\n");
      console.log(`  wrote  ${mandatePath}   (signed ${workflow} policy mandate)`);
      console.log(`  wrote  ${signingKeyPath}   (ed25519 signing key - keep private, gitignored)`);
      console.log(`  wrote  ${envPath}   (secrets - gitignored)`);
      console.log(`  signature valid: ${verifyPolicyMandateSignature(signed)}`);
      console.log("\nTo halt gated actions instantly at any time:");
      console.log(`  touch ${killFilePath}`);
      console.log("\nFirst MCP tool call: gate_action");
      console.log(
        JSON.stringify(
          {
            actionType: policy.allowedActionTypes[0] ?? "custom",
            amountUsd: Math.min(policy.humanApprovalThresholdUsd || policy.maxSingleActionUsd, policy.maxSingleActionUsd),
            counterparty: "example-counterparty",
            resource: "example-resource",
            dailyTotalUsd: 0,
          },
          null,
          2,
        ),
      );
      console.log("\n--- MCP config (paste into your client) ---");
      console.log("Paste this server entry into your local MCP-compatible agent client.\n");
      console.log(JSON.stringify(mcpConfig, null, 2));
      console.log("");
      return;
    }

    // --- Venue credentials ---
    console.log("\n2) Venue credentials (stay LOCAL - never sent to Forge)\n");
    const useKalshi = await askYesNo("Configure Kalshi?", true);
    let kalshiKeyId = "";
    let kalshiKeyPath = "";
    let kalshiEnv = "demo";
    if (useKalshi) {
      kalshiKeyId = await ask("Kalshi API Key ID");
      kalshiKeyPath = await ask("Path to Kalshi RSA private key (PEM)", "./kalshi_private_key.pem");
      kalshiEnv = (await askYesNo("Use production (else demo)?", false)) ? "prod" : "demo";
    }

    // --- Mandate ---
    console.log("\n3) First mandate (your risk policy)\n");
    const base = defaultMandate();
    const venuesRaw = await ask(
      "Allowed venues (comma-separated)",
      useKalshi ? "kalshi" : base.venueWhitelist.join(","),
    );
    const venueWhitelist = venuesRaw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== "");
    const maxOrderNotionalUsd = await askNum("Max notional per order (USD)", base.maxOrderNotionalUsd);
    const maxPositionPerMarketUsd = await askNum(
      "Max open exposure per market (USD)",
      base.maxPositionPerMarketUsd,
    );
    const maxTotalOpenExposureUsd = await askNum(
      "Max total open exposure (USD)",
      base.maxTotalOpenExposureUsd,
    );
    const maxDailyRealizedLossUsd = await askNum(
      "Daily realized-loss stop (USD)",
      base.maxDailyRealizedLossUsd,
    );
    const humanApprovalThresholdUsd = await askNum(
      "Human-approval threshold (USD, 0 to disable)",
      base.humanApprovalThresholdUsd,
    );

    let tradingHours: TradingHours | null = null;
    if (await askYesNo("Restrict trading hours?", false)) {
      const tz = await ask("Timezone (IANA)", "America/New_York");
      const start = await ask("Window start (HH:MM)", "09:30");
      const end = await ask("Window end (HH:MM)", "16:00");
      const weekdaysOnly = await askYesNo("Weekdays only (Mon-Fri)?", true);
      tradingHours = {
        tz,
        windows: [weekdaysOnly ? { days: [1, 2, 3, 4, 5], start, end } : { start, end }],
      };
    }

    const denyRaw = await ask("Deny market categories (comma-separated, blank for none)", "");
    const deny = denyRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");

    const mandate: Mandate = {
      ...base,
      venueWhitelist,
      marketCategoryFilters: deny.length > 0 ? { deny } : {},
      maxOrderNotionalUsd,
      maxPositionPerMarketUsd,
      maxTotalOpenExposureUsd,
      maxDailyRealizedLossUsd,
      humanApprovalThresholdUsd,
      tradingHours,
    };

    // --- Sign mandate ---
    const keypair = generateMandateKeypair();
    const signed = signMandate(mandate, keypair.privateKeyPem);
    const cwd = process.cwd();
    const mandatePath = resolve(cwd, "mandate.json");
    const signingKeyPath = resolve(cwd, "mandate_signing_key.pem");
    const killFilePath = resolve(cwd, ".forge-agent-gate.kill");
    writeMandate(mandatePath, signed);
    writeFileSync(signingKeyPath, keypair.privateKeyPem, { mode: 0o600 });

    // --- Write .env ---
    const envLines = [
      `FORGE_API_KEY=${forgeApiKey}`,
      `FORGE_API_BASE_URL=${forgeBaseUrl}`,
      `FORGE_TENANT_ID=${tenantId}`,
      `FORGE_RECORD_MODE=${recordMode}`,
      `AGENT_GATE_AGENT_ID=${agentId}`,
      `AGENT_GATE_MANDATE_PATH=${mandatePath}`,
      `AGENT_GATE_KILL_FILE=${killFilePath}`,
    ];
    if (useKalshi) {
      envLines.push(
        `KALSHI_API_KEY_ID=${kalshiKeyId}`,
        `KALSHI_PRIVATE_KEY_PATH=${resolve(cwd, kalshiKeyPath)}`,
        `KALSHI_ENV=${kalshiEnv}`,
      );
    }
    const envPath = resolve(cwd, ".env");
    writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });

    // --- MCP config ---
    const mcpEnv: Record<string, string> = {
      FORGE_API_KEY: forgeApiKey,
      FORGE_API_BASE_URL: forgeBaseUrl,
      FORGE_TENANT_ID: tenantId,
      FORGE_RECORD_MODE: recordMode,
      AGENT_GATE_AGENT_ID: agentId,
      AGENT_GATE_MANDATE_PATH: mandatePath,
      AGENT_GATE_KILL_FILE: killFilePath,
    };
    if (useKalshi) {
      mcpEnv.KALSHI_API_KEY_ID = kalshiKeyId;
      mcpEnv.KALSHI_PRIVATE_KEY_PATH = resolve(cwd, kalshiKeyPath);
      mcpEnv.KALSHI_ENV = kalshiEnv;
    }
    const mcpConfig = {
      mcpServers: {
        "forge-agent-gate": {
          command: "npx",
          args: ["-y", "forge-agent-gate", "serve"],
          env: mcpEnv,
        },
      },
    };

    console.log("\nDone.\n");
    console.log(`  wrote  ${mandatePath}   (signed mandate)`);
    console.log(`  wrote  ${signingKeyPath}   (ed25519 signing key - keep private, gitignored)`);
    console.log(`  wrote  ${envPath}   (secrets - gitignored)`);
    console.log(`  signature valid: ${verifyMandateSignature(signed)}`);
    console.log("\nTo halt trading instantly at any time:");
    console.log(`  touch ${killFilePath}`);
    console.log("\n--- MCP config (paste into your client) ---");
    console.log("Paste this server entry into your local MCP-compatible agent client.\n");
    console.log(JSON.stringify(mcpConfig, null, 2));
    console.log("");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`[forge-agent-gate] ${(err as Error).message}`);
  process.exit(1);
});
