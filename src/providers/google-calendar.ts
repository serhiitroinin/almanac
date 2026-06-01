import { HttpClient } from "../lib/http.ts";
import { getValidAccessToken, type OAuth2Config } from "../lib/oauth2.ts";
import {
  DEFAULT_TZ,
  type AccountConfig,
  type CalendarProvider,
  type CalendarInfo,
  type CalEvent,
  type ActionResult,
  type CreateEventInput,
} from "../types.ts";

const BASE_URL = "https://www.googleapis.com/calendar/v3";

export const CALENDAR_OAUTH2_CONFIG: OAuth2Config = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/calendar",
  ],
};

// ── Raw API types ────────────────────────────────────────────────

interface GCalCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  timeZone: string;
  accessRole: string;
}

interface GCalDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GCalEvent {
  id: string;
  summary?: string;
  start: GCalDateTime;
  end: GCalDateTime;
  location?: string;
  description?: string;
  status: string;
  htmlLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
}

interface GCalEventList {
  items?: GCalEvent[];
  nextPageToken?: string;
}

interface GCalCalendarList {
  items?: GCalCalendarListEntry[];
  nextPageToken?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function toolName(account: AccountConfig): string {
  return `almanac-${account.alias}`;
}

async function client(account: AccountConfig): Promise<HttpClient> {
  const token = await getValidAccessToken(toolName(account), CALENDAR_OAUTH2_CONFIG, "almanac");
  return new HttpClient({
    baseUrl: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

function toCalendarInfo(entry: GCalCalendarListEntry): CalendarInfo {
  return {
    id: entry.id,
    summary: entry.summary,
    primary: entry.primary ?? false,
    timeZone: entry.timeZone,
    accessRole: entry.accessRole,
  };
}

function toCalEvent(event: GCalEvent, account: AccountConfig): CalEvent {
  const isAllDay = !!event.start.date;
  return {
    id: event.id,
    summary: event.summary ?? "(no title)",
    start: event.start.dateTime ?? event.start.date ?? "",
    end: event.end.dateTime ?? event.end.date ?? "",
    location: event.location,
    description: event.description,
    isAllDay,
    status: event.status,
    account: account.alias,
    recurringEventId: event.recurringEventId,
  };
}

/** URL-encode event ID for use in API paths. */
function encodeEventId(eventId: string): string {
  return encodeURIComponent(eventId);
}

function buildEventBody(input: CreateEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.summary,
  };
  if (input.location) body.location = input.location;
  if (input.description) body.description = input.description;

  if (input.allDay) {
    // All-day: use date fields (YYYY-MM-DD)
    // Google API end date is exclusive, so always +1 day (user input is inclusive)
    body.start = { date: input.start.split("T")[0] };
    const endDate = input.end.split("T")[0]!;
    const d = new Date(endDate);
    d.setDate(d.getDate() + 1);
    body.end = { date: d.toISOString().split("T")[0]! };
  } else {
    body.start = { dateTime: input.start, timeZone: DEFAULT_TZ };
    body.end = { dateTime: input.end, timeZone: DEFAULT_TZ };
  }

  return body;
}

// ── Provider ─────────────────────────────────────────────────────

export const googleCalendarProvider: CalendarProvider = {
  async listCalendars(account) {
    const http = await client(account);
    const list = await http.get<GCalCalendarList>("/users/me/calendarList");
    return (list.items ?? []).map(toCalendarInfo);
  },

  async listEvents(account, timeMin, timeMax) {
    const http = await client(account);
    let all: CalEvent[] = [];
    let pageToken: string | undefined;

    for (let i = 0; i < 10; i++) {
      const params: Record<string, string> = {
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      };
      if (pageToken) params.pageToken = pageToken;

      const list = await http.get<GCalEventList>("/calendars/primary/events", params);
      const events = (list.items ?? [])
        .filter((e) => e.status !== "cancelled")
        .map((e) => toCalEvent(e, account));
      all = all.concat(events);

      if (!list.nextPageToken) break;
      pageToken = list.nextPageToken;
    }

    return all;
  },

  async getEvent(account, eventId) {
    const http = await client(account);
    const event = await http.get<GCalEvent>(`/calendars/primary/events/${encodeEventId(eventId)}`);
    return toCalEvent(event, account);
  },

  async createEvent(account, input) {
    const http = await client(account);
    const body = buildEventBody(input);
    const event = await http.post<GCalEvent>("/calendars/primary/events", body);
    return toCalEvent(event, account);
  },

  async quickAdd(account, text) {
    const http = await client(account);
    const event = await http.post<GCalEvent>(
      `/calendars/primary/events/quickAdd?text=${encodeURIComponent(text)}`
    );
    return toCalEvent(event, account);
  },

  async updateEvent(account, eventId, updates) {
    const http = await client(account);
    const body: Record<string, unknown> = {};
    if (updates.summary) body.summary = updates.summary;
    if (updates.location) body.location = updates.location;
    if (updates.description) body.description = updates.description;

    if (updates.allDay) {
      if (updates.start) body.start = { date: updates.start.split("T")[0] };
      if (updates.end) {
        const endDate = updates.end.split("T")[0]!;
        const d = new Date(endDate);
        d.setDate(d.getDate() + 1);
        body.end = { date: d.toISOString().split("T")[0]! };
      }
    } else {
      if (updates.start) body.start = { dateTime: updates.start, timeZone: DEFAULT_TZ };
      if (updates.end) body.end = { dateTime: updates.end, timeZone: DEFAULT_TZ };
    }

    const event = await http.request<GCalEvent>(`/calendars/primary/events/${encodeEventId(eventId)}`, {
      method: "PATCH",
      body,
    });
    return toCalEvent(event, account);
  },

  async deleteEvent(account, eventId) {
    const http = await client(account);
    try {
      await http.delete(`/calendars/primary/events/${encodeEventId(eventId)}`);
      return { id: eventId, ok: true };
    } catch (e) {
      return { id: eventId, ok: false, error: (e as Error).message };
    }
  },
};
