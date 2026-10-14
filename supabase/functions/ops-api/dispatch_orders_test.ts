// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 5 (docs/dispatch-slice-5-contract.md): the pure rules in
// dispatch_orders.ts. Supplier names, addresses and job numbers are made up.
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchAddressCheck,
  dispatchDeliverTo,
  dispatchDraftHash,
  dispatchGroupThreads,
  dispatchHtmlToText,
  dispatchOrderableLines,
  dispatchOrderBody,
  dispatchOrderChip,
  dispatchOrderLine,
  dispatchOrderLines,
  dispatchOrderLineText,
  dispatchOrderSubject,
  dispatchSameLineSet,
  dispatchSupplierOrder,
  dispatchUpdateDraftPlan,
  perthDayMonth,
  projectDispatchDraft,
  sameInstant,
  sha256Hex,
} from "./dispatch_orders.ts";

const SUP = "b1000000-0000-4000-8000-000000000001";
const OTHER = "b1000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-14T04:00:00Z");

function line(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    supplier_id: SUP,
    description: `Item ${n}`,
    quantity: n,
    unit: "ea",
    status: "to_order",
    purchase_order_id: null,
    position: n,
    updated_at: `2026-10-14T03:00:0${n}.123456+00:00`,
    unit_price: 99,
    ...over,
  };
}

// ── Which lines go on an order ──────────────────────────────────────────────

Deno.test("lines: only this supplier's To order lines on no order, in position order", () => {
  const lines = [
    line(3),
    line(1),
    line(2, { status: "not_reviewed" }),
    line(4, { status: "in_stock" }),
    line(5, { supplier_id: OTHER }),
    line(6, { purchase_order_id: "e1000000-0000-4000-8000-000000000001" }),
  ];
  assertEquals(dispatchOrderableLines(lines, SUP).map((l) => l.description), [
    "Item 1",
    "Item 3",
  ]);
});

Deno.test("lines: the order's copy is item, quantity and unit, never a price", () => {
  const copy = dispatchOrderLine(line(1));
  assertEquals(copy, {
    line_id: line(1).id,
    description: "Item 1",
    quantity: 1,
    unit: "ea",
  });
  const text = JSON.stringify(dispatchOrderLines([line(2), line(1)]));
  assert(!text.includes("price") && !text.includes("99"));
  assertEquals(
    dispatchOrderLine(line(1, { unit: "  ", quantity: null })).unit,
    null,
  );
});

Deno.test("lines: the caller's set must match by id and stamp; the same instant written two ways matches", () => {
  const stored = [line(1), line(2)];
  const stamps = stored.map((l) => ({ id: l.id, updated_at: l.updated_at }));
  assert(dispatchSameLineSet(stamps, stored));
  assert(dispatchSameLineSet(
    [{ id: line(1).id, updated_at: "2026-10-14T03:00:01.123456Z" }, stamps[1]],
    stored,
  ));
  assert(!dispatchSameLineSet([stamps[0]], stored));
  assert(
    !dispatchSameLineSet(
      [
        { ...stamps[0], updated_at: "2026-10-14T03:00:01.123457+00:00" },
        stamps[1],
      ],
      stored,
    ),
  );
  assert(!dispatchSameLineSet([stamps[0], stamps[0]], stored));
  assert(
    sameInstant("2026-10-14T03:00:00Z", "2026-10-14T03:00:00.000000+00:00"),
  );
  assert(!sameInstant(null, "2026-10-14T03:00:00Z"));
});

// ── The draft's text ────────────────────────────────────────────────────────

Deno.test("text: a line prints quantity, unit and item; no quantity prints the item alone", () => {
  assertEquals(
    dispatchOrderLineText({
      line_id: "x",
      description: "Colorbond sheet 2.1 m (Monument)",
      quantity: 18,
      unit: "sheets",
    }),
    "18 sheets Colorbond sheet 2.1 m (Monument)",
  );
  assertEquals(
    dispatchOrderLineText({
      line_id: "x",
      description: "Gate kit",
      quantity: null,
      unit: "ea",
    }),
    "Gate kit",
  );
  assertEquals(
    dispatchOrderLineText({
      line_id: "x",
      description: "Screws",
      quantity: 2.5,
      unit: null,
    }),
    "2.5 Screws",
  );
});

Deno.test("text: the subject and the message match the note's wording, with no long dash and no price", () => {
  assertEquals(
    dispatchOrderSubject("order", "PO-1000001", "SWF-900001"),
    "Purchase order PO-1000001 for SWF-900001",
  );
  assertEquals(
    dispatchOrderSubject("update", "PO-1000001", "SWF-900001"),
    "Updated purchase order PO-1000001 for SWF-900001",
  );
  const body = dispatchOrderBody({
    kind: "order",
    poNumber: "PO-1000001",
    jobNumber: "SWF-900001",
    suburb: "Exampleton",
    lines: [
      {
        line_id: "a",
        description: "Colorbond sheet 2.1 m (Monument)",
        quantity: 18,
        unit: "sheets",
      },
      {
        line_id: "b",
        description: "Steel post 65x65 2.4 m",
        quantity: 16,
        unit: "posts",
      },
    ],
  });
  assertEquals(
    body,
    "Hi team,\n\nPlease find attached PO-1000001 for job SWF-900001 (Exampleton).\n\n" +
      "18 sheets Colorbond sheet 2.1 m (Monument)\n16 posts Steel post 65x65 2.4 m\n\n" +
      "Please confirm the delivery date, and quote SWF-900001 on your delivery docket and invoice.\n\n" +
      "Thanks,\nSecureWorks Group",
  );
  assert(!/[–—$]/.test(body));
  const noSuburb = dispatchOrderBody({
    kind: "order",
    poNumber: "PO-1000001",
    jobNumber: "SWF-900001",
    suburb: "  ",
    lines: [{ line_id: "a", description: "Rail", quantity: 1, unit: null }],
  });
  assert(noSuburb.includes("for job SWF-900001.\n"));
});

Deno.test("text: an update names the lines added and taken off since the last email sent", () => {
  const a = { line_id: "a", description: "Rail", quantity: 4, unit: null };
  const b = { line_id: "b", description: "Post", quantity: 2, unit: null };
  const c = { line_id: "c", description: "Cap", quantity: 8, unit: null };
  const body = dispatchOrderBody({
    kind: "update",
    poNumber: "PO-1000001",
    jobNumber: "SWR-900002",
    suburb: null,
    lines: [a, c],
    previousLines: [a, b],
  });
  assert(
    body.startsWith(
      "Hi team,\n\nPlease find attached the updated PO-1000001 for job SWR-900002.",
    ),
  );
  assert(body.includes("Added:\n8 Cap"));
  assert(body.includes("Taken off:\n2 Post"));
  assert(body.includes("The order now reads:\n4 Rail\n8 Cap"));
});

// ── Hash and address check ──────────────────────────────────────────────────

Deno.test("hash: any change to the address, subject, message or PDF changes the hash", async () => {
  const base = {
    draft_id: "d",
    purchase_order_id: "p",
    to_email: "orders@supplier.test",
    subject: "S",
    body_text: "B",
    pdf_sha256: "aa",
  };
  const h = await dispatchDraftHash(base);
  assertEquals(h, await dispatchDraftHash({ ...base }));
  for (
    const key of ["to_email", "subject", "body_text", "pdf_sha256"] as const
  ) {
    assertNotEquals(
      h,
      await dispatchDraftHash({ ...base, [key]: "changed" }),
      key,
    );
  }
  assertEquals(h.length, 64);
});

Deno.test("address: missing, malformed, ours or a test address is refused; an outside address is ok", () => {
  assertEquals(dispatchAddressCheck(null), { state: "missing", email: null });
  assertEquals(dispatchAddressCheck("  "), { state: "missing", email: null });
  assertEquals(dispatchAddressCheck("a@b.test; c@d.test").state, "malformed");
  assertEquals(dispatchAddressCheck("a@b.test, c@d.test").state, "malformed");
  assertEquals(dispatchAddressCheck("Name <a@b.test>").state, "malformed");
  assertEquals(dispatchAddressCheck("not an address").state, "malformed");
  for (
    const email of [
      "orders@secureworkswa.com.au",
      "ops@secureworksgroup.app",
      "x@mail.secureworksgroup.com.au",
      "sales@example.com",
      "sales@EXAMPLE.ORG",
      "a@example.net",
      "test@supplier.test",
    ]
  ) {
    assertEquals(dispatchAddressCheck(email).state, "not_supplier", email);
  }
  assertEquals(dispatchAddressCheck(" orders@steel-supplies.test "), {
    state: "ok",
    email: "orders@steel-supplies.test",
  });
});

// ── Plain text from HTML ────────────────────────────────────────────────────

Deno.test("text from html: tags gone, entities decoded, blank lines collapsed", () => {
  assertEquals(
    dispatchHtmlToText(
      "<html><head><style>p{}</style></head><body><p>Hi &amp; thanks</p><br><br><br><div>Next&nbsp;week &#39;ok&#39;</div></body></html>",
    ),
    "Hi & thanks\n\nNext week 'ok'",
  );
  assertEquals(dispatchHtmlToText(null), "");
});

// ── Threads ─────────────────────────────────────────────────────────────────

const PO = "e1000000-0000-4000-8000-000000000001";

function comm(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    po_id: null,
    job_id: "a1",
    direction: "inbound",
    from_email: "client@home.test",
    to_email: "quotes@secureworksgroup.app",
    subject: `Subject ${n}`,
    body_text: null,
    body_html: `<p>Message ${n}</p>`,
    attachments_json: [],
    sent_at: null,
    received_at: null,
    created_at: `2026-10-0${n}T01:00:00+00:00`,
    communication_type: "client",
    message_id: null,
    thread_id: null,
    delivery_status: null,
    ...over,
  };
}

Deno.test("threads: by thread id, supplier rows by order too; newest thread first, messages oldest first", () => {
  const rows = [
    comm(1, { thread_id: "t1" }),
    comm(3, { thread_id: "t1", direction: "outbound" }),
    comm(2),
    // Our sent order email (filed under the Resend id) and the supplier's two
    // replies with no thread id: one thread, by the order.
    comm(4, {
      communication_type: "purchase_order",
      po_id: PO,
      direction: "outbound",
      thread_id: "resend-id",
      to_email: "orders@steel-supplies.test",
      from_email: "orders@secureworksgroup.app",
    }),
    comm(5, {
      communication_type: "purchase_order",
      po_id: PO,
      from_email: "orders@steel-supplies.test",
      attachments_json: [{ filename: "docket.pdf" }],
    }),
    comm(6, {
      communication_type: "purchase_order",
      po_id: PO,
      from_email: "orders@steel-supplies.test",
      body_text: "Confirmed for Friday",
    }),
    comm(7, { communication_type: "council" }),
  ];
  const threads = dispatchGroupThreads(rows, {
    orders: new Map([[PO, {
      po_number: "PO-1000001",
      supplier_name: "Example Steel",
    }]]),
  });
  assertEquals(threads.map((t) => [t.tag, t.messages.length]), [
    ["supplier", 3],
    ["client", 2],
    ["client", 1],
  ]);
  const supplier = threads[0];
  assertEquals(supplier.key, `th-${comm(4).id}`);
  assertEquals(supplier.po_number, "PO-1000001");
  assertEquals(supplier.counterpart, "Example Steel");
  assertEquals(supplier.last_preview, "Confirmed for Friday");
  assertEquals(supplier.can_reply, true);
  assertEquals(supplier.can_link, false);
  assertEquals(supplier.messages[1].attachments, [{ file_name: "docket.pdf" }]);
  assertEquals(supplier.messages[1].text, "Message 5");
  assertEquals(threads[1].counterpart, "Client");
  assertEquals(threads[1].can_reply, false);
  assertEquals(threads[1].messages.map((m: any) => m.text), [
    "Message 1",
    "Message 3",
  ]);
});

Deno.test("threads: a supplier thread with no order can be linked; a reply needs an outside sender", () => {
  const rows = [
    comm(1, {
      communication_type: "purchase_order",
      from_email: "staff@secureworkswa.com.au",
    }),
  ];
  const [thread] = dispatchGroupThreads(rows, { orders: new Map() });
  assertEquals(thread.can_link, true);
  assertEquals(thread.can_reply, false);
  assertEquals(thread.counterpart, "staff@secureworkswa.com.au");
});

// ── The chip ────────────────────────────────────────────────────────────────

Deno.test("chip: every state in the note's table, and In Xero after it", () => {
  const order = {
    id: PO,
    po_number: "PO-1000001",
    xero_po_id: null,
    last_sent_at: null,
    pdf_version: 1,
    last_sent_pdf_version: null,
  };
  const chip = (o: any, openDraft: any = null, newestMessage: any = null) =>
    dispatchOrderChip({ order: o, openDraft, newestMessage, nowMs: NOW });
  assertEquals(chip(null), {
    state: "not_ordered",
    text: "Not ordered",
    tone: "muted",
    in_xero: false,
  });
  assertEquals(
    chip(order, { status: "draft" }).text,
    "PO-1000001 · Draft email ready",
  );
  assertEquals(chip(order, { status: "draft" }).tone, "info");
  assertEquals(chip(order).text, "PO-1000001 · Not sent");
  assertEquals(chip(order).tone, "warn");
  const sent = {
    ...order,
    last_sent_at: "2026-10-14T02:00:00Z",
    last_sent_pdf_version: 1,
  };
  assertEquals(
    chip({ ...sent, pdf_version: 2 }).text,
    "PO-1000001 · Changed, not sent",
  );
  assertEquals(
    chip(sent, null, { direction: "outbound", sent_at: "2026-10-14T02:00:00Z" })
      .text,
    "PO-1000001 · Sent 14/10",
  );
  const replied = chip(sent, null, {
    direction: "inbound",
    received_at: "2026-10-14T17:00:00Z",
  });
  assertEquals([replied.text, replied.tone], [
    "PO-1000001 · Replied 15/10",
    "ok",
  ]);
  assertEquals(
    chip(sent, { status: "send_unknown" }).text,
    "PO-1000001 · Send not confirmed",
  );
  // A claim with no answer for over two minutes reads as not confirmed.
  assertEquals(
    chip(order, { status: "sending", updated_at: "2026-10-14T03:50:00Z" })
      .state,
    "send_unknown",
  );
  assertEquals(
    chip(order, { status: "sending", updated_at: "2026-10-14T03:59:30Z" })
      .state,
    "draft_ready",
  );
  const inXero = chip({ ...sent, xero_po_id: "x" }, null, {
    direction: "outbound",
    sent_at: "2026-10-14T02:00:00Z",
  });
  assertEquals([inXero.text, inXero.in_xero], [
    "PO-1000001 · Sent 14/10 · In Xero",
    true,
  ]);
  assertEquals(perthDayMonth("2026-10-14T16:30:00Z"), "15/10");
});

Deno.test("supplier order: the newest open Dispatch order for the supplier, or null", () => {
  const orders = [
    {
      id: "1",
      source: "dispatch",
      supplier_id: SUP,
      status: "cancelled",
      po_number: "PO-1",
      created_at: "2026-10-01",
    },
    {
      id: "2",
      source: null,
      supplier_id: null,
      status: "draft",
      po_number: "PO-2",
      created_at: "2026-10-02",
    },
    {
      id: "3",
      source: "dispatch",
      supplier_id: SUP,
      status: "sent",
      po_number: "PO-3",
      created_at: "2026-10-03",
      xero_po_id: "x",
      last_sent_at: "2026-10-03",
    },
    {
      id: "4",
      source: "dispatch",
      supplier_id: SUP,
      status: "draft",
      po_number: "PO-4",
      created_at: "2026-10-04",
      pdf_version: 1,
    },
  ];
  const out = dispatchSupplierOrder({
    orders,
    supplierId: SUP,
    openDrafts: [{ purchase_order_id: "4", status: "draft" }],
    messages: [],
    nowMs: NOW,
  });
  assertEquals(out?.po_number, "PO-4");
  assertEquals(out?.chip.state, "draft_ready");
  assertEquals(
    dispatchSupplierOrder({
      orders,
      supplierId: OTHER,
      openDrafts: [],
      messages: [],
      nowMs: NOW,
    }),
    null,
  );
});

// ── Drafts ──────────────────────────────────────────────────────────────────

Deno.test("draft: To is worked out from the contact on every read; the hash names only an ok address", async () => {
  const body = "Hi team,";
  const draft = {
    id: "d1",
    purchase_order_id: PO,
    supplier_id: SUP,
    kind: "order",
    status: "draft",
    subject: "S",
    body_text: body,
    body_generated_sha: await sha256Hex(body),
    pdf_version: 1,
    pdf_sha256: "aa",
    line_count: 2,
  };
  const order = { id: PO, po_number: "PO-1000001", pdf_version: 1 };
  const ok = await projectDispatchDraft({
    draft,
    order,
    supplier: { name: "Steel", email: "a@steel.test" },
    nowMs: NOW,
    currentGeneratedSha: draft.body_generated_sha,
  });
  assertEquals(ok.to, { email: "a@steel.test", state: "ok" });
  assertEquals(ok.body_edited, false);
  assertEquals(ok.order_changed_since_edit, false);
  assertEquals(ok.pdf, {
    version: 1,
    file_name: "PO-1000001.pdf",
    line_count: 2,
  });
  const missing = await projectDispatchDraft({
    draft,
    order,
    supplier: { name: "Steel", email: null },
    nowMs: NOW,
    currentGeneratedSha: null,
  });
  assertEquals(missing.to.state, "missing");
  assertNotEquals(missing.draft_hash, ok.draft_hash);
  const edited = await projectDispatchDraft({
    draft: { ...draft, body_text: "Hi team, please hurry" },
    order,
    supplier: null,
    nowMs: NOW,
    currentGeneratedSha: "something-else",
  });
  assertEquals([edited.body_edited, edited.order_changed_since_edit], [
    true,
    true,
  ]);
});

Deno.test("update plan: an unedited draft is rewritten, an edited one kept; no draft makes order or update by whether it was sent", async () => {
  const lines = [{
    line_id: "a",
    description: "Rail",
    quantity: 4,
    unit: null,
  }];
  const order = { id: PO, po_number: "PO-1000001", last_sent_at: null };
  const body = "Hi team,";
  const unedited = {
    id: "d",
    kind: "order",
    updated_at: "t",
    body_text: body,
    body_generated_sha: await sha256Hex(body),
  };
  const plan1 = await dispatchUpdateDraftPlan({
    openDraft: unedited,
    order,
    jobNumber: "SWF-1",
    suburb: null,
    lines,
    lastSentLines: null,
  });
  assertEquals(plan1.kind, "refresh");
  assert((plan1 as any).fields.body_text.includes("1 Rail") === false);
  assert((plan1 as any).fields.body_text.includes("4 Rail"));
  const plan2 = await dispatchUpdateDraftPlan({
    openDraft: { ...unedited, body_text: "mine" },
    order,
    jobNumber: "SWF-1",
    suburb: null,
    lines,
    lastSentLines: null,
  });
  assertEquals([(plan2 as any).fields, (plan2 as any).body_kept], [{}, true]);
  const plan3 = await dispatchUpdateDraftPlan({
    openDraft: null,
    order,
    jobNumber: "SWF-1",
    suburb: null,
    lines,
    lastSentLines: null,
  });
  assertEquals([plan3.kind, (plan3 as any).fields.kind], ["insert", "order"]);
  const plan4 = await dispatchUpdateDraftPlan({
    openDraft: null,
    order: { ...order, last_sent_at: "2026-10-14" },
    jobNumber: "SWF-1",
    suburb: null,
    lines,
    lastSentLines: [],
  });
  assertEquals((plan4 as any).fields.kind, "update");
  assertEquals(
    (plan4 as any).fields.subject,
    "Updated purchase order PO-1000001 for SWF-1",
  );
});

Deno.test("deliver to: the address with its suburb, never the suburb twice", () => {
  assertEquals(
    dispatchDeliverTo("1 Example St", "Exampleton"),
    "1 Example St, Exampleton",
  );
  assertEquals(
    dispatchDeliverTo("1 Example St, EXAMPLETON WA", "Exampleton"),
    "1 Example St, EXAMPLETON WA",
  );
  assertEquals(dispatchDeliverTo("", "Exampleton"), "Exampleton");
  assertEquals(dispatchDeliverTo(null, null), null);
});
