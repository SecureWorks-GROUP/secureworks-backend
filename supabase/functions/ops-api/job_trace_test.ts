// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  billTokensFromOrders,
  buildCardLink,
  buildCrewLinesLink,
  buildInvoicesLink,
  buildOrdersLink,
  buildSupplierBillsLink,
  buildWorkOrderLink,
  figureFree,
  firstGap,
  JOB_TRACE_REASONS,
  jobTraceAction,
  jobTraceView,
} from "./job_trace.ts";

// A recording PostgREST stand-in: each from() answers from `tables`, applies
// eq/neq/in, and logs every builder call. It has no insert, update, upsert,
// delete or rpc, so a write from the trace would throw.
function fakeClient(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const builder: any = {};
      for (const op of ["select", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      builder.eq = (col: string, val: unknown) => {
        call.ops.push(["eq", [col, val]]);
        rows = rows.filter((r) => r[col] === val);
        return builder;
      };
      builder.neq = (col: string, val: unknown) => {
        call.ops.push(["neq", [col, val]]);
        rows = rows.filter((r) => r[col] !== val);
        return builder;
      };
      builder.in = (col: string, vals: unknown[]) => {
        call.ops.push(["in", [col, vals]]);
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          errors[table]
            ? { data: null, error: { message: errors[table] } }
            : { data: rows, error: null },
        );
      return builder;
    },
  };
  return client;
}

const JOB = "a7100000-0000-4000-8000-000000000001";
const REV = "a7100000-0000-4000-8000-0000000000a1";
const PO = "a7100000-0000-4000-8000-0000000000b1";
const PARTY = "a7100000-0000-4000-8000-0000000000c1";
const TINV = "a7100000-0000-4000-8000-0000000000d1";
const HASH = "a".repeat(64);

// SWF-26979 as DSP-10's hand trace recorded it on 19 Oct 2026
// (secureworks-projects dispatch/verify/evidence/20261019-chain-trace-SWF-26979.md),
// with made-up row ids. The figures are made up too. SIMULATED: this is the
// trace run on a copy of the hand trace's rows, not on production.
function swf26979Tables(): Record<string, any[]> {
  return {
    jobs: [{
      id: JOB,
      job_number: "SWF-26979",
      type: "fencing",
      status: "complete",
      accepted_at: "2026-09-01T02:46:00+00:00",
      accepted_scope_revision_id: REV,
    }],
    scope_revisions: [{
      id: REV,
      job_id: JOB,
      revision_number: 1,
      status: "frozen",
      scope_hash: HASH,
      pricing_hash: HASH,
      frozen_at: "2026-09-01T02:40:00+00:00",
      superseded_at: null,
    }],
    quote_revisions: [{
      id: "a7100000-0000-4000-8000-0000000000a2",
      job_id: JOB,
      version: 1,
      sent_at: "2026-08-28T03:00:00+00:00",
    }],
    quote_builder_versions: [],
    job_material_lines: [],
    purchase_orders: [{
      id: PO,
      job_id: JOB,
      po_number: "PO-298035",
      supplier_id: null,
      supplier_name: "R&R Fencing",
      source: null,
      status: "confirmed",
      reference: "R&R INV-86844",
      xero_po_id: null,
      xero_bill_id: null,
      subtotal: 1000,
      total: 1100,
    }],
    job_order_emails: [],
    job_materials_facts: [],
    materials_reconciliation_queue: [{
      id: "a7100000-0000-4000-8000-0000000000e1",
      xero_invoice_id: "x-bill-86844",
      invoice_number: "INV-86844",
      contact_name: "R&R Fencing",
      status: "open",
      suggested_job_id: null,
      suggestion_reason: "no_ref_no_po",
      suggestion_confidence: "low",
      sub_total: 1000,
      total: 1100,
    }],
    xero_invoices: [
      {
        xero_invoice_id: "x-bill-86844",
        invoice_type: "ACCPAY",
        job_id: null,
        invoice_number: "INV-86844",
        contact_name: "R&R Fencing",
        status: "AUTHORISED",
        sub_total: 1000,
        total: 1100,
      },
      {
        xero_invoice_id: "x-inv-1",
        invoice_type: "ACCREC",
        job_id: JOB,
        invoice_number: "INV-0001",
        status: "PAID",
        reference: "SWF-26979",
        job_contact_id: PARTY,
        invoice_date: "2026-09-15",
        fully_paid_on: "2026-09-20",
        total: 4000,
        amount_due: 0,
      },
    ],
    work_orders: [],
    trade_invoice_lines: [{
      id: "a7100000-0000-4000-8000-0000000000d2",
      job_id: JOB,
      trade_invoice_id: TINV,
      line_type: "work_order",
      job_work_order_id: null,
      office_review_status: null,
    }],
    trade_invoices: [{
      id: TINV,
      invoice_number: "TI-1",
      status: "approved",
      xero_bill_id: "x-crew-bill-1",
      xero_bill_status: "AUTHORISED",
    }],
    job_contacts: [{
      id: PARTY,
      job_id: JOB,
      contact_label: "A",
      removed_at: null,
    }],
    context_ledger_generations: [],
    context_ledger_items: [],
  };
}

// Every link present except the job work order.
function noWorkOrderTables(): Record<string, any[]> {
  const t = swf26979Tables();
  t.jobs[0].job_number = "SWF-900002";
  t.purchase_orders = [{
    ...t.purchase_orders[0],
    po_number: "PO-1000002",
    supplier_id: "a7100000-0000-4000-8000-0000000000f1",
    source: "dispatch",
    status: "sent",
    reference: "SWF-900002",
  }];
  t.job_material_lines = [{
    id: "a7100000-0000-4000-8000-0000000000f2",
    job_id: JOB,
    supplier_id: "a7100000-0000-4000-8000-0000000000f1",
    status: "to_order",
    source: "scope",
    purchase_order_id: PO,
  }];
  t.job_order_emails = [{
    id: "a7100000-0000-4000-8000-0000000000f3",
    job_id: JOB,
    purchase_order_id: PO,
    kind: "order",
    status: "sent",
    sent_at: "2026-10-20T01:00:00+00:00",
    sent_via: "screen",
  }];
  t.job_materials_facts = [{
    id: "a7100000-0000-4000-8000-0000000000f4",
    job_id: JOB,
    kind: "actual",
    xero_invoice_id: "x-bill-2",
    invoice_number: "INV-2",
    contact_name: "Example Steel",
    lane: "materials",
    confidence: "high",
    automation_source: "xero_ref_link",
    matched_po_id: null,
    amount_ex_gst: 1000,
  }];
  t.materials_reconciliation_queue = [];
  t.xero_invoices = t.xero_invoices.filter((x) => x.invoice_type === "ACCREC");
  t.trade_invoice_lines[0].job_work_order_id = null;
  t.context_ledger_generations = [{
    id: "a7100000-0000-4000-8000-0000000000f5",
    job_id: JOB,
    status: "live",
    reader: "luna-ledger:v1",
    promoted_at: "2026-10-20T02:00:00+00:00",
    evidence_until: "2026-10-20T01:00:00+00:00",
  }];
  t.context_ledger_items = [
    { generation_id: "a7100000-0000-4000-8000-0000000000f5", status: "open" },
    { generation_id: "a7100000-0000-4000-8000-0000000000f5", status: "closed" },
  ];
  return t;
}

function linkOf(body: any, id: string) {
  return body.links.find((l: any) => l.link === id);
}

const WRITE_OPS = ["insert", "update", "upsert", "delete", "rpc"];

Deno.test("an admin/owner session reads the staff shape, the ops key the figure-free shape, nobody else", () => {
  assertEquals(jobTraceView("jwt", "admin"), "staff");
  assertEquals(jobTraceView("jwt", "Owner"), "staff");
  assertEquals(jobTraceView("api_key", null), "figure_free");
  for (const role of ["ops_manager", "lead_installer", "trade", "", null]) {
    assertEquals(jobTraceView("jwt", role), null, `role ${role}`);
  }
  assertEquals(jobTraceView("routine", "admin"), null);
  assertEquals(jobTraceView("agent_read", null), null);
  assertEquals(jobTraceView("none", null), null);
});

Deno.test("a job number is required, checked, and must name exactly one job", async () => {
  const client = fakeClient(swf26979Tables());
  const bare = await jobTraceAction(client, new URLSearchParams(), "staff");
  assertEquals(bare.status, 400);
  assertEquals(client.calls.length, 0, "refused before any read");
  const bad = await jobTraceAction(
    client,
    new URLSearchParams("job_number=SWF 26979;"),
    "staff",
  );
  assertEquals(bad.status, 400);
  const badId = await jobTraceAction(
    client,
    new URLSearchParams("job_id=nope"),
    "staff",
  );
  assertEquals(badId.status, 400);
  const none = await jobTraceAction(
    client,
    new URLSearchParams("job_number=SWF-1"),
    "staff",
  );
  assertEquals(none.status, 404);
  const twice = swf26979Tables();
  twice.jobs.push({
    ...twice.jobs[0],
    id: "a7100000-0000-4000-8000-000000000002",
  });
  const dup = await jobTraceAction(
    fakeClient(twice),
    new URLSearchParams("job_number=swf-26979"),
    "staff",
  );
  assertEquals(dup.status, 409);
});

Deno.test("SWF-26979 (DSP-10 hand trace, simulated): every link matches, and the first gap is material lines", async () => {
  const client = fakeClient(swf26979Tables());
  const out = await jobTraceAction(
    client,
    new URLSearchParams("job_number=SWF-26979"),
    "figure_free",
  );
  assertEquals(out.status, 200);
  const body: any = out.body;
  assertEquals(body.version, "job-trace-v1");
  assertEquals(body.first_gap, {
    link: "L2",
    name: "material_lines",
    state: "missing",
    reason: "no_material_lines",
  });
  // L1: the accepted quote is present.
  const l1 = linkOf(body, "L1");
  assertEquals(l1.state, "present");
  assertEquals(l1.items[0].source, "accepted_revision");
  assertEquals(l1.items[0].scope_hash, HASH);
  // L3: PO-298035 is a legacy priced PO, never sent through Dispatch.
  const l3 = linkOf(body, "L3");
  assertEquals(l3.state, "partial");
  assertEquals(l3.reason, "legacy_po");
  assertEquals(l3.items[0].key, "PO-298035");
  assertEquals(l3.items[0].state, "legacy");
  assertEquals(l3.items[0].source, null);
  assertEquals(l3.items[0].emails, []);
  // L4: bill INV-86844 is not placed, with the matcher's reason.
  const l4 = linkOf(body, "L4");
  assertEquals(l4.state, "missing");
  assertEquals(l4.reason, "bill_not_placed");
  assertEquals(l4.items.length, 1);
  assertEquals(l4.items[0].key, "INV-86844");
  assertEquals(l4.items[0].state, "not_placed");
  assertEquals(l4.items[0].queue_reason, "no_ref_no_po");
  assertEquals(l4.items[0].found_via, "named_by_po_reference");
  // L5: there is no job work order.
  assertEquals(linkOf(body, "L5").state, "missing");
  assertEquals(linkOf(body, "L5").reason, "no_job_work_order");
  // The crew bill is never read as a supplier bill.
  assert(!l4.items.some((i: any) => i.row_id === "x-crew-bill-1"));
  // The recorded answer.
  const recorded = JSON.parse(
    await Deno.readTextFile(
      new URL("../../../docs/job-trace-recorded-answers.json", import.meta.url),
    ),
  );
  assertEquals(body, recorded.swf_26979_figure_free);
});

Deno.test("a job whose earlier links are all present but has no job work order names that as the first gap", async () => {
  const out = await jobTraceAction(
    fakeClient(noWorkOrderTables()),
    new URLSearchParams("job_number=SWF-900002"),
    "staff",
  );
  const body: any = out.body;
  for (const id of ["L1", "L2", "L3", "L4"]) {
    assertEquals(linkOf(body, id).state, "present", id);
  }
  assertEquals(body.first_gap, {
    link: "L5",
    name: "work_order",
    state: "missing",
    reason: "no_job_work_order",
  });
});

Deno.test("a failed read makes its link unknown, never missing, and the first gap unknown", async () => {
  const out = await jobTraceAction(
    fakeClient(swf26979Tables(), { job_material_lines: "timeout" }),
    new URLSearchParams("job_number=SWF-26979"),
    "staff",
  );
  const body: any = out.body;
  const l2 = linkOf(body, "L2");
  assertEquals(l2.state, "unknown");
  assertEquals(l2.reason, "read_failed");
  assert(String(l2.error).includes("timeout"));
  assertEquals(body.first_gap.state, "unknown");
  assertEquals(body.first_gap.link, "L2");
});

Deno.test("the figure-free shape carries no money figure; the staff shape copies the row figures", async () => {
  const params = new URLSearchParams("job_number=SWF-900002");
  const staff: any = (await jobTraceAction(
    fakeClient(noWorkOrderTables()),
    params,
    "staff",
  )).body;
  const free: any = (await jobTraceAction(
    fakeClient(noWorkOrderTables()),
    params,
    "figure_free",
  )).body;
  assertEquals(linkOf(staff, "L4").items[0].amounts, { amount_ex_gst: 1000 });
  assertEquals(linkOf(staff, "L7").items[0].amounts, {
    total: 4000,
    amount_due: 0,
  });
  const text = JSON.stringify(free);
  assert(!text.includes('"amounts"'));
  for (const key of ["amount", "total", "subtotal", "sub_total", "labour_ex"]) {
    assert(!new RegExp(`"[a-z_]*${key}[a-z_]*":\\s*-?\\d`).test(text), key);
  }
  // Only the figures are dropped: the states are the same.
  assertEquals(
    free.links.map((l: any) => [l.link, l.state, l.reason]),
    staff.links.map((l: any) => [l.link, l.state, l.reason]),
  );
});

Deno.test("the trace only reads, and reads only the tables it names", async () => {
  const client = fakeClient(noWorkOrderTables());
  await jobTraceAction(
    client,
    new URLSearchParams("job_number=SWF-900002"),
    "staff",
  );
  for (const c of client.calls) {
    for (const [op] of c.ops) assert(!WRITE_OPS.includes(op), op);
  }
  const tables = [...new Set(client.calls.map((c) => c.table))].sort();
  assertEquals(tables, [
    "context_ledger_generations",
    "context_ledger_items",
    "job_contacts",
    "job_material_lines",
    "job_materials_facts",
    "job_order_emails",
    "jobs",
    "materials_reconciliation_queue",
    "purchase_orders",
    "quote_builder_versions",
    "quote_revisions",
    "scope_revisions",
    "trade_invoice_lines",
    "trade_invoices",
    "work_orders",
    "xero_invoices",
  ]);
  // The scope revision is read without its canonical text, the job without
  // its expected cost figures.
  const selects = client.calls.flatMap((c) =>
    c.ops.filter(([op]) => op === "select").map(([, a]) => String(a[0]))
  );
  assert(!selects.some((s) => s.includes("canonical_text")));
  assert(
    !selects.some((s) => /expected_costs(?!->>scope_revision_id)/.test(s)),
  );
  assert(!selects.some((s) => s.includes("scope_json")));
});

Deno.test("bill numbers are read from a PO's reference, never the job or PO number", () => {
  assertEquals(
    billTokensFromOrders([
      {
        po_number: "PO-298035",
        reference: "R&R INV-86844 for SWF-26979 PO-298035",
      },
      { po_number: "PO-1000001", reference: "SWF-26979" },
    ], "SWF-26979"),
    ["INV-86844"],
  );
  assertEquals(billTokensFromOrders([{ reference: null }], "SWF-1"), []);
});

Deno.test("orders: a Dispatch order is present only once its email is sent", () => {
  const base = { id: "p1", po_number: "PO-1", source: "dispatch" };
  assertEquals(buildOrdersLink([base], []).reason, "order_not_sent");
  assertEquals(
    buildOrdersLink([base], [{
      purchase_order_id: "p1",
      status: "send_unknown",
    }])
      .reason,
    "order_send_unknown",
  );
  assertEquals(
    buildOrdersLink([base], [{ purchase_order_id: "p1", status: "sent" }])
      .state,
    "present",
  );
  assertEquals(buildOrdersLink([], []).reason, "no_purchase_orders");
});

Deno.test("supplier bills: placed, queued, linked without a fact, and crew mirrors", () => {
  const fact = {
    id: "f1",
    xero_invoice_id: "b1",
    automation_source: "po_deterministic",
    confidence: "medium",
  };
  const placedOnly = buildSupplierBillsLink([fact], [], [], [], new Set());
  assertEquals(placedOnly.state, "present");
  assertEquals(placedOnly.items[0].source, "po_deterministic");
  const mixed = buildSupplierBillsLink(
    [fact],
    [{
      xero_invoice_id: "b2",
      status: "open",
      suggestion_reason: "no_po_match",
    }],
    [],
    [],
    new Set(),
  );
  assertEquals(mixed.state, "partial");
  assertEquals(mixed.reason, "bill_not_placed");
  const linked = buildSupplierBillsLink(
    [],
    [],
    [{ xero_invoice_id: "b3" }, { xero_invoice_id: "crew1" }],
    [],
    new Set(["crew1"]),
  );
  assertEquals(linked.state, "missing");
  assertEquals(linked.reason, "bill_linked_no_fact");
  assertEquals(linked.items.length, 1);
  const notJob = buildSupplierBillsLink(
    [],
    [{ xero_invoice_id: "b4", status: "not_job_related" }],
    [],
    [],
    new Set(),
  );
  assertEquals(notJob.reason, "no_supplier_bills");
});

Deno.test("work order: draft, approved without a seal, sealed", () => {
  assertEquals(
    buildWorkOrderLink([{ id: "w", status: "draft" }]).reason,
    "work_order_draft",
  );
  assertEquals(
    buildWorkOrderLink([{ id: "w", status: "approved", approved_at: "t" }])
      .reason,
    "work_order_not_sealed",
  );
  assertEquals(
    buildWorkOrderLink([{
      id: "w",
      status: "approved",
      approved_at: "t",
      sealed_content_hash: HASH,
    }]).state,
    "present",
  );
  assertEquals(
    buildWorkOrderLink([{ id: "w", status: "cancelled" }]).reason,
    "no_job_work_order",
  );
});

Deno.test("crew lines: held by office review, not in Xero, not on the work order", () => {
  const out = buildCrewLinesLink(
    [
      {
        id: "l1",
        trade_invoice_id: "t1",
        office_review_status: "awaiting",
        job_work_order_id: "w",
      },
      { id: "l2", trade_invoice_id: "t2", job_work_order_id: null },
    ],
    [{ id: "t1" }, { id: "t2", xero_bill_id: null }],
  );
  assertEquals(out.state, "partial");
  assertEquals(out.notes, [
    "crew_bill_held",
    "crew_bill_not_in_xero",
    "line_not_on_work_order",
  ]);
});

Deno.test("invoices: per party, drafts only, voided invoices left out", () => {
  const parties = [{ id: "A", contact_label: "A" }, {
    id: "B",
    contact_label: "B",
  }];
  assertEquals(
    buildInvoicesLink([{
      xero_invoice_id: "i",
      status: "DRAFT",
      job_contact_id: "A",
    }], parties)
      .reason,
    "invoice_draft_only",
  );
  const oneParty = buildInvoicesLink(
    [{ xero_invoice_id: "i", status: "AUTHORISED", job_contact_id: "A" }],
    parties,
  );
  assertEquals(oneParty.reason, "party_not_invoiced");
  assertEquals(oneParty.items[0].party, "A");
  assertEquals(oneParty.items[0].state, "owing");
  assertEquals(
    buildInvoicesLink([{ xero_invoice_id: "i", status: "VOIDED" }], []).reason,
    "no_customer_invoice",
  );
});

Deno.test("card: the live reading's item counts, and the H7 outcome not yet released", () => {
  const out = buildCardLink(
    [{ id: "g", status: "live", reader: "r" }],
    [{ status: "open" }, { status: "open" }, { status: "closed" }],
  );
  assertEquals(out.state, "partial");
  assertEquals(out.reason, "h7_not_released");
  assertEquals(out.items[0].item_counts, { open: 2, closed: 1 });
  assertEquals(buildCardLink([], []).reason, "no_live_card_reading");
});

Deno.test("a partial link does not break the chain; unknown before missing wins", () => {
  const l = (link: string, state: any, reason: string | null = null) => ({
    link,
    name: link,
    state,
    reason,
    notes: [],
    items: [],
  });
  assertEquals(firstGap([l("L1", "partial", "x"), l("L2", "present")]), null);
  assertEquals(
    firstGap([l("L1", "partial", "x"), l("L2", "missing", "y")])?.link,
    "L2",
  );
  assertEquals(
    firstGap([l("L1", "unknown", "read_failed"), l("L2", "missing", "y")])
      ?.state,
    "unknown",
  );
});

Deno.test("every reason code a link can return has a meaning", () => {
  const src = Deno.readTextFileSync(new URL("./job_trace.ts", import.meta.url));
  const used = new Set<string>();
  for (const m of src.matchAll(/"([a-z][a-z0-9_]+)"/g)) used.add(m[1]);
  for (const code of Object.keys(JOB_TRACE_REASONS)) {
    assert(used.has(code), code);
  }
  for (const m of src.matchAll(/notes\.(?:add|push)\("([a-z_]+)"\)/g)) {
    assert(m[1] in JOB_TRACE_REASONS, m[1]);
  }
  for (const m of src.matchAll(/"(?:missing|partial)",\s*"([a-z_]+)"/g)) {
    assert(m[1] in JOB_TRACE_REASONS, m[1]);
  }
});

Deno.test("figureFree drops amounts at any depth and nothing else", () => {
  assertEquals(
    figureFree<any>({
      a: 1,
      amounts: { x: 1 },
      items: [{ amounts: {}, k: "v" }],
    }),
    { a: 1, items: [{ k: "v" }] },
  );
});
