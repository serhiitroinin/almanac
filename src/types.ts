import type { AccountConfig, ProviderType } from "./lib/accounts.ts";
import { loadAccounts, resolveAccount, addAccount, removeAccount } from "./lib/accounts.ts";

export type { AccountConfig, ProviderType };
export { loadAccounts, resolveAccount, addAccount, removeAccount };

// ── Calendar Types ──────────────────────────────────────────────

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  timeZone: string;
  accessRole: string;
}

export interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  isAllDay: boolean;
  status: string;
  account: string;
  recurringEventId?: string;
}

export interface ActionResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface CalendarProvider {
  listCalendars(account: AccountConfig): Promise<CalendarInfo[]>;
  listEvents(account: AccountConfig, timeMin: string, timeMax: string): Promise<CalEvent[]>;
  getEvent(account: AccountConfig, eventId: string): Promise<CalEvent>;
  createEvent(account: AccountConfig, event: CreateEventInput): Promise<CalEvent>;
  quickAdd(account: AccountConfig, text: string): Promise<CalEvent>;
  updateEvent(account: AccountConfig, eventId: string, updates: Partial<CreateEventInput>): Promise<CalEvent>;
  deleteEvent(account: AccountConfig, eventId: string): Promise<ActionResult>;
}

export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  allDay?: boolean;
}

// ── Time Helpers ────────────────────────────────────────────────

export const DEFAULT_TZ = "Europe/Amsterdam";

/** Get current timezone offset string like "+01:00" */
function tzOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/** Ensure datetime has seconds (HH:MM → HH:MM:00) */
function ensureSeconds(dt: string): string {
  return dt.replace(/T(\d{2}:\d{2})([+-])/, "T$1:00$2");
}

/**
 * Parse flexible time input to RFC3339 datetime.
 * Accepts: "2026-02-14T10:00", "2026-02-14 10:00", "10:00" (today), "HH:MM"
 */
export function parseDateTime(input: string): string {
  // Already RFC3339 with offset
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/.test(input)) {
    return ensureSeconds(input);
  }
  // ISO with T but no offset
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    const withOffset = `${input}${tzOffset()}`;
    return ensureSeconds(withOffset);
  }
  // Date + space + time
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    const withOffset = `${input.replace(/\s+/, "T")}${tzOffset()}`;
    return ensureSeconds(withOffset);
  }
  // Just time (HH:MM or HH:MM:SS) — use today's date
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    const today = new Date().toISOString().split("T")[0];
    const withOffset = `${today}T${input}${tzOffset()}`;
    return ensureSeconds(withOffset);
  }
  // Just a date (all-day)
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  throw new Error(`Cannot parse time: "${input}". Use YYYY-MM-DD HH:MM or HH:MM`);
}

/** Start of today in RFC3339 */
export function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** End of today in RFC3339 */
export function todayEnd(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** N days from now in RFC3339 */
export function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
