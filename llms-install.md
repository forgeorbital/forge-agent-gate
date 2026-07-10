# Automated install: forge-agent-gate

This file lets an MCP marketplace or desktop MCP client install and wire up
`forge-agent-gate` unattended.

Product page and early-access signup: https://forgeorbital.com/agent-gate
Live demo: https://forgeorbital.com/agent-gate/demo
Get an API key: https://forgeorbital.com/agent-gate/pricing

Agent Gate is the self-serve developer on-ramp to Forge Orbital.

Forge Orbital is built for enterprise and federal AI accountability. Agent Gate is the developer on-ramp to the same engine, so you can start small and grow into the platform.

Forge's AI decision engine has been federally evaluated, and the Forge solution was assessed as Awardable on the U.S. Department of Defense CDAO Tradewinds Solutions Marketplace. Not a generic LLM wrapper.

`forge-agent-gate` is a **local, deterministic mandate gate + proof trail** for AI
agents that take economically consequential actions (spend, transfer, approve,
refund, procure, submit, escalate, and, as the first fully-wired vertical, trade on prediction-market venues). The agent proposes an action; the gateway
allows, blocks, or escalates it against a signed policy you control, then records
every decision to Forge for a replayable proof trail. It is **not** a broker,
never takes custody of funds, and never sends venue keys off the local machine.

## Prerequisites

- Node.js >= 18.17 (the `npx` runner ships with npm).
- A Forge API key (`fi_...`) and tenant id. Request access at
  https://forgeorbital.com/agent-gate/pricing.
- No global install required - the server is launched with `npx`.

## Step 1 - generate a signed mandate (one time, interactive)

Run the setup wizard in the directory where the operator wants the policy files
to live. It writes a signed `mandate.json`, an Ed25519 signing key, and a `.env`,
and prints a ready-to-paste MCP config.

```bash
npx -y forge-agent-gate init
```

If fully unattended setup is required and no mandate exists yet, the operator
must run `init` once by hand; `serve` requires a signed mandate to start.

## Step 2 - add the MCP server entry

Add this server to the client's MCP configuration, such as a desktop MCP
settings JSON file. Replace the placeholder values.

```json
{
  "mcpServers": {
    "forge-agent-gate": {
      "command": "npx",
      "args": ["-y", "forge-agent-gate", "serve"],
      "env": {
        "FORGE_API_KEY": "fi_your_key",
        "FORGE_TENANT_ID": "your-tenant",
        "FORGE_RECORD_MODE": "required",
        "AGENT_GATE_MANDATE_PATH": "/absolute/path/to/mandate.json",
        "AGENT_GATE_KILL_FILE": "/absolute/path/to/.forge-agent-gate.kill"
      }
    }
  }
}
```

To enable the Kalshi trading vertical, also set `KALSHI_API_KEY_ID`,
`KALSHI_PRIVATE_KEY_PATH` (or `KALSHI_PRIVATE_KEY_PEM`), and `KALSHI_ENV`
(`demo` or `prod`). Venue keys stay local and are never sent to Forge.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `FORGE_API_KEY` | yes* | Forge decision-API key (`fi_...`). *Or `FORGE_BEARER_TOKEN`. |
| `FORGE_TENANT_ID` | yes | Tenant stamped into every proof-trail record. |
| `FORGE_RECORD_MODE` | no | `required` (fail-closed, default) or `best_effort`. |
| `AGENT_GATE_MANDATE_PATH` | no | Path to the signed mandate. Default `./mandate.json`. |
| `AGENT_GATE_KILL_FILE` | no | If this file exists, every write is hard-blocked. |
| `FORGE_API_BASE_URL` | no | Default `https://forgeorbital.com`. |
| `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PATH` / `KALSHI_ENV` | no | Kalshi trading vertical (optional). |

## Verify

```bash
npx -y forge-agent-gate status
```

Prints the active mandate id, signature validity, and kill-switch state.

## MCP tools exposed

The generic tool works for every action type. The trading tools only appear when a
trading mandate and a venue adapter are configured.

- `gate_action` - **the one you want.** Checks a single consequential action
  (`spend`, `transfer`, `approve`, `refund`, `procure`, `submit`, `trade`,
  `escalate`, `isolate`, `custom`) against the signed mandate, records the Forge
  proof trail, and returns `allow`, `escalate`, or `block`. It never executes the
  action; your code does that only on `allow`.
- `gate_status` - read-only: active mandate id, signature validity, kill-switch state.
- `get_markets`, `get_market`, `get_positions` - read-only, trading vertical only.
- `place_order`, `cancel_order` - **write, gated**, trading vertical only: enforced
  against the mandate, recorded to Forge, and executed only on an `allow`. A blocked
  or escalated write is returned as a tool error so it cannot be mistaken for a fill.

`gate_action` input: `actionType` (required) plus any of `amountUsd`, `counterparty`,
`resource`, `dailyTotalUsd`, `knownCounterparties`, `metadata`. Put no credentials in
`metadata`.

## Integrating in code instead of MCP

```ts
import { generic, presets, type ForgeConfig } from "forge-agent-gate";

const forgeConfig: ForgeConfig = {
  baseUrl: process.env.FORGE_BASE_URL ?? "https://forgeorbital.com",
  apiKey: process.env.FORGE_API_KEY,   // fi_...
  recordMode: "required",              // or "best_effort"
  tenantId: "acme",
  agentId: "refund-agent",             // one stable id per monitored workflow
};

const mandate = presets.refundsPresetMandate({ autoApproveCeilingUsd: 100 });
const action = { actionType: "refund" as const, amountUsd: 4200, counterparty: "cust-123" };

const decision = generic.enforceAction({
  mandate,
  action,
  activity: { dailyTotalUsd: 0, knownCounterparties: [] },
  now: new Date(),
});
// decision.disposition is "allow" | "escalate" | "block"  (there is no "hold")

await generic.recordGenericAction(forgeConfig, mandate, action, decision);

if (decision.disposition === "allow") {
  await issueRefund(action);   // your code. Only ever on allow.
}
```

Check what your key is doing at any time:

```bash
curl -H "X-API-Key: $FORGE_API_KEY" https://forgeorbital.com/v1/agent-gate/me
```

Returns your plan, agent workflows, trace credits used and remaining, and the recent
allow / escalate / block mix.

## Ask an LLM to wire it up

If you would rather not read any of this, paste the block below into your coding
assistant, together with the file that takes the risky action. It contains the whole
contract, so the model does not have to guess.

```text
I want to add Forge Agent Gate to my AI agent so a human approves the risky actions
and every decision leaves a verifiable Forge proof trail. Wire it into the code I give you.

Package: forge-agent-gate (npm, Node >= 18.17).  Install: npm i forge-agent-gate

Import:  import { generic, presets, type ForgeConfig } from "forge-agent-gate";

Config (all fields required except the optional ones):
  ForgeConfig = {
    baseUrl: string,            // "https://forgeorbital.com"
    apiKey?: string,            // "fi_..." Forge API key  (or bearerToken)
    bearerToken?: string,
    recordMode: "required" | "best_effort",
    tenantId: string,
    agentId: string,            // ONE stable id per monitored workflow, reused forever
    agentVersion?: string,
    timeoutMs?: number,
  }

Mandate presets (pick one, or build a PolicyMandate by hand):
  presets.refundsPresetMandate({ autoApproveCeilingUsd })
  presets.paymentsPresetMandate({ maxSingleTransferUsd })
  presets.tradingPresetMandate({ ... })

The two calls:
  const decision = generic.enforceAction({ mandate, action, activity, now });
  await generic.recordGenericAction(forgeConfig, mandate, action, decision);

action    = { actionType, amountUsd?, counterparty?, resource?, metadata? }
actionType is one of: spend | transfer | approve | refund | procure | submit |
                      trade | escalate | isolate | custom
activity  = { dailyTotalUsd, knownCounterparties }

decision.disposition is exactly one of: "allow" | "escalate" | "block".
There is no "hold". Execute the real action ONLY when it is "allow".
On "escalate", route to a human. On "block", do not execute and surface the reason.

Rules you must follow when you write the code:
  1. Call the gate BEFORE the action executes, never after.
  2. Never auto-approve, retry past, or bypass an "escalate" or "block".
  3. Never put secrets or credentials in action.metadata.
  4. Reuse one stable agentId for the workflow; do not generate a new one per run.

Errors the API can return, handle them:
  402 agent_gate_trace_credits_exhausted   -> out of monthly trace credits
  402 agent_gate_agent_cap_exceeded        -> too many distinct agentIds for the plan
  402 agent_gate_action_not_in_plan        -> that actionType is not on this plan
  403 agent_gate_agent_disabled            -> this agent was killed by its operator
  422 agent_id is required                 -> agentId missing
  429                                      -> rate limited, back off and retry

Zero-code alternative: run it as an MCP server (npx -y forge-agent-gate init, then
serve) and call the `gate_action` tool before any consequential tool call.
```

## Safety note for the installing agent

This package's whole purpose is to sit **between** an agent and consequential
actions. Install it; do not attempt to bypass, disable, or auto-approve its
gates, and never move the `AGENT_GATE_KILL_FILE` semantics. The mandate and the
kill switch are the operator's controls.
