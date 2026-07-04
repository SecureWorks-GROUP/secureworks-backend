// ════════════════════════════════════════════════════════════
// A3 dropped-WO breadcrumb + empty-feed anomaly (alarm additions)
// ════════════════════════════════════════════════════════════
// Pure-Deno, no network. Extends the #273 extraction-health alarm with:
//   * dropped_wo / live-collision -> alarm regardless of status/freshness
//   * empty-feed anomaly (Graph mirror returning nothing) -> alarm ONLY during Perth
//     business hours, own rate-limit key, fails toward NOT alarming on ambiguity
//
// RUN: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/makesafe_empty_feed_dropped_alarm_test.ts

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkExtractionHealth,
  EMPTY_FEED_STALE_BUSINESS_HOURS,
  EMPTY_FEED_STATE_KEY,
  EXTRACTION_HEALTH_STATE_KEY,
  isPerthBusinessHour,
  makesafeExtractionHealthAlarm,
  perthBusinessHoursBetween,
} from "./makesafe_reconcile.ts";

// Perth is UTC+8. Anchors:
const BIZ_NOW = "2026-07-06T07:00:00.000Z"; // Mon 15:00 AWST -> business hours
const NIGHT_NOW = "2026-07-06T14:00:00.000Z"; // Mon 22:00 AWST -> outside business hours
const WEEKEND_NOW = "2026-07-04T04:00:00.000Z"; // Sat 12:00 AWST -> weekend
const INBOUND_8BH_AGO = "2026-07-05T23:00:00.000Z"; // Mon 07:00 AWST (8 biz hours before BIZ_NOW)
const INBOUND_2BH_AGO = "2026-07-06T05:00:00.000Z"; // Mon 13:00 AWST (2 biz hours before BIZ_NOW)
const freshScan = new Date(Date.parse(BIZ_NOW) - 2 * 60_000).toISOString();

// ── business-hours helpers ──
Deno.test("perth hours: business hour detection (weekday day vs night vs weekend)", () => {
  assertEquals(isPerthBusinessHour(Date.parse(BIZ_NOW)), true);
  assertEquals(isPerthBusinessHour(Date.parse(NIGHT_NOW)), false);
  assertEquals(isPerthBusinessHour(Date.parse(WEEKEND_NOW)), false);
});

Deno.test("perth hours: business hours between counts only Mon-Fri 07-18 AWST", () => {
  assertEquals(perthBusinessHoursBetween(Date.parse(INBOUND_8BH_AGO), Date.parse(BIZ_NOW)), 8);
  assertEquals(perthBusinessHoursBetween(Date.parse(INBOUND_2BH_AGO), Date.parse(BIZ_NOW)), 2);
  // a whole weekend contributes zero business hours
  assertEquals(perthBusinessHoursBetween(Date.parse(WEEKEND_NOW), Date.parse("2026-07-05T04:00:00Z")), 0);
});

// ── A3 dropped-WO / live-collision ──
Deno.test("A3: a dropped WO alarms even when status ok + scan fresh", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastScanDroppedWo: 1, lastScanInsertConflictsLive: 0,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.reason, "dropped_wo");
  assertStringIncludes(r.detail, "DROPPED");
});

Deno.test("A3: a live dedup collision alarms (dropped_wo reason)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastScanDroppedWo: 0, lastScanInsertConflictsLive: 2,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.reason, "dropped_wo");
});

Deno.test("A3: healed-only conflicts do NOT alarm (benign recovery)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastScanDroppedWo: 0, lastScanInsertConflictsLive: 0,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.alarm, false);
});

// ── empty-feed anomaly ──
Deno.test("empty-feed: no inbound > threshold business hours DURING business hours -> alarm", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastInboundEmailAt: INBOUND_8BH_AGO,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.alarm, true);
  assertEquals(r.reason, "empty_feed");
  assertStringIncludes(r.detail, "EMPTY");
});

Deno.test("empty-feed: within threshold -> no alarm", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastInboundEmailAt: INBOUND_2BH_AGO,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.alarm, false);
});

Deno.test("empty-feed: OUTSIDE business hours never false-positives (night)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: new Date(Date.parse(NIGHT_NOW) - 2 * 60_000).toISOString(),
    lastInboundEmailAt: "2026-07-03T04:00:00.000Z", // days ago
    lastAlertAt: null, nowIso: NIGHT_NOW,
  });
  assertEquals(r.alarm, false);
});

Deno.test("empty-feed: weekend never false-positives", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: new Date(Date.parse(WEEKEND_NOW) - 2 * 60_000).toISOString(),
    lastInboundEmailAt: "2026-07-01T04:00:00.000Z",
    lastAlertAt: null, nowIso: WEEKEND_NOW,
  });
  assertEquals(r.alarm, false);
});

Deno.test("empty-feed: no last_inbound (blank feed) does NOT alarm (fail toward quiet)", () => {
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastInboundEmailAt: null,
    lastAlertAt: null, nowIso: BIZ_NOW,
  });
  assertEquals(r.alarm, false);
});

Deno.test("empty-feed: uses its OWN rate-limit key, independent of the degraded key", () => {
  // A recent DEGRADED alert (lastAlertAt) must NOT suppress a fresh empty-feed alert.
  const r = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastInboundEmailAt: INBOUND_8BH_AGO,
    lastAlertAt: new Date(Date.parse(BIZ_NOW) - 60_000).toISOString(), // degraded key just fired
    lastEmptyFeedAlertAt: null, // empty-feed key never fired
    nowIso: BIZ_NOW,
  });
  assertEquals(r.reason, "empty_feed");
  assertEquals(r.shouldAlert, true);
  // And a recent empty-feed alert DOES suppress the next one.
  const r2 = checkExtractionHealth({
    extractionStatus: "ok", extractionDegradedReason: null, degradedSince: null,
    lastScanAt: freshScan, lastInboundEmailAt: INBOUND_8BH_AGO,
    lastAlertAt: null,
    lastEmptyFeedAlertAt: new Date(Date.parse(BIZ_NOW) - 60_000).toISOString(),
    nowIso: BIZ_NOW,
  });
  assertEquals(r2.reason, "empty_feed");
  assertEquals(r2.shouldAlert, false);
});

Deno.test("empty-feed: threshold constant is 6 business hours", () => {
  assertEquals(EMPTY_FEED_STALE_BUSINESS_HOURS, 6);
});

// ── DB-bound: alarm writes state under the reason-appropriate key ──
function makeStubClient(opts: { health: any; stateRows: any[] }): any {
  const upserts: any[] = [];
  const from = (table: string) => {
    const chain: any = {
      select: (_c?: string, _o?: any) => chain,
      eq: (_c: string, _v: any) => chain,
      in: (_c: string, _v: any[]) => Promise.resolve({ data: opts.stateRows, error: null }),
      maybeSingle: async () => {
        if (table === "makesafe_intake_health") return { data: opts.health, error: null };
        return { data: null, error: null };
      },
      upsert: (row: any, _o?: any) => { upserts.push({ table, row }); return Promise.resolve({ error: null }); },
    };
    return chain;
  };
  return { from, _upserts: upserts };
}

Deno.test("A3 DB-bound: empty-feed alarm writes state under the empty_feed key", async () => {
  const client = makeStubClient({
    health: { extraction_status: "ok", degraded_reason: null, degraded_since: null, last_scan_at: freshScan, last_scan_dropped_wo: 0, last_scan_insert_conflicts_live: 0, last_inbound_email_at: INBOUND_8BH_AGO },
    stateRows: [],
  });
  const alerts: any[] = [];
  const smses: string[] = [];
  const sink = { logBusinessEvent: async (_c: any, e: any) => { alerts.push(e); }, notifySms: async (t: string) => { smses.push(t); } };
  const r = await makesafeExtractionHealthAlarm(client, sink, { nowIso: BIZ_NOW });
  assertEquals(r.reason, "empty_feed");
  assertEquals(r.alerted, true);
  assert(smses.length >= 1);
  const stateWrite = client._upserts.find((u: any) => u.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite?.row.key, EMPTY_FEED_STATE_KEY);
});

Deno.test("A3 DB-bound: dropped WO alarm writes state under the extraction_degraded key", async () => {
  const client = makeStubClient({
    health: { extraction_status: "ok", degraded_reason: null, degraded_since: null, last_scan_at: freshScan, last_scan_dropped_wo: 1, last_scan_insert_conflicts_live: 0, last_inbound_email_at: freshScan },
    stateRows: [],
  });
  const alerts: any[] = [];
  const sink = { logBusinessEvent: async (_c: any, e: any) => { alerts.push(e); }, notifySms: async () => {} };
  const r = await makesafeExtractionHealthAlarm(client, sink, { nowIso: BIZ_NOW });
  assertEquals(r.reason, "dropped_wo");
  const stateWrite = client._upserts.find((u: any) => u.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite?.row.key, EXTRACTION_HEALTH_STATE_KEY);
});
