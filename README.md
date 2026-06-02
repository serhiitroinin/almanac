# almanac

A terminal CLI for **Google Calendar** — a merged agenda, event counts, and event
create/update/delete across multiple Google accounts, from your shell. Uses the Calendar
API v3 (REST/JSON) with OAuth2.

The name is the almanac — a calendar of days. This is an unofficial third-party CLI.

## Install

```sh
brew install serhiitroinin/tap/almanac
```

Or run from source with [Bun](https://bun.sh) ≥ 1.3.9 (for the native `Bun.secrets` keychain API):

```sh
bun install
bun run src/cli.ts --help
```

## Setup

Accounts live in `~/.config/almanac/accounts.json` (Google only). Register them, then
authenticate:

```sh
almanac accounts add s4t you@gmail.com

# One-time OAuth2 app credentials (no redirect URI — a random-port callback is used)
almanac auth-setup <client-id>
almanac auth-login s4t

almanac accounts            # list accounts + auth status
```

Tokens are stored in the macOS Keychain (services: `almanac`, `almanac-<alias>`).

## Usage

```sh
almanac agenda --days 7        # merged timeline across all accounts (the key command)
almanac today                  # today's events, all accounts
almanac week                   # next 7 days
almanac overview               # event counts per account
almanac list all --days 30     # flexible range
almanac add s4t "Standup" 09:00 09:30
almanac quickadd s4t "Lunch tomorrow at noon"
almanac update s4t <id> --start 15:00 --end 16:00
almanac delete s4t <id>
almanac calendars              # list available calendars
```

## License

MIT
