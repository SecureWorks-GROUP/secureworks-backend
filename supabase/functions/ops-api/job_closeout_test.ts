// deno-lint-ignore-file no-import-prefix no-explicit-any
// Paid close-out (job_closeout.ts) against an in-memory PostgREST fake: the move, the
// review sender's switch, claim and look-back, the 24-hour archive and the backlog list.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  closeoutBacklogPreview,
  closeoutCatchUp,
  closeoutOnPaid,
  closeoutSweep,
  effectiveSenderMode,
  ghlProxyReviewSender,
  type JobCloseoutDeps,
  quoteForCloseout,
  requestJobReview,
  reviewRequestMessage,
  runJobCloseoutAction,
  setReviewOptOut,
  type SmsSendResult,
} from "./job_closeout.ts";

// ── A small PostgREST fake ───────────────────────────────────────────────────

type Row = Record<string, any>;
const PRIMARY_KEYS: Record<string, string> = {
  job_review_claims: "job_id",
  job_closeout_state: "job_id",
  job_closeout_settings: "id",
};

function read(row: Row, col: string): any {
  const path = col.match(/^(\w+)->>(\w+)$/);
  if (path) return row[path[1]]?.[path[2]] ?? null;
  return row[col];
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private from_ = 0;
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: any = null;
  private single: "one" | "maybe" | null = null;
  private badFilter: { message: string; code: string } | null = null;
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string) {
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => read(r, col) === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(read(r, col)));
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => String(read(r, col) ?? "") >= v);
    return this;
  }
  // Serialised as postgrest-js does: a string is sent as is, an array becomes a Postgres
  // array literal (`{[object Object]}`), which a jsonb column refuses with 22P02.
  contains(col: string, v: unknown) {
    let want: Row[];
    try {
      if (typeof v !== "string") throw new Error("not a JSON string");
      want = JSON.parse(v);
    } catch {
      this.badFilter = {
        message: "invalid input syntax for type json",
        code: "22P02",
      };
      return this;
    }
    this.filters.push((r) =>
      want.every((w) =>
        (r[col] ?? []).some((have: Row) =>
          Object.entries(w).every(([k, x]) => have[k] === x)
        )
      )
    );
    return this;
  }
  or(expr: string) {
    const needles = [...expr.matchAll(/ilike\."\*(.+?)\*"/g)].map((m) =>
      m[1].toLowerCase()
    );
    this.filters.push((r) =>
      needles.some((n) =>
        String(r.body_preview ?? "").toLowerCase().includes(n)
      )
    );
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sort = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(a: number, b: number) {
    this.from_ = a;
    this.max = b - a + 1;
    return this;
  }
  maybeSingle() {
    this.single = "maybe";
    return this;
  }
  insert(v: any) {
    this.mode = "insert";
    this.payload = v;
    return this;
  }
  upsert(v: any) {
    this.mode = "upsert";
    this.payload = v;
    return this;
  }
  update(v: any) {
    this.mode = "update";
    this.payload = v;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  then(ok?: (v: { data: any; error: any }) => any, bad?: (e: unknown) => any) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): { data: any; error: any } {
    const fail = this.db.failures[this.table];
    if (fail) return { data: null, error: { message: fail, code: "XX000" } };
    if (this.badFilter) return { data: null, error: this.badFilter };
    const rows = this.db.rows(this.table);
    const pk = PRIMARY_KEYS[this.table];
    if (this.mode === "insert" || this.mode === "upsert") {
      for (const row of [this.payload].flat()) {
        const clash = pk ? rows.find((r) => r[pk] === row[pk]) : null;
        if (clash && this.mode === "insert") {
          return {
            data: null,
            error: { message: "duplicate key", code: "23505" },
          };
        }
        if (clash) Object.assign(clash, row);
        else rows.push({ created_at: this.db.now, ...row });
      }
      return { data: null, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      hit.forEach((r) => Object.assign(r, this.payload));
      return { data: null, error: null };
    }
    if (this.mode === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    if (this.sort) {
      const { col, asc } = this.sort;
      hit = [...hit].sort((a, b) =>
        (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)
      );
    }
    hit = hit.slice(
      this.from_,
      this.max === null ? undefined : this.from_ + this.max,
    );
    if (this.single) return { data: hit[0] ?? null, error: null };
    return { data: hit, error: null };
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  failures: Record<string, string> = {};
  now = "2026-10-13T00:00:00.000Z";
  rows(t: string) {
    return (this.tables[t] ??= []);
  }
  from(t: string) {
    return new Query(this, t);
  }
  rpc(_name: string) {
    return Promise.resolve({ data: this.rows("__quote_values"), error: null });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-13T00:00:00.000Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

function setup(
  opts: {
    move?: boolean;
    sender?: "off" | "dry_run" | "live";
    envLive?: boolean;
    lane?: boolean;
  } = {},
) {
  const db = new FakeDb();
  db.rows("job_closeout_settings").push({
    id: 1,
    get_review_move_enabled: opts.move ?? true,
    review_sender_mode: opts.sender ?? "off",
  });
  const moves: Row[] = [];
  const sms: Row[] = [];
  let smsResult: (n: number) => SmsSendResult | Error = () => ({
    ok: true,
    message_id: "m1",
  });
  const deps: JobCloseoutDeps = {
    client: db,
    now: () => NOW,
    env: (
      k,
    ) => (k === "JOB_REVIEW_SENDING_ENABLED" && opts.envLive !== false
      ? "true"
      : undefined),
    moveJobStatus: (body) => {
      moves.push(body);
      const job = db.rows("jobs").find((j) => j.id === body.jobId);
      const expected = body.expected_statuses as string[] | undefined;
      if (!job || (expected && !expected.includes(job.status))) {
        return Promise.resolve({ success: false, skipped: "status_changed" });
      }
      job.status = body.status;
      db.rows("job_events").push({
        job_id: job.id,
        event_type: "status_changed",
        detail_json: { new_status: body.status },
        created_at: NOW.toISOString(),
      });
      return Promise.resolve({ success: true });
    },
    sendSms: (args) => {
      sms.push(args);
      const r = smsResult(sms.length);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    laneEnabled: () => Promise.resolve(opts.lane ?? true),
  };
  return {
    db,
    deps,
    moves,
    sms,
    setSms: (f: typeof smsResult) => (smsResult = f),
  };
}

function addJob(db: FakeDb, over: Row = {}): Row {
  const job = {
    id: `job-${db.rows("jobs").length + 1}`,
    job_number: "SWF-1",
    type: "fencing",
    status: "invoiced",
    is_callback: false,
    deposit_invoice_id: null,
    client_name: "Pat Owner",
    client_email: null,
    ghl_contact_id: "ghl-owner",
    updated_at: hoursAgo(100),
    ...over,
  };
  db.rows("jobs").push(job);
  return job;
}

function addInvoice(
  db: FakeDb,
  jobId: string,
  reference: string,
  status: string,
  total: number,
  over: Row = {},
) {
  db.rows("xero_invoices").push({
    job_id: jobId,
    xero_invoice_id: `x-${db.rows("xero_invoices").length + 1}`,
    invoice_number: null,
    invoice_type: "ACCREC",
    status,
    reference,
    total,
    amount_paid: status === "PAID" ? total : 0,
    job_contact_id: null,
    xero_contact_id: null,
    fully_paid_on: status === "PAID" ? "2026-10-12" : null,
    first_description: /-(?:FIN|FINBAL|BAL)\d{0,3}$/.test(reference)
      ? "Balance of works"
      : /DEP\d{0,3}$/.test(reference)
      ? "Deposit"
      : null,
    ...over,
  });
}

function paidJob(db: FakeDb, over: Row = {}) {
  const job = addJob(db, over);
  addInvoice(db, job.id, `${job.job_number}-DEP50`, "PAID", 1000);
  addInvoice(db, job.id, `${job.job_number}-FINBAL`, "PAID", 1000);
  return job;
}

function enteredGetReview(db: FakeDb, jobId: string, at: string) {
  db.rows("job_events").push({
    job_id: jobId,
    event_type: "status_changed",
    detail_json: { new_status: "get_review" },
    created_at: at,
  });
}

function addQuote(db: FakeDb, jobId: string, valueInc: number) {
  db.rows("__quote_values").push({
    document_id: `doc-${jobId}`,
    job_contact_id: null,
    party_is_owner: null,
    run_label: null,
    value_inc_gst: valueInc,
    value_source: "quote_revision",
    whole_quote_total_inc: null,
    whole_quote_source: null,
  });
  db.rows("job_documents").push({
    id: `doc-${jobId}`,
    job_id: jobId,
    type: "quote",
    sent_at: "2026-08-01T00:00:00Z",
    accepted_at: "2026-08-02T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
  });
}

// ── Pure pieces ──────────────────────────────────────────────────────────────

Deno.test("the paid review text is the owner's exact wording, signed by job type", () => {
  const body = (first: string, signOff: string) =>
    `Hi ${first},\n\n` +
    "Thank you for trusting us with your recent job!\n" +
    "Payment is well received.\n\n" +
    "We'd love to hear your feedback. If you have a moment, could you leave us a quick review here: https://share.google/AFyfkE7jLfCZcxanV\n\n" +
    "Thank you again for your business!\n\n" +
    `Shaun\n${signOff}`;
  assertEquals(
    reviewRequestMessage("Luke Smith", "fencing", true),
    body("Luke", "SecureWorks Fencing"),
  );
  assertEquals(
    reviewRequestMessage("Luke Smith", "patio", true),
    body("Luke", "SecureWorks Patios"),
  );
  assertEquals(
    reviewRequestMessage(null, "patio", true),
    body("there", "SecureWorks Patios"),
  );
});

Deno.test("the other review text is unchanged byte for byte", () => {
  assertEquals(
    reviewRequestMessage("Jane Citizen", "decking", true),
    "Hi Jane,\n\nThank you for choosing SecureWorks for your recent job!\n\n" +
      "If you were satisfied with our work and the overall experience, we'd greatly appreciate it if you could take a moment to share your feedback. " +
      "Your review helps us continue to provide quality service to our customers. You can leave a review here: https://share.google/AFyfkE7jLfCZcxanV\n\n" +
      "Thank you again for your business!\n\nSecureWorks",
  );
});

Deno.test("the 90-day look-back still recognises the paid review text", () => {
  for (const type of ["fencing", "patio"]) {
    assert(
      reviewRequestMessage("Luke", type, true).includes(
        "share.google/AFyfkE7jLfCZcxanV",
      ),
    );
  }
});

Deno.test("the review text makes no payment claim and signs SecureWorks for other types and unpaid jobs", () => {
  for (
    const [type, paid] of [["decking", true], ["makesafe", true], [
      "fencing",
      false,
    ], ["patio", false]] as const
  ) {
    const message = reviewRequestMessage("Jane Citizen", type, paid);
    assertStringIncludes(
      message,
      "Hi Jane,\n\nThank you for choosing SecureWorks for your recent job!",
    );
    assertStringIncludes(
      message,
      "You can leave a review here: https://share.google/AFyfkE7jLfCZcxanV",
    );
    assert(!message.includes("Payment"), `${type} ${paid}`);
    assert(!message.includes("Fencing"), `${type} ${paid}`);
    assert(
      message.endsWith("Thank you again for your business!\n\nSecureWorks"),
      `${type} ${paid}`,
    );
  }
});

Deno.test("sender mode: the settings row alone decides; live is live", () => {
  assertEquals(effectiveSenderMode("live"), "live");
  assertEquals(effectiveSenderMode("dry_run"), "dry_run");
  assertEquals(effectiveSenderMode("off"), "off");
  assertEquals(effectiveSenderMode("garbage"), "off");
});

Deno.test("quote side: whole-job total wins, then the headline; only agreed variations add, inc GST", () => {
  const variations = [
    { agreed: true, amount: 220, gst_included: true },
    { agreed: true, amount: 100, gst_included: false },
    { agreed: false, amount: 200, gst_included: true },
    { agreed: false, amount: 999, gst_included: true },
  ];
  assertEquals(
    quoteForCloseout({
      status: "accepted",
      whole_quote_total: { value_inc_gst: 8000, source: "x" },
      headline: { value_inc_gst: 4000 } as any,
    }, variations),
    { quote_total_inc: 8000, variations_inc: 330, unknown_reason: null },
  );
  assertEquals(
    quoteForCloseout({
      status: "accepted",
      whole_quote_total: null,
      headline: { value_inc_gst: 4000 } as any,
    }, []).quote_total_inc,
    4000,
  );
  assertEquals(quoteForCloseout(null, []).unknown_reason, "quote_unreadable");
  assertEquals(
    quoteForCloseout({
      status: "none_recorded",
      whole_quote_total: null,
      headline: null,
    }, []).unknown_reason,
    "no_sent_quote",
  );
  assertEquals(
    quoteForCloseout({
      status: "accepted",
      whole_quote_total: null,
      headline: { value_inc_gst: 4000 } as any,
    }, null).unknown_reason,
    "variations_unreadable",
  );
});

// ── Paid -> Get Review ───────────────────────────────────────────────────────

Deno.test("switch off: the paid hook does nothing", async () => {
  const { db, deps, moves } = setup({ move: false });
  const job = paidJob(db);
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: job.id })).action,
    "switch_off",
  );
  assertEquals(moves.length, 0);
});

Deno.test("a paid fencing job moves to get_review with compare and set from complete, final payment or invoiced", async () => {
  for (const status of ["complete", "final_payment", "invoiced"]) {
    const { db, deps, moves } = setup();
    const job = paidJob(db, { status });
    const out = await closeoutOnPaid(deps, {
      job_id: job.id,
      source: "xero_sync",
    });
    assertEquals(out.action, "moved", status);
    assertEquals(moves[0], {
      jobId: job.id,
      status: "get_review",
      source: "xero_sync",
      expected_statuses: ["complete", "final_payment", "invoiced"],
    });
    assertEquals(db.rows("job_closeout_state")[0].outcome, "paid");
  }
});

Deno.test("make-safe, repair and other types are never touched", async () => {
  for (const type of ["makesafe", "repair", "insurance", "decking"]) {
    const { db, deps, moves } = setup();
    const job = paidJob(db, { type });
    assertEquals(
      (await closeoutOnPaid(deps, { job_id: job.id })).action,
      "not_closeout_type",
      type,
    );
    assertEquals(moves.length, 0);
    assertEquals(db.rows("job_closeout_state").length, 0);
  }
});

Deno.test("held jobs never move: callback, and rectification", async () => {
  const { db, deps, moves } = setup();
  const callback = paidJob(db, { is_callback: true });
  const rect = paidJob(db, { status: "rectification" });
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: callback.id })).action,
    "held",
  );
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: rect.id })).action,
    "held",
  );
  assertEquals(moves.length, 0);
});

Deno.test("a job outside complete, final payment and invoiced is left alone", async () => {
  const { db, deps, moves } = setup();
  const job = paidJob(db, { status: "archived" });
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: job.id })).action,
    "not_in_from_status",
  );
  assertEquals(moves.length, 0);
});

Deno.test("SWF-261335 shape: unbilled neighbour -> not paid, the card stays", async () => {
  const { db, deps, moves } = setup();
  const job = addJob(db, { job_number: "SWF-261335" });
  addInvoice(db, job.id, "DEP50", "PAID", 1018);
  db.rows("job_contacts").push(
    {
      id: "pa",
      job_id: job.id,
      contact_label: "A",
      is_primary: true,
      share_percentage: 100,
      removed_at: null,
    },
    {
      id: "pb",
      job_id: job.id,
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
    },
  );
  const out = await closeoutOnPaid(deps, { job_id: job.id });
  assertEquals(out.action, "not_paid");
  assertEquals(moves.length, 0);
  assertEquals(db.rows("job_closeout_state")[0].outcome, "not_paid");
});

Deno.test("paid less than quoted: the card stays and carries the marker, logged once", async () => {
  const { db, deps, moves } = setup();
  const job = paidJob(db);
  addQuote(db, job.id, 5000);
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: job.id })).action,
    "paid_less_than_quoted",
  );
  await closeoutOnPaid(deps, { job_id: job.id });
  assertEquals(moves.length, 0);
  const state = db.rows("job_closeout_state")[0];
  assertEquals([
    state.outcome,
    state.paid_less_than_quoted,
    state.shortfall_inc,
  ], ["paid_less_than_quoted", true, 3000]);
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.event_type === "closeout_paid_less_than_quoted"
    ).length,
    1,
  );
});

Deno.test("a card paid over 30 days ago is the backlog in every from-status: it never moves and is never texted", async () => {
  for (const status of ["complete", "final_payment", "invoiced"]) {
    const { db, deps, moves, sms } = setup({ sender: "live" });
    const job = addJob(db, { status, job_number: "SWF-50" });
    addInvoice(db, job.id, "SWF-50-FINBAL", "PAID", 1000, {
      fully_paid_on: "2026-09-01",
    });
    const out = await closeoutOnPaid(deps, { job_id: job.id });
    assertEquals(out.action, "stale_payment", status);
    assertEquals([moves.length, sms.length, job.status], [0, 0, status]);
    assertEquals(db.rows("job_review_claims").length, 0);
  }
});

Deno.test("a card paid within 30 days moves from every from-status", async () => {
  for (const status of ["complete", "final_payment", "invoiced"]) {
    const { db, deps } = setup();
    const job = addJob(db, { status });
    addInvoice(db, job.id, "SWF-1-FINBAL", "PAID", 1000, {
      fully_paid_on: "2026-09-14",
    });
    assertEquals(
      (await closeoutOnPaid(deps, { job_id: job.id })).action,
      "moved",
      status,
    );
    assertEquals(job.status, "get_review");
  }
});

Deno.test("a card moved by hand meanwhile is left alone (compare and set)", async () => {
  const { db, deps } = setup();
  const job = paidJob(db);
  deps.moveJobStatus = () =>
    Promise.resolve({ success: false, skipped: "status_changed" });
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: job.id })).action,
    "move_skipped",
  );
});

Deno.test("catch-up: an invoiced card paid recently moves; one paid long ago is left for a person", async () => {
  const { db, deps, moves } = setup();
  const recent = paidJob(db, { job_number: "SWF-10" });
  const old = addJob(db, { job_number: "SWF-11", status: "final_payment" });
  addInvoice(db, old.id, "SWF-11-FINBAL", "PAID", 1000, {
    fully_paid_on: "2026-01-16",
  });
  const complete = paidJob(db, { job_number: "SWF-12", status: "complete" });
  const out = await closeoutCatchUp(deps, {});
  assertEquals(moves.map((m) => m.jobId), [recent.id]);
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob["SWF-11"], "stale_payment");
  assertEquals(
    byJob["SWF-12"],
    undefined,
    "complete cards are the backlog, never caught up",
  );
  assertEquals(complete.status, "complete");
});

Deno.test("catch-up reads every candidate card, so stuck unpaid cards never hide a newly paid one", async () => {
  const { db, deps, moves } = setup();
  for (let i = 0; i < 600; i++) {
    const stuck = addJob(db, {
      job_number: `SWF-S${i}`,
      updated_at: hoursAgo(5000),
    });
    addInvoice(db, stuck.id, `SWF-S${i}-FINBAL`, "AUTHORISED", 100);
  }
  const fresh = paidJob(db, {
    job_number: "SWF-FRESH",
    updated_at: hoursAgo(1),
  });
  const out = await closeoutCatchUp(deps, {});
  assertEquals(out.checked, 601);
  assertEquals(moves.map((m) => m.jobId), [fresh.id]);
});

// ── The review sender ────────────────────────────────────────────────────────

function reviewJob(db: FakeDb, over: Row = {}) {
  const job = paidJob(db, { status: "get_review", ...over });
  enteredGetReview(db, job.id, hoursAgo(1));
  return job;
}

Deno.test("sender off: nothing read beyond the switch, nothing written", async () => {
  const { db, deps, sms } = setup({ sender: "off" });
  const job = reviewJob(db);
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sender_off",
  );
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_review_claims").length, 0);
});

Deno.test("dry run: one would-send log per job, no claim, no text", async () => {
  const { db, deps, sms } = setup({ sender: "dry_run" });
  const job = reviewJob(db);
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "dry_run",
  );
  await requestJobReview(deps, { job_id: job.id, trigger: "t" });
  const logs = db.rows("job_events").filter((e) =>
    e.event_type === "review_request_dry_run"
  );
  assertEquals(logs.length, 1);
  assertEquals(logs[0].detail_json.recipients, [{
    label: "owner",
    ghl_contact_id: "ghl-owner",
    would: "send",
  }]);
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_review_claims").length, 0);
});

Deno.test("live in the settings row sends with the env unset: the database switch alone decides", async () => {
  const { db, deps, sms } = setup({ sender: "live", envLive: false });
  const job = reviewJob(db);
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
  assertEquals(sms.length, 1);
});

Deno.test("dry_run never sends, even with the old env set", async () => {
  const { db, deps, sms } = setup({ sender: "dry_run", envLive: true });
  const job = reviewJob(db);
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "dry_run",
  );
  assertEquals(sms.length, 0);
});

Deno.test("live: every paying owner is texted once, a contact asked in the last 90 days is skipped, the job is claimed", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = addJob(db, { status: "get_review", job_number: "SWF-20" });
  enteredGetReview(db, job.id, hoursAgo(1));
  db.rows("job_contacts").push(
    {
      id: "pa",
      job_id: job.id,
      contact_label: "A",
      is_primary: true,
      share_percentage: 50,
      removed_at: null,
      client_name: "Alex Owner",
      ghl_contact_id: null,
    },
    {
      id: "pb",
      job_id: job.id,
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      client_name: "Bo Neighbour",
      ghl_contact_id: "ghl-b",
    },
    {
      id: "pc",
      job_id: job.id,
      contact_label: "C",
      is_primary: false,
      share_percentage: 25,
      removed_at: null,
      client_name: "Cy Neighbour",
      ghl_contact_id: "ghl-c",
    },
    {
      id: "pd",
      job_id: job.id,
      contact_label: "D",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      status: "removed",
      client_name: "Di Pulledout",
      ghl_contact_id: "ghl-d",
    },
  );
  for (
    const [ref, cid] of [["SWF-20-DEP50", null], ["SWF-20-FINBAL", null], [
      "SWF-20-B-FINBAL",
      "pb",
    ], ["SWF-20-C-FINBAL", "pc"]]
  ) {
    addInvoice(db, job.id, ref as string, "PAID", 500, { job_contact_id: cid });
  }
  db.rows("business_events").push({
    contact_id: "ghl-c",
    direction: "outbound",
    occurred_at: hoursAgo(24 * 30),
    body_preview:
      "Hi Cy, ... You can leave a review here: https://share.google/AFyfkE7jLfCZcxanV",
  });
  const out = await requestJobReview(deps, { job_id: job.id, trigger: "t" });
  assertEquals(out.action, "sent");
  assertEquals(sms.map((s) => s.contactId), ["ghl-owner", "ghl-b"]);
  assertStringIncludes(sms[0].message, "Hi Alex,");
  assertStringIncludes(sms[1].message, "Hi Bo,");
  const claim = db.rows("job_review_claims")[0];
  assertEquals(claim.status, "sent");
  assertEquals(claim.recipients.map((r: Row) => [r.label, r.result]), [
    ["A", "sent"],
    ["B", "sent"],
    ["C", "skipped_asked_recently"],
  ]);
  // Never twice: a second request is refused by the claim.
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "again" })).action,
    "already_claimed",
  );
  assertEquals(sms.length, 2);
});

Deno.test("a contact our own claim texted on another job in the last 90 days is skipped", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db);
  db.rows("job_review_claims").push({
    job_id: "other-job",
    status: "sent",
    claimed_at: hoursAgo(48),
    recipients: [{
      label: "owner",
      ghl_contact_id: "ghl-owner",
      result: "sent",
    }],
  });
  const out = await requestJobReview(deps, { job_id: job.id, trigger: "t" });
  assertEquals(out.action, "skipped");
  assertEquals(out.reason, "asked_recently");
  assertEquals(sms.length, 0);
});

Deno.test("re-checked at send time: not in get_review, held, or not paid -> no claim, no text", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const invoiced = paidJob(db, { status: "invoiced" });
  const callback = reviewJob(db, { is_callback: true });
  const unpaid = addJob(db, { status: "get_review", job_number: "SWF-26989" });
  addInvoice(db, unpaid.id, "SWF-26989-DEP50", "PAID", 2186.25);
  addInvoice(db, unpaid.id, "SWF-26989-FINBAL50", "AUTHORISED", 2433.75);
  assertEquals(
    (await requestJobReview(deps, { job_id: invoiced.id, trigger: "t" }))
      .action,
    "not_in_get_review",
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: callback.id, trigger: "t" }))
      .action,
    "held",
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: unpaid.id, trigger: "t" })).action,
    "not_paid",
  );
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_review_claims").length, 0);
});

Deno.test("a card paid within 30 days entering get_review is texted, even when paid weeks before it got there", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = addJob(db, { status: "get_review" });
  addInvoice(db, job.id, "SWF-1-FINBAL", "PAID", 1000, {
    fully_paid_on: "2026-09-20",
  });
  enteredGetReview(db, job.id, hoursAgo(1));
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
  assertEquals(sms.length, 1);
});

Deno.test("a card paid over 30 days ago is not texted and not claimed, so a manual Send review still works", async () => {
  for (const entered of ["2026-09-02T00:00:00.000Z", hoursAgo(1)]) {
    const { db, deps, sms } = setup({ sender: "live" });
    const job = addJob(db, { status: "get_review" });
    addInvoice(db, job.id, "SWF-1-FINBAL", "PAID", 1000, {
      fully_paid_on: "2026-09-01",
    });
    enteredGetReview(db, job.id, entered);
    const out = await requestJobReview(deps, { job_id: job.id, trigger: "t" });
    assertEquals(out.action, "paid_too_long_ago", entered);
    assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
    assertEquals(
      (await requestJobReview(deps, {
        job_id: job.id,
        trigger: "manual",
        manual: true,
      })).action,
      "sent",
    );
    assertEquals(sms.length, 1);
  }
});

Deno.test("no linked contact claims nothing, so linking it and asking again sends exactly once", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db, { ghl_contact_id: null });
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "no_contact",
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "no_contact",
  );
  assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
  job.ghl_contact_id = "ghl-linked";
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "already_claimed",
  );
  assertEquals(sms.map((s) => s.contactId), ["ghl-linked"]);
});

Deno.test("no linked contact on a manual request claims nothing either", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = addJob(db, { status: "archived", ghl_contact_id: null });
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "manual",
      manual: true,
    })).action,
    "no_contact",
  );
  assertEquals(db.rows("job_review_claims").length, 0);
  job.ghl_contact_id = "ghl-linked";
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "manual",
      manual: true,
    })).action,
    "sent",
  );
  assertEquals(sms.length, 1);
});

Deno.test("every send refused by a guard keeps no claim and logs once, so a later attempt sends exactly once", async () => {
  const { db, deps, sms, setSms } = setup({ sender: "live" });
  const job = reviewJob(db);
  setSms(() => ({ ok: false, refused: true, error: "contact not on job" }));
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "refused",
  );
  assertEquals(db.rows("job_review_claims").length, 0);
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.event_type === "review_request_not_sent"
    ).map((e) => e.detail_json.status),
    ["refused"],
  );
  for (let i = 0; i < 3; i++) {
    assertEquals(
      (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
      "refused",
    );
  }
  assertEquals(db.rows("job_review_claims").length, 0);
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.event_type === "review_request_not_sent"
    ).length,
    1,
    "a repeated refusal logs once",
  );
  setSms(() => ({ ok: true, message_id: "m2" }));
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
  assertEquals(
    db.rows("job_events").filter((e) => e.event_type === "review_request_sent")
      .length,
    1,
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "already_claimed",
  );
  assertEquals(sms.length, 5);
  assertEquals(db.rows("job_review_claims")[0].status, "sent");
});

Deno.test("a send confirmed for one owner keeps the claim even when another owner's send was refused", async () => {
  const { db, deps, setSms } = setup({ sender: "live" });
  const job = reviewJob(db);
  db.rows("job_contacts").push(
    {
      id: "p-a",
      job_id: job.id,
      contact_label: "A",
      is_primary: true,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      xero_contact_id: null,
      client_name: "Pat",
      ghl_contact_id: "ghl-a",
    },
    {
      id: "p-b",
      job_id: job.id,
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      xero_contact_id: null,
      client_name: "Sam",
      ghl_contact_id: "ghl-b",
    },
  );
  for (const share of ["A", "B"]) {
    addInvoice(db, job.id, `SWF-1-${share}-FINBAL`, "PAID", 500);
  }
  setSms((n) =>
    n === 1
      ? { ok: true, message_id: "m1" }
      : { ok: false, refused: true, error: "contact not on job" }
  );
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
  assertEquals(db.rows("job_review_claims")[0].status, "sent");
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "already_claimed",
  );
});

Deno.test("an unconfirmed send finishes the claim and is never retried", async () => {
  const lost = setup({ sender: "live" });
  const b = reviewJob(lost.db);
  lost.setSms(() => new Error("network"));
  assertEquals(
    (await requestJobReview(lost.deps, { job_id: b.id, trigger: "t" })).action,
    "unconfirmed",
  );
  assertEquals(
    (await requestJobReview(lost.deps, { job_id: b.id, trigger: "t" })).action,
    "already_claimed",
  );
  assertEquals(lost.sms.length, 1);
});

Deno.test("an unreadable look-back claims nothing, so the next sweep tries again", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db);
  db.failures.business_events = "boom";
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "lookback_unreadable",
  );
  assertEquals(db.rows("job_review_claims").length, 0);
  assertEquals(sms.length, 0);
});

Deno.test("manual send_review_request obeys the sender switch, skips the paid and status checks, claims, never doubles", async () => {
  const off = setup({ sender: "off" });
  const offJob = addJob(off.db, { status: "archived" });
  assertEquals(
    (await requestJobReview(off.deps, {
      job_id: offJob.id,
      trigger: "manual",
      manual: true,
    })).action,
    "sender_off",
  );
  assertEquals(off.sms.length, 0);
  const { db, deps, sms } = setup({ sender: "live" });
  const job = addJob(db, { status: "archived" });
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "manual",
      manual: true,
    })).action,
    "sent",
  );
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "manual",
      manual: true,
    })).action,
    "already_claimed",
  );
  assertEquals(sms.length, 1);
});

Deno.test("manual send_review_request says payment was received only on a paid fencing or patio job", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const paidFence = paidJob(db, {
    status: "archived",
    ghl_contact_id: "ghl-1",
  });
  const unpaidFence = addJob(db, {
    status: "invoiced",
    ghl_contact_id: "ghl-2",
  });
  addInvoice(db, unpaidFence.id, "SWF-1-FINBAL", "AUTHORISED", 1000);
  const decking = paidJob(db, {
    type: "decking",
    status: "complete",
    ghl_contact_id: "ghl-3",
  });
  for (const job of [paidFence, unpaidFence, decking]) {
    assertEquals(
      (await requestJobReview(deps, {
        job_id: job.id,
        trigger: "manual",
        manual: true,
      })).action,
      "sent",
    );
  }
  assert(sms[0].message.endsWith("Shaun\nSecureWorks Fencing"));
  assertStringIncludes(sms[0].message, "Payment is well received.");
  for (const message of [sms[1].message, sms[2].message]) {
    assert(!message.includes("Payment"));
    assert(
      message.endsWith("Thank you again for your business!\n\nSecureWorks"),
    );
  }
});

Deno.test("an unreadable quote decides nothing: no move, no record, no text, no claim, no archive, not on the backlog list", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  const invoiced = paidJob(db, { job_number: "SWF-80" });
  const review = paidJob(db, { job_number: "SWF-81", status: "get_review" });
  enteredGetReview(db, review.id, hoursAgo(30));
  const complete = paidJob(db, { job_number: "SWF-82", status: "complete" });
  db.failures.job_documents = "boom";

  assertEquals(
    (await closeoutOnPaid(deps, { job_id: invoiced.id })).action,
    "facts_unreadable",
  );
  assertEquals(
    (await closeoutCatchUp(deps, {})).results?.map((r: any) => r.action),
    ["facts_unreadable"],
  );
  assertEquals(invoiced.status, "invoiced");
  assertEquals(db.rows("job_closeout_state").length, 0);

  assertEquals(
    (await requestJobReview(deps, { job_id: review.id, trigger: "t" })).action,
    "facts_unreadable",
  );
  assertEquals(
    (await requestJobReview(deps, {
      job_id: complete.id,
      trigger: "manual",
      manual: true,
    })).action,
    "facts_unreadable",
  );

  const sweep = await closeoutSweep(deps, { dry_run: false });
  assertEquals(
    sweep.results?.map((r: any) => [r.job_number, r.action]),
    [["SWF-81", "undecided"]],
  );
  const backlog = await closeoutBacklogPreview(deps);
  assertEquals(backlog.would_archive_count, 0);
  assertEquals(backlog.excluded, { quote_unreadable: ["SWF-82"] });

  assertEquals([moves.length, sms.length], [0, 0]);
  assertEquals(db.rows("job_review_claims").length, 0);
  assertEquals(db.rows("job_closeout_state").length, 0);

  delete db.failures.job_documents;
  assertEquals(
    (await closeoutOnPaid(deps, { job_id: invoiced.id })).action,
    "moved",
  );
});

Deno.test("an unlabelled paid invoice is not a final, so the card stays where it is", async () => {
  const { db, deps, moves } = setup();
  const job = addJob(db, { job_number: "SWF-26624" });
  addInvoice(db, job.id, "SWF-26624", "PAID", 2000, {
    first_description: "Deposit 50%",
  });
  const out = await closeoutOnPaid(deps, { job_id: job.id });
  assertEquals(out.action, "not_paid");
  assertEquals((out as any).detail, ["party_without_paid_final:owner"]);
  assertEquals([moves.length, job.status], [0, "invoiced"]);
});

// ── The 24-hour archive sweep ────────────────────────────────────────────────

Deno.test("sweep: unreadable switches archive nothing on a live run", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  const job = paidJob(db, { status: "get_review" });
  enteredGetReview(db, job.id, hoursAgo(30));
  db.failures.job_closeout_settings = "boom";
  assertEquals(await closeoutSweep(deps, { dry_run: false }), {
    ok: false,
    ran: false,
    reason: "switches_unreadable",
  });
  assertEquals([moves.length, sms.length, job.status], [0, 0, "get_review"]);
});

Deno.test("sweep: lane off archives nothing", async () => {
  const { db, deps, moves } = setup({ lane: false });
  const job = reviewJob(db);
  enteredGetReview(db, job.id, hoursAgo(30));
  assertEquals(
    (await closeoutSweep(deps, { dry_run: false })).reason,
    "lane_off",
  );
  assertEquals(moves.length, 0);
});

Deno.test("sweep: archives after 24 hours once paid, not held and the review is done; compare and set on get_review", async () => {
  const { db, deps, moves } = setup({ sender: "live" });
  const ready = paidJob(db, { status: "get_review", job_number: "SWF-30" });
  enteredGetReview(db, ready.id, hoursAgo(30));
  db.rows("job_review_claims").push({
    job_id: ready.id,
    status: "sent",
    recipients: [],
  });
  const young = paidJob(db, { status: "get_review", job_number: "SWF-31" });
  enteredGetReview(db, young.id, hoursAgo(2));
  db.rows("job_review_claims").push({
    job_id: young.id,
    status: "sent",
    recipients: [],
  });
  const unpaid = addJob(db, { status: "get_review", job_number: "SWF-26989" });
  addInvoice(db, unpaid.id, "SWF-26989-FINBAL50", "AUTHORISED", 2433.75);
  enteredGetReview(db, unpaid.id, hoursAgo(90));
  const held = paidJob(db, {
    status: "get_review",
    job_number: "SWF-33",
    is_callback: true,
  });
  enteredGetReview(db, held.id, hoursAgo(90));
  const inFlight = paidJob(db, { status: "get_review", job_number: "SWF-34" });
  enteredGetReview(db, inFlight.id, hoursAgo(90));
  db.rows("job_review_claims").push({
    job_id: inFlight.id,
    status: "claimed",
    claimed_at: hoursAgo(0.5),
    recipients: [],
  });

  const out = await closeoutSweep(deps, { dry_run: false });
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob, {
    "SWF-30": "archived",
    "SWF-31": "waiting_24h",
    "SWF-26989": "not_paid",
    "SWF-33": "held",
    "SWF-34": "waiting_for_review",
  });
  assertEquals(moves, [{
    jobId: ready.id,
    status: "archived",
    source: "job_closeout_sweep",
    expected_statuses: ["get_review"],
  }]);
});

Deno.test("sweep: a paid card with no linked contact archives after 24 hours with no claim, so Send review still works later", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  const young = paidJob(db, {
    status: "get_review",
    job_number: "SWF-60",
    ghl_contact_id: null,
  });
  enteredGetReview(db, young.id, hoursAgo(2));
  const old = paidJob(db, {
    status: "get_review",
    job_number: "SWF-61",
    ghl_contact_id: null,
  });
  enteredGetReview(db, old.id, hoursAgo(25));
  const out = await closeoutSweep(deps, { dry_run: false });
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob, { "SWF-60": "waiting_24h", "SWF-61": "archived" });
  assertEquals(moves.map((m) => m.jobId), [old.id]);
  assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
  old.ghl_contact_id = "ghl-linked";
  assertEquals(
    (await requestJobReview(deps, {
      job_id: old.id,
      trigger: "manual",
      manual: true,
    })).action,
    "sent",
  );
  assertEquals(sms.map((s) => s.contactId), ["ghl-linked"]);
});

Deno.test("sweep: a card paid over 30 days ago or whose sends were all refused archives after 24 hours with no claim", async () => {
  const { db, deps, moves, sms, setSms } = setup({ sender: "live" });
  const stale = addJob(db, { status: "get_review", job_number: "SWF-70" });
  addInvoice(db, stale.id, "SWF-70-FINBAL", "PAID", 1000, {
    fully_paid_on: "2026-09-01",
  });
  enteredGetReview(db, stale.id, hoursAgo(25));
  const refused = paidJob(db, { status: "get_review", job_number: "SWF-71" });
  enteredGetReview(db, refused.id, hoursAgo(25));
  const young = paidJob(db, { status: "get_review", job_number: "SWF-72" });
  enteredGetReview(db, young.id, hoursAgo(2));
  setSms(() => ({ ok: false, refused: true, error: "contact not on job" }));
  const out = await closeoutSweep(deps, { dry_run: false });
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob, {
    "SWF-70": "archived",
    "SWF-71": "archived",
    "SWF-72": "waiting_24h",
  });
  assertEquals(moves.map((m) => m.jobId), [stale.id, refused.id]);
  assertEquals(db.rows("job_review_claims").length, 0);
  assertEquals(sms.length, 2);
});

Deno.test("sweep: the backstop sends a missing review before archiving; with the sender off it archives without one", async () => {
  const live = setup({ sender: "live" });
  const a = paidJob(live.db, { status: "get_review" });
  live.db.rows("job_events").push({
    job_id: a.id,
    event_type: "status_changed",
    detail_json: { new_status: "get_review" },
    created_at: hoursAgo(25),
  });
  await closeoutSweep(live.deps, { dry_run: false });
  assertEquals(live.sms.length, 1);
  assertEquals(a.status, "archived");

  const off = setup({ sender: "off" });
  const b = paidJob(off.db, { status: "get_review" });
  enteredGetReview(off.db, b.id, hoursAgo(25));
  await closeoutSweep(off.deps, { dry_run: false });
  assertEquals(off.sms.length, 0);
  assertEquals(b.status, "archived");
});

Deno.test("sweep reads every get_review card, so stuck unpaid cards never hold back an archive", async () => {
  const { db, deps } = setup({ sender: "off" });
  for (let i = 0; i < 600; i++) {
    const stuck = addJob(db, {
      status: "get_review",
      job_number: `SWF-S${i}`,
      updated_at: hoursAgo(5000),
    });
    addInvoice(db, stuck.id, `SWF-S${i}-FINBAL`, "AUTHORISED", 100);
    enteredGetReview(db, stuck.id, hoursAgo(5000));
  }
  const ready = paidJob(db, {
    status: "get_review",
    job_number: "SWF-READY",
    updated_at: hoursAgo(30),
  });
  enteredGetReview(db, ready.id, hoursAgo(30));
  const out = await closeoutSweep(deps, { dry_run: false });
  assertEquals(out.checked, 601);
  assertEquals(ready.status, "archived");
});

Deno.test("sweep: a claim stuck in claimed for over an hour is recorded unconfirmed, never re-sent, and the card archives", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  const stuck = paidJob(db, { status: "get_review", job_number: "SWF-35" });
  enteredGetReview(db, stuck.id, hoursAgo(30));
  db.rows("job_review_claims").push({
    job_id: stuck.id,
    status: "claimed",
    claimed_at: hoursAgo(2),
    recipients: [],
  });
  const dry = await closeoutSweep(deps, {});
  assertEquals(dry.results?.map((r: any) => r.action), ["would_archive"]);
  assertEquals(db.rows("job_review_claims")[0].status, "claimed");

  const out = await closeoutSweep(deps, { dry_run: false });
  assertEquals(out.results?.map((r: any) => r.action), ["archived"]);
  const claim = db.rows("job_review_claims")[0];
  assertEquals([claim.status, claim.reason], ["unconfirmed", "stuck_claim"]);
  assert(claim.finished_at);
  assertEquals([sms.length, moves.length], [0, 1]);
});

Deno.test("the ghl-proxy sender: a send that does not answer in time is unconfirmed, a 4xx is refused", async () => {
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
      );
    });
  const slow = ghlProxyReviewSender({
    supabaseUrl: "https://x",
    serviceKey: "k",
    fetch: hang,
    timeoutMs: 10,
  });
  assertEquals(
    await slow({ contactId: "c", message: "m", jobId: "j" }),
    { ok: false, refused: false, error: "timeout" },
  );

  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db);
  deps.sendSms = slow;
  const out = await requestJobReview(deps, { job_id: job.id, trigger: "t" });
  assertEquals(out.action, "unconfirmed");
  assertEquals(db.rows("job_review_claims")[0].status, "unconfirmed");
  assertEquals(sms.length, 0);

  const answer = (status: number, body: unknown): typeof fetch => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const args = { contactId: "c", message: "m", jobId: "j" };
  assertEquals(
    await ghlProxyReviewSender({
      supabaseUrl: "https://x",
      serviceKey: "k",
      fetch: answer(400, { error: "contact not on job" }),
    })(args),
    { ok: false, refused: true, error: "contact not on job" },
  );
  assertEquals(
    await ghlProxyReviewSender({
      supabaseUrl: "https://x",
      serviceKey: "k",
      fetch: answer(200, { success: true, messageId: "m1" }),
    })(args),
    { ok: true, message_id: "m1" },
  );
});

Deno.test("sweep dry run (the default): reports would_archive and writes nothing", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live", lane: false });
  const job = paidJob(db, { status: "get_review" });
  enteredGetReview(db, job.id, hoursAgo(30));
  const claimed = paidJob(db, { status: "get_review" });
  enteredGetReview(db, claimed.id, hoursAgo(30));
  db.rows("job_review_claims").push({
    job_id: claimed.id,
    status: "skipped",
    recipients: [],
  });
  const out = await closeoutSweep(deps, {});
  assertEquals(out.results?.map((r: any) => r.action), [
    "would_send_review_then_archive",
    "would_archive",
  ]);
  assertEquals(
    [moves.length, sms.length, db.rows("job_closeout_state").length],
    [0, 0, 0],
  );
});

// ── The Complete backlog list ────────────────────────────────────────────────

Deno.test("backlog: lists only fully paid fencing and patio jobs in complete, writes nothing, texts nobody", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  paidJob(db, { status: "complete", job_number: "SWF-40" });
  paidJob(db, { status: "complete", job_number: "SWP-41", type: "patio" });
  paidJob(db, { status: "complete", job_number: "SWMS-42", type: "makesafe" });
  paidJob(db, { status: "complete", job_number: "SWF-43", is_callback: true });
  addJob(db, { status: "complete", job_number: "SWF-44" });
  const short = paidJob(db, { status: "complete", job_number: "SWF-45" });
  addQuote(db, short.id, 9000);
  const unpaid = addJob(db, { status: "complete", job_number: "SWF-46" });
  addInvoice(db, unpaid.id, "SWF-46-FINBAL", "AUTHORISED", 100);
  const eventsBefore = db.rows("job_events").length;

  const out = await closeoutBacklogPreview(deps);
  assertEquals(out.dry_run, true);
  assertEquals((out.would_archive as Row[]).map((r) => r.job_number), [
    "SWF-40",
    "SWP-41",
  ]);
  assertEquals(out.excluded, {
    held_callback: ["SWF-43"],
    no_invoices: ["SWF-44"],
    paid_less_than_quoted: ["SWF-45"],
    not_paid: ["SWF-46"],
  });
  assertEquals([
    moves.length,
    sms.length,
    db.rows("job_closeout_state").length,
    db.rows("job_events").length - eventsBefore,
  ], [0, 0, 0, 0]);
});

// ── Doors ────────────────────────────────────────────────────────────────────

Deno.test("doors: only the server key moves, sweeps or catches up; the backlog list also admits staff", async () => {
  const { deps } = setup();
  for (
    const action of [
      "job_closeout_paid",
      "job_closeout_catch_up",
      "job_closeout_sweep",
    ]
  ) {
    assertEquals(
      (await runJobCloseoutAction(action, "POST", {}, { kind: "staff" }, deps))
        .status,
      403,
      action,
    );
    assertEquals(
      (await runJobCloseoutAction(action, "POST", {}, { kind: "none" }, deps))
        .status,
      403,
      action,
    );
    assertEquals(
      (await runJobCloseoutAction(action, "GET", {}, { kind: "server" }, deps))
        .status,
      405,
      action,
    );
  }
  assertEquals(
    (await runJobCloseoutAction("job_closeout_backlog_preview", "GET", {}, {
      kind: "none",
    }, deps)).status,
    403,
  );
  assertEquals(
    (await runJobCloseoutAction("job_closeout_backlog_preview", "GET", {}, {
      kind: "staff",
    }, deps)).status,
    200,
  );
  assertEquals(
    (await runJobCloseoutAction("job_closeout_paid", "POST", {}, {
      kind: "server",
    }, deps)).status,
    400,
  );
});

// ── The per-job review switch (captain, 20 Oct 2026) ─────────────────────────

function optedOut(job: Row, by = "shaun@secureworkswa.com.au") {
  job.review_opt_out = true;
  job.review_opt_out_at = hoursAgo(30);
  job.review_opt_out_by = by;
}

Deno.test("review switch: by default the Get Review text still goes out", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db, { review_opt_out: false });
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "status_changed:x",
    }))
      .action,
    "sent",
  );
  assertEquals(sms.length, 1);
  // A job row that predates the column (no key at all) sends too.
  const older = setup({ sender: "live" });
  const legacy = reviewJob(older.db);
  assertEquals("review_opt_out" in legacy, false);
  assertEquals(
    (await requestJobReview(older.deps, { job_id: legacy.id, trigger: "t" }))
      .action,
    "sent",
  );
});

Deno.test("review switch: the Get Review hook skips an opted-out job: no text, no claim, one event", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db);
  optedOut(job);
  for (let i = 0; i < 2; i++) {
    assertEquals(
      (await requestJobReview(deps, {
        job_id: job.id,
        trigger: "status_changed:xero_sync",
      })).action,
      "opted_out",
    );
  }
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_review_claims").length, 0);
  const events = db.rows("job_events").filter((e) =>
    e.event_type === "review_request_not_sent"
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].detail_json.status, "opted_out");
  assertEquals(
    events[0].detail_json.opted_out.by,
    "shaun@secureworkswa.com.au",
  );
});

Deno.test("review switch: a dry run logs the opt-out on its would-send row and sends nothing", async () => {
  const { db, deps, sms } = setup({ sender: "dry_run" });
  const job = reviewJob(db);
  optedOut(job);
  const out = await requestJobReview(deps, { job_id: job.id, trigger: "t" });
  assertEquals([out.action, out.dry_run], ["opted_out", true]);
  const logs = db.rows("job_events").filter((e) =>
    e.event_type === "review_request_dry_run"
  );
  assertEquals(logs.length, 1);
  assertEquals(logs[0].detail_json.skip_reason, "opted_out");
  assertEquals(logs[0].detail_json.recipients, [{
    label: "owner",
    ghl_contact_id: "ghl-owner",
    would: "skipped_opted_out",
  }]);
  assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
});

Deno.test("review switch: the sweep sends nothing for an opted-out card and still archives it after 24 hours", async () => {
  const { db, deps, moves, sms } = setup({ sender: "live" });
  const old = paidJob(db, { status: "get_review", job_number: "SWF-80" });
  optedOut(old);
  enteredGetReview(db, old.id, hoursAgo(25));
  const young = paidJob(db, { status: "get_review", job_number: "SWF-81" });
  optedOut(young);
  enteredGetReview(db, young.id, hoursAgo(2));
  const sends = paidJob(db, { status: "get_review", job_number: "SWF-82" });
  enteredGetReview(db, sends.id, hoursAgo(25));
  const out = await closeoutSweep(deps, { dry_run: false });
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob, {
    "SWF-80": "archived",
    "SWF-81": "waiting_24h",
    "SWF-82": "archived",
  });
  assertEquals(moves.map((m) => m.jobId), [old.id, sends.id]);
  // Only the job left on is texted and claimed.
  assertEquals(sms.length, 1);
  assertEquals(db.rows("job_review_claims").map((c) => c.job_id), [sends.id]);
  // A second sweep writes no second opt-out event for the waiting card.
  await closeoutSweep(deps, { dry_run: false });
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.job_id === young.id && e.detail_json?.status === "opted_out"
    ).length,
    1,
  );
  assertEquals(sms.length, 1);
});

Deno.test("review switch: a manual Send review still sends on an opted-out job", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db);
  optedOut(job);
  assertEquals(
    (await requestJobReview(deps, {
      job_id: job.id,
      trigger: "manual:ops@secureworkswa.com.au",
      manual: true,
    })).action,
    "sent",
  );
  assertEquals(sms.length, 1);
  assertEquals(db.rows("job_review_claims").length, 1);
});

Deno.test("set_review_opt_out: off then on, stamping who and when, one event per change", async () => {
  const { db, deps } = setup({ sender: "live" });
  const job = addJob(db, { status: "complete", review_opt_out: false });
  const off = await setReviewOptOut(
    deps,
    { job_id: job.id, opt_out: true },
    "shaun@secureworkswa.com.au",
  );
  assertEquals(off.status, 200);
  assertEquals(off.body, {
    success: true,
    changed: true,
    review_opt_out: true,
    review_opt_out_at: NOW.toISOString(),
    review_opt_out_by: "shaun@secureworkswa.com.au",
  });
  assertEquals(
    [job.review_opt_out, job.review_opt_out_at, job.review_opt_out_by],
    [true, NOW.toISOString(), "shaun@secureworkswa.com.au"],
  );
  // The same value again changes nothing and logs nothing.
  const again = await setReviewOptOut(
    deps,
    { job_id: job.id, opt_out: true },
    "esther@secureworkswa.com.au",
  );
  assertEquals([again.status, again.body.changed], [200, false]);
  assertEquals(job.review_opt_out_by, "shaun@secureworkswa.com.au");
  const on = await setReviewOptOut(
    deps,
    { job_id: job.id, opt_out: false },
    "esther@secureworkswa.com.au",
  );
  assertEquals([on.status, on.body.review_opt_out], [200, false]);
  assertEquals(job.review_opt_out, false);
  const events = db.rows("job_events").filter((e) =>
    e.event_type === "review_opt_out_changed"
  );
  assertEquals(events.map((e) => e.detail_json), [
    {
      review_opt_out: true,
      review: "off",
      by: "shaun@secureworkswa.com.au",
      at: NOW.toISOString(),
    },
    {
      review_opt_out: false,
      review: "on",
      by: "esther@secureworkswa.com.au",
      at: NOW.toISOString(),
    },
  ]);
});

Deno.test("set_review_opt_out: refused 409 review_already_sent once the job has a review claim", async () => {
  const { db, deps } = setup({ sender: "live" });
  const job = reviewJob(db, { review_opt_out: false });
  for (const status of ["claimed", "sent"]) {
    db.tables.job_review_claims = [{ job_id: job.id, status, trigger: "t" }];
    const out = await setReviewOptOut(
      deps,
      { job_id: job.id, opt_out: true },
      "shaun@secureworkswa.com.au",
    );
    assertEquals(out.status, 409);
    assertEquals(out.body.error, "review_already_sent");
    assertEquals(out.body.review_claim_status, status);
    assertEquals(job.review_opt_out, false);
  }
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.event_type === "review_opt_out_changed"
    )
      .length,
    0,
  );
});

Deno.test("set_review_opt_out: bad input, unknown job and an unreadable claim write nothing", async () => {
  const { db, deps } = setup({ sender: "live" });
  const job = addJob(db, { status: "complete", review_opt_out: false });
  assertEquals(
    (await setReviewOptOut(deps, { opt_out: true }, null)).status,
    400,
  );
  assertEquals(
    (await setReviewOptOut(deps, { job_id: job.id, opt_out: "yes" }, null))
      .status,
    400,
  );
  assertEquals(
    (await setReviewOptOut(deps, { job_id: "nope", opt_out: true }, null))
      .status,
    404,
  );
  db.failures.job_review_claims = "boom";
  assertEquals(
    (await setReviewOptOut(deps, { job_id: job.id, opt_out: true }, null))
      .status,
    503,
  );
  assertEquals(job.review_opt_out, false);
  assertEquals(db.rows("job_events").length, 0);
});

/** The fake with a hook before each query of a table runs (the nth call, from 1). */
function hookedClient(
  db: FakeDb,
  table: string,
  hook: (n: number) => Promise<unknown> | void,
): FakeDb {
  let n = 0;
  return Object.assign(Object.create(db), {
    from(t: string) {
      const q: any = db.from(t);
      if (t !== table) return q;
      const call = ++n;
      const run = q.then.bind(q);
      q.then = (ok?: any, bad?: any) =>
        Promise.resolve(hook(call)).then(() => run(ok, bad));
      return q;
    },
  });
}

Deno.test("review switch: turned off while the sender is reading, the text does not go out", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db, { review_opt_out: false });
  let press: Awaited<ReturnType<typeof setReviewOptOut>> | null = null;
  // Staff press the switch during the 90-day look-back, after the sender read the job.
  const client = hookedClient(db, "business_events", async (n) => {
    if (n === 1) {
      press = await setReviewOptOut(
        { client: db, now: () => NOW },
        { job_id: job.id, opt_out: true },
        "shaun@secureworkswa.com.au",
      );
    }
  });
  const out = await requestJobReview({ ...deps, client }, {
    job_id: job.id,
    trigger: "status_changed:xero_sync",
  });
  assertEquals(out.action, "opted_out");
  assertEquals([press!.status, press!.body.changed], [200, true]);
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_review_claims").length, 0);
  const notSent = db.rows("job_events").filter((e) =>
    e.event_type === "review_request_not_sent"
  );
  assertEquals(notSent.map((e) => e.detail_json.status), ["opted_out"]);
  assertEquals(
    notSent[0].detail_json.opted_out.by,
    "shaun@secureworkswa.com.au",
  );
});

Deno.test("review switch: a sender that claims after the switch first looks is reported 409", async () => {
  const { db, deps } = setup({ sender: "live" });
  const job = reviewJob(db, { review_opt_out: false });
  // The sender claims (and sends) between the switch's claim check and its write.
  const client = hookedClient(db, "jobs", (n) => {
    if (n === 2) {
      db.rows("job_review_claims").push({
        job_id: job.id,
        status: "sent",
        trigger: "status_changed:xero_sync",
      });
    }
  });
  const out = await setReviewOptOut(
    { ...deps, client },
    { job_id: job.id, opt_out: true },
    "shaun@secureworkswa.com.au",
  );
  assertEquals(out.status, 409);
  assertEquals(out.body.error, "review_already_sent");
  assertEquals(out.body.review_claim_status, "sent");
  // A refused press leaves no trace: the switch is as it was and nothing is logged.
  assertEquals(
    [job.review_opt_out, job.review_opt_out_at, job.review_opt_out_by],
    [false, null, null],
  );
  assertEquals(
    db.rows("job_events").filter((e) =>
      e.event_type === "review_opt_out_changed"
    ).length,
    0,
  );
});

Deno.test("review switch: a failed second claim look puts the switch back and logs nothing", async () => {
  const { db, deps } = setup({ sender: "live" });
  const job = addJob(db, {
    status: "complete",
    review_opt_out: true,
    review_opt_out_at: hoursAgo(5),
    review_opt_out_by: "esther@secureworkswa.com.au",
  });
  const client = hookedClient(db, "job_review_claims", (n) => {
    if (n === 2) db.failures.job_review_claims = "boom";
  });
  const out = await setReviewOptOut(
    { ...deps, client },
    { job_id: job.id, opt_out: false },
    "shaun@secureworkswa.com.au",
  );
  delete db.failures.job_review_claims;
  assertEquals([out.status, out.body.error], [503, "review_claim_unreadable"]);
  assertEquals(
    [job.review_opt_out, job.review_opt_out_at, job.review_opt_out_by],
    [true, hoursAgo(5), "esther@secureworkswa.com.au"],
  );
  assertEquals(db.rows("job_events").length, 0);
});

Deno.test("review switch: an unreadable switch after the claim sends nothing and keeps no claim", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const job = reviewJob(db, { review_opt_out: false });
  const client = hookedClient(db, "jobs", (n) => {
    if (n === 2) db.failures.jobs = "boom";
  });
  const out = await requestJobReview({ ...deps, client }, {
    job_id: job.id,
    trigger: "t",
  });
  delete db.failures.jobs;
  assertEquals(out.action, "opt_out_unreadable");
  assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
  // The next attempt, with the switch readable and still on, sends.
  assertEquals(
    (await requestJobReview(deps, { job_id: job.id, trigger: "t" })).action,
    "sent",
  );
});

Deno.test("review switch: a sweep dry run reports an opted-out card would_archive, not would_send", async () => {
  const { db, deps, sms } = setup({ sender: "live" });
  const off = paidJob(db, { status: "get_review", job_number: "SWF-83" });
  optedOut(off);
  enteredGetReview(db, off.id, hoursAgo(25));
  const on = paidJob(db, { status: "get_review", job_number: "SWF-84" });
  enteredGetReview(db, on.id, hoursAgo(25));
  const out = await closeoutSweep(deps, { dry_run: true });
  const byJob = Object.fromEntries(
    (out.results ?? []).map((r: any) => [r.job_number, r.action]),
  );
  assertEquals(byJob, {
    "SWF-83": "would_archive",
    "SWF-84": "would_send_review_then_archive",
  });
  assertEquals([sms.length, db.rows("job_review_claims").length], [0, 0]);
});
