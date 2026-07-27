// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Behavioural runtime tests over an in-memory Supabase double. These cover the
// two invariants that pure-plan tests cannot reach: thread coordinates actually
// being read from `emails`, and a resumed exception being re-decided against the
// current plan rather than left stuck.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _ensureDraftAndJobForTest,
  _readInputsForTest,
  enrichSourcesWithPdfText,
  runDeterministicIntake,
} from "./makesafe_deterministic_intake_runtime.ts";
import {
  buildDeterministicIntakePlan,
  DETERMINISTIC_INTAKE_VERSION,
} from "./makesafe_deterministic_intake.ts";

const NOW = "2026-07-20T12:00:00.000Z";
const ORG = "00000000-0000-0000-0000-000000000001";
const ENCODER = new TextEncoder();

function digitalWorkOrderPdf(
  lines: readonly string[] = [
    "Work Order Number MLB-26770PO-55296",
    "Policyholders Name Amanda Parker",
    "Mobile 0422636182",
    "Site Address 8 Syrinx Pl Mullaloo WA 6027",
    "Scope of Works Install temporary roof tarps and make the storm damaged property safe",
    "Notes",
    "Attend within twenty four hours and protect the occupants and contents from weather damage",
  ],
): Uint8Array {
  const content = `BT /F1 10 Tf 72 760 Td ${
    lines.map((line) => `(${line}) Tj 0 -14 Td`).join(" ")
  } ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${
      ENCODER.encode(content).length
    } >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(ENCODER.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = ENCODER.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return ENCODER.encode(pdf);
}

interface Store {
  [table: string]: any[];
}

// Evaluate a single PostgREST leaf condition ("col.op.value") against a row,
// mirroring the String-comparison semantics the other filters use.
function evalPostgrestLeaf(row: any, token: string): boolean {
  const first = token.indexOf(".");
  const second = token.indexOf(".", first + 1);
  const column = token.slice(0, first);
  const op = token.slice(first + 1, second);
  let value = token.slice(second + 1);
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  const left = String(row[column] ?? "");
  const right = String(value);
  if (op === "eq") return left === right;
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;
  throw new Error(`fake .or() does not support op ${op}`);
}

// Split a PostgREST boolean expression on commas that sit at the top level, so
// nested and(...) / or(...) groups stay intact.
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function evalPostgrestExpr(row: any, expr: string): boolean {
  if (expr.startsWith("and(") && expr.endsWith(")")) {
    return splitTopLevel(expr.slice(4, -1)).every((clause) =>
      evalPostgrestExpr(row, clause)
    );
  }
  if (expr.startsWith("or(") && expr.endsWith(")")) {
    return splitTopLevel(expr.slice(3, -1)).some((clause) =>
      evalPostgrestExpr(row, clause)
    );
  }
  return evalPostgrestLeaf(row, expr);
}

class FakeQuery {
  private filters: Array<(row: any) => boolean> = [];
  private sliceRange: [number, number] | null = null;
  private limitTo: number | null = null;
  private sortKeys: Array<{ column: string; ascending: boolean }> = [];
  selectedColumns: string | null = null;

  constructor(
    private store: Store,
    private table: string,
    private op: "select" | "insert" | "update" | "upsert",
    private payload: any = null,
    private log?: (table: string, columns: string) => void,
    private inLog?: (table: string, column: string, count: number) => void,
    private fail?: (
      table: string,
      operation: "select" | "insert" | "update" | "upsert",
      payload: any,
    ) => any,
  ) {}

  private rows(): any[] {
    return (this.store[this.table] || []).filter((row) =>
      this.filters.every((f) => f(row))
    );
  }

  select(columns: string) {
    this.selectedColumns = columns;
    this.log?.(this.table, columns);
    return this;
  }
  eq(column: string, value: any) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: any) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  gte(column: string, value: any) {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }
  gt(column: string, value: any) {
    this.filters.push((row) => String(row[column]) > String(value));
    return this;
  }
  in(column: string, values: any[]) {
    this.inLog?.(this.table, column, values.length);
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  or(expr: string) {
    this.filters.push((row) =>
      splitTopLevel(expr).some((clause) => evalPostgrestExpr(row, clause))
    );
    return this;
  }
  // The bounded two-part read depends on real ordering, so the double sorts
  // rather than returning insertion order. Chained order() calls compose into a
  // tuple sort, matching PostgREST's secondary-order semantics.
  order(column: string, opts?: { ascending?: boolean }) {
    this.sortKeys.push({ column, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitTo = n;
    return this;
  }
  range(from: number, to: number) {
    this.sliceRange = [from, to];
    return this;
  }

  private run(): { data: any[]; error: any } {
    this.store[this.table] ||= [];
    const injectedError = this.fail?.(this.table, this.op, this.payload);
    if (injectedError) return { data: [], error: injectedError };
    if (this.op === "insert") {
      const duplicate = this.table === "makesafe_intake_cases"
        ? this.store[this.table].some((row) =>
          row.org_id === this.payload.org_id &&
          row.instruction_key === this.payload.instruction_key
        )
        : this.table === "makesafe_intake_case_sources"
        ? this.store[this.table].some((row) =>
          row.org_id === this.payload.org_id &&
          row.post_id === this.payload.post_id
        )
        : this.table === "makesafe_intake_artifacts"
        ? this.store[this.table].some((row) =>
          row.org_id === this.payload.org_id &&
          row.artifact_key === this.payload.artifact_key
        )
        : this.table === "makesafe_intake_drafts" &&
            this.payload.deterministic_key
        ? this.store[this.table].some((row) =>
          row.org_id === this.payload.org_id &&
          row.deterministic_key === this.payload.deterministic_key
        )
        : this.table === "email_events_raw" &&
            String(this.payload.change_type || "").startsWith("intake_")
        ? this.store[this.table].some((row) =>
          row.org_id === this.payload.org_id &&
          row.post_id === this.payload.post_id &&
          row.change_type === this.payload.change_type
        )
        : false;
      if (duplicate) {
        return {
          data: [],
          error: { code: "23505", message: "duplicate key value" },
        };
      }
      const id = `${this.table}-${this.store[this.table].length + 1}`;
      let payload = this.payload;
      if (this.table === "makesafe_intake_cases") {
        const parent = this.payload.parent_case_id
          ? this.store[this.table].find((candidate) =>
            candidate.org_id === this.payload.org_id &&
            candidate.id === this.payload.parent_case_id
          )
          : null;
        if (this.payload.parent_case_id && !parent) {
          return {
            data: [],
            error: { code: "23503", message: "lineage parent does not exist" },
          };
        }
        const cycle = parent
          ? this.payload.parent_relation === "reopen_of"
            ? (parent.cycle ?? 1) + 1
            : parent.cycle ?? 1
          : this.payload.cycle ?? 1;
        if (!String(this.payload.instruction_key).endsWith(`/cycle:${cycle}`)) {
          return {
            data: [],
            error: {
              code: "23514",
              message:
                "makesafe_intake_cases_instruction_key_cycle_check violated",
            },
          };
        }
        payload = {
          ...this.payload,
          cycle,
          lineage_id: parent ? parent.lineage_id ?? parent.id : id,
        };
      }
      const row = { id, ...payload };
      this.store[this.table].push(row);
      return { data: [row], error: null };
    }
    if (this.op === "upsert") {
      const rows = this.store[this.table];
      const index = rows.findIndex((r) => r.id === this.payload.id);
      if (index >= 0) rows[index] = { ...rows[index], ...this.payload };
      else rows.push({ ...this.payload });
      return { data: [this.payload], error: null };
    }
    if (this.op === "update") {
      const matched = this.rows();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null };
    }
    let data = this.rows();
    if (this.sortKeys.length) {
      data = data
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          for (const { column, ascending } of this.sortKeys) {
            const left = String(a.row[column] ?? "");
            const right = String(b.row[column] ?? "");
            const cmp = left.localeCompare(right);
            if (cmp !== 0) return ascending ? cmp : -cmp;
          }
          const primaryAscending = this.sortKeys[0].ascending;
          return primaryAscending ? a.index - b.index : b.index - a.index;
        })
        .map((entry) => entry.row);
    }
    if (this.sliceRange) {
      data = data.slice(this.sliceRange[0], this.sliceRange[1] + 1);
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
      data.length ? { data: data[0], error: null } : {
        data: null,
        error: { message: "no rows returned", code: "PGRST116" },
      },
    );
  }
  then(resolve: (value: any) => void) {
    resolve(this.run());
  }
}

function fakeClient(
  store: Store,
  selectLog: Array<[string, string]> = [],
  inLog?: (table: string, column: string, count: number) => void,
  downloadBytes?: (path: string) => Uint8Array,
  fail?: (
    table: string,
    operation: "select" | "insert" | "update" | "upsert",
    payload: any,
  ) => any,
) {
  return {
    selectLog,
    store,
    rpc(name: string, args: any) {
      if (name !== "makesafe_intake_fresh_source_health") {
        return Promise.resolve({
          data: null,
          error: { message: `unsupported fake rpc ${name}` },
        });
      }
      const eligible = (store.emails || []).filter((row: any) =>
        row.mailbox === args.p_mailbox &&
        String(row.received_at) >= String(args.p_since)
      );
      const isFinal = (postId: string) => {
        const caseSourceCount = (store.makesafe_intake_case_sources || [])
          .filter((row: any) =>
            row.org_id === args.p_org_id && row.post_id === postId
          ).length;
        const classifierExcluded =
          (store.email_classifier_exclusions || []).some((row: any) =>
            row.mailbox === args.p_mailbox && row.post_id === postId
          ) ||
          (store.email_events_raw || []).some((row: any) =>
            row.org_id === args.p_org_id && row.post_id === postId &&
            row.change_type === "excluded"
          );
        return caseSourceCount + (classifierExcluded ? 1 : 0) === 1;
      };
      const finalRows = eligible.filter((row: any) =>
        isFinal(String(row.post_id))
      );
      const unfatedRows = eligible.filter((row: any) =>
        !isFinal(String(row.post_id))
      );
      const latest = (rows: any[]) =>
        rows.map((row) => String(row.received_at)).sort().at(-1) ?? null;
      const oldest = (rows: any[]) =>
        rows.map((row) => String(row.received_at)).sort()[0] ?? null;
      const oldestUnfated = oldest(unfatedRows);
      const cursor = (store.mail_sync_cursors || []).find((row: any) =>
        row.mailbox === args.p_mailbox
      );
      return Promise.resolve({
        data: [{
          latest_ingested_received_at: cursor?.last_completed_max ?? null,
          latest_final_fate_received_at: latest(finalRows),
          unfated_source_count: unfatedRows.length,
          oldest_unfated_received_at: oldestUnfated,
          fresh_source_lag_seconds: oldestUnfated
            ? Math.max(
              0,
              Math.floor(
                (Date.parse(args.p_now) - Date.parse(oldestUnfated)) / 1000,
              ),
            )
            : 0,
        }],
        error: null,
      });
    },
    from(table: string) {
      const log = (t: string, c: string) => selectLog.push([t, c]);
      return {
        select: (columns: string) =>
          new FakeQuery(store, table, "select", null, log, inLog, fail).select(
            columns,
          ),
        insert: (payload: any) =>
          new FakeQuery(store, table, "insert", payload, log, inLog, fail),
        update: (payload: any) =>
          new FakeQuery(store, table, "update", payload, log, inLog, fail),
        upsert: (payload: any) =>
          new FakeQuery(store, table, "upsert", payload, log, inLog, fail),
      };
    },
    storage: {
      from() {
        return {
          download: (path: string) =>
            Promise.resolve({
              data: {
                arrayBuffer: () =>
                  Promise.resolve(
                    (downloadBytes?.(path) || new Uint8Array([1, 2, 3])).buffer,
                  ),
              },
              error: null,
            }),
          upload: () => Promise.resolve({ data: {}, error: null }),
          getPublicUrl: () => ({
            data: { publicUrl: "https://example.test/doc.pdf" },
          }),
        };
      },
    },
  } as any;
}

function baseStore(): Store {
  return {
    makesafe_companies: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        slug: "mlb",
        name: "MLB",
        sender_patterns: ["mlb.test"],
        parsing_rules: null,
        active: true,
      },
    ],
    emails: [],
    email_attachments: [],
    makesafe_intake_cases: [],
    makesafe_intake_case_sources: [],
    makesafe_intake_artifacts: [],
    makesafe_intake_drafts: [],
    makesafe_intake_health: [],
    makesafe_intake_case_events: [],
    email_events_raw: [],
    email_classifier_exclusions: [],
    mail_sync_cursors: [],
    jobs: [],
    makesafe_job_details: [],
    makesafe_intake_source_authority_corrections: [],
    makesafe_intake_source_authority_correction_supersessions: [],
  };
}

function email(input: Record<string, any>) {
  return {
    post_id: input.post_id,
    mailbox: "ses@secureworkswa.com.au",
    internet_message_id: input.internet_message_id ?? null,
    conversation_id: input.conversation_id ?? null,
    thread_id: input.thread_id ?? null,
    from_email: input.from_email ?? "dispatch@mlb.test",
    from_name: "MLB Dispatch",
    subject: input.subject ?? "",
    body_content: input.body_content ?? "",
    body_preview: null,
    received_at: input.received_at ?? "2026-07-20T01:00:00.000Z",
    pii_purged_at: null,
    makesafe_scanned_at: input.makesafe_scanned_at ?? null,
  };
}

const approveDraft = (_client: any, _body: any) =>
  Promise.resolve({ job: { id: "job-abc" } });

function cancellationFixture(
  statuses: readonly string[] = ["accepted"],
): Store {
  const store = baseStore();
  store.emails.push(email({
    post_id: "cancel-source",
    subject: "CANCELLED WORK ORDER - MLB-27001 Work Order: WO-27001 PO: 99001",
    body_content: "Please cancel this work order.",
  }));
  statuses.forEach((status, index) => {
    const id = `cancel-job-${index + 1}`;
    store.jobs.push({ id, status, type: "makesafe" });
    store.makesafe_job_details.push({
      job_id: id,
      external_ref: "MLB-27001",
      requesting_company_slug: "mlb",
      requesting_company_name: "MLB",
      report_type: null,
      jobs: {
        id,
        status,
        type: "makesafe",
        site_address: "1 Exact Street",
        metadata: {
          builder_work_order_number: "WO-27001",
          builder_po_number: "99001",
        },
      },
    });
  });
  return store;
}

Deno.test("cancellation resolves one exact job, calls the canonical boundary, and proves cancelled read-back", async () => {
  const store = cancellationFixture();
  let command: any = null;
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["cancel-source"],
    maxCases: 1,
    approveDraft,
    applyBuilderCancellation: (args) => {
      command = args;
      store.jobs[0].status = "cancelled";
      store.makesafe_job_details[0].jobs.status = "cancelled";
      return Promise.resolve({ ok: true, cancelled: true });
    },
  });

  assertEquals(report.quality_measure.version, DETERMINISTIC_INTAKE_VERSION);
  assertEquals(report.quality_measure.instructions, 1);
  assert(report.quality_measure.by_builder.mlb !== undefined);

  assertEquals(command.targetJobId, "cancel-job-1");
  assertEquals(command.reasonCode, "builder_recalled");
  const saved = store.makesafe_intake_cases[0];
  assertEquals(saved.reason_code, "cancellation");
  assertEquals(saved.target_relation, "cancellation_of");
  assertEquals(saved.target_job_id, "cancel-job-1");
  assertEquals(report.evidence.durable_source_fates, {
    checked: 1,
    final: 1,
    transient: 0,
  });
  assertEquals(store.makesafe_intake_case_sources.length, 1);
  assertEquals(
    store.makesafe_intake_case_events.at(-1).evidence.read_back_status,
    "cancelled",
  );
});

Deno.test("ambiguous cancellation fails closed without calling the cancellation command", async () => {
  const store = cancellationFixture(["accepted", "scheduled"]);
  let calls = 0;
  await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["cancel-source"],
    maxCases: 1,
    approveDraft,
    applyBuilderCancellation: () => {
      calls++;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(calls, 0);
  assertEquals(
    store.makesafe_intake_cases[0].reason_code,
    "cancellation_target_ambiguous",
  );
  assertEquals(store.makesafe_intake_cases[0].target_job_id, null);
  assertEquals(
    store.makesafe_intake_case_events.at(-1).evidence.candidate_job_ids,
    ["cancel-job-1", "cancel-job-2"],
  );
});

Deno.test("one ambiguous live-job binding files one exception while clean sources keep advancing", async () => {
  const store = baseStore();
  const pdfs = new Map<string, Uint8Array>();
  const addWorkOrder = (
    postId: string,
    externalRef: string,
    clientName: string,
    address: string,
    receivedAt: string,
  ) => {
    const storagePath = `raw/${postId}.pdf`;
    const bytes = digitalWorkOrderPdf([
      `Work Order Number ${externalRef}`,
      `Policyholders Name ${clientName}`,
      "Mobile 0422636182",
      `Site Address ${address}`,
      "Scope of Works Install temporary roof tarps and make the storm damaged property safe",
      "Notes",
      "Attend within twenty four hours and protect the occupants and contents from weather damage",
    ]);
    store.emails.push(email({
      post_id: postId,
      received_at: receivedAt,
      subject: `NEW WORK ORDER ${externalRef}`,
      body_content: "Please attend. The builder work order is attached.",
    }));
    store.email_attachments.push({
      id: `${postId}-attachment`,
      email_id: postId,
      name: `${externalRef} Work Order.pdf`,
      content_type: "application/pdf",
      storage_path: storagePath,
      status: "uploaded",
      size_bytes: bytes.length,
    });
    pdfs.set(storagePath, bytes);
  };
  addWorkOrder(
    "ambiguous-source",
    "MLB-25897",
    "Ambiguous Client",
    "4 Shared Claim Road Perth WA 6000",
    "2026-07-20T03:00:00.000Z",
  );
  addWorkOrder(
    "clean-source-1",
    "MLB-27002",
    "Clean Client One",
    "2 Clean Road Perth WA 6000",
    "2026-07-20T02:00:00.000Z",
  );
  addWorkOrder(
    "clean-source-2",
    "MLB-27003",
    "Clean Client Two",
    "3 Clean Road Perth WA 6000",
    "2026-07-20T01:00:00.000Z",
  );
  for (
    const [id, jobNumber] of [
      ["ambiguous-job-1", "SWMS-1001"],
      ["ambiguous-job-2", "SWMS-1002"],
    ]
  ) {
    store.jobs.push({
      id,
      job_number: jobNumber,
      status: "accepted",
      type: "makesafe",
    });
    store.makesafe_job_details.push({
      job_id: id,
      external_ref: "MLB-25897",
      requesting_company_slug: "mlb",
      requesting_company_name: "MLB",
      report_type: null,
      jobs: {
        id,
        job_number: jobNumber,
        status: "accepted",
        type: "makesafe",
        site_address: "4 Shared Claim Road Perth WA 6000",
        metadata: { builder_work_order_number: "MLB-25897" },
      },
    });
  }
  let approvals = 0;
  const report = await runDeterministicIntake(
    fakeClient(
      store,
      [],
      undefined,
      (path) => pdfs.get(path) || ENCODER.encode("%PDF-1.7\nmissing"),
    ),
    {
      dryRun: false,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxSources: 6,
      maxCases: 3,
      approveDraft: () =>
        Promise.resolve({ job: { id: `clean-job-${++approvals}` } }),
    },
  );

  assertEquals(report.totals.cases_attempted, 3);
  assertEquals(report.totals.write_failures, 0);
  assertEquals(approvals, 2);
  assertEquals(store.makesafe_intake_case_sources.length, 3);
  assertEquals(
    store.makesafe_intake_cases.filter((row) =>
      row.reason_code === "conflicting_fields"
    ).map((row) => ({
      state: row.state,
      candidates: row.conflicting_fields.live_job_binding,
    })),
    [{
      state: "exception",
      candidates: ["SWMS-1001", "SWMS-1002"],
    }],
  );
  assertEquals(
    store.makesafe_intake_cases.filter((row) =>
      row.state === "confirmed_live_job"
    ).length,
    2,
  );
  assertEquals(report.evidence.durable_source_fates, {
    checked: 3,
    final: 3,
    transient: 0,
  });
  assertEquals(store.makesafe_intake_health[0].extraction_status, "ok");
  assertEquals(store.makesafe_intake_health[0].last_scan_at, NOW);

  store.makesafe_intake_cases[0].job_id = "ambiguous-job-1";
  let resumedApprovals = 0;
  const resumed = await runDeterministicIntake(
    fakeClient(
      store,
      [],
      undefined,
      (path) => pdfs.get(path) || ENCODER.encode("%PDF-1.7\nmissing"),
    ),
    {
      dryRun: false,
      selectionMode: "exact",
      allowSourcePostIds: ["ambiguous-source"],
      maxCases: 1,
      nowIso: NOW,
      approveDraft: () => {
        resumedApprovals++;
        return Promise.resolve({ job: { id: "must-not-be-created" } });
      },
    },
  );
  assertEquals(resumed.totals.cases_attempted, 1);
  assertEquals(resumedApprovals, 0);
  assertEquals(store.makesafe_intake_cases[0].state, "exception");
  assertEquals(
    store.makesafe_intake_cases[0].conflicting_fields.live_job_binding,
    ["SWMS-1001", "SWMS-1002"],
  );
});

Deno.test("a corrected target mismatch becomes one visible binding exception", async () => {
  const store = baseStore();
  const postId = "corrected-target-source";
  const externalRef = "MLB-26190";
  const address = "9 Corrected Target Road Perth WA 6000";
  const storagePath = `raw/${postId}.pdf`;
  const bytes = digitalWorkOrderPdf([
    `Work Order Number ${externalRef}`,
    "Policyholders Name Corrected Target Client",
    "Mobile 0422636182",
    `Site Address ${address}`,
    "Scope of Works Install temporary roof tarps and make the storm damaged property safe",
  ]);
  store.emails.push(email({
    post_id: postId,
    subject: `NEW WORK ORDER ${externalRef}`,
    body_content: "Please attend. The builder work order is attached.",
  }));
  store.email_attachments.push({
    id: `${postId}-attachment`,
    email_id: postId,
    name: `${externalRef} Work Order.pdf`,
    content_type: "application/pdf",
    storage_path: storagePath,
    status: "uploaded",
    size_bytes: bytes.length,
  });
  for (
    const [id, jobNumber, candidateRef] of [
      ["identity-match-job", "SWMS-2001", externalRef],
      ["corrected-target-job", "SWMS-2002", "MLB-99999"],
    ]
  ) {
    store.jobs.push({
      id,
      job_number: jobNumber,
      status: "accepted",
      type: "makesafe",
    });
    store.makesafe_job_details.push({
      job_id: id,
      external_ref: candidateRef,
      requesting_company_slug: "mlb",
      requesting_company_name: "MLB",
      report_type: null,
      jobs: {
        id,
        job_number: jobNumber,
        status: "accepted",
        type: "makesafe",
        site_address: address,
        metadata: { builder_work_order_number: candidateRef },
      },
    });
  }
  store.makesafe_intake_source_authority_corrections.push({
    id: "correction-1",
    org_id: ORG,
    source_post_id: postId,
    legacy_case_id: null,
    effective_case_id: null,
    target_job_id: "corrected-target-job",
    expected_identity_key: null,
  });
  let approvals = 0;
  const report = await runDeterministicIntake(
    fakeClient(store, [], undefined, () => bytes),
    {
      dryRun: false,
      selectionMode: "exact",
      allowSourcePostIds: [postId],
      maxCases: 1,
      approveDraft: () => {
        approvals++;
        return Promise.resolve({ job: { id: "must-not-be-created" } });
      },
      nowIso: NOW,
    },
  );

  assertEquals(report.totals.cases_attempted, 1);
  assertEquals(report.totals.write_failures, 0);
  assertEquals(approvals, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_cases[0].state, "exception");
  assertEquals(
    store.makesafe_intake_cases[0].reason_code,
    "conflicting_fields",
  );
  assertEquals(
    store.makesafe_intake_cases[0].conflicting_fields
      .corrected_target_job_binding,
    ["SWMS-2001", "SWMS-2002"],
  );
  assertEquals(report.evidence.durable_source_fates, {
    checked: 1,
    final: 1,
    transient: 0,
  });
});

Deno.test("already-cancelled, live-invoice and terminal cancellation outcomes stay typed", async () => {
  for (
    const fixture of [
      {
        status: "cancelled",
        result: { ok: true },
        reason: "cancellation",
        calls: 0,
      },
      {
        status: "accepted",
        result: { ok: false, code: "live_invoice" },
        reason: "cancellation_live_invoice_review",
        calls: 1,
      },
      {
        status: "archived",
        result: { ok: true },
        reason: "cancellation_target_terminal_conflict",
        calls: 0,
      },
    ]
  ) {
    const store = cancellationFixture([fixture.status]);
    let calls = 0;
    await runDeterministicIntake(fakeClient(store), {
      dryRun: false,
      selectionMode: "exact",
      allowSourcePostIds: ["cancel-source"],
      maxCases: 1,
      approveDraft,
      applyBuilderCancellation: () => {
        calls++;
        return Promise.resolve(fixture.result);
      },
    });
    assertEquals(calls, fixture.calls);
    assertEquals(store.makesafe_intake_cases[0].reason_code, fixture.reason);
    assertEquals(
      store.makesafe_intake_cases[0].target_job_id,
      "cancel-job-1",
    );
  }
});

Deno.test("zero-target cancellation is visible and never calls the command", async () => {
  const store = cancellationFixture([]);
  let calls = 0;
  await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["cancel-source"],
    maxCases: 1,
    approveDraft,
    applyBuilderCancellation: () => {
      calls++;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(calls, 0);
  assertEquals(
    store.makesafe_intake_cases[0].reason_code,
    "cancellation_target_not_found",
  );
  assertEquals(store.makesafe_intake_cases[0].target_job_id, null);
});

Deno.test("cancellation read-back failure stays visible and retries idempotently", async () => {
  const store = cancellationFixture();
  let calls = 0;
  const options = {
    dryRun: false,
    selectionMode: "exact" as const,
    allowSourcePostIds: ["cancel-source"],
    maxCases: 1,
    approveDraft,
    applyBuilderCancellation: () => {
      calls++;
      if (calls === 2) {
        store.jobs[0].status = "cancelled";
        store.makesafe_job_details[0].jobs.status = "cancelled";
      }
      return Promise.resolve({ ok: true, cancelled: true });
    },
  };

  await runDeterministicIntake(fakeClient(store), options);
  assertEquals(
    store.makesafe_intake_cases[0].reason_code,
    "cancellation_apply_failed",
  );
  assertEquals(store.makesafe_intake_case_sources.length, 1);

  await runDeterministicIntake(fakeClient(store), options);
  assertEquals(calls, 2);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 1);
  assertEquals(store.makesafe_intake_cases[0].reason_code, "cancellation");

  const eventCount = store.makesafe_intake_case_events.length;
  await runDeterministicIntake(fakeClient(store), options);
  assertEquals(calls, 2);
  assertEquals(store.makesafe_intake_case_events.length, eventCount);
});

Deno.test("PDF extraction quarantines bad records without aborting good records", async () => {
  const goodBytes = digitalWorkOrderPdf();
  const client = fakeClient(
    baseStore(),
    [],
    undefined,
    (path) =>
      path === "raw/good.pdf" ? goodBytes : ENCODER.encode("%PDF-1.7\nbroken"),
  );
  const makeSource = (
    postId: string,
    attachmentId: string,
    storagePath: string,
    sizeBytes: number,
  ) => ({
    postId,
    fromEmail: "dispatch@mlb.test",
    subject: "NEW WORK ORDER",
    body: "Attached.",
    receivedAt: NOW,
    attachments: [{
      id: attachmentId,
      sourcePostId: postId,
      name: "Work Order.pdf",
      contentType: "application/pdf",
      storagePath,
      status: "uploaded",
      sizeBytes,
    }],
    links: [],
    direction: "inbound" as const,
  });
  const enriched = await enrichSourcesWithPdfText(client, [
    makeSource("good", "good-att", "raw/good.pdf", goodBytes.length),
    makeSource("corrupt", "corrupt-att", "raw/corrupt.pdf", 20),
    makeSource("pathological", "large-att", "raw/large.pdf", 5_000_001),
  ]);
  const byPost = new Map(enriched.map((source) => [source.postId, source]));
  assertEquals(byPost.get("good")?.pdfDocuments?.[0].status, "extracted");
  assert(
    byPost.get("good")?.pdfDocuments?.[0].text?.includes("Amanda Parker"),
  );
  assertEquals(
    byPost.get("corrupt")?.pdfDocuments?.[0].status,
    "quarantined",
  );
  assertEquals(
    byPost.get("corrupt")?.pdfDocuments?.[0].reason,
    "pdf_parse_failed",
  );
  assertEquals(
    byPost.get("pathological")?.pdfDocuments?.[0].reason,
    "pdf_too_large",
  );
});

Deno.test("U1 real-email regression: newest recent work order owns a PDF slot before old sweep mail", async () => {
  // Derived from production source hash b65f17701ab66ea5 (24 Jul): a genuine
  // inbound NEW WORK ORDER sat behind old mailbox PDFs. Content is replaced with
  // the existing non-PII digital fixture; only the observed queue shape remains.
  const pdfBytes = digitalWorkOrderPdf();
  const store = baseStore();
  const client = fakeClient(
    store,
    [],
    undefined,
    () => pdfBytes,
  );
  const makeSource = (postId: string, receivedAt: string) => ({
    postId,
    fromEmail: "dispatch@mlb.test",
    subject: "NEW WORK ORDER",
    body: "Builder work order attached.",
    receivedAt,
    attachments: [{
      id: `${postId}-attachment`,
      sourcePostId: postId,
      name: "Work Order.pdf",
      contentType: "application/pdf",
      storagePath: `raw/${postId}.pdf`,
      status: "uploaded",
      sizeBytes: pdfBytes.length,
    }],
    links: [],
    direction: "inbound" as const,
  });
  const oldSources = Array.from({ length: 51 }, (_, index) =>
    makeSource(
      `old-${String(index).padStart(2, "0")}`,
      new Date(Date.parse(NOW) - (60 - index) * 60_000).toISOString(),
    ));
  const newest = makeSource(
    "real-shape-newest-work-order",
    new Date(Date.parse(NOW) + 60_000).toISOString(),
  );

  const enriched = await enrichSourcesWithPdfText(
    client,
    [...oldSources, newest],
    [newest.postId],
  );
  const byPost = new Map(enriched.map((source) => [source.postId, source]));

  assertEquals(
    byPost.get(newest.postId)?.pdfDocuments?.[0].status,
    "extracted",
  );
  assertEquals(
    enriched.flatMap((source) => source.pdfDocuments || []).filter((document) =>
      document.status === "deferred"
    ).length,
    2,
  );
});

Deno.test("U1 causal boundary: readInputs gives the newest recent WO a PDF slot ahead of a full old sweep", async () => {
  // Production source shape: NEW WORK ORDER with one named PDF at the newest edge
  // of a bounded backlog+recent read. Unlike the lower-level ordering test above,
  // this drives readInputs and supplies no priority ids. Reverting the
  // recentRows->priority wiring makes the newest source `run_extraction_cap` and
  // fails this assertion.
  const pdfBytes = digitalWorkOrderPdf();
  const store = baseStore();
  const oldSources = Array.from({ length: 51 }, (_, index) => {
    const postId = `old-window-${String(index).padStart(2, "0")}`;
    return {
      postId,
      receivedAt: new Date(
        Date.parse(NOW) - (180 - index) * 60_000,
      ).toISOString(),
    };
  });
  const newest = {
    postId: "real-shape-newest-window-work-order",
    receivedAt: new Date(Date.parse(NOW) - 60_000).toISOString(),
  };
  for (const item of [...oldSources, newest]) {
    store.emails.push(email({
      post_id: item.postId,
      received_at: item.receivedAt,
      subject: "NEW WORK ORDER - MLB-REDACTED",
      body_content: "Builder work order attached.",
    }));
    store.email_attachments.push({
      id: `${item.postId}-attachment`,
      email_id: item.postId,
      name: "Work Order.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${item.postId}.pdf`,
      status: "uploaded",
      size_bytes: pdfBytes.length,
    });
  }
  const client = fakeClient(store, [], undefined, () => pdfBytes);

  const input = await _readInputsForTest(client, {
    days: 60,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 102,
    seedPostIds: [],
    cursor: null,
  });
  const byPost = new Map(input.sources.map((item) => [item.postId, item]));

  assertEquals(
    byPost.get(newest.postId)?.pdfDocuments?.[0].status,
    "extracted",
  );
  assertEquals(
    input.sources.flatMap((item) => item.pdfDocuments || []).filter((
      document,
    ) => document.reason === "pdf_extraction_cap").length,
    2,
  );
});

Deno.test("standing recent queue skips dual-capture final fates and accounts the older unfated instruction within the four-source bound", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "old-final-1",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-25001 Work Order: WO-25001 PO: 250010",
      body_content: "Address: 1 Old Street, Perth",
    }),
    email({
      post_id: "old-final-2",
      received_at: "2026-07-01T01:00:01.000Z",
      subject: "NEW WORK ORDER MLB-25001 Work Order: WO-25001 PO: 250010",
      body_content: "Address: 1 Old Street, Perth",
    }),
    email({
      post_id: "older-unfated-group",
      conversation_id: "older-unfated-conversation",
      received_at: "2026-07-20T00:55:00.000Z",
      subject: "NEW WORK ORDER MLB-25338 Work Order: WO-25338 PO: 253380",
      body_content: "Client: Queue Client\nAddress: 38 Queue Street, Perth",
    }),
    email({
      post_id: "older-unfated-mailbox",
      conversation_id: "older-unfated-conversation",
      received_at: "2026-07-20T00:55:00.000Z",
      subject: "NEW WORK ORDER MLB-25338 Work Order: WO-25338 PO: 253380",
      body_content: "Client: Queue Client\nAddress: 38 Queue Street, Perth",
    }),
    email({
      post_id: "newest-final-group",
      conversation_id: "newest-final-conversation",
      received_at: "2026-07-20T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-25321 Work Order: WO-25321 PO: 253210",
      body_content: "Address: 21 Final Street, Perth",
    }),
    email({
      post_id: "newest-final-mailbox",
      conversation_id: "newest-final-conversation",
      received_at: "2026-07-20T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-25321 Work Order: WO-25321 PO: 253210",
      body_content: "Address: 21 Final Street, Perth",
    }),
  );
  store.makesafe_intake_cases.push(
    {
      id: "old-final-case",
      org_id: "00000000-0000-0000-0000-000000000001",
      instruction_key: "mlb/wo:WO-25001/po:250010/deliverable:makesafe/cycle:1",
      lineage_id: "old-final-case",
      cycle: 1,
      parent_relation: null,
      source_fingerprint: null,
      state: "exception",
      reason_code: "below_identity_floor",
      job_id: null,
    },
    {
      id: "newest-final-case",
      org_id: "00000000-0000-0000-0000-000000000001",
      instruction_key: "mlb/wo:WO-25321/po:253210/deliverable:makesafe/cycle:1",
      lineage_id: "newest-final-case",
      cycle: 1,
      parent_relation: null,
      source_fingerprint: null,
      state: "exception",
      reason_code: "below_identity_floor",
      job_id: null,
    },
  );
  store.makesafe_intake_case_sources.push(
    {
      id: "old-final-source-1",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "old-final-case",
      post_id: "old-final-1",
    },
    {
      id: "old-final-source-2",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "old-final-case",
      post_id: "old-final-2",
    },
    {
      id: "newest-final-source-1",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "newest-final-case",
      post_id: "newest-final-group",
    },
    {
      id: "newest-final-source-2",
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: "newest-final-case",
      post_id: "newest-final-mailbox",
    },
  );
  for (
    const postId of ["older-unfated-group", "older-unfated-mailbox"]
  ) {
    store.email_attachments.push({
      id: `${postId}-pdf`,
      email_id: postId,
      name: "Work Order.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${postId}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  let pdfAttempts = 0;
  const selectLog: Array<[string, string]> = [];
  store.mail_sync_cursors.push({
    mailbox: "ses@secureworkswa.com.au",
    last_completed_max: "2026-07-20T01:00:00.000Z",
  });
  const client = fakeClient(
    store,
    selectLog,
    undefined,
    () => {
      pdfAttempts++;
      return digitalWorkOrderPdf([
        "Work Order Number MLB-25338 PO-253380",
        "Policyholders Name Queue Client",
        "Site Address 38 Queue Street Perth WA",
        "Scope of Works Attend and make the property safe",
      ]);
    },
  );

  const report = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "full_open",
    days: 60,
    nowIso: NOW,
    onlyUnscanned: false,
    maxSources: 4,
    maxCases: 1,
    approveDraft,
  });

  assertEquals(report.source_read.backlog_rows, 2);
  assertEquals(report.source_read.recent_rows, 2);
  assert(report.source_read.window_rows <= 4);
  assert(pdfAttempts <= 8);
  assert(
    selectLog.some(([table, columns]) =>
      table === "emails" && columns === "post_id,received_at"
    ),
  );
  assertEquals(
    store.makesafe_intake_case_sources
      .filter((row) =>
        row.post_id === "older-unfated-group" ||
        row.post_id === "older-unfated-mailbox"
      )
      .map((row) => row.post_id)
      .sort(),
    ["older-unfated-group", "older-unfated-mailbox"],
  );
  const health = store.makesafe_intake_health[0];
  assertEquals(health.extraction_status, "ok");
  assertEquals(
    health.latest_ingested_received_at,
    "2026-07-20T01:00:00.000Z",
  );
  assertEquals(health.unfated_source_count, 0);
  assertEquals(health.oldest_unfated_received_at, null);
  assertEquals(health.fresh_source_lag_seconds, 0);
  assertEquals(health.last_fresh_source_accounted_at, NOW);
  assertEquals(health.last_successful_extraction_at, NOW);
});

Deno.test("standing recent queue pages lightweight identifiers past a final-fated head", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "page-old-final-1",
      received_at: "2026-07-01T01:00:00.000Z",
    }),
    email({
      post_id: "page-old-final-2",
      received_at: "2026-07-01T01:00:01.000Z",
    }),
    email({
      post_id: "page-unfated-1",
      received_at: "2026-07-20T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-25401 Work Order: WO-25401 PO: 254010",
      body_content: "Address: 1 Page Street, Perth",
    }),
    email({
      post_id: "page-unfated-2",
      received_at: "2026-07-20T01:00:01.000Z",
      subject: "NEW WORK ORDER MLB-25402 Work Order: WO-25402 PO: 254020",
      body_content: "Address: 2 Page Street, Perth",
    }),
  );
  for (
    const postId of [
      "page-old-final-1",
      "page-old-final-2",
    ]
  ) {
    store.makesafe_intake_case_sources.push({
      id: `${postId}-source`,
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: `${postId}-case`,
      post_id: postId,
    });
  }
  for (let index = 0; index < 100; index++) {
    const postId = `page-head-final-${String(index).padStart(3, "0")}`;
    store.emails.push(email({
      post_id: postId,
      received_at: new Date(
        Date.parse("2026-07-20T02:00:00.000Z") + index * 1000,
      ).toISOString(),
    }));
    store.makesafe_intake_case_sources.push({
      id: `${postId}-source`,
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: `${postId}-case`,
      post_id: postId,
    });
  }
  const selectLog: Array<[string, string]> = [];
  const input = await _readInputsForTest(fakeClient(store, selectLog), {
    days: 60,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 4,
    seedPostIds: [],
    cursor: null,
  });

  assertEquals(input.read.backlog_rows, 2);
  assertEquals(input.read.recent_rows, 2);
  assertEquals(
    input.sources.map((source) => source.postId).sort(),
    [
      "page-old-final-1",
      "page-old-final-2",
      "page-unfated-1",
      "page-unfated-2",
    ],
  );
  assert(
    selectLog.filter(([table, columns]) =>
      table === "emails" && columns === "post_id,received_at"
    ).length >= 2,
  );
});

Deno.test("standing recent queue keeps sources with multiple transient issues eligible", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "multi-issue-source",
    received_at: "2026-07-20T02:00:00.000Z",
    subject: "NEW WORK ORDER MLB-25403 Work Order: WO-25403 PO: 254030",
    body_content: "Client: Retry Client\nAddress: 3 Retry Street, Perth",
  }));
  store.email_events_raw.push(
    {
      org_id: "00000000-0000-0000-0000-000000000001",
      post_id: "multi-issue-source",
      change_type: "intake_deferred_run_cap_deferred",
    },
    {
      org_id: "00000000-0000-0000-0000-000000000001",
      post_id: "multi-issue-source",
      change_type: "intake_exception_attachment_recovery_failed",
    },
  );

  const input = await _readInputsForTest(fakeClient(store), {
    days: 60,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 2,
    seedPostIds: [],
    cursor: null,
  });

  assertEquals(input.sources.map((source) => source.postId), [
    "multi-issue-source",
  ]);
});

Deno.test("deterministic health degrades when an included source remains unfated beyond five minutes", async () => {
  const store = baseStore();
  for (let index = 1; index <= 4; index++) {
    store.emails.push(email({
      post_id: `health-unfated-${index}`,
      received_at: `2026-07-20T0${index}:00:00.000Z`,
      subject:
        `NEW WORK ORDER MLB-2600${index} Work Order: WO-2600${index} PO: 2600${index}0`,
      body_content:
        `Client: Health Client ${index}\nAddress: ${index} Health Way, Perth`,
    }));
  }
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "full_open",
    days: 60,
    nowIso: "2026-07-20T12:00:00.000Z",
    onlyUnscanned: false,
    maxSources: 4,
    maxCases: 1,
    approveDraft,
  });

  assertEquals(report.totals.cases_deferred, 3);
  const health = store.makesafe_intake_health[0];
  assertEquals(health.extraction_status, "degraded");
  assertEquals(
    health.degraded_reason,
    "deterministic_fresh_source_lag",
  );
  assertEquals(health.unfated_source_count, 3);
  assertEquals(
    health.oldest_unfated_received_at,
    "2026-07-20T02:00:00.000Z",
  );
  assertEquals(health.fresh_source_lag_seconds, 10 * 60 * 60);
  assertEquals(
    health.last_fresh_source_accounted_at,
    "2026-07-20T12:00:00.000Z",
  );
  assertEquals(
    health.last_successful_extraction_at,
    "2026-07-20T12:00:00.000Z",
  );
});

Deno.test("live deterministic intake fills a draft from PDF and persists readable text provenance", async () => {
  const store = baseStore();
  const pdfBytes = digitalWorkOrderPdf();
  store.emails.push(email({
    post_id: "pdf-live-1",
    subject: "NEW WORK ORDER",
    body_content: "Please attend. The builder work order is attached.",
  }));
  store.email_attachments.push({
    id: "pdf-live-att",
    email_id: "pdf-live-1",
    name: "MLB Work Order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/pdf-live.pdf",
    status: "uploaded",
    size_bytes: pdfBytes.length,
  });
  const client = fakeClient(
    store,
    [],
    undefined,
    () => pdfBytes,
  );
  const report = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["pdf-live-1"],
    maxCases: 1,
    approveDraft,
    nowIso: NOW,
  });
  assertEquals(report.ai_calls, 0);
  assertEquals(report.totals.jobs_created, 1);
  const intakeCase = store.makesafe_intake_cases[0];
  assertEquals(intakeCase.client_name, "Amanda Parker");
  assertEquals(
    intakeCase.field_provenance.client_name.source,
    "work_order_pdf_text",
  );
  assert(
    intakeCase.raw_identity_json.work_order_pdf_text[0].text.includes(
      "Amanda Parker",
    ),
  );
  const draft = store.makesafe_intake_drafts[0];
  assertEquals(draft.client_name, "Amanda Parker");
  assertEquals(draft.client_phone, "0422636182");
  assertEquals(
    draft.description,
    "Install temporary roof tarps and make the storm damaged property safe",
  );
  assertEquals(
    draft.extraction_json.pdf_field_provenance.client_name.attachmentId,
    "pdf-live-att",
  );
  assert(
    draft.extraction_json.work_order_pdf_text[0].text.includes(
      "Scope of Works",
    ),
  );
  assertEquals(
    store.makesafe_intake_case_sources[0].evidence.pdf_extraction[0].status,
    "extracted",
  );
  assert(
    store.makesafe_intake_case_sources[0].evidence.pdf_extraction[0].text
      .includes("Amanda Parker"),
  );
});

Deno.test("portal-only blocker is reported by its actual missing evidence", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "roof-portal-blocker",
    subject: "Roof report work order Work Order: 445566",
    body_content: [
      "Client: Roof Client",
      "Site Address: 30 Beta Avenue, Perth",
      "Mobile: 0411 111 111",
      "Complete roof report https://portal.prime.test/r/445566",
    ].join("\n"),
  }));
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: true,
    selectionMode: "exact",
    allowSourcePostIds: ["roof-portal-blocker"],
    maxCases: 1,
    nowIso: NOW,
  });
  assertEquals(
    report.by_builder_and_reason.mlb["missing:portal_capture"],
    1,
  );
  assertEquals(
    report.by_builder_and_reason.mlb.adapter_parse_failure,
    undefined,
  );
});

Deno.test("auto-file brake parks a complete deterministic draft without stopping intake", async () => {
  const store = baseStore();
  const pdfBytes = digitalWorkOrderPdf();
  store.emails.push(email({
    post_id: "parked-live-1",
    subject: "NEW WORK ORDER",
    body_content: "The builder work order is attached.",
  }));
  store.email_attachments.push({
    id: "parked-live-att",
    email_id: "parked-live-1",
    name: "MLB Work Order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/parked-live.pdf",
    status: "uploaded",
    size_bytes: pdfBytes.length,
  });
  const client = fakeClient(store, [], undefined, () => pdfBytes);
  let approvalCalls = 0;
  const guardedApprove = (_client: any, _body: any) => {
    approvalCalls++;
    return Promise.resolve({ job: { id: "job-after-brake" } });
  };

  const parked = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["parked-live-1"],
    maxCases: 1,
    advanceDrafts: false,
    approveDraft: guardedApprove,
    nowIso: NOW,
  });
  assertEquals(parked.ai_calls, 0);
  assertEquals(parked.totals.drafts_created, 1);
  assertEquals(parked.totals.jobs_created, 0);
  assertEquals(parked.totals.job_creation_deferred, 1);
  assertEquals(approvalCalls, 0);
  assertEquals(store.makesafe_intake_drafts.length, 1);
  assertEquals(store.makesafe_intake_cases[0].job_id, null);
  assertEquals(store.emails[0].makesafe_scanned_at, null);

  const advanced = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "exact",
    allowSourcePostIds: ["parked-live-1"],
    maxCases: 1,
    advanceDrafts: true,
    approveDraft: guardedApprove,
    nowIso: NOW,
  });
  assertEquals(advanced.totals.drafts_created, 0);
  assertEquals(advanced.totals.jobs_created, 1);
  assertEquals(approvalCalls, 1);
  assertEquals(store.makesafe_intake_drafts.length, 1);
  assertEquals(store.makesafe_intake_cases[0].job_id, "job-after-brake");
  assertEquals(store.emails[0].makesafe_scanned_at, NOW);
});

function seedCanonicalCase(
  store: Store,
  id: string,
  instructionKey: string,
  postId: string,
) {
  store.makesafe_intake_cases.push({
    id,
    org_id: "00000000-0000-0000-0000-000000000001",
    instruction_key: instructionKey,
    lineage_id: id,
    cycle: 1,
    parent_relation: null,
    source_fingerprint: instructionKey.match(/fingerprint:([^/]+)/)?.[1] ??
      null,
    state: "exception",
    job_id: null,
  });
  store.makesafe_intake_case_sources.push({
    id: `source-${id}`,
    org_id: "00000000-0000-0000-0000-000000000001",
    case_id: id,
    post_id: postId,
  });
}

Deno.test("runtime reads thread coordinates and correlates on conversation id", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "t-1",
      conversation_id: "conv-1",
      internet_message_id: "<msg-1@mlb.test>",
      subject: "NEW WORK ORDER MLB-55000 Work Order: WO-55000",
      body_content: "Client: Thread Client\nAddress: 9 Thread Way, Perth",
    }),
    // Carries no identity of its own. Only the shared conversation id can pull it
    // into the same case.
    email({
      post_id: "t-2",
      conversation_id: "conv-1",
      subject: "Work order document",
      body_content: "Attached",
      received_at: "2026-07-20T02:00:00.000Z",
    }),
  );
  store.email_attachments.push({
    id: "att-t2",
    email_id: "t-2",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/t2.pdf",
    status: "uploaded",
    size_bytes: 4096,
  });
  const selectLog: Array<[string, string]> = [];
  const client = fakeClient(store, selectLog);
  const report = await runDeterministicIntake(client, {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });

  const emailSelect = selectLog.find(([table]) => table === "emails")?.[1] ||
    "";
  for (
    const column of ["internet_message_id", "conversation_id", "thread_id"]
  ) {
    assert(
      emailSelect.includes(column),
      `emails projection must read ${column}`,
    );
  }
  assertEquals(report.totals.sources, 2);
  assertEquals(report.totals.cases, 1);
  assertEquals(report.totals.unaccounted, 0);
});

Deno.test("sanitized live traces reach canonical identity without mistaking job readiness for identity", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ",
    sender_patterns: ["ajs.build"],
    parsing_rules: null,
    active: true,
  });
  const traced = [
    {
      id: "trace-mlb-1",
      from: "dispatch@mlb.test",
      subject: "NEW WORK ORDER MLB-70001 Work Order: WO-70001 PO: PO-101",
      body:
        "<html><table><tr><td>Site Address:</td><td>1 Redacted Road, Perth</td></tr><tr><td>Phone:</td><td>0400 000 001</td></tr></table></html>",
    },
    {
      id: "trace-mlb-2",
      from: "dispatch@mlb.test",
      subject: "NEW WORK ORDER MLB-70002 Work Order: WO-70002 PO: PO-102",
      body:
        "<html><table><tr><td>Site Address:</td><td>2 Redacted Road, Perth</td></tr><tr><td>Phone:</td><td>0400 000 002</td></tr></table></html>",
    },
    {
      id: "trace-mlb-3",
      from: "dispatch@mlb.test",
      subject: "NEW WORK ORDER MLB-70003 Work Order: WO-70003 PO: PO-103",
      body:
        "<html><table><tr><td>Site Address:</td><td>3 Redacted Road, Perth</td></tr><tr><td>Phone:</td><td>0400 000 003</td></tr></table></html>",
    },
    {
      id: "trace-prime-4",
      from: "notifications@primeeco.test",
      subject: "Prime roof report Work Order: 70004",
      body:
        "<html><p>Site Address: 4 Redacted Road, Perth</p><p>Complete roof report at https://portal.test/report</p></html>",
    },
    {
      id: "trace-aj-5",
      from: "dispatch@ajs.build",
      subject: "Make Safe - Redacted - Job No 70005 Work Order: 70005",
      body:
        "<html><table><tr><td>Address:</td><td>5 Redacted Road, Perth</td></tr><tr><td>Phone:</td><td>0400 000 005</td></tr></table></html>",
    },
  ];
  for (const trace of traced) {
    store.emails.push(email({
      post_id: trace.id,
      from_email: trace.from,
      subject: trace.subject,
      body_content: trace.body,
    }));
    store.email_attachments.push({
      id: `att-${trace.id}`,
      email_id: trace.id,
      name: "sanitized-work-order.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${trace.id}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  // ses@ receives copies of SecureWorks' own sends. The proven legacy path drops
  // them before matching; deterministic replay must account for one as non-work,
  // not let its quoted builder ref inflate the identity denominator.
  store.emails.push(email({
    post_id: "trace-own-copy",
    from_email: "ops@secureworkswa.com.au",
    subject: "NEW WORK ORDER MLB-79999 Work Order: WO-79999",
    body_content:
      "<p>Client: Outbound Copy</p><p>Address: 99 Redacted Road</p>",
  }));

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });

  assertEquals(report.totals.sources, 6);
  assertEquals(report.totals.unaccounted, 0);
  assertEquals(report.totals.nonWork, 1);
  assertEquals(report.identity_floor.known_builder_work_candidates, 5);
  assertEquals(report.identity_floor.reached, 5);
  assertEquals(report.identity_floor.percentage, 100);
  assertEquals(report.identity_floor.by_builder.mlb, {
    candidates: 4,
    reached: 4,
    shortfall: 0,
  });
  assertEquals(report.identity_floor.by_builder.aj, {
    candidates: 1,
    reached: 1,
    shortfall: 0,
  });
  // Client data remains a loud parser/recovery gap. The matcher now reports the
  // WO/ref identity honestly without pretending these are job-creation-ready.
  assertEquals(report.by_builder_and_reason.mlb.adapter_parse_failure, 4);
  assertEquals(report.by_builder_and_reason.aj.adapter_parse_failure, 1);
  assertEquals(report.ai_calls, 0);
});

Deno.test("live run persists thread coordinates onto case sources", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "s-1",
      conversation_id: "conv-9",
      thread_id: "thread-9",
      internet_message_id: "<msg-9@mlb.test>",
      subject: "NEW WORK ORDER MLB-56000 Work Order: WO-56000",
      body_content: "Client: Source Client\nAddress: 10 Source Road, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-9",
    email_id: "s-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/wo.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["s-1"],
    approveDraft,
  });

  const [sourceRow] = store.makesafe_intake_case_sources;
  assertEquals(sourceRow.conversation_id, "conv-9");
  assertEquals(sourceRow.thread_id, "thread-9");
  assertEquals(sourceRow.internet_message_id, "<msg-9@mlb.test>");
});

Deno.test("a late work order promotes a resumed exception into a live job", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "late-1",
      conversation_id: "conv-late",
      subject: "NEW WORK ORDER MLB-57000 Work Order: WO-57000 PO: 57001",
      body_content:
        "Client: Late Client\nPhone: 0400 000 111\nAddress: 11 Late Street, Perth",
    }),
  );
  const client = fakeClient(store);

  // Run 1: the work order PDF has not landed, so the case is a visible exception
  // and no job exists yet.
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    allowSourcePostIds: ["late-1"],
    approveDraft,
  });
  assertEquals(first.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_cases[0].state, "exception");
  assertEquals(store.makesafe_intake_cases[0].job_id, null);
  const persistedIdentity = {
    instruction_key: store.makesafe_intake_cases[0].instruction_key,
    lineage_id: store.makesafe_intake_cases[0].lineage_id,
    external_ref_canonical:
      store.makesafe_intake_cases[0].external_ref_canonical,
    builder_wo_canonical: store.makesafe_intake_cases[0].builder_wo_canonical,
    builder_po_canonical: store.makesafe_intake_cases[0].builder_po_canonical,
  };
  // An unresolved exception must stay unstamped, or the next run cannot re-read the
  // original instruction alongside the late work order.
  assertEquals(store.emails[0].makesafe_scanned_at, null);

  // Run 2: the PDF has arrived and is correlated into the same instruction.
  store.email_attachments.push({
    id: "att-late",
    email_id: "late-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/late.pdf",
    status: "uploaded",
    size_bytes: 2048,
  });
  const second = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    allowSourcePostIds: ["late-1"],
    approveDraft,
  });

  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_cases[0].state, "confirmed_live_job");
  assertEquals(store.makesafe_intake_cases[0].job_id, "job-abc");
  assertEquals({
    instruction_key: store.makesafe_intake_cases[0].instruction_key,
    lineage_id: store.makesafe_intake_cases[0].lineage_id,
    external_ref_canonical:
      store.makesafe_intake_cases[0].external_ref_canonical,
    builder_wo_canonical: store.makesafe_intake_cases[0].builder_wo_canonical,
    builder_po_canonical: store.makesafe_intake_cases[0].builder_po_canonical,
  }, persistedIdentity);
  assertEquals(second.totals.jobs_created, 1);
  assertEquals(second.totals.write_failures, 0);
  // Now that it is settled, the source is stamped and drops out of the next window.
  assertEquals(store.emails[0].makesafe_scanned_at, NOW);
});

Deno.test("standing late evidence charges persisted exception closure to the recent source cap", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "closure-old-final-1",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-24001 Work Order: WO-24001 PO: 240010",
      body_content: "Address: 1 Old Closure Street, Perth",
    }),
    email({
      post_id: "closure-old-final-2",
      received_at: "2026-07-01T01:00:01.000Z",
      subject: "NEW WORK ORDER MLB-24002 Work Order: WO-24002 PO: 240020",
      body_content: "Address: 2 Old Closure Street, Perth",
    }),
    email({
      post_id: "closure-original",
      conversation_id: "closure-conversation",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-57010 Work Order: WO-57010 PO: 570100",
      body_content: "Client: Closure Client\nAddress: 10 Closure Street, Perth",
    }),
  );
  for (let index = 1; index <= 2; index++) {
    const caseId = `closure-old-case-${index}`;
    store.makesafe_intake_cases.push({
      id: caseId,
      org_id: "00000000-0000-0000-0000-000000000001",
      instruction_key:
        `mlb/wo:WO-2400${index}/po:2400${index}0/deliverable:makesafe/cycle:1`,
      lineage_id: caseId,
      cycle: 1,
      parent_relation: null,
      source_fingerprint: null,
      state: "exception",
      reason_code: "below_identity_floor",
      job_id: null,
    });
    store.makesafe_intake_case_sources.push({
      id: `closure-old-source-${index}`,
      org_id: "00000000-0000-0000-0000-000000000001",
      case_id: caseId,
      post_id: `closure-old-final-${index}`,
    });
  }
  let closurePdfAttempts = 0;
  const client = fakeClient(
    store,
    [],
    undefined,
    () => {
      closurePdfAttempts++;
      return digitalWorkOrderPdf([
        "Work Order Number MLB-57010 PO-570100",
        "Policyholders Name Closure Client",
        "Site Address 10 Closure Street Perth WA",
        "Scope of Works Attend and make the property safe",
      ]);
    },
  );
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 60,
    nowIso: NOW,
    maxSources: 4,
    allowSourcePostIds: ["closure-original"],
    approveDraft,
  });
  assertEquals(first.totals.jobs_created, 0);
  const persisted = store.makesafe_intake_cases.find((row: any) =>
    store.makesafe_intake_case_sources.some((source: any) =>
      source.case_id === row.id && source.post_id === "closure-original"
    )
  );
  assert(persisted);
  assertEquals(persisted.state, "exception");
  store.makesafe_intake_health[0].deterministic_scan_cursor_at = null;
  store.makesafe_intake_health[0].deterministic_scan_cursor_post_id = null;

  store.emails.push(
    email({
      post_id: "closure-unrelated",
      received_at: "2026-07-20T00:58:00.000Z",
      subject: "NEW WORK ORDER MLB-57011 Work Order: WO-57011 PO: 570110",
      body_content: "Client: Other Client\nAddress: 11 Closure Street, Perth",
    }),
    email({
      post_id: "closure-late-pdf",
      conversation_id: "closure-conversation",
      received_at: "2026-07-20T00:59:00.000Z",
      subject: "NEW WORK ORDER MLB-57010 Work Order: WO-57010 PO: 570100",
      body_content: "Client: Closure Client\nAddress: 10 Closure Street, Perth",
    }),
  );
  store.email_attachments.push({
    id: "closure-late-pdf-attachment",
    email_id: "closure-late-pdf",
    name: "Work Order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/closure-late.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });

  const second = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "full_open",
    days: 60,
    nowIso: NOW,
    onlyUnscanned: false,
    maxSources: 4,
    maxCases: 1,
    approveDraft,
  });

  assertEquals(second.source_read.backlog_rows, 2);
  assertEquals(second.source_read.recent_rows, 2);
  assert(second.source_read.window_rows <= 4);
  assert(closurePdfAttempts <= 8);
  assertEquals(second.totals.jobs_created, 1);
  assertEquals(persisted.job_id, "job-abc");
  assert(
    store.makesafe_intake_case_sources.some((row: any) =>
      row.case_id === persisted.id && row.post_id === "closure-late-pdf"
    ),
  );
  assert(
    store.email_events_raw.some((row: any) =>
      row.post_id === "closure-unrelated" &&
      row.change_type === "intake_deferred_source_closure_cap"
    ),
  );
});

Deno.test("full-open processes the bounded page while exact-empty and mixed configs fail closed", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "full-open-1",
      received_at: "2026-07-19T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-57001 Work Order: WO-57001",
      body_content: "Address: 1 Open Way, Perth",
    }),
    email({
      post_id: "full-open-2",
      received_at: "2026-07-20T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-57002 Work Order: WO-57002",
      body_content: "Address: 2 Open Way, Perth",
    }),
  );
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxSources: 4,
    maxCases: 1,
    approveDraft,
  } as const;

  const first = await runDeterministicIntake(client, options);
  assertEquals(first.selection.mode, "full_open");
  assertEquals(first.selection.source_allowlist_count, 0);
  assertEquals(first.selection.instruction_allowlist_count, 0);
  assertEquals(first.selection.selected_cases, 2);
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.cases_attempted, 1);
  assertEquals(first.totals.cases_deferred, 1);
  assertEquals(first.totals.artifacts_created, 0);
  assertEquals(first.totals.drafts_created, 0);

  const second = await runDeterministicIntake(client, options);
  assertEquals(second.totals.case_rows_created, 1);
  assertEquals(store.makesafe_intake_cases.length, 2);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);

  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(baseStore()), {
        dryRun: false,
        selectionMode: "exact",
        approveDraft,
      }),
    Error,
    "exact mode requires a non-empty exact DB allowlist",
  );
  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(baseStore()), {
        dryRun: false,
        selectionMode: "full_open",
        allowSourcePostIds: ["must-not-mix"],
        approveDraft,
      }),
    Error,
    "full_open mode requires empty exact allowlists",
  );
});

Deno.test("standing full-open completes cleanly when the bounded mailbox page is quiet", async () => {
  const store = baseStore();
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxCases: 10,
    approveDraft,
  });

  assertEquals(report.ok, true);
  assertEquals(report.selection.mode, "full_open");
  assertEquals(report.selection.selected_cases, 0);
  assertEquals(report.totals.cases_attempted, 0);
  assertEquals(report.totals.write_failures, 0);
  assertEquals(store.makesafe_intake_cases.length, 0);
});

Deno.test("full-open chunks long instruction-key filters below the live URL failure boundary", async () => {
  const store = baseStore();
  for (let index = 0; index < 220; index++) {
    const ref = 70000 + index;
    store.emails.push(email({
      post_id: `url-boundary-${String(index).padStart(3, "0")}`,
      received_at: "2026-07-19T01:00:00.000Z",
      subject: `NEW WORK ORDER MLB-${ref} Work Order: WO-${ref}`,
      body_content: `${index} Boundary Way, Perth`,
    }));
  }
  const instructionKeyBatchSizes: number[] = [];
  const client = fakeClient(store, [], (table, column, count) => {
    if (table === "makesafe_intake_cases" && column === "instruction_key") {
      instructionKeyBatchSizes.push(count);
    }
  });

  const report = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxSources: 500,
    maxCases: 1,
    approveDraft,
  });

  assertEquals(report.selection.selected_cases, 220);
  assertEquals(report.totals.cases_attempted, 1);
  assertEquals(report.totals.case_rows_created, 1);
  assertEquals(instructionKeyBatchSizes.length, 9);
  assert(
    instructionKeyBatchSizes.every((size) => size <= 25),
    `oversized instruction-key filter batches: ${instructionKeyBatchSizes}`,
  );
});

Deno.test("live default N=1 exact allowlist cannot pick up unrelated backlog", async () => {
  const store = baseStore();
  for (const source of ["approved-one", "unapproved-backlog"]) {
    store.emails.push(email({
      post_id: source,
      subject: `NEW WORK ORDER MLB-${
        source === "approved-one" ? "63001" : "63002"
      } Work Order: WO-${source === "approved-one" ? "63001" : "63002"}`,
      body_content: `Client: ${source}\nAddress: 1 Exact Way, Perth`,
    }));
    store.email_attachments.push({
      id: `att-${source}`,
      email_id: source,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${source}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["approved-one"],
    approveDraft,
  });

  assertEquals(report.selection.source_allowlist_count, 1);
  assertEquals(report.selection.selected_cases, 1);
  assertEquals(report.totals.cases_attempted, 1);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources[0].post_id, "approved-one");
  assertEquals(
    store.emails.find((row) => row.post_id === "unapproved-backlog")
      ?.makesafe_scanned_at,
    null,
  );
});

Deno.test("live batch is capped per invocation and defers the remainder", async () => {
  const store = baseStore();
  for (let i = 1; i <= 4; i++) {
    store.emails.push(
      email({
        post_id: `cap-${i}`,
        subject: `NEW WORK ORDER MLB-6000${i} Work Order: WO-6000${i}`,
        body_content: `Client: Cap Client ${i}\nAddress: ${i} Cap Court, Perth`,
      }),
    );
    store.email_attachments.push({
      id: `att-cap-${i}`,
      email_id: `cap-${i}`,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/cap-${i}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  const client = fakeClient(
    store,
    [],
    undefined,
    (path) => {
      const suffix = path.match(/cap-(\d+)/)?.[1] ?? "1";
      return digitalWorkOrderPdf([
        `Work Order Number MLB-6000${suffix}PO-6000${suffix}`,
        `Policyholders Name Cap Client ${suffix}`,
        `Site Address ${suffix} Cap Court Perth WA`,
        "Scope of Works Attend and make the property safe",
        "Notes",
        "Attend within twenty four hours and protect the occupants and contents from weather damage",
      ]);
    },
  );
  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxCases: 2,
    allowSourcePostIds: ["cap-1", "cap-2", "cap-3", "cap-4"],
    approveDraft,
  });

  assertEquals(report.totals.cases, 4);
  assertEquals(report.totals.cases_attempted, 2);
  assertEquals(report.totals.cases_deferred, 2);
  assertEquals(store.makesafe_intake_cases.length, 2);
  assertEquals(
    store.email_events_raw
      .filter((row) => row.change_type === "intake_deferred_run_cap_deferred")
      .map((row) => row.post_id)
      .sort(),
    ["cap-3", "cap-4"],
  );
  assertEquals(report.evidence.durable_source_fates, {
    checked: 4,
    final: 2,
    transient: 2,
  });
  // Deferred cases keep their sources unstamped so the next invocation picks them up.
  assertEquals(
    store.emails.filter((e) => e.makesafe_scanned_at === null).length,
    2,
  );
});

Deno.test("source-issue persistence failure retains the cursor and exact retry accounts the source", async () => {
  const store = baseStore();
  store.makesafe_intake_health.push({
    id: true,
    deterministic_scan_cursor_at: "2026-07-19T00:00:00.000Z",
    deterministic_scan_cursor_post_id: "prior",
  });
  for (let i = 1; i <= 2; i++) {
    store.emails.push(email({
      post_id: `issue-fail-${i}`,
      subject: `NEW WORK ORDER MLB-6100${i} Work Order: WO-6100${i}`,
      body_content:
        `Client: Retry Client ${i}\nAddress: ${i} Retry Road, Perth`,
    }));
  }
  let issueWriteFailures = 0;
  const failingClient = fakeClient(
    store,
    [],
    undefined,
    undefined,
    (table, operation) => {
      if (table === "email_events_raw" && operation === "insert") {
        issueWriteFailures++;
        return { code: "XX001", message: "injected issue ledger failure" };
      }
      return null;
    },
  );

  await assertRejects(
    () =>
      runDeterministicIntake(failingClient, {
        dryRun: false,
        selectionMode: "exact",
        allowSourcePostIds: ["issue-fail-1", "issue-fail-2"],
        maxCases: 1,
        approveDraft,
      }),
    Error,
    "issue persistence failed",
  );
  assertEquals(issueWriteFailures, 1);
  assertEquals(
    store.makesafe_intake_health[0].deterministic_scan_cursor_at,
    "2026-07-19T00:00:00.000Z",
  );

  const retryOptions = {
    dryRun: false,
    selectionMode: "exact" as const,
    allowSourcePostIds: ["issue-fail-1", "issue-fail-2"],
    maxCases: 1,
    approveDraft,
  };
  let retried = await runDeterministicIntake(
    fakeClient(store),
    retryOptions,
  );
  if (retried.evidence.durable_source_fates?.final !== 2) {
    retried = await runDeterministicIntake(fakeClient(store), retryOptions);
  }
  assertEquals(retried.evidence.durable_source_fates, {
    checked: 2,
    final: 2,
    transient: 0,
  });
  assertEquals(
    store.makesafe_intake_case_sources.map((row) => row.post_id).sort(),
    ["issue-fail-1", "issue-fail-2"],
  );
});

Deno.test("stuck exceptions cannot consume the whole per-run budget", async () => {
  const store = baseStore();
  // Two older instructions that can never advance without a work order PDF.
  for (let i = 1; i <= 2; i++) {
    store.emails.push(
      email({
        post_id: `stuck-${i}`,
        received_at: `2026-07-19T0${i}:00:00.000Z`,
        subject: `NEW WORK ORDER MLB-5900${i} Work Order: WO-5900${i}`,
        body_content:
          `Client: Stuck Client ${i}\nAddress: ${i} Stuck Way, Perth`,
      }),
    );
  }
  const client = fakeClient(store);
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxCases: 2,
    allowSourcePostIds: ["stuck-1", "stuck-2"],
    approveDraft,
  });
  assertEquals(first.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_cases.length, 2);

  // A newer, fully evidenced instruction arrives behind them in received_at order.
  store.emails.push(
    email({
      post_id: "fresh-1",
      received_at: "2026-07-20T02:00:00.000Z",
      subject: "NEW WORK ORDER MLB-59003 Work Order: WO-59003",
      body_content: "Client: Fresh Client\nAddress: 3 Fresh Road, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-fresh",
    email_id: "fresh-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/fresh.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const second = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxCases: 2,
    allowSourcePostIds: ["stuck-1", "stuck-2", "fresh-1"],
    approveDraft,
  });

  // The unchanged exceptions are deprioritised, so the run still reaches the case
  // that can actually make progress.
  assertEquals(second.totals.jobs_created, 1);
  assertEquals(
    store.emails.find((e) => e.post_id === "fresh-1")?.makesafe_scanned_at,
    NOW,
  );
});

Deno.test("full-open does not spend its cap reattaching sources already settled on canonical cases", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ",
    sender_patterns: ["aj.test"],
    parsing_rules: null,
    active: true,
  });
  store.emails.push(
    email({
      post_id: "settled-a",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-02T01:00:00.000Z",
      subject: "Make Safe - Redacted - Job No 69019",
      body_content: "Work Order AJBR 69019 received for review.",
    }),
    email({
      post_id: "settled-b",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "Make Safe - Redacted - Job No 69019",
      body_content: "Work Order AJBR 69019 received for review.",
    }),
    email({
      post_id: "tail-fresh",
      received_at: "2026-07-09T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-99001 Work Order: WO-99001",
      body_content: "Address: 1 Tail Way, Perth",
    }),
  );
  seedCanonicalCase(
    store,
    "settled-case-a",
    "fingerprint:settled-a/deliverable:wo%3AAJBR-69019/cycle:1",
    "settled-a",
  );
  seedCanonicalCase(
    store,
    "settled-case-b",
    "fingerprint:settled-b/deliverable:wo%3AAJBR-69019/cycle:1",
    "settled-b",
  );

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    approveDraft,
  });

  assertEquals(report.totals.write_failures, 0);
  assertEquals(report.totals.cases_attempted, 1);
  assertEquals(report.totals.case_rows_created, 1);
  assertEquals(report.totals.source_rows_created, 1);
  assert(
    store.makesafe_intake_case_sources.some((row) =>
      row.post_id === "tail-fresh"
    ),
    "the unaccounted tail source must receive the only commit slot",
  );
  assertEquals(store.makesafe_intake_cases.length, 3);
});

Deno.test("a fresh cross-case merge spanning distinct persisted deliverables is quarantined", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ",
    sender_patterns: ["aj.test"],
    parsing_rules: null,
    active: true,
  });
  store.emails.push(
    email({
      post_id: "merge-a",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-02T01:00:00.000Z",
      subject: "Make Safe - Redacted - Job No 69019",
      body_content: "Work Order AJBR 69019 received for review.",
    }),
    email({
      post_id: "merge-b",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "Make Safe - Redacted - Job No 69019",
      body_content: "Work Order AJBR 69019 received for review.",
    }),
  );
  // Same deliverable this run, but the two persisted authorities were split under
  // different deliverables. Collapsing them under one primary row would silently
  // rewrite a genuinely distinct canonical source, so binding must throw.
  seedCanonicalCase(
    store,
    "merge-case-a",
    "fingerprint:merge-a/deliverable:wo%3AAJBR-69019/cycle:1",
    "merge-a",
  );
  seedCanonicalCase(
    store,
    "merge-case-b",
    "fingerprint:merge-b/deliverable:wo%3AAJBR-70000/cycle:1",
    "merge-b",
  );

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    approveDraft,
  });
  assertEquals(
    report.isolated_failures[0]?.reason,
    "multiple_persisted_deliverables",
  );
  assertEquals(report.totals.components_failed, 1);
  assertEquals(report.totals.sources_quarantined, 2);
  assertEquals(report.completion_status, "completed_degraded");
  assertEquals(report.totals.write_failures, 1);
  assertEquals(
    store.email_events_raw
      .filter((row) =>
        row.change_type === "intake_exception_lineage_quarantine"
      )
      .map((row) => row.post_id)
      .sort(),
    ["merge-a", "merge-b"],
  );
  assert(
    report.evidence.caveats.includes("lineage_components_quarantined"),
  );
  assert(
    report.evidence.caveats.includes(
      "scan_page_completed_degraded_retry_next_sweep",
    ),
  );
  assertEquals(store.makesafe_intake_cases.length, 2);
});

Deno.test("fresh or state-mismatched multi-authority merges are quarantined", async () => {
  const groupedStore = (prefix: string, includeFresh: boolean) => {
    const store = baseStore();
    store.makesafe_companies.push({
      id: "22222222-2222-2222-2222-222222222222",
      slug: "aj",
      name: "AJ",
      sender_patterns: ["aj.test"],
      parsing_rules: null,
      active: true,
    });
    for (
      const [index, suffix] of ["a", "b", ...(includeFresh ? ["c"] : [])]
        .entries()
    ) {
      store.emails.push(email({
        post_id: `${prefix}-${suffix}`,
        from_email: "dispatch@aj.test",
        received_at: `2026-07-0${index + 2}T01:00:00.000Z`,
        subject: "Make Safe - Redacted - Job No 69019",
        body_content: "Work Order AJBR 69019 received for review.",
      }));
    }
    seedCanonicalCase(
      store,
      `${prefix}-case-a`,
      `fingerprint:${prefix}-a/deliverable:wo%3AAJBR-69019/cycle:1`,
      `${prefix}-a`,
    );
    seedCanonicalCase(
      store,
      `${prefix}-case-b`,
      `fingerprint:${prefix}-b/deliverable:wo%3AAJBR-69019/cycle:1`,
      `${prefix}-b`,
    );
    return store;
  };
  const options = {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    approveDraft,
  } as const;

  const fresh = groupedStore("fresh-merge", true);
  const freshReport = await runDeterministicIntake(
    fakeClient(fresh),
    options,
  );
  assertEquals(
    freshReport.isolated_failures[0]?.reason,
    "fresh_multi_authority_merge",
  );
  assertEquals(freshReport.totals.sources_quarantined, 3);
  assertEquals(fresh.makesafe_intake_cases.length, 2);
  assertEquals(fresh.makesafe_intake_case_sources.length, 2);

  const stateMismatch = groupedStore("state-merge", false);
  stateMismatch.makesafe_intake_cases.find((row) =>
    row.id === "state-merge-case-b"
  ).state = "accounted_non_wo";
  const mismatchReport = await runDeterministicIntake(
    fakeClient(stateMismatch),
    options,
  );
  assertEquals(
    mismatchReport.isolated_failures[0]?.reason,
    "state_mismatched_secondary_authority",
  );
  assertEquals(mismatchReport.totals.sources_quarantined, 2);
  assertEquals(stateMismatch.makesafe_intake_cases.length, 2);
  assertEquals(stateMismatch.makesafe_intake_case_sources.length, 2);
});

Deno.test("inverse authority binding requires explicit correction across the four-authority BOX shape", async () => {
  const buildCrossedStore = (
    corrected: boolean,
    identityMismatch = false,
    includeFreshFollowUp = true,
  ) => {
    const store = baseStore();
    const claims = ["26947", "26948", "26949", "26950"];
    const legacyCaseIds = claims.map((_, index) => `box-legacy-${index + 1}`);
    const effectiveCaseIds = claims.map((claim) => `box-effective-${claim}`);
    for (const [index, claim] of claims.entries()) {
      store.makesafe_intake_cases.push({
        id: effectiveCaseIds[index],
        org_id: "00000000-0000-0000-0000-000000000001",
        instruction_key:
          `fingerprint:corrected-${claim}/deliverable:wo%3AWO-${claim}/cycle:1`,
        lineage_id: effectiveCaseIds[index],
        cycle: 1,
        parent_relation: null,
        source_fingerprint: `corrected-${claim}`,
        state: "exception",
        job_id: null,
        last_decision_provenance: "backfill",
        normaliser_version:
          "makesafe_refs.normaliseRef+wo_po_precedence@v2+po_box_reconciliation@v1",
      });
    }
    for (const [authorityIndex, legacyCaseId] of legacyCaseIds.entries()) {
      store.makesafe_intake_cases.push({
        id: legacyCaseId,
        org_id: "00000000-0000-0000-0000-000000000001",
        instruction_key:
          `fingerprint:false-box-${authorityIndex}/deliverable:po%3ABOX/cycle:1`,
        lineage_id: legacyCaseId,
        cycle: 1,
        parent_relation: null,
        source_fingerprint: `false-box-${authorityIndex}`,
        state: "exception",
        job_id: null,
      });
      for (const [claimIndex, claim] of claims.entries()) {
        const postId = `box-${authorityIndex + 1}-${claim}`;
        store.emails.push(email({
          post_id: postId,
          received_at: `2026-07-${
            String(2 + authorityIndex).padStart(2, "0")
          }T0${claimIndex + 1}:00:00.000Z`,
          subject: `NEW WORK ORDER MLB-${claim} Work Order: WO-${claim}`,
          body_content: `Client: Claim ${claim}\nAddress: ${
            claimIndex + 1
          } Claim Street, Perth\nPO Box 2143, Malaga WA 6944`,
        }));
        store.makesafe_intake_case_sources.push({
          id: `source-${postId}`,
          org_id: "00000000-0000-0000-0000-000000000001",
          case_id: legacyCaseId,
          post_id: postId,
        });
        if (corrected) {
          store.makesafe_intake_source_authority_corrections.push({
            id: `correction-${postId}`,
            org_id: "00000000-0000-0000-0000-000000000001",
            source_post_id: postId,
            legacy_case_id: legacyCaseId,
            effective_case_id: effectiveCaseIds[claimIndex],
            target_job_id: null,
            expected_identity_key:
              identityMismatch && authorityIndex === 0 && claimIndex === 0
                ? "wo:WO-99999"
                : `wo:WO-${claim}`,
          });
        }
      }
    }
    if (includeFreshFollowUp) {
      store.emails.push(email({
        post_id: "box-report-follow-up",
        received_at: "2026-07-10T01:00:00.000Z",
        subject: "Roof report required MLB-26950 Work Order: WO-26950",
        body_content:
          "Client: Claim 26950\nAddress: 4 Claim Street, Perth\nPO Box 2143, Malaga WA 6944",
      }));
    }
    return store;
  };

  const uncorrected = await runDeterministicIntake(
    fakeClient(buildCrossedStore(false)),
    {
      dryRun: true,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
    },
  );
  assertEquals(
    uncorrected.isolated_failures[0]?.reason,
    "persisted_authority_split_reconciliation_required",
  );
  assertEquals(uncorrected.totals.components_failed, 1);
  assertEquals(uncorrected.totals.sources_quarantined, 17);

  const corrected = await runDeterministicIntake(
    fakeClient(buildCrossedStore(true)),
    {
      dryRun: true,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
    },
  );
  assertEquals(corrected.isolated_failures, []);
  assertEquals(corrected.totals.sources_quarantined, 0);
  assertEquals(corrected.selection.selected_sources, 17);
  assertEquals(corrected.selection.selected_cases, 5);

  const historicalOnlyStore = buildCrossedStore(true, false, false);
  const historicalCaseCount = historicalOnlyStore.makesafe_intake_cases.length;
  const historicalSourceCount =
    historicalOnlyStore.makesafe_intake_case_sources.length;
  let historicalApprovalCalls = 0;
  const historicalOnly = await runDeterministicIntake(
    fakeClient(historicalOnlyStore),
    {
      dryRun: false,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
      approveDraft: () => {
        historicalApprovalCalls++;
        throw new Error(
          "reconciled BOX history must never enter operational approval",
        );
      },
    },
  );
  assertEquals(historicalOnly.totals.cases_attempted, 0);
  assertEquals(historicalOnly.totals.case_rows_created, 0);
  assertEquals(historicalOnly.totals.source_rows_created, 0);
  assertEquals(historicalOnly.totals.drafts_created, 0);
  assertEquals(historicalOnly.totals.jobs_created, 0);
  assertEquals(historicalApprovalCalls, 0);
  assertEquals(
    historicalOnlyStore.makesafe_intake_cases.length,
    historicalCaseCount,
  );
  assertEquals(
    historicalOnlyStore.makesafe_intake_case_sources.length,
    historicalSourceCount,
  );

  const staleCorrection = await runDeterministicIntake(
    fakeClient(buildCrossedStore(true, true)),
    {
      dryRun: true,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
    },
  );
  assertEquals(
    staleCorrection.isolated_failures[0]?.reason,
    "source_correction_identity_mismatch_reconciliation_required",
  );
  assert(staleCorrection.totals.sources_quarantined > 0);
  assertEquals(staleCorrection.completion_status, "completed_degraded");

  const secondRoundStore = buildCrossedStore(true, false, false);
  const splitSources = secondRoundStore
    .makesafe_intake_source_authority_corrections.filter((row) =>
      row.source_post_id.endsWith("-26948")
    );
  for (const correction of splitSources) {
    correction.effective_case_id = "box-effective-26947";
  }
  secondRoundStore.makesafe_intake_cases.push({
    id: "box-v2-effective-26948",
    org_id: "00000000-0000-0000-0000-000000000001",
    instruction_key: "fingerprint:v2-26948/deliverable:wo%3AWO-26948/cycle:1",
    lineage_id: "box-v2-effective-26948",
    cycle: 1,
    parent_relation: null,
    source_fingerprint: "v2-26948",
    state: "exception",
    job_id: null,
    last_decision_provenance: "backfill",
    normaliser_version:
      "makesafe_refs.normaliseRef+wo_po_precedence@v2+lineage_reconciliation@v2",
  });
  for (const correction of splitSources) {
    secondRoundStore
      .makesafe_intake_source_authority_correction_supersessions.push({
        org_id: "00000000-0000-0000-0000-000000000001",
        source_post_id: correction.source_post_id,
        superseded_correction_id: correction.id,
        prior_authority_case_id: "box-effective-26947",
        effective_case_id: "box-v2-effective-26948",
        expected_identity_key: "wo:WO-26948",
      });
  }
  const secondRound = await runDeterministicIntake(
    fakeClient(secondRoundStore),
    {
      dryRun: true,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
    },
  );
  assertEquals(secondRound.isolated_failures, []);
  assertEquals(secondRound.totals.sources_quarantined, 0);

  const repairedIdentityStore = buildCrossedStore(true, true, false);
  const stale = repairedIdentityStore
    .makesafe_intake_source_authority_corrections.find((row) =>
      row.expected_identity_key === "wo:WO-99999"
    );
  repairedIdentityStore
    .makesafe_intake_source_authority_correction_supersessions.push({
      org_id: "00000000-0000-0000-0000-000000000001",
      source_post_id: stale.source_post_id,
      superseded_correction_id: stale.id,
      prior_authority_case_id: stale.effective_case_id,
      effective_case_id: stale.effective_case_id,
      expected_identity_key: null,
    });
  const repairedIdentity = await runDeterministicIntake(
    fakeClient(repairedIdentityStore),
    {
      dryRun: true,
      selectionMode: "full_open",
      days: 30,
      nowIso: NOW,
      maxCases: 10,
    },
  );
  assertEquals(repairedIdentity.isolated_failures, []);
  assertEquals(repairedIdentity.totals.sources_quarantined, 0);

  const staleSupersessionStore = buildCrossedStore(true, false, false);
  const correctedSource =
    staleSupersessionStore.makesafe_intake_source_authority_corrections[0];
  staleSupersessionStore
    .makesafe_intake_source_authority_correction_supersessions.push({
      org_id: "00000000-0000-0000-0000-000000000001",
      source_post_id: correctedSource.source_post_id,
      superseded_correction_id: "not-the-reviewed-correction",
      prior_authority_case_id: correctedSource.effective_case_id,
      effective_case_id: correctedSource.effective_case_id,
      expected_identity_key: correctedSource.expected_identity_key,
    });
  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(staleSupersessionStore), {
        dryRun: true,
        selectionMode: "full_open",
        days: 30,
        nowIso: NOW,
        maxCases: 10,
      }),
    Error,
    "source correction supersession target mismatch",
  );

  const stalePriorStore = buildCrossedStore(true, false, false);
  const stalePriorCorrection =
    stalePriorStore.makesafe_intake_source_authority_corrections[0];
  stalePriorStore
    .makesafe_intake_source_authority_correction_supersessions.push({
      org_id: "00000000-0000-0000-0000-000000000001",
      source_post_id: stalePriorCorrection.source_post_id,
      superseded_correction_id: stalePriorCorrection.id,
      prior_authority_case_id: "not-the-current-authority",
      effective_case_id: stalePriorCorrection.effective_case_id,
      expected_identity_key: stalePriorCorrection.expected_identity_key,
    });
  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(stalePriorStore), {
        dryRun: true,
        selectionMode: "full_open",
        days: 30,
        nowIso: NOW,
        maxCases: 10,
      }),
    Error,
    "source correction supersession prior authority mismatch",
  );
});

Deno.test("a poisoned BOX component links AJ 70062 to SWMS-261055 and never revives cancelled SWMS-261054", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ Building & Restoration",
    sender_patterns: ["ajs.build"],
    parsing_rules: null,
    active: true,
  });
  const poisonIds = ["box-poison-26947", "box-poison-26948"];
  for (const [index, claim] of ["26947", "26948"].entries()) {
    store.emails.push(email({
      post_id: poisonIds[index],
      received_at: `2026-07-23T0${index + 1}:00:00.000Z`,
      subject: `NEW WORK ORDER MLB-${claim} Work Order: WO-${claim}`,
      body_content: `Client: Poison ${claim}\nAddress: ${
        index + 1
      } Poison Street, Perth\nPO Box 2143, Malaga WA 6944`,
    }));
  }
  seedCanonicalCase(
    store,
    "poison-box-authority",
    "fingerprint:poison-box/deliverable:po%3ABOX/cycle:1",
    poisonIds[0],
  );
  store.makesafe_intake_case_sources.push({
    id: "source-poison-box-2",
    org_id: "00000000-0000-0000-0000-000000000001",
    case_id: "poison-box-authority",
    post_id: poisonIds[1],
  });

  const ajSourceIds = [
    "AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAAr9x7QAAA=",
    "mailbox_264b5ecbedc4e9de97560c373f5fb9941936cc42186dab6d5336d7bb6fd9650d",
  ];
  for (const [index, postId] of ajSourceIds.entries()) {
    store.emails.push(email({
      post_id: postId,
      from_email: "workorders@ajs.build",
      received_at: "2026-07-24T02:07:26.000Z",
      subject: "Make Safe - Dianella - Job No 70062",
      body_content:
        "Client: Emma Clingan\nPhone: 0400 000 062\nAddress: 12 Railton Place, Dianella WA 6059",
    }));
    store.email_attachments.push({
      id: `aj-70062-attachment-${index + 1}`,
      email_id: postId,
      name: "Works Order.pdf",
      content_type: "application/pdf",
      storage_path: `raw/aj-70062-${index + 1}.pdf`,
      status: "uploaded",
      size_bytes: 2048,
      sha256:
        "d76df8ef7248120bdb9c4356259234b92fe293df94eb8bdbcb42cbcb7f32e7b0",
    });
    store.makesafe_intake_source_authority_corrections.push({
      org_id: "00000000-0000-0000-0000-000000000001",
      source_post_id: postId,
      legacy_case_id: null,
      effective_case_id: null,
      target_job_id: "985708c4-ffae-48e4-aab7-9c8ead7dac0e",
      expected_identity_key: "wo:AJBR-70062",
    });
  }

  const cancelledDuplicate = {
    id: "401b97c8-b5e8-49ff-8202-5be5bb0a1135",
    job_number: "SWMS-261054",
    status: "cancelled",
    type: "makesafe",
    site_address: "12 Railton Place, Dianella WA 6059",
    metadata: { external_ref: "70062" },
  };
  const existingJob = {
    id: "985708c4-ffae-48e4-aab7-9c8ead7dac0e",
    job_number: "SWMS-261055",
    status: "processing",
    type: "makesafe",
    site_address: "12 Railton Place, Dianella WA 6059",
    metadata: { external_ref: "70062" },
  };
  const hugoAssignment = {
    id: "d413fb96-f442-40c0-bdfd-782f54c096fd",
    job_id: existingJob.id,
    user_id: "b353f39a-b3cc-495d-a016-50ebf4a8497d",
    status: "scheduled",
  };
  store.jobs = [cancelledDuplicate, existingJob];
  store.job_assignments = [hugoAssignment];
  store.work_orders = [];
  store.outbound_messages = [];
  store.makesafe_job_details.push({
    job_id: cancelledDuplicate.id,
    external_ref: "70062",
    requesting_company_slug: "ajbr",
    requesting_company_name: "AJ Building & Restoration",
    report_type: null,
    jobs: cancelledDuplicate,
  });
  store.makesafe_job_details.push({
    job_id: existingJob.id,
    external_ref: "70062",
    requesting_company_slug: "aj",
    requesting_company_name: "AJ Building & Restoration",
    report_type: null,
    jobs: existingJob,
  });
  const exactAjStore = structuredClone(store);
  const jobsBefore = JSON.stringify(store.jobs);
  const assignmentsBefore = JSON.stringify(store.job_assignments);
  let approvalCalls = 0;

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: "2026-07-24T12:00:00.000Z",
    maxCases: 10,
    approveDraft: () => {
      approvalCalls++;
      throw new Error("AJ existing-job accounting must not approve a draft");
    },
  });

  assertEquals(
    report.isolated_failures[0]?.reason,
    "persisted_authority_split_reconciliation_required",
  );
  assertEquals(report.totals.components_failed, 1);
  assertEquals(report.totals.sources_quarantined, 2);
  assertEquals(report.completion_status, "completed_degraded");
  assertEquals(report.totals.case_rows_created, 1);
  assertEquals(report.totals.source_rows_created, 2);
  assertEquals(report.totals.drafts_created, 0);
  assertEquals(report.totals.jobs_created, 0);
  assertEquals(approvalCalls, 0);
  const ajCase = store.makesafe_intake_cases.find((row: any) =>
    row.job_id === existingJob.id
  );
  assert(ajCase);
  assertEquals(ajCase.external_ref_canonical, "AJBR-70062");
  assertEquals(ajCase.state, "confirmed_live_job");
  assertEquals(
    store.makesafe_intake_case_sources
      .filter((row: any) => row.case_id === ajCase.id)
      .map((row: any) => row.post_id)
      .sort(),
    [...ajSourceIds].sort(),
  );
  assertEquals(
    report.isolated_failures[0].source_post_ids.filter((postId) =>
      ajSourceIds.includes(postId)
    ),
    [],
  );
  assertEquals(JSON.stringify(store.jobs), jobsBefore);
  assertEquals(JSON.stringify(store.job_assignments), assignmentsBefore);
  assertEquals(store.makesafe_intake_drafts.length, 0);
  assertEquals(store.work_orders.length, 0);
  assertEquals(store.outbound_messages.length, 0);
  assertEquals(
    store.makesafe_intake_health[0].extraction_status,
    "degraded",
  );
  assert(
    report.evidence.caveats.includes(
      "scan_page_completed_degraded_retry_next_sweep",
    ),
  );

  let exactApprovalCalls = 0;
  const exactAjReport = await runDeterministicIntake(
    fakeClient(exactAjStore),
    {
      dryRun: false,
      selectionMode: "exact",
      days: 30,
      nowIso: "2026-07-24T12:00:00.000Z",
      maxCases: 1,
      allowSourcePostIds: ajSourceIds,
      requireAllAllowlistMatches: true,
      approveDraft: () => {
        exactApprovalCalls++;
        throw new Error("exact AJ continuation must not approve a draft");
      },
    },
  );
  assertEquals(exactAjReport.selection.mode, "exact");
  assertEquals(exactAjReport.selection.source_allowlist_count, 2);
  assertEquals(exactAjReport.selection.selected_cases, 1);
  assertEquals(exactAjReport.isolated_failures, []);
  assertEquals(exactAjReport.completion_status, "completed");
  assertEquals(exactAjReport.totals.case_rows_created, 1);
  assertEquals(exactAjReport.totals.source_rows_created, 2);
  assertEquals(exactAjReport.totals.jobs_created, 0);
  assertEquals(exactAjReport.totals.drafts_created, 0);
  assertEquals(exactApprovalCalls, 0);
  assertEquals(
    exactAjStore.makesafe_intake_cases.find((row: any) =>
      row.job_id === existingJob.id
    )?.state,
    "confirmed_live_job",
  );
  assertEquals(JSON.stringify(exactAjStore.jobs), jobsBefore);
  assertEquals(JSON.stringify(exactAjStore.job_assignments), assignmentsBefore);
});

Deno.test("a confirmed grouped plan binds no-job exception secondaries but quarantines a genuine state divergence", async () => {
  const groupedStore = () => {
    const store = baseStore();
    store.makesafe_companies.push({
      id: "22222222-2222-2222-2222-222222222222",
      slug: "aj",
      name: "AJ",
      sender_patterns: ["aj.test"],
      parsing_rules: null,
      active: true,
    });
    for (const [index, suffix] of ["a", "b"].entries()) {
      store.emails.push(email({
        post_id: `conf-${suffix}`,
        from_email: "dispatch@aj.test",
        received_at: `2026-07-0${index + 2}T01:00:00.000Z`,
        subject: "NEW WORK ORDER AJBR-69019 Work Order: AJBR 69019 PO: 69019",
        body_content:
          "Client: Grouped Client\nPhone: 0400 000 222\nAddress: 5 Grouped St, Perth",
      }));
      store.email_attachments.push({
        id: `att-conf-${suffix}`,
        email_id: `conf-${suffix}`,
        name: "wo.pdf",
        content_type: "application/pdf",
        storage_path: `raw/conf-${suffix}.pdf`,
        status: "uploaded",
        size_bytes: 2048,
      });
    }
    seedCanonicalCase(
      store,
      "conf-case-a",
      "fingerprint:conf-a/deliverable:wo%3AAJBR-69019/cycle:1",
      "conf-a",
    );
    seedCanonicalCase(
      store,
      "conf-case-b",
      "fingerprint:conf-b/deliverable:wo%3AAJBR-69019/cycle:1",
      "conf-b",
    );
    return store;
  };
  const options = {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    approveDraft,
  } as const;

  // The plan derives confirmed_live_job, but each persisted secondary is a settled
  // no-job exception. resolvedState(plan, null) is exception too, so the grouped
  // history is legitimate and must bind instead of failing on a raw-state mismatch.
  const equal = groupedStore();
  const report = await runDeterministicIntake(fakeClient(equal), options);
  assertEquals(report.totals.write_failures, 0);
  assertEquals(report.totals.jobs_created, 1);
  assertEquals(equal.makesafe_intake_cases.length, 2);

  // The secondary is genuinely divergent in resolved space: accounted_non_wo can
  // never collapse to the plan's exception, so the component must be quarantined.
  const divergent = groupedStore();
  divergent.makesafe_intake_cases.find((row) => row.id === "conf-case-b")
    .state = "accounted_non_wo";
  const divergentReport = await runDeterministicIntake(
    fakeClient(divergent),
    options,
  );
  assertEquals(
    divergentReport.isolated_failures[0]?.reason,
    "state_mismatched_secondary_authority",
  );
  assertEquals(divergent.makesafe_intake_cases.length, 2);
  assertEquals(divergent.makesafe_intake_case_sources.length, 2);
});

Deno.test("exact selection ignores an unrelated fresh multi-authority case on the bounded page", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ",
    sender_patterns: ["aj.test"],
    parsing_rules: null,
    active: true,
  });
  for (const [index, suffix] of ["a", "b", "fresh"].entries()) {
    store.emails.push(email({
      post_id: `unrelated-merge-${suffix}`,
      from_email: "dispatch@aj.test",
      received_at: `2026-07-0${index + 2}T01:00:00.000Z`,
      subject: "Make Safe - Redacted - Job No 69019",
      body_content: "Work Order AJBR 69019 received for review.",
    }));
  }
  store.emails.push(email({
    post_id: "exact-independent-tail",
    received_at: "2026-07-09T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-99002 Work Order: WO-99002",
    body_content: "Address: 2 Tail Way, Perth",
  }));
  seedCanonicalCase(
    store,
    "unrelated-case-a",
    "fingerprint:unrelated-a/deliverable:wo%3AAJBR-69019/cycle:1",
    "unrelated-merge-a",
  );
  seedCanonicalCase(
    store,
    "unrelated-case-b",
    "fingerprint:unrelated-b/deliverable:wo%3AAJBR-69019/cycle:1",
    "unrelated-merge-b",
  );

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    selectionMode: "exact",
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    allowSourcePostIds: ["exact-independent-tail"],
    approveDraft,
  });

  assertEquals(report.totals.write_failures, 0);
  assertEquals(report.totals.case_rows_created, 1);
  assertEquals(report.totals.source_rows_created, 1);
  assert(
    store.makesafe_intake_case_sources.some((row) =>
      row.post_id === "exact-independent-tail"
    ),
  );
  assert(
    !store.makesafe_intake_case_sources.some((row) =>
      row.post_id === "unrelated-merge-fresh"
    ),
    "exact mode must leave the unrelated unsafe merge untouched",
  );
  assertEquals(store.makesafe_intake_cases.length, 3);
});

Deno.test("repeatedly failing cases do not consume the commit budget", async () => {
  const store = baseStore();
  for (let i = 1; i <= 2; i++) {
    store.emails.push(
      email({
        post_id: `fail-${i}`,
        received_at: `2026-07-19T0${i}:00:00.000Z`,
        subject: `NEW WORK ORDER MLB-5910${i} Work Order: WO-5910${i}`,
        body_content: `Client: Fail Client ${i}\nAddress: ${i} Fail Way, Perth`,
      }),
    );
    store.email_attachments.push({
      id: `att-fail-${i}`,
      email_id: `fail-${i}`,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/fail-${i}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  store.emails.push(
    email({
      post_id: "good-1",
      received_at: "2026-07-20T02:00:00.000Z",
      subject: "NEW WORK ORDER MLB-59103 Work Order: WO-59103",
      body_content: "Client: Good Client\nAddress: 3 Good Road, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-good",
    email_id: "good-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/good.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(
    store,
    [],
    undefined,
    (path) => {
      const failingSuffix = path.match(/fail-(\d+)/)?.[1];
      const suffix = failingSuffix ?? "3";
      return digitalWorkOrderPdf([
        `Work Order Number MLB-5910${suffix}PO-5910${suffix}`,
        `Policyholders Name ${
          failingSuffix ? `Fail Client ${suffix}` : "Good Client"
        }`,
        `Site Address ${suffix} ${
          failingSuffix ? "Fail Way" : "Good Road"
        } Perth WA`,
        "Scope of Works Attend and make the property safe",
        "Notes",
        "Attend within twenty four hours and protect the occupants and contents from weather damage",
      ]);
    },
  );
  // The two older cases fail on every run. A budget spent on them would starve
  // every case behind them.
  const flakyApprove = (_client: any, body: any) => {
    const draft = store.makesafe_intake_drafts.find((d: any) =>
      d.id === body.draft_id
    );
    if (/WO-5910[12]/.test(String(draft?.deterministic_key || ""))) {
      return Promise.resolve({});
    }
    return Promise.resolve({ job: { id: "job-good" } });
  };

  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxSources: 4,
    maxCases: 1,
    allowSourcePostIds: ["fail-1", "fail-2", "good-1"],
    approveDraft: flakyApprove,
  });

  assertEquals(report.write_failure_reasons.approval_no_job, 2);
  assertEquals(
    store.email_events_raw
      .filter((row) =>
        row.change_type === "intake_exception_source_persist_failed"
      )
      .map((row) => row.post_id)
      .sort(),
    ["fail-1", "fail-2"],
  );
  assertEquals(report.totals.jobs_created, 1);
  assert(
    report.evidence.caveats.includes(
      "scan_page_completed_degraded_retry_next_sweep",
    ),
  );
  assert(store.makesafe_intake_health[0].deterministic_scan_cursor_at !== null);
  assertEquals(
    store.emails.find((e) => e.post_id === "good-1")?.makesafe_scanned_at,
    NOW,
  );
});

Deno.test("repeat failures are deprioritised on the next run", async () => {
  const store = baseStore();
  // Enough permanently failing cases to exhaust the attempt ceiling on their own.
  for (let i = 1; i <= 4; i++) {
    store.emails.push(
      email({
        post_id: `dead-${i}`,
        received_at: `2026-07-19T0${i}:00:00.000Z`,
        subject: `NEW WORK ORDER MLB-5920${i} Work Order: WO-5920${i}`,
        body_content: `Client: Dead Client ${i}\nAddress: ${i} Dead End, Perth`,
      }),
    );
    store.email_attachments.push({
      id: `att-dead-${i}`,
      email_id: `dead-${i}`,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/dead-${i}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  const client = fakeClient(store);
  const deadApprove = (_client: any, body: any) => {
    const draft = store.makesafe_intake_drafts.find((d: any) =>
      d.id === body.draft_id
    );
    return /WO-5920[1-4]/.test(String(draft?.deterministic_key || ""))
      ? Promise.resolve({})
      : Promise.resolve({ job: { id: "job-late" } });
  };
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxCases: 1,
    allowSourcePostIds: ["dead-1", "dead-2", "dead-3", "dead-4"],
    approveDraft: deadApprove,
  });
  assertEquals(first.totals.jobs_created, 0);
  // No commit landed, and the attempt ceiling stopped the run: that is reported
  // rather than looking like a quiet, healthy scan.
  assertEquals(first.attempt_cap_reached_without_commit, true);
  assertEquals(first.totals.cases_failed, 4);

  // A fully evidenced instruction arrives behind all four failures.
  store.emails.push(
    email({
      post_id: "late-1",
      received_at: "2026-07-20T02:00:00.000Z",
      subject: "NEW WORK ORDER MLB-59205 Work Order: WO-59205",
      body_content: "Client: Late Client\nAddress: 5 Late Lane, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-late",
    email_id: "late-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/late.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const second = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxCases: 1,
    allowSourcePostIds: ["dead-1", "dead-2", "dead-3", "dead-4", "late-1"],
    approveDraft: deadApprove,
  });

  // The failed cases accounted their sources on the first run, so they no longer
  // look like fresh work and the run reaches the case that can advance.
  assertEquals(second.totals.jobs_created, 1);
  assertEquals(second.attempt_cap_reached_without_commit, false);
  assertEquals(
    store.emails.find((e) => e.post_id === "late-1")?.makesafe_scanned_at,
    NOW,
  );
});

Deno.test("a disallowed state transition never creates an orphan job", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "orphan-1",
      subject: "NEW WORK ORDER MLB-59500 Work Order: WO-59500",
      body_content: "Client: Orphan Client\nAddress: 5 Orphan Rise, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-orphan",
    email_id: "orphan-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/orphan.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["orphan-1"],
    approveDraft,
  });
  const persisted = store.makesafe_intake_cases[0];
  assert(
    persisted.state === "confirmed_live_job" ||
      persisted.state === "blocked_live_job",
  );

  // Force the case into a state with no edge back to a live-job state.
  persisted.state = "accounted_non_wo";
  persisted.job_id = null;
  for (const row of store.emails) row.makesafe_scanned_at = null;
  store.makesafe_intake_drafts.length = 0;

  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["orphan-1"],
    approveDraft,
  });

  assertEquals(report.totals.jobs_created, 0);
  // A deferral, not a write failure: the case itself committed successfully.
  assertEquals(report.totals.job_creation_deferred, 1);
  assertEquals(report.totals.write_failures, 0);
  // No orphan job, and the case is routed through the one edge the state machine
  // permits rather than being abandoned mid-run.
  assertEquals(store.makesafe_intake_cases[0].state, "exception");
  assertEquals(store.makesafe_intake_cases[0].job_id, null);
  // Sources are still accounted, so nothing is left outside the invariant.
  assert(
    store.makesafe_intake_case_sources.some((s: any) =>
      s.post_id === "orphan-1"
    ),
  );
  // The unresolved case is not stamped away; it stays visible for the next run.
  assertEquals(store.emails[0].makesafe_scanned_at, null);
});

Deno.test("write failures are classified without retaining source content", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "fail-1",
      subject: "NEW WORK ORDER MLB-58000 Work Order: WO-58000",
      body_content: "Client: Fail Client\nAddress: 12 Fail Way, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-fail",
    email_id: "fail-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/fail.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["fail-1"],
    approveDraft: () => Promise.resolve({ job: null }),
  });

  assertEquals(report.totals.write_failures, 1);
  assertEquals(report.write_failure_reasons.approval_no_job, 1);
  // Validation passed, so these writes are legitimate persisted outcomes even
  // though the injected approval callback returned no job. Counters must report
  // what committed rather than waiting for ensureDraftAndJob to return.
  assertEquals(report.totals.artifacts_created, 1);
  assertEquals(report.totals.drafts_created, 1);
  assertEquals(store.makesafe_intake_artifacts.length, 1);
  assertEquals(store.makesafe_intake_drafts.length, 1);
  const serialised = JSON.stringify(report);
  assert(!serialised.includes("Fail Client"));
  assert(!serialised.includes("12 Fail Way"));
});

Deno.test("dark observe is case-level, sanitized, exact, zero-AI and writes only its own sweep position", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "dark-secret-source",
    subject: "NEW WORK ORDER MLB-61001 Work Order: WO-61001",
    body_content: "Client: Private Person\nAddress: 99 Secret Street, Perth",
  }));
  store.email_attachments.push({
    id: "dark-att",
    email_id: "dark-secret-source",
    name: "private-client-work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/private.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const { makesafe_intake_health: _health, ...businessTables } = store as any;
  const before = JSON.stringify(businessTables);
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["dark-secret-source"],
    includeSanitizedCases: true,
  });

  const { makesafe_intake_health: healthAfter, ...businessAfter } =
    store as any;
  assertEquals(JSON.stringify(businessAfter), before);
  // The one permitted dry-run write is the observe sweep position (its tuple of
  // received_at plus tie-breaker post_id). It must not claim a successful
  // extraction or touch the live scan cursor.
  assertEquals(Object.keys(healthAfter[0] ?? {}).sort(), [
    "deterministic_observe_cursor_at",
    "deterministic_observe_cursor_post_id",
    "id",
  ]);
  assertEquals(report.ai_calls, 0);
  assertEquals(report.dry_run, true);
  assertEquals(report.selection.selected_cases, 1);
  assertEquals(report.proposed_cases?.length, 1);
  const serialized = JSON.stringify(report);
  for (
    const forbidden of [
      "dark-secret-source",
      "Private Person",
      "99 Secret Street",
      "WO-61001",
      "private-client-work-order.pdf",
    ]
  ) assert(!serialized.includes(forbidden), `dark output leaked ${forbidden}`);
});

Deno.test("content ledger collapses twin PDFs and an exact run-twice creates no side effects", async () => {
  const store = baseStore();
  store.job_assignments = [];
  store.work_orders = [];
  store.xero_invoices = [];
  store.outbound_messages = [];
  store.emails.push(
    email({
      post_id: "twin-a",
      conversation_id: "twin-conversation",
      subject: "NEW WORK ORDER MLB-62001 Work Order: WO-62001",
      body_content: "Client: Twin Client\nAddress: 1 Twin Way, Perth",
    }),
    email({
      post_id: "twin-b",
      conversation_id: "twin-conversation",
      subject: "NEW WORK ORDER MLB-62001 Work Order: WO-62001",
      body_content: "Client: Twin Client\nAddress: 1 Twin Way, Perth",
    }),
  );
  for (const source of ["twin-a", "twin-b"]) {
    store.email_attachments.push({
      id: `att-${source}`,
      email_id: source,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${source}.pdf`,
      status: "uploaded",
      size_bytes: 3,
    });
  }
  let approvals = 0;
  const approving = () => {
    approvals++;
    return Promise.resolve({ job: { id: "job-twin" } });
  };
  const client = fakeClient(store);
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxCases: 1,
    allowSourcePostIds: ["twin-a"],
    approveDraft: approving,
  });
  assertEquals(first.ai_calls, 0);
  assertEquals(first.totals.jobs_created, 1);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 2);
  assertEquals(store.makesafe_intake_artifacts.length, 1);
  assertEquals(store.makesafe_intake_drafts[0].attachments_json.length, 1);
  assertEquals(approvals, 1);

  const counts = Object.fromEntries(
    Object.entries(store).map(([table, rows]) => [table, rows.length]),
  );
  const second = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: "2026-07-20T12:02:00.000Z",
    onlyUnscanned: false,
    maxCases: 1,
    allowSourcePostIds: ["twin-a"],
    requireAllAllowlistMatches: true,
    approveDraft: approving,
  });
  assertEquals(second.selection.selected_cases, 1);
  assertEquals(second.totals.cases_attempted, 0);
  assertEquals(second.totals.case_rows_created, 0);
  assertEquals(second.totals.source_rows_created, 0);
  assertEquals(second.totals.drafts_created, 0);
  assertEquals(second.totals.jobs_created, 0);
  assertEquals(second.ai_calls, 0);
  assertEquals(approvals, 1);
  for (
    const table of [
      "makesafe_intake_cases",
      "makesafe_intake_case_sources",
      "makesafe_intake_artifacts",
      "makesafe_intake_drafts",
      "job_assignments",
      "work_orders",
      "xero_invoices",
      "outbound_messages",
    ]
  ) {
    assertEquals(
      store[table].length,
      counts[table],
      `${table} changed on replay`,
    );
  }
});

Deno.test("storage failure surfaces a storage blocker instead of staying silent", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "blk-1",
      subject: "NEW WORK ORDER MLB-59000 Work Order: WO-59000",
      body_content: "Client: Blocker Client\nAddress: 13 Blocker Bend, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-blk",
    email_id: "blk-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/blk.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  client.storage.from = () => ({
    download: () =>
      Promise.resolve({ data: null, error: { message: "not authorised" } }),
    upload: () => Promise.resolve({ data: {}, error: null }),
    getPublicUrl: () => ({ data: { publicUrl: null } }),
  });
  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["blk-1"],
    approveDraft,
  });

  assertEquals(report.storage_blockers, ["makesafe-emails_download_failed"]);
  assertEquals(report.write_failure_reasons.attachment_staging, 1);
  assertEquals(
    store.email_events_raw
      .filter((row) =>
        row.change_type ===
          "intake_deferred_attachment_recovery_failed"
      )
      .map((row) => row.post_id),
    ["blk-1"],
  );
  assertEquals(report.ai_calls, 0);
  assertEquals(report.totals.drafts_created, 0);
  assertEquals(report.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.job_assignments?.length ?? 0, 0);
  assertEquals(store.work_orders?.length ?? 0, 0);
  assertEquals(store.xero_invoices?.length ?? 0, 0);
  assertEquals(store.outbound_messages?.length ?? 0, 0);
});

Deno.test("window read cost is capped and does not grow with the mailbox", async () => {
  const bulk = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) =>
      email({
        post_id: `${prefix}-${index}`,
        subject: `Re: general chatter ${index}`,
        body_content: "Thanks, noted.",
      }));

  const small = baseStore();
  small.emails.push(...bulk(900, "a"));
  const smallLog: Array<[string, string]> = [];
  const first = await runDeterministicIntake(fakeClient(small, smallLog), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });

  const large = baseStore();
  large.emails.push(...bulk(4000, "b"));
  const largeLog: Array<[string, string]> = [];
  const second = await runDeterministicIntake(fakeClient(large, largeLog), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });

  assertEquals(first.source_read.cap, 500);
  assertEquals(first.source_read.window_rows, 500);
  assertEquals(first.source_read.cap_reached, true);
  assertEquals(first.totals.sources, 500);
  // A mailbox four times the size reads exactly the same number of rows through
  // the same number of round trips.
  assertEquals(second.source_read.window_rows, first.source_read.window_rows);
  assertEquals(second.totals.sources, first.totals.sources);
  assertEquals(
    largeLog.filter(([table]) => table === "emails").length,
    smallLog.filter(([table]) => table === "emails").length,
  );
});

// The bound is only safe if it defers work rather than dropping it. A newest-first
// truncation would keep re-reading the same newest rows forever, and so would a
// backlog half filtered on makesafe_scanned_at, because ordinary non-actionable
// SES mail is never stamped by any run. The persisted received_at sweep is what
// turns the cap into a rotation. Nothing here stamps or advances anything by hand:
// every read and every cursor write comes out of runDeterministicIntake.
Deno.test("every in-window source is eventually read despite the per-run cap", async () => {
  const store = baseStore();
  const chatter = 40;
  const cap = 10;
  for (let index = 0; index < chatter; index++) {
    store.emails.push(email({
      post_id: `q-${index}`,
      received_at: `2026-07-${
        String(index + 1).padStart(2, "0")
      }T01:00:00.000Z`,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  // Live mode needs a resolvable allowlist. This source is read by id every run
  // and so never consumes the sweep's progress.
  store.emails.push(email({
    post_id: "sweep-wo",
    received_at: "2026-07-10T05:00:00.000Z",
    subject: "NEW WORK ORDER MLB-64000 Work Order: WO-64000",
    body_content: "Client: Sweep Client\nAddress: 4 Sweep Way, Perth",
  }));
  store.email_attachments.push({
    id: "att-sweep",
    email_id: "sweep-wo",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/sweep.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });

  const client = fakeClient(store);
  const readIds = new Set<string>();
  const baseFrom = client.from.bind(client);
  client.from = (table: string) => {
    const api = baseFrom(table);
    if (table !== "emails") return api;
    const baseSelect = api.select;
    api.select = (columns: string) => {
      const query = baseSelect(columns);
      const baseThen = query.then.bind(query);
      query.then = (resolve: (value: any) => void) =>
        baseThen((result: any) => {
          for (const row of result.data || []) {
            if (row?.post_id) readIds.add(row.post_id);
          }
          resolve(result);
        });
      return query;
    };
    return api;
  };

  let runs = 0;
  while (runs < 25) {
    runs++;
    const report = await runDeterministicIntake(client, {
      dryRun: false,
      days: 60,
      nowIso: "2026-08-01T00:00:00.000Z",
      maxSources: cap,
      allowSourcePostIds: ["sweep-wo"],
      approveDraft,
    });
    // Cost stays bounded on every single run, not just on average.
    assert(report.source_read.window_rows <= cap);
    assert(report.source_read.backlog_rows <= report.source_read.backlog_cap);
    if (readIds.size >= chatter + 1) break;
  }

  for (let index = 0; index < chatter; index++) {
    assert(readIds.has(`q-${index}`), `source q-${index} was never read`);
  }
  // The rows that matter are the ones a newest-first cap would have starved: they
  // sit behind the sweep's first page and ahead of the newest half.
  assert(readIds.has("q-10"));
  assert(readIds.has("q-20"));
  assert(
    runs < 25,
    `expected convergence well inside the run budget, got ${runs}`,
  );
});

Deno.test("the scan sweep advances across runs and restarts at the window head", async () => {
  const store = baseStore();
  for (let index = 0; index < 12; index++) {
    store.emails.push(email({
      post_id: `s-${index}`,
      received_at: `2026-07-${
        String(index + 1).padStart(2, "0")
      }T01:00:00.000Z`,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  store.emails.push(email({
    post_id: "cursor-wo",
    received_at: "2026-07-06T05:00:00.000Z",
    subject: "NEW WORK ORDER MLB-64100 Work Order: WO-64100",
    body_content: "Client: Cursor Client\nAddress: 5 Cursor Way, Perth",
  }));
  store.email_attachments.push({
    id: "att-cursor",
    email_id: "cursor-wo",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/cursor.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const run = () =>
    runDeterministicIntake(client, {
      dryRun: false,
      days: 60,
      nowIso: "2026-08-01T00:00:00.000Z",
      maxSources: 4,
      allowSourcePostIds: ["cursor-wo"],
      approveDraft,
    });

  const first = await run();
  assertEquals(first.source_read.cursor_at, null);
  assertEquals(first.source_read.next_cursor_at, "2026-07-02T01:00:00.000Z");
  assertEquals(
    store.makesafe_intake_health[0].deterministic_scan_cursor_at,
    "2026-07-02T01:00:00.000Z",
  );

  const second = await run();
  assertEquals(second.source_read.cursor_at, "2026-07-02T01:00:00.000Z");
  assert(
    String(second.source_read.next_cursor_at) >
      String(first.source_read.next_cursor_at),
    "the sweep must move forward on every run",
  );

  let restarted = false;
  for (let index = 0; index < 12 && !restarted; index++) {
    const report = await run();
    if (report.source_read.next_cursor_at === null) restarted = true;
  }
  assert(restarted, "the sweep must restart once it reaches the window end");
  assertEquals(
    store.makesafe_intake_health[0].deterministic_scan_cursor_at,
    null,
  );
});

// The completeness guarantee has to hold unconditionally, not just when received_at
// happens to be unique. A bare-timestamp cursor advanced with `.gt(received_at)`
// skips every row sharing the boundary timestamp once more of them land in one
// window than a single run's cap can read, stranding the overflow forever. The
// (received_at, post_id) tuple cursor keeps walking those ties until all are read.
Deno.test("the sweep covers a timestamp collision larger than the read cap", async () => {
  const store = baseStore();
  const shared = "2026-07-10T01:00:00.000Z";
  const total = 7;
  for (let index = 0; index < total; index++) {
    store.emails.push(email({
      post_id: `tie-${index}`,
      received_at: shared,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  const client = fakeClient(store);
  const readIds = new Set<string>();
  const baseFrom = client.from.bind(client);
  client.from = (table: string) => {
    const api = baseFrom(table);
    if (table !== "emails") return api;
    const baseSelect = api.select;
    api.select = (columns: string) => {
      const query = baseSelect(columns);
      const baseThen = query.then.bind(query);
      query.then = (resolve: (value: any) => void) =>
        baseThen((result: any) => {
          for (const row of result.data || []) {
            if (row?.post_id) readIds.add(row.post_id);
          }
          resolve(result);
        });
      return query;
    };
    return api;
  };

  // maxSources 4 => backlog cap 2, so the collision (7 rows) far exceeds one run's
  // sweep page and cannot be read in a single pass.
  let runs = 0;
  while (runs < 25 && readIds.size < total) {
    runs++;
    const report = await runDeterministicIntake(client, {
      dryRun: true,
      days: 60,
      nowIso: "2026-08-01T00:00:00.000Z",
      maxSources: 4,
    });
    assert(report.source_read.backlog_rows <= report.source_read.backlog_cap);
  }

  for (let index = 0; index < total; index++) {
    assert(readIds.has(`tie-${index}`), `sweep never read tie-${index}`);
  }
  assert(runs < 25, `expected convergence inside the run budget, got ${runs}`);
});

// Cutover evidence is gathered before any live run exists, so dark observe cannot
// borrow the live sweep's progress. It has to reach the middle of a window larger
// than one run's cap entirely on its own.
Deno.test("dark observe sweeps the whole window on its own cursor", async () => {
  const store = baseStore();
  const total = 30;
  for (let index = 0; index < total; index++) {
    store.emails.push(email({
      post_id: `o-${index}`,
      received_at: `2026-07-${
        String(index + 1).padStart(2, "0")
      }T01:00:00.000Z`,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  const client = fakeClient(store);
  const readIds = new Set<string>();
  const baseFrom = client.from.bind(client);
  client.from = (table: string) => {
    const api = baseFrom(table);
    if (table !== "emails") return api;
    const baseSelect = api.select;
    api.select = (columns: string) => {
      const query = baseSelect(columns);
      const baseThen = query.then.bind(query);
      query.then = (resolve: (value: any) => void) =>
        baseThen((result: any) => {
          for (const row of result.data || []) {
            if (row?.post_id) readIds.add(row.post_id);
          }
          resolve(result);
        });
      return query;
    };
    return api;
  };

  let runs = 0;
  while (runs < 25 && readIds.size < total) {
    runs++;
    const report = await runDeterministicIntake(client, {
      dryRun: true,
      days: 60,
      nowIso: "2026-08-01T00:00:00.000Z",
      maxSources: 6,
    });
    assert(report.source_read.window_rows <= 6);
  }

  for (let index = 0; index < total; index++) {
    assert(readIds.has(`o-${index}`), `observe never read o-${index}`);
  }
  // The live sweep is untouched, so cutover starts from the window head rather
  // than from wherever observation happened to stop.
  assertEquals(
    store.makesafe_intake_health[0].deterministic_scan_cursor_at ?? null,
    null,
  );
  assertEquals(
    store.makesafe_intake_health[0].last_successful_extraction_at ?? null,
    null,
  );
});

Deno.test("an all-cap-exposed run is a reported no-op, never a poisoned cron", async () => {
  const store = baseStore();
  for (let index = 0; index < 30; index++) {
    store.emails.push(email({
      post_id: `x-${index}`,
      received_at: `2026-07-${
        String(index + 1).padStart(2, "0")
      }T01:00:00.000Z`,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  // Configured but never yet planned, so it has no persisted case to seed it by
  // id, and its source sits outside this run's cap.
  store.emails.push(email({
    post_id: "hidden-wo",
    received_at: "2026-07-15T05:00:00.000Z",
    subject: "NEW WORK ORDER MLB-64200 Work Order: WO-64200",
    body_content: "Client: Hidden Client\nAddress: 6 Hidden Way, Perth",
  }));
  const client = fakeClient(store);
  const report = await runDeterministicIntake(client, {
    dryRun: false,
    days: 60,
    nowIso: "2026-08-01T00:00:00.000Z",
    maxSources: 4,
    allowInstructionKeys: ["mlb:wo-64200"],
    approveDraft,
  });

  assertEquals(report.source_read.cap_reached, true);
  assertEquals(report.selection.selected_cases, 0);
  assertEquals(report.selection.unmatched_instruction_allowlist, 0);
  assertEquals(report.selection.cap_exposed_instruction_allowlist, 1);
  assert(report.evidence.caveats.includes("no_cases_readable_within_cap"));
  assertEquals(report.totals.jobs_created, 0);
  assertEquals(report.totals.write_failures, 0);
  // The cron still made progress, so the configuration is not pinned out of reach.
  assert(store.makesafe_intake_health[0].deterministic_scan_cursor_at !== null);
  // Filing nothing is not a successful extraction. The alarm and morning-report
  // surfaces read the health row, so the caveat has to live there too.
  const health = store.makesafe_intake_health[0];
  assertEquals(health.extraction_status, "degraded");
  assertEquals(
    health.degraded_reason,
    "deterministic_no_cases_readable_within_cap",
  );
  assertEquals(health.last_successful_extraction_at ?? null, null);
  assertEquals(health.last_scan_at, "2026-08-01T00:00:00.000Z");
});

Deno.test("a genuinely stale allowlist fails closed without advancing its page", async () => {
  const store = baseStore();
  store.emails.push(
    ...Array.from({ length: 8 }, (_, index) =>
      email({
        post_id: `s-${index}`,
        received_at: `2026-07-${
          String(index + 1).padStart(2, "0")
        }T01:00:00.000Z`,
        subject: "Re: chatter",
        body_content: "ok",
      })),
  );
  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(store), {
        dryRun: false,
        days: 30,
        nowIso: NOW,
        maxSources: 4,
        allowSourcePostIds: ["source-does-not-exist"],
        approveDraft,
      }),
    Error,
  );
  assertEquals(store.makesafe_intake_health.length, 0);
});

Deno.test("a capped run is not clean zero-unaccounted evidence", async () => {
  const capped = baseStore();
  capped.emails.push(
    ...Array.from({ length: 900 }, (_, index) =>
      email({
        post_id: `c-${index}`,
        received_at: `2026-07-${
          String((index % 20) + 1).padStart(2, "0")
        }T01:00:00.000Z`,
        subject: `Re: chatter ${index}`,
        body_content: "Thanks, noted.",
      })),
  );
  const cappedReport = await runDeterministicIntake(fakeClient(capped), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });
  assertEquals(cappedReport.source_read.cap_reached, true);
  // totals.unaccounted alone still reads as clean, which is exactly why the gate
  // must key off the evidence block instead.
  assertEquals(cappedReport.totals.unaccounted, 0);
  assertEquals(cappedReport.evidence.source_accounting_complete, false);
  assertEquals(cappedReport.evidence.zero_unaccounted_proved, false);
  assert(cappedReport.evidence.caveats.includes("source_read_capped"));

  const whole = baseStore();
  whole.emails.push(
    email({ post_id: "w-1", subject: "Re: chatter", body_content: "ok" }),
  );
  const wholeReport = await runDeterministicIntake(fakeClient(whole), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
  });
  assertEquals(wholeReport.source_read.cap_reached, false);
  assertEquals(wholeReport.evidence.source_accounting_complete, true);
  assertEquals(wholeReport.evidence.zero_unaccounted_proved, true);
  assertEquals(wholeReport.evidence.caveats, []);
});

Deno.test("a full backlog page cannot claim a clean sweep while its cursor remains", async () => {
  const capped = baseStore();
  for (let index = 0; index < 6; index++) {
    capped.emails.push(email({
      post_id: `overlap-${index}`,
      received_at: `2026-07-${
        String(index + 1).padStart(2, "0")
      }T01:00:00.000Z`,
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
      // Reproduce the gate-report shape: the sweep reads all rows, while the
      // newest half sees fewer because only-unscanned excludes two.
      makesafe_scanned_at: index < 2 ? NOW : null,
    }));
  }
  const cappedReport = await runDeterministicIntake(fakeClient(capped), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxSources: 10,
  });
  assertEquals(cappedReport.source_read.backlog_rows, 5);
  // The unfated queue does not spend recent capacity rereading physical rows
  // already present in the historical lane.
  assertEquals(cappedReport.source_read.recent_rows, 1);
  assertEquals(cappedReport.source_read.window_rows, 6);
  assertEquals(cappedReport.source_read.next_cursor_at !== null, true);
  assertEquals(cappedReport.source_read.cap_reached, true);
  assertEquals(cappedReport.evidence.source_accounting_complete, false);
  assertEquals(cappedReport.evidence.zero_unaccounted_proved, false);
  assert(cappedReport.evidence.caveats.includes("source_read_capped"));

  // A larger bounded replay from the window head can prove the same six rows in
  // one response and returns no tie-breaker source identifiers.
  const complete = baseStore();
  complete.emails.push(...capped.emails.map((row) => ({ ...row })));
  const completeReport = await runDeterministicIntake(fakeClient(complete), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    onlyUnscanned: true,
    maxSources: 20,
  });
  assertEquals(completeReport.source_read.next_cursor_at, null);
  assertEquals(completeReport.source_read.cap_reached, false);
  assertEquals(completeReport.evidence.source_accounting_complete, true);
  assertEquals(completeReport.evidence.zero_unaccounted_proved, true);
  assertEquals(completeReport.evidence.caveats, []);
  assertEquals("cursor_post_id" in completeReport.source_read, false);
  assertEquals("next_cursor_post_id" in completeReport.source_read, false);
});

Deno.test("persisted source authority survives capped-cursor sibling re-key across reruns", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "cursor-noise",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "FYI",
      body_content: "No work instruction.",
    }),
    // This distinct-PO sibling is outside the first one-row sweep page. On the
    // second run it becomes the earlier/root instruction, which used to re-key
    // the exact selected source below as an unpersisted sibling child.
    email({
      post_id: "cursor-parent-po",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90001 Work Order: WO-90001 PO: 900011",
      body_content: "Address: 1 Stable Street, Perth",
    }),
    email({
      post_id: "cursor-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90001 Work Order: WO-90001 PO: 900012",
      body_content: "Address: 1 Stable Street, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-cursor-selected",
    email_id: "cursor-selected-po",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/cursor-selected.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 1,
    maxCases: 1,
    allowSourcePostIds: ["cursor-selected-po"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const first = await runDeterministicIntake(client, options);
  assertEquals(first.source_read.cursor_at, null);
  assertEquals(first.source_read.seed_rows, 1);
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.source_rows_created, 1);
  assertEquals(first.totals.jobs_created, 0);
  assertEquals(first.proposed_cases?.[0].parent_relation, null);
  const stableKeyHash = first.proposed_cases?.[0].case_key_sha256;
  assert(stableKeyHash);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 1);

  // The cursor now exposes cursor-parent-po. The raw planner sees two distinct
  // PO instructions and would make cursor-selected-po a sibling. Persisted-source
  // authority must retain the original key/root and make this rerun inert.
  const second = await runDeterministicIntake(client, options);
  assert(second.source_read.cursor_at !== null);
  assertEquals(second.proposed_cases?.[0].case_key_sha256, stableKeyHash);
  assertEquals(second.proposed_cases?.[0].parent_relation, null);
  assertEquals(second.totals.case_rows_created, 0);
  assertEquals(second.totals.source_rows_created, 0);
  assertEquals(second.totals.drafts_created, 0);
  assertEquals(second.totals.jobs_created, 0);
  assertEquals(second.totals.write_failures, 0);
  assertEquals(second.totals.cases_failed, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 1);

  // A consecutive third page reaches the selected source naturally. It must
  // still converge to the same persisted case with no new business writes.
  const third = await runDeterministicIntake(client, options);
  assert(third.source_read.cursor_at !== null);
  assertEquals(third.proposed_cases?.[0].case_key_sha256, stableKeyHash);
  assertEquals(third.proposed_cases?.[0].parent_relation, null);
  assertEquals(third.totals.case_rows_created, 0);
  assertEquals(third.totals.source_rows_created, 0);
  assertEquals(third.totals.drafts_created, 0);
  assertEquals(third.totals.jobs_created, 0);
  assertEquals(third.totals.write_failures, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 1);
});

Deno.test("exact-selected sibling of a persisted cycle-1 root rebases to the trigger-derived cycle", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "persisted-parent-root",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-25953 Work Order: WO-25953 PO: 259531",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    email({
      post_id: "persisted-parent-reopen-1",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-25953 Work Order: WO-25953 PO: 259533",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    email({
      post_id: "persisted-parent-reopen-2",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-25953 Work Order: WO-25953 PO: 259534",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    // Production shape: two correlated copies of a new exact-selected MLB case,
    // whose ambient sibling parent has a different external reference and is
    // already persisted as a cycle-1 review exception.
    email({
      post_id: "persisted-parent-selected-1",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-26537 Work Order: WO-26537 PO: PO-56922",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    email({
      post_id: "persisted-parent-selected-2",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-10T01:00:01.000Z",
      subject: "NEW WORK ORDER MLB-26537 Work Order: WO-26537 PO: PO-56922",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
  );
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 5,
    seedPostIds: ["persisted-parent-selected-1"],
    cursor: null,
  });
  const rawPlan = buildDeterministicIntakePlan(inputs.sources, inputs.profiles);
  const ambientParent = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("persisted-parent-root")
  );
  const selectedChild = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("persisted-parent-selected-1")
  );
  assert(ambientParent);
  assert(selectedChild);
  assertEquals(ambientParent.cycle, 1);
  assertEquals(selectedChild.parentRelation, "sibling_of");
  assertEquals(
    selectedChild.parentInstructionKey,
    ambientParent.instructionKey,
  );
  assertEquals(selectedChild.cycle, 3);
  assert(/\/cycle:3$/.test(selectedChild.instructionKey));
  assertEquals(selectedChild.sourcePostIds.length, 2);

  store.makesafe_intake_cases.push({
    id: "persisted-cycle-1-parent",
    org_id: "00000000-0000-0000-0000-000000000001",
    instruction_key: ambientParent.instructionKey,
    lineage_id: "persisted-cycle-1-parent",
    cycle: 1,
    state: "exception",
    reason_code: "adapter_parse_failure",
    job_id: null,
    external_ref_canonical: "MLB-25953",
  });
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 5,
    maxCases: 1,
    allowSourcePostIds: ["persisted-parent-selected-1"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const first = await runDeterministicIntake(client, options);
  assertEquals(first.selection.selected_cases, 1);
  assertEquals(first.selection.selected_sources, 2);
  assertEquals(first.proposed_cases?.[0].parent_relation, "sibling_of");
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.source_rows_created, 2);
  assertEquals(first.totals.write_failures, 0);
  assertEquals(first.totals.jobs_created, 0);
  const child = store.makesafe_intake_cases.find((row: any) =>
    row.parent_case_id === "persisted-cycle-1-parent"
  );
  assert(child);
  assertEquals(child.cycle, 1);
  assert(/\/cycle:1$/.test(child.instruction_key));

  const rerun = await runDeterministicIntake(client, options);
  assertEquals(rerun.totals.case_rows_created, 0);
  assertEquals(rerun.totals.source_rows_created, 0);
  assertEquals(rerun.totals.write_failures, 0);
  assertEquals(rerun.totals.drafts_created, 0);
  assertEquals(rerun.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_cases.length, 2);
  assertEquals(store.makesafe_intake_case_sources.length, 2);
});

Deno.test("full-open normalizes a parentless reopen root to database cycle 1", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "fresh-reopen-root",
    thread_id: "fresh-reopen-root-thread",
    received_at: "2026-07-10T01:00:00.000Z",
    subject: "REOPEN WORK ORDER MLB-28001 Work Order: WO-28001 PO: PO-58001",
    body_content: "Address: 1 Root Cycle Way, Perth",
  }));
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 5,
    seedPostIds: [],
    cursor: null,
  });
  const rawRoot = buildDeterministicIntakePlan(inputs.sources, inputs.profiles)
    .cases[0];
  assert(rawRoot);
  assertEquals(rawRoot.parentRelation, null);
  assertEquals(rawRoot.cycle, 2);
  assert(/\/cycle:2$/.test(rawRoot.instructionKey));

  const run = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxSources: 5,
    maxCases: 1,
    approveDraft,
  });
  assertEquals(run.totals.write_failures, 0);
  assertEquals(run.totals.case_rows_created, 1);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_cases[0].parent_relation ?? null, null);
  assertEquals(store.makesafe_intake_cases[0].cycle, 1);
  assert(/\/cycle:1$/.test(store.makesafe_intake_cases[0].instruction_key));
});

Deno.test("full-open normalizes selected persisted-root siblings, cancellation, and reopen descendants", async () => {
  const store = baseStore();
  const thread = "full-open-cycle-thread";
  store.emails.push(
    email({
      post_id: "selected-root",
      thread_id: thread,
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-26499 Work Order: WO-26499 PO: 264990",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "root-reopen-1",
      thread_id: thread,
      received_at: "2026-07-02T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26499 Work Order: WO-26499 PO: 264991",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "root-reopen-2",
      thread_id: thread,
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26499 Work Order: WO-26499 PO: 264992",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "cycle-3-sibling",
      thread_id: thread,
      received_at: "2026-07-04T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-26658 Work Order: WO-26658 PO: 266580",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "sibling-reopen-1",
      thread_id: thread,
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26658 Work Order: WO-26658 PO: 266583",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "sibling-reopen-2",
      thread_id: thread,
      received_at: "2026-07-06T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26658 Work Order: WO-26658 PO: 266584",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "cycle-5-cancellation",
      thread_id: thread,
      received_at: "2026-07-07T01:00:00.000Z",
      subject: "CANCELLED WORK ORDER MLB-24749 Work Order: WO-24749 PO: 247490",
      body_content:
        "Cancel this instruction. Address: 2 Selected Root Way, Perth",
    }),
  );
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 10,
    seedPostIds: [],
    cursor: null,
  });
  const rawPlan = buildDeterministicIntakePlan(inputs.sources, inputs.profiles);
  const root = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("selected-root")
  );
  const sibling = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("cycle-3-sibling")
  );
  const firstSiblingReopen = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("sibling-reopen-1")
  );
  const secondSiblingReopen = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("sibling-reopen-2")
  );
  const cancellation = rawPlan.cases.find((item) =>
    item.sourcePostIds.includes("cycle-5-cancellation")
  );
  assert(root);
  assert(sibling);
  assert(firstSiblingReopen);
  assert(secondSiblingReopen);
  assert(cancellation);
  assertEquals(root.cycle, 1);
  assertEquals(sibling.parentRelation, "sibling_of");
  assertEquals(sibling.cycle, 3);
  assertEquals(firstSiblingReopen.parentRelation, "reopen_of");
  assertEquals(firstSiblingReopen.parentInstructionKey, sibling.instructionKey);
  assertEquals(firstSiblingReopen.cycle, 4);
  assertEquals(secondSiblingReopen.parentRelation, "reopen_of");
  assertEquals(
    secondSiblingReopen.parentInstructionKey,
    firstSiblingReopen.instructionKey,
  );
  assertEquals(secondSiblingReopen.cycle, 5);
  assertEquals(cancellation.parentRelation, "cancellation_of");
  assertEquals(cancellation.cycle, 5);

  store.makesafe_intake_cases.push({
    id: "selected-persisted-root",
    org_id: "00000000-0000-0000-0000-000000000001",
    instruction_key: root.instructionKey,
    lineage_id: "selected-persisted-root",
    cycle: 1,
    state: "exception",
    reason_code: "adapter_parse_failure",
    job_id: null,
  });
  store.makesafe_intake_case_sources.push({
    id: "selected-persisted-root-source",
    org_id: "00000000-0000-0000-0000-000000000001",
    case_id: "selected-persisted-root",
    post_id: "selected-root",
  });

  const run = await runDeterministicIntake(client, {
    dryRun: false,
    selectionMode: "full_open",
    days: 30,
    nowIso: NOW,
    maxSources: 10,
    maxCases: 10,
    approveDraft,
  });
  assertEquals(run.totals.write_failures, 0);
  assertEquals(run.totals.cases_failed, 0);
  assertEquals(run.write_failure_reasons, {});

  const savedSibling = store.makesafe_intake_cases.find((row: any) =>
    row.external_ref_canonical === "MLB-26658" &&
    row.parent_relation === "sibling_of"
  );
  const savedCancellation = store.makesafe_intake_cases.find((row: any) =>
    row.reason_code === "cancellation_target_not_found"
  );
  assert(savedSibling);
  assert(savedCancellation);
  assertEquals(savedSibling.cycle, 1);
  assert(/\/cycle:1$/.test(savedSibling.instruction_key));
  assertEquals(savedCancellation.cycle, 1);
  assert(/\/cycle:1$/.test(savedCancellation.instruction_key));

  const firstSavedSiblingReopen = store.makesafe_intake_cases.find((row: any) =>
    row.parent_relation === "reopen_of" &&
    row.parent_case_id === savedSibling.id
  );
  assert(firstSavedSiblingReopen);
  const secondSavedSiblingReopen = store.makesafe_intake_cases.find((
    row: any,
  ) =>
    row.parent_relation === "reopen_of" &&
    row.parent_case_id === firstSavedSiblingReopen.id
  );
  assert(secondSavedSiblingReopen);
  assertEquals(firstSavedSiblingReopen.cycle, 2);
  assertEquals(secondSavedSiblingReopen.cycle, 3);
  assert(firstSavedSiblingReopen.instruction_key.endsWith("/cycle:2"));
  assert(secondSavedSiblingReopen.instruction_key.endsWith("/cycle:3"));
});

Deno.test("deterministic selection links a canonical MLB ref to its composite-ref recovery job", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "canonical-ref-selected",
    received_at: "2026-07-10T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-26537 Work Order: WO-26537 PO: PO-56922",
    body_content: "Client: Dedupe Client\nAddress: 10 Canonical Way, Perth",
  }));
  store.email_attachments.push({
    id: "att-canonical-ref-selected",
    email_id: "canonical-ref-selected",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/canonical-ref.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  store.makesafe_job_details.push({
    job_id: "different-po-job",
    external_ref: "MLB-26537PO-56866",
    requesting_company_slug: "mlb",
    requesting_company_name: "MLB",
    report_type: null,
    jobs: {
      status: "accepted",
      metadata: { builder_po_number: "PO-56866" },
    },
  }, {
    job_id: "manual-recovery-job",
    external_ref: "MLB-26537PO-56922",
    requesting_company_slug: "mlb",
    requesting_company_name: "MLB",
    report_type: null,
    jobs: {
      status: "accepted",
      metadata: { builder_po_number: "PO-56922" },
    },
  });
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 5,
    maxCases: 1,
    allowSourcePostIds: ["canonical-ref-selected"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const first = await runDeterministicIntake(client, options);
  assertEquals(first.selection.selected_cases, 1);
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.source_rows_created, 1);
  assertEquals(first.totals.drafts_created, 0);
  assertEquals(first.totals.jobs_created, 0);
  assertEquals(first.totals.write_failures, 0);
  assertEquals(store.makesafe_intake_cases[0].job_id, "manual-recovery-job");
  assertEquals(store.makesafe_intake_cases[0].state, "blocked_live_job");

  const rerun = await runDeterministicIntake(client, options);
  assertEquals(rerun.totals.case_rows_created, 0);
  assertEquals(rerun.totals.source_rows_created, 0);
  assertEquals(rerun.totals.drafts_created, 0);
  assertEquals(rerun.totals.jobs_created, 0);
  assertEquals(rerun.totals.write_failures, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
});

Deno.test("live-shaped fresh exception loop converges across cron rerun and same-instruction mail", async () => {
  const store = baseStore();
  store.emails.push(
    // The real canary's exact source was planned after two earlier reopen groups.
    // It was therefore a cycle-3 sibling before N=1 authority promoted it to a
    // root. Keep all four sources in the capped page to reproduce that shape.
    email({
      post_id: "loop-ambient-po",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: 905011",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-ambient-reopen-1",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-90501 Work Order: WO-90501 PO: 905013",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-ambient-reopen-2",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-90501 Work Order: WO-90501 PO: 905014",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: 905012",
      body_content: "Address: 5 Loop Street, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-loop-selected",
    email_id: "loop-selected-po",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/loop-selected.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const plannedInputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 4,
    seedPostIds: ["loop-selected-po"],
    cursor: null,
  });
  const preAuthorityPlan = buildDeterministicIntakePlan(
    plannedInputs.sources,
    plannedInputs.profiles,
  );
  const preAuthoritySelected = preAuthorityPlan.cases.find((item) =>
    item.sourcePostIds.includes("loop-selected-po")
  );
  assert(preAuthoritySelected);
  assertEquals(preAuthoritySelected.cycle, 3);
  assertEquals(preAuthoritySelected.parentRelation, "sibling_of");
  assert(/\/cycle:3$/.test(preAuthoritySelected.instructionKey));

  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 4,
    maxCases: 1,
    allowSourcePostIds: ["loop-selected-po"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  // Production cron pass: the fresh exact sibling becomes the authorised root
  // review exception rather than pulling in or waiting for the ambient sibling.
  const first = await runDeterministicIntake(client, options);
  assertEquals(first.source_read.cap_reached, true);
  assertEquals(first.proposed_cases?.[0].outcome, "exception");
  assertEquals(first.proposed_cases?.[0].reason_code, "adapter_parse_failure");
  assert(first.proposed_cases?.[0].missing_fields.includes("client_name"));
  assertEquals(first.proposed_cases?.[0].parent_relation, null);
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.source_rows_created, 1);
  assertEquals(first.totals.write_failures, 0);
  assertEquals(first.totals.drafts_created, 0);
  assertEquals(first.totals.jobs_created, 0);
  const stableKeyHash = first.proposed_cases?.[0].case_key_sha256;
  assert(stableKeyHash);
  assertEquals(store.makesafe_intake_cases.length, 1);
  const persistedRoot = store.makesafe_intake_cases[0];
  assertEquals(persistedRoot.state, "exception");
  assertEquals(persistedRoot.cycle, 1);
  assert(/\/cycle:1$/.test(persistedRoot.instruction_key));
  assertEquals(
    persistedRoot.recovery_cursor.sideEffectKeys.draft,
    `draft:${persistedRoot.instruction_key}`,
  );
  assertEquals(
    persistedRoot.recovery_cursor.sideEffectKeys.job,
    `job:${persistedRoot.instruction_key}`,
  );
  assertEquals(
    persistedRoot.recovery_cursor.sideEffectKeys.approvals,
    [`approval:${persistedRoot.instruction_key}`],
  );
  assertEquals(store.makesafe_intake_case_sources.length, 1);

  // Immediate cron rerun: the pending review exception is fully inert.
  const rerun = await runDeterministicIntake(client, options);
  assert(rerun.source_read.cursor_at !== null);
  assertEquals(rerun.proposed_cases?.[0].case_key_sha256, stableKeyHash);
  assertEquals(rerun.proposed_cases?.[0].parent_relation, null);
  assertEquals(rerun.totals.case_rows_created, 0);
  assertEquals(rerun.totals.source_rows_created, 0);
  assertEquals(rerun.totals.write_failures, 0);
  assertEquals(rerun.totals.drafts_created, 0);
  assertEquals(rerun.totals.jobs_created, 0);

  // A second real-shaped mail for the same WO/PO arrives with changed content.
  // This used to re-fingerprint the instruction and reopen the first seam.
  store.emails.push(email({
    post_id: "loop-selected-resend",
    received_at: "2026-07-11T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: 905012",
    body_content:
      "Address: 5 Loop Street, Perth\nFollow-up copy for the same instruction.",
  }));
  store.email_attachments.push({
    id: "att-loop-resend",
    email_id: "loop-selected-resend",
    name: "work-order-resend.pdf",
    content_type: "application/pdf",
    storage_path: "raw/loop-selected-resend.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });

  const withResend = await runDeterministicIntake(client, options);
  assertEquals(withResend.proposed_cases?.[0].case_key_sha256, stableKeyHash);
  assertEquals(withResend.proposed_cases?.[0].parent_relation, null);
  assertEquals(withResend.totals.case_rows_created, 0);
  assertEquals(withResend.totals.source_rows_created, 1);
  assertEquals(withResend.totals.write_failures, 0);
  assertEquals(withResend.totals.drafts_created, 0);
  assertEquals(withResend.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 2);

  // Final cron rerun converges after the new source has been accounted.
  const finalRerun = await runDeterministicIntake(client, options);
  assertEquals(finalRerun.proposed_cases?.[0].case_key_sha256, stableKeyHash);
  assertEquals(finalRerun.proposed_cases?.[0].parent_relation, null);
  assertEquals(finalRerun.totals.case_rows_created, 0);
  assertEquals(finalRerun.totals.source_rows_created, 0);
  assertEquals(finalRerun.totals.write_failures, 0);
  assertEquals(finalRerun.totals.drafts_created, 0);
  assertEquals(finalRerun.totals.jobs_created, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 2);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);
});

Deno.test("approval prevalidation rejects a null canonical client before artifact or draft persistence", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "prevalidate-target",
    subject: "NEW WORK ORDER MLB-93000 Work Order: WO-93000",
    body_content: "Client: Initially Present\nAddress: 1 Guard Way, Perth",
  }));
  store.email_attachments.push({
    id: "att-prevalidate-target",
    email_id: "prevalidate-target",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/prevalidate-target.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 4,
    seedPostIds: ["prevalidate-target"],
    cursor: null,
  });
  const built = buildDeterministicIntakePlan(inputs.sources, inputs.profiles)
    .cases[0];
  assert(built);
  // Reproduce the production contradiction directly: live-ready manifest/state,
  // but the actual canonical client value is null.
  const contradictory = {
    ...built,
    identity: { ...built.identity, clientName: null },
    state: "confirmed_live_job" as const,
  };
  let approvalCalls = 0;
  const persistedOutcomes: string[] = [];
  await assertRejects(
    () =>
      _ensureDraftAndJobForTest(
        client,
        "case-prevalidate",
        contradictory,
        new Map(inputs.sources.map((source) => [source.postId, source])),
        () => {
          approvalCalls++;
          return Promise.resolve({ job: { id: "must-not-run" } });
        },
        () => {},
        (outcome) => persistedOutcomes.push(outcome),
      ),
    Error,
    "approval prevalidation failed: client_name",
  );
  assertEquals(approvalCalls, 0);
  assertEquals(persistedOutcomes, []);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);
});

Deno.test("report-family split obligation requires a work-order PDF before any artifact or draft", async () => {
  const store = baseStore();
  // A report-family email with NO servable work-order PDF. On its own this would be
  // report-only (WO PDF not required), but a combined make-safe + report obligation
  // forces the primary physical: parity with approveIntakeDraft primaryIsReportOnly.
  store.emails.push(email({
    post_id: "split-obligation-target",
    subject: "NEW WORK ORDER MLB-93010 Work Order: WO-93010 Roof Report",
    body_content: "Client: Split Client\nAddress: 7 Split Way, Perth",
  }));
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 4,
    seedPostIds: ["split-obligation-target"],
    cursor: null,
  });
  const built = buildDeterministicIntakePlan(inputs.sources, inputs.profiles)
    .cases[0];
  assert(built);
  const splitReport = {
    ...built,
    identity: { ...built.identity, jobFamily: "roof_report" },
    secondaryObligation: {
      type: "roof_report",
      reason: "combined_makesafe_and_report",
    },
    state: "confirmed_live_job" as const,
  };
  let approvalCalls = 0;
  const persistedOutcomes: string[] = [];
  await assertRejects(
    () =>
      _ensureDraftAndJobForTest(
        client,
        "case-split-obligation",
        splitReport,
        new Map(inputs.sources.map((source) => [source.postId, source])),
        () => {
          approvalCalls++;
          return Promise.resolve({ job: { id: "must-not-run" } });
        },
        () => {},
        (outcome) => persistedOutcomes.push(outcome),
      ),
    Error,
    "approval prevalidation failed: work_order_pdf",
  );
  assertEquals(approvalCalls, 0);
  assertEquals(persistedOutcomes, []);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);
});

Deno.test("report-family plan without a split obligation still needs no work-order PDF", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "report-only-target",
    subject: "NEW WORK ORDER MLB-93011 Work Order: WO-93011 Roof Report",
    body_content: "Client: Report Client\nAddress: 8 Report Way, Perth",
  }));
  const client = fakeClient(store);
  const inputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 4,
    seedPostIds: ["report-only-target"],
    cursor: null,
  });
  const built = buildDeterministicIntakePlan(inputs.sources, inputs.profiles)
    .cases[0];
  assert(built);
  const reportOnly = {
    ...built,
    identity: { ...built.identity, jobFamily: "roof_report" },
    state: "confirmed_live_job" as const,
  };
  let approvalCalls = 0;
  const persistedOutcomes: string[] = [];
  const result = await _ensureDraftAndJobForTest(
    client,
    "case-report-only",
    reportOnly,
    new Map(inputs.sources.map((source) => [source.postId, source])),
    () => {
      approvalCalls++;
      return Promise.resolve({ job: { id: "job-report" } });
    },
    () => {},
    (outcome) => persistedOutcomes.push(outcome),
  );
  // Prevalidation passed with no WO PDF: the report-only path is not over-tightened.
  assertEquals(result.jobId, "job-report");
  assertEquals(approvalCalls, 1);
  assert(persistedOutcomes.includes("draft"));
  assertEquals(store.makesafe_intake_drafts.length, 1);
});

Deno.test("production-shaped moving sweep cannot satisfy a null canonical client from off-case candidates", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "sweep-noise-1",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "FYI one",
      body_content: "No work instruction.",
    }),
    email({
      post_id: "sweep-noise-2",
      received_at: "2026-07-02T01:00:00.000Z",
      subject: "FYI two",
      body_content: "No work instruction.",
    }),
    email({
      post_id: "sweep-noise-3",
      received_at: "2026-07-02T02:00:00.000Z",
      subject: "FYI three",
      body_content: "No work instruction.",
    }),
    // These sibling instructions enter only after the live sweep cursor advances.
    // Their client evidence must never satisfy the target instruction.
    email({
      post_id: "sweep-off-case-client-1",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930011",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-off-case-client-2",
      received_at: "2026-07-04T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930013",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-off-case-client-3",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930014",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-copy-1",
      received_at: "2026-07-09T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930012",
      body_content: "Address: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-copy-2",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930012",
      body_content: "Address: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-exact",
      received_at: "2026-07-11T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: 930012",
      body_content: "Address: 3 Sweep Way, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-sweep-target",
    email_id: "sweep-target-exact",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/sweep-target.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 6,
    maxCases: 1,
    allowSourcePostIds: ["sweep-target-exact"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const manual = await runDeterministicIntake(client, options);
  assertEquals(manual.proposed_cases?.[0].outcome, "exception");
  assert(manual.proposed_cases?.[0].missing_fields.includes("client_name"));
  assertEquals(manual.totals.case_rows_created, 1);
  assertEquals(manual.totals.artifacts_created, 0);
  assertEquals(manual.totals.drafts_created, 0);

  const cursorRow = store.makesafe_intake_health[0];
  const scheduledInputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 6,
    seedPostIds: ["sweep-target-exact"],
    cursor: {
      receivedAt: cursorRow.deterministic_scan_cursor_at,
      postId: cursorRow.deterministic_scan_cursor_post_id,
    },
  });
  const scheduledPlan = buildDeterministicIntakePlan(
    scheduledInputs.sources,
    scheduledInputs.profiles,
  );
  const scheduledTarget = scheduledPlan.cases.find((item) =>
    item.sourcePostIds.includes("sweep-target-exact")
  );
  assert(scheduledTarget);
  assertEquals(scheduledTarget.identity.clientName, null);
  assertEquals(scheduledTarget.evidenceMap.client_name.status, "missing");
  assertEquals(scheduledTarget.evidenceMap.client_name.evidence.length, 0);
  assertEquals(
    scheduledTarget.evidenceMap.client_name.rejectedCandidateLocators.length,
    3,
  );

  // This is the 10:03 shape: the scheduled invocation sees the persisted source
  // authority plus a different sweep page carrying three off-case evidence
  // candidates. Canonical client identity remains null, so it must stay inert.
  const scheduled = await runDeterministicIntake(client, options);
  assert(scheduled.source_read.cursor_at !== null);
  assertEquals(scheduled.proposed_cases?.[0].outcome, "exception");
  assert(scheduled.proposed_cases?.[0].missing_fields.includes("client_name"));
  assertEquals(
    scheduled.proposed_cases?.[0].identity_evidence.client_name,
    false,
  );
  assertEquals(scheduled.totals.case_rows_created, 0);
  assertEquals(scheduled.totals.source_rows_created, 0);
  assertEquals(scheduled.totals.artifacts_created, 0);
  assertEquals(scheduled.totals.drafts_created, 0);
  assertEquals(scheduled.totals.jobs_created, 0);
  assertEquals(scheduled.totals.write_failures, 0);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);
});

Deno.test("overlapping manual and scheduled exact invocations converge without prevalidation side effects", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "overlap-target",
    received_at: "2026-07-10T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-93002 Work Order: WO-93002",
    body_content: "Address: 4 Sweep Way, Perth",
  }));
  store.email_attachments.push({
    id: "att-overlap-target",
    email_id: "overlap-target",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/overlap-target.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 4,
    maxCases: 1,
    allowSourcePostIds: ["overlap-target"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const [manual, scheduled] = await Promise.all([
    runDeterministicIntake(client, options),
    runDeterministicIntake(client, options),
  ]);
  assertEquals(manual.totals.write_failures, 0);
  assertEquals(scheduled.totals.write_failures, 0);
  // Both calls read the same pre-write cursor before either persisted progress,
  // proving the fake exercised an actual overlap rather than a serial rerun.
  assertEquals(manual.source_read.cursor_at, null);
  assertEquals(scheduled.source_read.cursor_at, null);
  assertEquals(
    manual.totals.case_rows_created + scheduled.totals.case_rows_created,
    1,
  );
  assertEquals(store.makesafe_intake_cases.length, 1);
  assertEquals(store.makesafe_intake_case_sources.length, 1);
  assertEquals(store.makesafe_intake_artifacts.length, 0);
  assertEquals(store.makesafe_intake_drafts.length, 0);
  assertEquals(store.makesafe_intake_cases[0].state, "exception");
});

Deno.test("exact selection promoting a cycle-N sibling rebases its selected reopen child to the collapsed cycle", async () => {
  const store = baseStore();
  store.emails.push(
    // Same lineage shape as the single-case canary, but the exact selection now
    // also pulls the promoted sibling's own reopen child. The sibling is a cycle-3
    // review exception and the reopen is its cycle-4 child.
    email({
      post_id: "child-ambient-po",
      received_at: "2026-07-01T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90601 Work Order: WO-90601 PO: 906011",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-ambient-reopen-1",
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: 906013",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-ambient-reopen-2",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: 906014",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90601 Work Order: WO-90601 PO: 906012",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-selected-reopen",
      received_at: "2026-07-12T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: 906015",
      body_content: "Address: 7 Child Street, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-child-selected",
    email_id: "child-selected-po",
    name: "work-order.pdf",
    content_type: "application/pdf",
    storage_path: "raw/child-selected.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const plannedInputs = await _readInputsForTest(client, {
    days: 30,
    onlyUnscanned: false,
    nowIso: NOW,
    maxSources: 5,
    seedPostIds: ["child-selected-po", "child-selected-reopen"],
    cursor: null,
  });
  const preAuthorityPlan = buildDeterministicIntakePlan(
    plannedInputs.sources,
    plannedInputs.profiles,
  );
  const promotedSibling = preAuthorityPlan.cases.find((item) =>
    item.sourcePostIds.includes("child-selected-po")
  );
  const reopenChild = preAuthorityPlan.cases.find((item) =>
    item.sourcePostIds.includes("child-selected-reopen")
  );
  assert(promotedSibling);
  assert(reopenChild);
  // Before N=1 authority: the fresh sibling is a cycle-3 exception and the reopen
  // is its cycle-4 child. A naive promotion to cycle 1 would collapse the sibling
  // but leave the child's /cycle:4 suffix disagreeing with the trigger-derived
  // cycle, hitting the exact instruction-key cycle check this fix targets.
  assertEquals(promotedSibling.cycle, 3);
  assertEquals(promotedSibling.parentRelation, "sibling_of");
  assert(/\/cycle:3$/.test(promotedSibling.instructionKey));
  assertEquals(reopenChild.cycle, 4);
  assertEquals(reopenChild.parentRelation, "reopen_of");
  assertEquals(
    reopenChild.parentInstructionKey,
    promotedSibling.instructionKey,
  );
  assert(/\/cycle:4$/.test(reopenChild.instructionKey));

  const run = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 5,
    maxCases: 2,
    allowSourcePostIds: ["child-selected-po", "child-selected-reopen"],
    includeSanitizedCases: true,
    approveDraft,
  });

  // Both cases commit with no cycle-check failure: the promoted sibling roots the
  // lineage at cycle 1 and its selected reopen child rebases to cycle 2, the cycle
  // the trigger derives from the collapsed parent.
  assertEquals(run.selection.selected_cases, 2);
  assertEquals(run.totals.write_failures, 0);
  assertEquals(run.totals.cases_failed, 0);
  assertEquals(run.totals.case_rows_created, 2);
  assertEquals(store.makesafe_intake_cases.length, 2);

  const persistedRoot = store.makesafe_intake_cases.find((row) =>
    row.parent_relation == null
  );
  const persistedChild = store.makesafe_intake_cases.find((row) =>
    row.parent_relation === "reopen_of"
  );
  assert(persistedRoot);
  assert(persistedChild);
  assertEquals(persistedRoot.cycle, 1);
  assert(/\/cycle:1$/.test(persistedRoot.instruction_key));
  assertEquals(persistedChild.cycle, 2);
  assert(/\/cycle:2$/.test(persistedChild.instruction_key));
  assertEquals(persistedChild.parent_case_id, persistedRoot.id);
  assertEquals(persistedChild.lineage_id, persistedRoot.lineage_id);
});

Deno.test("exact selection pulls the semantic parent chain and advances it within the case cap", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "guard-original",
      thread_id: "guard-thread",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-91001 Work Order: WO-91001 PO: 910011",
      body_content: "Client: Parent Client\nAddress: 2 Guard Street, Perth",
    }),
    email({
      post_id: "guard-revision",
      thread_id: "guard-thread",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "REVISED WORK ORDER MLB-91001 Work Order: WO-91001 PO: 910011",
      body_content:
        "Client: Parent Client\nAddress: 2 Guard Street, Perth\nUpdated instruction",
    }),
  );
  for (const postId of ["guard-original", "guard-revision"]) {
    store.email_attachments.push({
      id: `att-${postId}`,
      email_id: postId,
      name: "wo.pdf",
      content_type: "application/pdf",
      storage_path: `raw/${postId}.pdf`,
      status: "uploaded",
      size_bytes: 1024,
    });
  }
  const client = fakeClient(store);
  const options = {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 10,
    maxCases: 1,
    allowSourcePostIds: ["guard-revision"],
    includeSanitizedCases: true,
    approveDraft,
  } as const;

  const first = await runDeterministicIntake(client, options);
  assertEquals(first.selection.selected_cases, 2);
  assertEquals(first.totals.write_failures, 0);
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.totals.cases_deferred, 1);
  assertEquals(first.proposed_cases?.[0].parent_relation, null);
  assertEquals(first.proposed_cases?.[1].parent_relation, "revision_of");

  const second = await runDeterministicIntake(client, options);
  assertEquals(second.totals.write_failures, 0);
  assertEquals(second.totals.case_rows_created, 1);
  assertEquals(store.makesafe_intake_cases.length, 2);
  const revision = store.makesafe_intake_cases.find((row) =>
    row.parent_relation === "revision_of"
  );
  assert(revision?.parent_case_id);
  assertEquals(store.makesafe_intake_artifacts.length, 2);
  assertEquals(store.makesafe_intake_drafts.length, 2);
});

Deno.test("production-shaped own copy closes onto its persisted ambient parent", async () => {
  const store = baseStore();
  store.makesafe_companies.push({
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJ",
    sender_patterns: ["aj.test"],
    parsing_rules: null,
    active: true,
  });
  store.emails.push(
    email({
      post_id: "ambient-a",
      thread_id: "ambient-thread",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-02T03:35:24.000Z",
      subject: "Make Safe - Redacted - Job No 68554",
      body_content: "Work Order AJBR 68554 received for review.",
    }),
    email({
      post_id: "ambient-b",
      thread_id: "ambient-thread",
      from_email: "dispatch@aj.test",
      received_at: "2026-07-06T22:46:51.000Z",
      subject: "Make Safe - Redacted - Job No 68554",
      body_content: "Work Order AJBR 68554 received for review.",
    }),
    email({
      post_id: "exact-own-copy",
      thread_id: "ambient-thread",
      from_email: "ops@secureworkswa.com.au",
      received_at: "2026-07-07T01:01:48.000Z",
      subject: "Make Safe - Redacted - Job No 68554",
      body_content: "SecureWorks acknowledgement for Job No 68554.",
    }),
  );
  seedCanonicalCase(
    store,
    "ambient-case-a",
    "fingerprint:ambient-a/deliverable:wo%3AAJBR-68554/cycle:1",
    "ambient-a",
  );
  seedCanonicalCase(
    store,
    "ambient-case-b",
    "fingerprint:ambient-b/deliverable:wo%3AAJBR-68554/cycle:1",
    "ambient-b",
  );

  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxCases: 1,
    allowSourcePostIds: ["exact-own-copy"],
    includeSanitizedCases: true,
    approveDraft,
  });

  assertEquals(report.selection.selected_cases, 2);
  assertEquals(report.totals.write_failures, 0);
  assertEquals(report.totals.cases_failed, 0);
  assertEquals(report.totals.cases_attempted, 1);
  assertEquals(report.totals.case_rows_created, 1);
  assertEquals(report.totals.source_rows_created, 1);
  const ownCopyCase = store.makesafe_intake_cases.find((row) =>
    row.state === "accounted_non_wo"
  );
  assert(ownCopyCase);
  assertEquals(ownCopyCase.parent_case_id, "ambient-case-a");
  assertEquals(ownCopyCase.parent_relation, "sibling_of");
});

Deno.test("a re-keyed persisted parent re-points its in-plan child instead of failing closed", async () => {
  const store = baseStore();
  // Run one persists the parent instruction alone, fixing its stable key/root.
  store.emails.push(email({
    post_id: "multi-parent-po",
    received_at: "2026-07-05T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: 920011",
    body_content: "Client: Multi Client\nAddress: 3 Multi Street, Perth",
  }));
  store.email_attachments.push({
    id: "att-multi-parent",
    email_id: "multi-parent-po",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/multi-parent.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  const first = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 50,
    allowSourcePostIds: ["multi-parent-po"],
    includeSanitizedCases: true,
    approveDraft,
  });
  assertEquals(first.totals.case_rows_created, 1);
  assertEquals(first.proposed_cases?.[0].parent_relation, null);
  const parentStableHash = first.proposed_cases?.[0].case_key_sha256;
  assert(parentStableHash);
  assertEquals(store.makesafe_intake_cases.length, 1);

  // A twin of the parent instruction arrives and drifts the parent group's
  // fingerprint, so this run computes a different this-run key for the persisted
  // parent. A brand-new distinct-PO sibling child is parented to that this-run
  // key. Rebinding the parent back to its stable key must also re-point the child.
  store.emails.push(
    email({
      post_id: "multi-parent-twin",
      received_at: "2026-07-06T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: 920011",
      body_content:
        "Client: Multi Client\nAddress: 3 Multi Street, Perth\nFollow-up copy for the same order.",
    }),
    email({
      post_id: "multi-child-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: 920012",
      body_content: "Client: Multi Client\nAddress: 3 Multi Street, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-multi-child",
    email_id: "multi-child-po",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/multi-child.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });

  const second = await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 50,
    maxCases: 2,
    allowSourcePostIds: ["multi-parent-po", "multi-child-po"],
    includeSanitizedCases: true,
    approveDraft,
  });

  // The lineage guard must not fail closed: the parent is present under its stable
  // key, and the child was re-pointed to it rather than left dangling on the
  // parent's this-run key.
  assertEquals(
    second.write_failure_reasons.lineage_parent_unselected,
    undefined,
  );
  assertEquals(second.totals.write_failures, 0);
  assertEquals(second.totals.cases_failed, 0);
  assertEquals(second.selection.selected_cases, 2);
  assert(
    second.proposed_cases?.some((c) =>
      c.case_key_sha256 === parentStableHash && c.parent_relation === null
    ),
    "persisted parent retains its stable key and root identity",
  );
  assert(
    second.proposed_cases?.some((c) => c.parent_relation === "sibling_of"),
    "the newly-arrived child is planned as a re-pointed sibling",
  );
  // The new child instruction becomes its own persisted case alongside the parent.
  assertEquals(store.makesafe_intake_cases.length, 2);
});

Deno.test("an allowlisted instruction key is seeded by id and stays cap-proof", async () => {
  const store = baseStore();
  store.emails.push(email({
    post_id: "wo-1",
    received_at: "2026-07-01T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-64000 Work Order: WO-64000",
    body_content: "Client: Key Client\nAddress: 18 Key Court, Perth",
  }));
  store.email_attachments.push({
    id: "att-key",
    email_id: "wo-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/key.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const client = fakeClient(store);
  await runDeterministicIntake(client, {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["wo-1"],
    approveDraft,
  });
  const instructionKey = store.makesafe_intake_cases[0].instruction_key;
  assert(instructionKey);

  // Bury the instruction's source between older and newer traffic and cap the
  // window to one row, so neither half of the bounded read can reach it and it is
  // only reachable through the instruction-key seed read.
  store.emails.push(email({
    post_id: "older-1",
    received_at: "2026-06-25T01:00:00.000Z",
    subject: "Re: earlier chatter",
    body_content: "Thanks, noted.",
  }));
  for (let index = 0; index < 20; index++) {
    store.emails.push(email({
      post_id: `newer-${index}`,
      received_at: "2026-07-19T01:00:00.000Z",
      subject: `Re: chatter ${index}`,
      body_content: "Thanks, noted.",
    }));
  }
  const report = await runDeterministicIntake(client, {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    maxSources: 1,
    allowInstructionKeys: [instructionKey],
    requireAllAllowlistMatches: true,
  });
  assert(report.source_read.seed_rows >= 1);
  assertEquals(report.selection.selected_cases, 1);
  assertEquals(report.selection.unmatched_instruction_allowlist, 0);
  assertEquals(report.selection.cap_exposed_instruction_allowlist, 0);
});

Deno.test("a cap-induced instruction-key miss is never reported as stale", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "live-key-1",
      received_at: "2026-07-19T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-65000 Work Order: WO-65000",
      body_content: "Client: Capped Client\nAddress: 19 Capped Close, Perth",
    }),
    email({
      post_id: "noise-key-1",
      received_at: "2026-07-19T02:00:00.000Z",
      subject: "Re: chatter",
      body_content: "ok",
    }),
  );
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    maxSources: 2,
    allowSourcePostIds: ["live-key-1"],
    allowInstructionKeys: ["instruction:never:persisted"],
    // A capped run must not fail closed on a key it could not have read.
    requireAllAllowlistMatches: true,
  });
  assertEquals(report.source_read.cap_reached, true);
  assertEquals(report.selection.unmatched_instruction_allowlist, 0);
  assertEquals(report.selection.cap_exposed_instruction_allowlist, 1);
  assert(
    report.evidence.caveats.includes("instruction_allowlist_cap_exposed"),
  );
});

Deno.test("an allowlisted source outside the capped window is still read by id", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "noise-1",
      subject: "Re: chatter",
      body_content: "ok",
      received_at: "2026-07-01T01:00:00.000Z",
    }),
    email({
      post_id: "noise-2",
      subject: "Re: chatter",
      body_content: "ok",
      received_at: "2026-07-02T01:00:00.000Z",
    }),
    // Newer than the noise, so the oldest-first sweep spends its single-row cap on
    // the backlog and only the by-id seed can pull this work order in.
    email({
      post_id: "aged-1",
      subject: "NEW WORK ORDER MLB-61000 Work Order: WO-61000",
      body_content: "Client: Aged Client\nAddress: 15 Aged Avenue, Perth",
      received_at: "2026-07-19T01:00:00.000Z",
    }),
  );
  store.email_attachments.push({
    id: "att-aged",
    email_id: "aged-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/aged.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    maxSources: 1,
    allowSourcePostIds: ["aged-1"],
    approveDraft,
  });

  assertEquals(report.source_read.window_rows, 1);
  assertEquals(report.source_read.seed_rows, 1);
  assertEquals(report.selection.selected_cases, 1);
  assertEquals(report.selection.unmatched_source_allowlist, 0);
  assertEquals(store.makesafe_intake_cases.length, 1);
});

Deno.test("a stale allowlist entry is reported and the resolved set still runs", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "live-1",
      subject: "NEW WORK ORDER MLB-62000 Work Order: WO-62000",
      body_content: "Client: Live Client\nAddress: 16 Live Loop, Perth",
    }),
  );
  store.email_attachments.push({
    id: "att-live",
    email_id: "live-1",
    name: "wo.pdf",
    content_type: "application/pdf",
    storage_path: "raw/live.pdf",
    status: "uploaded",
    size_bytes: 1024,
  });
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: false,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["live-1", "deleted-long-ago"],
    allowInstructionKeys: ["instruction:that:no:longer:groups"],
    approveDraft,
  });

  assertEquals(report.selection.unmatched_source_allowlist, 1);
  assertEquals(report.selection.unmatched_instruction_allowlist, 1);
  assertEquals(report.selection.selected_cases, 1);
  assertEquals(store.makesafe_intake_cases.length, 1);
});

Deno.test("a fully unresolved allowlist fails closed instead of scanning empty", async () => {
  const store = baseStore();
  store.emails.push(
    email({
      post_id: "other-1",
      subject: "NEW WORK ORDER MLB-63000 Work Order: WO-63000",
      body_content: "Client: Other Client\nAddress: 17 Other Way, Perth",
    }),
  );
  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(store), {
        dryRun: false,
        days: 30,
        nowIso: NOW,
        allowSourcePostIds: ["deleted-long-ago"],
        approveDraft,
      }),
    Error,
    "resolved no cases",
  );
  assertEquals(store.makesafe_intake_cases.length, 0);
});
