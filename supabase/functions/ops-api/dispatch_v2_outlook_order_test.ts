// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2, Tweak 2 piece 1: an order Shaun sent from Outlook becomes a
// Dispatch order (dispatch_v2_outlook_order.ts, contract section 3f.1). The
// rules and the step the scan calls, on an in-memory store. No network.
//
// Run: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/dispatch_v2_outlook_order_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isOutlookOrderSubject,
  type JobOrderRow,
  type OutlookOrderStore,
  type OutlookSentEmail,
  outlookSentEmailOf,
  outlookTieReason,
  parseOutlookOrderBody,
  pickSentOrderEmail,
  pickSupplierId,
  readOrderDate,
  type RecordOutlookOrderInput,
  recordOutlookOrderForReply,
  sentToSupplier,
  type SupplierUsage,
} from "./dispatch_v2_outlook_order.ts";
import type {
  ApprovedSupplierSender,
  JobHint,
} from "./dispatch_v2_replies_rules.ts";

// ── Vesna's order (SWF-261586), as the capture saved it on 3 Nov 2026 ─────
// The real email text, with the client's phone number replaced.

const VESNA_BODY = [
  "Subject: Material Order Ref SWF-261586",
  "",
  "Hi Team, could we please order the following for delivery:",
  "",
  "Date: 12 November 2026",
  "Address: 29 Galileo Ave, Tapping WA 6065",
  "Contact: <PHONE> (Vesna)",
  "",
  "Materials Needed:",
  "1. 14 x 2100H standard width panels with 2700H posts",
  "Profile: Ridgeside",
  "Colour: Monument",
  "",
  "2. 4 x bags of quickset",
  "",
  "3. Fixings, Post Caps and Screws as necessary",
  "",
  "Please confirm when you can, thank you.",
  "",
  "Kind regards,",
  "Shaun Lee",
  "Operations Coordinator",
  "",
  "[cid:image001.png@01DB0000.00000000]",
  "E X C E L L E N C E | I N T E G R I T Y | S E R V I C E",
  "P: +61 489 267 771 | E: admin@secureworkswa.com.au",
].join("\n");

const VESNA_EVENT = {
  id: "c2d2936a-e6e5-4d2c-b12b-26b1ba2da667",
  provider_message_id:
    "email:sy3ppfe390838d4f8a0450e1f6e24a3315e936a2@sy3ppfe390838d4.ausp300.prod.outlook.com",
  event_at: "2026-11-03T09:05:03Z",
  recorded_at: "2026-11-03T09:07:02Z",
  privacy_classification: "staff_only",
  payload: {
    to: ["sales@randrfencing.com.au"],
    cc: ["fencing@secureworkswa.com.au"],
    from: "admin@secureworkswa.com.au",
    mailbox: "admin@secureworkswa.com.au",
    sent_by_user: "admin@secureworkswa.com.au",
    folder_kind: "sent",
    subject: "Material Order Ref SWF-261586",
    internet_message_id:
      "SY3PPFE390838D4F8A0450E1F6E24A3315E936A2@SY3PPFE390838D4.ausp300.prod.outlook.com",
    conversation_id: "AAQkADE1-VESNA-CONV",
    body: VESNA_BODY,
    body_truncated: false,
  },
};

const VESNA_REPLY = {
  id: "8d5a75c7-ffc6-490f-8b4d-192d5125ee00",
  conversation_id: "AAQkADE1-VESNA-CONV",
  received_at: "2026-11-04T01:31:26Z",
};

const ORG = "00000000-0000-0000-0000-000000000001";
const VESNA_JOB: JobHint = {
  job_id: "7db45c39-6ca0-4087-95c6-3c65a7ae8010",
  job_number: "SWF-261586",
  client_name: "Vesna Tapajner",
  site_address: "29 Galileo Ave",
  site_suburb: "Tapping",
  status: "scheduled",
  type: "fencing",
};

// R&R Fencing is three Xero contacts on one approved entry (live, 5 Nov).
const RR_MAIN = "c2bf210b-11dc-4821-849a-39a6de25aaaf";
const RR_CAPS = "022434eb-bba0-4726-b6ce-71a40632a275";
const RR_KVS = "fce8671a-1437-4afb-a434-35f0ab3ec0a0";
const RR: ApprovedSupplierSender = {
  supplier_key: "rrfencing",
  supplier_name: "R&R Fencing",
  supplier_ids: [RR_MAIN, RR_CAPS, RR_KVS],
  emails: ["sales@randrfencing.com.au"],
};
const RR_USAGE: SupplierUsage[] = [
  {
    supplier_id: RR_MAIN,
    last_order_at: "2026-10-26T13:52:17Z",
    last_box_at: "2026-10-26T13:00:00Z",
  },
  { supplier_id: RR_CAPS, last_order_at: null, last_box_at: "2026-10-30T00:00:00Z" },
];

function sentEmail(over: Partial<OutlookSentEmail> = {}): OutlookSentEmail {
  return { ...outlookSentEmailOf(VESNA_EVENT), ...over };
}

// ── Reading the email ─────────────────────────────────────────────────────

Deno.test("parse: Vesna's real Outlook order reads as a delivery on 12 Nov with three lines", () => {
  const sent = outlookSentEmailOf(VESNA_EVENT);
  const p = parseOutlookOrderBody(sent.body, sent.sent_at)!;
  assertEquals(p.fulfilment, "delivery");
  assertEquals(p.pickup_branch, null);
  assertEquals(p.date_mode, "date");
  assertEquals(p.date_text, "12 November 2026");
  assertEquals(p.delivery_date, "2026-11-12");
  assertEquals(p.address, "29 Galileo Ave, Tapping WA 6065");
  assertEquals(p.lines.map((l) => [l.text, l.standing]), [
    [
      "14 x 2100H standard width panels with 2700H posts\nProfile: Ridgeside\nColour: Monument",
      false,
    ],
    ["4 x bags of quickset", true],
    ["Fixings, Post Caps and Screws as necessary", true],
  ]);
  assertEquals(p.lines.every((l) => l.line_id === null), true);
  // The order as written: no subject line, no signature.
  assertEquals(
    p.body_text.startsWith(
      "Hi Team, could we please order the following for delivery:",
    ),
    true,
  );
  assertEquals(
    p.body_text.endsWith("Please confirm when you can, thank you."),
    true,
  );
  assertEquals(p.body_text.includes("Kind regards"), false);
  assertEquals(p.body_text.includes("Subject:"), false);
});

Deno.test("parse: pickup from a branch, ASAP, and a day with no year", () => {
  const pickup = parseOutlookOrderBody(
    [
      "Hi Team, could we please order the following for pickup from Neerabup:",
      "",
      "Date: ASAP",
      "Contact: <PHONE>",
      "",
      "Materials Needed:",
      "",
      "1. 6 x 2400 sheets",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
    "2026-11-03T01:00:00Z",
  )!;
  assertEquals(pickup.fulfilment, "pickup");
  assertEquals(pickup.pickup_branch, "Neerabup");
  assertEquals([pickup.date_mode, pickup.delivery_date], ["asap", null]);
  assertEquals(pickup.address, null);
  // No "Please confirm" line: the order ends at the sign-off.
  const signed = parseOutlookOrderBody(
    "Materials Needed:\n1. 3 x posts\n\nThanks,\nShaun",
    null,
  )!;
  assertEquals(signed.lines.map((l) => l.text), ["3 x posts"]);
  assertEquals(signed.body_text, "Materials Needed:\n1. 3 x posts");
});

Deno.test("date: the Date line's ways of naming a day", () => {
  const sent = "2026-11-03T01:00:00Z";
  assertEquals(readOrderDate("12 November 2026", sent), "2026-11-12");
  assertEquals(readOrderDate("Thu 12 Nov", sent), "2026-11-12");
  assertEquals(readOrderDate("12th of Nov", sent), "2026-11-12");
  assertEquals(readOrderDate("12/11/2026", sent), "2026-11-12");
  assertEquals(readOrderDate("12/11", sent), "2026-11-12");
  assertEquals(readOrderDate("1 Sept", sent), "2027-09-01");
  // A day a few weeks back stays this year (a typo, not next year).
  assertEquals(readOrderDate("5 Oct", sent), "2026-10-05");
  // Early January from a November send is next year.
  assertEquals(readOrderDate("6 Jan", sent), "2027-01-06");
  assertEquals(readOrderDate("ASAP", sent), null);
  assertEquals(readOrderDate("next week sometime", sent), null);
  assertEquals(readOrderDate("31/02/2026", sent), null);
  assertEquals(readOrderDate("", sent), null);
});

Deno.test("parse: an email we cannot read for certain is left alone", () => {
  // No Materials Needed heading.
  assertEquals(
    parseOutlookOrderBody("Hi Team, please send 14 panels. Thanks", null),
    null,
  );
  // A heading but no numbered line.
  assertEquals(
    parseOutlookOrderBody("Materials Needed:\n\nPlease confirm, thank you.", null),
    null,
  );
  // Words before the first numbered line.
  assertEquals(
    parseOutlookOrderBody(
      "Materials Needed:\nsome panels\n1. 14 x panels",
      null,
    ),
    null,
  );
});

Deno.test("subject: only our order subject for this job, never a reply or another job", () => {
  assertEquals(isOutlookOrderSubject("Material Order Ref SWF-261586", "SWF-261586"), true);
  assertEquals(isOutlookOrderSubject("material order ref swf261586", "SWF-261586"), true);
  assertEquals(isOutlookOrderSubject("Material Order Ref SWF-261586 - Vesna", "SWF-261586"), true);
  assertEquals(isOutlookOrderSubject("RE: Material Order Ref SWF-261586", "SWF-261586"), false);
  assertEquals(isOutlookOrderSubject("Material Order Ref SWF-2615861", "SWF-261586"), false);
  assertEquals(isOutlookOrderSubject("Material Order Ref SWF-261587", "SWF-261586"), false);
  assertEquals(isOutlookOrderSubject("Quote SWF-261586", "SWF-261586"), false);
});

Deno.test("recipients: the supplier's approved address or company domain, never a shared domain", () => {
  assertEquals(sentToSupplier(["sales@randrfencing.com.au"], RR), true);
  assertEquals(sentToSupplier(["Dave <dave@randrfencing.com.au>"], RR), true);
  assertEquals(sentToSupplier(["sales@fencingwarehousewa.au"], RR), false);
  assertEquals(
    sentToSupplier(["someone@gmail.com"], { emails: ["maxicoat@gmail.com"] }),
    false,
  );
  assertEquals(
    sentToSupplier(["maxicoat@gmail.com"], { emails: ["maxicoat@gmail.com"] }),
    true,
  );
});

// ── Choosing the sent email and the Xero contact ──────────────────────────

const PICK = {
  jobNumber: "SWF-261586",
  approved: RR,
  replyConversationId: VESNA_REPLY.conversation_id,
  replyReceivedAt: VESNA_REPLY.received_at,
  dispatchMessageKeys: new Set<string>(),
};

Deno.test("pick: the sent email in the reply's conversation wins, else the newest", () => {
  const older = sentEmail({
    business_event_id: "e-older",
    sent_at: "2026-11-02T01:00:00Z",
    provider_message_id: "email:older@x",
  });
  const newer = sentEmail({
    business_event_id: "e-newer",
    sent_at: "2026-11-03T12:00:00Z",
    conversation_id: "OTHER-CONV",
    provider_message_id: "email:newer@x",
  });
  assertEquals(pickSentOrderEmail([newer, older], PICK)?.business_event_id, "e-older");
  assertEquals(
    pickSentOrderEmail([newer, older], { ...PICK, replyConversationId: null })
      ?.business_event_id,
    "e-newer",
  );
});

Deno.test("pick: never a later email, another mailbox, another supplier, a cut-off body or a Dispatch send", () => {
  const ok = sentEmail();
  assertEquals(pickSentOrderEmail([ok], PICK)?.business_event_id, VESNA_EVENT.id);
  assertEquals(pickSentOrderEmail([sentEmail({ sent_at: "2026-11-04T02:00:00Z" })], PICK), null);
  assertEquals(
    pickSentOrderEmail([sentEmail({ mailbox: "shaun@secureworkswa.com.au", from_email: "shaun@secureworkswa.com.au" })], PICK),
    null,
  );
  assertEquals(pickSentOrderEmail([sentEmail({ to: ["sales@fencingwarehousewa.au"] })], PICK), null);
  assertEquals(pickSentOrderEmail([sentEmail({ body_truncated: true })], PICK), null);
  assertEquals(pickSentOrderEmail([sentEmail({ folder_kind: "inbox" })], PICK), null);
  assertEquals(
    pickSentOrderEmail([ok], {
      ...PICK,
      dispatchMessageKeys: new Set([VESNA_EVENT.provider_message_id]),
    }),
    null,
  );
});

Deno.test("supplier contact: the one boxed on the job, the only one, else the one Dispatch last sent to", () => {
  assertEquals(pickSupplierId([RR_MAIN, RR_CAPS, RR_KVS], [RR_CAPS], RR_USAGE), RR_CAPS);
  assertEquals(pickSupplierId(["only"], [], []), "only");
  assertEquals(pickSupplierId([RR_MAIN, RR_CAPS, RR_KVS], [], RR_USAGE), RR_MAIN);
  // Never sent to: the one last boxed.
  assertEquals(
    pickSupplierId([RR_CAPS, RR_KVS], [], RR_USAGE),
    RR_CAPS,
  );
  // Cannot be told: nothing is recorded.
  assertEquals(pickSupplierId([RR_CAPS, RR_KVS], [], []), null);
  assertEquals(pickSupplierId([RR_MAIN, RR_CAPS], [RR_MAIN, RR_CAPS], RR_USAGE), null);
  assertEquals(pickSupplierId([], [], RR_USAGE), null);
});

// ── The step the scan calls ───────────────────────────────────────────────

class FakeOutlookStore implements OutlookOrderStore {
  sent: OutlookSentEmail[] = [outlookSentEmailOf(VESNA_EVENT)];
  orders: JobOrderRow[] = [];
  boxes: string[] = [];
  usage: SupplierUsage[] = RR_USAGE;
  calls: RecordOutlookOrderInput[] = [];
  fail = false;
  sentOrderEmails(_org: string, jobNumber: string) {
    if (this.fail) return Promise.reject(new Error("read failed"));
    return Promise.resolve(
      this.sent.filter((e) => e.subject.includes(jobNumber.slice(4))),
    );
  }
  jobOrders() {
    return Promise.resolve(this.orders.map((o) => ({ ...o })));
  }
  jobBoxSupplierIds() {
    return Promise.resolve([...this.boxes]);
  }
  supplierUsage() {
    return Promise.resolve(this.usage);
  }
  recordOutlookOrder(input: RecordOutlookOrderInput) {
    this.calls.push(input);
    // As the database function does: once per sent email.
    const same = this.orders.find((o) =>
      o.source_business_event_id === input.source_business_event_id
    );
    if (same) {
      return Promise.resolve({
        recorded: false,
        order_id: same.id,
        box_created: false,
        reason: "already_recorded",
      });
    }
    const id = `order-${this.orders.length + 1}`;
    this.orders.push({
      id,
      supplier_id: input.supplier_id,
      status: "sent",
      origin: "outlook",
      source_business_event_id: input.source_business_event_id,
      sent_internet_message_id: input.sent_internet_message_id,
    });
    const boxCreated = !this.boxes.includes(input.supplier_id);
    if (boxCreated) this.boxes.push(input.supplier_id);
    return Promise.resolve({
      recorded: true,
      order_id: id,
      box_created: boxCreated,
      reason: null,
    });
  }
}

const STEP = { orgId: ORG, reply: VESNA_REPLY, job: VESNA_JOB, supplier: RR };

Deno.test("step: Vesna's order is recorded as a sent order with its real time, ids and lines", async () => {
  const store = new FakeOutlookStore();
  const out = await recordOutlookOrderForReply(store, STEP);
  assertEquals([out.recorded, out.box_created, out.reason], [true, true, "recorded"]);
  assertEquals(out.order?.supplier_id, RR_MAIN);
  assertEquals(out.order?.status, "sent");
  assertEquals(out.order?.sent_at, "2026-11-03T09:05:03Z");
  assertEquals(out.order?.sent_conversation_id, "AAQkADE1-VESNA-CONV");
  assertEquals(out.order?.fulfilment, "delivery");
  const call = store.calls[0];
  assertEquals(call.source_business_event_id, VESNA_EVENT.id);
  assertEquals(call.related_supplier_ids, [RR_MAIN, RR_CAPS, RR_KVS]);
  assertEquals(call.to_emails, ["sales@randrfencing.com.au"]);
  assertEquals(call.cc_emails, ["fencing@secureworkswa.com.au"]);
  assertEquals(call.team_cc_email, "fencing@secureworkswa.com.au");
  assertEquals(call.work_type, "fencing");
  assertEquals(call.subject, "Material Order Ref SWF-261586");
  assertEquals(call.delivery_date, "2026-11-12");
  assertEquals(call.order_lines.length, 3);
  assertEquals(call.standing_lines_included, true);
  assertEquals(call.sent_from_mailbox, "admin@secureworkswa.com.au");
  assertEquals(call.reply_email_id, VESNA_REPLY.id);
  assertEquals(outlookTieReason(out.order!), "Tied to the order sent from Outlook on Tue 3 Nov");
});

Deno.test("step: once per sent email; a second reply ties to the same order", async () => {
  const store = new FakeOutlookStore();
  const first = await recordOutlookOrderForReply(store, STEP);
  const second = await recordOutlookOrderForReply(store, {
    ...STEP,
    reply: { ...VESNA_REPLY, id: "second-reply", received_at: "2026-11-05T01:00:00Z" },
  });
  assertEquals(second.recorded, false);
  assertEquals(second.order?.order_id, first.order?.order_id);
  assertEquals(store.orders.length, 1);
});

Deno.test("step: a job with a Dispatch order for that supplier is left alone", async () => {
  for (const status of ["draft", "sent", "send_unknown"]) {
    const store = new FakeOutlookStore();
    store.orders = [{
      id: "dispatch-order",
      supplier_id: RR_CAPS,
      status,
      origin: "dispatch",
      source_business_event_id: null,
      sent_internet_message_id: null,
    }];
    const out = await recordOutlookOrderForReply(store, STEP);
    assertEquals([out.order, out.reason], [null, "dispatch_order_exists"]);
    assertEquals(store.calls.length, 0);
  }
  // A discarded draft does not count.
  const store = new FakeOutlookStore();
  store.orders = [{
    id: "thrown-away",
    supplier_id: RR_MAIN,
    status: "discarded",
    origin: "dispatch",
    source_business_event_id: null,
    sent_internet_message_id: null,
  }];
  assertEquals((await recordOutlookOrderForReply(store, STEP)).recorded, true);
});

Deno.test("step: nothing found, nothing readable, a failed read or no approved entry records nothing", async () => {
  const none = new FakeOutlookStore();
  none.sent = [];
  assertEquals((await recordOutlookOrderForReply(none, STEP)).reason, "sent_email_not_found");

  const unreadable = new FakeOutlookStore();
  unreadable.sent = [sentEmail({ body: "Hi Team, 14 panels please. Thanks" })];
  assertEquals((await recordOutlookOrderForReply(unreadable, STEP)).reason, "sent_email_not_read");

  const failing = new FakeOutlookStore();
  failing.fail = true;
  assertEquals((await recordOutlookOrderForReply(failing, STEP)).reason, "failed");

  const unknown = new FakeOutlookStore();
  unknown.usage = [];
  assertEquals(
    (await recordOutlookOrderForReply(unknown, STEP)).reason,
    "supplier_contact_not_known",
  );

  const notApproved = new FakeOutlookStore();
  assertEquals(
    (await recordOutlookOrderForReply(notApproved, { ...STEP, supplier: null }))
      .reason,
    "supplier_not_on_approved_list",
  );
  for (const s of [none, unreadable, failing, unknown, notApproved]) {
    assertEquals(s.calls.length, 0);
  }
});
