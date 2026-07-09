/**
 * Optional pmxt passthrough adapter (github.com/pmxt-dev/pmxt - "CCXT for
 * prediction markets"). pmxt unifies many venues (Polymarket, Limitless,
 * Opinion, Kalshi where self-hosted, etc.). Its own safety model is
 * confirmation-only with NO risk limits - this package supplies exactly the
 * risk limits that pmxt lacks, then delegates execution to pmxt.
 *
 * The `pmxtjs` package is an OPTIONAL dependency. This adapter loads it lazily
 * so the gateway works without it installed. SDK surface mirrored here:
 *   fetch_markets(), fetch_positions(), fetch_balance(), create_order().
 *
 * TODO: pmxt's TypeScript SDK (`pmxtjs`) surface is still stabilizing. The
 * method/field names below reflect its documented shape as of 2026-07; once a
 * live pmxt key is available, verify `fetchMarkets` / `createOrder` argument
 * names against the installed version and adjust the mapping in one place here.
 */

import { randomUUID } from "node:crypto";

import type {
  AccountState,
  ProposedOrder,
  VenueAdapter,
  VenueCancelResult,
  VenueMarket,
  VenueOrderResult,
  VenuePosition,
} from "./types.js";

export interface PmxtConfig {
  venue: string;
  apiKey?: string;
  walletAddress?: string;
  privateKey?: string;
}

interface PmxtClientLike {
  fetchMarkets?: (query?: unknown) => Promise<unknown>;
  fetch_markets?: (query?: unknown) => Promise<unknown>;
  fetchPositions?: () => Promise<unknown>;
  fetch_positions?: () => Promise<unknown>;
  createOrder?: (order: unknown) => Promise<unknown>;
  create_order?: (order: unknown) => Promise<unknown>;
  cancelOrder?: (id: string) => Promise<unknown>;
  cancel_order?: (id: string) => Promise<unknown>;
}

async function loadPmxtClient(config: PmxtConfig): Promise<PmxtClientLike> {
  let mod: Record<string, unknown>;
  try {
    // Optional dependency; not bundled. Loaded only when a pmxt venue is used.
    mod = (await import(/* @vite-ignore */ "pmxtjs")) as Record<string, unknown>;
  } catch {
    throw new Error(
      "pmxt passthrough requested but the optional 'pmxtjs' dependency is not installed. Run `npm install pmxtjs`.",
    );
  }
  const Ctor =
    (mod.Pmxt as (new (opts: unknown) => PmxtClientLike) | undefined) ??
    (mod.default as (new (opts: unknown) => PmxtClientLike) | undefined) ??
    (mod.Client as (new (opts: unknown) => PmxtClientLike) | undefined);
  if (!Ctor) {
    throw new Error("Installed 'pmxtjs' does not export a recognized client constructor.");
  }
  return new Ctor({
    venue: config.venue,
    apiKey: config.apiKey,
    walletAddress: config.walletAddress,
    privateKey: config.privateKey,
  });
}

export class PmxtAdapter implements VenueAdapter {
  readonly venue: string;
  private client: PmxtClientLike | null = null;

  constructor(private readonly config: PmxtConfig) {
    this.venue = config.venue;
  }

  private async getClient(): Promise<PmxtClientLike> {
    if (!this.client) this.client = await loadPmxtClient(this.config);
    return this.client;
  }

  async getMarket(marketId: string): Promise<VenueMarket> {
    const markets = await this.getMarkets({ id: marketId });
    const found = markets.find((m) => m.marketId === marketId);
    return found ?? { venue: this.venue, marketId, raw: null };
  }

  async getMarkets(query?: Record<string, string | number>): Promise<VenueMarket[]> {
    const client = await this.getClient();
    const fn = client.fetchMarkets ?? client.fetch_markets;
    if (!fn) throw new Error("pmxt client has no fetchMarkets method");
    const raw = (await fn.call(client, query)) as unknown;
    const list = Array.isArray(raw) ? raw : [];
    return list.map((m) => {
      const rec = (m ?? {}) as Record<string, unknown>;
      return {
        venue: this.venue,
        marketId: String(rec.id ?? rec.market_id ?? rec.ticker ?? ""),
        category: typeof rec.category === "string" ? rec.category : undefined,
        raw: m,
      };
    });
  }

  async getPositions(): Promise<VenuePosition[]> {
    const client = await this.getClient();
    const fn = client.fetchPositions ?? client.fetch_positions;
    if (!fn) throw new Error("pmxt client has no fetchPositions method");
    const raw = (await fn.call(client)) as unknown;
    const list = Array.isArray(raw) ? raw : [];
    return list.map((p) => {
      const rec = (p ?? {}) as Record<string, unknown>;
      const exposure = Number(rec.exposure_usd ?? rec.notional ?? rec.value ?? 0);
      return {
        marketId: String(rec.market_id ?? rec.id ?? ""),
        exposureUsd: Number.isFinite(exposure) ? Math.abs(exposure) : 0,
        realizedPnlUsd:
          rec.realized_pnl !== undefined ? Number(rec.realized_pnl) : undefined,
        raw: p,
      };
    });
  }

  async getAccountState(): Promise<AccountState> {
    const positions = await this.getPositions();
    return {
      positions: positions.map((p) => ({ marketId: p.marketId, exposureUsd: p.exposureUsd })),
      totalOpenExposureUsd: positions.reduce((s, p) => s + p.exposureUsd, 0),
      dailyRealizedPnlUsd: positions.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0),
    };
  }

  async placeOrder(order: ProposedOrder): Promise<VenueOrderResult> {
    const client = await this.getClient();
    const fn = client.createOrder ?? client.create_order;
    if (!fn) throw new Error("pmxt client has no createOrder method");
    const raw = (await fn.call(client, {
      market_id: order.marketId,
      side: order.side,
      action: order.action,
      amount: order.count,
      price: order.limitPriceUsd,
      type: order.orderType ?? "limit",
      client_order_id: order.clientOrderId ?? randomUUID(),
    })) as Record<string, unknown>;
    return {
      venue: this.venue,
      orderId: raw && raw.id ? String(raw.id) : null,
      status: String((raw && raw.status) ?? "submitted"),
      raw,
    };
  }

  async cancelOrder(orderId: string): Promise<VenueCancelResult> {
    const client = await this.getClient();
    const fn = client.cancelOrder ?? client.cancel_order;
    if (!fn) throw new Error("pmxt client has no cancelOrder method");
    const raw = (await fn.call(client, orderId)) as unknown;
    return { venue: this.venue, orderId, status: "canceled", raw };
  }
}
