import type { AppConfig } from "../config.js";
import { KalshiAdapter } from "./kalshi.js";
import { PmxtAdapter } from "./pmxt.js";
import type { VenueAdapter } from "./types.js";

/** Construct the venue adapters that the current config has credentials for. */
export function buildAdapters(config: AppConfig): VenueAdapter[] {
  const adapters: VenueAdapter[] = [];
  if (config.kalshi) adapters.push(new KalshiAdapter(config.kalshi));
  if (config.pmxt) adapters.push(new PmxtAdapter(config.pmxt));
  return adapters;
}

export { KalshiAdapter } from "./kalshi.js";
export { PmxtAdapter } from "./pmxt.js";
export * from "./types.js";
