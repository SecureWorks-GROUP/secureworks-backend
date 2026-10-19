// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTradeReportEvidenceRow,
  captureTradeReportEvidence,
  scrubTradeReportText,
  TRADE_REPORT_EVENT_TYPE,
  tradeReportSections,
} from "./trade_report_evidence.ts";

const MAKESAFE = {
  id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  status: "submitted",
  submitted_at: "2026-10-18T03:00:00.000Z",
  cycle_number: 1,
  attendance_cycle_id: "33333333-3333-4333-8333-333333333333",
  checklist_json: {
    damage_description: "Fence panel down along the rear boundary.",
    damage_cause: "Storm wind",
    work_done: "Propped the panel with two star pickets and taped off the area.",
    access_issues: "",
    labour_hours: 3,
    trade_count: 2,
    materials_used: ["star_pickets"],
    invoice_notes: "Charge $450 ex GST",
    follow_up_required: true,
  },
  notes: "Propped the panel with two star pickets and taped off the area.",
};

Deno.test("trade report: a submitted make-safe report builds one admitted note row", async () => {
  const built = await buildTradeReportEvidenceRow(MAKESAFE);
  assert("row" in built);
  const row = built.row;
  assertEquals(row.event_type, TRADE_REPORT_EVENT_TYPE);
  assertEquals(row.channel, "note"); // context_ledger_message_kind admits 'note'
  assert(!String(row.event_type).startsWith("trade.")); // never status-only
  assertEquals(row.job_id, MAKESAFE.job_id);
  assertEquals(row.match_method, "direct_job_id");
  assertEquals(row.event_at, MAKESAFE.submitted_at);
  assertEquals((row.metadata as Record<string, unknown>).capture_mode, "live");
  assert(String(row.provider_message_id).startsWith(`job_service_report:${MAKESAFE.id}:`));
  const payload = row.payload as Record<string, unknown>;
  assertEquals(payload.job_id, row.job_id); // context_event_source_admissible
  const text = String(payload.text);
  assertStringIncludes(text, "Damage found: Fence panel down");
  assertStringIncludes(text, "Cause: Storm wind");
  assertStringIncludes(text, "Work done: Propped the panel");
  assertStringIncludes(text, "Follow-up required: yes");
  // notes duplicate work_done: said once
  assertEquals(text.split("Propped the panel").length - 1, 1);
  for (const leaked of ["450", "labour", "star_pickets", "Charge", "trade_count"]) {
    assert(!text.includes(leaked), `leaked ${leaked}`);
  }
  for (const writerOwned of ["occurred_at", "attribution_status", "id", "recorded_at"]) {
    assert(!(writerOwned in row), `writer-owned ${writerOwned}`);
  }
});

Deno.test("trade report: the key is stable for the same words and moves when they change", async () => {
  const a = await buildTradeReportEvidenceRow(MAKESAFE);
  const b = await buildTradeReportEvidenceRow({ ...MAKESAFE });
  const c = await buildTradeReportEvidenceRow({
    ...MAKESAFE,
    checklist_json: { ...MAKESAFE.checklist_json, work_done: "Replaced the panel." },
  });
  assert("row" in a && "row" in b && "row" in c);
  assertEquals(a.row.provider_message_id, b.row.provider_message_id);
  assert(a.row.provider_message_id !== c.row.provider_message_id);
  const backfill = await buildTradeReportEvidenceRow(MAKESAFE, "backfill");
  assert("row" in backfill);
  assertEquals(backfill.row.provider_message_id, a.row.provider_message_id);
});

Deno.test("trade report: drafts, missing ids and wordless reports write nothing", async () => {
  assertEquals(await buildTradeReportEvidenceRow({ ...MAKESAFE, status: "draft" }), { skip: "not_submitted" });
  assertEquals(await buildTradeReportEvidenceRow({ ...MAKESAFE, job_id: null }), { skip: "no_ids" });
  assertEquals(
    await buildTradeReportEvidenceRow({ id: "r", job_id: "j", status: "submitted", checklist_json: [], notes: "  " }),
    { skip: "no_words" },
  );
});

Deno.test("trade report: a generic service report uses its notes only", () => {
  const sections = tradeReportSections({
    checklist_json: [{ label: "Posts concreted", checked: true }],
    notes: "Installed 12 m of colorbond, call me on 0412 345 678.",
  });
  assertEquals(sections.map((s) => s.field), ["notes"]);
  assertStringIncludes(sections[0].text, "[phone removed]");
});

Deno.test("trade report: phone numbers, emails and money are removed", () => {
  const out = scrubTradeReportText(
    "Owner +61 8 9123 4567 / 08 9123 4567 / jo@example.com said $1,250.00 and 300 dollars. 2400mm panel.",
  );
  for (const gone of ["9123", "example.com", "1,250", "300 dollars"]) {
    assert(!out.includes(gone), `kept ${gone}: ${out}`);
  }
  assertStringIncludes(out, "2400mm panel");
});

Deno.test("trade report: capture goes through capture_business_event and never throws", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const ok = await captureTradeReportEvidence({
    rpc: (fn, args) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: { outcome: "inserted", id: "e1" }, error: null });
    },
  }, MAKESAFE);
  assertEquals(ok, { outcome: "inserted", id: "e1" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "capture_business_event");

  const failed = await captureTradeReportEvidence({
    rpc: () => Promise.resolve({ data: null, error: { code: "PGRST202" } }),
  }, MAKESAFE);
  assertEquals(failed, { outcome: "error", code: "PGRST202" });

  const threw = await captureTradeReportEvidence({
    rpc: () => {
      throw new Error("boom");
    },
  }, MAKESAFE);
  assertEquals(threw, { outcome: "error", code: "threw" });

  // deno-lint-ignore no-explicit-any
  const noRpc = await captureTradeReportEvidence({} as any, MAKESAFE);
  assertEquals(noRpc.outcome, "error");

  const draft = await captureTradeReportEvidence({
    rpc: () => {
      throw new Error("must not be called");
    },
  }, { ...MAKESAFE, status: "draft" });
  assertEquals(draft, { outcome: "skipped", code: "not_submitted" });
});
