// deno-lint-ignore-file no-import-prefix no-explicit-any
// Deposit advance (job_deposit_advance.ts) against an in-memory PostgREST fake: the
// landing in Awaiting Deposit, the paid move, the switch, the once-only client text, the
// flag after a void or refund, and the action door.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  depositCatchUp,
  depositInvoiceSent,
  depositOnInvoiceChange,
  type JobDepositDeps,
  loadDepositFlags,
  readDepositAdvanceMode,
  runJobDepositAction,
} from "./job_deposit_advance.ts";
import type { SmsSendResult } from "./job_closeout.ts";

// ── A small PostgREST fake ───────────────────────────────────────────────────

type Row = Record<string, any>;
const PRIMARY_KEYS: Record<string, string> = {
  job_deposit_advance_state: "job_id",
  job_closeout_settings: "id",
};

function read(row: Row, col: string): any {
  const path = col.match(/^(\w+)->>(\w+)$/);
  if (path) {
    const v = row[path[1]]?.[path[2]];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col];
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private from_ = 0;
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: any = null;
  private single = false;
  private returning = false;
  private head = false;
  private projections: { alias: string; col: string; key: string }[] = [];
  constructor(private db: FakeDb, private table: string) {}
  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode !== "select") this.returning = true;
    // A JSON path projection, alias:col->Key, reads like PostgREST: the JSON value, or null.
    for (const m of String(cols ?? "").matchAll(/(\w+):(\w+)->(\w+)/g)) {
      this.projections.push({ alias: m[1], col: m[2], key: m[3] });
    }
    if (opts?.head) this.head = true;
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
  is(col: string, v: null) {
    this.filters.push((r) => (read(r, col) ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: null) {
    assertEquals(op, "is");
    this.filters.push((r) => (read(r, col) ?? null) !== v);
    return this;
  }
  or(expr: string) {
    const tests = expr.split(",").map((part) => {
      const m = part.match(/^(\w+)\.(not\.)?is\.null$/);
      if (!m) throw new Error(`unsupported or(): ${part}`);
      return (r: Row) => ((read(r, m[1]) ?? null) === null) !== !!m[2];
    });
    this.filters.push((r) => tests.some((t) => t(r)));
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
    this.single = true;
    return this;
  }
  insert(v: any) {
    this.mode = "insert";
    this.payload = v;
    return this;
  }
  upsert(v: any, _opts?: unknown) {
    this.mode = "upsert";
    this.payload = v;
    return this;
  }
  update(v: any) {
    this.mode = "update";
    this.payload = v;
    return this;
  }
  then(ok?: (v: any) => any, bad?: (e: unknown) => any) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): { data: any; error: any; count?: number } {
    const fail = this.db.failures[this.table];
    if (fail) return { data: null, error: { message: fail, code: "XX000" } };
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
        else rows.push({ ...row });
      }
      return { data: null, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      hit.forEach((r) => Object.assign(r, this.payload));
      return {
        data: this.returning ? hit.map((r) => ({ ...r })) : null,
        error: null,
      };
    }
    if (this.head) return { data: null, error: null, count: hit.length };
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
    if (this.projections.length) {
      hit = hit.map((r) => {
        const out = { ...r };
        for (const p of this.projections) {
          out[p.alias] = r[p.col]?.[p.key] ?? null;
        }
        return out;
      });
    }
    if (this.single) return { data: hit[0] ?? null, error: null };
    return { data: hit, error: null };
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  failures: Record<string, string> = {};
  rows(t: string) {
    return (this.tables[t] ??= []);
  }
  from(t: string) {
    return new Query(this, t);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-26T06:00:00.000Z");

function setup(mode: "off" | "dry_run" | "live" | null = "live") {
  const db = new FakeDb();
  if (mode) {
    db.rows("job_closeout_settings").push({
      id: 1,
      deposit_advance_mode: mode,
    });
  }
  const moves: Row[] = [];
  const sms: Row[] = [];
  let smsResult: () => SmsSendResult = () => ({ ok: true, message_id: "m1" });
  const deps: JobDepositDeps = {
    client: db,
    now: () => NOW,
    moveJobStatus: (body) => {
      moves.push(body);
      const job = db.rows("jobs").find((j) => j.id === body.jobId);
      const expected = body.expected_statuses as string[] | undefined;
      if (!job || (expected && !expected.includes(job.status))) {
        return Promise.resolve({ success: false, skipped: "status_changed" });
      }
      job.status = body.status;
      return Promise.resolve({ success: true });
    },
    sendSms: (args) => {
      sms.push(args);
      return Promise.resolve(smsResult());
    },
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
  const n = db.rows("jobs").length + 1;
  const job = {
    id: `job-${n}`,
    job_number: `SWF-26136${n}`,
    type: "fencing",
    status: "awaiting_deposit",
    deposit_invoice_id: null,
    council_required: null,
    client_name: "Vicky Zhang",
    ghl_contact_id: "ghl-vicky",
    ...over,
  };
  db.rows("jobs").push(job);
  return job;
}

function addDeposit(db: FakeDb, job: Row, over: Row = {}): Row {
  const id = over.xero_invoice_id ?? `x-${db.rows("xero_invoices").length + 1}`;
  const status = over.status ?? "PAID";
  const total = over.total ?? 2000;
  const inv = {
    job_id: job.id,
    xero_invoice_id: id,
    invoice_number: `INV-${1749 + db.rows("xero_invoices").length}`,
    invoice_type: "ACCREC",
    status,
    reference: `${job.job_number}-DEP50`,
    total,
    amount_due: status === "PAID" ? 0 : total,
    amount_paid: status === "PAID" ? total : 0,
    fully_paid_on: status === "PAID" ? "2026-10-26" : null,
    ...over,
  };
  db.rows("xero_invoices").push(inv);
  if (!job.deposit_invoice_id) job.deposit_invoice_id = id;
  return inv;
}

const events = (db: FakeDb, type: string) =>
  db.rows("job_events").filter((e) => e.event_type === type);

// ── The switch ───────────────────────────────────────────────────────────────

Deno.test("deposit switch: off, missing or unreadable reads as off and does nothing", async () => {
  for (const mode of ["off", null] as const) {
    const { db, deps, moves, sms } = setup(mode);
    const job = addJob(db);
    addDeposit(db, job);
    assertEquals(await readDepositAdvanceMode(db), "off");
    assertEquals(
      (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
      "switch_off",
    );
    assertEquals(
      (await depositInvoiceSent(deps, { job_id: job.id, source: "t" })).action,
      "switch_off",
    );
    assertEquals((await depositCatchUp(deps, {})).ran, false);
    assertEquals(moves.length + sms.length + db.rows("job_events").length, 0);
  }
  const { db } = setup("live");
  db.failures.job_closeout_settings = "boom";
  assertEquals(await readDepositAdvanceMode(db), "off");
});

// ── Landing in Awaiting Deposit ──────────────────────────────────────────────

Deno.test("deposit sent: an accepted job with its deposit sent lands in Awaiting Deposit", async () => {
  const { db, deps, moves } = setup("live");
  const job = addJob(db, { status: "accepted" });
  const inv = addDeposit(db, job, { status: "AUTHORISED" });
  const r = await depositInvoiceSent(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
    source: "send_acceptance_invoice",
  });
  assertEquals(r.action, "moved");
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(moves[0].expected_statuses, ["accepted"]);
  assertEquals(moves[0].source, "send_acceptance_invoice");
  assertEquals(moves[0].skip_ghl_push, true);
});

Deno.test("deposit sent: no deposit invoice, a draft, or another invoice leaves it in Accepted", async () => {
  const { db, deps, moves } = setup("live");
  const none = addJob(db, { status: "accepted" });
  assertEquals(
    (await depositInvoiceSent(deps, { job_id: none.id, source: "t" })).action,
    "not_sent",
  );
  const draft = addJob(db, { status: "accepted" });
  const d = addDeposit(db, draft, { status: "DRAFT" });
  assertEquals(
    (await depositInvoiceSent(deps, {
      job_id: draft.id,
      xero_invoice_id: d.xero_invoice_id,
      source: "t",
    })).action,
    "not_deposit_invoice",
  );
  const fin = addJob(db, { status: "accepted" });
  addDeposit(db, fin, { status: "AUTHORISED" });
  const f = addDeposit(db, fin, {
    status: "AUTHORISED",
    reference: `${fin.job_number}-FINBAL`,
  });
  assertEquals(
    (await depositInvoiceSent(deps, {
      job_id: fin.id,
      xero_invoice_id: f.xero_invoice_id,
      source: "t",
    })).action,
    "not_deposit_invoice",
  );
  // Already moved on, or a make-safe: untouched.
  const on = addJob(db, { status: "scheduled" });
  addDeposit(db, on, { status: "AUTHORISED" });
  assertEquals(
    (await depositInvoiceSent(deps, { job_id: on.id, source: "t" })).action,
    "not_in_from_status",
  );
  const ms = addJob(db, { status: "accepted", type: "makesafe" });
  assertEquals(
    (await depositInvoiceSent(deps, { job_id: ms.id, source: "t" })).action,
    "not_deposit_type",
  );
  assertEquals(moves.length, 0);
  assertEquals(
    db.rows("jobs").filter((j) => j.status === "accepted").length,
    4,
  );
});

// ── Landing by Xero's own sent flag ──────────────────────────────────────────

Deno.test("deposit sent in Xero: an accepted job whose deposit Xero marks sent lands in Awaiting Deposit", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db, { status: "accepted" });
  const inv = addDeposit(db, job, {
    status: "AUTHORISED",
    raw_json: { SentToContact: true },
  });
  // The invoice change alone does not land it; the catch-up does.
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: inv.xero_invoice_id,
      source: "xero_sync",
    })).action,
    "not_paid",
  );
  assertEquals(job.status, "accepted");
  const r = await depositCatchUp(deps, {});
  assertEquals(r.results?.map((x) => x.action), ["moved"]);
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(moves[0].source, "xero_deposit_sent");
  assertEquals(moves[0].expected_statuses, ["accepted"]);
  assertEquals(moves[0].skip_ghl_push, true);
  assertEquals(sms.length, 0);
  // Landed, not paid: no move record, so nothing is flagged later.
  assertEquals(db.rows("job_deposit_advance_state").length, 0);
  // Then it moves on payment as before.
  Object.assign(inv, {
    status: "PAID",
    amount_due: 0,
    amount_paid: 2000,
    fully_paid_on: "2026-10-27",
  });
  const paid = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
  });
  assertEquals(paid.action, "moved");
  assertEquals(job.status, "order_materials");
});

Deno.test("deposit sent in Xero: not known, false, a draft or status alone leaves it in Accepted", async () => {
  const { db, deps, moves } = setup("live");
  // No SentToContact on the stored record: not known, never sent.
  const unknown = addJob(db, { status: "accepted" });
  addDeposit(db, unknown, { status: "AUTHORISED", raw_json: {} });
  const noRaw = addJob(db, { status: "accepted" });
  addDeposit(db, noRaw, { status: "AUTHORISED" });
  const notBool = addJob(db, { status: "accepted" });
  addDeposit(db, notBool, {
    status: "AUTHORISED",
    raw_json: { SentToContact: "true" },
  });
  const no = addJob(db, { status: "accepted" });
  addDeposit(db, no, {
    status: "AUTHORISED",
    raw_json: { SentToContact: false },
  });
  // A sent deposit beside a draft one: a draft was never sent.
  const draft = addJob(db, { status: "accepted" });
  addDeposit(db, draft, {
    status: "AUTHORISED",
    reference: `${draft.job_number}-A-DEP50`,
    raw_json: { SentToContact: true },
  });
  addDeposit(db, draft, {
    status: "DRAFT",
    reference: `${draft.job_number}-B-DEP50`,
  });
  // Xero marks a non-deposit invoice sent: not a deposit (and not the job's pointer).
  const fin = addJob(db, { status: "accepted", deposit_invoice_id: "x-other" });
  addDeposit(db, fin, {
    status: "AUTHORISED",
    reference: `${fin.job_number}-FINBAL`,
    raw_json: { SentToContact: true },
  });
  for (const job of [unknown, noRaw, notBool, no, draft]) {
    const r = await depositOnInvoiceChange(deps, { job_id: job.id });
    assertEquals(r.action, "not_paid");
  }
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: fin.id })).action,
    "not_paid",
  );
  const catchUp = await depositCatchUp(deps, {});
  assertEquals(catchUp.results, []);
  assertEquals(moves.length, 0);
  assertEquals(
    db.rows("jobs").filter((j) => j.status === "accepted").length,
    6,
  );
});

Deno.test("deposit sent in Xero: the catch-up lands a deposit sent before the deploy", async () => {
  const { db, deps, moves } = setup("live");
  const job = addJob(db, { status: "accepted" });
  addDeposit(db, job, {
    status: "AUTHORISED",
    raw_json: { SentToContact: true },
  });
  // Already in Awaiting Deposit: the landing does nothing more.
  const waiting = addJob(db, { status: "awaiting_deposit" });
  addDeposit(db, waiting, {
    status: "AUTHORISED",
    raw_json: { SentToContact: true },
  });
  const r = await depositCatchUp(deps, {});
  assertEquals(r.ran, true);
  assertEquals(r.results?.map((x) => [x.job_id, x.action]), [
    [job.id, "moved"],
  ]);
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(waiting.status, "awaiting_deposit");
  assertEquals(moves.length, 1);
  // The next run finds nothing to do.
  assertEquals((await depositCatchUp(deps, {})).results, []);
});

Deno.test("deposit sent in Xero: dry_run records once and moves nothing; off reads nothing", async () => {
  const { db, deps, moves } = setup("dry_run");
  const job = addJob(db, { status: "accepted" });
  addDeposit(db, job, {
    status: "AUTHORISED",
    raw_json: { SentToContact: true },
  });
  const first = await depositCatchUp(deps, {});
  assertEquals(first.results?.[0].action, "dry_run");
  assertEquals(
    (await depositCatchUp(deps, {})).results?.[0].action,
    "dry_run_already_recorded",
  );
  assertEquals(job.status, "accepted");
  assertEquals(moves.length, 0);
  const rows = events(db, "deposit_advance_dry_run");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].detail_json.rule, "deposit_sent_in_xero");
  assertEquals(rows[0].detail_json.from_status, "accepted");
  assertEquals(rows[0].detail_json.would_move_to, "awaiting_deposit");
  assertEquals(rows[0].detail_json.sent_in_xero, [
    db.rows("xero_invoices")[0].invoice_number,
  ]);

  const off = setup("off");
  const offJob = addJob(off.db, { status: "accepted" });
  addDeposit(off.db, offJob, {
    status: "AUTHORISED",
    raw_json: { SentToContact: true },
  });
  assertEquals(
    (await depositOnInvoiceChange(off.deps, { job_id: offJob.id })).action,
    "switch_off",
  );
  assertEquals((await depositCatchUp(off.deps, {})).ran, false);
  assertEquals(offJob.status, "accepted");
  assertEquals(off.moves.length + off.db.rows("job_events").length, 0);
});

// ── Paid -> Order Materials / Approvals ──────────────────────────────────────

Deno.test("deposit paid: full payment moves fencing to Order Materials and texts once", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db);
  const inv = addDeposit(db, job);
  const r = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
    source: "xero_sync",
  });
  assertEquals(r.action, "moved");
  assertEquals(r.text, "sent");
  assertEquals(job.status, "order_materials");
  assertEquals(moves[0].source, "xero_deposit_paid");
  assertEquals(moves[0].expected_statuses, ["accepted", "awaiting_deposit"]);
  assertEquals(moves[0].skip_ghl_push, true);
  assertEquals(sms.length, 1);
  assertEquals(sms[0].contactId, "ghl-vicky");
  assert(String(sms[0].message).startsWith("Hi Vicky,"));
  const state = db.rows("job_deposit_advance_state")[0];
  assertEquals(state.moved_to, "order_materials");
  assertEquals(state.counted_invoice_ids, [inv.xero_invoice_id]);
  assertEquals(state.text_status, "sent");
  assertEquals(
    db.rows("email_events").filter((e) => e.comms_trigger === "deposit_paid")
      .length,
    1,
  );
  // The same paid invoice again (every sync re-reads it): nothing more.
  const again = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
  });
  assertEquals(again.action, "no_flag");
  // Even if the job were put back and moved again, the text claim is already taken.
  job.status = "awaiting_deposit";
  const third = await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(third.action, "moved");
  assertEquals(third.text, "already_claimed");
  assertEquals(sms.length, 1);
});

Deno.test("deposit paid: a part payment does not move the job", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db);
  addDeposit(db, job, {
    status: "AUTHORISED",
    amount_due: 500,
    amount_paid: 1500,
  });
  const r = await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(r.action, "not_paid");
  assertEquals(r.detail, [
    `part_paid:${db.rows("xero_invoices")[0].invoice_number}`,
  ]);
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(moves.length + sms.length, 0);
});

Deno.test("deposit paid: a shared fence moves only when every party has paid", async () => {
  const { db, deps, moves } = setup("live");
  const job = addJob(db);
  addDeposit(db, job, { reference: `${job.job_number}-A-DEP50` });
  const b = addDeposit(db, job, {
    reference: `${job.job_number}-B-DEP50`,
    status: "AUTHORISED",
  });
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "not_paid",
  );
  assertEquals(moves.length, 0);
  Object.assign(b, {
    status: "PAID",
    amount_due: 0,
    amount_paid: 2000,
    fully_paid_on: "2026-10-26",
  });
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: b.xero_invoice_id,
    })).action,
    "moved",
  );
  assertEquals(job.status, "order_materials");
});

Deno.test("deposit paid: a shared fence never moves while a paying party has no deposit", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db);
  db.rows("job_contacts").push(
    {
      id: "jc-a",
      job_id: job.id,
      contact_label: "A",
      is_primary: true,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      xero_contact_id: null,
    },
    {
      id: "jc-b",
      job_id: job.id,
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      status: "active",
      xero_contact_id: null,
    },
  );
  const a = addDeposit(db, job, { reference: `${job.job_number}-A-DEP50` });
  const r = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: a.xero_invoice_id,
  });
  assertEquals([r.action, r.detail], ["not_paid", ["party_without_deposit:B"]]);
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(moves.length + sms.length, 0);
  // The neighbour's deposit is raised and paid: the job moves.
  const b = addDeposit(db, job, {
    reference: `${job.job_number}-B-DEP50`,
    job_contact_id: "jc-b",
  });
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: b.xero_invoice_id,
    })).action,
    "moved",
  );
  assertEquals(job.status, "order_materials");
  // The party read failing moves nothing.
  const other = addJob(db);
  addDeposit(db, other);
  db.failures.job_contacts = "boom";
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: other.id })).action,
    "facts_unreadable",
  );
  assertEquals(other.status, "awaiting_deposit");
});

Deno.test("deposit paid: a hand-made Xero deposit that is not the job's pointer is counted", async () => {
  const { db, deps } = setup("live");
  const job = addJob(db);
  addDeposit(db, job); // the pointer, paid
  const hand = addDeposit(db, job, {
    reference: `${job.job_number}-DEP`,
    status: "AUTHORISED",
  });
  assert(job.deposit_invoice_id !== hand.xero_invoice_id);
  // The hand-made deposit is unpaid: no move.
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "not_paid",
  );
  // Its own change is a deposit change, so it is acted on once paid.
  Object.assign(hand, { status: "PAID", amount_due: 0, amount_paid: 2000 });
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: hand.xero_invoice_id,
    })).action,
    "moved",
  );
});

Deno.test("deposit paid: a job someone already moved on is never moved", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db, { status: "scheduled" });
  addDeposit(db, job);
  const r = await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(r.action, "no_flag");
  assertEquals(job.status, "scheduled");
  // Moved between the read and the write: the compare and set refuses, nothing texted.
  const raced = addJob(db, { status: "awaiting_deposit" });
  addDeposit(db, raced);
  const realMove = deps.moveJobStatus;
  deps.moveJobStatus = (body) => {
    raced.status = "schedule_install";
    return realMove(body);
  };
  const r2 = await depositOnInvoiceChange(deps, { job_id: raced.id });
  assertEquals(r2.action, "move_skipped");
  assertEquals(r2.detail, "status_changed");
  assertEquals(raced.status, "schedule_install");
  assertEquals(sms.length, 0);
  assertEquals(db.rows("job_deposit_advance_state").length, 0);
  assertEquals(moves.length, 1);
});

Deno.test("deposit paid: patio goes to Approvals when council is needed or undecided, no text", async () => {
  for (const council of [true, null]) {
    const { db, deps, sms } = setup("live");
    const job = addJob(db, { type: "patio", council_required: council });
    addDeposit(db, job);
    const r = await depositOnInvoiceChange(deps, { job_id: job.id });
    assertEquals(r.action, "moved");
    assertEquals(job.status, "approvals");
    assertEquals(r.text, "not_order_materials");
    assertEquals(sms.length, 0);
  }
  const { db, deps, sms } = setup("live");
  const job = addJob(db, { type: "patio", council_required: false });
  addDeposit(db, job);
  const r = await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  assertEquals(r.text, "sent");
  assertEquals(sms.length, 1);
});

Deno.test("deposit paid: dry_run moves and texts nothing and records once", async () => {
  const { db, deps, moves, sms } = setup("dry_run");
  const job = addJob(db);
  addDeposit(db, job);
  const landing = addJob(db, { status: "accepted" });
  addDeposit(db, landing, { status: "AUTHORISED" });
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "dry_run",
  );
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "dry_run_already_recorded",
  );
  assertEquals(
    (await depositInvoiceSent(deps, {
      job_id: landing.id,
      source: "send_acceptance_invoice",
    })).action,
    "dry_run",
  );
  const catchUp = await depositCatchUp(deps, {});
  assertEquals(catchUp.ran, true);
  assertEquals(moves.length + sms.length, 0);
  assertEquals(job.status, "awaiting_deposit");
  assertEquals(landing.status, "accepted");
  assertEquals(db.rows("job_deposit_advance_state").length, 0);
  const dry = events(db, "deposit_advance_dry_run");
  assertEquals(dry.length, 2);
  assertEquals(dry[0].detail_json.would_move_to, "order_materials");
  assertEquals(dry[0].detail_json.would_text_client, true);
  assertEquals(dry[1].detail_json.would_move_to, "awaiting_deposit");
});

Deno.test("deposit text: not sent with no contact, a prior send, or prior sends unreadable", async () => {
  const unreadable = setup("live");
  const j1 = addJob(unreadable.db);
  addDeposit(unreadable.db, j1);
  unreadable.db.failures.email_events = "boom";
  const r1 = await depositOnInvoiceChange(unreadable.deps, { job_id: j1.id });
  assertEquals([r1.action, r1.text], ["moved", "prior_send_unreadable"]);
  assertEquals(unreadable.sms.length, 0);
  assertEquals(
    unreadable.db.rows("job_deposit_advance_state")[0].text_status,
    "prior_send_unreadable",
  );

  const noContact = setup("live");
  const j2 = addJob(noContact.db, { ghl_contact_id: null });
  addDeposit(noContact.db, j2);
  assertEquals(
    (await depositOnInvoiceChange(noContact.deps, { job_id: j2.id })).text,
    "no_contact",
  );
  assertEquals(noContact.sms.length, 0);

  const prior = setup("live");
  const j3 = addJob(prior.db);
  addDeposit(prior.db, j3);
  prior.db.rows("email_events").push({
    job_id: j3.id,
    comms_trigger: "deposit_paid",
    status: "sent",
  });
  assertEquals(
    (await depositOnInvoiceChange(prior.deps, { job_id: j3.id })).text,
    "already_sent",
  );
  assertEquals(prior.sms.length, 0);

  const refused = setup("live");
  refused.setSms(() => ({ ok: false, refused: true, error: "contact DND" }));
  const j4 = addJob(refused.db);
  addDeposit(refused.db, j4);
  assertEquals(
    (await depositOnInvoiceChange(refused.deps, { job_id: j4.id })).text,
    "refused",
  );
  assertEquals(refused.db.rows("email_events").length, 0);
  assertEquals(
    events(refused.db, "deposit_received_text")[0].detail_json.result,
    "refused",
  );
});

// ── Catch-up ─────────────────────────────────────────────────────────────────

Deno.test("deposit catch-up: a card paid before the switch was on moves on the first live run", async () => {
  const { db, deps, sms } = setup("live");
  const vicky = addJob(db, { status: "accepted" });
  addDeposit(db, vicky, { fully_paid_on: "2026-10-20" });
  const waiting = addJob(db);
  addDeposit(db, waiting, { status: "AUTHORISED" });
  const r = await depositCatchUp(deps, {}) as any;
  assertEquals(r.ran, true);
  assertEquals(vicky.status, "order_materials");
  assertEquals(waiting.status, "awaiting_deposit");
  assertEquals(r.results.length, 1);
  // Paid six days ago, before the switch was on: the client is still texted once.
  assertEquals(r.results[0].text, "sent");
  assertEquals(sms.length, 1);
});

// ── Voided or refunded after the move ────────────────────────────────────────

Deno.test("deposit flag: a void after the move is flagged once, never moved back, then cleared", async () => {
  const { db, deps, moves } = setup("live");
  const job = addJob(db);
  const inv = addDeposit(db, job);
  await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  inv.status = "VOIDED";
  const r = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
  });
  assertEquals(r.action, "flagged");
  assertEquals(job.status, "order_materials");
  assertEquals(moves.length, 1);
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "already_flagged",
  );
  assertEquals(events(db, "deposit_flagged").length, 1);
  const flags = await loadDepositFlags(db, [job.id, "other"]);
  assertEquals(flags?.get(job.id)?.reason, "deposit_voided");
  assertEquals(flags?.has("other"), false);
  // A person clears it.
  const cleared = await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: "shaun@secureworkswa.com.au" },
    deps,
  );
  assertEquals(cleared.body.action, "cleared");
  assertEquals((await loadDepositFlags(db, [job.id]))?.size, 0);
  const twice = await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: null },
    deps,
  );
  assertEquals(twice.body.action, "no_open_flag");
  // The same void seen again (the sync overlap, or another deposit changing): it stays cleared.
  const replacement = addDeposit(db, job, {
    status: "AUTHORISED",
    amount_due: 2000,
    amount_paid: 0,
  });
  const again = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: replacement.xero_invoice_id,
  });
  assertEquals(again.action, "no_flag");
  assertEquals(events(db, "deposit_flagged").length, 1);
  assertEquals((await loadDepositFlags(db, [job.id]))?.size, 0);
});

Deno.test("deposit flag: after a clear, another reason or invoice raises a new flag", async () => {
  const { db, deps } = setup("live");
  const job = addJob(db);
  const first = addDeposit(db, job);
  const second = addDeposit(db, job, { reference: `${job.job_number}-DEP2` });
  await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  first.status = "VOIDED";
  second.status = "AUTHORISED";
  Object.assign(second, { amount_due: 2000, amount_paid: 0 });
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: first.xero_invoice_id,
    })).detail,
    {
      reason: "deposit_voided",
      xero_invoice_id: first.xero_invoice_id,
      invoice_number: first.invoice_number,
      invoice_status: "VOIDED",
    },
  );
  await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: null },
    deps,
  );
  // The void is dealt with, but the other counted deposit is no longer paid: another
  // reason on another invoice, so a new flag.
  const r = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: second.xero_invoice_id,
  });
  assertEquals(r.action, "flagged");
  assertEquals((r.detail as any).reason, "deposit_unpaid");
  assertEquals((r.detail as any).xero_invoice_id, second.xero_invoice_id);
  assertEquals(events(db, "deposit_flagged").length, 2);
  assertEquals((await loadDepositFlags(db, [job.id]))?.size, 1);
  // Both cleared: neither comes back on the next sync, whichever was cleared first.
  await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: null },
    deps,
  );
  for (const inv of [first, second]) {
    const again = await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: inv.xero_invoice_id,
    });
    assertEquals(again.action, "no_flag");
  }
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
  assertEquals(events(db, "deposit_flagged").length, 2);
  assertEquals((await loadDepositFlags(db, [job.id]))?.size, 0);
});

Deno.test("deposit flag: a refund on a job the catch-up checks is flagged", async () => {
  const { db, deps } = setup("live");
  const job = addJob(db);
  const inv = addDeposit(db, job);
  await depositOnInvoiceChange(deps, { job_id: job.id });
  job.status = "scheduled";
  Object.assign(inv, {
    status: "AUTHORISED",
    amount_due: 2000,
    amount_paid: 0,
  });
  const r = await depositCatchUp(deps, {}) as any;
  assertEquals(r.results.map((x: any) => x.action), ["flagged"]);
  assertEquals(db.rows("job_deposit_advance_state")[0].flag, "deposit_unpaid");
  // A job a person moved on is never flagged, even when its deposit is voided.
  const hand = addJob(db, { status: "scheduled" });
  const handInv = addDeposit(db, hand, { status: "VOIDED" });
  const r2 = await depositOnInvoiceChange(deps, {
    job_id: hand.id,
    xero_invoice_id: handInv.xero_invoice_id,
  });
  assertEquals(r2.action, "no_flag");
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
});

Deno.test("deposit flag: the catch-up checks a job whose flag was cleared", async () => {
  const { db, deps } = setup("live");
  const job = addJob(db);
  const inv = addDeposit(db, job);
  await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  Object.assign(inv, {
    status: "AUTHORISED",
    amount_due: 2000,
    amount_paid: 0,
  });
  assertEquals(
    (await depositCatchUp(deps, {}) as any).results.map((x: any) => x.action),
    [
      "flagged",
    ],
  );
  await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: null },
    deps,
  );
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
  inv.status = "VOIDED";
  const r = await depositCatchUp(deps, {}) as any;
  assertEquals(r.results.map((x: any) => x.action), ["flagged"]);
  assertEquals(db.rows("job_deposit_advance_state")[0].flag, "deposit_voided");
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
});

// Xero's CreditNotes on an invoice, as the read projects them (raw_json->CreditNotes).
const creditNote = (id: string, number: string, applied: number) => ({
  CreditNoteID: id,
  CreditNoteNumber: number,
  AppliedAmount: applied,
  Total: applied,
  DateString: "2026-10-28T00:00:00",
});

Deno.test("deposit flag: a refund by credit note after the move is flagged once, never moved back, then cleared", async () => {
  const { db, deps, moves, sms } = setup("live");
  const job = addJob(db);
  // A rounding credit closed the invoice before the move: part of how it was paid.
  const inv = addDeposit(db, job, {
    amount_paid: 1999.82,
    credit_notes: [creditNote("cn-r", "CN-0499", 0.18)],
  });
  await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  const state = db.rows("job_deposit_advance_state")[0];
  assertEquals(state.counted_credit_note_ids, ["cn-r"]);
  assertEquals(
    (await depositOnInvoiceChange(deps, {
      job_id: job.id,
      xero_invoice_id: inv.xero_invoice_id,
    })).action,
    "no_flag",
  );
  // Xero refund: payment taken off, credit note allocated and refunded; still PAID.
  Object.assign(inv, {
    amount_paid: 0,
    credit_notes: [
      creditNote("cn-r", "CN-0499", 0.18),
      creditNote("cn-1", "CN-0500", 1999.82),
    ],
  });
  const r = await depositOnInvoiceChange(deps, {
    job_id: job.id,
    xero_invoice_id: inv.xero_invoice_id,
  });
  assertEquals(r.action, "flagged");
  assertEquals((r.detail as any).reason, "deposit_credited");
  assertEquals(job.status, "order_materials");
  assertEquals(moves.length, 1);
  assertEquals(sms.length, 1);
  const flagged = events(db, "deposit_flagged");
  assertEquals(flagged.length, 1);
  assertEquals(flagged[0].detail_json.reason, "deposit_credited");
  assertEquals(flagged[0].detail_json.credit_note_numbers, ["CN-0500"]);
  assertEquals(flagged[0].detail_json.invoice_status, "PAID");
  assertEquals((await loadDepositFlags(db, [job.id]))?.get(job.id), {
    reason: "deposit_credited",
    invoice_number: inv.invoice_number,
    invoice_status: "PAID",
    flagged_at: NOW.toISOString(),
  });
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "already_flagged",
  );
  // A person clears it: it stays cleared on the next sync and the catch-up.
  const cleared = await runJobDepositAction(
    "clear_job_deposit_flag",
    "POST",
    { job_id: job.id },
    { kind: "staff", email: "shaun@secureworkswa.com.au" },
    deps,
  );
  assertEquals(cleared.body.action, "cleared");
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "no_flag",
  );
  assertEquals((await depositCatchUp(deps, {}) as any).results.length, 0);
  assertEquals(events(db, "deposit_flagged").length, 1);
  assertEquals(moves.length + sms.length, 2);
});

Deno.test("deposit flag: a refund by credit note follows the switch like a void", async () => {
  const { db, deps, moves, sms } = setup("live");
  const settings = db.rows("job_closeout_settings")[0];
  const job = addJob(db);
  const inv = addDeposit(db, job);
  await depositOnInvoiceChange(deps, { job_id: job.id });
  assertEquals(job.status, "order_materials");
  Object.assign(inv, {
    amount_paid: 0,
    credit_notes: [creditNote("cn-1", "CN-0500", 2000)],
  });
  // off: nothing is read or written.
  settings.deposit_advance_mode = "off";
  assertEquals(
    (await depositOnInvoiceChange(deps, { job_id: job.id })).action,
    "switch_off",
  );
  assertEquals((await depositCatchUp(deps, {})).ran, false);
  assertEquals(events(db, "deposit_flagged").length, 0);
  // dry_run: the flag is a record, not a move, so it is recorded (here by the catch-up).
  settings.deposit_advance_mode = "dry_run";
  const r = await depositCatchUp(deps, {}) as any;
  assertEquals(r.results.map((x: any) => x.action), ["flagged"]);
  assertEquals(
    db.rows("job_deposit_advance_state")[0].flag,
    "deposit_credited",
  );
  assertEquals(job.status, "order_materials");
  assertEquals(moves.length + sms.length, 2);
  assertEquals(events(db, "deposit_flagged").length, 1);
});

Deno.test("deposit flag: an unreadable pipeline read is reported, not empty", async () => {
  const { db } = setup("live");
  db.failures.job_deposit_advance_state = "boom";
  assertEquals(await loadDepositFlags(db, ["job-1"]), null);
});

// ── The action door ──────────────────────────────────────────────────────────

Deno.test("deposit door: the moves need the server key, a clear needs staff, POST only", async () => {
  const { db, deps } = setup("live");
  const job = addJob(db);
  addDeposit(db, job);
  const staff = { kind: "staff" as const, email: "x@secureworkswa.com.au" };
  assertEquals(
    (await runJobDepositAction(
      "job_deposit_paid",
      "POST",
      { job_id: job.id },
      staff,
      deps,
    )).status,
    403,
  );
  assertEquals(
    (await runJobDepositAction("job_deposit_catch_up", "POST", {}, {
      kind: "none",
    }, deps)).status,
    403,
  );
  assertEquals(
    (await runJobDepositAction(
      "clear_job_deposit_flag",
      "POST",
      { job_id: job.id },
      { kind: "none" },
      deps,
    )).status,
    403,
  );
  assertEquals(
    (await runJobDepositAction("job_deposit_paid", "GET", { job_id: job.id }, {
      kind: "server",
    }, deps)).status,
    405,
  );
  assertEquals(
    (await runJobDepositAction("job_deposit_paid", "POST", {}, {
      kind: "server",
    }, deps)).status,
    400,
  );
  assertEquals(
    (await runJobDepositAction("job_deposit_paid", "POST", { job_id: "nope" }, {
      kind: "server",
    }, deps)).status,
    404,
  );
  assertEquals(job.status, "awaiting_deposit");
  const ok = await runJobDepositAction(
    "job_deposit_paid",
    "POST",
    { job_id: job.id },
    { kind: "server" },
    deps,
  );
  assertEquals([ok.status, ok.body.action], [200, "moved"]);
});
