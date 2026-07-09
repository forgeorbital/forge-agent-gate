/**
 * Vertical presets. Each is a typed factory that produces a generic
 * `PolicyMandate`, proving one firewall covers many economically consequential
 * verticals. Example mandate JSON lives in `./examples/`.
 */

export { tradingToPolicyMandate, tradingPresetMandate } from "./trading.js";
export { paymentsPresetMandate, type PaymentsPresetOptions } from "./payments.js";
export { refundsPresetMandate, type RefundsPresetOptions } from "./refunds.js";

import { paymentsPresetMandate } from "./payments.js";
import { refundsPresetMandate } from "./refunds.js";
import { tradingPresetMandate } from "./trading.js";

/** All built-in preset factories, keyed by name. */
export const PRESETS = {
  trading: tradingPresetMandate,
  payments: paymentsPresetMandate,
  refunds: refundsPresetMandate,
} as const;

export type PresetName = keyof typeof PRESETS;
