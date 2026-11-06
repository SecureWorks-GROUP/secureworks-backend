// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2 section 3g (Shaun, 6 Nov 2026): an order sent from Outlook
// becomes a Dispatch order when it is sent. The rules and the scan step on
// an in-memory store. No network.
//
// Run: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/dispatch_v2_outlook_on_send_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isDispatchOwnSend,
  jobOnDispatchBoard,
  type OnSendEntry,
  type OnSendJob,
  orderForStoredReply,
  OUR_SENT_ORDER_VIA,
  planSentOrderEmail,
  readOrderSubject,
  scanSentOrderEmails,
  type StoredReply,
  storedRepliesToTie,
  suppliersAddressed,
} from "./dispatch_v2_outlook_on_send.ts";
import { readOutlookOrderBody } from "./dispatch_v2_outlook_order.ts";
import {
  ADMIN,
  MemoryOnSendStore,
  sentEmail,
} from "./dispatch_v2_outlook_on_send_test_fakes.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = "2026-11-06T04:00:00Z";

// ── The suppliers (as on the approved order list, 6 Nov 2026) ────────────

const RR_MAIN = "c2bf210b-11dc-4821-849a-39a6de25aaaf";
const RR_CAPS = "022434eb-bba0-4726-b6ce-71a40632a275";
const METROLL = "5a0f6e9a-2d6f-4c43-9a43-7b1c1d3c2b10";
const STRATCO = "7d303bb6-7862-4885-b6a1-7581e2872a13";

const RR: OnSendEntry = {
  approved_id: "e0000000-0000-4000-8000-000000000001",
  supplier_key: "rrfencing",
  supplier_name: "R&R Fencing",
  supplier_ids: [RR_MAIN, RR_CAPS],
  emails: ["sales@randrfencing.com.au"],
  on_account: true,
};
const METROLL_E: OnSendEntry = {
  approved_id: "e0000000-0000-4000-8000-000000000002",
  supplier_key: "metroll",
  supplier_name: "Metroll",
  supplier_ids: [METROLL],
  emails: ["perth@metroll.com.au"],
  on_account: false,
};
const STRATCO_E: OnSendEntry = {
  approved_id: "e0000000-0000-4000-8000-000000000003",
  supplier_key: "stratcowa",
  supplier_name: "Stratco WA",
  supplier_ids: [STRATCO],
  emails: ["tradewa@stratco.com.au"],
  on_account: true,
};
// On the list, but no Xero supplier contact to link (like Westline).
const WESTLINE: OnSendEntry = {
  approved_id: "e0000000-0000-4000-8000-000000000004",
  supplier_key: "westlinefencing",
  supplier_name: "Westline Fencing",
  supplier_ids: [],
  emails: ["info@westlinefencing.com.au"],
  on_account: false,
};
// A supplier that uses a shared mail domain.
const BIGPOND_E: OnSendEntry = {
  approved_id: "e0000000-0000-4000-8000-000000000005",
  supplier_key: "smallsupplier",
  supplier_name: "Small Supplier",
  supplier_ids: ["5a0f6e9a-0000-4000-8000-000000000099"],
  emails: ["smallsupplier@bigpond.com"],
  on_account: false,
};
const ENTRIES = [RR, METROLL_E, STRATCO_E, WESTLINE, BIGPOND_E];

// ── The jobs ──────────────────────────────────────────────────────────────

function job(n: number, over: Partial<OnSendJob> = {}): OnSendJob {
  return {
    job_id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
    job_number: "SWF-261586",
    client_name: "Vesna Tapajner",
    status: "scheduled",
    type: "fencing",
    legacy: false,
    ses_family: null,
    makesafe_family: null,
    repair_stage: null,
    ...over,
  };
}
const VESNA = job(1);
const LOUISE = job(2, {
  job_number: "SWP-261283",
  client_name: "Louise Boyd",
  status: "in_progress",
  type: "patio",
});
const FINISHED = job(3, {
  job_number: "SWP-26348",
  client_name: "Done Client",
  status: "complete",
  type: "patio",
});
const REPAIR = job(4, {
  job_number: "SWR-261499",
  client_name: "Pat Kay",
  status: "processing",
  type: "repair",
  repair_stage: "materials",
});
const JOBS = [VESNA, LOUISE, FINISHED, REPAIR];

// Vesna's real order (3 Nov 2026), with the phone number replaced.
const VESNA_BODY = [
  "Hi Team, could we please order the following for delivery:",
  "",
  "Date: 12 November 2026",
  "Address: 29 Galileo Ave, Tapping WA 6065",
  "Contact: <PHONE> (Vesna)",
  "",
  "Materials Needed:",
  "1. 14 x 2100H standard width panels with 2700H posts",
  "Profile: Ridgeside",
  "",
  "2. 4 x bags of quickset",
  "",
  "Please confirm when you can, thank you.",
  "",
  "Kind regards,",
  "Shaun Lee",
].join("\n");

// An order with no numbered list (Louise's Metroll order, 22 Oct).
const NO_LIST_BODY = [
  "Hi Team, could we please order the attached cutting list for pickup from Bayswater:",
  "",
  "Date: ASAP",
  "",
  "See attached.",
  "",
  "Kind regards,",
  "Shaun Lee",
].join("\n");

function input(extra: { dispatchSends?: any[]; jobs?: OnSendJob[] } = {}) {
  const jobs = extra.jobs ?? JOBS;
  return {
    jobsByNumber: new Map(jobs.map((j) => [String(j.job_number), j])),
    entries: ENTRIES,
    dispatchSends: extra.dispatchSends ?? [],
  };
}

// ── The subject ───────────────────────────────────────────────────────────

Deno.test("subject: only one that starts Material Order Ref <job number> is an order", () => {
  assertEquals(readOrderSubject("Material Order Ref SWF-261586"), {
    kind: "order",
    job_number: "SWF-261586",
  });
  // Words after the number are fine; a colon or no hyphen too.
  assertEquals(
    readOrderSubject("Material Order Ref SWP-261283 - 2nd order"),
    { kind: "order", job_number: "SWP-261283" },
  );
  assertEquals(readOrderSubject("Material Order Ref: SWP-26701"), {
    kind: "order",
    job_number: "SWP-26701",
  });
  assertEquals(readOrderSubject("material order ref swf261586"), {
    kind: "order",
    job_number: "SWF-261586",
  });
  // Not one of our job numbers.
  assertEquals(readOrderSubject("Material Order Ref MLB-27836"), {
    kind: "order_unknown_number",
    token: "MLB-27836",
  });
  assertEquals(readOrderSubject("Material Order Ref SWMS-261100").kind, "order_unknown_number");
  // Never an order.
  assertEquals(readOrderSubject("Re: Material Order Ref SWF-261586").kind, "reply_or_forward");
  assertEquals(readOrderSubject("FW: Material Order Ref SWF-261586").kind, "reply_or_forward");
  assertEquals(readOrderSubject("Re: 30/11**Material Order Ref SWF-261586").kind, "reply_or_forward");
  assertEquals(readOrderSubject("Re: Material Order Inquiry Ref SWF-261586").kind, "reply_or_forward");
  assertEquals(readOrderSubject("Material Order Quote Ref SWP-261283").kind, "quote_request");
  assertEquals(readOrderSubject("Quote for SWF-261586").kind, "not_order");
  assertEquals(readOrderSubject("Urgent: Material Order Ref SWF-261586").kind, "not_order");
});

// ── Who it went to ────────────────────────────────────────────────────────

Deno.test("supplier: from the To addresses only; an approved address or its company domain", () => {
  const names = (to: string[]) =>
    suppliersAddressed(to, ENTRIES).map((a) => a.entry.supplier_name);
  assertEquals(names(["sales@randrfencing.com.au"]), ["R&R Fencing"]);
  // Another address at the same company.
  assertEquals(names(["Joe <joe@randrfencing.com.au>"]), ["R&R Fencing"]);
  // Two suppliers in one email: two orders.
  assertEquals(names(["perth@metroll.com.au", "tradewa@stratco.com.au"]), [
    "Metroll",
    "Stratco WA",
  ]);
  // The same supplier twice: once.
  assertEquals(names(["sales@randrfencing.com.au", "joe@randrfencing.com.au"]), [
    "R&R Fencing",
  ]);
  // A shared mail domain matches only the exact address.
  assertEquals(names(["smallsupplier@bigpond.com"]), ["Small Supplier"]);
  assertEquals(names(["someoneelse@bigpond.com"]), []);
  assertEquals(names(["fencing@secureworkswa.com.au"]), []);
});

Deno.test("own send: the same message or conversation as a Dispatch send", () => {
  const e = sentEmail(1, {
    internet_message_id: "<ABC@outlook.com>",
    provider_message_id: null,
    conversation_id: "CONV-1",
  });
  const send = (over: any) => ({
    origin: "dispatch",
    sent_internet_message_id: null,
    sent_conversation_id: null,
    ...over,
  });
  assert(isDispatchOwnSend(e, [send({ sent_internet_message_id: "abc@outlook.com" })]));
  assert(isDispatchOwnSend(e, [send({ sent_conversation_id: "CONV-1" })]));
  assert(!isDispatchOwnSend(e, [send({ sent_conversation_id: "CONV-2" })]));
  // An Outlook order is not a Dispatch send.
  assert(!isDispatchOwnSend(e, [send({ origin: "outlook", sent_conversation_id: "CONV-1" })]));
});

Deno.test("board: the board's own rule, repairs at Materials or Scheduled included", () => {
  assertEquals(jobOnDispatchBoard(VESNA), {
    on_board: true,
    stage_label: "Scheduled",
    finished: false,
  });
  assertEquals(jobOnDispatchBoard(LOUISE).on_board, true);
  assertEquals(jobOnDispatchBoard(FINISHED).on_board, false);
  assertEquals(jobOnDispatchBoard(FINISHED).finished, true);
  const repair = jobOnDispatchBoard(REPAIR);
  assertEquals([repair.on_board, repair.stage_label], [true, "Repair: Materials"]);
  assertEquals(
    jobOnDispatchBoard({ ...REPAIR, repair_stage: "quote" }).on_board,
    false,
  );
  assertEquals(jobOnDispatchBoard({ ...VESNA, legacy: true }).on_board, false);
  assertEquals(
    jobOnDispatchBoard({ ...VESNA, client_name: "Marnin Test Fence" }).on_board,
    false,
  );
  assertEquals(jobOnDispatchBoard({ ...VESNA, status: "accepted" }).on_board, false);
});

// ── The plan for one sent email ───────────────────────────────────────────

Deno.test("plan: Vesna's order to R&R is one order with its lines, delivery, date and address", () => {
  const p = planSentOrderEmail(
    sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY }),
    input(),
  );
  assertEquals([p.verdict, p.job_number, p.job?.job_id], ["orders", "SWF-261586", VESNA.job_id]);
  assertEquals(p.orders.length, 1);
  const o = p.orders[0].parsed;
  assertEquals(o.list_read, true);
  assertEquals(o.lines.map((l) => l.text), [
    "14 x 2100H standard width panels with 2700H posts\nProfile: Ridgeside",
    "4 x bags of quickset",
  ]);
  assertEquals(
    [o.fulfilment, o.date_mode, o.delivery_date, o.address],
    ["delivery", "date", "2026-11-12", "29 Galileo Ave, Tapping WA 6065"],
  );
});

Deno.test("plan: no readable list keeps the email's words as the order, lines empty", () => {
  const p = planSentOrderEmail(
    sentEmail(2, {
      subject: "Material Order Ref SWP-261283",
      to: ["perth@metroll.com.au"],
      body: NO_LIST_BODY,
    }),
    input(),
  );
  assertEquals(p.verdict, "orders");
  const o = p.orders[0].parsed;
  assertEquals([o.list_read, o.lines.length], [false, 0]);
  assertEquals([o.fulfilment, o.date_mode], ["pickup", "asap"]);
  assert(o.body_text.startsWith("Hi Team, could we please order the attached"));
  assert(!o.body_text.includes("Kind regards"));
  // An email with no words at all is never an order.
  assertEquals(readOutlookOrderBody("   ", null), null);
});

Deno.test("plan: refused or ignored, each for its reason", () => {
  const plan = (over: any) =>
    planSentOrderEmail(
      sentEmail(3, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY, ...over }),
      input({ dispatchSends: [{ origin: "dispatch", sent_internet_message_id: "<own@outlook.com>", sent_conversation_id: null }] }),
    );
  const seen = (over: any) => {
    const p = plan(over);
    return [p.verdict, p.reason];
  };
  assertEquals(seen({ mailbox: "shaun@secureworkswa.com.au", from_email: "shaun@secureworkswa.com.au" }), ["ignored", "not_sent_from_admin"]);
  assertEquals(seen({ folder_kind: "inbox" }), ["ignored", "not_sent_from_admin"]);
  assertEquals(seen({ subject: "RE: Material Order Ref SWF-261586" }), ["ignored", "reply_or_forward"]);
  assertEquals(seen({ subject: "Material Order Quote Ref SWF-261586" }), ["ignored", "quote_request"]);
  assertEquals(seen({ internet_message_id: "own@outlook.com", provider_message_id: null }), ["ignored", "dispatch_own_send"]);
  assertEquals(seen({ to: ["someone@gmail.com"] }), ["ignored", "not_to_a_supplier"]);
  assertEquals(seen({ subject: "Material Order Ref MLB-27836" }), ["refused", "job_number_unknown"]);
  assertEquals(seen({ subject: "Material Order Ref SWF-999999" }), ["refused", "job_number_unknown"]);
  assertEquals(seen({ subject: "Material Order Ref SWP-26348" }), ["refused", "job_not_on_board"]);
  assertEquals(seen({ to: ["info@westlinefencing.com.au"] }), ["refused", "supplier_not_in_xero"]);
  assertEquals(seen({ body: "" }), ["refused", "no_words"]);
  // The refusal says why, in plain words.
  const p = plan({ subject: "Material Order Ref SWP-26348" });
  assert(String(p.reason_text).includes("not on the Dispatch board (Complete)"));
});

Deno.test("plan: one email to two suppliers is two orders; one with no Xero contact also waits to be sorted", () => {
  const two = planSentOrderEmail(
    sentEmail(4, {
      to: ["perth@metroll.com.au", "tradewa@stratco.com.au"],
      body: VESNA_BODY,
    }),
    input(),
  );
  assertEquals(two.orders.map((o) => o.entry.supplier_name), ["Metroll", "Stratco WA"]);
  const part = planSentOrderEmail(
    sentEmail(5, {
      to: ["perth@metroll.com.au", "info@westlinefencing.com.au"],
      body: VESNA_BODY,
    }),
    input(),
  );
  assertEquals(part.verdict, "orders");
  assertEquals(part.orders.map((o) => o.entry.supplier_name), ["Metroll"]);
  assertEquals(part.unlinked.map((e) => e.supplier_name), ["Westline Fencing"]);
});

// ── Stored replies ────────────────────────────────────────────────────────

function reply(n: number, over: Partial<StoredReply> = {}): StoredReply {
  return {
    id: `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`,
    job_id: VESNA.job_id,
    order_id: null,
    state: "matched",
    rung: "job_number",
    supplier_key: "rrfencing",
    from_email: "sales@randrfencing.com.au",
    conversation_id: null,
    received_at: "2026-11-04T01:31:26Z",
    match_reason: "Job number SWF-261586 in the email",
    subject: "RE: Material Order Ref SWF-261586",
    ...over,
  };
}

Deno.test("replies: the order in the reply's thread, else the newest sent before it", () => {
  const orders = [
    { order_id: "o1", sent_at: "2026-11-01T00:00:00Z", sent_conversation_id: "C1" },
    { order_id: "o2", sent_at: "2026-11-03T00:00:00Z", sent_conversation_id: "C2" },
    { order_id: "o3", sent_at: "2026-11-05T00:00:00Z", sent_conversation_id: "C3" },
  ];
  const at = "2026-11-04T00:00:00Z";
  assertEquals(orderForStoredReply({ conversation_id: "C1", received_at: at }, orders)?.order_id, "o1");
  assertEquals(orderForStoredReply({ conversation_id: null, received_at: at }, orders)?.order_id, "o2");
  // Its thread's order was sent after it: the newest before it instead.
  assertEquals(orderForStoredReply({ conversation_id: "C3", received_at: at }, orders)?.order_id, "o2");
  assertEquals(orderForStoredReply({ conversation_id: null, received_at: "2026-10-01T00:00:00Z" }, orders), null);
});

Deno.test("replies: only matched, on this job, with no order, from this supplier, to an order just recorded", () => {
  const orders = [
    { order_id: "new", sent_at: "2026-11-03T02:00:00Z", sent_conversation_id: "CONV-SENT-1" },
  ];
  const replies = [
    reply(1),
    reply(2, { order_id: "other" }),
    reply(3, { state: "unmatched" }),
    reply(4, { job_id: LOUISE.job_id }),
    reply(5, { supplier_key: "metroll", from_email: "perth@metroll.com.au" }),
    // Another address at R&R, stored with no supplier key.
    reply(6, { supplier_key: null, from_email: "joe@randrfencing.com.au" }),
    // Before the order was sent.
    reply(7, { received_at: "2026-11-02T00:00:00Z" }),
  ];
  const ties = storedRepliesToTie(replies, {
    job_id: VESNA.job_id,
    entry: RR,
    orders,
    tieable: new Set(["new"]),
  });
  assertEquals(ties.map((t) => t.reply.id.slice(-1)), ["1", "6"]);
  // Not one of the orders just recorded: left alone.
  assertEquals(
    storedRepliesToTie(replies, { job_id: VESNA.job_id, entry: RR, orders, tieable: new Set() }).length,
    0,
  );
});

// ── The scan step ─────────────────────────────────────────────────────────

/** The reply table as far as the send rule uses it: the tray rows. */
function trayStore() {
  const rows: any[] = [];
  return {
    rows,
    insertEmail(row: any) {
      if (rows.some((r) => r.business_event_id === row.business_event_id)) {
        return Promise.resolve(null);
      }
      const full = { ...row, id: `tray-${rows.length + 1}` };
      rows.push(full);
      return Promise.resolve(full);
    },
  } as any;
}

function scanSetup() {
  const store = new MemoryOnSendStore();
  store.entries = ENTRIES.map((e) => ({ ...e }));
  store.jobs = JOBS.map((j) => ({ ...j }));
  store.usage = [{ supplier_id: RR_MAIN, last_order_at: "2026-10-26T13:52:17Z", last_box_at: null }];
  const tray = trayStore();
  store.storedEventIds = (ids: string[]) =>
    Promise.resolve(
      new Set(tray.rows.map((r: any) => r.business_event_id).filter((x: string) => ids.includes(x))),
    );
  const run = (now = NOW) =>
    scanSentOrderEmails({ orgId: ORG, store, replies: tray, now });
  return { store, tray, run };
}

Deno.test("scan: the first run only starts the clock; nothing older is recorded", async () => {
  const t = scanSetup();
  t.store.sent = [sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY })];
  const r = await t.run();
  assertEquals(r.first_run, true);
  assertEquals(t.store.since, NOW);
  assertEquals(t.store.calls.length, 0);
});

Deno.test("scan: an order sent after the start is recorded at once, with its box, as Sent", async () => {
  const t = scanSetup();
  t.store.since = "2026-11-03T00:00:00Z";
  t.store.sent = [sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY })];
  const r = await t.run();
  assertEquals([r.sent_read, r.sent_orders, r.sent_failed], [1, 1, 0]);
  assertEquals(t.store.calls.length, 1);
  const c = t.store.calls[0];
  assertEquals(
    [c.trigger, c.job_id, c.supplier_id, c.approved_email_id, c.work_type],
    ["send", VESNA.job_id, RR_MAIN, RR.approved_id, "fencing"],
  );
  assertEquals(c.order_lines.length, 2);
  assertEquals(c.delivery_date, "2026-11-12");
  assertEquals(c.sent_at, "2026-11-03T02:00:00Z");
  assertEquals(c.to_emails, ["sales@randrfencing.com.au"]);
  assertEquals(t.store.boxes.length, 1);
  // Run again: the same email is never a second order.
  const again = await t.run();
  assertEquals([again.sent_orders, again.sent_already], [0, 1]);
  assertEquals(t.store.orders.length, 1);
});

Deno.test("scan: a second order to the same supplier reuses the box", async () => {
  const t = scanSetup();
  t.store.since = "2026-11-01T00:00:00Z";
  t.store.sent = [
    sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY }),
    sentEmail(2, {
      to: ["sales@randrfencing.com.au"],
      body: VESNA_BODY,
      subject: "Material Order Ref SWF-261586 extra posts",
      sent_at: "2026-11-04T02:00:00Z",
    }),
  ];
  const r = await t.run();
  assertEquals(r.sent_orders, 2);
  assertEquals(t.store.boxes.length, 1);
  assertEquals(t.store.orders.map((o) => o.supplier_id), [RR_MAIN, RR_MAIN]);
});

Deno.test("scan: a wrong job number, a finished job or a supplier not in Xero waits under Emails to sort", async () => {
  const t = scanSetup();
  t.store.since = "2026-11-01T00:00:00Z";
  t.store.sent = [
    sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY, subject: "Material Order Ref MLB-27836" }),
    sentEmail(2, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY, subject: "Material Order Ref SWP-26348" }),
    sentEmail(3, { to: ["info@westlinefencing.com.au"], body: VESNA_BODY }),
    // Ignored, and not put anywhere.
    sentEmail(4, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY, subject: "Re: Material Order Ref SWF-261586" }),
  ];
  const r = await t.run();
  assertEquals([r.sent_orders, r.sent_to_sort, r.sent_ignored], [0, 3, 1]);
  assertEquals(t.store.calls.length, 0);
  for (const row of t.tray.rows) {
    assertEquals([row.state, row.order_desk, row.sender_via, row.job_id, row.order_id], [
      "unmatched",
      true,
      OUR_SENT_ORDER_VIA,
      null,
      null,
    ]);
    assertEquals(row.from_email, ADMIN);
  }
  assertEquals(t.tray.rows[1].job_numbers, ["SWP-26348"]);
  assertEquals(t.tray.rows[0].job_numbers, []);
  assertEquals(t.tray.rows[2].supplier_name, "Westline Fencing");
  // Next run: already sorted, nothing new.
  const again = await t.run();
  assertEquals([again.sent_to_sort, again.sent_already], [0, 4 - 1]);
});

Deno.test("scan: stored replies the scan matched to the job alone are tied to the new order", async () => {
  const t = scanSetup();
  t.store.since = "2026-11-01T00:00:00Z";
  t.store.sent = [sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY })];
  t.store.replies = [reply(1)];
  const r = await t.run();
  assertEquals(r.sent_replies_tied, 1);
  const tied = t.store.replies[0];
  assertEquals(tied.order_id, t.store.orders[0].order_id);
  assert(String(tied.match_reason).endsWith("Tied to the order sent from Outlook on Tue 3 Nov"));
});

Deno.test("scan: a failed read or write is counted and the scan carries on", async () => {
  const t = scanSetup();
  t.store.since = "2026-11-01T00:00:00Z";
  t.store.sent = [sentEmail(1, { to: ["sales@randrfencing.com.au"], body: VESNA_BODY })];
  t.store.failing.add("recordOrder");
  const r = await t.run();
  assertEquals([r.sent_orders, r.sent_failed], [0, 1]);
  // Fixed: the next run records it (it is still within the seven days).
  t.store.failing.clear();
  assertEquals((await t.run()).sent_orders, 1);
  t.store.failing.add("sentOrdersSince");
  assertEquals((await t.run()).sent_failed, 1);
});
