import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { stableStringify } from "./canonical.js";
import type { TradingWindow } from "./time.js";

/** Current on-disk mandate schema version. */
export const MANDATE_SCHEMA_VERSION = 1;

export interface TradingHours {
  /** IANA timezone, e.g. "America/New_York". All windows are interpreted here. */
  tz: string;
  /** Allowed trading windows. Empty array = no time restriction. */
  windows: TradingWindow[];
}

export interface MarketCategoryFilters {
  /** If non-empty, an order's market category MUST be in this list. */
  allow?: string[];
  /** An order whose market category is in this list is blocked. */
  deny?: string[];
}

export interface MandateSignature {
  alg: "ed25519";
  /** base64-encoded SPKI DER public key that verifies `value`. */
  publicKey: string;
  /** base64-encoded signature over the canonical mandate (minus this block). */
  value: string;
  /** ISO-8601 timestamp of when the mandate was signed. */
  signedAt: string;
}

/**
 * Signed risk mandate. This is the customer's policy. The enforcement engine
 * treats every field as a hard boundary except `humanApprovalThresholdUsd`,
 * which routes to a human instead of blocking.
 */
export interface Mandate {
  schemaVersion: number;
  mandateId: string;
  createdAt: string;
  /** Venues the agent is allowed to trade on (lower-cased slugs, e.g. "kalshi"). */
  venueWhitelist: string[];
  /** Allow/deny lists on market category. */
  marketCategoryFilters: MarketCategoryFilters;
  /** Max USD notional (worst-case cost) of a single order. */
  maxOrderNotionalUsd: number;
  /** Max USD open exposure allowed on any one market after the order. */
  maxPositionPerMarketUsd: number;
  /** Max USD total open exposure across all markets after the order. */
  maxTotalOpenExposureUsd: number;
  /** Once today's realized loss reaches this USD amount, new orders are blocked. */
  maxDailyRealizedLossUsd: number;
  /** Time-of-day restriction, or null for none. */
  tradingHours: TradingHours | null;
  /** Orders at/above this USD notional escalate to a human (0 disables). */
  humanApprovalThresholdUsd: number;
  /** Master off switch. When true, every write is blocked. */
  killSwitch: boolean;
  /** Present once the mandate has been signed. */
  signature?: MandateSignature;
}

/** Anything that carries an optional ed25519 `signature` block. */
export type Signable = { signature?: MandateSignature };

/** Non-signature portion of a signable document, for signing/verify. */
function signaturePayload<T extends Signable>(doc: T): Record<string, unknown> {
  const { signature: _signature, ...rest } = doc;
  return rest as Record<string, unknown>;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Strictly validate an untyped object as a Mandate. Returns a list of human
 * readable errors; an empty list means the object is a structurally valid,
 * enforceable mandate.
 */
export function validateMandate(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return ["mandate must be a JSON object"];
  }
  const m = input as Record<string, unknown>;

  if (m.schemaVersion !== MANDATE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MANDATE_SCHEMA_VERSION}`);
  }
  if (typeof m.mandateId !== "string" || m.mandateId.trim() === "") {
    errors.push("mandateId is required");
  }
  if (typeof m.createdAt !== "string" || m.createdAt.trim() === "") {
    errors.push("createdAt is required");
  }

  if (!Array.isArray(m.venueWhitelist) || m.venueWhitelist.some((v) => typeof v !== "string")) {
    errors.push("venueWhitelist must be an array of strings");
  } else if (m.venueWhitelist.length === 0) {
    errors.push("venueWhitelist must not be empty (fail-closed: no venue is allowed by default)");
  }

  const filters = m.marketCategoryFilters;
  if (filters === undefined || filters === null || typeof filters !== "object") {
    errors.push("marketCategoryFilters must be an object with optional allow/deny arrays");
  } else {
    const f = filters as Record<string, unknown>;
    for (const key of ["allow", "deny"] as const) {
      const list = f[key];
      if (list !== undefined && (!Array.isArray(list) || list.some((v) => typeof v !== "string"))) {
        errors.push(`marketCategoryFilters.${key} must be an array of strings`);
      }
    }
  }

  for (const key of [
    "maxOrderNotionalUsd",
    "maxPositionPerMarketUsd",
    "maxTotalOpenExposureUsd",
    "maxDailyRealizedLossUsd",
    "humanApprovalThresholdUsd",
  ] as const) {
    if (!isFiniteNonNegative(m[key])) {
      errors.push(`${key} must be a finite number >= 0`);
    }
  }

  if (typeof m.killSwitch !== "boolean") {
    errors.push("killSwitch must be a boolean");
  }

  const hours = m.tradingHours;
  if (hours !== null && hours !== undefined) {
    if (typeof hours !== "object") {
      errors.push("tradingHours must be null or an object");
    } else {
      const h = hours as Record<string, unknown>;
      if (typeof h.tz !== "string" || h.tz.trim() === "") {
        errors.push("tradingHours.tz is required when tradingHours is set");
      } else if (!isValidTimezone(h.tz)) {
        errors.push(`tradingHours.tz is not a valid IANA timezone: ${h.tz}`);
      }
      if (!Array.isArray(h.windows)) {
        errors.push("tradingHours.windows must be an array");
      } else {
        h.windows.forEach((w, i) => {
          if (!w || typeof w !== "object") {
            errors.push(`tradingHours.windows[${i}] must be an object`);
            return;
          }
          const win = w as Record<string, unknown>;
          if (typeof win.start !== "string" || typeof win.end !== "string") {
            errors.push(`tradingHours.windows[${i}] requires string start/end "HH:MM"`);
          }
          if (
            win.days !== undefined &&
            (!Array.isArray(win.days) ||
              win.days.some((d) => typeof d !== "number" || d < 0 || d > 6))
          ) {
            errors.push(`tradingHours.windows[${i}].days must be integers 0..6`);
          }
        });
      }
    }
  }

  return errors;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse + strictly validate raw JSON text into a Mandate (throws on error). */
export function parseMandate(text: string): Mandate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`mandate is not valid JSON: ${(err as Error).message}`);
  }
  const errors = validateMandate(parsed);
  if (errors.length > 0) {
    throw new Error(`invalid mandate:\n - ${errors.join("\n - ")}`);
  }
  return parsed as Mandate;
}

/** Load, validate, and return a mandate from disk (throws on error). */
export function loadMandate(path: string): Mandate {
  return parseMandate(readFileSync(path, "utf8"));
}

export interface MandateKeypair {
  /** PKCS#8 PEM private key. Store this locally; treat it as a secret. */
  privateKeyPem: string;
  /** base64-encoded SPKI DER public key. Safe to embed in the mandate. */
  publicKeyBase64: string;
}

/** Generate a fresh ed25519 keypair for signing mandates. */
export function generateMandateKeypair(): MandateKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Alias: generate an ed25519 keypair for signing any signable document. */
export const generateSigningKeypair = generateMandateKeypair;

/**
 * Return a copy of any signable document with a fresh ed25519 `signature`
 * block computed over its canonical, signature-free JSON encoding. Shared by
 * the trading mandate and the generic policy mandate - one crypto path.
 */
export function signDocument<T extends Signable>(doc: T, privateKeyPem: string): T {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyBase64 = createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const message = Buffer.from(stableStringify(signaturePayload(doc)), "utf8");
  const value = edSign(null, message, key).toString("base64");
  return {
    ...doc,
    signature: {
      alg: "ed25519",
      publicKey: publicKeyBase64,
      value,
      signedAt: new Date().toISOString(),
    },
  };
}

/**
 * Verify any signable document's embedded ed25519 signature against its
 * canonical signature-free encoding. Returns false if unsigned or tampered.
 */
export function verifyDocumentSignature(doc: Signable): boolean {
  const sig = doc.signature;
  if (!sig || sig.alg !== "ed25519" || !sig.publicKey || !sig.value) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(sig.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(stableStringify(signaturePayload(doc)), "utf8");
    return edVerify(null, message, publicKey, Buffer.from(sig.value, "base64"));
  } catch {
    return false;
  }
}

/**
 * Return a copy of `mandate` with a fresh ed25519 `signature` block. Thin
 * wrapper over {@link signDocument}; behavior is unchanged.
 */
export function signMandate(mandate: Mandate, privateKeyPem: string): Mandate {
  return signDocument(mandate, privateKeyPem);
}

/** Verify a trading mandate's embedded ed25519 signature. */
export function verifyMandateSignature(mandate: Mandate): boolean {
  return verifyDocumentSignature(mandate);
}

/** Write a mandate to disk as pretty JSON. */
export function writeMandate(path: string, mandate: Mandate): void {
  writeFileSync(path, `${JSON.stringify(mandate, null, 2)}\n`, "utf8");
}

/** Build a default, unsigned mandate skeleton with conservative limits. */
export function defaultMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    schemaVersion: MANDATE_SCHEMA_VERSION,
    mandateId: `mandate-${Date.now()}`,
    createdAt: new Date().toISOString(),
    venueWhitelist: ["kalshi"],
    marketCategoryFilters: {},
    maxOrderNotionalUsd: 100,
    maxPositionPerMarketUsd: 250,
    maxTotalOpenExposureUsd: 1000,
    maxDailyRealizedLossUsd: 200,
    tradingHours: null,
    humanApprovalThresholdUsd: 250,
    killSwitch: false,
    ...overrides,
  };
}
