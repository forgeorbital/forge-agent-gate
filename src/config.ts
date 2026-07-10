import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ForgeConfig, RecordMode } from "./forge.js";
import type { KalshiConfig, KalshiEnvironment } from "./venues/kalshi.js";
import type { PmxtConfig } from "./venues/pmxt.js";

export interface AppConfig {
  forge: ForgeConfig;
  mandatePath: string;
  killFilePath: string;
  kalshi?: KalshiConfig;
  pmxt?: PmxtConfig;
}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new Error(`missing required environment variable: ${key}`);
  }
  return value.trim();
}

function opt(env: Env, key: string): string | undefined {
  const value = env[key];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function loadKalshiPrivateKey(env: Env): string | undefined {
  const inline = opt(env, "KALSHI_PRIVATE_KEY_PEM");
  if (inline) return inline.replace(/\\n/g, "\n");
  const path = opt(env, "KALSHI_PRIVATE_KEY_PATH");
  if (path) return readFileSync(resolve(path), "utf8");
  return undefined;
}

function recordMode(env: Env): RecordMode {
  const raw = (opt(env, "FORGE_RECORD_MODE") ?? "required").toLowerCase();
  if (raw === "best_effort") return "best_effort";
  // Default to fail-closed for anything else, including "required".
  return "required";
}

/**
 * Build the full application config from environment variables (see
 * `.env.example`). Forge credentials and a tenant id are required. Venue
 * configs are optional and only built when their keys are present.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const apiKey = opt(env, "FORGE_API_KEY");
  const bearerToken = opt(env, "FORGE_BEARER_TOKEN");
  if (!apiKey && !bearerToken) {
    throw new Error("one of FORGE_API_KEY or FORGE_BEARER_TOKEN is required");
  }

  const forge: ForgeConfig = {
    baseUrl: opt(env, "FORGE_API_BASE_URL") ?? "https://forgeorbital.com",
    recordMode: recordMode(env),
    tenantId: req(env, "FORGE_TENANT_ID"),
    agentId: opt(env, "AGENT_GATE_AGENT_ID") ?? "trading-agent",
    agentVersion: opt(env, "AGENT_GATE_AGENT_VERSION") ?? "0.1.5",
    timeoutMs: Number(opt(env, "FORGE_TIMEOUT_MS") ?? "15000"),
  };
  if (apiKey) forge.apiKey = apiKey;
  else if (bearerToken) forge.bearerToken = bearerToken;

  const config: AppConfig = {
    forge,
    mandatePath: resolve(opt(env, "AGENT_GATE_MANDATE_PATH") ?? "./mandate.json"),
    killFilePath: resolve(opt(env, "AGENT_GATE_KILL_FILE") ?? "./.forge-agent-gate.kill"),
  };

  const kalshiKeyId = opt(env, "KALSHI_API_KEY_ID");
  const kalshiPem = loadKalshiPrivateKey(env);
  if (kalshiKeyId && kalshiPem) {
    const environment = (opt(env, "KALSHI_ENV") ?? "demo").toLowerCase();
    config.kalshi = {
      keyId: kalshiKeyId,
      privateKeyPem: kalshiPem,
      environment: (environment === "prod" ? "prod" : "demo") as KalshiEnvironment,
    };
  }

  const pmxtKey = opt(env, "PMXT_API_KEY");
  if (pmxtKey) {
    config.pmxt = {
      venue: opt(env, "PMXT_VENUE") ?? "polymarket",
      apiKey: pmxtKey,
      walletAddress: opt(env, "PMXT_WALLET_ADDRESS"),
      privateKey: opt(env, "PMXT_PRIVATE_KEY"),
    };
  }

  return config;
}
