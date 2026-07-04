// ════════════════════════════════════════════════════════════
// B1 — EXTRACTION-HEALTH ALARM TESTS (dead key / scan stall)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Tests checkExtractionHealth pure logic and the DB-bound
// makesafeExtractionHealthAlarm wiring (stub client + captured AlertSink).
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_extraction_health_alarm_test.ts
//
// Covers:
//   - degraded status -> alarm + alert (with reason/since in detail)
//   - fresh scan, ok status -> no alarm
//   - stale last_scan_at (> budget), ok status -> alarm (scan stall)
//   - never-scanned (unknown, no last_scan_at) -> alarm
//   - rate-limit: recent alert suppresses; old alert re-fires
//   - DB-bound: alert emitted + state upserted on the 'extraction_degraded' key
//   - DB-bound: healthy -> no alert, last_ok_at recorded

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkExtractionHealth,
  makesafeExtractionHealthAlarm,
  EXTRACTION_STALE_MINUTES,
  EXTRACTION_HEALTH_STATE_KEY,
  HEARTBEAT_RESEND_HOURS,
} from "./makesafe_reconcile.ts";

const NOW = "2026-07-04T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const fresh = new Date(NOW_MS - 2 * 60_000).toISOString(); // 2 min ago (within budget)
const stale = new Date(NOW_MS - (EXTRACTION_STALE_MINUTES + 5) * 60_000).toISOString();

// ── Pure logic ─────────────────────────────────────────────────────────────────

Deno.test("B1 pure: degraded -> alarm + shouldAlert, detail names reason + since", () => {
  const r = checkExtractionHealth({
    extractionStatus: "degraded",
    extractionDegradedReason: "auth_failed",
    degradedSince: "2026-07-04T06:00:00Z",
    lastScanAt: fresh, // even fresh scans don't matter when degraded
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.reason, "degraded");
  assertEquals(r.shouldAlert, true);
  assertStringIncludes(r.detail, "DEGRADED");
  assertStringIncludes(r.detail, "auth_failed");
  assertStringIncludes(r.detail, "2026-07-04T06:00:00Z");
});

Deno.test("B1 pure: ok + fresh scan -> no alarm", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok",
    extractionDegradedReason: null,
    degradedSince: null,
    lastScanAt: fresh,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.alarm, false);
  assertEquals(r.shouldAlert, false);
});

Deno.test("B1 pure: ok but STALE scan -> alarm (scan stall)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok",
    extractionDegradedReason: null,
    degradedSince: null,
    lastScanAt: stale,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.reason, "stale_scan");
  assertStringIncludes(r.detail, "STALLED");
});

Deno.test("B1 pure: unknown + no last_scan_at -> alarm (never scanned)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "unknown",
    extractionDegradedReason: null,
    degradedSince: null,
    lastScanAt: null,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.reason, "unknown_never_scanned");
});

Deno.test("B1 pure: degraded but alerted 1h ago -> rate-limited (no alert)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "degraded",
    extractionDegradedReason: "key_unset",
    degradedSince: "2026-07-04T06:00:00Z",
    lastScanAt: fresh,
    lastAlertAt: new Date(NOW_MS - 1 * 3_600_000).toISOString(),
    nowIso: NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.shouldAlert, false);
});

Deno.test(`B1 pure: degraded, last alert ${HEARTBEAT_RESEND_HOURS}h ago -> re-fires`, () => {
  const r = checkExtractionHealth({
    extractionStatus: "degraded",
    extractionDegradedReason: "key_unset",
    degradedSince: "2026-07-04T06:00:00Z",
    lastScanAt: fresh,
    lastAlertAt: new Date(NOW_MS - HEARTBEAT_RESEND_HOURS * 3_600_000).toISOString(),
    nowIso: NOW,
  });
  assertEquals(r.shouldAlert, true);
});

// ── DB-bound wiring ──────────────────────────────────────────────────────────────

function makeStubClient(opts: {
  health: any;
  lastAlertAt: string | null;
  healthReadError?: string;
}): any {
  const upsertCalls: any[] = [];
  const from = (table: string) => {
    const chain: any = {
      select: (_c: string, _o?: any) => chain,
      eq: (_c: string, _v: any) => chain,
      maybeSingle: async () => {
        if (table === "makesafe_intake_health") {
          if (opts.healthReadError) return { data: null, error: { message: opts.healthReadError } };
          return { data: opts.health, error: null };
        }
        if (table === "makesafe_heartbeat_state") {
          return { data: opts.lastAlertAt ? { last_alert_at: opts.lastAlertAt } : null, error: null };
        }
        return { data: null, error: null };
      },
      upsert: (row: any, _o?: any) => {
        upsertCalls.push({ table, row });
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  };
  return { from, _upsertCalls: upsertCalls };
}

Deno.test("B1 DB-bound: degraded -> alert emitted + state upserted under extraction_degraded key", async () => {
  const client = makeStubClient({
    health: { extraction_status: "degraded", degraded_reason: "auth_failed", degraded_since: "2026-07-04T06:00:00Z", last_scan_at: fresh },
    lastAlertAt: null,
  });
  const alerts: any[] = [];
  const telegrams: string[] = [];
  const sink = {
    logBusinessEvent: async (_c: any, e: any) => { alerts.push(e); },
    notifySms: async (t: string) => { telegrams.push(t); },
  };
  const r = await makesafeExtractionHealthAlarm(client, sink, { nowIso: NOW });
  assertEquals(r.alarm, true);
  assertEquals(r.alerted, true);
  assertEquals(alerts.length, 1);
  assertStringIncludes(alerts[0].event_type, "makesafe.reconcile.extraction_degraded");
  assertEquals(telegrams.length, 1);
  assertStringIncludes(telegrams[0], "B1-extraction-health");
  const stateWrite = client._upsertCalls.find((c: any) => c.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite?.row.key, EXTRACTION_HEALTH_STATE_KEY);
  assertEquals(stateWrite?.row.last_alert_at, NOW);
});

Deno.test("B1 DB-bound: healthy fresh scan -> no alert, last_ok_at recorded", async () => {
  const client = makeStubClient({
    health: { extraction_status: "ok", degraded_reason: null, degraded_since: null, last_scan_at: fresh },
    lastAlertAt: null,
  });
  const alerts: any[] = [];
  const sink = {
    logBusinessEvent: async (_c: any, e: any) => { alerts.push(e); },
    notifySms: async (_t: string) => {},
  };
  const r = await makesafeExtractionHealthAlarm(client, sink, { nowIso: NOW });
  assertEquals(r.alarm, false);
  assertEquals(alerts.length, 0);
  const stateWrite = client._upsertCalls.find((c: any) => c.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite?.row.last_ok_at, NOW);
});

Deno.test("B1 DB-bound: stale scan on an ok row -> alert fires", async () => {
  const client = makeStubClient({
    health: { extraction_status: "ok", degraded_reason: null, degraded_since: null, last_scan_at: stale },
    lastAlertAt: null,
  });
  const alerts: any[] = [];
  const sink = {
    logBusinessEvent: async (_c: any, e: any) => { alerts.push(e); },
    notifySms: async (_t: string) => {},
  };
  const r = await makesafeExtractionHealthAlarm(client, sink, { nowIso: NOW });
  assertEquals(r.reason, "stale_scan");
  assertEquals(r.alerted, true);
  assertEquals(alerts.length, 1);
});

Deno.test("B1 DB-bound: health read error FAILS CLOSED (throws)", async () => {
  const client = makeStubClient({ health: null, lastAlertAt: null, healthReadError: "boom" });
  const sink = { logBusinessEvent: async () => {}, notifySms: async () => {} };
  let threw = false;
  try {
    await makesafeExtractionHealthAlarm(client, sink, { nowIso: NOW });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "extraction health read failed");
  }
  assertEquals(threw, true);
});
