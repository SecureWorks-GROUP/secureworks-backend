// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertNoSyntheticLivefireInvoiceForTest,
  _assertNoSyntheticLivefireJobsForTest,
  _assertNoSyntheticLivefireReleaseRevisionForTest,
  _deriveMakesafeBoardStage,
} from "./index.ts";
import {
  buildCanonicalMakesafeRows,
  checkMakesafeBoardParity,
  isSyntheticLivefireJob,
  isTerminalSyntheticLivefireJob,
  mapOpsStageToTradeColumn,
  OPS_MAKESAFE_STAGES,
  projectOpsMakesafeBoard,
  projectTradeMakesafeBoard,
  TRADE_MAKESAFE_COLUMNS,
} from "./makesafe_board_read_model.ts";

const NOW = "2026-07-20T12:00:00Z";

function baseJob(
  stage: string,
  id = `job-${stage}`,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    job_number: `SWMS-${id}`,
    type: "makesafe",
    status: stage === "cancelled" ? "cancelled" : "scheduled",
    board_stage: stage,
    board_label: stage,
    substatus: stage === "new"
      ? "company_contact_required"
      : "waiting_on_trade_report",
    client_name: "Kim Client",
    client_phone: "0400 111 222",
    site_address: "10 Sample Street",
    site_suburb: "Perth",
    requesting_company_name: "ML Builders",
    external_ref: "MLB-100",
    metadata: {
      builder_claim_ref: "MLB-100",
      builder_po_number: `PO-${id}`,
      makesafe_job_family: "general_makesafe",
    },
    makesafe_details: { substatus: "waiting_on_trade_report", cycle_number: 1 },
    assignments: [{
      id: `assignment-${id}`,
      user_id: "trade-1",
      status: "scheduled",
      scheduled_date: "2026-07-20",
      start_time: "09:00",
      users: { id: "trade-1", name: "Hugo", phone: "0400 000 001" },
    }],
    report_status: "waiting_on_trade_report",
    sent_to_builder: false,
    age_hours: 20,
    ...over,
  };
}

Deno.test("parity: every ops stage maps exactly once to the captain's four trade columns", () => {
  const rows = buildCanonicalMakesafeRows(
    OPS_MAKESAFE_STAGES.map((stage) => baseJob(stage)),
  );
  const parity = checkMakesafeBoardParity(rows);
  assertEquals(parity.ok, true);
  assertEquals(parity.checked, OPS_MAKESAFE_STAGES.length);
  assertEquals(parity.errors, []);
  assertEquals(parity.unmapped_stage_job_ids, []);

  const trade = projectTradeMakesafeBoard(rows, {
    userId: "hugo-id",
    name: "Hugo",
    role: "installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(Object.keys(trade.columns), [...TRADE_MAKESAFE_COLUMNS]);
  assert(
    !Object.keys(trade.columns).some((name) =>
      name.toLowerCase().includes("office")
    ),
  );
  assertEquals(trade.columns.New.map((r) => r.canonical_stage), ["new"]);
  assertEquals(trade.columns.Allocated.map((r) => r.canonical_stage), [
    "allocated",
  ]);
  assertEquals(
    trade.columns.Complete.map((r) => r.canonical_stage),
    ["trade_report_in", "report_ready"],
  );
  assertEquals(
    trade.columns.Archive.map((r) => r.canonical_stage),
    ["completed", "archive", "cancelled"],
  );
});

Deno.test("historical divergence: assignment complete without a report remains Allocated", () => {
  const stage = _deriveMakesafeBoardStage(
    { status: "scheduled" },
    { substatus: "waiting_on_trade_report" },
    [{ user_id: "trade-1", status: "complete" }],
    undefined,
  );
  assertEquals(stage, "allocated");
  assertEquals(mapOpsStageToTradeColumn(stage).column, "Allocated");
});

Deno.test("historical divergence: Docs Ready/report_ready deterministically appears in Complete", () => {
  assertEquals(mapOpsStageToTradeColumn("report_ready"), {
    column: "Complete",
    mapped: true,
  });
});

Deno.test("historical divergence: unknown stage never vanishes silently", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("mystery_status", "job-mystery"),
  ]);
  const ops = projectOpsMakesafeBoard(rows);
  const trade = projectTradeMakesafeBoard(rows, {
    userId: "hugo-id",
    name: "Hugo",
    managedVerticals: ["makesafe"],
  });
  assertEquals(ops.columns.new[0].id, "job-mystery");
  assertEquals(trade.columns.New[0].id, "job-mystery");
  assert(trade.columns.New[0].projection_warning.includes("mystery_status"));
  assertEquals(checkMakesafeBoardParity(rows).unmapped_stage_job_ids, [
    "job-mystery",
  ]);
});

Deno.test("trade visibility is server-shaped: ordinary allocated-only, Hugo all, Khairo make-safe allocated-only", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("new", "mine", {
      assignments: [{
        user_id: "ordinary",
        status: "scheduled",
        users: { name: "Ordinary" },
      }],
    }),
    baseJob("allocated", "other", {
      assignments: [{
        user_id: "other-trade",
        status: "scheduled",
        users: { name: "Other" },
      }],
    }),
  ]);

  const ordinary = projectTradeMakesafeBoard(rows, {
    userId: "ordinary",
    name: "Sam Trade",
    role: "installer",
    managedVerticals: [],
  });
  assertEquals(ordinary.rows.map((r) => r.id), ["mine"]);
  assertEquals(ordinary.rows[0].assignments.map((a: any) => a.user_id), [
    "ordinary",
  ]);

  const hugo = projectTradeMakesafeBoard(rows, {
    userId: "hugo",
    name: "Hugo",
    role: "installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(new Set(hugo.rows.map((r) => r.id)), new Set(["mine", "other"]));
  assertEquals(hugo.permissions.can_allocate, true);

  const khairo = projectTradeMakesafeBoard(rows, {
    userId: "khairo",
    name: "Khairo",
    role: "installer",
    managedVerticals: ["fencing"],
  });
  assertEquals(khairo.rows, []);
  assertEquals(khairo.permissions.fencing_view_only, true);
  assertEquals(khairo.permissions.can_allocate, false);
});

Deno.test("contact actions are always live-linked or explicitly unavailable", () => {
  const [linked] = buildCanonicalMakesafeRows([baseJob("allocated")]);
  assertEquals(linked.contact.client_name, "Kim Client");
  assertEquals(linked.contact.phone, "0400 111 222");
  assertEquals(linked.contact.actions.call.href, "tel:0400111222");
  assertEquals(linked.contact.actions.text.href, "sms:0400111222");
  assert(
    linked.contact.actions.navigate.href.includes(
      encodeURIComponent("10 Sample Street, Perth"),
    ),
  );

  const [missing] = buildCanonicalMakesafeRows([
    baseJob("new", "missing-contact", {
      client_name: null,
      client_phone: null,
      site_address: null,
      site_suburb: null,
    }),
  ]);
  assertEquals(missing.contact.actions.call.available, false);
  assertEquals(missing.contact.actions.call.href, null);
  assertEquals(missing.contact.actions.navigate.available, false);
  assert(missing.contact.actions.call.unavailable_reason.length > 0);
});

Deno.test("canonical row carries report/photos, pack/send, notes, age and separates stale substatus", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "facts", {
      substatus: "company_contact_required",
      makesafe_details: {
        substatus: "company_contact_required",
        report_received_at: NOW,
        report_type: "roof_report",
      },
      report: { status: "submitted", submitted_at: NOW, cycle_number: 2 },
      report_pack: { status: "drafted", report_doc_id: "doc-1", sent_at: null },
      docs_missing: true,
      missing_docs: ["invoice"],
      age_hours: 60,
    }),
  ], {
    photoCountByJobId: { facts: 7 },
    notesByJobId: {
      facts: [{
        id: "note-1",
        user_id: "trade-1",
        detail_json: { text: "Client not reachable" },
        users: { name: "Hugo" },
        created_at: NOW,
      }],
    },
  });

  assertEquals(row.report.submitted_at, NOW);
  assertEquals(row.report.photo_count, 7);
  assertEquals(row.pack.state, "drafted");
  assertEquals(row.notes[0].text, "Client not reachable");
  assertEquals(row.age.target_hours, 48);
  assertEquals(row.age.target_state, "over_target");
  assertEquals(
    row.blockers.stale_artifacts[0].code,
    "stale_company_contact_substatus",
  );
  assert(
    !row.blockers.real.some((b: any) => b.code === "client_contact_required"),
  );
  assert(
    row.blockers.real.some((b: any) => b.code === "closeout_documents_missing"),
  );
});

Deno.test("canonical row preserves the visible plain-English Captain action", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "captain-action", {
      captain_action: {
        code: "attendance_cycle_ruling",
        message:
          "Need you to choose which attendance cycle owns the submitted report.",
        evidence_refs: ["job_service_reports:report-1"],
        since: NOW,
      },
    }),
  ]);

  assertEquals(row.captain_action, {
    code: "attendance_cycle_ruling",
    message:
      "Need you to choose which attendance cycle owns the submitted report.",
    evidence_refs: ["job_service_reports:report-1"],
    since: NOW,
  });
});

Deno.test("canonical board exposes U4 Docs Ready identity and typed blockers without money facts", () => {
  const [ready] = buildCanonicalMakesafeRows([
    baseJob("report_ready", "u4-ready", {
      report_pack: {
        status: "drafted",
        review_state: "READY",
        docket_revision_id: "revision-ready",
        pre_xero_docs_ready: true,
        blockers: [],
      },
    }),
  ]);
  assertEquals(ready.pack.docket_revision_id, "revision-ready");
  assertEquals(ready.pack.pre_xero_docs_ready, true);
  assertEquals(ready.pack.drafted, true);
  assertEquals(ready.blockers.real, []);

  const [blocked] = buildCanonicalMakesafeRows([
    baseJob("trade_report_in", "u4-blocked", {
      report_pack: {
        status: "drafted",
        review_state: "U4_BLOCKED",
        docket_revision_id: "revision-blocked",
        pre_xero_docs_ready: false,
        blockers: [{
          reason_code: "spine_missing_source",
          reason: "not projected to the board",
        }],
      },
    }),
  ]);
  assertEquals(blocked.pack.pre_xero_docs_ready, false);
  assertEquals(blocked.blockers.real, [{
    code: "spine_missing_source",
    category: "ses_docket",
    docket_revision_id: "revision-blocked",
  }]);
  assertEquals("local_invoice_proposal" in blocked.pack, false);
});

Deno.test("captain-applied status is a display overlay and never rewrites declared or raw state", () => {
  const source = baseJob("new", "overlay", {
    substatus: "company_contact_required",
    makesafe_details: {
      substatus: "company_contact_required",
      cycle_number: 1,
    },
  });
  const [row] = buildCanonicalMakesafeRows([source], {
    statusApplicationsByJobId: {
      overlay: {
        run_key: "makesafe-stage1-20260724",
        job_id: "overlay",
        source_status: "new",
        before_status: "new",
        after_status: "allocated",
        evidence_ref: "review://makesafe-board-review-surface-v1",
        applied_by: "captain-approved-cutover",
        applied_at: NOW,
      },
    },
  });

  assertEquals(row.declared_stage, "new");
  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.canonical_stage_label, "Allocated");
  assertEquals(row.substatus, "company_contact_required");
  assertEquals(
    (source.makesafe_details as any).substatus,
    "company_contact_required",
  );
  assertEquals(row.status_application, {
    run_key: "makesafe-stage1-20260724",
    before_status: "new",
    after_status: "allocated",
    evidence_ref: "review://makesafe-board-review-surface-v1",
    applied_by: "captain-approved-cutover",
    applied_at: NOW,
  });
});

Deno.test("display overlay fails closed when its source is stale or the card is terminal", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("new", "stale"),
    baseJob("archive", "terminal"),
    baseJob("new", "closed-job", { status: "closed" }),
  ], {
    statusApplicationsByJobId: {
      stale: {
        source_status: "allocated",
        before_status: "allocated",
        after_status: "trade_report_in",
      },
      terminal: {
        source_status: "archive",
        before_status: "archive",
        after_status: "allocated",
      },
      "closed-job": {
        source_status: "new",
        before_status: "new",
        after_status: "allocated",
      },
    },
  });

  assertEquals(rows[0].canonical_stage, "new");
  assertEquals(rows[0].status_application, null);
  assertEquals(rows[1].canonical_stage, "archive");
  assertEquals(rows[1].computed_status, "archive");
  assertEquals(rows[1].status_application, null);
  assertEquals(rows[2].canonical_stage, "new");
  assertEquals(rows[2].computed_status, "completed");
  assertEquals(rows[2].status_application, null);
});

Deno.test("computed closeout reads the actual ACCREC status, not a synthetic board invoice label", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "no-invoice", {
      invoice_status: "invoiced",
      invoice_raw_status: null,
      pack_sent: true,
      report_pack: { status: "sent", sent_at: NOW },
      has_invoice_doc: false,
      has_report_doc: false,
    }),
  ]);

  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.computed_status, "allocated");
});

Deno.test("same property claim keeps one card per PO and links siblings", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("allocated", "po-a", {
      metadata: { builder_claim_ref: "MLB-900", builder_po_number: "PO-1" },
      external_ref: "MLB-900",
    }),
    baseJob("new", "po-b", {
      metadata: { builder_claim_ref: "MLB-900", builder_po_number: "PO-2" },
      external_ref: "MLB-900",
    }),
  ]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].lineage.one_card_per_po, true);
  assertEquals(rows[0].lineage.siblings[0].job_id, "po-b");
  assertEquals(rows[0].lineage.siblings[0].builder_po_number, "PO-2");
});

Deno.test("trade payload is an allow-list with no pricing or invoice data", () => {
  const [row] = buildCanonicalMakesafeRows([baseJob("allocated")]);
  (row as any).pricing_json = { total: 999 };
  (row as any).xero_invoice = { amount: 999 };
  (row as any).trade_invoices = [{ user_id: "other" }];
  const trade = projectTradeMakesafeBoard([row], {
    userId: "hugo",
    name: "Hugo",
    managedVerticals: ["makesafe"],
  });
  const payload = JSON.stringify(trade);
  assert(!payload.includes("pricing_json"));
  assert(!payload.includes("xero_invoice"));
  assert(!payload.includes("trade_invoices"));
  assert(!payload.includes("999"));
});

Deno.test("terminally accounted synthetic live-fire jobs disappear from both boards", () => {
  const synthetic = baseJob("cancelled", "synthetic-terminal", {
    metadata: {
      synthetic_livefire_marker:
        "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111",
      synthetic_livefire_terminal_at: NOW,
    },
  });
  assertEquals(isSyntheticLivefireJob(synthetic), true);
  assertEquals(isTerminalSyntheticLivefireJob(synthetic), true);
  assertEquals(buildCanonicalMakesafeRows([synthetic]).length, 1);
  assertEquals(
    buildCanonicalMakesafeRows([synthetic], {
      terminalSyntheticLivefireJobIds: new Set([synthetic.id]),
    }),
    [],
  );

  const lookalike = baseJob("cancelled", "ordinary-cancelled", {
    metadata: { synthetic_livefire_terminal_at: NOW },
  });
  assertEquals(isTerminalSyntheticLivefireJob(lookalike), false);
  assertEquals(buildCanonicalMakesafeRows([lookalike]).length, 1);

  const prefixLookalike = baseJob("cancelled", "prefix-lookalike", {
    metadata: {
      synthetic_livefire_marker: "SWG-SES-LIVEFIRE-TEST-ONLY-not-a-uuid",
      synthetic_livefire_terminal_at: NOW,
    },
  });
  assertEquals(isSyntheticLivefireJob(prefixLookalike), false);
  assertEquals(isTerminalSyntheticLivefireJob(prefixLookalike), false);
});

Deno.test("synthetic live-fire jobs are refused before any release operation", async () => {
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in(column: string, ids: string[]) {
              assertEquals(column, "id");
              assertEquals(ids, ["synthetic-job"]);
              return Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: {
                    synthetic_livefire_marker:
                      "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111",
                  },
                }],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireJobsForTest(
        client,
        ["synthetic-job"],
        "release",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );
});

Deno.test("synthetic-linked invoices are refused before invoice effects", async () => {
  const marker =
    "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111";
  const client = {
    from(table: string) {
      if (table === "xero_invoices") {
        return {
          select(columns: string) {
            assertEquals(columns, "job_id");
            return {
              eq(column: string, id: string) {
                assertEquals(column, "xero_invoice_id");
                assertEquals(id, "invoice-1");
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { job_id: "synthetic-job" },
                      error: null,
                    }),
                };
              },
            };
          },
        };
      }
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in: () =>
              Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: { synthetic_livefire_marker: marker },
                }],
                error: null,
              }),
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireInvoiceForTest(
        client,
        "invoice-1",
        "void_invoice",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );

  const unresolvedClient = {
    from(table: string) {
      assertEquals(table, "xero_invoices");
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              };
            },
          };
        },
      };
    },
  };
  await assertRejects(
    () =>
      _assertNoSyntheticLivefireInvoiceForTest(
        unresolvedClient,
        "missing",
        "void_invoice",
      ),
    Error,
    "synthetic_livefire_invoice_unresolved",
  );
});

Deno.test("synthetic live-fire release members cannot be approved or executed", async () => {
  const marker =
    "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111";
  const client = {
    from(table: string) {
      if (table === "makesafe_release_revision_members") {
        return {
          select(columns: string) {
            assertEquals(columns, "job_id");
            return {
              eq(column: string, id: string) {
                assertEquals(column, "release_revision_id");
                assertEquals(id, "release-1");
                return Promise.resolve({
                  data: [{ job_id: "synthetic-job" }],
                  error: null,
                });
              },
            };
          },
        };
      }
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in(column: string, ids: string[]) {
              assertEquals(column, "id");
              assertEquals(ids, ["synthetic-job"]);
              return Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: { synthetic_livefire_marker: marker },
                }],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireReleaseRevisionForTest(
        client,
        "release-1",
        "execute_ses_release_revision",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );
});
