import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setSecret } from "./keychain.ts";
import { writeConfig } from "./config.ts";
import type { AccountConfig } from "./accounts.ts";

// Legacy luff locations.
const LUFF_ACCOUNTS = join(homedir(), ".config", "luff", "accounts.json");
const LUFF_CAL_SERVICE = "luff-cal";

function readLuffSecret(service: string, account: string): string | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

export interface ImportSummary {
  accountsImported: number;
  copied: string[];
  missing: string[];
}

/**
 * One-shot migration from the legacy `luff` cal tool:
 *   1. ~/.config/luff/accounts.json (Google only) → ~/.config/almanac/accounts.json
 *   2. OAuth app credentials  luff-cal        → almanac
 *   3. Per-account tokens     luff-cal-<alias> → almanac-<alias>
 *      (access-token / refresh-token / expires-at)
 * Non-destructive: the luff entries are left intact. Only Google accounts are
 * imported — calendar access requires Google.
 */
export function importFromLuff(): ImportSummary {
  const copied: string[] = [];
  const missing: string[] = [];

  // 1. Account registry — Google accounts only.
  let accounts: AccountConfig[] = [];
  if (existsSync(LUFF_ACCOUNTS)) {
    try {
      const all = JSON.parse(readFileSync(LUFF_ACCOUNTS, "utf-8")) as AccountConfig[];
      accounts = all.filter((a) => a.provider === "google");
      writeConfig("accounts", accounts);
    } catch {
      /* leave accounts empty */
    }
  }

  // 2. OAuth app credentials (shared across Google accounts).
  for (const key of ["client-id", "client-secret", "redirect-uri"]) {
    const v = readLuffSecret(LUFF_CAL_SERVICE, key);
    if (v == null) {
      missing.push(`almanac/${key}`);
      continue;
    }
    setSecret("almanac", key, v);
    copied.push(`almanac/${key}`);
  }

  // 3. Per-account tokens.
  for (const acct of accounts) {
    const src = `${LUFF_CAL_SERVICE}-${acct.alias}`;
    const dst = `almanac-${acct.alias}`;
    for (const key of ["access-token", "refresh-token", "expires-at"]) {
      const v = readLuffSecret(src, key);
      if (v == null) {
        missing.push(`${dst}/${key}`);
        continue;
      }
      setSecret(dst, key, v);
      copied.push(`${dst}/${key}`);
    }
  }

  return { accountsImported: accounts.length, copied, missing };
}
