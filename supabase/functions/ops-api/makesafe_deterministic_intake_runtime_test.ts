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
import { runDeterministicIntake } from "./makesafe_deterministic_intake_runtime.ts";

const NOW = "2026-07-20T12:00:00.000Z";

interface Store {
  [table: string]: any[];
}

class FakeQuery {
  private filters: Array<(row: any) => boolean> = [];
  private sliceRange: [number, number] | null = null;
  private limitTo: number | null = null;
  selectedColumns: string | null = null;

  constructor(
    private store: Store,
    private table: string,
    private op: "select" | "insert" | "update" | "upsert",
    private payload: any = null,
    private log?: (table: string, columns: string) => void,
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
  in(column: string, values: any[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  order() {
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
      const duplicate = this.table === "makesafe_intake_case_sources"
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
      const row = {
        id: `${this.table}-${this.store[this.table].length + 1}`,
        ...this.payload,
      };
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

function fakeClient(store: Store, selectLog: Array<[string, string]> = []) {
  return {
    selectLog,
    store,
    from(table: string) {
      const log = (t: string, c: string) => selectLog.push([t, c]);
      return {
        select: (columns: string) =>
          new FakeQuery(store, table, "select", null, log).select(columns),
        insert: (payload: any) =>
          new FakeQuery(store, table, "insert", payload, log),
        update: (payload: any) =>
          new FakeQuery(store, table, "update", payload, log),
        upsert: (payload: any) =>
          new FakeQuery(store, table, "upsert", payload, log),
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
    maxCases: 1,
    allowSourcePostIds: ["fail-1", "fail-2", "good-1"],
    approveDraft: flakyApprove,
  });

  assertEquals(report.write_failure_reasons.approval_no_job, 2);
  assertEquals(report.totals.jobs_created, 1);
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
  const serialised = JSON.stringify(report);
  assert(!serialised.includes("Fail Client"));
  assert(!serialised.includes("12 Fail Way"));
});

Deno.test("dark observe is case-level, sanitized, exact, zero-write and zero-AI", async () => {
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
  const before = JSON.stringify(store);
  const report = await runDeterministicIntake(fakeClient(store), {
    dryRun: true,
    days: 30,
    nowIso: NOW,
    allowSourcePostIds: ["dark-secret-source"],
    includeSanitizedCases: true,
  });

  assertEquals(JSON.stringify(store), before);
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

Deno.test("an allowlisted source outside the capped window is still read by id", async () => {
  const store = baseStore();
  store.emails.push(
    email({ post_id: "noise-1", subject: "Re: chatter", body_content: "ok" }),
    email({ post_id: "noise-2", subject: "Re: chatter", body_content: "ok" }),
    email({
      post_id: "aged-1",
      subject: "NEW WORK ORDER MLB-61000 Work Order: WO-61000",
      body_content: "Client: Aged Client\nAddress: 15 Aged Avenue, Perth",
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
