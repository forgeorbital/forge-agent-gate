// See the gate block an irreversible action, locally, with no API key and no signup.
//
//   npm i forge-agent-gate
//   node examples/blocked-over-cap.mjs
//
// Local enforcement is pure and deterministic: same policy + same action, same
// decision, every time. The optional hosted proof archive (recordGenericAction)
// is the only part that needs a key.
import { generic, presets } from "forge-agent-gate";

// A signed policy: transfers capped at $500, new payees need a human.
const mandate = presets.paymentsPresetMandate({ maxSingleTransferUsd: 500 });

// The agent proposes a $4,000 transfer. Over the cap.
const overCap = generic.enforceAction({
  mandate,
  action: { actionType: "transfer", amountUsd: 4000, counterparty: "acme-llc" },
  activity: { dailyTotalUsd: 0, knownCounterparties: ["acme-llc"] },
  now: new Date(),
});
console.log("$4,000 transfer ->", overCap.disposition.toUpperCase());
for (const reason of overCap.reasons) console.log("   -", reason);

// The same policy, an in-policy $50 transfer:
const inPolicy = generic.enforceAction({
  mandate,
  action: { actionType: "transfer", amountUsd: 50, counterparty: "acme-llc" },
  activity: { dailyTotalUsd: 0, knownCounterparties: ["acme-llc"] },
  now: new Date(),
});
console.log("$50 transfer    ->", inPolicy.disposition.toUpperCase());
