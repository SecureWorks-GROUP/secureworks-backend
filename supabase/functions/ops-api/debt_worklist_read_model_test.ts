// deno-lint-ignore-file no-explicit-any require-await no-import-prefix
//
// Debtor work list (debt redesign PR 3, review 24 Sep 2026).
//
// Pins:
//   1. Synthetic book (fixtures/debt_worklist_synthetic_book_v1.json: fabricated
//      ids and amounts, the real book's shapes): every open invoice id appears
//      exactly once, the unlinked included; totals, overdue and debtor counts
//      match an independent count of the same rows; the invoice whose mirror
//      contact id disagrees with its Xero payload stands alone. The same check
//      runs read-only against the live book when credentials are present.
//   2. Grouping is by verified Xero contact only: a shared name never joins two
//      contacts, a contact with two names stays one debtor, no contact stands alone.
//   3. A source that cannot be read is a fault on the row, never a clean zero or
//      an empty list; a book that cannot be read refuses the call.
//   4. One timeline per debtor: stored messages, GHL notes, debt notes, calls and
//      Xero events merged newest first, each with provider, id, time, direction,
//      author and source; the same message seen twice appears once.
//   5. Summary counts name their denominator; the next step names its invoice.
//   6. The read is SELECT-only (the fake client has no write methods).
//   7. getJobConversation's opt-in report_faults names failed sources and adds
//      provider ids, and leaves the default response unchanged.
//   8. Captured facts are timeline entries; a no-job GHL contact match is read;
//      GHL, email and notes publish status, last success, stale after, owner and
//      recovery; a failed link read is never a complete timeline; another org's
//      signed-in caller is refused before any read.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  debtorIdentityFor,
  debtorNextStep,
  debtWorklist,
  DebtWorklistError,
  entryFromChaseLog,
  entryFromConversation,
  mergeTimeline,
} from "./debt_worklist_read_model.ts";
import { isCurrentContextFact } from "./context_visibility.ts";
import { _getJobConversationForTest } from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-24T02:00:00.000Z");

type Tables = Record<string, any[]>;

// ── fake PostgREST client (read-only) ───────────────────────────────────────

function pick(row: any, src: string): any {
  const parts = src.split(/->>?/).map((p) => p.trim());
  let v = row[parts[0]];
  for (const p of parts.slice(1)) v = v == null ? undefined : v[p];
  if (
    src.includes("->>") && v !== undefined && v !== null &&
    typeof v !== "string"
  ) v = String(v);
  return v ?? null;
}

function fakeClient(tables: Tables, failing: Set<string> = new Set()) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const filters: Array<(row: any) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let range: { from: number; to: number } | null = null;
      let selected: Array<{ out: string; src: string }> | null = null;
      let single = false;
      const q: any = {};
      const chain = (fn: (...a: any[]) => void) => (...args: any[]) => {
        fn(...args);
        return q;
      };
      q.select = chain((cols?: string) => {
        if (typeof cols !== "string" || cols.trim() === "*") return;
        selected = cols.split(",").map((part) => {
          const piece = part.trim();
          const colon = piece.indexOf(":");
          return colon > 0
            ? {
              out: piece.slice(0, colon).trim(),
              src: piece.slice(colon + 1).trim(),
            }
            : { out: piece, src: piece };
        });
      });
      q.eq = chain((c: string, v: any) => filters.push((r) => r[c] === v));
      q.neq = chain((c: string, v: any) => filters.push((r) => r[c] !== v));
      q.gt = chain((c: string, v: any) =>
        filters.push((r) => r[c] != null && r[c] > v)
      );
      q.lt = chain((c: string, v: any) =>
        filters.push((r) => r[c] != null && r[c] < v)
      );
      q.in = chain((c: string, v: any[]) =>
        filters.push((r) => v.includes(r[c]))
      );
      q.ilike = chain((c: string, v: string) =>
        filters.push((r) =>
          String(r[c] ?? "").toLowerCase() === v.toLowerCase()
        )
      );
      q.order = chain((c: string, o: any) => {
        order = { col: c, asc: o?.ascending !== false };
      });
      q.limit = chain((n: number) => {
        limit = n;
      });
      q.range = chain((from: number, to: number) => {
        range = { from, to };
      });
      const run = () => {
        if (failing.has(table)) {
          return { data: null, error: { message: `${table} unavailable` } };
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        if (order) {
          const o = order as { col: string; asc: boolean };
          rows = [...rows].sort((a, b) =>
            (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) *
            (o.asc ? 1 : -1)
          );
        }
        if (limit !== null) rows = rows.slice(0, limit);
        if (range) {
          rows = rows.slice((range as any).from, (range as any).to + 1);
        }
        if (selected) {
          const sel = selected as Array<{ out: string; src: string }>;
          rows = rows.map((r) => {
            const out: any = {};
            for (const c of sel) out[c.out] = pick(r, c.src);
            return out;
          });
        }
        rows = rows.slice(0, 1000);
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.then = (resolve: any, reject: any) =>
        Promise.resolve(run()).then(resolve, reject);
      return q;
    },
  };
}

function conversationStub(
  byJob: Record<string, any[]>,
  faults: Record<string, string[]> = {},
) {
  const calls: any[] = [];
  const fn = async (_client: any, body: any) => {
    calls.push(body);
    return {
      messages: (byJob[body.job_id] ?? []).slice(0, body.limit),
      read_faults: faults[body.job_id] ?? [],
    };
  };
  return { fn, calls };
}

function deps(
  client: any,
  conv = conversationStub({}).fn,
  orgId = ORG,
  now = NOW,
) {
  return {
    client,
    orgId,
    getJobConversation: conv,
    isCurrentContextFact,
    now: () => now,
  };
}

// ── unit fixture ────────────────────────────────────────────────────────────

const JOB_A = "a0000000-0000-4000-8000-00000000000a";
const JOB_B = "a0000000-0000-4000-8000-00000000000b";
const INV = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function invoice(n: number, over: Record<string, any>) {
  const contact = over.xero_contact_id === undefined
    ? "xc-1"
    : over.xero_contact_id;
  return {
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: INV(n),
    xero_contact_id: contact,
    contact_name: "Shared Name Pty",
    invoice_number: `INV-${1000 + n}`,
    reference: null,
    status: "AUTHORISED",
    total: 100,
    amount_due: 100,
    amount_paid: 0,
    invoice_date: "2026-08-01",
    due_date: "2026-08-15",
    job_id: null,
    job_number: null,
    synced_at: "2026-09-24T01:00:00.000Z",
    raw_json: {
      Contact: { ContactID: contact },
      SentToContact: true,
      Payments: [],
    },
    ...over,
  };
}

function unitTables(): Tables {
  return {
    xero_invoices: [
      // Debtor xc-1: two invoices on job A, one on job B, one unlinked.
      invoice(1, {
        job_id: JOB_A,
        amount_due: 300,
        total: 500,
        amount_paid: 200,
        due_date: "2026-07-01",
        debt_owner: "DEBT",
        debt_next_action: "Call about the balance",
        debt_next_action_at: "2026-09-30",
        raw_json: {
          Contact: { ContactID: "xc-1" },
          SentToContact: true,
          Payments: [{
            PaymentID: "pay-1",
            Date: "/Date(1756684800000+0000)/",
            Amount: 200,
          }],
        },
      }),
      invoice(2, {
        job_id: JOB_A,
        amount_due: 900,
        debt_owner: "BOOKKEEPING",
        debt_next_action: "Check allocation",
        debt_next_action_at: "2026-09-25",
      }),
      invoice(3, { job_id: JOB_B, amount_due: 50, due_date: "2026-10-30" }),
      invoice(4, { job_id: null, amount_due: 20 }),
      // Same name, different Xero contact: its own debtor.
      invoice(5, { xero_contact_id: "xc-2", amount_due: 40 }),
      // Same contact, second name: still debtor xc-2.
      invoice(6, {
        xero_contact_id: "xc-2",
        contact_name: "Renamed Pty",
        amount_due: 60,
      }),
      // Mirror and Xero payload disagree: stands alone.
      invoice(7, {
        xero_contact_id: "xc-2",
        amount_due: 70,
        raw_json: { Contact: { ContactID: "xc-9" }, Payments: [] },
      }),
      // No contact: stands alone.
      invoice(8, {
        xero_contact_id: null,
        amount_due: 80,
        raw_json: { Payments: [] },
      }),
      // Not open: never shown.
      invoice(9, { status: "PAID", amount_due: 0 }),
      invoice(10, { invoice_type: "ACCPAY", amount_due: 999 }),
    ],
    jobs: [
      {
        id: JOB_A,
        job_number: "SWP-26001",
        ghl_contact_id: "ghl-a",
        status: "complete",
        type: "patio",
      },
      {
        id: JOB_B,
        job_number: "SWF-26002",
        ghl_contact_id: "ghl-b",
        status: "complete",
        type: "fencing",
      },
    ],
    contact_matches: [],
    current_job_context_facts: [{
      id: "f1",
      job_id: JOB_A,
      kind: "payment_promise",
      provenance: { extractor: "context-luna-subscription:v1" },
      _context_store: "job_context",
    }],
    extraction_jobs: [],
    ghl_conversation_cache: [{
      contact_id: "ghl-a",
      job_id: JOB_A,
      message_count: 2,
      synced_at: "2026-09-20T00:00:00Z",
    }],
    inbox_events: [],
    job_events: [],
    business_events: [
      {
        id: "ev-emailed",
        event_type: "invoice.emailed",
        entity_type: "xero_invoice",
        entity_id: INV(2),
        job_id: JOB_A,
        occurred_at: "2026-08-02T01:00:00.000Z",
        payload: { to_email: "accounts@example.test" },
      },
    ],
    payment_chase_logs: [
      {
        id: "c-note",
        xero_invoice_id: INV(1),
        job_id: JOB_A,
        method: "note",
        outcome: "promised",
        notes: "Said Friday",
        chased_by: "desk@example.test",
        created_at: "2026-09-10T02:00:00.000Z",
      },
      {
        id: "c-sms",
        xero_invoice_id: INV(2),
        job_id: JOB_A,
        method: "sms",
        outcome: "SMS sent",
        notes: "Hi, INV-1002 is overdue.",
        chased_by: "desk@example.test",
        created_at: "2026-09-12T03:00:00.000Z",
      },
      {
        id: "c-call",
        xero_invoice_id: INV(3),
        job_id: JOB_B,
        method: "call",
        outcome: "Promised to pay",
        notes: null,
        chased_by: "desk@example.test",
        created_at: "2026-09-13T03:00:00.000Z",
        follow_up_date: "2026-09-26",
        follow_up_resolved: false,
      },
    ],
  };
}

// Job A's merge: one GHL SMS seen in the cache and as a captured event, the
// outbound chase SMS as the provider saw it, and a staff note.
const JOB_A_MESSAGES = [
  {
    id: "bev:e1",
    channel: "sms",
    direction: "inbound",
    occurred_at: "2026-09-14T01:00:00.000Z",
    author: "Client",
    preview: "Will pay Friday",
    source_system: "business_events",
    source_ref: "e1",
    provider_message_id: "ghl:m1",
  },
  {
    id: "ghl:m1",
    channel: "sms",
    direction: "inbound",
    occurred_at: "2026-09-14T01:00:00.000Z",
    author: "Client",
    preview: "Will pay Friday",
    source_system: "ghl_cache",
    source_ref: "m1",
    provider_message_id: "ghl:m1",
  },
  {
    id: "ghl:m2",
    channel: "sms",
    direction: "outbound",
    occurred_at: "2026-09-12T03:00:05.000Z",
    author: "SecureWorks",
    preview: "Hi,  INV-1002 is overdue.",
    source_system: "ghl_cache",
    source_ref: "m2",
    provider_message_id: "ghl:m2",
  },
  {
    id: "note:n1",
    channel: "note",
    direction: "internal",
    occurred_at: "2026-09-11T00:00:00.000Z",
    author: "staff-1",
    preview: "Client rang",
    source_system: "job_events",
    source_ref: "n1",
  },
];

// ── pins ────────────────────────────────────────────────────────────────────

Deno.test("grouping: verified contact only; a shared name never joins, a conflict or no contact stands alone", async () => {
  const out: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    deps(fakeClient(unitTables())),
  );
  const keys = out.debtors.map((d: any) => d.key).sort();
  assertEquals(
    keys,
    [`invoice:${INV(7)}`, `invoice:${INV(8)}`, "xero:xc-1", "xero:xc-2"].sort(),
  );
  const xc1 = out.debtors.find((d: any) => d.key === "xero:xc-1");
  assertEquals(xc1.invoices.map((i: any) => i.invoice_number).sort(), [
    "INV-1001",
    "INV-1002",
    "INV-1003",
    "INV-1004",
  ]);
  assertEquals(xc1.total_due, 1270);
  assertEquals(xc1.oldest_due_date, "2026-07-01");
  assertEquals(xc1.invoice_count, 4);
  assertEquals(xc1.overdue_count, 3);
  const xc2 = out.debtors.find((d: any) => d.key === "xero:xc-2");
  assertEquals(xc2.identity.names, ["Renamed Pty", "Shared Name Pty"]);
  assertEquals(xc2.identity.name_variants, true);
  const conflict = out.debtors.find((d: any) => d.key === `invoice:${INV(7)}`);
  assertEquals(conflict.identity.status, "contact_conflict");
  assert(conflict.identity.detail.includes("xc-9"));
  assertEquals(
    out.debtors.find((d: any) => d.key === `invoice:${INV(8)}`).identity.status,
    "no_contact",
  );
  // Every open invoice once; paid and payable never.
  assertEquals(out.reconciliation.exactly_once, true);
  assertEquals(out.reconciliation.book_invoice_ids, 8);
  assertEquals(out.reconciliation.shown_invoice_ids, 8);
  assertEquals(out.faults, []);
});

Deno.test("invoice rows: link, next step and owner, freshness, chase and as-of on every row", async () => {
  const out: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    deps(fakeClient(unitTables())),
  );
  const rows = out.debtors.flatMap((d: any) => d.invoices);
  for (const r of rows) {
    assertEquals(r.as_of, NOW.toISOString());
    assert(["linked", "ambiguous", "none", "unknown"].includes(r.link.status));
    assert(typeof r.xero.fresh === "boolean");
    assertEquals(r.faults, []);
  }
  const unlinked = rows.find((r: any) => r.invoice_number === "INV-1004");
  assertEquals(unlinked.link.status, "none");
  assertEquals(unlinked.context.facts, "no_job");
  const inv1 = rows.find((r: any) => r.invoice_number === "INV-1001");
  assertEquals(inv1.link, {
    status: "linked",
    method: "invoice.job_id",
    job_id: JOB_A,
    job_number: "SWP-26001",
    candidates: [],
  });
  assertEquals(inv1.ghl_contact_id, "ghl-a");
  assertEquals(inv1.context.facts, "present");
  assertEquals(inv1.chase.count, 1);
  const inv3 = rows.find((r: any) => r.invoice_number === "INV-1003");
  assertEquals(inv3.next_step.follow_up_date, "2026-09-26");
  assertEquals(inv3.overdue, false);
  const xc1 = out.debtors.find((d: any) => d.key === "xero:xc-1");
  // Earliest dated next action wins, and names the invoice it came from.
  assertEquals(xc1.next_step, {
    action: "Check allocation",
    at: "2026-09-25",
    owner: "BOOKKEEPING",
    from_invoice_id: INV(2),
    from_invoice_number: "INV-1002",
  });
  assertEquals(xc1.link_state, {
    linked: 3,
    ambiguous: 0,
    none: 1,
    unknown: 0,
    job_ids: [JOB_A, JOB_B].sort(),
  });
  // Two bound contacts; job A's cache is 4 days old and job B has none.
  assertEquals(xc1.sources.ghl.status, "stale");
  assertEquals(
    xc1.sources.ghl.contact_ids.map((c: any) => c.ghl_contact_id).sort(),
    ["ghl-a", "ghl-b"],
  );
  assertEquals(xc1.sources.facts.status, "partial");
  assertEquals(xc1.sources.xero.status, "current");
  assertEquals(xc1.sources.notes.debt_notes, 1);
});

Deno.test("summary: every count names its denominator", async () => {
  const out: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    deps(fakeClient(unitTables())),
  );
  const s = out.summary;
  assert(s.invoices.denominator.includes("AUTHORISED or SUBMITTED"));
  assertEquals(s.invoices.count, 8);
  assertEquals(s.invoices.amount_due, 1520);
  assertEquals(s.invoices.overdue, {
    n: 7,
    of: 8,
    denominator: "open_invoices",
    amount_due: 1470,
  });
  assertEquals(s.invoices.link.none, {
    n: 5,
    of: 8,
    denominator: "open_invoices",
  });
  assertEquals(s.invoices.facts.present, {
    n: 2,
    of: 8,
    denominator: "open_invoices",
  });
  assertEquals(s.debtors.count, 4);
  assertEquals(s.debtors.verified, { n: 2, of: 4, denominator: "debtors" });
  assertEquals(s.debtors.standing_alone, {
    n: 2,
    of: 4,
    denominator: "debtors",
  });
});

Deno.test("timeline: one stream, provider ids, the same message seen twice appears once", async () => {
  const conv = conversationStub({ [JOB_A]: JOB_A_MESSAGES });
  const out: any = await debtWorklist(
    new URLSearchParams({ debtor: "xero:xc-1" }),
    deps(fakeClient(unitTables()), conv.fn),
  );
  assertEquals(out.debtors.length, 1);
  // Job A read once although two invoices sit on it; full mode per-job bound.
  assertEquals(conv.calls.filter((c) => c.job_id === JOB_A).length, 1);
  assertEquals(conv.calls[0].report_faults, true);
  assertEquals(conv.calls[0].limit, 100);
  const t = out.debtors[0].timeline;
  assertEquals(t.mode, "full");
  assertEquals(t.order, "newest_first");
  const keys = t.entries.map((e: any) => e.key);
  assertEquals(new Set(keys).size, keys.length);
  // Cache + captured copy of ghl:m1 -> one entry, business event kept, both sources named.
  const m1 = t.entries.filter((e: any) => e.provider_id === "ghl:m1");
  assertEquals(m1.length, 1);
  assertEquals(m1[0].source, "business_events");
  assertEquals(m1[0].seen_in.sort(), ["business_events", "ghl_cache"]);
  assertEquals(m1[0].invoice_ids.sort(), [INV(1), INV(2)].sort());
  // The chase log of the SMS send collapses into the provider's outbound copy.
  const m2 = t.entries.filter((e: any) => e.provider_id === "ghl:m2");
  assertEquals(m2.length, 1);
  assertEquals(m2[0].seen_in.sort(), ["ghl_cache", "payment_chase_logs"]);
  assert(!keys.includes("chase:c-sms"));
  assertEquals(t.duplicates_merged, 2);
  // Every kind in one stream.
  const kinds = new Set(t.entries.map((e: any) => e.kind));
  for (
    const k of [
      "sms",
      "job_note",
      "debt_note",
      "call",
      "invoice_event",
      "xero_invoice_raised",
      "xero_payment",
    ]
  ) {
    assert(kinds.has(k), `timeline has ${k}`);
  }
  for (const e of t.entries) {
    for (
      const f of [
        "provider",
        "provider_id",
        "at",
        "direction",
        "author",
        "source",
        "source_ref",
      ]
    ) {
      assert(f in e, `${e.key} carries ${f}`);
    }
  }
  const pay = t.entries.find((e: any) => e.kind === "xero_payment");
  assertEquals(pay.at, "2025-09-01");
  assertEquals(pay.provider, "xero");
  // Newest first.
  const ats = t.entries.map((e: any) => e.at ?? "");
  assertEquals(ats, [...ats].sort().reverse());
  assertEquals(t.complete, true);
  // Last contact from the timeline, newest provider message either way.
  assertEquals(out.debtors[0].last_contact.last.at, "2026-09-14T01:00:00.000Z");
  assertEquals(
    out.debtors[0].last_contact.last_outbound.at,
    "2026-09-12T03:00:05.000Z",
  );
  // A logged call is contact whichever way it went.
  assert(
    t.entries.some((e: any) =>
      e.kind === "call" && e.source === "payment_chase_logs"
    ),
  );
  assertEquals(
    out.debtors[0].invoices.every((i: any) => i.brief === null),
    true,
  );
});

Deno.test("timeline: recent mode trims per debtor and says so", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `ghl:x${i}`,
    channel: "sms",
    direction: "inbound",
    occurred_at: `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T0${
      i % 10
    }:00:00.000Z`,
    preview: `m${i}`,
    source_system: "ghl_cache",
    source_ref: `x${i}`,
    provider_message_id: `ghl:x${i}`,
  }));
  const out: any = await debtWorklist(
    new URLSearchParams(),
    deps(fakeClient(unitTables()), conversationStub({ [JOB_A]: many }).fn),
  );
  const t = out.debtors.find((d: any) => d.key === "xero:xc-1").timeline;
  assertEquals(t.mode, "recent");
  assertEquals(t.entries.length, 12);
  assertEquals(t.truncated, true);
  assertEquals(t.per_job_cap_reached, ["SWP-26001"]);
  assertEquals(t.complete, false);
});

Deno.test("faults: an unreadable source is a fault on the row, never a clean zero", async () => {
  const out: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    deps(
      fakeClient(
        unitTables(),
        new Set(["payment_chase_logs", "current_job_context_facts"]),
      ),
    ),
  );
  const inv1 = out.debtors.flatMap((d: any) => d.invoices).find((r: any) =>
    r.invoice_number === "INV-1001"
  );
  assertEquals(inv1.chase.count, null);
  assertEquals(inv1.context.facts, "unreadable");
  assert(inv1.faults.some((f: any) => f.source === "notes"));
  assert(inv1.faults.some((f: any) => f.source === "facts"));
  const xc1 = out.debtors.find((d: any) => d.key === "xero:xc-1");
  assertEquals(xc1.sources.notes.status, "unreadable");
  assertEquals(xc1.sources.notes.debt_notes, null);
  assertEquals(xc1.sources.facts.status, "unreadable");
  assertEquals(out.summary.invoices.facts.present.n, 0);
  assertEquals(out.summary.invoices.facts.unknown.n, 3);
  assert(out.faults.some((f: any) => f.source === "notes"));
  // Still every invoice once.
  assertEquals(out.reconciliation.exactly_once, true);
});

Deno.test("faults: a failed context read marks every row unknown, and the book still shows in full", async () => {
  const tables = unitTables();
  const client = fakeClient(tables, new Set(["jobs", "contact_matches"]));
  const out: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    deps(client),
  );
  assertEquals(out.reconciliation.exactly_once, true);
  assertEquals(out.summary.invoices.count, 8);
  const rows = out.debtors.flatMap((d: any) => d.invoices);
  assertEquals(rows.every((r: any) => r.faults.length > 0), true);
  assertEquals(rows.every((r: any) => r.link.status === "unknown"), true);
  assertEquals(out.summary.invoices.link.unknown.n, 8);
  assertEquals(out.summary.invoices.link.none.n, 0);
  assertEquals(out.summary.invoices.facts.no_job.n, 0);
  assertEquals(
    rows.every((r: any) => r.context.blockers.includes("job_link_unreadable")),
    true,
  );
  assertEquals(
    rows.some((r: any) => r.context.blockers.includes("no_job_linked")),
    false,
  );
});

Deno.test("faults: conversation read faults surface on the debtor and its timeline is not complete", async () => {
  const conv = conversationStub({ [JOB_A]: JOB_A_MESSAGES }, {
    [JOB_A]: ["ghl_cache: timeout"],
  });
  const out: any = await debtWorklist(
    new URLSearchParams({ debtor: "xero:xc-1" }),
    deps(fakeClient(unitTables()), conv.fn),
  );
  const d = out.debtors[0];
  assert(
    d.faults.some((f: any) =>
      f.source === "timeline" &&
      f.detail.includes("SWP-26001: ghl_cache: timeout")
    ),
  );
  assertEquals(d.sources.ghl.status, "unreadable");
  assertEquals(d.timeline.complete, false);
  assertEquals(d.last_contact.complete, false);
});

Deno.test("refusals: unreadable book, unknown debtor, bad params", async () => {
  await assertRejects(
    () =>
      debtWorklist(
        new URLSearchParams(),
        deps(fakeClient(unitTables(), new Set(["xero_invoices"]))),
      ),
    DebtWorklistError,
    "nothing is shown rather than an empty book",
  );
  const e404 = await assertRejects(
    () =>
      debtWorklist(
        new URLSearchParams({ debtor: "xero:nobody" }),
        deps(fakeClient(unitTables())),
      ),
    DebtWorklistError,
  );
  assertEquals((e404 as DebtWorklistError).status, 404);
  await assertRejects(
    () =>
      debtWorklist(
        new URLSearchParams({ timeline: "full" }),
        deps(fakeClient(unitTables())),
      ),
    DebtWorklistError,
    "needs one debtor",
  );
  await assertRejects(
    () =>
      debtWorklist(
        new URLSearchParams({ debtor: "name:Shared Name Pty" }),
        deps(fakeClient(unitTables())),
      ),
    DebtWorklistError,
  );
  await assertRejects(
    () =>
      debtWorklist(
        new URLSearchParams({ timeline: "all" }),
        deps(fakeClient(unitTables())),
      ),
    DebtWorklistError,
  );
});

Deno.test("read-only: the fake client has no write methods and the read never needs one", async () => {
  const client = fakeClient(unitTables());
  for (const m of ["insert", "update", "upsert", "delete", "rpc"]) {
    assert(!(m in client));
  }
  await debtWorklist(
    new URLSearchParams(),
    deps(client, conversationStub({ [JOB_A]: JOB_A_MESSAGES }).fn),
  );
  assert(client.reads.includes("xero_invoices"));
});

Deno.test("pure helpers: identity, merge and next step", () => {
  assertEquals(
    debtorIdentityFor({
      xero_invoice_id: "i",
      xero_contact_id: "c",
      raw_contact_id: "c",
    }).key,
    "xero:c",
  );
  assertEquals(
    debtorIdentityFor({
      xero_invoice_id: "i",
      xero_contact_id: "c",
      raw_contact_id: null,
    }).status,
    "contact_unconfirmed",
  );
  const a = entryFromConversation(JOB_A_MESSAGES[3], JOB_A, [INV(1)]);
  assertEquals(a.kind, "job_note");
  assertEquals(a.key, "job_events:n1");
  const log = entryFromChaseLog({
    id: "z",
    method: "sms",
    notes: "hello there",
    created_at: "2026-09-01T00:00:00Z",
    xero_invoice_id: INV(1),
  });
  const far = entryFromConversation(
    {
      channel: "sms",
      direction: "outbound",
      occurred_at: "2026-09-01T01:00:00Z",
      preview: "hello there",
      source_system: "ghl_cache",
      source_ref: "q",
      provider_message_id: "ghl:q",
    },
    JOB_A,
    [],
  );
  // An hour apart is two acts, not one message.
  assertEquals(mergeTimeline([log, far]).entries.length, 2);
  assertEquals(
    debtorNextStep([{
      xero_invoice_id: "x",
      invoice_number: "I",
      amount_due: 1,
      next_step: { action: null },
    }]),
    null,
  );
  assertEquals(
    debtorNextStep([
      {
        xero_invoice_id: "s",
        invoice_number: "S",
        amount_due: 5,
        next_step: { action: "small", at: null, owner: "DEBT" },
      },
      {
        xero_invoice_id: "b",
        invoice_number: "B",
        amount_due: 50,
        next_step: { action: "big", at: null, owner: "MARNIN" },
      },
    ])?.from_invoice_id,
    "b",
  );
});

// ── a synthetic book with the real book's shapes ─────────────────────────────
//
// Fabricated ids and amounts. The shapes are the ones the 24 Sep 2026 real
// book showed: unlinked invoices, a reference-number link, a contact-route
// link, a mirror/payload contact conflict, two contacts sharing a name, one
// contact with two names, a GHL contact matched with no job, a stale fact.

const BOOK = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/debt_worklist_synthetic_book_v1.json", import.meta.url),
  ),
);

Deno.test("synthetic book: every open invoice once, unlinked included, counts match an independent count", async () => {
  const org = BOOK.xero_invoices[0].org_id;
  const now = new Date(BOOK.captured_at);
  const conv = conversationStub({});
  const out: any = await debtWorklist(
    new URLSearchParams(),
    deps(fakeClient(BOOK), conv.fn, org, now),
  );

  // Independent count straight off the fixture rows.
  const ids: string[] = BOOK.xero_invoices.map((i: any) => i.xero_invoice_id);
  const today = BOOK.captured_at.slice(0, 10);
  const due = Math.round(
    BOOK.xero_invoices.reduce(
      (n: number, i: any) => n + Number(i.amount_due),
      0,
    ) * 100,
  ) / 100;
  const overdue =
    BOOK.xero_invoices.filter((i: any) => i.due_date && i.due_date < today)
      .length;
  const verified = BOOK.xero_invoices.filter((i: any) =>
    i.xero_contact_id && i.raw_json?.Contact?.ContactID === i.xero_contact_id
  );
  const alone = ids.length - verified.length;
  const verifiedContacts =
    new Set(verified.map((i: any) => i.xero_contact_id)).size;

  assertEquals(out.summary.invoices.count, ids.length);
  assertEquals(out.summary.invoices.amount_due, due);
  assertEquals(out.summary.invoices.overdue.n, overdue);
  assertEquals(out.summary.debtors.count, verifiedContacts + alone);
  assertEquals(out.summary.debtors.standing_alone.n, 1);

  const shown = out.debtors.flatMap((d: any) =>
    d.invoices.map((i: any) => i.xero_invoice_id)
  );
  assertEquals(shown.length, ids.length);
  assertEquals([...shown].sort(), [...ids].sort());
  assertEquals(out.reconciliation.exactly_once, true);
  assertEquals(out.reconciliation.missing_from_context, []);

  // 5 unlinked; one linked through the reference, one through the contact.
  assertEquals(out.summary.invoices.link.none.n, 5);
  assertEquals(out.summary.invoices.link.linked.n, ids.length - 5);
  const rows = out.debtors.flatMap((d: any) => d.invoices);
  const methods = new Set(rows.map((r: any) => r.link.method));
  assert(methods.has("reference_job_number"));
  assert(methods.has("contact_single_job"));

  // Shared name, two contacts: two debtors. Two names, one contact: one.
  const shared = out.debtors.filter((d: any) =>
    d.identity.names.includes("Shared Name Pty")
  );
  assertEquals(shared.length, 2);
  const twoNames = out.debtors.find((d: any) =>
    d.identity.names.includes("Two Names Pty")
  );
  assertEquals(twoNames.identity.names.length, 2);

  // No payer group hides an invoice.
  for (const d of out.debtors) {
    const sum = Math.round(
      d.invoices.reduce((n: number, i: any) => n + (i.amount_due ?? 0), 0) *
        100,
    ) / 100;
    assertEquals(d.total_due, sum);
    assertEquals(d.invoice_count, d.invoices.length);
  }
  // Current Luna facts on the same denominator as the coverage read.
  assertEquals(out.summary.invoices.facts.present, {
    n: 7,
    of: ids.length,
    denominator: "open_invoices",
  });
  assertEquals(out.faults, []);
});

Deno.test("synthetic book: a GHL contact matched with no job is bound and its cached messages are read (DW-04)", async () => {
  const org = BOOK.xero_invoices[0].org_id;
  const out: any = await debtWorklist(
    new URLSearchParams(),
    deps(
      fakeClient(BOOK),
      conversationStub({}).fn,
      org,
      new Date(BOOK.captured_at),
    ),
  );
  const d = out.debtors.find((x: any) =>
    x.identity.names.includes("Synthetic Homes")
  );
  const c = d.sources.ghl.contact_ids.find((x: any) =>
    x.ghl_contact_id === "ghl-syn-contact-only"
  );
  assertEquals(c.via, "contact_match");
  assertEquals(c.cache_synced_at, "2026-09-23T09:00:00+00:00");
  const e = d.timeline.entries.find((x: any) =>
    x.provider_id === "ghl:m-syn-co-1"
  );
  assertEquals(e.invoice_scope, "debtor");
  assertEquals(e.invoice_ids.length, d.invoice_count);
  assertEquals(e.provider, "ghl");
});

Deno.test("synthetic book: fact entries carry value, time, source id, state and scope (DW-03)", async () => {
  const org = BOOK.xero_invoices[0].org_id;
  const out: any = await debtWorklist(
    new URLSearchParams({
      debtor: `xero:${BOOK.xero_invoices[5].xero_contact_id}`,
    }),
    deps(
      fakeClient(BOOK),
      conversationStub({}).fn,
      org,
      new Date(BOOK.captured_at),
    ),
  );
  const d = out.debtors[0];
  const facts = d.timeline.entries.filter((e: any) => e.kind === "fact");
  const byId = new Map(facts.map((e: any) => [e.fact.source_id, e]));
  const current: any = byId.get("f-syn-4");
  const stale: any = byId.get("f-syn-stale");
  assertEquals(current.fact.state, "current");
  assertEquals(current.fact.value, { text: "synthetic" });
  assertEquals(current.fact.captured_at, "2026-09-13T00:00:00+00:00");
  assertEquals(current.at, current.fact.captured_at);
  assertEquals(current.source, "current_job_context_facts");
  assertEquals(current.invoice_scope, "job");
  assert(current.job_id);
  assertEquals(stale.fact.state, "stale");
  assertEquals(stale.label, "stale fact");
  assertEquals(d.sources.facts.timeline_read, "read");
  assertEquals(d.sources.facts.facts_shown, 2);
});

Deno.test("sources: GHL, email and notes carry status, last success, stale after, owner and recovery (DW-05)", async () => {
  const org = BOOK.xero_invoices[0].org_id;
  const out: any = await debtWorklist(
    new URLSearchParams(),
    deps(
      fakeClient(BOOK),
      conversationStub({}).fn,
      org,
      new Date(BOOK.captured_at),
    ),
  );
  for (const d of out.debtors) {
    for (const src of ["ghl", "email", "notes"]) {
      for (
        const f of [
          "status",
          "last_success_at",
          "stale_after",
          "owner",
          "recovery_action",
        ]
      ) {
        assert(f in d.sources[src], `${d.key} ${src}.${f}`);
      }
    }
    // Email never reads complete while Sent Items are not captured.
    assert(!["complete", "read", "current"].includes(d.sources.email.status));
    assertEquals(d.sources.email.last_success_at, null);
    assertEquals(
      d.sources.notes.last_success_at,
      BOOK.captured_at.replace("+00:00", ".000Z"),
    );
  }
  // Job 4's GHL cache synced 1 Sep: older than 24h, so the source is stale.
  const homes = out.debtors.find((x: any) =>
    x.identity.names.includes("Synthetic Homes")
  );
  assertEquals(homes.sources.ghl.status, "stale");
  assertEquals(homes.sources.ghl.stale, true);
  assertEquals(homes.sources.ghl.stale_after, "24h");
  assertEquals(homes.sources.ghl.last_success_at, "2026-09-01T10:00:00+00:00");
  assert(homes.sources.ghl.recovery_action.includes("reconcile"));
  // A bound contact with no cache row is stale and has no last success.
  const builders = out.debtors.find((x: any) =>
    x.identity.names.includes("Synthetic Builders")
  );
  assertEquals(builders.sources.ghl.stale, true);
  assertEquals(builders.sources.ghl.last_success_at, null);
});

Deno.test("faults: a failed job-link read marks the timeline incomplete and GHL and email unreadable (DW-02)", async () => {
  const org = BOOK.xero_invoices[0].org_id;
  // contact_matches failing makes invoice_context's link resolver throw.
  const out: any = await debtWorklist(
    new URLSearchParams(),
    deps(
      fakeClient(BOOK, new Set(["contact_matches"])),
      conversationStub({}).fn,
      org,
      new Date(BOOK.captured_at),
    ),
  );
  assertEquals(out.reconciliation.exactly_once, true);
  for (const d of out.debtors) {
    assertEquals(d.timeline.complete, false);
    assertEquals(d.sources.ghl.status, "unreadable");
    assertEquals(d.sources.email.status, "unreadable");
    assert(d.faults.some((f: any) => f.source === "link"));
    assertEquals(d.last_contact.complete, false);
  }
});

Deno.test("org boundary: a signed-in caller from another org is refused before any read (DW-01)", async () => {
  const client = fakeClient(unitTables());
  const refused = await assertRejects(
    () =>
      debtWorklist(new URLSearchParams(), {
        ...deps(client),
        callerOrgId: "99999999-0000-0000-0000-000000000000",
      }),
    DebtWorklistError,
  );
  assertEquals((refused as DebtWorklistError).status, 403);
  assertEquals((refused as DebtWorklistError).code, "operator_org_required");
  await assertRejects(
    () =>
      debtWorklist(new URLSearchParams(), {
        ...deps(client),
        callerOrgId: null,
      }),
    DebtWorklistError,
  );
  assertEquals(client.reads, []);
  const ok: any = await debtWorklist(
    new URLSearchParams({ timeline: "none" }),
    {
      ...deps(fakeClient(unitTables())),
      callerOrgId: ORG,
    },
  );
  assertEquals(ok.summary.invoices.count, 8);
});

// ── the real book, read-only, when credentials are present ──────────────────
//
// Runs the real read against the live database when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set (never in PR CI); skipped otherwise. It is
// SELECT-only: debtWorklist issues no write. The book moves, so it asserts the
// invariants against an independent count, not pinned numbers.
const LIVE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const LIVE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LIVE_ORG = Deno.env.get("DEBT_WORKLIST_ORG_ID") ??
  "00000000-0000-0000-0000-000000000001";

Deno.test({
  name:
    "live book (read-only): every open invoice once against an independent count",
  ignore: !LIVE_URL || !LIVE_KEY,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.99.3"
    );
    const client = createClient(LIVE_URL, LIVE_KEY, {
      auth: { persistSession: false },
    });
    const out: any = await debtWorklist(
      new URLSearchParams({ timeline: "none" }),
      {
        client,
        orgId: LIVE_ORG,
        getJobConversation: conversationStub({}).fn,
        isCurrentContextFact,
      },
    );
    const { data, error } = await client.from("xero_invoices")
      .select("xero_invoice_id")
      .eq("org_id", LIVE_ORG).eq("invoice_type", "ACCREC")
      .in("status", ["AUTHORISED", "SUBMITTED"]).gt("amount_due", 0)
      .limit(1000);
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((r: any) => r.xero_invoice_id).sort();
    const shown = out.debtors.flatMap((d: any) =>
      d.invoices.map((i: any) => i.xero_invoice_id)
    ).sort();
    assertEquals(out.reconciliation.exactly_once, true);
    assertEquals(shown, ids);
    for (const d of out.debtors) {
      const sum = Math.round(
        d.invoices.reduce((n: number, i: any) => n + (i.amount_due ?? 0), 0) *
          100,
      ) / 100;
      assertEquals(d.total_due, sum);
    }
    console.log(
      `live book: ${out.summary.invoices.count} open invoices, $${out.summary.invoices.amount_due}, ${out.summary.invoices.overdue.n} overdue, ${out.summary.invoices.link.none.n} unlinked, ${out.summary.invoices.facts.present.n} with facts, ${out.summary.debtors.count} debtors`,
    );
  },
});

// ── getJobConversation opt-in ───────────────────────────────────────────────

Deno.test("getJobConversation: report_faults names failed sources and adds provider ids; default response unchanged", async () => {
  const jobId = "c0000000-0000-4000-8000-000000000001";
  const tables: Tables = {
    jobs: [{ id: jobId, job_number: "SWP-1", ghl_contact_id: "g1" }],
    ghl_conversation_cache: [{
      contact_id: "g1",
      job_id: jobId,
      messages: [{
        id: "m9",
        type: "TYPE_SMS",
        direction: "inbound",
        timestamp: "2026-09-01T00:00:00Z",
        body: "hi",
      }],
    }],
    inbox_events: [{
      id: "i1",
      job_id: jobId,
      graph_message_id: "G1",
      received_at: "2026-09-02T00:00:00Z",
      body_preview: "mail",
    }],
    job_events: [],
    business_events: [],
  };
  const plain: any = await _getJobConversationForTest(fakeClient(tables), {
    job_id: jobId,
    limit: 10,
  });
  assertEquals("read_faults" in plain, false);
  assert(plain.messages.every((m: any) => !("provider_message_id" in m)));

  const failing = fakeClient(
    tables,
    new Set(["business_events", "job_events"]),
  );
  const opted: any = await _getJobConversationForTest(failing, {
    job_id: jobId,
    limit: 10,
    report_faults: true,
  });
  assert(
    opted.read_faults.some((f: string) => f.startsWith("business_events:")),
  );
  assert(opted.read_faults.some((f: string) => f.startsWith("job_events:")));
  const ghl = opted.messages.find((m: any) => m.source_system === "ghl_cache");
  assertEquals(ghl.provider_message_id, "ghl:m9");

  const clean: any = await _getJobConversationForTest(fakeClient(tables), {
    job_id: jobId,
    limit: 10,
    report_faults: true,
  });
  assertEquals(clean.read_faults, []);
  const inbox = clean.messages.find((m: any) => m.source_system === "inbox");
  assertEquals(inbox.provider_message_id, "graph:G1");
});
