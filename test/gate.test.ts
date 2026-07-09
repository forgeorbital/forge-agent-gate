import { afterEach, describe, expect, it, vi } from "./testlib.js";

import type { ForgeConfig } from "../src/forge.js";
import { GateEngine } from "../src/gate.js";
import { defaultMandate, type Mandate } from "../src/mandate.js";
import type {
  AccountState,
  ProposedOrder,
  VenueAdapter,
  VenueCancelResult,
  VenueMarket,
  VenueOrderResult,
  VenuePosition,
} from "../src/venues/types.js";

class FakeAdapter implements VenueAdapter {
  readonly venue = "kalshi";
  placed: ProposedOrder[] = [];
  canceled: string[] = [];
  account: AccountState = { positions: [], totalOpenExposureUsd: 0, dailyRealizedPnlUsd: 0 };

  async getMarket(marketId: string): Promise<VenueMarket> {
    return { venue: this.venue, marketId, category: "econ", raw: {} };
  }
  async getMarkets(): Promise<VenueMarket[]> {
    return [await this.getMarket("MKT-1")];
  }
  async getPositions(): Promise<VenuePosition[]> {
    return [];
  }
  async getAccountState(): Promise<AccountState> {
    return this.account;
  }
  async placeOrder(order: ProposedOrder): Promise<VenueOrderResult> {
    this.placed.push(order);
    return { venue: this.venue, orderId: "o-1", status: "resting", raw: {} };
  }
  async cancelOrder(orderId: string): Promise<VenueCancelResult> {
    this.canceled.push(orderId);
    return { venue: this.venue, orderId, status: "canceled", raw: {} };
  }
}

const FORGE: ForgeConfig = {
  baseUrl: "https://forgeorbital.com",
  apiKey: "fi_test",
  recordMode: "required",
  tenantId: "tenant-x",
  agentId: "agent-x",
  agentVersion: "0.1.0",
};

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return defaultMandate({
    venueWhitelist: ["kalshi"],
    maxOrderNotionalUsd: 1000,
    maxPositionPerMarketUsd: 1000,
    maxTotalOpenExposureUsd: 10000,
    maxDailyRealizedLossUsd: 1000,
    humanApprovalThresholdUsd: 0,
    ...overrides,
  });
}

function engine(m: Mandate, forge: ForgeConfig = FORGE): { gate: GateEngine; adapter: FakeAdapter } {
  const adapter = new FakeAdapter();
  const gate = new GateEngine({
    mandate: m,
    forge,
    killFilePath: "/nonexistent/.kill",
    adapters: [adapter],
    now: () => new Date("2026-07-08T12:00:00Z"),
  });
  return { gate, adapter };
}

const ORDER: ProposedOrder = {
  venue: "kalshi",
  marketId: "MKT-1",
  action: "buy",
  side: "yes",
  count: 10,
  limitPriceUsd: 0.5, // notional 5
};

function stubForgeOk() {
  vi.stubGlobal("fetch", async () =>
    new Response(
      JSON.stringify({ record: { record_id: "rec_1", selected_action: "proceed", signature: "sig" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GateEngine.placeOrder", () => {
  it("executes an allowed order and records it", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate());
    const result = await gate.placeOrder(ORDER);
    expect(result.disposition).toBe("allow");
    expect(result.executed).toBe(true);
    expect(result.forge.recordId).toBe("rec_1");
    expect(result.forge.signaturePresent).toBe(true);
    expect(adapter.placed).toHaveLength(1);
  });

  it("does NOT execute a blocked order but still records it", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate({ maxOrderNotionalUsd: 1 }));
    const result = await gate.placeOrder(ORDER);
    expect(result.disposition).toBe("block");
    expect(result.executed).toBe(false);
    expect(result.forge.recordId).toBe("rec_1"); // block is still signed
    expect(adapter.placed).toHaveLength(0);
  });

  it("does NOT execute an escalated order", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate({ humanApprovalThresholdUsd: 1 }));
    const result = await gate.placeOrder(ORDER);
    expect(result.disposition).toBe("escalate");
    expect(result.executed).toBe(false);
    expect(adapter.placed).toHaveLength(0);
  });

  it("fail-closed: an allow that cannot be recorded is downgraded to block (required mode)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const { gate, adapter } = engine(mandate());
    const result = await gate.placeOrder(ORDER);
    expect(result.disposition).toBe("block");
    expect(result.executed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/fail-closed/);
    expect(adapter.placed).toHaveLength(0);
  });

  it("best_effort: an allow still executes even when Forge is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const { gate, adapter } = engine(mandate(), { ...FORGE, recordMode: "best_effort" });
    const result = await gate.placeOrder(ORDER);
    expect(result.disposition).toBe("allow");
    expect(result.executed).toBe(true);
    expect(result.forge.ok).toBe(false);
    expect(adapter.placed).toHaveLength(1);
  });

  it("evaluateOrder never executes", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate());
    const result = await gate.evaluateOrder(ORDER);
    expect(result.disposition).toBe("allow");
    expect(result.executed).toBe(false);
    expect(adapter.placed).toHaveLength(0);
  });
});

describe("GateEngine.cancelOrder", () => {
  it("cancels on a whitelisted venue", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate());
    const result = await gate.cancelOrder("kalshi", "o-99");
    expect(result.disposition).toBe("allow");
    expect(result.executed).toBe(true);
    expect(adapter.canceled).toEqual(["o-99"]);
  });

  it("blocks a cancel when the kill switch is engaged", async () => {
    stubForgeOk();
    const { gate, adapter } = engine(mandate({ killSwitch: true }));
    const result = await gate.cancelOrder("kalshi", "o-99");
    expect(result.disposition).toBe("block");
    expect(result.executed).toBe(false);
    expect(adapter.canceled).toHaveLength(0);
  });
});
