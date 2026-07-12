// Trade<->ops comms thread — regression guard for the note classifier that both
// new filter sites rely on:
//   * tradeJobDetail.notes  — strips system markers before the trade ever sees them
//   * list_jobs comms_notes_count — excludes markers so they never light the badge
//
// Both read the note body from job_events.detail_json (text, or legacy note) and
// keep a row iff it is NOT a system/audit marker. If noteIsSystemMarker ever stops
// catching MAKESAFE_PACK_SENT / MAKESAFE_AGENT_REPLY, an internal breadcrumb would
// leak into the trade UI and inflate the ops badge — this test fails first.
//
// Pure: NO network, NO Supabase, NO Xero.
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/job_notes_comms_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { noteIsSystemMarker } from "./makesafe_draft_notes.ts";

// Mirror of the exact expression used at both filter sites in index.ts.
function commsBody(ev: any): string {
  return ev?.detail_json?.text ?? ev?.detail_json?.note ?? "";
}
function isCommsNote(ev: any): boolean {
  return !noteIsSystemMarker(commsBody(ev));
}

Deno.test("human notes are kept in the comms thread", () => {
  const rows = [
    { detail_json: { text: "Gate is locked, need a key" } },
    { detail_json: { text: "On my way, ETA 20 min", from_ops: true } },
    { detail_json: { note: "legacy note field body" } }, // legacy note_added shape
  ];
  for (const r of rows) assert(isCommsNote(r), `expected kept: ${commsBody(r)}`);
  assertEquals(rows.filter(isCommsNote).length, 3);
});

Deno.test("system markers are excluded from the comms thread and the count", () => {
  const rows = [
    { detail_json: { text: "MAKESAFE_PACK_SENT 2026-07-11 to builder" } },
    { detail_json: { text: "MAKESAFE_AGENT_REPLY | tightened wording" } },
    { detail_json: { note: "MAKESAFE_PACK_SENT legacy-shaped marker" } },
  ];
  for (const r of rows) assert(!isCommsNote(r), `expected excluded: ${commsBody(r)}`);
  assertEquals(rows.filter(isCommsNote).length, 0);
});

Deno.test("a mixed feed yields the human-only count used by the badge", () => {
  const feed = [
    { detail_json: { text: "Trade: found asbestos, holding off" } },
    { detail_json: { text: "MAKESAFE_PACK_SENT ..." } },
    { detail_json: { text: "Office: approved, proceed", from_ops: true } },
    { detail_json: { text: "MAKESAFE_AGENT_REPLY | ..." } },
    { detail_json: {} }, // empty body — not a marker, still a (blank) human row
  ];
  assertEquals(feed.filter(isCommsNote).length, 3);
});
