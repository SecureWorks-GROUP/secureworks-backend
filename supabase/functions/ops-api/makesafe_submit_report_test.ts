import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafePipelineForTest,
  _normaliseOpsAttachJobPhotoInputForTest,
  _submitMakesafeReportForTest,
} from "./index.ts";

type TableRows = Record<string, any[]>;

function makeSubmitClient(seed: TableRows, fail: Record<string, string> = {}) {
  const rows: TableRows = {};
  for (const [table, tableRows] of Object.entries(seed)) {
    rows[table] = tableRows.map((r) => ({ ...r }));
  }
  const nextId = (table: string) =>
    `${table}-${(rows[table] || []).length + 1}`;

  function builder(table: string) {
    if (!rows[table]) rows[table] = [];
    const preds: Array<(r: any) => boolean> = [];
    let insertRow: any = null;
    let updateRow: any = null;
    let maxRows: number | null = null;

    const matchingRows = () => {
      const matched = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? matched : matched.slice(0, maxRows);
    };
    const failKey = (op: string) => `${table}.${op}`;
    const failure = (op: string) =>
      fail[failKey(op)]
        ? { data: null, error: { message: fail[failKey(op)] } }
        : null;
    const applyInsert = () => {
      const failed = failure("insert");
      if (failed) return failed;
      const row = { id: insertRow.id || nextId(table), ...insertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const applyUpdate = () => {
      const failed = failure("update");
      if (failed) return failed;
      const matched = matchingRows();
      for (const row of matched) Object.assign(row, updateRow);
      return { data: matched[0] || null, error: null };
    };
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (updateRow) return applyUpdate();
      const data = matchingRows();
      return { data: single ? data[0] || null : data, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        preds.push((r) => r?.[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        preds.push((r) => r?.[col] !== val);
        return b;
      },
      not: () => b,
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        maxRows = n;
        return b;
      },
      // .range() supports the paginated readers. Seeded sets are small (<1000):
      // return the matched rows in [from,to] inclusive (real PostgREST .range()),
      // which yields [] once `from` is past the end so the loop terminates.
      range: async (from: number, to: number) => ({
        data: matchingRows().slice(from, to + 1),
        error: null,
      }),
      insert: (row: any) => {
        insertRow = row;
        return b;
      },
      update: (row: any) => {
        updateRow = row;
        return b;
      },
      maybeSingle: async () => terminal(true),
      single: async () => terminal(true),
      then: (resolve: (v: any) => any) => resolve(terminal()),
    };
    return b;
  }

  return { client: { from: (table: string) => builder(table) }, rows };
}

function baseRows(overrides: TableRows = {}): TableRows {
  return {
    jobs: [{
      id: "job-1",
      job_number: "SWMS-26001",
      type: "makesafe",
      status: "scheduled",
      client_name: "Test Builder",
      site_address: "1 Test St",
      site_suburb: "Perth",
      metadata: {},
      created_at: "2026-06-10T01:00:00Z",
      updated_at: "2026-06-10T01:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
    }],
    job_service_reports: [],
    job_media: Array.from({ length: 5 }, (_, i) => ({
      id: `media-${i + 1}`,
      job_id: "job-1",
      type: "photo",
      phase: i === 0 ? "front" : i < 3 ? "scope" : "completion",
    })),
    job_events: [],
    job_assignments: [],
    xero_invoices: [],
    job_documents: [],
    ...overrides,
  };
}

function validBody(overrides: Record<string, any> = {}) {
  return {
    job_id: "job-1",
    userId: "trade-1",
    arrival_time: "2026-06-16T08:30:00+08:00",
    damage_description: "Storm damage to front fence.",
    damage_cause: "Storm",
    job_type: "Fence make safe",
    work_done: "Temporary fence secured and loose sheets removed.",
    materials_used: ["temp panels", "star pickets"],
    labour_hours: 2.5,
    trade_count: 2,
    invoice_notes: "Charge temp panels and labour.",
    status: "submitted",
    ...overrides,
  };
}

Deno.test("ops attach job photo normalises recovered completion photo input", () => {
  const body = {
    job_id: "96e9b216-5e06-408e-a8af-e51d665da22b",
    dataUrl: "data:image/jpeg;base64,aGVsbG8=",
    label: "Mirrabooka recovered photo 1 — 11 Jun 2026",
  };

  const parsed = _normaliseOpsAttachJobPhotoInputForTest(body);

  assertEquals(parsed.jId, body.job_id);
  assertEquals(parsed.phase, "completion");
  assertEquals(parsed.mime, "image/jpeg");
  assertEquals(parsed.ext, "jpg");
  assertEquals(parsed.bytes.byteLength, 5);
  assertEquals(parsed.label, body.label);
});

Deno.test("ops attach job photo rejects non-completion or non-image recovery payloads", () => {
  assertRejects(
    async () =>
      _normaliseOpsAttachJobPhotoInputForTest({
        job_id: "96e9b216-5e06-408e-a8af-e51d665da22b",
        phase: "scope",
        dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      }),
    Error,
    "only attaches completion photos",
  );

  assertRejects(
    async () =>
      _normaliseOpsAttachJobPhotoInputForTest({
        job_id: "96e9b216-5e06-408e-a8af-e51d665da22b",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      }),
    Error,
    "base64 jpeg, png, or webp image data URL",
  );
});

Deno.test("submit_makesafe_report rejects final submit with fewer than 5 photos", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    job_media: Array.from(
      { length: 4 },
      (_, i) => ({ id: `media-${i + 1}`, job_id: "job-1", type: "photo" }),
    ),
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "MakeSafe report needs at least 5 photos",
  );
  assertEquals(rows.job_service_reports.length, 0);
});

Deno.test("submit_makesafe_report saves report, flips board state, records event, and pipeline returns Trade Report In", async () => {
  const { client, rows } = makeSubmitClient(baseRows());

  const res: any = await _submitMakesafeReportForTest(client, validBody());

  assertEquals(res.ok, true);
  assertEquals(res.board_sync.ok, true);
  assertEquals(res.event_sync.ok, true);
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].status, "submitted");
  assertEquals(
    rows.job_service_reports[0].checklist_json.work_done,
    validBody().work_done,
  );
  assertEquals(rows.job_service_reports[0].checklist_json.labour_hours, 2.5);
  assertEquals(rows.makesafe_job_details[0].substatus, "admin_to_send_report");
  assert(
    rows.makesafe_job_details[0].report_received_at,
    "report_received_at should be written",
  );
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].event_type, "makesafe_report_submitted");

  const pipeline: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  // Board V2: a freshly submitted trade report (sub=admin_to_send_report) with no
  // drafted close-out pack (no rendered report doc, no draft invoice) lands in the
  // new Trade Report In column, not Report Ready. Report Ready is now reserved for
  // drafted-not-sent packs awaiting the human send.
  const inTradeReportIn = pipeline.columns.trade_report_in.find((j: any) =>
    j.id === "job-1"
  );
  assert(inTradeReportIn, "submitted MakeSafe should be in Trade Report In");
  assertEquals(inTradeReportIn.report_status, "ready_for_reporting_skill");
  // And it must NOT be in report_ready (no draft pack yet).
  assert(
    !pipeline.columns.report_ready.find((j: any) => j.id === "job-1"),
    "un-drafted report must not sit in Report Ready",
  );
});

Deno.test("submit_makesafe_report blocks duplicate submitted reports", async () => {
  const { client } = makeSubmitClient(baseRows({
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      checklist_json: {},
    }],
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "Report already submitted",
  );
});

Deno.test("submit_makesafe_report fails visibly when the report-ready board sync fails", async () => {
  const { client, rows } = makeSubmitClient(baseRows(), {
    "makesafe_job_details.update": "permission denied for makesafe_job_details",
  });

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "board sync failed",
  );
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_makesafe_report returns an event warning if audit event insert fails after board sync", async () => {
  const { client, rows } = makeSubmitClient(baseRows(), {
    "job_events.insert": "event table unavailable",
  });

  const res: any = await _submitMakesafeReportForTest(client, validBody());

  assertEquals(res.ok, true);
  assertEquals(res.board_sync.ok, true);
  assertEquals(res.event_sync.ok, false);
  assertEquals(res.warnings.includes("event_sync_failed"), true);
  assertEquals(rows.makesafe_job_details[0].substatus, "admin_to_send_report");
});
