# forge-agent-gate

Product page: https://forgeorbital.com/agent-gate
Live demo: https://forgeorbital.com/agent-gate/demo
Get an early-access API key: https://forgeorbital.com/agent-gate/pricing

Agent Gate is the self-serve developer on-ramp to Forge Orbital.

Forge Orbital is built for enterprise and federal AI accountability. Agent Gate is the developer on-ramp to the same engine, so you can start small and grow into the platform.

**Mandate gate + proof trail for AI agents that can take economically
consequential actions** - spend, transfer, approve, refund, procure, trade,
submit, escalate, isolate. It is a local, deterministic **mandate gate / risk
firewall**: your agent proposes an action, the gateway checks it against a
**signed policy mandate** you control, executes only what the mandate allows,
and sends **every** decision - allow, block, and escalate - to
[Forge Agent Gate](https://forgeorbital.com/agent-gate) to produce a **replayable proof trail** for
your archive. The signature is the integrity check; the proof trail is the
product.

The category is broad - payments, refunds, procurement, underwriting, claims,
account actions, security actions, workflow approvals. **Trading against
prediction-market venues (Kalshi natively, other venues via an optional
[pmxt](https://github.com/pmxt-dev/pmxt) passthrough) is the first fully-wired
vertical**, with a live Kalshi adapter (the pmxt passthrough is preview).
Everything else runs on the same generic core and the same proof-trail contract.

> This is a **risk-control gateway**. It is **not** a broker, does **not** take
> custody of funds, does **not** hold or transmit your venue keys anywhere but
> your own machine, and gives **no trading advice**. It decides only whether an
> action your agent already chose is *permitted* by your mandate.

**Open thin gateway, closed engine.** This package - the local gateway,
enforcement engine, mandate model, and venue adapters - is open source (MIT).
The Forge decision engine / API that produces the proof trail is a separate,
closed service.

**Federal marketplace credential.** Forge's AI decision engine has been federally evaluated, and the Forge solution was assessed as Awardable on the U.S. Department of Defense CDAO Tradewinds Solutions Marketplace. Not a generic LLM wrapper.

---

## Why it exists

Agent action SDKs (including trading SDKs like pmxt) are typically
**confirmation-only**: they will do whatever the model decides, with no hard
risk limits. That gap is what this package fills. Enforcement here is **local
and authoritative** - you are protecting yourself from your own agent - and the
Forge proof trail is the independent accountability layer on top.

## The category layer (generic) and the trading vertical

There are two layers you can use:

| Layer | What it gates | Engine | Mandate |
|-------|---------------|--------|---------|
| **Generic** (`generic/*`) | any `AgentAction` (`spend`, `transfer`, `approve`, `refund`, `procure`, `submit`, `trade`, `escalate`, `isolate`, `custom`) | `enforceAction()` | `PolicyMandate` |
| **Trading** (`enforce.ts`, `venues/*`, `gate.ts`, MCP) | prediction-market orders, wired to Kalshi (pmxt passthrough is preview) | `enforce()` | `Mandate` |

Both are **pure, deterministic** engines that evaluate **every** constraint and
resolve a disposition by the same precedence - **any `fail` → block, else any
`escalate` → escalate, else allow** - and both feed the identical Forge
`pre_action_gate` event contract. The trading mandate compiles down to the
generic model via `tradingToPolicyMandate()`, so trading interoperates with
every other vertical under one firewall.

### Generic policy mandate (action-agnostic)

```jsonc
{
  "schemaVersion": 1,
  "mandateId": "policy-...",
  "createdAt": "2026-07-09T00:00:00.000Z",
  "allowedActionTypes": ["transfer", "spend"], // empty = allow all types
  "counterpartyAllowlist": [], "counterpartyDenylist": ["sanctioned-1"],
  "resourceAllowlist": [], "resourceDenylist": [],
  "maxSingleActionUsd": 5000,          // cap on one action's USD magnitude
  "maxDailyTotalUsd": 25000,           // cumulative daily USD ceiling
  "perActionType": { "refund": { "humanApprovalThresholdUsd": 100 } },
  "allowedHours": null,                // tz-aware windows, or null
  "humanApprovalThresholdUsd": 2500,   // >= this ESCALATES (0 disables)
  "requireApprovalForNewCounterparty": true, // new payee/vendor => ESCALATE
  "rateLimit": { "maxActions": 20, "windowSeconds": 60 },
  "killSwitch": false,
  "signature": { "alg": "ed25519", "publicKey": "…", "value": "…", "signedAt": "…" }
}
```

Generic constraints, each evaluated every time and unit-tested: kill switch,
action-type allow-list (+ per-type disallow), counterparty allow/deny, resource
allow/deny, single-action cap (+ per-type override), daily cumulative cap,
rolling-window rate limit, tz-aware allowed hours (fail-closed on bad tz),
**new-counterparty → escalate**, human-approval threshold (+ per-type override,
escalate). Malformed input fails closed.

### Presets

Typed factories in `presets/*` (with example JSON in `src/presets/examples/`)
show the category is bigger than trading:

| Preset | Shape |
|--------|-------|
| `tradingPresetMandate()` / `tradingToPolicyMandate(m)` | trades only; venue → resource allow-list; order cap → single-action cap |
| `paymentsPresetMandate()` | transfers/spend; per-transfer + daily caps; **new-payee approval required** |
| `refundsPresetMandate()` | refunds auto-approve below a ceiling, **escalate at/above it**; daily cap; hard cap |

```ts
import { generic, presets } from "forge-agent-gate";

const mandate = presets.paymentsPresetMandate({ maxSingleTransferUsd: 5000 });
const decision = generic.enforceAction({
  mandate,
  action: { actionType: "transfer", amountUsd: 4200, counterparty: "acme-llc" },
  activity: { dailyTotalUsd: 0, knownCounterparties: [] },
  now: new Date(),
});
// decision.disposition === "escalate"  (brand-new counterparty)
await generic.recordGenericAction(forgeConfig, mandate, action, decision); // proof trail
```

## Install

```bash
npx -y forge-agent-gate init
```

Requires Node 18.17+ and a Forge API key. Request early access at
https://forgeorbital.com/agent-gate/pricing. The only runtime dependency is the
MCP SDK. RSA-PSS (Kalshi) and Ed25519 (mandate) signing use Node's built-in
`crypto`. `pmxtjs` is an **optional** dependency, loaded lazily only if you use a
pmxt venue.

If you are working from this repository rather than the published package:

```bash
npm install
npm run build
```

## Quickstart

```bash
# 1. Interactive setup: Forge creds, venue creds, first signed mandate,
#    and ready-to-paste MCP config for your local agent client.
npx forge-agent-gate init

# 2. Inspect the active mandate and kill-switch state.
npx forge-agent-gate status

# 3. Run the MCP server (usually launched by your MCP client, not by hand).
npx forge-agent-gate serve
```

`init` writes three files in the current directory (all gitignored):

| File | Purpose |
|------|---------|
| `mandate.json` | your signed risk policy |
| `mandate_signing_key.pem` | the Ed25519 key that signs the mandate - keep private |
| `.env` | Forge + venue credentials |

### MCP client config

`init` prints a standard MCP server entry. Paste the same shape into any
MCP-compatible local agent client:

```json
{
  "mcpServers": {
    "forge-agent-gate": {
      "command": "npx",
      "args": ["-y", "forge-agent-gate", "serve"],
      "env": {
        "FORGE_API_KEY": "fi_...",
        "FORGE_TENANT_ID": "your-tenant",
        "FORGE_RECORD_MODE": "required",
        "AGENT_GATE_MANDATE_PATH": "/abs/path/mandate.json",
        "AGENT_GATE_KILL_FILE": "/abs/path/.forge-agent-gate.kill",
        "KALSHI_API_KEY_ID": "...",
        "KALSHI_PRIVATE_KEY_PATH": "/abs/path/kalshi_private_key.pem",
        "KALSHI_ENV": "demo"
      }
    }
  }
}
```

### MCP tools

| Tool | Type | Behavior |
|------|------|----------|
| `get_markets`, `get_market`, `get_positions` | read | safe passthrough to the venue |
| `place_order` | **write, gated** | enforce → record → execute only on `allow` |
| `cancel_order` | **write, gated** | kill-switch + venue check → record → execute |
| `gate_status` | read | mandate summary + kill-switch state |

A blocked or escalated write is returned as a tool **error** so the agent cannot
mistake it for a fill.

## The mandate

The mandate is the policy the engine enforces. It is a signed JSON document:

```jsonc
{
  "schemaVersion": 1,
  "mandateId": "mandate-...",
  "createdAt": "2026-07-08T00:00:00.000Z",
  "venueWhitelist": ["kalshi"],           // only these venues may trade
  "marketCategoryFilters": {              // optional allow/deny on category
    "allow": [],                          // if non-empty, category MUST be listed
    "deny": ["crypto"]                    // category in this list is blocked
  },
  "maxOrderNotionalUsd": 100,             // worst-case cost of one order
  "maxPositionPerMarketUsd": 250,         // max open USD exposure per market
  "maxTotalOpenExposureUsd": 1000,        // max open USD exposure across markets
  "maxDailyRealizedLossUsd": 200,         // circuit breaker: stop when hit
  "tradingHours": {                       // optional; null for no restriction
    "tz": "America/New_York",
    "windows": [{ "days": [1,2,3,4,5], "start": "09:30", "end": "16:00" }]
  },
  "humanApprovalThresholdUsd": 250,       // orders >= this ESCALATE (0 disables)
  "killSwitch": false,                    // master off switch
  "signature": {                          // Ed25519, added by the signer
    "alg": "ed25519",
    "publicKey": "base64-spki-der",
    "value": "base64-signature",
    "signedAt": "2026-07-08T00:00:00.000Z"
  }
}
```

Weekdays are `0=Sun .. 6=Sat`. A trading window with `end <= start` wraps past
midnight. The signature covers the canonical (key-sorted) JSON of every field
except `signature`, so any tampering invalidates it.

### What the enforcement engine guarantees

`enforce()` and `enforceCancel()` are **pure functions** - no network, no
filesystem, no ambient clock. Given a mandate, a proposed order, a live account
snapshot, and the current instant, they return a deterministic decision. Every
mandate field is covered, and **every constraint is evaluated** so the proof
trail is complete. Disposition is chosen by precedence:

> **any `fail` → `block`**, else **any `escalate` → `escalate`**, else `allow`.

Specific guarantees, all unit-tested (`npm test`):

- **Kill switch:** `killSwitch: true` *or* the presence of the kill-file
  hard-blocks every write. `touch <killfile>` halts trading instantly.
- **Venue whitelist:** off-list venues are blocked (case-insensitive).
- **Category filters:** allow-list is fail-closed (unknown category blocked when
  an allow-list is set); deny-list blocks.
- **Notional / exposure ceilings:** per-order, per-market, and total exposure
  are checked at the boundary (`<=` passes). Risk-reducing **sells never fail**
  an exposure ceiling.
- **Daily-loss circuit breaker:** once today's realized loss reaches the limit,
  new orders are blocked (`>=` trips).
- **Trading hours:** timezone-aware; outside all windows blocks; invalid
  timezone or malformed window **fails closed**.
- **Human approval:** orders at/above the threshold **escalate** (not block) and
  are never executed without a human.
- **Malformed orders** (zero/negative/non-integer count, negative price,
  non-finite notional, empty ids) **fail closed**.

## Trust model

```
AI agent ──▶ MCP tool (place_order)
                 │
                 ▼
         enforce()  ← LOCAL, deterministic, authoritative
                 │  allow / block / escalate
                 ▼
  POST /v1/agentic/events/evaluate  ← Forge writes the proof trail
                 │
         allow ──┴─▶ venue.placeOrder()   (execute)
   block/escalate ─▶ do nothing, return the reason + record id
```

- **Enforcement is local.** Forge never relaxes a local block; it produces the
  proof trail. The one way Forge affects execution is fail-closed
  mode: with `FORGE_RECORD_MODE=required`, an `allow` that cannot be recorded is
  downgraded to a **block**. Use `best_effort` to execute even if the record
  could not be written.
- **Keys stay local.** Venue private keys live only in this process. They are
  never logged and never sent to Forge. Only non-secret facts (venue, market,
  side, count, USD notional, plus a SHA-256 of the order) go into the record.

### The exact Forge payload

Each decision is posted to `POST /v1/agentic/events/evaluate` with header
`X-API-Key: fi_...` (or `Authorization: Bearer <jwt>`). Body:

```jsonc
{
  "agent_id": "trading-agent-prod-1",
  "agent_version": "0.1.0",
  "tenant_id": "your-tenant",
  "client_id": "your-tenant",
  "integration_mode": "pre_action_gate",
  "proposed_action": "place_order:kalshi:buy_yes",
  "task": "Gate a real-money prediction-market order against the customer risk mandate.",
  "decision_question": "Should this prediction-market order be allowed, blocked, or escalated?",
  "decision_options": ["allow", "escalate", "block"],
  "workflow_type": "agent_pre_action_gate",
  "policy_checks": [
    { "name": "max_order_notional", "passed": true, "detail": "Order notional $50.00 <= limit $100.00." }
  ],
  "constraint_results": [
    { "constraint": "max_order_notional", "passed": true, "status": "pass", "detail": "Order notional $50.00 <= limit $100.00." }
  ],
  "required_approvals": ["human_reviewer_approval"],
  "missing_required_approval": [],
  "blocked_actions": [],
  "human_approval_state": {
    "threshold_usd": 250, "order_notional_usd": 50,
    "approval_required": false, "approval_present": false
  },
  "tools_called": [
    { "tool": "venue:kalshi", "detail": "buy yes x100 on MKT-1 @ $0.50 (notional $50.00)" }
  ],
  "data_provenance": {
    "local_decision": "allow", "mandate_id": "mandate-...",
    "venue": "kalshi", "market_id": "MKT-1", "order_notional_usd": 50,
    "order_sha256": "…", "raw_credentials_sent_to_forge": false
  },
  "learning_rights": { "learning_mode": "evaluation_metrics_only", "raw_payload_retention": "none" }
}
```

Forge returns a proof-trail result with a record id and signature; the gateway
attaches that verification summary to the tool result. (Field shapes match the Forge `AgenticEventRequest` contract in the public
`docs/openapi.latest.json` schema.)

## Kalshi auth

The native Kalshi adapter signs every request per Kalshi's 2026 scheme:
RSA-PSS (SHA-256 digest, MGF1-SHA256, salt length = digest length) over the
ASCII string `timestamp_ms + METHOD + path`, where `path` includes the
`/trade-api/v2` prefix and excludes the query string, sent as headers
`KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`.
Base URLs: `https://external-api.kalshi.com/trade-api/v2` (prod) and
`https://external-api.demo.kalshi.co/trade-api/v2` (demo).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # Node test runner - exhaustive enforcement suite
npm run build       # emit dist/
```

## License

See `LICENSE`.
