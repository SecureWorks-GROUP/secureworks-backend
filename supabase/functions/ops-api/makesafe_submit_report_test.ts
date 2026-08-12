// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _confirmUploadForTest,
  _dispatchMakesafeReportForTest,
  _makesafePipelineForTest,
  _normaliseOpsAttachJobPhotoInputForTest,
  _preferBearerForOpsApiAction,
  _resolveMakesafeReportActor,
  _resolveOpsApiAuthIntent,
  _submitMakesafeReportForTest,
  _submitServiceReportForTest,
  _tradeMakesafeCompletionHandoffForTest,
  allocateJob,
  createAssignment,
  updateAssignment,
} from "./index.ts";

type TableRows = Record<string, any[]>;
type FailureSpec = string | {
  message?: string;
  code?: string;
  concurrentRow?: any;
};

function makeSubmitClient(
  seed: TableRows,
  fail: Record<string, FailureSpec> = {},
) {
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
    let upsertRow: any = null;
    let updateRow: any = null;
    let deleteRows = false;
    let maxRows: number | null = null;

    const matchingRows = () => {
      const matched = rows[table].filter((r) => preds.every((p) => p(r)));
      return maxRows === null ? matched : matched.slice(0, maxRows);
    };
    const failKey = (op: string) => `${table}.${op}`;
    const failure = (op: string) => {
      const spec = fail[failKey(op)];
      if (!spec) return null;
      if (typeof spec === "string") {
        return { data: null, error: { message: spec } };
      }
      if (
        spec.concurrentRow &&
        !rows[table].some((row) => row.id === spec.concurrentRow.id)
      ) {
        rows[table].push({ ...spec.concurrentRow });
      }
      if (!spec.message) return null;
      return {
        data: null,
        error: { message: spec.message, code: spec.code },
      };
    };
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
    const applyUpsert = () => {
      const failed = failure("upsert");
      if (failed) return failed;
      const existing = rows[table].find((row) =>
        row.job_id === upsertRow.job_id &&
        row.cycle_number === upsertRow.cycle_number
      );
      if (existing) {
        Object.assign(existing, upsertRow);
        return { data: existing, error: null };
      }
      const row = { id: upsertRow.id || nextId(table), ...upsertRow };
      rows[table].push(row);
      return { data: row, error: null };
    };
    const applyDelete = () => {
      const failed = failure("delete");
      if (failed) return failed;
      const matched = matchingRows();
      const ids = new Set(matched.map((row) => row.id));
      rows[table] = rows[table].filter((row) => !ids.has(row.id));
      return { data: matched, error: null };
    };
    const terminal = (single = false) => {
      if (insertRow) return applyInsert();
      if (upsertRow) return applyUpsert();
      if (updateRow) return applyUpdate();
      if (deleteRows) return applyDelete();
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
      gte: () => b,
      or: () => b,
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
      upsert: (row: any) => {
        upsertRow = row;
        return b;
      },
      update: (row: any) => {
        updateRow = row;
        return b;
      },
      delete: () => {
        deleteRows = true;
        return b;
      },
      maybeSingle: async () => terminal(true),
      single: async () => terminal(true),
      then: (
        resolve: (v: any) => any,
        reject?: (reason: unknown) => any,
      ) => Promise.resolve(terminal()).then(resolve, reject),
    };
    return b;
  }

  return { client: { from: (table: string) => builder(table) }, rows };
}

function baseRows(overrides: TableRows = {}): TableRows {
  return {
    jobs: [{
      id: "job-1",
      org_id: "org-test",
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
    makesafe_attendance_cycles: [],
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

Deno.test("submit_makesafe_report attributes a mixed-credential Trade request from the verified JWT when the body omits userId", async () => {
  const url = new URL(
    "https://example.test/functions/v1/ops-api?action=submit_makesafe_report",
  );
  const authMode = _resolveOpsApiAuthIntent({
    xApiKey: "master-key",
    bearerToken: "hugo-jwt",
    validKey: "master-key",
    serviceKey: "service-key",
    preferBearerOverApiKey: _preferBearerForOpsApiAction(url),
  });
  assertEquals(authMode, "jwt");
  if (authMode !== "jwt") throw new Error("expected JWT auth");

  const actor = _resolveMakesafeReportActor(
    authMode,
    { id: "hugo-user-id" },
    {},
  );
  assertEquals(actor, "hugo-user-id");
  if (!actor) throw new Error("expected JWT actor");

  const { client, rows } = makeSubmitClient(baseRows());
  const { userId: _bodyActor, ...body } = validBody();
  await _dispatchMakesafeReportForTest(client, body, authMode, {
    id: actor,
    email: "hugo@example.test",
    orgId: "org-test",
    role: "installer",
    managedVerticals: [],
  });
  assertEquals(rows.job_service_reports[0].submitted_by, "hugo-user-id");
  assertEquals(rows.job_events[0].user_id, "hugo-user-id");
});

Deno.test("submit_makesafe_report ignores a body-spoofed actor for an authenticated Trade request", () => {
  assertEquals(
    _resolveMakesafeReportActor(
      "jwt",
      { id: "hugo-user-id" },
      { userId: "other-trade-id" },
    ),
    "hugo-user-id",
  );
  assertEquals(
    _resolveMakesafeReportActor(
      "api_key",
      null,
      { user_id: "privileged-supplied-actor" },
    ),
    "privileged-supplied-actor",
  );
});

Deno.test("submit_makesafe_report JWT authority is tenant-scoped before report or assignment writes", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  await assertRejects(
    () =>
      _dispatchMakesafeReportForTest(
        client,
        validBody(),
        "jwt",
        {
          id: "trade-1",
          email: "trade@example.test",
          orgId: "different-org",
          role: "installer",
          managedVerticals: [],
        },
      ),
    Error,
    "not authorized",
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report routine callers may save drafts but cannot finalize a trade report", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  await assertRejects(
    () =>
      _dispatchMakesafeReportForTest(
        client,
        validBody({ userId: "trade-1" }),
        "routine",
        null,
      ),
    Error,
    "requires an authenticated Trade session or privileged operator",
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);

  const draft: any = await _dispatchMakesafeReportForTest(
    client,
    validBody({ status: "draft", userId: "trade-1" }),
    "routine",
    null,
  );
  assertEquals(draft.report.status, "draft");
  assertEquals(rows.job_assignments.length, 0);
});

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

Deno.test("confirm_upload stamps a MakeSafe photo with the server current cycle", async () => {
  const { client, rows } = makeSubmitClient(baseRows());

  const result: any = await _confirmUploadForTest(
    client,
    {
      job_id: "job-1",
      publicUrl: "https://example.test/current-cycle-photo.jpg",
      phase: "completion",
    },
    "trade-1",
  );

  const media = rows.job_media.find((row: any) =>
    row.storage_url === "https://example.test/current-cycle-photo.jpg"
  );
  assert(media);
  assertEquals(media.cycle_attribution, "bound");
  assertEquals(media.attendance_cycle_id, result.attendance_cycle_id);
  assertEquals(
    rows.makesafe_job_details[0].attendance_cycle_id,
    result.attendance_cycle_id,
  );
});

Deno.test("submit_makesafe_report requires five photos from the current reattendance cycle", async () => {
  const stale = Array.from({ length: 5 }, (_, i) => ({
    id: `old-${i + 1}`,
    job_id: "job-1",
    type: "photo",
    attendance_cycle_id: "cycle-1",
    cycle_attribution: "bound",
  }));
  const current = Array.from({ length: 4 }, (_, i) => ({
    id: `current-${i + 1}`,
    job_id: "job-1",
    type: "photo",
    attendance_cycle_id: "cycle-2",
    cycle_attribution: "bound",
  }));
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 2,
      reattend_count: 1,
      attendance_cycle_id: "cycle-2",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-2",
      job_id: "job-1",
      cycle_number: 2,
    }],
    job_media: [...stale, ...current],
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "at least 5 current-visit photos (found 4)",
  );
  rows.job_media.push({
    id: "current-5",
    job_id: "job-1",
    type: "photo",
    attendance_cycle_id: "cycle-2",
    cycle_attribution: "bound",
  });
  const result: any = await _submitMakesafeReportForTest(
    client,
    validBody(),
  );
  assertEquals(result.ok, true);
  assertEquals(rows.job_service_reports[0].attendance_cycle_id, "cycle-2");
});

Deno.test("trade completion handoff uses persisted roof mode and fails closed when unknown", () => {
  assertEquals(
    _tradeMakesafeCompletionHandoffForTest(
      {
        metadata: {
          makesafe_job_family: "roof_report",
          roof_report_mode: "own_template",
        },
      },
      { report_type: "roof_report" },
      null,
    ).completion_handoff,
    "own_template",
  );
  assertEquals(
    _tradeMakesafeCompletionHandoffForTest(
      { metadata: { makesafe_job_family: "roof_report" } },
      { report_type: "roof_report" },
      { id: "draft-1", status: "draft" },
    ).completion_handoff,
    "own_template",
  );
  assertEquals(
    _tradeMakesafeCompletionHandoffForTest(
      { metadata: { makesafe_job_family: "roof_report" } },
      {
        report_type: "roof_report",
        external_links: [{
          kind: "builder_portal",
          url: "https://builder.example/report",
        }],
      },
      null,
    ).completion_handoff,
    "builder_portal",
  );
  const unknown = _tradeMakesafeCompletionHandoffForTest(
    { metadata: { makesafe_job_family: "roof_report" } },
    { report_type: "roof_report" },
    null,
  );
  assertEquals(unknown.completion_handoff, "unknown");
  assertEquals(
    unknown.completion_handoff_reason,
    "roof_completion_mode_unknown",
  );
});

Deno.test("submit_makesafe_report auto-assigns an unassigned submitter as the current-cycle completing trade and audits when", async () => {
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
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].user_id, "trade-1");
  assertEquals(rows.job_assignments[0].status, "complete");
  assertEquals(rows.job_assignments[0].role, "crew");
  assertEquals(rows.job_assignments[0].is_lead, false);
  assertEquals(
    rows.job_assignments[0].attendance_cycle_id,
    rows.makesafe_job_details[0].attendance_cycle_id,
  );
  assertEquals(rows.job_assignments[0].cycle_attribution, "bound");
  assertStringIncludes(
    rows.job_assignments[0].notes,
    "Bound from final MakeSafe report submission as completing trade",
  );
  assertStringIncludes(
    rows.job_assignments[0].notes,
    "not an intake allocation",
  );
  assertEquals(rows.job_assignments[0].id, rows.job_service_reports[0].id);
  assertEquals(res.board_sync.auto_assignment.user_id, "trade-1");
  assertEquals(
    res.board_sync.auto_assignment.attribution,
    "final_makesafe_report_submitter",
  );
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].id, rows.job_service_reports[0].id);
  assertEquals(rows.job_events[0].event_type, "makesafe_report_submitted");
  assertEquals(rows.job_events[0].detail_json.auto_assigned_submitter, true);
  assertEquals(
    rows.job_events[0].detail_json.auto_assigned_at,
    rows.makesafe_job_details[0].report_received_at,
  );

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

Deno.test("submit_makesafe_report does not let an unbound assignment suppress the current-cycle submitter binding", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    job_assignments: [{
      id: "assignment-existing",
      job_id: "job-1",
      user_id: "trade-existing",
      status: "scheduled",
      role: "lead_installer",
    }],
  }));

  const res: any = await _submitMakesafeReportForTest(client, validBody());
  assertEquals(rows.job_assignments.length, 2);
  assertEquals(rows.job_assignments[0].id, "assignment-existing");
  assertEquals(rows.job_assignments[0].status, "complete");
  assertEquals(rows.job_assignments[1].user_id, "trade-1");
  assertEquals(
    rows.job_assignments[1].attendance_cycle_id,
    rows.makesafe_job_details[0].attendance_cycle_id,
  );
  assertEquals(rows.job_assignments[1].cycle_attribution, "bound");
  assertEquals(res.board_sync.auto_assignment.user_id, "trade-1");
  assertEquals(rows.job_events[0].detail_json.auto_assigned_submitter, true);
});

Deno.test("submit_makesafe_report preserves a different current-cycle assignment while attaching the submitter", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_assignments: [{
      id: "assignment-existing",
      job_id: "job-1",
      user_id: "trade-existing",
      status: "scheduled",
      role: "lead_installer",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
  }));

  const result: any = await _submitMakesafeReportForTest(client, validBody());

  assertEquals(rows.job_assignments.length, 2);
  const existing = rows.job_assignments.find((row) =>
    row.id === "assignment-existing"
  );
  assert(existing);
  assertEquals(existing.user_id, "trade-existing");
  assertEquals(existing.attendance_cycle_id, "cycle-1");
  const completingTrade = rows.job_assignments.find((row) =>
    row.user_id === "trade-1"
  );
  assert(completingTrade);
  assertEquals(completingTrade.attendance_cycle_id, "cycle-1");
  assertEquals(completingTrade.status, "complete");
  assertEquals(result.board_sync.auto_assignment.id, completingTrade.id);
  assertEquals(rows.job_events[0].detail_json.auto_assigned_submitter, true);
});

Deno.test("observer ghost declined and open-pool rows cannot satisfy final report attribution", async () => {
  const hostileRows = [
    { id: "declined", status: "declined", role: "lead_installer" },
    { id: "observer", status: "complete", role: "observer" },
    {
      id: "ghost",
      status: "complete",
      role: "lead_installer",
      assignment_type: "ghost",
    },
    { id: "open-pool", status: "complete", role: "makesafe_open" },
  ].map((row) => ({
    ...row,
    job_id: "job-1",
    user_id: "trade-1",
    attendance_cycle_id: "cycle-1",
    cycle_attribution: "bound",
  }));
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_assignments: hostileRows,
  }));

  const result: any = await _submitMakesafeReportForTest(client, validBody());
  assertEquals(result.report.status, "submitted");
  assertEquals(rows.job_assignments.length, 5);
  const canonical = rows.job_assignments.find((row) => row.id === "cycle-1");
  assert(canonical);
  assertEquals(canonical.user_id, "trade-1");
  assertEquals(canonical.role, "crew");
  assertEquals(canonical.is_lead, false);
  assertEquals(result.board_sync.auto_assignment.id, "cycle-1");
});

Deno.test("submit_makesafe_report preserves one same-actor current-cycle assignment on retry", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_assignments: [{
      id: "assignment-existing",
      job_id: "job-1",
      user_id: "trade-1",
      status: "scheduled",
      role: "lead_installer",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
  }));

  const res: any = await _submitMakesafeReportForTest(client, validBody());
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "assignment-existing");
  assertEquals(rows.job_assignments[0].status, "complete");
  assertEquals(res.board_sync.auto_assignment, null);
  assertEquals(rows.job_events[0].detail_json.auto_assigned_submitter, false);
});

Deno.test("submit_makesafe_report requires an attributed actor before writing a final report", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody({ userId: null })),
    Error,
    "user_id required",
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report refuses approved as an unsupported Trade submission transition", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  await assertRejects(
    () =>
      _submitMakesafeReportForTest(
        client,
        validBody({ status: "approved" }),
      ),
    Error,
    "status must be draft or submitted",
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report leaves only a bound draft when current-cycle actor binding fails", async () => {
  const { client, rows } = makeSubmitClient(baseRows(), {
    "job_assignments.insert": "permission denied for job_assignments",
  });

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "submitter assignment failed",
  );
  assertEquals(rows.job_assignments.length, 0);
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].status, "draft");
  assertEquals(rows.job_service_reports[0].submitted_by, "trade-1");
  assertEquals(rows.job_service_reports[0].cycle_attribution, "bound");
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_service_report rejects malformed MakeSafe signature data before report or assignment persistence", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  await assertRejects(
    () =>
      _submitServiceReportForTest(client, {
        job_id: "job-1",
        userId: "trade-1",
        checklist: [],
        signatureData: "data:image/png;base64,%%%",
        status: "submitted",
      }),
    Error,
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_makesafe_report leaves no assignment when final draft staging fails", async () => {
  const { client, rows } = makeSubmitClient(baseRows(), {
    "job_service_reports.insert": "report table unavailable",
  });
  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "report table unavailable",
  );
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_makesafe_report keeps a recoverable bound draft if final promotion fails", async () => {
  const { client, rows } = makeSubmitClient(baseRows(), {
    "job_service_reports.update": "final promotion unavailable",
  });
  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "final promotion unavailable",
  );
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].status, "draft");
  assertEquals(rows.job_service_reports[0].submitted_by, "trade-1");
  assertEquals(rows.job_service_reports[0].cycle_attribution, "bound");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(
    rows.job_assignments[0].id,
    rows.job_service_reports[0].id,
  );
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_makesafe_report converges concurrent assignment and event conflicts on the canonical report UUID", async () => {
  const cycleRows = baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
  });
  const { client, rows } = makeSubmitClient(cycleRows, {
    "job_assignments.insert": {
      message: "duplicate key",
      code: "23505",
      concurrentRow: {
        id: "cycle-1",
        job_id: "job-1",
        user_id: "trade-1",
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        role: "crew",
        is_lead: false,
        status: "complete",
      },
    },
    "job_events.insert": {
      message: "duplicate key",
      code: "23505",
      concurrentRow: {
        id: "cycle-1",
        job_id: "job-1",
        user_id: "trade-1",
        event_type: "makesafe_report_submitted",
        detail_json: {
          report_id: "cycle-1",
          attendance_cycle_id: "cycle-1",
          cycle_number: 1,
        },
      },
    },
  });

  const result: any = await _submitMakesafeReportForTest(client, validBody());
  assertEquals(result.report.id, "cycle-1");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "cycle-1");
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].id, "cycle-1");
  assertEquals(result.event_sync, {
    ok: true,
    skipped: "concurrent_already_logged",
  });
});

Deno.test("submit_makesafe_report prefers a concurrent explicit allocation over its canonical provenance row", async () => {
  const { client, rows } = makeSubmitClient(
    baseRows({
      makesafe_job_details: [{
        job_id: "job-1",
        substatus: "waiting_on_trade_report",
        report_received_at: null,
        cycle_number: 1,
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
      }],
      makesafe_attendance_cycles: [{
        id: "cycle-1",
        job_id: "job-1",
        cycle_number: 1,
      }],
    }),
    {
      "job_assignments.insert": {
        concurrentRow: {
          id: "explicit-allocation",
          job_id: "job-1",
          user_id: "trade-1",
          attendance_cycle_id: "cycle-1",
          cycle_attribution: "bound",
          scheduled_date: "2026-08-03",
          role: "lead_installer",
          is_lead: true,
          status: "scheduled",
        },
      },
    },
  );

  const result: any = await _submitMakesafeReportForTest(client, validBody());
  assertEquals(result.report.status, "submitted");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "explicit-allocation");
  assertEquals(rows.job_assignments[0].role, "lead_installer");
  assertEquals(result.board_sync.auto_assignment, null);
});

Deno.test("createAssignment removes an earlier canonical report binding when explicit allocation commits second", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "legacy-report-uuid",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "draft",
      submitted_by: "trade-1",
    }],
    job_assignments: [{
      id: "cycle-1",
      job_id: "job-1",
      user_id: "trade-1",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      role: "crew",
      is_lead: false,
      status: "complete",
      notes:
        "Bound from final MakeSafe report submission (cycle 1); not an intake allocation",
    }],
    users: [],
  }));

  const result: any = await createAssignment(client, {
    jobId: "job-1",
    userId: "trade-1",
    scheduledDate: "2026-08-03",
    confirmationStatus: "placeholder",
  });

  assertEquals(result.assignment.user_id, "trade-1");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, result.assignment.id);
  assertEquals(rows.job_assignments[0].scheduled_date, "2026-08-03");
  assertEquals(rows.job_assignments[0].role, "lead_installer");
});

Deno.test("a direct create_assignment cleanup failure preserves side effects and its retry reconciles", async () => {
  const failures: Record<string, FailureSpec> = {
    "job_assignments.delete": "cleanup temporarily unavailable",
  };
  const { client, rows } = makeSubmitClient(
    baseRows({
      makesafe_job_details: [{
        job_id: "job-1",
        substatus: "waiting_on_trade_report",
        report_received_at: null,
        cycle_number: 1,
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
      }],
      makesafe_attendance_cycles: [{
        id: "cycle-1",
        job_id: "job-1",
        cycle_number: 1,
      }],
      job_service_reports: [{
        id: "legacy-report-uuid",
        job_id: "job-1",
        cycle_number: 1,
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        status: "draft",
        submitted_by: "trade-1",
      }],
      job_assignments: [{
        id: "cycle-1",
        job_id: "job-1",
        user_id: "trade-1",
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        role: "crew",
        is_lead: false,
        status: "complete",
        notes:
          "Bound from final MakeSafe report submission (cycle 1); not an intake allocation",
      }],
      users: [{ id: "trade-1", phone: null }],
    }),
    failures,
  );

  await assertRejects(
    () =>
      createAssignment(client, {
        jobId: "job-1",
        userId: "trade-1",
        scheduledDate: "2026-08-03",
        confirmationStatus: "placeholder",
      }),
    Error,
    "duplicate reporting assignment reconciliation failed",
  );
  assertEquals(rows.job_assignments.length, 2);
  assertEquals(
    rows.job_events.filter((event) => event.event_type === "assignment_created")
      .length,
    1,
  );

  delete failures["job_assignments.delete"];
  const retry: any = await createAssignment(client, {
    jobId: "job-1",
    userId: "trade-1",
    scheduledDate: "2026-08-03",
    confirmationStatus: "placeholder",
  });
  assertEquals(retry.deduped, true);
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].scheduled_date, "2026-08-03");
  assertEquals(
    rows.job_events.filter((event) => event.event_type === "assignment_created")
      .length,
    1,
  );
});

Deno.test("reassigning an explicit allocation to the report actor removes the canonical duplicate", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "legacy-report-uuid",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_by: "trade-2",
    }],
    job_assignments: [{
      id: "cycle-1",
      job_id: "job-1",
      user_id: "trade-2",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      role: "crew",
      is_lead: false,
      status: "complete",
      notes:
        "Bound from final MakeSafe report submission (cycle 1); not an intake allocation",
    }, {
      id: "explicit-allocation",
      job_id: "job-1",
      user_id: "trade-1",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      scheduled_date: "2026-08-03",
      role: "lead_installer",
      is_lead: true,
      status: "scheduled",
    }],
    users: [{ id: "trade-2", phone: null }],
  }));

  const result: any = await allocateJob(client, {
    body: {
      assignmentId: "explicit-allocation",
      userId: "trade-2",
    },
    callerRole: "ops_manager",
  });
  assertEquals(result.mode, "reassign");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "explicit-allocation");
  assertEquals(rows.job_assignments[0].user_id, "trade-2");
  assertEquals(rows.job_assignments[0].scheduled_date, "2026-08-03");
});

Deno.test("a reassignment cleanup failure is reconciled by its same-user retry", async () => {
  const failures: Record<string, FailureSpec> = {
    "job_assignments.delete": "cleanup temporarily unavailable",
  };
  const { client, rows } = makeSubmitClient(
    baseRows({
      makesafe_job_details: [{
        job_id: "job-1",
        substatus: "waiting_on_trade_report",
        report_received_at: null,
        cycle_number: 1,
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
      }],
      makesafe_attendance_cycles: [{
        id: "cycle-1",
        job_id: "job-1",
        cycle_number: 1,
      }],
      job_assignments: [{
        id: "cycle-1",
        job_id: "job-1",
        user_id: "trade-2",
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        role: "crew",
        is_lead: false,
        status: "complete",
        notes:
          "Bound from final MakeSafe report submission (cycle 1); not an intake allocation",
      }, {
        id: "explicit-allocation",
        job_id: "job-1",
        user_id: "trade-1",
        attendance_cycle_id: "cycle-1",
        cycle_attribution: "bound",
        scheduled_date: "2026-08-03",
        role: "lead_installer",
        status: "scheduled",
      }],
      users: [{ id: "trade-2", phone: null }],
    }),
    failures,
  );

  await assertRejects(
    () =>
      allocateJob(client, {
        body: {
          assignmentId: "explicit-allocation",
          userId: "trade-2",
        },
        callerRole: "ops_manager",
      }),
    Error,
    "duplicate reporting assignment reconciliation failed",
  );
  assertEquals(rows.job_assignments.length, 2);
  assertEquals(
    rows.job_assignments.find((row) => row.id === "explicit-allocation")
      ?.user_id,
    "trade-2",
  );

  delete failures["job_assignments.delete"];
  const retry: any = await allocateJob(client, {
    body: {
      assignmentId: "explicit-allocation",
      userId: "trade-2",
    },
    callerRole: "ops_manager",
  });
  assertEquals(retry.deduped, true);
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "explicit-allocation");
});

Deno.test("editing a prior-cycle assignment preserves its historical attendance identity", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 2,
      attendance_cycle_id: "cycle-2",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }, {
      id: "cycle-2",
      job_id: "job-1",
      cycle_number: 2,
    }],
    job_assignments: [{
      id: "prior-explicit",
      job_id: "job-1",
      user_id: "trade-1",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      scheduled_date: "2026-08-01",
      role: "lead_installer",
      status: "complete",
    }],
  }));

  await updateAssignment(client, {
    assignmentId: "prior-explicit",
    scheduledDate: "2026-08-02",
  });
  assertEquals(rows.job_assignments[0].scheduled_date, "2026-08-02");
  assertEquals(rows.job_assignments[0].attendance_cycle_id, "cycle-1");
  assertEquals(rows.job_assignments[0].cycle_attribution, "bound");
});

Deno.test("submit_makesafe_report refuses a cancelled card before cycle, report, or assignment writes", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    jobs: [{
      ...baseRows().jobs[0],
      status: "cancelled",
    }],
  }));
  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "cannot submit a final MakeSafe report for a cancelled job",
  );
  assertEquals(rows.makesafe_attendance_cycles.length, 0);
  assertEquals(rows.job_service_reports.length, 0);
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report blocks a genuine duplicate once the board has advanced", async () => {
  const { client } = makeSubmitClient(baseRows({
    // A genuine duplicate: the first submit fully synced the board (substatus
    // already at the finished value), so a second submit is rejected.
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      report_received_at: "2026-06-16T01:05:00Z",
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      // cycle_number is NOT NULL DEFAULT 1 post-migration; a first-visit report is
      // cycle 1 and must still block a same-cycle duplicate submit.
      cycle_number: 1,
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

Deno.test("submit_makesafe_report second submit creates no duplicate assignment or audit event", async () => {
  const { client, rows } = makeSubmitClient(baseRows());

  await _submitMakesafeReportForTest(client, validBody());
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_events.length, 1);

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "Report already submitted",
  );
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_events.length, 1);
});

Deno.test("submit_makesafe_report resumes a submitted report stuck before board sync", async () => {
  // A prior submit saved the report row as 'submitted' but failed a post-save step
  // (e.g. auto-assignment insert) and returned 500, leaving the board un-advanced.
  // The retry must resume and finish the sync instead of dead-ending.
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      submitted_by: "trade-1",
      checklist_json: {},
    }],
  }));

  const result = await _submitMakesafeReportForTest(client, validBody());
  assert(result.ok);
  // Board advanced and the submitter was auto-assigned by the resumed sync.
  assertEquals(rows.makesafe_job_details[0].substatus, "admin_to_send_report");
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].id, "cycle-1");
  assertEquals(rows.job_events.length, 1);
  // The original submission attribution/timestamp is preserved (not overwritten).
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(
    rows.job_service_reports[0].submitted_at,
    "2026-06-16T01:00:00Z",
  );
  assertEquals(
    rows.job_service_reports[0].attendance_cycle_id,
    rows.makesafe_job_details[0].attendance_cycle_id,
  );
  assertEquals(rows.job_service_reports[0].cycle_attribution, "bound");
});

Deno.test("submit_makesafe_report refuses to infer a historical submitter from an authenticated retry", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      submitted_by: null,
      checklist_json: {},
    }],
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "persisted submission has no immutable actor evidence",
  );
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_service_reports[0].submitted_by, null);
  assertEquals(
    rows.job_service_reports[0].submitted_at,
    "2026-06-16T01:00:00Z",
  );
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report never lets a routine draft downgrade or anonymize a submitted row", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      submitted_by: "trade-original",
      checklist_json: {},
    }],
  }));

  await assertRejects(
    () =>
      _dispatchMakesafeReportForTest(
        client,
        { job_id: "job-1", status: "draft" },
        "routine",
        null,
      ),
    Error,
    "cannot be downgraded to draft",
  );
  assertEquals(rows.job_service_reports[0].status, "submitted");
  assertEquals(rows.job_service_reports[0].submitted_by, "trade-original");
  assertEquals(
    rows.job_service_reports[0].submitted_at,
    "2026-06-16T01:00:00Z",
  );
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report refuses an ambiguous retry by a different actor", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-1",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      submitted_by: "trade-original",
      checklist_json: {},
    }],
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "retry actor does not match the persisted submitter",
  );
  assertEquals(rows.job_service_reports[0].submitted_by, "trade-original");
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_makesafe_report refuses a retry whose persisted report points outside the authoritative cycle", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "waiting_on_trade_report",
      report_received_at: null,
      cycle_number: 1,
      attendance_cycle_id: "cycle-current",
      cycle_attribution: "bound",
    }],
    makesafe_attendance_cycles: [{
      id: "cycle-current",
      job_id: "job-1",
      cycle_number: 1,
    }],
    job_service_reports: [{
      id: "report-existing",
      job_id: "job-1",
      cycle_number: 1,
      attendance_cycle_id: "cycle-other",
      cycle_attribution: "bound",
      status: "submitted",
      submitted_at: "2026-06-16T01:00:00Z",
      submitted_by: "trade-1",
      checklist_json: {},
    }],
  }));

  await assertRejects(
    () => _submitMakesafeReportForTest(client, validBody()),
    Error,
    "lacks authoritative current-cycle evidence",
  );
  assertEquals(rows.job_service_reports[0].attendance_cycle_id, "cycle-other");
  assertEquals(rows.job_assignments.length, 0);
});

Deno.test("submit_service_report delegates a live generic MakeSafe final into actor and current-cycle authority", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  const result: any = await _submitServiceReportForTest(client, {
    job_id: "job-1",
    userId: "trade-1",
    checklist: [{ item: "live generic MakeSafe path" }],
    notes: "generic payload preserved",
    signatureData: "https://example.test/signature.png",
    signatureName: "Trade User",
    status: "submitted",
  });

  assertEquals(result.ok, true);
  assertEquals(result.report, rows.job_service_reports[0]);
  assertEquals(result.report.checklist_json, [{
    item: "live generic MakeSafe path",
  }]);
  assertEquals(result.report.notes, "generic payload preserved");
  assertEquals(
    result.report.signature_data,
    "https://example.test/signature.png",
  );
  assertEquals(result.report.submitted_by, "trade-1");
  assertEquals(result.report.cycle_attribution, "bound");
  assertEquals(
    result.report.attendance_cycle_id,
    rows.makesafe_job_details[0].attendance_cycle_id,
  );
  assertEquals(rows.job_assignments.length, 1);
  assertEquals(rows.job_assignments[0].role, "crew");
  assertEquals(rows.job_assignments[0].is_lead, false);
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].event_type, "makesafe_report_submitted");
  assertEquals(
    rows.job_events.some((event: any) =>
      event.event_type === "service_report_submitted"
    ),
    false,
  );
});

Deno.test("submit_service_report delegates MakeSafe drafts without assignment or final side effects", async () => {
  const { client, rows } = makeSubmitClient(baseRows());
  const result: any = await _submitServiceReportForTest(client, {
    job_id: "job-1",
    userId: "trade-1",
    checklist: [{ item: "draft through generic caller" }],
    notes: "draft",
    status: "draft",
  });

  assertEquals(result.report.status, "draft");
  assertEquals(result.report.cycle_attribution, "bound");
  assertEquals(rows.job_assignments.length, 0);
  assertEquals(rows.job_events.length, 0);
});

Deno.test("submit_service_report preserves ordinary assigned non-MakeSafe reports", async () => {
  const { client, rows } = makeSubmitClient(baseRows({
    jobs: [{
      ...baseRows().jobs[0],
      type: "fencing",
      job_number: "FENCE-TEST-1",
    }],
    makesafe_job_details: [],
    job_assignments: [{
      id: "assignment-1",
      job_id: "job-1",
      user_id: "trade-1",
      status: "scheduled",
    }],
  }));

  const result: any = await _submitServiceReportForTest(client, {
    job_id: "job-1",
    userId: "trade-1",
    checklist: [{ item: "ordinary service report" }],
    notes: "ordinary report",
    status: "submitted",
  });
  assertEquals(result.report.submitted_by, "trade-1");
  assertEquals(rows.job_service_reports.length, 1);
  assertEquals(rows.job_events.length, 1);
  assertEquals(rows.job_events[0].event_type, "service_report_submitted");
  assertEquals(rows.job_assignments.length, 1);
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
