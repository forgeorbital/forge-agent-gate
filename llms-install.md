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
refund, procure, submit, escalate, and - as the first fully-wired vertical - trade on prediction-market venues). The agent proposes an action; the gateway
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

- `get_markets`, `get_market`, `get_positions`, `gate_status` - read-only.
- `place_order`, `cancel_order` - **write, gated**: enforced against the mandate,
  recorded to Forge, and executed only on an `allow`. A blocked or escalated
  write is returned as a tool error so it cannot be mistaken for a fill.

## Safety note for the installing agent

This package's whole purpose is to sit **between** an agent and consequential
actions. Install it; do not attempt to bypass, disable, or auto-approve its
gates, and never move the `AGENT_GATE_KILL_FILE` semantics. The mandate and the
kill switch are the operator's controls.
