// ════════════════════════════════════════════════════════════
// DRAFT-CREATION HEARTBEAT TESTS — D5 (2026-06-18)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Tests the checkDraftCreationHeartbeat pure logic and
// the DB-bound makesafeDraftHeartbeat wiring.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_draft_heartbeat_test.ts
//
// Covers:
//   - emails present + no drafts -> stalled = true, shouldAlert = true
//   - emails present + drafts present -> stalled = false
//   - no emails, no drafts -> stalled = false (pipeline quiet, not a stall)
//   - stalled but alerted recently -> shouldAlert = false (rate-limit)
//   - stalled and last alert was >= HEARTBEAT_RESEND_HOURS ago -> shouldAlert = true (resend)
//   - DB-bound: alert emitted + state upserted on first stall
//   - DB-bound: alert suppressed on second call within resend window

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkDraftCreationHeartbeat,
  makesafeDraftHeartbeat,
  HEARTBEAT_STALL_HOURS,
  HEARTBEAT_RESEND_HOURS,
} from "./makesafe_reconcile.ts";

const NOW = "2026-06-18T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

// ── Pure logic: checkDraftCreationHeartbeat ────────────────────────────────────

Deno.test("heartbeat: emails present, no drafts -> stalled=true, shouldAlert=true (first time)", () => {
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 5,
    recentDraftCount: 0,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.stalled, true);
  assertEquals(r.shouldAlert, true);
  assertStringIncludes(r.detail, "stalled");
  assertStringIncludes(r.detail, "5 builder email");
  assertStringIncludes(r.detail, "0 new intake drafts");
});

Deno.test("heartbeat: emails present, drafts present -> stalled=false", () => {
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 5,
    recentDraftCount: 3,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.stalled, false);
  assertEquals(r.shouldAlert, false);
  assertStringIncludes(r.detail, "healthy");
});

Deno.test("heartbeat: no emails, no drafts -> stalled=false (pipeline quiet, not a stall)", () => {
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 0,
    recentDraftCount: 0,
    lastAlertAt: null,
    nowIso: NOW,
  });
  assertEquals(r.stalled, false);
  assertEquals(r.shouldAlert, false);
  assertStringIncludes(r.detail, "quiet");
});

Deno.test("heartbeat: stalled, alerted 1 hour ago -> shouldAlert=false (rate-limited)", () => {
  // 1 hour ago — within the HEARTBEAT_RESEND_HOURS (4h) window.
  const lastAlertAt = new Date(NOW_MS - 1 * 3_600_000).toISOString();
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 3,
    recentDraftCount: 0,
    lastAlertAt,
    nowIso: NOW,
  });
  assertEquals(r.stalled, true);
  assertEquals(r.shouldAlert, false);
});

Deno.test(`heartbeat: stalled, alerted ${HEARTBEAT_RESEND_HOURS}h ago -> shouldAlert=true (resend)`, () => {
  // Exactly at the resend threshold — should fire again.
  const lastAlertAt = new Date(NOW_MS - HEARTBEAT_RESEND_HOURS * 3_600_000).toISOString();
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 3,
    recentDraftCount: 0,
    lastAlertAt,
    nowIso: NOW,
  });
  assertEquals(r.stalled, true);
  assertEquals(r.shouldAlert, true);
});

Deno.test("heartbeat: stalled, alerted 3h59m ago -> shouldAlert=false (just under resend threshold)", () => {
  const justUnder = HEARTBEAT_RESEND_HOURS * 3_600_000 - 60_000; // 1 min under
  const lastAlertAt = new Date(NOW_MS - justUnder).toISOString();
  const r = checkDraftCreationHeartbeat({
    recentEmailCount: 2,
    recentDraftCount: 0,
    lastAlertAt,
    nowIso: NOW,
  });
  assertEquals(r.stalled, true);
  assertEquals(r.shouldAlert, false);
});

// ── Constants sanity ───────────────────────────────────────────────────────────

Deno.test("heartbeat constants: stall window is 2h, resend threshold is 4h", () => {
  assertEquals(HEARTBEAT_STALL_HOURS, 2);
  assertEquals(HEARTBEAT_RESEND_HOURS, 4);
});

// ── DB-bound wiring: makesafeDraftHeartbeat ────────────────────────────────────
//
// These tests use a minimal stub client and a captured AlertSink to verify the
// DB-bound action emits alerts and updates state correctly, without any network.

// Minimal stub SupabaseClient builder — returns stubbed row counts and state.
function makeStubClient(opts: {
  emailCount: number;
  draftCount: number;
  lastAlertAt: string | null;
  // whether the heartbeat_state table "exists" (true = maybeSingle returns a row or null cleanly)
  stateTableExists?: boolean;
}): any {
  const { emailCount, draftCount, lastAlertAt, stateTableExists = true } = opts;

  // Track upsert calls so we can assert state was written.
  const upsertCalls: any[] = [];

  // Simple chainable builder for .from().select()... queries.
  const from = (table: string) => {
    const chain: any = {
      select: (_cols: string, _opts?: any) => chain,
      eq: (_col: string, _val: any) => chain,
      is: (_col: string, _val: any) => chain,
      gte: (_col: string, _val: any) => chain,
      maybeSingle: async () => {
        if (table === "makesafe_heartbeat_state") {
          if (!stateTableExists) throw new Error("relation does not exist");
          return { data: lastAlertAt ? { last_alert_at: lastAlertAt } : null, error: null };
        }
        return { data: null, error: null };
      },
      // count queries resolve to { count, error }
      then: undefined as any,
    };

    // Attach count-result directly when head:true is passed via select.
    // Re-implement select to detect the { count, head } signature.
    chain.select = (_cols: string, selectOpts?: any) => {
      if (selectOpts?.head && selectOpts?.count === "exact") {
        // Return a count-flavoured chain that resolves immediately.
        const countChain: any = {
          eq: (_c: string, _v: any) => countChain,
          is: (_c: string, _v: any) => countChain,
          gte: (_c: string, _v: any) => countChain,
          // Final resolution.
          then: (resolve: (v: any) => void) => {
            if (table === "emails") resolve({ count: emailCount, error: null });
            else if (table === "makesafe_intake_drafts") resolve({ count: draftCount, error: null });
            else resolve({ count: 0, error: null });
          },
        };
        return countChain;
      }
      return chain;
    };

    chain.upsert = (row: any, _upsertOpts?: any) => {
      upsertCalls.push({ table, row });
      return Promise.resolve({ error: null });
    };

    return chain;
  };

  return { from, _upsertCalls: upsertCalls };
}

Deno.test("DB-bound: emails present, no drafts -> alert emitted, state upserted", async () => {
  const client = makeStubClient({ emailCount: 4, draftCount: 0, lastAlertAt: null });

  const capturedAlerts: any[] = [];
  const capturedTelegrams: string[] = [];
  const sink = {
    logBusinessEvent: async (_client: any, event: any) => { capturedAlerts.push(event); },
    notifyTelegram: async (text: string) => { capturedTelegrams.push(text); },
  };

  const result = await makesafeDraftHeartbeat(client, sink, { nowIso: NOW });

  assertEquals(result.stalled, true);
  assertEquals(result.shouldAlert, true);
  assertEquals(result.alerted, true);
  // Alert was sent to business_events.
  assertEquals(capturedAlerts.length, 1);
  assertStringIncludes(capturedAlerts[0].event_type, "makesafe.reconcile");
  // Telegram notification was sent.
  assertEquals(capturedTelegrams.length, 1);
  assertStringIncludes(capturedTelegrams[0], "D5-heartbeat");
  // State was upserted.
  const stateWrite = client._upsertCalls.find((c: any) => c.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite !== undefined, true);
  assertEquals(stateWrite.row.key, "draft_stall");
  assertEquals(stateWrite.row.last_alert_at, NOW);
});

Deno.test("DB-bound: stalled, alerted 1h ago -> alert suppressed", async () => {
  const lastAlertAt = new Date(NOW_MS - 1 * 3_600_000).toISOString();
  const client = makeStubClient({ emailCount: 2, draftCount: 0, lastAlertAt });

  const capturedAlerts: any[] = [];
  const sink = {
    logBusinessEvent: async (_client: any, event: any) => { capturedAlerts.push(event); },
    notifyTelegram: async (_text: string) => {},
  };

  const result = await makesafeDraftHeartbeat(client, sink, { nowIso: NOW });

  assertEquals(result.stalled, true);
  assertEquals(result.shouldAlert, false);
  assertEquals(result.alerted, false);
  // No alert emitted.
  assertEquals(capturedAlerts.length, 0);
});

Deno.test("DB-bound: emails present, drafts present -> no alert, last_ok_at written", async () => {
  const client = makeStubClient({ emailCount: 3, draftCount: 2, lastAlertAt: null });

  const capturedAlerts: any[] = [];
  const sink = {
    logBusinessEvent: async (_client: any, event: any) => { capturedAlerts.push(event); },
    notifyTelegram: async (_text: string) => {},
  };

  const result = await makesafeDraftHeartbeat(client, sink, { nowIso: NOW });

  assertEquals(result.stalled, false);
  assertEquals(result.alerted, false);
  assertEquals(capturedAlerts.length, 0);
  // last_ok_at was recorded.
  const stateWrite = client._upsertCalls.find((c: any) => c.table === "makesafe_heartbeat_state");
  assertEquals(stateWrite !== undefined, true);
  assertEquals(stateWrite.row.last_ok_at, NOW);
});

Deno.test("DB-bound: heartbeat_state table absent -> graceful degradation, alert still fires", async () => {
  // stateTableExists=false simulates the table not existing yet (deploy ordering).
  const client = makeStubClient({ emailCount: 3, draftCount: 0, lastAlertAt: null, stateTableExists: false });

  const capturedAlerts: any[] = [];
  const sink = {
    logBusinessEvent: async (_client: any, event: any) => { capturedAlerts.push(event); },
    notifyTelegram: async (_text: string) => {},
  };

  const result = await makesafeDraftHeartbeat(client, sink, { nowIso: NOW });

  // Should still detect the stall and alert even without the state table.
  assertEquals(result.stalled, true);
  assertEquals(result.alerted, true);
  assertEquals(capturedAlerts.length, 1);
});
