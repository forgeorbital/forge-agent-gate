/**
 * Timezone-aware trading-hours helpers.
 *
 * Pure and deterministic given an input `Date`. Uses the platform's Intl
 * timezone database so no extra dependency is required.
 */

export interface LocalTime {
  /** 0 = Sunday ... 6 = Saturday, in the target timezone. */
  weekday: number;
  /** Minutes since local midnight in the target timezone (0..1439). */
  minutes: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolve the wall-clock weekday and minute-of-day for `now` in IANA `tz`.
 * Throws a RangeError if `tz` is not a valid timezone identifier.
 */
export function localTimeInZone(now: Date, tz: string): LocalTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  let weekday = -1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") {
      weekday = WEEKDAYS[part.value] ?? -1;
    } else if (part.type === "hour") {
      // Some ICU builds emit "24" for midnight; normalize to 0..23.
      hour = Number.parseInt(part.value, 10) % 24;
    } else if (part.type === "minute") {
      minute = Number.parseInt(part.value, 10);
    }
  }
  return { weekday, minutes: hour * 60 + minute };
}

/** Parse "HH:MM" (24h) to minutes since midnight, or null if malformed. */
export function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface TradingWindow {
  /** Allowed weekdays (0=Sun..6=Sat). Omitted or empty = every day. */
  days?: number[];
  /** Window open time "HH:MM" local to the mandate timezone (inclusive). */
  start: string;
  /** Window close time "HH:MM" local to the mandate timezone (exclusive). */
  end: string;
}

/**
 * True if `local` falls inside `window`. Supports windows that wrap past
 * midnight (end <= start). A window with unparseable bounds never matches
 * (fail-closed). The weekday check is applied to the window's opening day.
 */
export function isWithinWindow(local: LocalTime, window: TradingWindow): boolean {
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === null || end === null) return false;

  if (window.days && window.days.length > 0 && !window.days.includes(local.weekday)) {
    return false;
  }

  const m = local.minutes;
  if (start <= end) {
    // Same-day window: [start, end).
    return m >= start && m < end;
  }
  // Wrap-around window: [start, 24:00) U [00:00, end).
  return m >= start || m < end;
}

/** True if `local` is inside at least one of the supplied windows. */
export function isWithinAnyWindow(local: LocalTime, windows: TradingWindow[]): boolean {
  return windows.some((w) => isWithinWindow(local, w));
}
