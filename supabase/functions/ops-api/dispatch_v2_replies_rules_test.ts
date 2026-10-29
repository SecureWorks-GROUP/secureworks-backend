// deno-lint-ignore-file no-import-prefix
// Dispatch v2, slice 8: the pure rules in dispatch_v2_replies_rules.ts.
// Supplier names, addresses and numbers are made up or are the public order
// desks on the approved list; no real client appears.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ApprovedSupplierSender,
  type CapturedEmail,
  dayLabel,
  identifySender,
  isAutoReply,
  type JobHint,
  jobNumbersIn,
  matchEmail,
  type MatchInputs,
  perthDay,
  readDeliveryDate,
  stageMoveOffer,
  suggestionLabel,
  supplierKeyOf,
  supplierRefsIn,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";

const APPROVED: ApprovedSupplierSender[] = [
  {
    supplier_key: "stratco",
    supplier_name: "Stratco",
    supplier_ids: ["sup-stratco"],
    emails: ["tradewa@stratcowa.com.au", "tony.bacich@stratcowa.com.au"],
  },
  {
    supplier_key: "fencingwarehousewa",
    supplier_name: "Fencing Warehouse WA",
    supplier_ids: ["sup-fw-1", "sup-fw-2"],
    emails: ["sales@fencingwarehousewa.au"],
  },
  {
    supplier_key: "smallyard",
    supplier_name: "Small Yard",
    supplier_ids: ["sup-small"],
    emails: ["smallyard@gmail.com"],
  },
];
const CONTACTS = [
  {
    id: "sup-cmi",
    name: "Combined Metal Industries Pty Ltd",
    email: "accounts@cmiwa.com.au",
  },
  {
    id: "sup-fw-2",
    name: "Fencing Warehouse",
    email: "accounts@fencingwarehousewa.au",
  },
];

// Fri 23 Oct 2026, 11:15 Perth. (4 Nov 2026 is a Wednesday.)
const RECEIVED = "2026-10-23T03:15:00Z";

function email(over: Partial<CapturedEmail> = {}): CapturedEmail {
  return {
    business_event_id: "be-1",
    sequence_number: 1,
    provider_message_id: "email:<a@b>",
    received_at: RECEIVED,
    from_email: "tony.bacich@stratcowa.com.au",
    subject: "RE: Material Order Ref SWF-261600",
    body: "Thanks, order received.",
    conversation_id: null,
    sender_kind: "supplier",
    has_attachments: false,
    attachment_names: [],
    ...over,
  };
}

function order(over: Partial<V2Order> = {}): V2Order {
  return {
    order_id: "ord-1",
    job_id: "job-1",
    job_number: "SWF-261600",
    supplier_id: "sup-stratco",
    supplier_name: "Stratco",
    status: "sent",
    sent_at: "2026-10-23T01:42:00Z",
    sent_internet_message_id: "sent-1@admin",
    sent_conversation_id: "CONV-1",
    confirmed_delivery_date: null,
    ...over,
  };
}

function job(over: Partial<JobHint> = {}): JobHint {
  return {
    job_id: "job-1",
    job_number: "SWF-261600",
    client_name: "Pat Example",
    site_address: "12 Sample Street",
    site_suburb: "Carlisle",
    status: "awaiting_supplier",
    type: "fencing",
    ...over,
  };
}

function inputs(over: Partial<MatchInputs> = {}): MatchInputs {
  const e = over.email ?? email();
  return {
    email: e,
    sender: identifySender(e.from_email, APPROVED, CONTACTS, e.sender_kind),
    orders: [order()],
    orderConversationIds: new Map([["ord-1", ["CONV-1"]]]),
    jobsByNumber: new Map(),
    refLinks: new Map(),
    jobsById: new Map([["job-1", job()]]),
    rejectedOrderIds: [],
    ...over,
  };
}

const NOW = "2026-10-23T08:00:00Z";

// ── Who sent it ───────────────────────────────────────────────────────────

Deno.test("sender: an approved order address names its supplier", () => {
  const s = identifySender(
    "Tony <TONY.BACICH@stratcowa.com.au>",
    APPROVED,
    CONTACTS,
  );
  assertEquals(s.is_supplier, true);
  assertEquals(s.supplier_key, "stratco");
  assertEquals(s.via, "approved_address");
  assertEquals(s.order_desk, true);
});

Deno.test("sender: another address at an approved domain is that supplier", () => {
  const s = identifySender("dispatch@stratcowa.com.au", APPROVED, CONTACTS);
  assertEquals(s.supplier_key, "stratco");
  assertEquals(s.via, "approved_domain");
});

Deno.test("sender: a shared mail domain never names a supplier by domain", () => {
  assertEquals(
    identifySender("smallyard@gmail.com", APPROVED, []).supplier_key,
    "smallyard",
  );
  assertEquals(
    identifySender("someone@gmail.com", APPROVED, []).is_supplier,
    false,
  );
});

Deno.test("sender: a Xero contact on the approved list takes that supplier's key", () => {
  const s = identifySender("accounts@fencingwarehousewa.au", [], CONTACTS);
  assertEquals(s.supplier_key, supplierKeyOf("Fencing Warehouse"));
  const t = identifySender(
    "accounts@fencingwarehousewa.au",
    APPROVED,
    CONTACTS,
  );
  // The approved domain wins first.
  assertEquals(t.supplier_key, "fencingwarehousewa");
  const u = identifySender("sales@cmiwa.com.au", APPROVED, CONTACTS);
  assertEquals(u.via, "supplier_contact_domain");
  assertEquals(u.supplier_key, "combinedmetalindustries");
  assertEquals(u.order_desk, false);
});

Deno.test("sender: our own addresses and strangers are not suppliers", () => {
  assertEquals(
    identifySender("admin@secureworkswa.com.au", APPROVED, CONTACTS)
      .is_supplier,
    false,
  );
  assertEquals(
    identifySender("client@example.com", APPROVED, CONTACTS).is_supplier,
    false,
  );
  // The capture reader's own supplier hint still marks it a supplier.
  const hinted = identifySender(
    "x@unknownsupplier.com.au",
    APPROVED,
    CONTACTS,
    "supplier",
  );
  assertEquals(hinted.is_supplier, true);
  assertEquals(hinted.supplier_key, null);
});

Deno.test("auto replies are recognised", () => {
  assert(isAutoReply("Automatic reply: Material Order Ref SWP-261283", ""));
  assert(isAutoReply("Out of Office: away", ""));
  assert(!isAutoReply("RE: Material Order Ref SWP-261283", "Booked for Tue"));
});

// ── What it quotes ────────────────────────────────────────────────────────

Deno.test("job numbers: fencing, patio and repair forms, normalised; make-safes left out", () => {
  assertEquals(
    jobNumbersIn(
      "RE: Material Order Ref SWF-261600",
      "also swp 26701 and SWR261499, not SWMS-261014",
    ),
    ["SWF-261600", "SWP-26701", "SWR-261499"],
  );
  assertEquals(jobNumbersIn("Order 238780", ""), []);
});

Deno.test("supplier refs: labelled numbers only, never our refs, accounts or dates", () => {
  assertEquals(
    supplierRefsIn(
      "Combined Metal Industries - Sales Order 238780 - Your Ref: SWP-26376",
      "",
    ),
    ["238780"],
  );
  assertEquals(
    supplierRefsIn("Tax Invoice 10094986 for Account 001185 - SECUREWORKS", ""),
    ["10094986"],
  );
  assertEquals(
    supplierRefsIn("Sales Invoice PSI-225053 - Your Ref: SWP-261046", ""),
    ["PSI-225053"],
  );
  assertEquals(
    supplierRefsIn("", "Your order #7781 is booked. Order No: 7781."),
    ["7781"],
  );
  assertEquals(supplierRefsIn("", "Quote Q12345 attached, ref 4/11/2026"), [
    "Q12345",
  ]);
  assertEquals(
    supplierRefsIn("RE: Material Order Ref SWF-261600", "PO-1000001"),
    [],
  );
});

// ── Delivery dates ────────────────────────────────────────────────────────

function dateOf(body: string, at = RECEIVED): string | null {
  return readDeliveryDate(body, at)?.date ?? null;
}

Deno.test("dates: the common Australian forms in a delivery sentence", () => {
  assertEquals(
    dateOf("Booked in for delivery Wednesday 4 November, morning run."),
    "2026-11-04",
  );
  assertEquals(dateOf("Delivery Wed 4 Nov"), "2026-11-04");
  assertEquals(dateOf("We can deliver on the 4th of November"), "2026-11-04");
  assertEquals(dateOf("ETA 4/11"), "2026-11-04");
  assertEquals(dateOf("Delivering 04/11/2026 AM"), "2026-11-04");
  assertEquals(dateOf("Will dispatch 4-11-26"), "2026-11-04");
  assertEquals(dateOf("Delivery Nov 4th"), "2026-11-04");
  assertEquals(dateOf("delivery 2026-11-04"), "2026-11-04");
  assertEquals(dateOf("Ready for pick up 4.11.2026"), "2026-11-04");
});

Deno.test("dates: day words count from the email's Perth day", () => {
  // Fri 23 Oct: tomorrow is Sat 24, Tuesday is Tue 27, Friday is next week's.
  assertEquals(dateOf("Delivering tomorrow"), "2026-10-24");
  assertEquals(dateOf("Truck will be there Tuesday"), "2026-10-27");
  assertEquals(dateOf("Delivery Friday"), "2026-10-30");
  assertEquals(
    readDeliveryDate("Truck will be there Tuesday", RECEIVED)?.day_word_only,
    true,
  );
  // 23:30 UTC on 22 Oct is already 23 Oct in Perth.
  assertEquals(perthDay("2026-10-22T23:30:00Z"), "2026-10-23");
});

Deno.test("dates: a written date beats a day word, and other dates are listed", () => {
  const r = readDeliveryDate(
    "Delivery Thursday. Actually delivery 4/11 or 5/11 if busy",
    RECEIVED,
  );
  assertEquals(r?.date, "2026-11-04");
  assertEquals(r?.other_dates.includes("2026-11-05"), true);
});

Deno.test("dates: no year rolls to next year only when well past", () => {
  // Received 20 Dec 2026: "delivery 5 Jan" is 5 Jan 2027.
  assertEquals(dateOf("delivery 5 Jan", "2026-12-20T02:00:00Z"), "2027-01-05");
});

Deno.test("dates: not read outside a delivery sentence, from headers, or when refused", () => {
  assertEquals(dateOf("Thanks, order received 4/11."), null);
  assertEquals(
    dateOf("Sent: Thursday, 23 October 2026 9:42 AM\nDate: Tue 4 Nov delivery"),
    null,
  );
  assertEquals(dateOf("Sorry, we cannot deliver Tue 4 Nov."), null);
  assertEquals(dateOf("We are closed for deliveries 24 Dec to 5 Jan."), null);
  assertEquals(dateOf("Our trucks deliver Mon to Fri."), null);
  assertEquals(dateOf("Delivered on 1 Oct."), null); // in the past
  assertEquals(dateOf("Order No 7781, delivering Tue 4 Nov"), "2026-11-04");
  assertEquals(
    dateOf(
      "Delivery 4/11\nOn Thu, 23 Oct 2026 at 9:42 am Admin wrote:\nDelivery 9/11",
    ),
    "2026-11-04",
  );
});

Deno.test("dates: a wrong weekday is flagged, the date wins", () => {
  const r = readDeliveryDate("Delivery Tue 4 Nov", RECEIVED);
  assertEquals(r?.date, "2026-11-04");
  assertEquals(r?.weekday_mismatch, true);
});

Deno.test("labels", () => {
  assertEquals(dayLabel("2026-11-04"), "Wed 4 Nov");
  assertEquals(dayLabel("2026-11-03"), "Tue 3 Nov");
  assertEquals(
    suggestionLabel("Stratco", "2026-11-03"),
    "Stratco: delivery Tue 3 Nov",
  );
  assertEquals(
    suggestionLabel(null, "2026-11-04"),
    "Supplier: delivery Wed 4 Nov",
  );
  assertEquals(
    suggestionLabel("Lysaght", "2026-11-02", "pickup"),
    "Lysaght: pickup Mon 2 Nov",
  );
  assertEquals(
    suggestionLabel("Lysaght", "2026-11-02", "delivery"),
    "Lysaght: delivery Mon 2 Nov",
  );
});

// ── The four rungs ────────────────────────────────────────────────────────

Deno.test("rung 1: same thread wins over everything else", () => {
  const r = matchEmail(
    inputs({
      email: email({
        conversation_id: "CONV-1",
        subject: "RE: Material Order Ref SWF-999999",
      }),
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "matched");
  assertEquals(r.rung, "thread");
  if (r.state === "matched") assertEquals(r.order_id, "ord-1");
});

Deno.test("rung 2: job number finds the job, and the sender's order on it", () => {
  const e = email({ conversation_id: "OTHER" });
  const r = matchEmail(
    inputs({
      email: e,
      jobsByNumber: new Map([["SWF-261600", job()]]),
      orders: [
        order(),
        order({
          order_id: "ord-2",
          supplier_id: "sup-fw-1",
          supplier_name: "Fencing Warehouse WA",
        }),
      ],
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "matched");
  assertEquals(r.rung, "job_number");
  if (r.state === "matched") assertEquals(r.order_id, "ord-1");
});

Deno.test("rung 2: a job with no order from that supplier is matched to the job only", () => {
  const r = matchEmail(
    inputs({ orders: [], jobsByNumber: new Map([["SWF-261600", job()]]) }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "matched");
  if (r.state === "matched") {
    assertEquals(r.job_id, "job-1");
    assertEquals(r.order_id, null);
  }
});

Deno.test("rung 2: two jobs named and no way to choose goes to the tray", () => {
  const r = matchEmail(
    inputs({
      email: email({
        subject: "Delivery run",
        body: "SWF-261600 and SWF-261601",
      }),
      orders: [],
      jobsByNumber: new Map([
        ["SWF-261600", job()],
        ["SWF-261601", job({ job_id: "job-2", job_number: "SWF-261601" })],
      ]),
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "unmatched");
  if (r.state === "unmatched") assertEquals(r.candidates.length, 2);
});

Deno.test("rung 3: the supplier's own number already linked", () => {
  const r = matchEmail(
    inputs({
      email: email({
        from_email: "sales@fencingwarehousewa.au",
        subject: "Order 7781 update",
        body: "Delivery Tue 4 Nov",
      }),
      orders: [
        order({
          order_id: "ord-fw",
          supplier_id: "sup-fw-1",
          supplier_name: "Fencing Warehouse WA",
        }),
        order({
          order_id: "ord-fw-b",
          job_id: "job-2",
          supplier_id: "sup-fw-1",
          supplier_name: "Fencing Warehouse WA",
        }),
      ],
      refLinks: new Map([["7781", [{
        order_id: "ord-fw",
        supplier_key: "fencingwarehousewa",
      }]]]),
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "matched");
  assertEquals(r.rung, "supplier_ref");
  if (r.state === "matched") assertEquals(r.order_id, "ord-fw");
});

Deno.test("rung 3: another supplier's link with the same number is ignored", () => {
  const r = matchEmail(
    inputs({
      email: email({ subject: "Order 7781 update", body: "" }),
      orders: [
        order({
          order_id: "ord-fw",
          supplier_id: "sup-fw-1",
          supplier_name: "Fencing Warehouse WA",
        }),
      ],
      refLinks: new Map([["7781", [{
        order_id: "ord-fw",
        supplier_key: "fencingwarehousewa",
      }]]]),
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "unmatched");
});

Deno.test("rung 4: one open order with the supplier is a best guess to confirm", () => {
  const r = matchEmail(
    inputs({
      email: email({ subject: "Your order", body: "Delivery Tue 4 Nov" }),
    }),
    APPROVED,
    NOW,
  );
  assertEquals(r.state, "needs_confirmation");
  if (r.state === "needs_confirmation") assertEquals(r.order_id, "ord-1");
});

Deno.test("rung 4: several open orders: the one whose address is named, else the tray", () => {
  const orders = [
    order(),
    order({ order_id: "ord-2", job_id: "job-2", job_number: "SWF-261601" }),
  ];
  const jobsById = new Map([
    ["job-1", job()],
    [
      "job-2",
      job({
        job_id: "job-2",
        job_number: "SWF-261601",
        site_address: "7 Other Road",
        client_name: "Lee Sample",
        site_suburb: "Bayswater",
      }),
    ],
  ]);
  const named = matchEmail(
    inputs({
      email: email({
        subject: "Delivery",
        body: "For 7 Other Road, delivery Tue 4 Nov",
      }),
      orders,
      jobsById,
    }),
    APPROVED,
    NOW,
  );
  assertEquals(named.state, "needs_confirmation");
  if (named.state === "needs_confirmation") {
    assertEquals(named.order_id, "ord-2");
  }
  const unnamed = matchEmail(
    inputs({
      email: email({ subject: "Delivery", body: "Delivery Tue 4 Nov" }),
      orders,
      jobsById,
    }),
    APPROVED,
    NOW,
  );
  assertEquals(unnamed.state, "unmatched");
  if (unnamed.state === "unmatched") assertEquals(unnamed.candidates.length, 2);
});

Deno.test("rung 4: a rejected guess is not guessed again, gone and old orders never", () => {
  assertEquals(
    matchEmail(
      inputs({
        email: email({ subject: "x", body: "" }),
        rejectedOrderIds: ["ord-1"],
      }),
      APPROVED,
      NOW,
    ).state,
    "unmatched",
  );
  assertEquals(
    matchEmail(
      inputs({
        email: email({ subject: "x", body: "" }),
        orders: [order({ status: "cancelled" })],
      }),
      APPROVED,
      NOW,
    ).state,
    "unmatched",
  );
  assertEquals(
    matchEmail(
      inputs({
        email: email({ subject: "x", body: "" }),
        orders: [order({ sent_at: "2026-05-01T00:00:00Z" })],
      }),
      APPROVED,
      NOW,
    ).state,
    "unmatched",
  );
});

Deno.test("stage move is only ever offered, from the two waiting stages, never for repairs", () => {
  assertEquals(stageMoveOffer(job())?.to_status, "order_confirmed");
  assertEquals(
    stageMoveOffer(job({ status: "order_materials" }))?.to_status,
    "order_confirmed",
  );
  assertEquals(stageMoveOffer(job({ status: "scheduled" })), null);
  assertEquals(stageMoveOffer(job({ type: "repair" })), null);
});
