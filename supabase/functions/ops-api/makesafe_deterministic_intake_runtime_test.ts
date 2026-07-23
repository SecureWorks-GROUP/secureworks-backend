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
  runDeterministicIntake,
} from "./makesafe_deterministic_intake_runtime.ts";
import { buildDeterministicIntakePlan } from "./makesafe_deterministic_intake.ts";

const NOW = "2026-07-20T12:00:00.000Z";

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
) {
  return {
    selectLog,
    store,
    from(table: string) {
      const log = (t: string, c: string) => selectLog.push([t, c]);
      return {
        select: (columns: string) =>
          new FakeQuery(store, table, "select", null, log, inLog).select(
            columns,
          ),
        insert: (payload: any) =>
          new FakeQuery(store, table, "insert", payload, log, inLog),
        update: (payload: any) =>
          new FakeQuery(store, table, "update", payload, log, inLog),
        upsert: (payload: any) =>
          new FakeQuery(store, table, "upsert", payload, log, inLog),
      };
    },
    storage: {
      from() {
        return {
          download: () =>
            Promise.resolve({
              data: {
                arrayBuffer: () =>
                  Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
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
    makesafe_job_details: [],
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
  assertEquals(second.totals.jobs_created, 1);
  assertEquals(second.totals.write_failures, 0);
  // Now that it is settled, the source is stamped and drops out of the next window.
  assertEquals(store.emails[0].makesafe_scanned_at, NOW);
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
  const client = fakeClient(store);
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
  // Deferred cases keep their sources unstamped so the next invocation picks them up.
  assertEquals(
    store.emails.filter((e) => e.makesafe_scanned_at === null).length,
    2,
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

Deno.test("a fresh cross-case merge spanning distinct persisted deliverables fails loudly", async () => {
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

  await assertRejects(
    () =>
      runDeterministicIntake(fakeClient(store), {
        dryRun: false,
        selectionMode: "full_open",
        days: 30,
        nowIso: NOW,
        maxCases: 1,
        approveDraft,
      }),
    Error,
    "multiple persisted deliverables",
  );
  assertEquals(store.makesafe_intake_cases.length, 2);
});

Deno.test("fresh or state-mismatched multi-authority merges fail loudly", async () => {
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
  await assertRejects(
    () => runDeterministicIntake(fakeClient(fresh), options),
    Error,
    "fresh source across multiple persisted cases",
  );
  assertEquals(fresh.makesafe_intake_cases.length, 2);
  assertEquals(fresh.makesafe_intake_case_sources.length, 2);

  const stateMismatch = groupedStore("state-merge", false);
  stateMismatch.makesafe_intake_cases.find((row) =>
    row.id === "state-merge-case-b"
  ).state = "accounted_non_wo";
  await assertRejects(
    () => runDeterministicIntake(fakeClient(stateMismatch), options),
    Error,
    "state-mismatched secondary persisted case",
  );
  assertEquals(stateMismatch.makesafe_intake_cases.length, 2);
  assertEquals(stateMismatch.makesafe_intake_case_sources.length, 2);
});

Deno.test("a confirmed grouped plan binds no-job exception secondaries but rejects a genuine state divergence", async () => {
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
  // never collapse to the plan's exception, so binding must fail loudly.
  const divergent = groupedStore();
  divergent.makesafe_intake_cases.find((row) => row.id === "conf-case-b")
    .state = "accounted_non_wo";
  await assertRejects(
    () => runDeterministicIntake(fakeClient(divergent), options),
    Error,
    "state-mismatched secondary persisted case",
  );
  assertEquals(divergent.makesafe_intake_cases.length, 2);
  assertEquals(divergent.makesafe_intake_case_sources.length, 2);
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
  const client = fakeClient(store);
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
  assertEquals(cappedReport.source_read.recent_rows, 4);
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
      subject: "NEW WORK ORDER MLB-90001 Work Order: WO-90001 PO: PO-90001-A",
      body_content: "Address: 1 Stable Street, Perth",
    }),
    email({
      post_id: "cursor-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90001 Work Order: WO-90001 PO: PO-90001-B",
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
      subject: "NEW WORK ORDER MLB-25953 Work Order: WO-25953 PO: PO-25953-A",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    email({
      post_id: "persisted-parent-reopen-1",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-03T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-25953 Work Order: WO-25953 PO: PO-25953-C",
      body_content: "Address: 9 Persisted Street, Perth",
    }),
    email({
      post_id: "persisted-parent-reopen-2",
      thread_id: "persisted-parent-thread",
      received_at: "2026-07-05T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-25953 Work Order: WO-25953 PO: PO-25953-D",
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
      subject: "NEW WORK ORDER MLB-26499 Work Order: WO-26499 PO: PO-BOX",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "root-reopen-1",
      thread_id: thread,
      received_at: "2026-07-02T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26499 Work Order: WO-26499 PO: PO-R1",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "root-reopen-2",
      thread_id: thread,
      received_at: "2026-07-03T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26499 Work Order: WO-26499 PO: PO-R2",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "cycle-3-sibling",
      thread_id: thread,
      received_at: "2026-07-04T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-26658 Work Order: WO-26658 PO: PO-BOX",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "sibling-reopen-1",
      thread_id: thread,
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26658 Work Order: WO-26658 PO: PO-R3",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "sibling-reopen-2",
      thread_id: thread,
      received_at: "2026-07-06T01:00:00.000Z",
      subject: "REOPEN WORK ORDER MLB-26658 Work Order: WO-26658 PO: PO-R4",
      body_content: "Address: 2 Selected Root Way, Perth",
    }),
    email({
      post_id: "cycle-5-cancellation",
      thread_id: thread,
      received_at: "2026-07-07T01:00:00.000Z",
      subject: "CANCELLED WORK ORDER MLB-24749 Work Order: WO-24749 PO: PO-BOX",
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
    row.reason_code === "cancellation"
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
      subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: PO-90501-A",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-ambient-reopen-1",
      received_at: "2026-07-03T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-90501 Work Order: WO-90501 PO: PO-90501-C",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-ambient-reopen-2",
      received_at: "2026-07-05T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-90501 Work Order: WO-90501 PO: PO-90501-D",
      body_content: "Address: 5 Loop Street, Perth",
    }),
    email({
      post_id: "loop-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: PO-90501-B",
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
    subject: "NEW WORK ORDER MLB-90501 Work Order: WO-90501 PO: PO-90501-B",
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
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-A",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-off-case-client-2",
      received_at: "2026-07-04T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-C",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-off-case-client-3",
      received_at: "2026-07-05T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-D",
      body_content:
        "Client: Other Instruction Client\nAddress: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-copy-1",
      received_at: "2026-07-09T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-B",
      body_content: "Address: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-copy-2",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-B",
      body_content: "Address: 3 Sweep Way, Perth",
    }),
    email({
      post_id: "sweep-target-exact",
      received_at: "2026-07-11T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-93001 Work Order: WO-93001 PO: PO-93001-B",
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
      subject: "NEW WORK ORDER MLB-90601 Work Order: WO-90601 PO: PO-90601-A",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-ambient-reopen-1",
      received_at: "2026-07-03T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: PO-90601-C",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-ambient-reopen-2",
      received_at: "2026-07-05T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: PO-90601-D",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-selected-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-90601 Work Order: WO-90601 PO: PO-90601-B",
      body_content: "Address: 7 Child Street, Perth",
    }),
    email({
      post_id: "child-selected-reopen",
      received_at: "2026-07-12T01:00:00.000Z",
      subject:
        "REOPEN WORK ORDER MLB-90601 Work Order: WO-90601 PO: PO-90601-E",
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
      subject: "NEW WORK ORDER MLB-91001 Work Order: WO-91001 PO: PO-91001-A",
      body_content: "Client: Parent Client\nAddress: 2 Guard Street, Perth",
    }),
    email({
      post_id: "guard-revision",
      thread_id: "guard-thread",
      received_at: "2026-07-10T01:00:00.000Z",
      subject:
        "REVISED WORK ORDER MLB-91001 Work Order: WO-91001 PO: PO-91001-A",
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
    subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: PO-92001-A",
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
      subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: PO-92001-A",
      body_content:
        "Client: Multi Client\nAddress: 3 Multi Street, Perth\nFollow-up copy for the same order.",
    }),
    email({
      post_id: "multi-child-po",
      received_at: "2026-07-10T01:00:00.000Z",
      subject: "NEW WORK ORDER MLB-92001 Work Order: WO-92001 PO: PO-92001-B",
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
