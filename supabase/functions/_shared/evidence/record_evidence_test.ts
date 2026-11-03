// T7 Loop 1 — Tests for recordEvidence + match + evidence_ref + storage helpers.
//
// Run from secureworks-site/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/evidence/record_evidence_test.ts
//
// All tests use dry_run mode + fake Supabase. No live DB calls.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EvidenceCapture,
  BODY_PREVIEW_MAX,
  SAFE_SUMMARY_MAX,
} from "./types.ts";
import { recordEvidence } from "./record_evidence.ts";
import { _resetFlagCache } from "./feature_flag.ts";

// ---------- Fake Supabase ----------

interface InsertCall {
  table: string;
  values: Record<string, unknown>;
}

interface FakeOpts {
  failOn?: string;
  spineId?: string;
  enqueueId?: string;
  /** When true (default), the flag reader returns evidence_capture_v1 enabled. */
  flagOn?: boolean;
}

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(opts: FakeOpts = {}): { client: any; calls: InsertCall[] } {
  _resetFlagCache(); // every test starts with a clean flag cache
  const calls: InsertCall[] = [];
  const flagOn = opts.flagOn ?? true; // default ON to mirror the live-writer assumption

  // Real-Supabase semantics:
  //   .insert(values)                         -> data: null (just await it)
  //   .insert(values).select(cols)            -> data: [row]
  //   .insert(values).select(cols).single()   -> data: row
  // The mock honors all three so a writer that forgets to chain .select()
  // gets data:null in the test (matching prod behavior) instead of being
  // saved by an over-generous fake.
  function insertResultForTable(table: string) {
    if (opts.failOn === table) {
      return { rows: null as Array<Record<string, unknown>> | null, error: { message: "simulated failure" } };
    }
    if (table === "business_events") {
      return {
        rows: [{ id: opts.spineId ?? "spine-uuid-1", occurred_at: "2026-05-02T00:00:00Z" }],
        error: null as { message: string } | null,
      };
    }
    if (table === "extraction_jobs") {
      return { rows: [{ id: opts.enqueueId ?? "queue-uuid-1" }], error: null };
    }
    return { rows: [] as Array<Record<string, unknown>>, error: null };
  }

  // deno-lint-ignore no-explicit-any
  const client: any = {
    rpc: () => Promise.resolve({ data: true, error: null }),
    from(table: string) {
      return {
        // SELECT chain used by the feature_flag reader.
        // deno-lint-ignore no-explicit-any
        select(_cols: string): any {
          const chain = {
            // deno-lint-ignore no-explicit-any
            eq(_col: string, _val: unknown): any { return chain; },
            // deno-lint-ignore no-explicit-any
            limit(_n: number): any {
              if (table === "feature_flags") {
                return Promise.resolve({
                  data: [{ enabled: flagOn, shadow_mode: false }],
                  error: null,
                });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        insert(values: unknown): any {
          calls.push({ table, values: values as Record<string, unknown> });
          const r = insertResultForTable(table);
          // Thenable: awaiting the insert directly returns data:null,
          // mirroring real Supabase (which only returns rows when you
          // chain .select()).
          const directThenable: PromiseLike<{ data: null; error: { message: string } | null }> = {
            then(onfulfilled, onrejected) {
              return Promise.resolve({ data: null, error: r.error })
                .then(onfulfilled, onrejected);
            },
          };
          // Attach a .select(cols) chain that DOES return rows.
          // deno-lint-ignore no-explicit-any
          (directThenable as any).select = (_cols: string) => {
            const selectThenable: PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }> = {
              then(onfulfilled, onrejected) {
                return Promise.resolve({ data: r.rows, error: r.error })
                  .then(onfulfilled, onrejected);
              },
            };
            // deno-lint-ignore no-explicit-any
            (selectThenable as any).single = () => {
              return Promise.resolve({
                data: r.rows && r.rows.length > 0 ? r.rows[0] : null,
                error: r.error,
              });
            };
            return selectThenable;
          };
          return directThenable;
        },
      };
    },
  };
  return { client, calls };
}

Deno.test("recordEvidence: body_preview > cap is truncated and warned", async () => {
  const { client } = makeFakeSupabase();
  const longBody = "a".repeat(BODY_PREVIEW_MAX + 200);
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: null,
    body_preview: longBody,
  }, { org_id: "org-1", dry_run: true });
  assertEquals(r.spine_row.match_status, "unresolved");
  assert(r.warnings.some((w) => w.includes("body_preview truncated")));
});

Deno.test("recordEvidence: live insert path writes to business_events", async () => {
  const { client, calls } = makeFakeSupabase({ spineId: "spine-7" });
  const r = await recordEvidence(client, {
    event_type: "note.added",
    source: "ops-api/add_note",
    channel: "note",
    direction: "internal",
    source_table: "job_events",
    source_id: "je-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    body_preview: "Site visit booked",
  }, { org_id: "org-1" });
  assertEquals(r.spine_event_id, "spine-7");
  assertEquals(calls[0].table, "business_events");
  // The retired v1 queue is never written; the live pass reads the spine row.
  assertEquals(calls.length, 1);
});

Deno.test("recordEvidence: channel default privacy classifications", async () => {
  const { client } = makeFakeSupabase();
  const callRow = await recordEvidence(client, {
    event_type: "client.call_complete",
    source: "ghl-webhook-receiver",
    channel: "call",
    direction: "inbound",
    source_table: "business_events",
    source_id: "spine-call-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
  }, { org_id: "org-1", dry_run: true });
  assertEquals(callRow.spine_row.match_status, "matched");

  const auditRow = await recordEvidence(client, {
    event_type: "agent.tool_called",
    source: "mcp",
    channel: "audit",
    direction: "system",
    source_table: "agent_audit_log",
    source_id: "audit-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    no_match_attempted: false as never,
  } as unknown as EvidenceCapture, { org_id: "org-1", dry_run: true });
  assertEquals(auditRow.spine_row.match_status, "matched");
});

Deno.test("recordEvidence: spine insert failure throws and emits failure event", async () => {
  const { client, calls } = makeFakeSupabase({ failOn: "business_events" });
  await assertRejects(
    () => recordEvidence(client, {
      event_type: "client.email_in",
      source: "monitor-inbox",
      channel: "email",
      direction: "inbound",
      source_table: "inbox_events",
      source_id: "evt-9",
      job_id: "SWP-26090",
      match_method: "direct_job_id",
    }, { org_id: "org-1" }),
    Error,
    "spine insert failed",
  );
  // Two calls attempted: original + the failure log (which also fails in this fixture).
  assertEquals(calls.length, 2);
  assertEquals(calls[1].values.event_type, "system.evidence_capture_failed");
});

Deno.test("recordEvidence: SAFE_SUMMARY_MAX honored", async () => {
  const { client } = makeFakeSupabase();
  const big = "X".repeat(SAFE_SUMMARY_MAX + 100);
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    safe_summary: big,
  }, { org_id: "org-1", dry_run: true });
  // We can only check via the ref summary length.
  assert(r.evidence_ref.summary.length <= SAFE_SUMMARY_MAX);
});

Deno.test("recordEvidence: SWP-26090 fixture (T5 verification job)", async () => {
  // Simulates a recent inbox event for the canonical T5 verification job.
  const { client, calls } = makeFakeSupabase({ spineId: "spine-swp-26090-1" });
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "graph-msg-id-abc",
    job_id: "SWP-26090",
    contact_id: "ghl-contact-7",
    match_method: "direct_reference",
    match_confidence: 0.9,
    body_preview: "Re: SWP-26090 — please call me back this afternoon.",
    thread_key: "<thread-id-xyz@graph>",
  }, { org_id: "org-marninstobbe-default" });
  assertEquals(r.spine_row.match_status, "matched");
  assertEquals(r.spine_row.match_method, "direct_reference");
  assertEquals(r.spine_row.match_confidence, 0.99);
  assertEquals(r.evidence_ref.job_id, "SWP-26090");
  assertEquals(r.evidence_ref.thread_key, "<thread-id-xyz@graph>");
  // matched + email channel + job_id present -> spine row only; the retired
  // v1 queue is not written.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "business_events");
});

Deno.test("context envelope retains provider time and full SMS beyond preview", async () => {
  const { client, calls } = makeFakeSupabase();
  const body = "Full message ".repeat(600);
  await recordEvidence(client, {
    event_type: "client.reply", source: "ghl-webhook-receiver", channel: "sms", direction: "inbound",
    source_table: "ghl_webhook", source_id: "message-7", job_id: null,
    contact_id: "contact-fixture", provider_message_id: "ghl:message-7", thread_key: "conversation-2",
    event_at: "2026-09-10T01:02:03.000Z", occurred_at: "2026-09-11T01:02:03.000Z",
    body_preview: body, payload: { message_text: body },
  }, { org_id: "org-1" });
  const row = calls.find(c => c.table === "business_events")!.values;
  assertEquals(row.provider_message_id, "ghl:message-7");
  assertEquals(row.event_at, "2026-09-10T01:02:03.000Z");
  assertEquals(row.occurred_at, "2026-09-11T01:02:03.000Z");
  assertEquals(row.contact_id, "contact-fixture");
  assertEquals((row.payload as Record<string,unknown>).message_text, body);
});

Deno.test("recordEvidence: high-confidence contact hint retained without binding or enqueue", async () => {
  const { client, calls } = makeFakeSupabase({ spineId: "weak-contact-event" });
  const r = await recordEvidence(client, {
    event_type: "call.transcript_completed", source: "transcribe-call", channel: "call",
    direction: "inbound", source_table: "business_events", source_id: "provider-call",
    job_id: "00000000-0000-0000-0000-000000000012", contact_id: "repeat-contact",
    match_method: "contact_id", match_confidence: 1,
    occurred_at: "2026-09-11T02:00:00.000Z", event_at: null,
    body_preview: "Please call about the other job",
  }, { org_id: "test-org" });
  assertEquals(r.spine_row.job_id, null);
  assertEquals((calls[0].values as Record<string, unknown>).event_at, null);
  assertEquals((calls[0].values as Record<string, unknown>).occurred_at, "2026-09-11T02:00:00.000Z");
  assertEquals(((calls[0].values as Record<string, unknown>).metadata as Record<string, unknown>).attribution_hint, {
    job_id: "00000000-0000-0000-0000-000000000012", match_method: "contact_id", match_confidence: 1,
  });
  assertEquals(calls.filter((c) => c.table === "extraction_jobs").length, 0);
});

Deno.test("recordEvidence: provider date survives capture and malformed date stays unknown", async () => {
  for (const [input, expected] of [["2025-01-02T10:00:00+08:00", "2025-01-02T02:00:00.000Z"], ["not-a-date", null], [undefined, null]]) {
    const { client, calls } = makeFakeSupabase({ spineId: "dated-call" });
    await recordEvidence(client, {
      event_type: "call.transcript_completed", source: "transcribe-call", channel: "call",
      direction: "inbound", source_table: "business_events", source_id: "provider-call",
      job_id: null, event_at: input, occurred_at: "2026-09-11T02:00:00.000Z",
      body_preview: "Original statement",
    }, { org_id: "test-org" });
    assertEquals((calls[0].values as Record<string, unknown>).event_at, expected);
  }
});

