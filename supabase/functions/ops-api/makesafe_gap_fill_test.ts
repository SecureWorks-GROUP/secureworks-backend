// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Tests for the batch AI gap-fill queue + apply (makesafe_gap_fill.ts and
// makesafe_gap_fill_report_ready.ts). Uses an in-memory Supabase double whose
// rows carry the production column names (test-schema fixtures). No network, no
// real DB, no model call.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyGapFill,
  buildAuditReason,
  computeCaseFill,
  describeGap,
  GAP_FILL_ACTOR,
  GAP_FILL_CONTRACT_VERSION,
  gapFillableFields,
  GapFillError,
  loadGapFillQueue,
  nextConflictingFields,
  nextMissingFields,
  reasonIsHumanOnly,
} from "./makesafe_gap_fill.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

// ── Minimal in-memory Supabase double ────────────────────────────────────────
interface Store {
  [table: string]: any[];
}

class FakeQuery {
  private filters: Array<(row: any) => boolean> = [];
  private sortKeys: Array<{ column: string; ascending: boolean }> = [];
  private limitTo: number | null = null;
  constructor(
    private store: Store,
    private table: string,
    private op: "select" | "update",
    private payload: any = null,
  ) {}
  private rows(): any[] {
    return (this.store[this.table] || []).filter((r) =>
      this.filters.every((f) => f(r))
    );
  }
  select(_cols?: string) {
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: any[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sortKeys.push({ column: col, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitTo = n;
    return this;
  }
  private run(): { data: any[]; error: any } {
    if (this.op === "update") {
      const matched = this.rows();
      for (const r of matched) Object.assign(r, this.payload);
      return { data: matched, error: null };
    }
    let data = this.rows();
    if (this.sortKeys.length) {
      data = [...data].sort((a, b) => {
        for (const { column, ascending } of this.sortKeys) {
          const l = String(a[column] ?? "");
          const r = String(b[column] ?? "");
          const cmp = l.localeCompare(r);
          if (cmp !== 0) return ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (this.limitTo !== null) data = data.slice(0, this.limitTo);
    return { data, error: null };
  }
  maybeSingle() {
    const { data, error } = this.run();
    return Promise.resolve({ data: data[0] ?? null, error });
  }
  single() {
    const { data } = this.run();
    return Promise.resolve(
      data.length
        ? { data: data[0], error: null }
        : { data: null, error: { message: "no rows", code: "PGRST116" } },
    );
  }
  then(resolve: (v: any) => void) {
    resolve(this.run());
  }
}

function fakeClient(store: Store) {
  return {
    store,
    from(table: string) {
      return {
        select: (c?: string) => new FakeQuery(store, table, "select").select(c),
        update: (payload: any) =>
          new FakeQuery(store, table, "update", payload),
      };
    },
  } as any;
}

function baseStore(): Store {
  return {
    makesafe_intake_cases: [],
    makesafe_intake_case_sources: [],
    emails: [],
    email_attachments: [],
    makesafe_job_details: [],
    makesafe_report_packs: [],
    jobs: [],
    job_service_reports: [],
  };
}

// A production-shaped exception case row missing client/site (adapter_parse_failure).
function exceptionCase(overrides: Record<string, any> = {}): any {
  return {
    id: "case-exc-1",
    org_id: ORG,
    instruction_key: "fingerprint:abc/deliverable:general/cycle:1",
    state: "exception",
    reason_code: "adapter_parse_failure",
    missing_fields: ["client_name", "site_address"],
    conflicting_fields: {},
    blocked_reasons: [],
    job_id: null,
    company_id: "11111111-1111-1111-1111-111111111111",
    company_slug_raw: "mlb",
    external_ref_canonical: "MLB-27037",
    builder_wo_canonical: "WO-27037",
    builder_po_canonical: null,
    deliverable_ref_canonical: "GENERAL_MAKESAFE",
    client_name: null,
    client_phone: null,
    client_email: null,
    site_address: null,
    site_suburb: null,
    evidence_map: {
      client_name: {
        status: "missing",
        nextRecoveryAction: "extract_client_name_from_selected_instruction",
      },
    },
    received_at: "2026-07-21T02:00:00.000Z",
    last_decision_provenance: "deterministic",
    last_decision_reason: "deterministic adapter_parse_failure",
    ...overrides,
  };
}

// ── Pure decision-logic tests ────────────────────────────────────────────────

Deno.test("describeGap surfaces the missing fields for a parse-failure exception", () => {
  const g = describeGap(exceptionCase());
  assert(g.includes("client_name"));
  assert(g.includes("site_address"));
});

Deno.test("describeGap marks unknown_builder / cancellation as no-fill", () => {
  assert(
    describeGap(exceptionCase({ reason_code: "unknown_builder" })).includes(
      "human",
    ),
  );
  assert(
    describeGap(exceptionCase({ reason_code: "cancellation" })).includes(
      "cancelled",
    ),
  );
});

Deno.test("gapFillableFields returns only currently-empty allow-listed fields", () => {
  assertEquals(gapFillableFields(exceptionCase()), [
    "client_name",
    "client_phone",
    "client_email",
    "site_address",
    "site_suburb",
  ]);
  const partly = exceptionCase({
    client_name: "Jane Doe",
    site_address: "1 St",
  });
  assertEquals(gapFillableFields(partly), [
    "client_phone",
    "client_email",
    "site_suburb",
  ]);
});

Deno.test("reasonIsHumanOnly: identity/cancellation/unknown-builder cases are human-only", () => {
  // below_identity_floor with NO fillable client/site material -> human only.
  assert(
    reasonIsHumanOnly(
      exceptionCase({
        reason_code: "below_identity_floor",
        client_name: "Set",
        client_phone: "0400000000",
        client_email: "a@b.com",
        site_address: "1 St",
        site_suburb: "Perth",
      }),
    ),
  );
  assert(reasonIsHumanOnly(exceptionCase({ reason_code: "unknown_builder" })));
  assert(reasonIsHumanOnly(exceptionCase({ reason_code: "cancellation" })));
  // adapter_parse_failure with empty client/site -> AI-fillable, not human-only.
  assertEquals(reasonIsHumanOnly(exceptionCase()), false);
});

Deno.test("computeCaseFill accepts empty allow-listed fields, rejects the rest", () => {
  const diff = computeCaseFill(exceptionCase(), {
    client_name: "Jane Doe",
    site_address: "10 Test St, Perth",
    company_slug_raw: "hacked", // not allow-listed
    client_phone: "   ", // empty after trim
  });
  assertEquals(diff.applied, {
    client_name: "Jane Doe",
    site_address: "10 Test St, Perth",
  });
  const skippedReasons = Object.fromEntries(
    diff.skipped.map((s) => [s.field, s.reason]),
  );
  assertEquals(skippedReasons.company_slug_raw, "field_not_allowlisted");
  assertEquals(skippedReasons.client_phone, "empty_value");
});

Deno.test("computeCaseFill never overwrites a populated field (additive-only)", () => {
  const diff = computeCaseFill(exceptionCase({ client_name: "Existing" }), {
    client_name: "Different",
  });
  assertEquals(diff.applied, {});
  assertEquals(diff.skipped[0].reason, "field_already_populated");
});

Deno.test("nextMissingFields drops filled fields, keeps non-fill requirements", () => {
  const caseRow = exceptionCase({
    missing_fields: ["client_name", "site_address", "work_order_attachment"],
  });
  assertEquals(
    nextMissingFields(caseRow, { client_name: "Jane", site_address: "1 St" }),
    ["work_order_attachment"],
  );
});

Deno.test("nextConflictingFields drops only the resolved conflict key", () => {
  const caseRow = exceptionCase({
    conflicting_fields: { client_name: ["A", "B"], site_address: ["X", "Y"] },
  });
  assertEquals(nextConflictingFields(caseRow, { client_name: "A" }), {
    site_address: ["X", "Y"],
  });
});

Deno.test("buildAuditReason names the fill source and embeds fields + evidence", () => {
  const reason = buildAuditReason(
    { client_name: "Jane", site_address: "1 St" },
    "client_name from WO PDF att-1",
  );
  assert(reason.includes("AI gap-fill"));
  assert(reason.includes(GAP_FILL_CONTRACT_VERSION));
  assert(reason.includes("client_name"));
  assert(reason.includes("Evidence: client_name from WO PDF att-1"));
});

// ── Queue loader tests (client-touching) ─────────────────────────────────────

Deno.test("loadGapFillQueue returns exception + blocked flags with evidence pointers", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(
    exceptionCase(),
    // A blocked_live_job missing only client_phone (secondary).
    {
      ...exceptionCase({
        id: "case-blk-1",
        instruction_key: "fingerprint:blk/deliverable:general/cycle:1",
        state: "blocked_live_job",
        reason_code: null,
        missing_fields: ["client_phone"],
        blocked_reasons: ["missing:client_phone"],
        job_id: "22222222-2222-2222-2222-222222222222",
        client_name: "Blocked Client",
        site_address: "9 Blocked Rd",
        received_at: "2026-07-21T05:00:00.000Z",
      }),
    },
    // Must NOT appear: a confirmed live case and an accounted non-work case.
    exceptionCase({
      id: "case-live-1",
      instruction_key: "fingerprint:live/deliverable:general/cycle:1",
      state: "confirmed_live_job",
      reason_code: null,
    }),
    exceptionCase({
      id: "case-nw-1",
      instruction_key: "fingerprint:nw/deliverable:general/cycle:1",
      state: "accounted_non_wo",
      reason_code: "non_makesafe",
    }),
  );
  store.makesafe_intake_case_sources.push({
    id: "src-1",
    org_id: ORG,
    case_id: "case-exc-1",
    post_id: "post-1",
    role: "original",
    received_at: "2026-07-21T02:00:00.000Z",
    attachment_refs: ["att-1"],
  });
  store.emails.push({
    post_id: "post-1",
    subject: "NEW WORK ORDER MLB-27037",
    from_email: "dispatch@mlb.test",
    from_name: "MLB Dispatch",
    received_at: "2026-07-21T02:00:00.000Z",
  });
  store.email_attachments.push({
    id: "att-1",
    email_id: "post-1",
    name: "Work Order.pdf",
    content_type: "application/pdf",
    status: "uploaded",
    size_bytes: 1200,
  });

  const queue = await loadGapFillQueue(fakeClient(store), {
    includeReportReady: false,
  });
  assertEquals(queue.contract_version, GAP_FILL_CONTRACT_VERSION);
  assertEquals(queue.intake_flags.length, 2); // exception + blocked only
  assertEquals(queue.totals.intake_flags, 2);
  assertEquals(queue.totals.ai_fillable, 2);

  // Ordered most-recent first: blocked (05:00) then exception (02:00).
  assertEquals(queue.intake_flags[0].case_id, "case-blk-1");
  assertEquals(queue.intake_flags[1].case_id, "case-exc-1");

  const exc = queue.intake_flags[1];
  assertEquals(exc.ai_fillable_fields.includes("client_name"), true);
  assertEquals(exc.human_only, false);
  assertEquals(exc.evidence_sources.length, 1);
  assertEquals(exc.evidence_sources[0].post_id, "post-1");
  assertEquals(exc.evidence_sources[0].attachments[0].is_pdf, true);
  assertEquals(
    exc.recovery_hints.client_name,
    "extract_client_name_from_selected_instruction",
  );
});

Deno.test("loadGapFillQueue flags human-only cases and counts them separately", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(
    exceptionCase({ id: "case-unknown", reason_code: "unknown_builder" }),
  );
  const queue = await loadGapFillQueue(fakeClient(store), {
    includeReportReady: false,
  });
  assertEquals(queue.totals.intake_flags, 1);
  assertEquals(queue.totals.human_only, 1);
  assertEquals(queue.totals.ai_fillable, 0);
  assertEquals(queue.intake_flags[0].human_only, true);
});

Deno.test("loadGapFillQueue includes report-ready jobs (submitted, pack not drafted)", async () => {
  const store = baseStore();
  // Due: substatus report-ready, no pack row, not sent, not report-type.
  store.makesafe_job_details.push({
    job_id: "job-due-1",
    substatus: "admin_to_send_report",
    report_received_at: "2026-07-21T06:00:00.000Z",
    report_sent_at: null,
    report_type: null,
    external_ref: "AJBR-67713",
    requesting_company_slug: "ajs-ajbr",
    requesting_company_name: "AJS",
    cycle_number: 1,
  });
  // NOT due: already sent.
  store.makesafe_job_details.push({
    job_id: "job-sent",
    substatus: "admin_to_send_report",
    report_received_at: "2026-07-20T06:00:00.000Z",
    report_sent_at: "2026-07-20T09:00:00.000Z",
    report_type: null,
  });
  // NOT due: report-type job (own portal path).
  store.makesafe_job_details.push({
    job_id: "job-report-type",
    substatus: "admin_to_send_report",
    report_sent_at: null,
    report_type: "roof_report",
  });
  // NOT due: pack already fully drafted (report_doc_id + xero_invoice_id set).
  store.makesafe_job_details.push({
    job_id: "job-drafted",
    substatus: "admin_to_send_report",
    report_sent_at: null,
    report_type: null,
  });
  store.makesafe_report_packs.push({
    job_id: "job-drafted",
    pack_kind: "main",
    status: "drafted",
    report_doc_id: "doc-1",
    invoice_doc_id: "idoc-1",
    xero_invoice_id: "xero-1",
  });
  store.jobs.push({
    id: "job-due-1",
    job_number: "SWM-0001",
    client_name: "Due Client",
    site_suburb: "Joondalup",
  });
  store.job_service_reports.push({
    id: "rep-1",
    job_id: "job-due-1",
    status: "submitted",
    cycle_number: 1,
    submitted_at: "2026-07-21T06:00:00.000Z",
  });

  const queue = await loadGapFillQueue(fakeClient(store), {});
  assertEquals(queue.report_ready.length, 1);
  assertEquals(queue.totals.report_ready, 1);
  const item = queue.report_ready[0];
  assertEquals(item.job_id, "job-due-1");
  assertEquals(item.job_number, "SWM-0001");
  assertEquals(item.builder, "ajs-ajbr");
  assertEquals(item.external_ref, "AJBR-67713");
  assertEquals(item.service_report_id, "rep-1");
});

// ── Apply tests (client-touching) ────────────────────────────────────────────

Deno.test("applyGapFill fills empty fields with an audited ai decision", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(exceptionCase());
  const client = fakeClient(store);
  const result = await applyGapFill(client, {
    caseId: "case-exc-1",
    fills: { client_name: "Jane Doe", site_address: "10 Test St, Perth" },
    evidenceNote: "client_name + address from WO PDF att-1",
  });
  assertEquals(result.applied, true);
  assertEquals(result.filled, {
    client_name: "Jane Doe",
    site_address: "10 Test St, Perth",
  });

  const row = store.makesafe_intake_cases[0];
  assertEquals(row.client_name, "Jane Doe");
  assertEquals(row.site_address, "10 Test St, Perth");
  // Missing fields dropped for the filled ones.
  assertEquals(row.missing_fields, []);
  // Audit: provenance ai, fresh reason naming the gap-fill, state untouched.
  assertEquals(row.last_decision_provenance, "ai");
  assertEquals(row.last_decision_actor, GAP_FILL_ACTOR);
  assert(row.last_decision_reason.includes("AI gap-fill"));
  assert(row.last_decision_reason !== "deterministic adapter_parse_failure");
  assertEquals(row.state, "exception"); // never transitions state
  assertEquals(row.job_id, null); // never creates a job
});

Deno.test("applyGapFill is idempotent: a re-run with a populated field is a no-op", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(exceptionCase({ client_name: "Jane Doe" }));
  const before = { ...store.makesafe_intake_cases[0] };
  const result = await applyGapFill(fakeClient(store), {
    caseId: "case-exc-1",
    fills: { client_name: "Jane Doe" },
  });
  assertEquals(result.applied, false);
  assertEquals(result.reason, "no_fillable_change");
  assertEquals(result.skipped[0].reason, "field_already_populated");
  // No write happened: decision metadata is unchanged (would trip the DB trigger).
  assertEquals(
    store.makesafe_intake_cases[0].last_decision_provenance,
    before.last_decision_provenance,
  );
});

Deno.test("applyGapFill resolves a conflict by filling the field and clearing that key", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(
    exceptionCase({
      reason_code: "conflicting_fields",
      conflicting_fields: { client_name: ["Jane Doe", "J. Doe"] },
      missing_fields: [],
    }),
  );
  const result = await applyGapFill(fakeClient(store), {
    caseId: "case-exc-1",
    fills: { client_name: "Jane Doe" },
    evidenceNote: "WO PDF names the insured as Jane Doe",
  });
  assertEquals(result.applied, true);
  assertEquals(store.makesafe_intake_cases[0].client_name, "Jane Doe");
  assertEquals(store.makesafe_intake_cases[0].conflicting_fields, {});
});

Deno.test("applyGapFill refuses a non-flag case and a missing case", async () => {
  const store = baseStore();
  store.makesafe_intake_cases.push(
    exceptionCase({
      id: "case-live",
      state: "confirmed_live_job",
      reason_code: null,
    }),
  );
  await assertRejects(
    () =>
      applyGapFill(fakeClient(store), {
        caseId: "case-live",
        fills: { client_phone: "0400000000" },
      }),
    GapFillError,
    "not a gap-fill flag",
  );
  await assertRejects(
    () =>
      applyGapFill(fakeClient(store), {
        caseId: "does-not-exist",
        fills: { client_name: "X" },
      }),
    GapFillError,
    "case not found",
  );
});

Deno.test("applyGapFill requires an identifier and a fills object", async () => {
  const store = baseStore();
  await assertRejects(
    () => applyGapFill(fakeClient(store), { fills: { client_name: "X" } }),
    GapFillError,
    "caseId or instructionKey is required",
  );
  await assertRejects(
    () => applyGapFill(fakeClient(store), { caseId: "case-exc-1" }),
    GapFillError,
    "fills object is required",
  );
});
