/**
 * Kalshi native venue adapter.
 *
 * Auth (as of 2026): API Key ID + RSA private key. Every request is signed
 * RSA-PSS (SHA-256 digest, MGF1-SHA256, salt length = digest length) over the
 * ASCII string `timestamp_ms + METHOD + path`, where `path` includes the
 * `/trade-api/v2` prefix and EXCLUDES the query string. Three headers are sent:
 *   KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE.
 * (Confirmed against docs.kalshi.com quick-start authenticated requests.)
 *
 * The private key never leaves this process and is never logged or sent to Forge.
 */

import { constants, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import type {
  AccountState,
  ProposedOrder,
  VenueAdapter,
  VenueCancelResult,
  VenueMarket,
  VenueOrderResult,
  VenuePosition,
} from "./types.js";

export const KALSHI_BASE_URLS = {
  prod: "https://external-api.kalshi.com/trade-api/v2",
  demo: "https://external-api.demo.kalshi.co/trade-api/v2",
} as const;

/** URL path prefix that MUST be part of the signed string. */
export const KALSHI_PATH_PREFIX = "/trade-api/v2";

export type KalshiEnvironment = "prod" | "demo";

export interface KalshiConfig {
  keyId: string;
  /** PKCS#8 / PKCS#1 PEM RSA private key. Kept local; never transmitted. */
  privateKeyPem: string;
  environment: KalshiEnvironment;
}

export interface KalshiSignatureHeaders {
  "KALSHI-ACCESS-KEY": string;
  "KALSHI-ACCESS-TIMESTAMP": string;
  "KALSHI-ACCESS-SIGNATURE": string;
}

/**
 * Produce the RSA-PSS signature (base64) for the Kalshi message
 * `timestampMs + METHOD + path`. `pathWithPrefix` must start with
 * `/trade-api/v2` and must not include a query string. Exported for testing.
 */
export function signKalshiMessage(
  privateKey: KeyObject | string,
  method: string,
  pathWithPrefix: string,
  timestampMs: string,
): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const message = `${timestampMs}${method.toUpperCase()}${pathWithPrefix}`;
  const signature = cryptoSign("sha256", Buffer.from(message, "utf8"), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

/** Build the three signed Kalshi auth headers for one request. */
export function buildKalshiHeaders(
  config: { keyId: string; privateKeyPem: string },
  method: string,
  pathWithPrefix: string,
  timestampMs: string = Date.now().toString(),
): KalshiSignatureHeaders {
  return {
    "KALSHI-ACCESS-KEY": config.keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signKalshiMessage(
      config.privateKeyPem,
      method,
      pathWithPrefix,
      timestampMs,
    ),
  };
}

function centsToUsd(cents: unknown): number {
  const n = typeof cents === "number" ? cents : Number(cents);
  return Number.isFinite(n) ? Math.abs(n) / 100 : 0;
}

export class KalshiAdapter implements VenueAdapter {
  readonly venue = "kalshi";
  private readonly baseUrl: string;
  private readonly key: KeyObject;

  constructor(private readonly config: KalshiConfig) {
    this.baseUrl = KALSHI_BASE_URLS[config.environment];
    // Parse the key once so a bad key fails fast at construction, and so we
    // never re-parse (or accidentally log) the PEM per request.
    this.key = createPrivateKey(config.privateKeyPem);
  }

  /** Signed request against a `/trade-api/v2`-relative route (no prefix, no host). */
  private async request<T>(
    method: string,
    route: string,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<T> {
    const routePath = route.startsWith("/") ? route : `/${route}`;
    const signedPath = `${KALSHI_PATH_PREFIX}${routePath}`;
    const timestampMs = Date.now().toString();
    const headers: Record<string, string> = {
      accept: "application/json",
      "KALSHI-ACCESS-KEY": this.config.keyId,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      "KALSHI-ACCESS-SIGNATURE": signKalshiMessage(this.key, method, signedPath, timestampMs),
    };
    let url = `${this.baseUrl}${routePath}`;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
      url += `?${qs.toString()}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Kalshi ${method} ${routePath} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getMarket(marketId: string): Promise<VenueMarket> {
    const data = await this.request<{ market?: Record<string, unknown> }>(
      "GET",
      `/markets/${encodeURIComponent(marketId)}`,
    );
    const market = data.market ?? {};
    return {
      venue: this.venue,
      marketId,
      category: typeof market.category === "string" ? market.category : undefined,
      raw: market,
    };
  }

  async getMarkets(query?: Record<string, string | number>): Promise<VenueMarket[]> {
    const data = await this.request<{ markets?: Array<Record<string, unknown>> }>(
      "GET",
      "/markets",
      undefined,
      query,
    );
    return (data.markets ?? []).map((market) => ({
      venue: this.venue,
      marketId: String(market.ticker ?? ""),
      category: typeof market.category === "string" ? market.category : undefined,
      raw: market,
    }));
  }

  async getPositions(): Promise<VenuePosition[]> {
    const data = await this.request<{ market_positions?: Array<Record<string, unknown>> }>(
      "GET",
      "/portfolio/positions",
    );
    return (data.market_positions ?? []).map((pos) => ({
      marketId: String(pos.ticker ?? ""),
      exposureUsd: centsToUsd(pos.market_exposure),
      contracts: typeof pos.position === "number" ? pos.position : undefined,
      realizedPnlUsd:
        pos.realized_pnl !== undefined ? Number(pos.realized_pnl) / 100 : undefined,
      raw: pos,
    }));
  }

  async getAccountState(): Promise<AccountState> {
    const positions = await this.getPositions();
    const totalOpenExposureUsd = positions.reduce((sum, p) => sum + p.exposureUsd, 0);
    // NOTE: Kalshi's positions endpoint reports CUMULATIVE realized_pnl, not
    // day-scoped. This sum is a conservative proxy. TODO: for a precise daily
    // figure, query GET /portfolio/settlements (or /fills) filtered to the
    // current trading day and sum realized P&L there.
    const dailyRealizedPnlUsd = positions.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);
    return {
      positions: positions.map((p) => ({ marketId: p.marketId, exposureUsd: p.exposureUsd })),
      totalOpenExposureUsd,
      dailyRealizedPnlUsd,
    };
  }

  async placeOrder(order: ProposedOrder): Promise<VenueOrderResult> {
    const priceCents = Math.round(order.limitPriceUsd * 100);
    const body: Record<string, unknown> = {
      ticker: order.marketId,
      client_order_id: order.clientOrderId ?? randomUUID(),
      action: order.action,
      side: order.side,
      count: order.count,
      type: order.orderType ?? "limit",
    };
    if (order.side === "yes") body.yes_price = priceCents;
    else if (order.side === "no") body.no_price = priceCents;

    const data = await this.request<{ order?: Record<string, unknown> }>(
      "POST",
      "/portfolio/orders",
      body,
    );
    const placed = data.order ?? {};
    return {
      venue: this.venue,
      orderId: placed.order_id ? String(placed.order_id) : null,
      status: String(placed.status ?? "submitted"),
      raw: data,
    };
  }

  async cancelOrder(orderId: string): Promise<VenueCancelResult> {
    const data = await this.request<Record<string, unknown>>(
      "DELETE",
      `/portfolio/orders/${encodeURIComponent(orderId)}`,
    );
    return {
      venue: this.venue,
      orderId,
      status: "canceled",
      raw: data,
    };
  }
}
