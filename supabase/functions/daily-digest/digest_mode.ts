// What one daily-digest request does (P0-14.3, 17 Nov 2026).
//
// One open ops page used to re-run the whole digest build every 5 minutes: a
// run that failed never filled the page's 30 minute cache. On Monday 16 Nov
// that was 177 runs, about 112,600 reads and 2,300 model calls. A screen or an
// agent now gets the last stored digest in one read; only a server caller
// builds, and the cron's build is once a day.

export type DigestMode = "stored" | "build" | "canary" | "forbidden" | "other";

export function digestMode(input: {
  action: string | null;
  method: string;
  isServerCaller: boolean;
}): DigestMode {
  const { action, method, isServerCaller } = input;
  if (action === "build") return isServerCaller ? "build" : "forbidden";
  if (action === "canary") return isServerCaller ? "canary" : "forbidden";
  if (action === "latest") return "stored";
  // No action: the old timer's shape (a server POST) still builds, so nothing
  // breaks before the timer is changed to call action=build by name.
  if (!action) {
    return isServerCaller && method.toUpperCase() === "POST"
      ? "build"
      : "stored";
  }
  return "other";
}

export interface StoredDigestRow {
  digest_date: string | null;
  digest_json: Record<string, unknown> | null;
}

/**
 * The stored read's body. A row: the digest as built, marked stored, with the
 * day it was built for. No row: an empty digest marked not built yet, so a
 * screen never reads "all clear" from a digest that does not exist.
 */
export function storedDigestBody(
  row: StoredDigestRow | null,
): Record<string, unknown> {
  if (row && row.digest_json && typeof row.digest_json === "object") {
    return { ...row.digest_json, stored: true, digest_date: row.digest_date };
  }
  return {
    alerts: [],
    summary_text: "",
    stored: true,
    digest_date: null,
    not_built_yet: true,
  };
}

const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8, no daylight saving

/**
 * Monday in Perth. The build runs at 23:00 UTC on Sunday, which is 07:00 on
 * Monday in Perth, so a check on the UTC day would never be true in that run.
 */
export function isMondayPerth(now: Date): boolean {
  return new Date(now.getTime() + PERTH_OFFSET_MS).getUTCDay() === 1;
}
