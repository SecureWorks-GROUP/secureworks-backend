// deno-lint-ignore-file no-import-prefix no-explicit-any
// Paid-invoice receipt (job_receipt.ts) against an in-memory PostgREST fake: the paid
// trigger, the window, the once-only claim, unknown outcomes, the wrong-party guard, holds,
// the builder/insurance exclusion, dry run, off, the catch-up and the Xero call itself.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type JobReceiptDeps,
  readReceiptSwitch,
  receiptCatchUp,
  type ReceiptEmailResult,
  receiptPartyCheck,
  receiptWindowMiss,
  requestInvoiceReceipt,
  runJobReceiptAction,
  xeroReceiptEmailer,
} from "./job_receipt.ts";

// ── A small PostgREST fake ───────────────────────────────────────────────────

type Row = Record<string, any>;
const UNIQUE_KEYS: Record<string, string> = {
  job_receipt_claims: "xero_invoice_id",
};

function read(row: Row, col: string): any {
  const path = col.match(/^(\w+)->>(\w+)$/);
  if (path) return row[path[1]]?.[path[2]] ?? null;
  return row[col];
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private max: number | null = null;
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private payload: any = null;
  private single = false;
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
  gt(col: string, v: number) {
    this.filters.push((r) => Number(read(r, col)) > v);
    return this;
  }
  lt(col: string, v: string) {
    this.filters.push((r) => String(read(r, col) ?? "") < v);
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op === "is" && v === null) {
      this.filters.push((r) => read(r, col) != null);
    }
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.max = n;
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
    const rows = this.db.rows(this.table);
    if (this.mode === "insert") {
      const key = UNIQUE_KEYS[this.table];
      for (const row of [this.payload].flat()) {
        if (key && rows.some((r) => r[key] === row[key])) {
          return {
            data: null,
            error: { message: "duplicate key", code: "23505" },
          };
        }
        rows.push({ claimed_at: this.db.now, created_at: this.db.now, ...row });
      }
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      hit.forEach((r) => Object.assign(r, this.payload));
      return { data: null, error: null };
    }
    if (this.mode === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    const out = this.max === null ? hit : hit.slice(0, this.max);
    if (this.single) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  failures: Record<string, string> = {};
  rpcs: { name: string; args: any }[] = [];
  now = "2026-10-21T02:00:00.000Z";
  rows(t: string) {
    return (this.tables[t] ??= []);
  }
  from(t: string) {
    return new Query(this, t);
  }
  rpc(name: string, args: any) {
    this.rpcs.push({ name, args });
    return Promise.resolve({
      data: { outcome: "inserted", id: "be-1" },
      error: null,
    });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// 21 Oct 2026, 10:00 Perth. The mode began 20 Oct 2026, 09:00 Perth.
const NOW = new Date("2026-10-21T02:00:00.000Z");
const SINCE = "2026-10-20T01:00:00.000Z";
const JOB = "job-1";

function setup(
  opts: {
    mode?: "off" | "dry_run" | "live";
    since?: string | null;
    jobType?: string;
    jobStatus?: string;
  } = {},
) {
  const db = new FakeDb();
  db.rows("job_closeout_settings").push({
    id: 1,
    receipt_sender_mode: opts.mode ?? "live",
    receipt_sender_mode_since: opts.since === undefined ? SINCE : opts.since,
  });
  db.rows("jobs").push({
    id: JOB,
    job_number: "SWF-261500",
    type: opts.jobType ?? "fencing",
    status: opts.jobStatus ?? "invoiced",
    is_callback: false,
    ses_money_sealed_at: null,
  });
  const emails: { xeroInvoiceId: string; idempotencyKey: string }[] = [];
  let result: () => ReceiptEmailResult = () => ({ outcome: "sent" });
  let ids = 0;
  const deps: JobReceiptDeps = {
    client: db,
    now: () => NOW,
    newId: () => `claim-${++ids}`,
    emailInvoice: (args) => {
      emails.push(args);
      return Promise.resolve(result());
    },
  };
  return {
    db,
    deps,
    emails,
    setResult: (f: () => ReceiptEmailResult) => (result = f),
  };
}

function invoice(db: FakeDb, over: Row = {}) {
  const row = {
    xero_invoice_id: "inv-1",
    invoice_number: "INV-1001",
    invoice_type: "ACCREC",
    status: "PAID",
    reference: "SWF-261500-DEP",
    job_id: JOB,
    job_contact_id: null,
    xero_contact_id: "xc-owner",
    contact_name: "Owner Person",
    fully_paid_on: "2026-10-21",
    amount_paid: 550,
    updated_at: "2026-10-21T01:30:00.000Z",
    ...over,
  };
  db.rows("xero_invoices").push(row);
  return row;
}

function party(db: FakeDb, over: Row) {
  db.rows("job_contacts").push({
    job_id: JOB,
    contact_label: null,
    is_primary: false,
    share_percentage: 50,
    removed_at: null,
    status: "active",
    xero_contact_id: null,
    ...over,
  });
}

const events = (db: FakeDb, type: string) =>
  db.rows("job_events").filter((e) => e.event_type === type);

// ── The paid trigger ─────────────────────────────────────────────────────────

Deno.test("a newly paid fencing invoice is emailed by Xero once, keyed by its claim", async () => {
  const { db, deps, emails } = setup();
  invoice(db);
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "sent");
  assertEquals(emails, [{ xeroInvoiceId: "inv-1", idempotencyKey: "claim-1" }]);
  const claim = db.rows("job_receipt_claims")[0];
  assertEquals(claim.id, "claim-1");
  assertEquals(claim.status, "sent");
  assertEquals(claim.invoice_number, "INV-1001");
  const sent = events(db, "receipt_sent");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].detail_json.invoice_number, "INV-1001");
  assertEquals(sent[0].detail_json.xero_contact_id, "xc-owner");
  assertEquals(sent[0].detail_json.claim_id, "claim-1");
  // Evidence through the one SQL writer, keyed on the invoice.
  assertEquals(db.rpcs.length, 1);
  assertEquals(db.rpcs[0].name, "capture_business_event");
  assertEquals(
    db.rpcs[0].args.p_row.provider_message_id,
    "xero:invoice:inv-1:receipt",
  );
  assertEquals(db.rpcs[0].args.p_row.metadata.capture_mode, "live");
  assertEquals(db.rpcs[0].args.p_row.job_id, JOB);
});

Deno.test("a patio deposit counts: every paid invoice is receipted, not only finals", async () => {
  const { db, deps, emails } = setup({ jobType: "patio" });
  invoice(db, { reference: "SWP-26200-DEP" });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "sent");
  assertEquals(emails.length, 1);
});

Deno.test("an invoice that is not paid, not a sales invoice or on no job is never emailed", async () => {
  const { db, deps, emails } = setup();
  invoice(db, { xero_invoice_id: "inv-unpaid", status: "AUTHORISED" });
  invoice(db, { xero_invoice_id: "inv-bill", invoice_type: "ACCPAY" });
  invoice(db, { xero_invoice_id: "inv-nojob", job_id: null });
  const t = { trigger: "xero_sync" };
  assertEquals(
    (await requestInvoiceReceipt(deps, { ...t, xero_invoice_id: "inv-unpaid" }))
      .action,
    "not_paid",
  );
  assertEquals(
    (await requestInvoiceReceipt(deps, { ...t, xero_invoice_id: "inv-bill" }))
      .action,
    "not_sales_invoice",
  );
  assertEquals(
    (await requestInvoiceReceipt(deps, { ...t, xero_invoice_id: "inv-nojob" }))
      .action,
    "no_job",
  );
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_receipt_claims").length, 0);
});

// ── Builder, insurer, make-safe and repair jobs ──────────────────────────────

Deno.test("builder, insurance, make-safe and repair jobs, and sealed SES cards, are never receipted", async () => {
  for (const type of ["makesafe", "repair", "insurance", "miscellaneous"]) {
    const { db, deps, emails } = setup({ jobType: type });
    invoice(db);
    const r = await requestInvoiceReceipt(deps, {
      xero_invoice_id: "inv-1",
      trigger: "xero_sync",
    });
    assertEquals(r.action, "not_closeout_type", type);
    assertEquals(emails.length, 0);
    assertEquals(db.rows("job_events").length, 0);
  }
  const { db, deps, emails } = setup();
  db.rows("jobs")[0].ses_money_sealed_at = "2026-08-01T00:00:00Z";
  invoice(db);
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "ses_sealed");
  assertEquals(emails.length, 0);
});

// ── The window: 30 days and the start instant ────────────────────────────────

Deno.test("an invoice fully paid more than 30 days ago is never emailed", async () => {
  const { db, deps, emails } = setup({ since: "2026-09-01T00:00:00.000Z" });
  invoice(db, { fully_paid_on: "2026-09-19" });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "paid_too_long_ago");
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_events").length, 0);
});

Deno.test("only invoices paid after the switch's mode began are in scope: no history is caught up", async () => {
  const { db, deps, emails } = setup();
  invoice(db, { xero_invoice_id: "inv-old", fully_paid_on: "2026-10-19" });
  // Paid on the start day, but last changed in Xero before the switch: history.
  invoice(db, {
    xero_invoice_id: "inv-sameday-before",
    fully_paid_on: "2026-10-20",
    updated_at: "2026-10-20T00:30:00.000Z",
  });
  // Paid on the start day after the switch.
  invoice(db, {
    xero_invoice_id: "inv-sameday-after",
    fully_paid_on: "2026-10-20",
    updated_at: "2026-10-20T03:00:00.000Z",
  });
  const t = { trigger: "xero_sync" };
  assertEquals(
    (await requestInvoiceReceipt(deps, { ...t, xero_invoice_id: "inv-old" }))
      .action,
    "paid_before_start",
  );
  assertEquals(
    (await requestInvoiceReceipt(deps, {
      ...t,
      xero_invoice_id: "inv-sameday-before",
    })).action,
    "paid_before_start",
  );
  assertEquals(
    (await requestInvoiceReceipt(deps, {
      ...t,
      xero_invoice_id: "inv-sameday-after",
    })).action,
    "sent",
  );
  assertEquals(emails.map((e) => e.xeroInvoiceId), ["inv-sameday-after"]);
});

Deno.test("receiptWindowMiss reads the start instant as its Perth day", () => {
  // 19 Oct 2026 20:00 UTC is 20 Oct 04:00 in Perth.
  const since = "2026-10-19T20:00:00.000Z";
  assertEquals(
    receiptWindowMiss(
      { fully_paid_on: "2026-10-19", updated_at: null },
      since,
      NOW,
    ),
    "paid_before_start",
  );
  assertEquals(
    receiptWindowMiss(
      { fully_paid_on: "2026-10-20", updated_at: "2026-10-19T21:00:00Z" },
      since,
      NOW,
    ),
    null,
  );
  assertEquals(
    receiptWindowMiss({ fully_paid_on: null, updated_at: null }, since, NOW),
    "no_paid_date",
  );
});

// ── Once only, and outcomes ──────────────────────────────────────────────────

Deno.test("a second trigger for the same invoice sends nothing: one email per invoice, ever", async () => {
  const { db, deps, emails } = setup();
  invoice(db);
  await requestInvoiceReceipt(deps, { xero_invoice_id: "inv-1", trigger: "a" });
  const again = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "b",
  });
  assertEquals(again.action, "already_claimed");
  const sweep = await receiptCatchUp(deps, {});
  assertEquals(sweep.results?.length, 0);
  assertEquals(emails.length, 1);
  assertEquals(events(db, "receipt_sent").length, 1);
});

Deno.test("a claim taken by a racing run stops the send at the insert", async () => {
  const { db, deps, emails } = setup();
  invoice(db);
  // The race: another run's claim lands after our claim read answered "none".
  const realFrom = db.from.bind(db);
  let raced = false;
  db.from = (t: string) => {
    if (t === "job_receipt_claims" && !raced) {
      raced = true;
      db.rows("job_receipt_claims").push({
        id: "other",
        xero_invoice_id: "inv-1",
        status: "claimed",
      });
      const empty = { data: null, error: null };
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(empty) }),
        }),
      } as any;
    }
    return realFrom(t);
  };
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "already_claimed");
  assertEquals(emails.length, 0);
});

Deno.test("an unknown outcome is kept as unconfirmed and never retried", async () => {
  const { db, deps, emails, setResult } = setup();
  invoice(db);
  setResult(() => ({ outcome: "unknown", error: "timeout" }));
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "unconfirmed");
  assertEquals(db.rows("job_receipt_claims")[0].status, "unconfirmed");
  assertEquals(
    events(db, "receipt_not_sent")[0].detail_json.reason,
    "unconfirmed",
  );
  setResult(() => ({ outcome: "sent" }));
  await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "again",
  });
  await receiptCatchUp(deps, {});
  assertEquals(emails.length, 1);
  assertEquals(db.rpcs.length, 0);
});

Deno.test("a thrown email call counts as unknown and keeps its claim", async () => {
  const { db, deps } = setup();
  invoice(db);
  deps.emailInvoice = () => Promise.reject(new Error("socket hang up"));
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "unconfirmed");
  assertEquals(db.rows("job_receipt_claims")[0].status, "unconfirmed");
});

Deno.test("a Xero refusal is kept for staff and never retried", async () => {
  const { db, deps, emails, setResult } = setup();
  invoice(db);
  setResult(() => ({
    outcome: "refused",
    error: "HTTP 400: The contact has no email address",
  }));
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "refused");
  const claim = db.rows("job_receipt_claims")[0];
  assertEquals(claim.status, "refused");
  assertStringIncludes(claim.error, "no email address");
  assertEquals(
    events(db, "receipt_not_sent")[0].detail_json.reason,
    "xero_refused",
  );
  await receiptCatchUp(deps, {});
  assertEquals(emails.length, 1);
});

Deno.test("an answer that proves Xero never took the request releases the claim; the next run sends", async () => {
  const { db, deps, emails, setResult } = setup();
  invoice(db);
  setResult(() => ({ outcome: "not_sent", error: "HTTP 429" }));
  const first = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(first.action, "retry_later");
  assertEquals(db.rows("job_receipt_claims").length, 0);
  assertEquals(db.rows("job_events").length, 0);
  setResult(() => ({ outcome: "sent" }));
  const sweep = await receiptCatchUp(deps, {});
  assertEquals(sweep.results?.map((r) => r.action), ["sent"]);
  assertEquals(emails.map((e) => e.idempotencyKey), ["claim-1", "claim-2"]);
});

// ── The wrong-party guard ────────────────────────────────────────────────────

function multiPayer(db: FakeDb, bContact: string | null) {
  party(db, {
    id: "p-a",
    contact_label: "A",
    is_primary: true,
    xero_contact_id: "xc-a",
  });
  party(db, { id: "p-b", contact_label: "B", xero_contact_id: bContact });
}

Deno.test("wrong party: B's invoice on A's Xero contact is refused, recorded once, and nothing sent", async () => {
  const { db, deps, emails } = setup();
  multiPayer(db, "xc-b");
  invoice(db, { reference: "SWF-261500-B-FINBAL", xero_contact_id: "xc-a" });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "refused");
  assertEquals(r.reason, "xero_contact_mismatch");
  await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "again",
  });
  const notSent = events(db, "receipt_not_sent");
  assertEquals(notSent.length, 1);
  assertEquals(notSent[0].detail_json.reason, "xero_contact_mismatch");
  assertEquals(notSent[0].detail_json.invoice_number, "INV-1001");
  assertEquals(emails.length, 0);
  // Nothing claimed: once staff put the invoice on B's contact, the next run sends.
  assertEquals(db.rows("job_receipt_claims").length, 0);
  db.rows("xero_invoices")[0].xero_contact_id = "xc-b";
  const fixed = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "fixed",
  });
  assertEquals(fixed.action, "sent");
  assertEquals(emails.length, 1);
});

Deno.test("wrong party: a party with no Xero contact, a shared contact or an unmatched invoice is refused", () => {
  const paying = [
    {
      id: "p-a",
      contact_label: "A",
      is_primary: true,
      share_percentage: 50,
      removed_at: null,
      xero_contact_id: "xc-a",
    },
    {
      id: "p-b",
      contact_label: "B",
      is_primary: false,
      share_percentage: 50,
      removed_at: null,
      xero_contact_id: null,
    },
  ];
  const inv = (over: Record<string, unknown>) => ({
    job_contact_id: null,
    reference: null,
    xero_contact_id: "xc-a",
    ...over,
  });
  assertEquals(
    receiptPartyCheck(inv({ job_contact_id: "p-b" }), paying),
    { ok: false, reason: "party_xero_contact_unknown" },
  );
  assertEquals(
    receiptPartyCheck(
      inv({ job_contact_id: "p-b" }),
      [paying[0], { ...paying[1], xero_contact_id: "xc-a" }],
    ),
    { ok: false, reason: "xero_contact_shared" },
  );
  assertEquals(
    receiptPartyCheck(inv({ job_contact_id: "p-gone" }), paying),
    { ok: false, reason: "party_unmatched" },
  );
  assertEquals(
    receiptPartyCheck(inv({ xero_contact_id: null }), paying),
    { ok: false, reason: "no_xero_contact" },
  );
  assertEquals(
    receiptPartyCheck(inv({ reference: "SWF-1-A-DEP" }), paying),
    { ok: true, party_id: "p-a", party_label: "A" },
  );
  // A one-payer job sends to the invoice's own Xero contact.
  assertEquals(
    receiptPartyCheck(inv({ xero_contact_id: "xc-other" }), [paying[0]]),
    { ok: true, party_id: "p-a", party_label: "A" },
  );
  // ...unless the invoice names its party: then it must sit on that party's contact.
  assertEquals(
    receiptPartyCheck(inv({ job_contact_id: "p-a" }), [paying[0]]),
    { ok: true, party_id: "p-a", party_label: "A" },
  );
  assertEquals(
    receiptPartyCheck(
      inv({ job_contact_id: "p-a", xero_contact_id: "xc-other" }),
      [paying[0]],
    ),
    { ok: false, reason: "xero_contact_mismatch" },
  );
  // A named party that is removed or has a zero share pays nothing.
  for (const gone of [{ removed_at: "2026-10-01" }, { share_percentage: 0 }]) {
    assertEquals(
      receiptPartyCheck(inv({ job_contact_id: "p-b" }), [
        paying[0],
        { ...paying[1], xero_contact_id: "xc-a", ...gone },
      ]),
      { ok: false, reason: "party_unmatched" },
    );
  }
});

Deno.test("wrong party on a one-payer job: an invoice naming its party on another Xero contact is refused", async () => {
  const { db, deps, emails } = setup();
  party(db, {
    id: "p-a",
    contact_label: "A",
    is_primary: true,
    share_percentage: 100,
    xero_contact_id: "xc-owner",
  });
  invoice(db, { job_contact_id: "p-a", xero_contact_id: "xc-elsewhere" });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "refused");
  assertEquals(r.reason, "xero_contact_mismatch");
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_receipt_claims").length, 0);
  db.rows("xero_invoices")[0].xero_contact_id = "xc-owner";
  const fixed = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "fixed",
  });
  assertEquals(fixed.action, "sent");
  assertEquals(emails.length, 1);
});

Deno.test("an invoice naming a removed party is refused, and nothing sent", async () => {
  const { db, deps, emails } = setup();
  party(db, {
    id: "p-a",
    contact_label: "A",
    is_primary: true,
    share_percentage: 100,
    xero_contact_id: "xc-owner",
  });
  party(db, {
    id: "p-gone",
    contact_label: "B",
    removed_at: "2026-10-01T00:00:00.000Z",
    status: "removed",
    xero_contact_id: "xc-owner",
  });
  invoice(db, { job_contact_id: "p-gone" });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.reason, "party_unmatched");
  assertEquals(emails.length, 0);
  assertEquals(
    events(db, "receipt_not_sent")[0].detail_json.reason,
    "party_unmatched",
  );
});

// ── Paid by the customer, not by credit ──────────────────────────────────────

Deno.test("a PAID invoice settled wholly by credit is skipped as credit_settled, recorded once", async () => {
  const { db, deps, emails } = setup();
  invoice(db, { amount_paid: 0 });
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "refused");
  assertEquals(r.reason, "credit_settled");
  await requestInvoiceReceipt(deps, { xero_invoice_id: "inv-1", trigger: "x" });
  const notSent = events(db, "receipt_not_sent");
  assertEquals(notSent.length, 1);
  assertEquals(notSent[0].detail_json.reason, "credit_settled");
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_receipt_claims").length, 0);
});

Deno.test("dry run shows a credit-settled invoice as credit_settled", async () => {
  const { db, deps, emails } = setup({ mode: "dry_run" });
  invoice(db, { amount_paid: 0 });
  await requestInvoiceReceipt(deps, { xero_invoice_id: "inv-1", trigger: "x" });
  const dry = events(db, "receipt_dry_run");
  assertEquals(dry.length, 1);
  assertEquals(dry[0].detail_json.would, "credit_settled");
  assertEquals(emails.length, 0);
});

// ── Holds and our own guards ─────────────────────────────────────────────────

Deno.test("a job in Rectification or marked as a callback is not sent a receipt", async () => {
  for (const hold of ["rectification", "callback"] as const) {
    const { db, deps, emails } = setup({
      jobStatus: hold === "rectification" ? "rectification" : "invoiced",
    });
    if (hold === "callback") db.rows("jobs")[0].is_callback = true;
    invoice(db);
    const r = await requestInvoiceReceipt(deps, {
      xero_invoice_id: "inv-1",
      trigger: "xero_sync",
    });
    assertEquals(r.reason, `held_${hold}`);
    assertEquals(emails.length, 0);
    assertEquals(db.rows("job_receipt_claims").length, 0);
    assertEquals(
      events(db, "receipt_not_sent")[0].detail_json.reason,
      `held_${hold}`,
    );
  }
});

Deno.test("ops-api's own send guards refuse by code, and nothing is sent", async () => {
  const { db, deps, emails } = setup();
  invoice(db);
  deps.preSendGuard = () => Promise.resolve("sealed_ses_money");
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.reason, "guard_sealed_ses_money");
  assertEquals(emails.length, 0);
});

// ── The switch ───────────────────────────────────────────────────────────────

Deno.test("off does nothing: no read of the invoice, no event, no claim, no email", async () => {
  const { db, deps, emails } = setup({ mode: "off" });
  invoice(db);
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "sender_off");
  const sweep = await receiptCatchUp(deps, {});
  assertEquals(sweep.ran, false);
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_events").length, 0);
  assertEquals(db.rows("job_receipt_claims").length, 0);
});

Deno.test("a mode with no start instant, or an unreadable switch, reads as off", async () => {
  const noSince = setup({ mode: "live", since: null });
  assertEquals((await readReceiptSwitch(noSince.deps)).mode, "off");
  const unreadable = setup();
  unreadable.db.failures.job_closeout_settings = "boom";
  const sw = await readReceiptSwitch(unreadable.deps);
  assertEquals(sw.mode, "off");
  assertEquals(sw.read_ok, false);
});

Deno.test("dry run sends nothing and logs one receipt_dry_run naming the invoice and Xero contact", async () => {
  const { db, deps, emails } = setup({ mode: "dry_run" });
  invoice(db);
  const r = await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "xero_sync",
  });
  assertEquals(r.action, "dry_run");
  await requestInvoiceReceipt(deps, {
    xero_invoice_id: "inv-1",
    trigger: "again",
  });
  await receiptCatchUp(deps, {});
  const dry = events(db, "receipt_dry_run");
  assertEquals(dry.length, 1);
  assertEquals(dry[0].detail_json.would, "send");
  assertEquals(dry[0].detail_json.invoice_number, "INV-1001");
  assertEquals(dry[0].detail_json.xero_contact_id, "xc-owner");
  assertEquals(dry[0].detail_json.contact_name, "Owner Person");
  assertEquals(emails.length, 0);
  assertEquals(db.rows("job_receipt_claims").length, 0);
  assertEquals(db.rpcs.length, 0);
});

Deno.test("dry run records a refusal as what it would do", async () => {
  const { db, deps, emails } = setup({ mode: "dry_run" });
  multiPayer(db, "xc-b");
  invoice(db, { reference: "SWF-261500-B-FINBAL", xero_contact_id: "xc-a" });
  await requestInvoiceReceipt(deps, { xero_invoice_id: "inv-1", trigger: "x" });
  const dry = events(db, "receipt_dry_run");
  assertEquals(dry.length, 1);
  assertEquals(dry[0].detail_json.would, "xero_contact_mismatch");
  assertEquals(events(db, "receipt_not_sent").length, 0);
  assertEquals(emails.length, 0);
});

// ── The catch-up ─────────────────────────────────────────────────────────────

Deno.test("the catch-up sends in-window unclaimed fencing and patio invoices only", async () => {
  const { db, deps, emails } = setup();
  db.rows("jobs").push({
    id: "job-ms",
    job_number: "SWMS-261300",
    type: "makesafe",
    status: "invoiced",
    is_callback: false,
  });
  invoice(db, { xero_invoice_id: "inv-fence" });
  invoice(db, { xero_invoice_id: "inv-ms", job_id: "job-ms" });
  invoice(db, { xero_invoice_id: "inv-old", fully_paid_on: "2026-10-01" });
  invoice(db, { xero_invoice_id: "inv-open", status: "AUTHORISED" });
  invoice(db, { xero_invoice_id: "inv-credit", amount_paid: 0 });
  const sweep = await receiptCatchUp(deps, {});
  assert(sweep.ran);
  assertEquals(emails.map((e) => e.xeroInvoiceId), ["inv-fence"]);
});

Deno.test("the catch-up records a claim stuck in flight as unconfirmed, never re-sent", async () => {
  const { db, deps, emails } = setup();
  invoice(db);
  db.rows("job_receipt_claims").push({
    id: "old",
    xero_invoice_id: "inv-1",
    status: "claimed",
    claimed_at: "2026-10-21T00:00:00.000Z",
  });
  const sweep = await receiptCatchUp(deps, {});
  assertEquals(sweep.stuck_claims_settled, 1);
  assertEquals(db.rows("job_receipt_claims")[0].status, "unconfirmed");
  assertEquals(emails.length, 0);
});

// ── Dispatch ─────────────────────────────────────────────────────────────────

Deno.test("both actions are server key only and POST only", async () => {
  const { deps, db, emails } = setup();
  invoice(db);
  for (const kind of ["staff", "none"] as const) {
    const r = await runJobReceiptAction(
      "job_receipt_paid",
      "POST",
      { xero_invoice_id: "inv-1" },
      { kind },
      deps,
    );
    assertEquals(r.status, 403);
  }
  assertEquals(
    (await runJobReceiptAction("job_receipt_catch_up", "GET", {}, {
      kind: "server",
    }, deps)).status,
    405,
  );
  assertEquals(emails.length, 0);
  const ok = await runJobReceiptAction(
    "job_receipt_paid",
    "POST",
    { xero_invoice_id: "inv-1", source: "xero_sync" },
    { kind: "server" },
    deps,
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.body.action, "sent");
});

// ── The Xero call ────────────────────────────────────────────────────────────

function emailer(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = xeroReceiptEmailer({
    getToken: () => Promise.resolve({ accessToken: "tok", tenantId: "ten" }),
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(respond());
    },
    baseUrl: "https://api.xero.com/api.xro/2.0",
  });
  return { send, calls };
}

Deno.test("the Xero call: one POST /Invoices/{id}/Email with the claim id as Idempotency-Key", async () => {
  const { send, calls } = emailer(() => new Response(null, { status: 204 }));
  assertEquals(
    await send({ xeroInvoiceId: "inv-1", idempotencyKey: "claim-1" }),
    { outcome: "sent" },
  );
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://api.xero.com/api.xro/2.0/Invoices/inv-1/Email",
  );
  assertEquals(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["Idempotency-Key"], "claim-1");
  assertEquals(headers["Xero-tenant-id"], "ten");
});

Deno.test("the Xero call: rate limit and auth are not sent; 4xx is refused; 5xx is unknown", async () => {
  for (const status of [429, 401, 403]) {
    const { send } = emailer(() => new Response("", { status }));
    assertEquals(
      (await send({ xeroInvoiceId: "i", idempotencyKey: "k" })).outcome,
      "not_sent",
      String(status),
    );
  }
  const refusal = emailer(() =>
    new Response(
      JSON.stringify({
        Elements: [{
          ValidationErrors: [{ Message: "The contact has no email address" }],
        }],
      }),
      { status: 400 },
    )
  );
  const refused = await refusal.send({
    xeroInvoiceId: "i",
    idempotencyKey: "k",
  });
  assertEquals(refused.outcome, "refused");
  assertStringIncludes(
    (refused as { error: string }).error,
    "The contact has no email address",
  );
  const { send } = emailer(() => new Response("", { status: 503 }));
  assertEquals(
    (await send({ xeroInvoiceId: "i", idempotencyKey: "k" })).outcome,
    "unknown",
  );
});

Deno.test("the Xero call: a cooldown refusal is not sent, a timeout is unknown, no token is not sent", async () => {
  const cooled = xeroReceiptEmailer({
    getToken: () => Promise.resolve({ accessToken: "t", tenantId: "x" }),
    fetch: () =>
      Promise.reject(
        Object.assign(new Error("cooldown"), {
          code: "XERO_COOLDOWN_ACTIVE",
          details: { provider_call_made: false },
        }),
      ),
    baseUrl: "https://api.xero.com/api.xro/2.0",
  });
  assertEquals(
    await cooled({ xeroInvoiceId: "i", idempotencyKey: "k" }),
    { outcome: "not_sent", error: "XERO_COOLDOWN_ACTIVE" },
  );
  const timedOut = xeroReceiptEmailer({
    getToken: () => Promise.resolve({ accessToken: "t", tenantId: "x" }),
    fetch: () =>
      Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
    baseUrl: "https://api.xero.com/api.xro/2.0",
  });
  assertEquals(
    await timedOut({ xeroInvoiceId: "i", idempotencyKey: "k" }),
    { outcome: "unknown", error: "timeout" },
  );
  const noToken = xeroReceiptEmailer({
    getToken: () => Promise.reject(new Error("no token")),
    fetch: () => Promise.reject(new Error("never called")),
    baseUrl: "https://api.xero.com/api.xro/2.0",
  });
  assertEquals(
    (await noToken({ xeroInvoiceId: "i", idempotencyKey: "k" })).outcome,
    "not_sent",
  );
});
