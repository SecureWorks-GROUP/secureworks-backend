// M0 · U9 — Comms capture-path fixtures (send-path replay).
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U9). Verifier V re-runs this.
//
// Run from secureworks-backend/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/evidence/comms_event_map_test.ts
//
// Proves the forward-fix: a `log_business_event` comms call now plans a COMPLETE
// T7 envelope, and replaying it through recordEvidence writes a business_events
// row with channel + direction + source_table + body — never the NULL/no-body
// shell the old generic insert produced. Non-comms events are untouched.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  commsEnvelopeForEventType,
  extractCommsBody,
  planCommsCaptureFromLog,
} from "./comms_event_map.ts";
import { recordEvidence } from "./record_evidence.ts";

// Minimal fake: records every insert; returns a spine row id on .select().
function makeFake() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          const thenable: Record<string, unknown> = {
            then(onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(onf, onr);
            },
            select(_c: string) {
              return {
                then(onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) {
                  const rows = table === "business_events"
                    ? [{ id: "evt-1", occurred_at: values.occurred_at ?? "2026-07-05T00:00:00Z" }]
                    : [];
                  return Promise.resolve({ data: rows, error: null }).then(onf, onr);
                },
              };
            },
          };
          return thenable;
        },
      };
    },
    storage: {},
  };
  return { client, inserts };
}

Deno.test("event_type -> envelope mapping", () => {
  assertEquals(commsEnvelopeForEventType("client.sms_out"), { channel: "sms", direction: "outbound" });
  assertEquals(commsEnvelopeForEventType("client.sms_in"), { channel: "sms", direction: "inbound" });
  assertEquals(commsEnvelopeForEventType("client.email_out"), { channel: "email", direction: "outbound" });
  assertEquals(commsEnvelopeForEventType("client.email_in"), { channel: "email", direction: "inbound" });
  // Non-comms => null (generic path preserved).
  assertEquals(commsEnvelopeForEventType("job.note"), null);
  assertEquals(commsEnvelopeForEventType("ghl.stage_changed"), null);
});

Deno.test("body extraction key precedence + empties", () => {
  assertEquals(extractCommsBody({ message: "hi there" }), "hi there");
  assertEquals(extractCommsBody({ body: "b", message: "m" }), "m"); // message wins
  assertEquals(extractCommsBody({ text: "t" }), "t");
  assertEquals(extractCommsBody({ message: "   " }), null); // whitespace-only ignored
  assertEquals(extractCommsBody({}), null);
  assertEquals(extractCommsBody(null), null);
});

Deno.test("plan: comms log builds a complete capture; non-comms returns null", () => {
  const plan = planCommsCaptureFromLog({
    event_type: "client.sms_out",
    entity_type: "contact",
    entity_id: "Cabc",
    job_id: "J1",
    payload: { message: "On my way, see you at 2pm", message_id: "ghl-msg-99", contact_id: "Cabc" },
  });
  assert(plan !== null);
  assertEquals(plan!.channel, "sms");
  assertEquals(plan!.direction, "outbound");
  assertEquals(plan!.source_table, "ops_api_log_business_event");
  assertEquals(plan!.source_id, "ghl-msg-99");
  assertEquals(plan!.body_preview, "On my way, see you at 2pm");
  assertEquals(plan!.contact_id, "Cabc");
  assertEquals(plan!.job_id, "J1");
  assertEquals(plan!.match_method, "direct_job_id");

  // Non-comms event => generic path (null plan).
  assertEquals(planCommsCaptureFromLog({ event_type: "job.note", payload: { note: "x" } }), null);
});

Deno.test("send-path replay: recordEvidence writes a FULL envelope (no NULL shell)", async () => {
  const plan = planCommsCaptureFromLog({
    event_type: "client.sms_out",
    entity_type: "contact",
    entity_id: "Cabc",
    job_id: "J1",
    payload: { message: "Quote sent — let me know", message_id: "ghl-1" },
  })!;
  const { client, inserts } = makeFake();
  const ref = await recordEvidence(client, plan, { org_id: "00000000-0000-0000-0000-000000000001", bypass_feature_flag: true });
  assert(ref.spine_event_id === "evt-1");

  const spine = inserts.find((i) => i.table === "business_events")!.values;
  // The columns that were NULL in the 248 broken rows are now all populated.
  assertEquals(spine.channel, "sms");
  assertEquals(spine.direction, "outbound");
  assertEquals(spine.source_table, "ops_api_log_business_event");
  assert(spine.body_preview != null && String(spine.body_preview).length > 0);
  assertEquals(spine.match_status, "matched"); // job_id + direct_job_id
});

Deno.test("before/after NULL-rate on the write path: 1/1 -> 0/1", async () => {
  const input = {
    event_type: "client.sms_out",
    entity_type: "contact",
    entity_id: "Cabc",
    job_id: null,
    payload: { message: "hello" },
  };

  // BEFORE — the old generic insert shape (what produced the shells).
  const oldRow: Record<string, unknown> = {
    event_type: input.event_type,
    source: "mcp_agent",
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    job_id: input.job_id,
    payload: input.payload,
    occurred_at: "2026-07-05T00:00:00Z",
  };
  const nullBefore = [oldRow].filter((r) => r.channel == null || r.direction == null).length;
  assertEquals(nullBefore, 1); // the shell

  // AFTER — the fixed path.
  const { client, inserts } = makeFake();
  await recordEvidence(client, planCommsCaptureFromLog(input)!, { org_id: "00000000-0000-0000-0000-000000000001", bypass_feature_flag: true });
  const newRows = inserts.filter((i) => i.table === "business_events").map((i) => i.values);
  const nullAfter = newRows.filter((r) => r.channel == null || r.direction == null).length;
  assertEquals(nullAfter, 0); // no shell
  // Unresolved (no job_id) is fine — still a full envelope, just quarantined.
  assertEquals(newRows[0].match_status, "unresolved");
});
