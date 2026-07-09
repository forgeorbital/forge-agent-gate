/**
 * Normalized, venue-agnostic order / position / market shapes plus the
 * VenueAdapter interface. Adapters translate between these and each venue's
 * native API. Venue credentials live inside the adapter and are never part of
 * these shapes.
 */

export type OrderAction = "buy" | "sell";
export type OrderType = "limit" | "market";

/**
 * A proposed order, normalized across venues. Money is expressed in USD.
 *
 * For contract markets (e.g. Kalshi) `limitPriceUsd` is the per-contract price
 * in dollars (a Kalshi 60c "yes" is 0.60). `count` is the number of contracts.
 * Worst-case notional is `count * limitPriceUsd`.
 */
export interface ProposedOrder {
  /** Venue slug, lower-case, e.g. "kalshi". Must be in the mandate whitelist. */
  venue: string;
  /** Venue market identifier / ticker. */
  marketId: string;
  /** Market category (resolved from the venue if not supplied). */
  marketCategory?: string;
  /** buy increases exposure; sell reduces an existing position. */
  action: OrderAction;
  /** Venue side, e.g. "yes" | "no" for binary markets. */
  side: string;
  /** Number of contracts / shares. Must be a positive integer. */
  count: number;
  /** Per-contract worst-case price in USD (limit price, or est. for market). */
  limitPriceUsd: number;
  /** Optional precomputed worst-case notional; defaults to count*limitPriceUsd. */
  notionalUsd?: number;
  /** limit (default) or market. */
  orderType?: OrderType;
  /** Idempotency key. Generated if omitted. */
  clientOrderId?: string;
}

export interface MarketPositionState {
  marketId: string;
  /** Current open exposure on this market in USD (>= 0). */
  exposureUsd: number;
}

/** Snapshot of account risk used by the enforcement engine. */
export interface AccountState {
  positions: MarketPositionState[];
  /** Current total open exposure across all markets in USD (>= 0). */
  totalOpenExposureUsd: number;
  /** Realized P&L for the current trading day in USD. Negative = net loss. */
  dailyRealizedPnlUsd: number;
}

export interface VenueMarket {
  venue: string;
  marketId: string;
  category?: string;
  /** Raw venue payload, unmodified. */
  raw: unknown;
}

export interface VenuePosition {
  marketId: string;
  exposureUsd: number;
  contracts?: number;
  realizedPnlUsd?: number;
  raw: unknown;
}

export interface VenueOrderResult {
  venue: string;
  orderId: string | null;
  status: string;
  raw: unknown;
}

export interface VenueCancelResult {
  venue: string;
  orderId: string;
  status: string;
  raw: unknown;
}

/** Minimal adapter surface each venue implements. */
export interface VenueAdapter {
  readonly venue: string;
  getMarket(marketId: string): Promise<VenueMarket>;
  getMarkets(query?: Record<string, string | number>): Promise<VenueMarket[]>;
  getPositions(): Promise<VenuePosition[]>;
  /** Derive the enforcement engine's AccountState from live venue data. */
  getAccountState(): Promise<AccountState>;
  placeOrder(order: ProposedOrder): Promise<VenueOrderResult>;
  cancelOrder(orderId: string): Promise<VenueCancelResult>;
}
