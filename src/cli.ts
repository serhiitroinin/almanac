#!/usr/bin/env bun
import { Command } from "commander";
import {
  saveOAuth2Credentials,
  loadTokens,
  buildAuthorizeUrl,
  exchangeCode,
  saveTokens,
  loadOAuth2Credentials,
} from "./lib/oauth2.ts";
import * as out from "./lib/output.ts";
import { error as showError } from "./lib/output.ts";
import { deleteSecret } from "./lib/keychain.ts";
import { importFromLuff } from "./lib/import-luff.ts";
import { readSecret } from "./lib/prompt.ts";
import {
  googleCalendarProvider,
  CALENDAR_OAUTH2_CONFIG,
} from "./providers/google-calendar.ts";
import {
  loadAccounts,
  resolveAccount,
  addAccount,
  removeAccount,
  type AccountConfig,
  type CalEvent,
  parseDateTime,
  todayStart,
  todayEnd,
  daysFromNow,
} from "./types.ts";

// ── Account helpers ─────────────────────────────────────────────

const PROVIDER_FILTER = { provider: "google" as const };

/** All Google accounts (calendar-eligible). */
function calAccounts(): AccountConfig[] {
  return loadAccounts(PROVIDER_FILTER);
}

function resolve(input: string): AccountConfig {
  return resolveAccount(input, PROVIDER_FILTER);
}

// ── Formatting helpers ──────────────────────────────────────────

function fmtTime(iso: string, isAllDay: boolean): string {
  if (isAllDay) return "all-day";
  // Extract HH:MM from ISO datetime
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1]! : iso;
}

function fmtDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

function fmtEvent(e: CalEvent, showDate = true): string {
  const time = e.isAllDay
    ? "  all-day  "
    : `  ${fmtTime(e.start, false)}-${fmtTime(e.end, false)}`;
  const prefix = showDate ? `${fmtDate(e.start)}  ` : "";
  const loc = e.location ? `  @ ${e.location}` : "";
  const recurring = e.recurringEventId ? " (recurring)" : "";
  return `  ${prefix}${time.padEnd(14)}[${e.account}]  ${e.summary}${loc}${recurring}`;
}

function fmtEventDetail(e: CalEvent): string {
  const lines = [
    `  ID:       ${e.id}`,
    `  Summary:  ${e.summary}`,
    `  Start:    ${e.start}`,
    `  End:      ${e.end}`,
    `  All-day:  ${e.isAllDay}`,
    `  Status:   ${e.status}`,
    `  Account:  ${e.account}`,
  ];
  if (e.recurringEventId) {
    lines.push(`  Recurring: yes (series: ${e.recurringEventId})`);
  }
  if (e.location) lines.push(`  Location: ${e.location}`);
  if (e.description) lines.push(`  Notes:    ${e.description.slice(0, 200)}`);
  return lines.join("\n");
}

// ── OAuth2 callback server ──────────────────────────────────────

async function oauthCallbackFlow(
  clientId: string,
  email: string,
  state: string,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1", // bind to loopback only — not exposed on the LAN
      fetch(req) {
        const url = new URL(req.url);
        const error = url.searchParams.get("error");
        if (error) {
          clearTimeout(timeoutId);
          reject(new Error(`OAuth2 error: ${error}`));
          setTimeout(() => server.stop(), 100);
          return new Response(`Authentication failed: ${error}. Close this tab.`, {
            headers: { "Content-Type": "text/plain" },
          });
        }
        const authCode = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!authCode) {
          return new Response("Waiting for OAuth2 callback...", {
            headers: { "Content-Type": "text/plain" },
          });
        }
        if (returnedState !== state) {
          clearTimeout(timeoutId);
          reject(new Error("OAuth2 state mismatch — possible CSRF"));
          setTimeout(() => server.stop(), 100);
          return new Response("State mismatch. Authentication aborted.", {
            headers: { "Content-Type": "text/plain" },
          });
        }
        clearTimeout(timeoutId);
        resolve({ code: authCode, redirectUri });
        setTimeout(() => server.stop(), 100);
        return new Response(
          "Authenticated! You can close this tab and return to the terminal.",
          { headers: { "Content-Type": "text/plain" } },
        );
      },
    });

    redirectUri = `http://localhost:${server.port}`;
    const baseUrl = buildAuthorizeUrl(
      CALENDAR_OAUTH2_CONFIG,
      clientId,
      redirectUri,
      state,
    );
    const authUrl = `${baseUrl}&access_type=offline&prompt=consent&login_hint=${encodeURIComponent(email)}`;

    out.heading(`Authorize ${email}`);
    out.info(`Callback server listening on ${redirectUri}`);
    out.blank();

    Bun.spawn(["open", authUrl]);
    console.log("Browser opened. Complete the OAuth2 consent flow...");

    timeoutId = setTimeout(() => {
      reject(new Error("OAuth2 timeout — no callback received after 2 minutes"));
      server.stop();
    }, 120_000);
  });
}

// ── Program ─────────────────────────────────────────────────────

const program = new Command();
program
  .name("almanac")
  .description("Google Calendar CLI")
  .version("0.1.3")
  .addHelpText("after", `
OVERVIEW
  Native Google Calendar CLI using the Calendar API v3 (REST/JSON).
  Manages multiple Google accounts with short aliases for fast terminal use.
  OAuth2 tokens stored in macOS Keychain per account.

COMMAND CATEGORIES
  Auth:
    auth-setup <id>                 Save OAuth2 client credentials (secret prompted)
    auth-login <account>            OAuth2 flow for a Google account
    accounts                        Manage accounts (list / add / remove)

  Read:
    overview [days]                 Event counts across all accounts
    today [account|all]             Today's events
    week [account|all]              Next 7 days of events
    list <account|all>              Flexible date range query
    agenda [--days N]               Merged timeline across all accounts
    calendars [account|all]         List available calendars
    get <account> <event-id>        Get event details

  Write:
    add <account> <summary> ...     Create an event
    quickadd <account> <text>       Natural language event creation
    update <account> <event-id>     Partial update of an event
    delete <account> <event-id>     Delete an event

ACCOUNTS
  Stored in ~/.config/almanac/accounts.json (not hardcoded).
  Only Google accounts are used for calendar operations.
  Run "almanac accounts" to list, "almanac accounts add" to register.

EXAMPLES
  almanac overview                         Event counts for next 7 days
  almanac today                            Today's events, all accounts
  almanac agenda --days 3                  3-day merged timeline
  almanac add s4t "Team standup" 09:00 09:30
  almanac quickadd s4t "Lunch tomorrow at noon"
  almanac delete s4t abc123

COMPLEMENTARY TOOLS
  pigeon    Email management (Gmail + Fastmail)
  strap   Health recovery and sleep data
  cadence  Training readiness, body battery, steps
`);

// ── Auth commands ───────────────────────────────────────────────

program
  .command("auth-setup <client-id>")
  .description("Save OAuth2 client credentials for Google Calendar (client secret prompted securely)")
  .addHelpText("after", `
Details:
  Stores OAuth2 app credentials in macOS Keychain (service: almanac).
  Shared across all Google accounts — run once, not per account.
  Get credentials from Google Cloud Console > APIs & Credentials.
  The client secret is prompted securely (never passed as an argument).

  The Google Calendar API must be enabled in your Google Cloud project.
  Required scope: https://www.googleapis.com/auth/calendar

  Note: A redirect URI is not needed — the callback server uses a random port.

Example:
  almanac auth-setup 12345.apps.googleusercontent.com
`)
  .action(async (clientId: string) => {
    try {
      const clientSecret = await readSecret("Google OAuth2 client secret: ");
      if (!clientSecret) {
        showError("No client secret provided.");
        process.exit(1);
      }
      // Use http://localhost as placeholder — the callback server picks a random port
      saveOAuth2Credentials("almanac", clientId, clientSecret, "http://localhost");
      out.success("OAuth2 credentials saved for Google Calendar.");
      out.info("Now run: almanac auth-login <alias> for each account");
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("auth-login <account>")
  .description("Authenticate a Google account via OAuth2")
  .addHelpText("after", `
Details:
  Opens a browser for OAuth2 consent. Starts a local callback server
  to receive the authorization code automatically.
  Requires: almanac auth-setup first (one-time).
  Tokens stored per account: almanac-s4t, almanac-st, almanac-ae.

Examples:
  almanac auth-login s4t
  almanac auth-login st
`)
  .action(async (accountInput: string) => {
    try {
      const account = resolve(accountInput);
      const tool = `almanac-${account.alias}`;
      const creds = loadOAuth2Credentials("almanac");
      const state = crypto.randomUUID();

      const { code, redirectUri } = await oauthCallbackFlow(
        creds.clientId,
        account.email,
        state,
      );

      const tokens = await exchangeCode(
        CALENDAR_OAUTH2_CONFIG,
        creds.clientId,
        creds.clientSecret,
        redirectUri,
        code,
      );
      saveTokens(tool, tokens);
      out.success(`Authenticated ${account.email} (tokens saved as ${tool})`);
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

// ── Accounts command ────────────────────────────────────────────

const accountsCmd = program
  .command("accounts")
  .description("Manage configured accounts")
  .addHelpText("after", `
Details:
  Lists Google accounts from ~/.config/almanac/accounts.json and their auth status.
  Only accounts with provider "google" are shown (calendar only works with Google).
  Use "accounts add" to register a new account.
  Use "accounts remove" to unregister an account.
`);

accountsCmd
  .command("list", { isDefault: true })
  .description("List Google accounts and authentication status")
  .action(async () => {
    const accounts = calAccounts();
    if (!accounts.length) {
      out.info('No Google accounts configured. Run: almanac accounts add <alias> <email>');
      return;
    }
    const rows = accounts.map((a) => {
      const tokens = loadTokens(`almanac-${a.alias}`);
      const auth = tokens ? "OK" : "MISSING";
      return [a.alias, a.email, auth];
    });
    out.table(["Alias", "Email", "Auth"], rows);
  });

accountsCmd
  .command("add <alias> <email>")
  .description("Add a new Google account for calendar access")
  .action(async (alias: string, email: string) => {
    try {
      addAccount(alias, email, "google");
      out.success(`Account "${alias}" (${email}) added.`);
      out.info(`Next: almanac auth-login ${alias}`);
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

accountsCmd
  .command("remove <alias>")
  .description("Remove an account and purge its Keychain tokens")
  .action(async (alias: string) => {
    try {
      const account = resolve(alias);
      removeAccount(account.alias);
      // Also purge the account's OAuth tokens so no orphan secrets remain.
      const tool = `almanac-${account.alias}`;
      for (const key of ["access-token", "refresh-token", "expires-at"]) {
        deleteSecret(tool, key);
      }
      out.success(`Account "${account.alias}" removed and Keychain tokens purged.`);
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("auth-import-from-luff")
  .description("One-shot: migrate Google accounts + Keychain auth from the legacy luff cal tool")
  .addHelpText("after", `
Details:
  For users migrating from the 'cal' tool shipped via the luff monorepo.
  Copies, in order:
    1. ~/.config/luff/accounts.json (Google only) → ~/.config/almanac/accounts.json
    2. OAuth app credentials  luff-cal        → almanac
    3. Per-account tokens     luff-cal-<alias> → almanac-<alias>
  Idempotent — re-run is safe. The luff entries are NOT deleted.

Example:
  almanac auth-import-from-luff`)
  .action(() => {
    const { accountsImported, copied, missing } = importFromLuff();
    if (copied.length === 0 && accountsImported === 0) {
      showError("Nothing found under luff (no accounts.json, no luff-cal Keychain entries).");
      process.exit(1);
    }
    out.success(`Imported ${accountsImported} accounts and ${copied.length} Keychain entries from luff:`);
    for (const k of copied) console.log(`  + ${k}`);
    if (missing.length > 0) {
      out.blank();
      out.info(`Missing (not present in luff): ${missing.join(", ")}`);
    }
  });

// ── Read commands ───────────────────────────────────────────────

program
  .command("overview [days]")
  .description("Event counts across all accounts")
  .addHelpText("after", `
Details:
  Checks all Google accounts in parallel and reports event count
  for the upcoming N days (default 7). Failed connections show ERR.

Example:
  almanac overview           # Next 7 days
  almanac overview 14        # Next 14 days
`)
  .action(async (daysArg?: string) => {
    const days = parseInt(daysArg ?? "7", 10);
    const timeMin = todayStart();
    const timeMax = daysFromNow(days);

    out.heading(`Calendar Overview (next ${days} days)`);
    out.blank();

    const accounts = calAccounts();
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const events = await googleCalendarProvider.listEvents(account, timeMin, timeMax);
        return { account, count: events.length };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const account = accounts[i]!;
      if (result.status === "fulfilled") {
        console.log(
          `  ${account.alias.padEnd(4)}  ${account.email.padEnd(38)}  ${result.value.count} events`,
        );
      } else {
        console.log(
          `  ${account.alias.padEnd(4)}  ${account.email.padEnd(38)}  ERR`,
        );
      }
    }
  });

program
  .command("today [account]")
  .description("Today's events")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Shows all events for today. Use "all" or omit the account argument
  to see events across all Google accounts, merged by start time.

Examples:
  almanac today              Today's events, all accounts
  almanac today s4t          Today's events for s4t only
  almanac today --json       JSON output
`)
  .action(async (accountInput?: string, opts?: { json?: boolean }) => {
    const timeMin = todayStart();
    const timeMax = todayEnd();
    await listEventsMulti(accountInput ?? "all", timeMin, timeMax, opts?.json);
  });

program
  .command("week [account]")
  .description("Next 7 days of events")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Shows events for the next 7 days. Use "all" or omit the account
  argument to see a merged timeline across all Google accounts.

Examples:
  almanac week               Next 7 days, all accounts
  almanac week ae            Next 7 days for ae only
  almanac week --json        JSON output
`)
  .action(async (accountInput?: string, opts?: { json?: boolean }) => {
    const timeMin = todayStart();
    const timeMax = daysFromNow(7);
    await listEventsMulti(accountInput ?? "all", timeMin, timeMax, opts?.json);
  });

program
  .command("list <account>")
  .description("Flexible date range event query")
  .option("--days <n>", "Number of days from today", "7")
  .option("--from <date>", "Start date (YYYY-MM-DD)")
  .option("--to <date>", "End date (YYYY-MM-DD)")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Query events with flexible date ranges. Use "all" for every account.

  By default, shows the next 7 days. Override with --days, or use
  explicit --from/--to for an arbitrary range.

Options:
  --days N       Number of days from today (default 7)
  --from DATE    Start date (YYYY-MM-DD), overrides --days
  --to DATE      End date (YYYY-MM-DD), overrides --days

Examples:
  almanac list s4t                           Next 7 days
  almanac list all --days 30                 Next 30 days, all accounts
  almanac list ae --from 2026-03-01 --to 2026-03-15
  almanac list s4t --json                    JSON output
`)
  .action(async (accountInput: string, opts: { days?: string; from?: string; to?: string; json?: boolean }) => {
    let timeMin: string;
    let timeMax: string;

    if (opts.from) {
      timeMin = new Date(opts.from).toISOString();
      timeMax = opts.to
        ? new Date(`${opts.to}T23:59:59`).toISOString()
        : daysFromNow(parseInt(opts.days ?? "7", 10));
    } else {
      timeMin = todayStart();
      timeMax = daysFromNow(parseInt(opts.days ?? "7", 10));
    }

    await listEventsMulti(accountInput, timeMin, timeMax, opts.json);
  });

program
  .command("agenda")
  .description("Merged timeline across all accounts")
  .option("--days <n>", "Number of days", "3")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  The key scheduling command. Fetches events from ALL Google accounts,
  merges them into a single timeline sorted by start time.

  Events show [alias] prefix to indicate which account they belong to.
  All-day events appear at the top of each day.

Options:
  --days N    Number of days to look ahead (default 3)
  --json      Output raw JSON array

Examples:
  almanac agenda               Next 3 days
  almanac agenda --days 7      Full week ahead
  almanac agenda --json        JSON output
`)
  .action(async (opts: { days?: string; json?: boolean }) => {
    const days = parseInt(opts.days ?? "3", 10);
    const timeMin = todayStart();
    const timeMax = daysFromNow(days);

    const accounts = calAccounts();
    const allEvents: CalEvent[] = [];

    const results = await Promise.allSettled(
      accounts.map(async (account) =>
        googleCalendarProvider.listEvents(account, timeMin, timeMax),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "fulfilled") {
        allEvents.push(...result.value);
      } else {
        const account = accounts[i]!;
        console.error(`[${account.alias}] ERROR: ${(result.reason as Error).message}`);
      }
    }

    // Sort: all-day first within each date, then by start time
    allEvents.sort((a, b) => {
      const dateA = fmtDate(a.start);
      const dateB = fmtDate(b.start);
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      return a.start.localeCompare(b.start);
    });

    if (opts.json) {
      out.json(allEvents);
      return;
    }

    out.heading(`Agenda (next ${days} days)`);
    out.blank();

    if (!allEvents.length) {
      console.log("  No events.");
      return;
    }

    let currentDate = "";
    for (const e of allEvents) {
      const date = fmtDate(e.start);
      if (date !== currentDate) {
        if (currentDate) out.blank();
        const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
        out.subheading(`  ${date} — ${dayName}`);
        currentDate = date;
      }
      console.log(fmtEvent(e, false));
    }
  });

program
  .command("get <account> <event-id>")
  .description("Get event details")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Fetches a single event by ID and displays full details.

Examples:
  almanac get s4t abc123def456
  almanac get ae event_id_here --json
`)
  .action(async (accountInput: string, eventId: string, opts: { json?: boolean }) => {
    try {
      const account = resolve(accountInput);
      const event = await googleCalendarProvider.getEvent(account, eventId);

      if (opts.json) {
        out.json(event);
        return;
      }

      console.log(fmtEventDetail(event));
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("calendars [account]")
  .description("List available calendars")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Lists all calendars visible to an account. Use "all" or omit
  the account to list calendars for all Google accounts.

  Shows calendar ID, name, primary status, timezone, and access role.

Examples:
  almanac calendars           All accounts
  almanac calendars s4t       Just s4t
  almanac calendars --json    JSON output
`)
  .action(async (accountInput?: string, opts?: { json?: boolean }) => {
    const accounts = accountInput && accountInput !== "all"
      ? [resolve(accountInput)]
      : calAccounts();

    for (const account of accounts) {
      try {
        const cals = await googleCalendarProvider.listCalendars(account);

        if (opts?.json) {
          out.json(cals);
          continue;
        }

        console.log(`[${account.alias}] ${account.email}`);
        out.blank();
        const rows = cals.map((c) => [
          c.id.length > 40 ? c.id.slice(0, 37) + "..." : c.id,
          c.summary,
          c.primary ? "primary" : "",
          c.timeZone,
          c.accessRole,
        ]);
        out.table(["ID", "Name", "Primary", "Timezone", "Role"], rows);
        out.blank();
      } catch (e) {
        console.log(`[${account.alias}] ERROR: ${(e as Error).message}`);
      }
    }
  });

// ── Write commands ──────────────────────────────────────────────

program
  .command("add <account> <summary> <start> <end>")
  .description("Create an event")
  .option("--location <loc>", "Event location")
  .option("--description <desc>", "Event description/notes")
  .option("--allday", "Create an all-day event")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Creates a new event on the account's primary calendar.

  Time formats accepted:
    2026-02-14T10:00      ISO with T separator
    2026-02-14 10:00      Date and time with space
    10:00                 Time only (uses today's date)
    2026-02-14            Date only (for all-day events)

  Timezone defaults to Europe/Amsterdam.

Options:
  --location <loc>       Venue or address
  --description <desc>   Notes or description
  --allday               Create as all-day event (start/end as dates)
  --json                 Output created event as JSON

Examples:
  almanac add s4t "Team standup" 09:00 09:30
  almanac add ae "Offsite" "2026-03-01 09:00" "2026-03-01 17:00" --location "Amsterdam"
  almanac add s4t "Holiday" 2026-03-10 2026-03-11 --allday
  almanac add st "Dentist" 14:00 15:00 --description "Annual checkup"
`)
  .action(async (
    accountInput: string,
    summary: string,
    startInput: string,
    endInput: string,
    opts: { location?: string; description?: string; allday?: boolean; json?: boolean },
  ) => {
    try {
      const account = resolve(accountInput);
      const start = parseDateTime(startInput);
      const end = parseDateTime(endInput);

      const event = await googleCalendarProvider.createEvent(account, {
        summary,
        start,
        end,
        location: opts.location,
        description: opts.description,
        allDay: opts.allday,
      });

      if (opts.json) {
        out.json(event);
        return;
      }

      out.success(`Created: ${event.summary}`);
      console.log(fmtEventDetail(event));
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("quickadd <account> <text>")
  .description("Natural language event creation")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Uses Google's natural language parsing to create an event.
  Google interprets dates, times, and recurrence from free-form text.

Examples:
  almanac quickadd s4t "Lunch tomorrow at noon"
  almanac quickadd ae "Team meeting every Monday at 10am"
  almanac quickadd st "Dentist appointment Feb 20 at 2pm"
`)
  .action(async (accountInput: string, text: string, opts: { json?: boolean }) => {
    try {
      const account = resolve(accountInput);
      const event = await googleCalendarProvider.quickAdd(account, text);

      if (opts.json) {
        out.json(event);
        return;
      }

      out.success(`Created: ${event.summary}`);
      console.log(fmtEventDetail(event));
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("update <account> <event-id>")
  .description("Partial update of an event")
  .option("--summary <text>", "New title")
  .option("--start <time>", "New start time")
  .option("--end <time>", "New end time")
  .option("--location <loc>", "New location")
  .option("--description <desc>", "New description")
  .option("--allday", "Treat start/end as all-day dates")
  .option("--json", "Output raw JSON")
  .addHelpText("after", `
Details:
  Updates specific fields of an existing event (PATCH semantics).
  Only the fields you specify are changed — others remain untouched.

  Recurring events:
    Using the instance ID (with _YYYYMMDDTHHMMSSZ suffix) updates
    ONLY that single occurrence — other instances stay unchanged.
    To update all future instances, use the series ID shown by "almanac get".

Options:
  --summary <text>       New event title
  --start <time>         New start time (same formats as "add")
  --end <time>           New end time
  --location <loc>       New location
  --description <desc>   New description
  --allday               Treat start/end as all-day dates
  --json                 Output updated event as JSON

Examples:
  almanac update s4t abc123 --summary "Renamed meeting"
  almanac update ae abc123 --start "15:00" --end "16:00"
  almanac update st abc123 --location "Room 301"
  almanac update s4t abc123 --start 2026-03-10 --end 2026-03-11 --allday
`)
  .action(async (
    accountInput: string,
    eventId: string,
    opts: {
      summary?: string;
      start?: string;
      end?: string;
      location?: string;
      description?: string;
      allday?: boolean;
      json?: boolean;
    },
  ) => {
    try {
      const account = resolve(accountInput);
      const updates: Record<string, string | boolean | undefined> = {};
      if (opts.summary) updates.summary = opts.summary;
      if (opts.start) updates.start = parseDateTime(opts.start);
      if (opts.end) updates.end = parseDateTime(opts.end);
      if (opts.location) updates.location = opts.location;
      if (opts.description) updates.description = opts.description;
      if (opts.allday) updates.allDay = true;

      if (!Object.keys(updates).length) {
        showError("No updates specified. Use --summary, --start, --end, --location, or --description.");
        process.exit(1);
      }

      const event = await googleCalendarProvider.updateEvent(account, eventId, updates);

      if (opts.json) {
        out.json(event);
        return;
      }

      out.success(`Updated: ${event.summary}`);
      console.log(fmtEventDetail(event));
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("delete <account> <event-id>")
  .description("Delete an event")
  .addHelpText("after", `
Details:
  Deletes an event from the account's primary calendar.
  This is permanent — the event cannot be recovered.

  Recurring events:
    Using the instance ID (with _YYYYMMDDTHHMMSSZ suffix) cancels
    ONLY that single occurrence — the rest of the series continues.
    To delete the entire series, use the series ID shown by "almanac get".

Examples:
  almanac delete s4t abc123def456
  almanac delete ae event_id_here
`)
  .action(async (accountInput: string, eventId: string) => {
    try {
      const account = resolve(accountInput);
      const result = await googleCalendarProvider.deleteEvent(account, eventId);
      if (result.ok) {
        out.success(`Deleted event ${eventId}`);
      } else {
        showError(`Failed to delete: ${result.error}`);
        process.exit(1);
      }
    } catch (e) {
      showError((e as Error).message);
      process.exit(1);
    }
  });

// ── Multi-account list helper ───────────────────────────────────

async function listEventsMulti(
  accountInput: string,
  timeMin: string,
  timeMax: string,
  jsonOutput?: boolean,
): Promise<void> {
  const accounts = accountInput === "all"
    ? calAccounts()
    : [resolve(accountInput)];

  const allEvents: CalEvent[] = [];

  for (const account of accounts) {
    try {
      const events = await googleCalendarProvider.listEvents(account, timeMin, timeMax);
      allEvents.push(...events);
    } catch (e) {
      console.error(`[${account.alias}] ERROR: ${(e as Error).message}`);
    }
  }

  allEvents.sort((a, b) => {
    const dateA = fmtDate(a.start);
    const dateB = fmtDate(b.start);
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    return a.start.localeCompare(b.start);
  });

  if (jsonOutput) {
    out.json(allEvents);
    return;
  }

  if (!allEvents.length) {
    console.log("  No events.");
    return;
  }

  let currentDate = "";
  for (const e of allEvents) {
    const date = fmtDate(e.start);
    if (date !== currentDate) {
      if (currentDate) out.blank();
      const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
      out.subheading(`  ${date} — ${dayName}`);
      currentDate = date;
    }
    console.log(fmtEvent(e, false));
  }
}

// ── Run ─────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((e) => {
  showError((e as Error).message);
  process.exit(1);
});
