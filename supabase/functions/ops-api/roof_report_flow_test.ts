// Wave 3 -- roof-report save/submit flow tests against in-memory fixtures.
// ZERO production data writes and ZERO network: the render+attach step is
// injected as a stub, so no jsPDF fetch and no Supabase storage upload occurs.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/roof_report_flow_test.ts
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _renderRoofReportActionForTest,
  _saveRoofReportForTest,
  _submitRoofReportForTest,
} from "./index.ts";
import { STOREY_DOUBLE, STOREY_SINGLE } from "./roof_report_template.ts";

type TableRows = Record<string, any[]>;

// Minimal PostgREST-shaped fake client (mirrors makesafe_submit_report_test.ts).
function makeClient(seed: TableRows, fail: Record<string, string> = {}) {
  const rows: TableRows = {};
  for (const [t, r] of Object.entries(seed)) rows[t] = r.map((x) => ({ ...x }));
  const nextId = (t: string) => `${t}-${(rows[t] || []).length + 1}`;

  function builder(table: string) {
    if (!rows[table]) rows[table] = [];
    const preds: Array<(r: any) => boolean> = [];
    let insertRow: any = null;
    let updateRow: any = null;
    let upsertRow: any = null;
    let upsertConflict: string | null = null;
    let maxRows: number | null = null;
    const matching = () => {
      const m = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? m : m.slice(0, maxRows);
    };
    const failure = (op: string) =>
      fail[`${table}.${op}`]
        ? { data: null, error: { message: fail[`${table}.${op}`] } }
        : null;
    const applyInsert = () => {
      const f = failure("insert");
      if (f) return f;
      const row = { id: insertRow.id || nextId(table), ...insertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const applyUpdate = () => {
      const f = failure("update");
      if (f) return f;
      const m = matching();
      for (const row of m) Object.assign(row, updateRow);
      return { data: m[0] || null, error: null };
    };
    // Upsert honours the UNIQUE conflict key: an existing row on that key is
    // updated in place; otherwise a new row is inserted. Models PostgREST
    // on-conflict so two "first" writes never duplicate or 500.
    const applyUpsert = () => {
      const f = failure("upsert") || failure("insert");
      if (f) return f;
      const cols = (upsertConflict || "")
        .split(",").map((c) => c.trim()).filter(Boolean);
      const hit = cols.length
        ? rows[table].find((r) => cols.every((c) => r?.[c] === upsertRow?.[c]))
        : null;
      if (hit) {
        Object.assign(hit, upsertRow);
        return { data: hit, error: null };
      }
      const row = { id: upsertRow.id || nextId(table), ...upsertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (updateRow) return applyUpdate();
      if (upsertRow) return applyUpsert();
      const d = matching();
      return { data: single ? d[0] || null : d, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        preds.push((r) => r?.[c] === v);
        return b;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => r?.[c] !== v);
        return b;
      },
      in: (c: string, vs: any[]) => {
        preds.push((r) => vs.includes(r?.[c]));
        return b;
      },
      not: () => b,
      gte: () => b,
      order: () => b,
      limit: (n: number) => {
        maxRows = n;
        return b;
      },
      insert: (row: any) => {
        insertRow = row;
        return b;
      },
      update: (row: any) => {
        updateRow = row;
        return b;
      },
      upsert: (row: any, opts?: { onConflict?: string }) => {
        upsertRow = row;
        upsertConflict = opts?.onConflict || null;
        return b;
      },
      maybeSingle: async () => terminal(true),
      single: async () => terminal(true),
      then: (resolve: (v: any) => any) => resolve(terminal()),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, rows };
}

function baseRows(overrides: TableRows = {}): TableRows {
  return {
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26861",
      type: "makesafe",
      status: "scheduled",
      client_name: "Major Loss Builders",
      site_address: "10 Caversham Way",
      site_suburb: "Caversham",
      metadata: {},
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
    makesafe_roof_report_drafts: [],
    job_media: [],
    job_events: [],
    job_assignments: [],
    job_documents: [],
    ...overrides,
  };
}

// A render+attach stub: no jsPDF, no storage. Records the render job it saw.
function stubRenderDeps() {
  const calls: any[] = [];
  return {
    calls,
    deps: {
      renderAndAttach: (
        _client: any,
        _jobId: string,
        renderJob: Record<string, unknown>,
        operator: string,
      ) => {
        calls.push({ renderJob, operator });
        return Promise.resolve({
          document_id: "00000000-0000-0000-0000-0000000000aa",
          file_name: "Roof Inspection Report - MLB - Caversham.pdf",
          render_hash: "deadbeef".repeat(8),
        });
      },
    },
  };
}

const fullFill = {
  inspection_date: "2026-07-20",
  inspection_time: "09:30",
  inspected_by: "Sam Trade",
  weather: "Sunny / Fine",
  construction_type: "Double Brick",
  storeys: STOREY_DOUBLE,
  roof_type: "Terracotta Tiles",
  roof_condition: "Fair",
  water_leak: true,
  leak_cause: "Cracked ridge capping.",
  overall_findings: "Roof in fair condition; localised storm damage.",
  maintenance_recommendation: "Recommended",
};

Deno.test("save_roof_report: inserts a draft, denormalises storey, records audit, no board change", async () => {
  const { client, rows } = makeClient(baseRows());
  const res: any = await _saveRoofReportForTest(client, {
    job_id: "job-1",
    userId: "11111111-1111-1111-1111-111111111111",
    fields: {
      inspected_by: "Sam Trade",
      storeys: STOREY_SINGLE,
      roof_type: "Colorbond",
    },
    photos: [{ url: "https://x/1.jpg", label: "Ridge", bytesBase64: "AAAA" }],
  });

  assertEquals(res.ok, true);
  assertEquals(res.status, "draft");
  assertEquals(res.saved, true);
  assertEquals(res.storey, "single");
  assertEquals(res.price.inc_gst, 275);

  assertEquals(rows.makesafe_roof_report_drafts.length, 1);
  const draft = rows.makesafe_roof_report_drafts[0];
  assertEquals(draft.status, "draft");
  assertEquals(draft.storey, "single");
  assertEquals(draft.fields_json.roof_type, "Colorbond");
  // Photo meta persisted WITHOUT base64 bytes.
  assertEquals(draft.fields_json.photos.length, 1);
  assertEquals(draft.fields_json.photos[0].label, "Ridge");
  assert(!("bytesBase64" in draft.fields_json.photos[0]));
  // Board untouched.
  assertEquals(
    rows.makesafe_job_details[0].substatus,
    "waiting_on_trade_report",
  );
  // Audit.
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].event_type, "roof_report_saved");
});

Deno.test("save_roof_report: idempotent -- a second save updates the same row, no duplicate", async () => {
  const { client, rows } = makeClient(baseRows());
  await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { inspected_by: "A" },
  });
  await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { inspected_by: "B", storeys: STOREY_DOUBLE },
  });
  assertEquals(rows.makesafe_roof_report_drafts.length, 1);
  assertEquals(
    rows.makesafe_roof_report_drafts[0].fields_json.inspected_by,
    "B",
  );
  assertEquals(rows.makesafe_roof_report_drafts[0].storey, "double");
});

Deno.test("save_roof_report: a save on an already-submitted fill is a no-op", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      fields_json: { inspected_by: "Locked" },
    }],
  }));
  const res: any = await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { inspected_by: "Nope" },
  });
  assertEquals(res.already_submitted, true);
  assertEquals(res.saved, false);
  assertEquals(
    rows.makesafe_roof_report_drafts[0].fields_json.inspected_by,
    "Locked",
  );
});

Deno.test("save_roof_report: a partial save merges over the existing draft, never wiping prior fields", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "draft",
      storey: "double",
      fields_json: {
        inspected_by: "Sam Trade",
        roof_type: "Terracotta Tiles",
        storeys: STOREY_DOUBLE,
        photos: [{ url: "https://x/ridge.jpg", label: "Ridge" }],
      },
    }],
  }));

  // Autosave only touches one text field; no photos in the request.
  const res: any = await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { roof_condition: "Fair" },
  });

  assertEquals(res.saved, true);
  const draft = rows.makesafe_roof_report_drafts[0];
  // New field written.
  assertEquals(draft.fields_json.roof_condition, "Fair");
  // Prior text fields preserved.
  assertEquals(draft.fields_json.inspected_by, "Sam Trade");
  assertEquals(draft.fields_json.roof_type, "Terracotta Tiles");
  // Storey preserved (a text-only save must not reset it).
  assertEquals(draft.fields_json.storeys, STOREY_DOUBLE);
  assertEquals(draft.storey, "double");
  // Photos preserved (request carried none).
  assertEquals(draft.fields_json.photos.length, 1);
  assertEquals(draft.fields_json.photos[0].label, "Ridge");
});

Deno.test("save_roof_report: an explicit empty photos array clears prior photos", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "draft",
      fields_json: {
        inspected_by: "Sam Trade",
        photos: [{ url: "https://x/ridge.jpg", label: "Ridge" }],
      },
    }],
  }));

  await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { roof_type: "Colorbond" },
    photos: [],
  });

  const draft = rows.makesafe_roof_report_drafts[0];
  assertEquals(draft.fields_json.photos.length, 0);
  assertEquals(draft.fields_json.inspected_by, "Sam Trade");
});

Deno.test("submit_roof_report: does not regress a board already at ready_to_invoice", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "ready_to_invoice",
      report_received_at: "2026-07-19T00:00:00.000Z",
      cycle_number: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
  }));
  const { deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);

  assertEquals(res.ok, true);
  assertEquals(res.board_sync.already_advanced, true);
  // Board NOT regressed and report_received_at NOT re-stamped.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "ready_to_invoice");
  assertEquals(detail.report_received_at, "2026-07-19T00:00:00.000Z");
  // Our-report verification still recorded for this cycle.
  assertEquals(detail.portal_verified_cycle, 1);
  assertEquals(res.board_sync.verification_recorded, true);
});

Deno.test("submit_roof_report: a resubmit completes an un-advanced board (retry after board failure)", async () => {
  // Fill already persisted as submitted, but the board never advanced (a prior
  // transient board-sync failure). A retry must finish the board sync.
  const { client, rows } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      submitted_cycle: 1,
      report_doc_id: "00000000-0000-0000-0000-0000000000aa",
      last_render_hash: "cafe".repeat(16),
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);

  assertEquals(res.already_submitted, true);
  assertEquals(calls.length, 0, "must not re-render on retry");
  // Board advanced by the retry.
  assertEquals(res.board_sync.ok, true);
  assertEquals(
    rows.makesafe_job_details[0].substatus,
    "admin_to_send_report",
  );
  assert(rows.makesafe_job_details[0].report_received_at);
});

Deno.test("submit_roof_report: a reopened newer cycle files a FRESH report and advances cycle 2", async () => {
  // Roof report was submitted for cycle 1. The job was later reopened: cycle
  // bumped to 2, substatus reset to an earlier stage, board un-advanced. A submit
  // for the new cycle must render a FRESH report and advance cycle 2 (it must NOT
  // stay stuck on the terminal cycle-1 row, and must NOT advance off the stale
  // cycle-1 render — it produces a new one).
  const { client, rows } = makeClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 2,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      submitted_cycle: 1,
      report_doc_id: "00000000-0000-0000-0000-0000000000aa",
      last_render_hash: "cafe".repeat(16),
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);

  // Fresh submit, not the idempotent no-op.
  assert(!res.already_submitted, "reopened cycle is a fresh submit, not idempotent");
  assertEquals(res.status, "submitted");
  assertEquals(calls.length, 1, "renders a fresh report for the new cycle");
  // Row re-stamped for cycle 2 (still one row).
  assertEquals(rows.makesafe_roof_report_drafts.length, 1);
  assertEquals(rows.makesafe_roof_report_drafts[0].submitted_cycle, 2);
  // Reopened cycle's board advanced and verified for cycle 2.
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "admin_to_send_report");
  assert(detail.report_received_at);
  assertEquals(detail.portal_verified_cycle, 2);
});

Deno.test("submit_roof_report: after refiling a reopened cycle, a same-cycle repeat is idempotent", async () => {
  // The cycle-2 refile has already happened (submitted_cycle=2, board advanced).
  // A duplicate submit within cycle 2 must be the idempotent no-op: no re-render,
  // board not re-stamped.
  const { client, rows } = makeClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      report_received_at: "2026-07-21T00:00:00.000Z",
      cycle_number: 2,
      portal_verified_at: "2026-07-21T00:00:00.000Z",
      portal_verified_cycle: 2,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      submitted_cycle: 2,
      report_doc_id: "00000000-0000-0000-0000-0000000000aa",
      last_render_hash: "cafe".repeat(16),
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);

  assertEquals(res.already_submitted, true);
  assertEquals(calls.length, 0, "must not re-render a same-cycle repeat");
  assertEquals(res.report_doc_id, "00000000-0000-0000-0000-0000000000aa");
});

Deno.test("save_roof_report: a reopened newer cycle resets the submitted row to a fresh draft", async () => {
  // The cycle-1 report is terminal, but the job was reopened to cycle 2. A save
  // for the new cycle must reset the row to a draft (not return already_submitted)
  // so the trade can fill and submit a fresh cycle-2 report.
  const { client, rows } = makeClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 2,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      submitted_cycle: 1,
      report_doc_id: "00000000-0000-0000-0000-0000000000aa",
      last_render_hash: "cafe".repeat(16),
      fields_json: { ...fullFill },
    }],
  }));

  const res: any = await _saveRoofReportForTest(client, {
    job_id: "job-1",
    fields: { inspected_by: "Fresh Cycle 2" },
  });

  assertEquals(res.ok, true);
  assertEquals(res.saved, true);
  assertEquals(res.status, "draft");
  const draft = rows.makesafe_roof_report_drafts[0];
  assertEquals(draft.status, "draft");
  // Prior cycle's submit state cleared.
  assertEquals(draft.submitted_cycle, null);
  assertEquals(draft.report_doc_id, null);
  // Fresh fill starts clean — the stale cycle-1 fields are NOT the merge base.
  assertEquals(draft.fields_json.inspected_by, "Fresh Cycle 2");
  assertEquals(draft.fields_json.roof_type, undefined);
});

Deno.test("save_roof_report: concurrent first-time writes upsert to a single row (no unique-constraint 500)", async () => {
  // Two racing first saves both see no existing row; the on-conflict upsert must
  // collapse them to one row rather than one of them 500-ing on the UNIQUE key.
  const { client, rows } = makeClient(baseRows());
  const results = await Promise.all([
    _saveRoofReportForTest(client, {
      job_id: "job-1",
      fields: { inspected_by: "Racer A", storeys: STOREY_SINGLE },
    }),
    _saveRoofReportForTest(client, {
      job_id: "job-1",
      fields: { inspected_by: "Racer B" },
    }),
  ]);
  for (const r of results as any[]) assertEquals(r.ok, true);
  assertEquals(rows.makesafe_roof_report_drafts.length, 1);
});

Deno.test("submit_roof_report: rejects an incomplete fill (missing required fields)", async () => {
  const { client, rows } = makeClient(baseRows());
  const { deps } = stubRenderDeps();
  await assertRejects(
    () =>
      _submitRoofReportForTest(client, {
        job_id: "job-1",
        fields: { roof_type: "Colorbond" },
      }, deps),
    Error,
    "Roof report incomplete",
  );
  // Nothing persisted, board untouched.
  assertEquals(rows.makesafe_roof_report_drafts.length, 0);
  assertEquals(
    rows.makesafe_job_details[0].substatus,
    "waiting_on_trade_report",
  );
});

Deno.test("submit_roof_report: renders our PDF, persists submitted, advances the reporting checklist, audits", async () => {
  const { client, rows } = makeClient(baseRows());
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    userId: "22222222-2222-2222-2222-222222222222",
    fields: fullFill,
    photos: [{ url: "https://x/ridge.jpg", label: "Ridge capping" }],
  }, deps);

  assertEquals(res.ok, true);
  assertEquals(res.status, "submitted");
  assertEquals(res.price.inc_gst, 385); // double storey
  assertEquals(res.board_sync.ok, true);
  assertEquals(res.event_sync.ok, true);

  // Render was called once, with the fee computed onto the render job.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].renderJob.price_inc_gst, 385);
  assertEquals(calls[0].renderJob.ref, "MLB-17270PO-54939 / SWMS-26861");
  assertEquals((calls[0].renderJob.photos as any[])[0].label, "Ridge capping");

  // Persisted submitted row.
  assertEquals(rows.makesafe_roof_report_drafts.length, 1);
  const draft = rows.makesafe_roof_report_drafts[0];
  assertEquals(draft.status, "submitted");
  assertEquals(draft.storey, "double");
  assert(draft.report_doc_id);
  assert(draft.submitted_at);

  // Reporting checklist advanced (mirrors mark_makesafe_portal_report_done).
  const detail = rows.makesafe_job_details[0];
  assertEquals(detail.substatus, "admin_to_send_report");
  assert(detail.report_received_at);
  assertEquals(detail.portal_verified_cycle, 1);
  assertEquals(
    detail.portal_verified_signal,
    "secureworks roof report submitted",
  );

  // Audit event.
  const submitEvent = rows.job_events.find((e: any) =>
    e.event_type === "roof_report_submitted"
  );
  assert(submitEvent, "roof_report_submitted event recorded");
  assertEquals(submitEvent.detail_json.price_inc_gst, 385);
});

Deno.test("submit_roof_report: merges an existing draft with the submit request fields", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "draft",
      fields_json: {
        inspection_date: "2026-07-20",
        inspected_by: "Sam Trade",
        roof_type: "Terracotta Tiles",
      },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  // Request supplies only the storey (the pricing driver); the rest comes from the draft.
  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: { storeys: STOREY_SINGLE },
  }, deps);

  assertEquals(res.ok, true);
  assertEquals(res.price.inc_gst, 275); // single storey from the request
  assertEquals(calls[0].renderJob.roof_type, "Terracotta Tiles"); // from the draft
  assertEquals(rows.makesafe_roof_report_drafts[0].status, "submitted");
});

Deno.test("submit_roof_report: idempotent -- resubmit returns existing report, no re-render", async () => {
  const { client, rows } = makeClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      report_received_at: "2026-07-20T00:00:00.000Z",
      cycle_number: 1,
      portal_verified_at: "2026-07-20T00:00:00.000Z",
      portal_verified_cycle: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: "roof_report",
    }],
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "submitted",
      report_doc_id: "00000000-0000-0000-0000-0000000000aa",
      last_render_hash: "cafe".repeat(16),
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);
  assertEquals(res.already_submitted, true);
  assertEquals(res.report_doc_id, "00000000-0000-0000-0000-0000000000aa");
  assertEquals(
    calls.length,
    0,
    "must not re-render an already-submitted report",
  );
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_roof_report: 409s on a normal (non-report-type) make-safe, nothing persisted or advanced", async () => {
  const { client, rows } = makeClient(baseRows({
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26861",
      type: "makesafe",
      status: "scheduled",
      client_name: "Major Loss Builders",
      site_address: "10 Caversham Way",
      site_suburb: "Caversham",
      metadata: {},
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: null,
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  await assertRejects(
    () =>
      _submitRoofReportForTest(client, {
        job_id: "job-1",
        fields: fullFill,
      }, deps),
    Error,
    "restricted to report-type jobs",
  );

  // Nothing rendered, nothing persisted, board untouched.
  assertEquals(calls.length, 0);
  assertEquals(rows.makesafe_roof_report_drafts.length, 0);
  assertEquals(
    rows.makesafe_job_details[0].substatus,
    "waiting_on_trade_report",
  );
  assertEquals(rows.makesafe_job_details[0].report_received_at, null);
});

Deno.test("submit_roof_report: a report-family job (no report_type, family metadata) still succeeds", async () => {
  const { client, rows } = makeClient(baseRows({
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26861",
      type: "makesafe",
      status: "scheduled",
      client_name: "Major Loss Builders",
      site_address: "10 Caversham Way",
      site_suburb: "Caversham",
      metadata: { makesafe_job_family: "roof_report" },
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: null,
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _submitRoofReportForTest(client, {
    job_id: "job-1",
    fields: fullFill,
  }, deps);

  assertEquals(res.ok, true);
  assertEquals(res.status, "submitted");
  assertEquals(calls.length, 1);
  assertEquals(rows.makesafe_job_details[0].substatus, "admin_to_send_report");
});

Deno.test("submit_roof_report: board-sync failure surfaces loudly", async () => {
  const { client } = makeClient(baseRows(), {
    "makesafe_job_details.update": "permission denied for makesafe_job_details",
  });
  const { deps } = stubRenderDeps();
  await assertRejects(
    () =>
      _submitRoofReportForTest(
        client,
        { job_id: "job-1", fields: fullFill },
        deps,
      ),
    Error,
    "board sync failed",
  );
});

Deno.test("render_roof_report: 409s on a normal (non-report-type) make-safe, nothing attached", async () => {
  const { client, rows } = makeClient(baseRows({
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26861",
      type: "makesafe",
      status: "scheduled",
      client_name: "Major Loss Builders",
      site_address: "10 Caversham Way",
      site_suburb: "Caversham",
      metadata: {},
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      external_ref: "MLB-17270PO-54939",
      report_type: null,
    }],
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "draft",
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  await assertRejects(
    () => _renderRoofReportActionForTest(client, { job_id: "job-1" }, deps),
    Error,
    "restricted to report-type jobs",
  );

  // Nothing rendered or attached.
  assertEquals(calls.length, 0);
  assertEquals(rows.job_documents.length, 0);
});

Deno.test("render_roof_report: succeeds on a report_type='roof_report' job", async () => {
  const { client } = makeClient(baseRows({
    makesafe_roof_report_drafts: [{
      id: "draft-1",
      job_id: "job-1",
      pack_kind: "roof",
      status: "draft",
      fields_json: { ...fullFill },
    }],
  }));
  const { calls, deps } = stubRenderDeps();

  const res: any = await _renderRoofReportActionForTest(
    client,
    { job_id: "job-1" },
    deps,
  );

  assertEquals(res.success, true);
  assertEquals(res.document_id, "00000000-0000-0000-0000-0000000000aa");
  assertEquals(calls.length, 1);
});
