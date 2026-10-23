// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2, slice 8: the reply engine, end to end on an in-memory database
// and fake sibling sources. No network, no Supabase.
//
// Run: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/dispatch_v2_replies_test.ts

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DispatchV2RepliesContext,
  runDispatchV2RepliesAction,
} from "./dispatch_v2_replies.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";
import {
  capturedEmailOf,
  type EmailRow,
  type RefLinkRow,
  type RepliesStore,
  type ScanState,
  type SuggestionRow,
} from "./dispatch_v2_replies_store.ts";
import type {
  DispatchRepliesSources,
  SetConfirmedDeliveryInput,
} from "./dispatch_v2_replies_sources.ts";
import {
  type JobHint,
  jobNumberForms,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
// Fri 23 Oct 2026, 11:15 Perth. The scan runs at 16:00 Perth.
const RECEIVED = "2026-10-23T03:15:00Z";
const NOW = "2026-10-23T08:00:00Z";

const S_STRATCO = "7d303bb6-7862-4885-b6a1-7581e2872a13";
const S_CMI = "134e926d-d3b5-43a0-9db0-e2b7d7e565ab";
const S_FW = "6e81fd10-63c0-4267-a6e2-1cfc8e4e518a";
const S_BUNNINGS = "57ab8d8c-1865-41cd-b0b0-d0055997ad89";

const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const J3 = "33333333-3333-4333-8333-333333333333";
const O1 = "aaaaaaa1-0000-4000-8000-000000000001";
const O2 = "aaaaaaa2-0000-4000-8000-000000000002";
const O3 = "aaaaaaa3-0000-4000-8000-000000000003";
const SHAUN = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "shaun@secureworkswa.com.au",
};

function uuid(n: number): string {
  return `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const JOBS: JobHint[] = [
  {
    job_id: J1,
    job_number: "SWF-261387",
    client_name: "Jo Smith",
    site_address: "12 Example St",
    site_suburb: "Carlisle",
    status: "awaiting_supplier",
    type: "fencing",
  },
  {
    job_id: J2,
    job_number: "SWP-26701",
    client_name: "Ann Lee",
    site_address: "5 Banksia Rd",
    site_suburb: "Morley",
    status: "order_materials",
    type: "patio",
  },
  {
    job_id: J3,
    job_number: "SWR-261499",
    client_name: "Pat Kay",
    site_address: "8 Hill Way",
    site_suburb: "Bassendean",
    status: "processing",
    type: "repair",
  },
];

function baseOrders(): V2Order[] {
  return [
    {
      order_id: O1,
      job_id: J1,
      job_number: "SWF-261387",
      supplier_id: S_STRATCO,
      supplier_name: "Stratco WA",
      status: "sent",
      sent_at: "2026-10-20T01:00:00Z",
      sent_internet_message_id: "<o1@outlook.com>",
      sent_conversation_id: "CONV-O1",
      confirmed_delivery_date: null,
    },
    {
      order_id: O2,
      job_id: J2,
      job_number: "SWP-26701",
      supplier_id: S_STRATCO,
      supplier_name: "Stratco WA",
      status: "sent",
      sent_at: "2026-10-21T01:00:00Z",
      sent_internet_message_id: "<o2@outlook.com>",
      sent_conversation_id: null,
      confirmed_delivery_date: null,
    },
    {
      order_id: O3,
      job_id: J2,
      job_number: "SWP-26701",
      supplier_id: S_CMI,
      supplier_name: "CMI (Combined Metal Industries)",
      status: "sent",
      sent_at: "2026-10-19T01:00:00Z",
      sent_internet_message_id: "<o3@outlook.com>",
      sent_conversation_id: "CONV-O3",
      confirmed_delivery_date: null,
    },
  ];
}

type Captured = {
  seq: number;
  from: string;
  subject: string;
  body: string;
  conv?: string | null;
  recorded_at?: string;
  event_at?: string;
  privacy?: string;
  direction?: string;
  history_tier?: string;
  sender_kind?: string;
  provider?: string;
};

function eventRow(c: Captured) {
  return {
    id: uuid(c.seq),
    sequence_number: c.seq,
    provider_message_id: c.provider ?? `email:m${c.seq}@supplier.example`,
    event_at: c.event_at ?? RECEIVED,
    recorded_at: c.recorded_at ?? RECEIVED,
    privacy_classification: c.privacy ?? "staff_only",
    channel: "email",
    direction: c.direction ?? "inbound",
    payload: {
      from: c.from,
      subject: c.subject,
      body: `Subject: ${c.subject}\n\n${c.body}`,
      conversation_id: c.conv ?? null,
      sender_kind: c.sender_kind ?? "supplier",
      has_attachments: false,
      attachments: [],
    },
    metadata: {
      capture_mode: "live",
      ...(c.history_tier ? { history_tier: c.history_tier } : {}),
    },
  };
}

// ── The in-memory database ────────────────────────────────────────────────

class MemoryStore implements RepliesStore {
  flag = true;
  scan: ScanState = {
    cursor_sequence: null,
    last_scan_at: null,
    last_result: {},
  };
  events: any[] = [];
  emails: EmailRow[] = [];
  refs: (RefLinkRow & { org_id: string })[] = [];
  suggestions: SuggestionRow[] = [];
  jobEvents: any[] = [];
  jobs: JobHint[] = JOBS.map((j) => ({ ...j }));
  n = 0;

  id() {
    this.n++;
    return `dddddddd-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }
  flagEnabled() {
    return Promise.resolve(this.flag);
  }
  getScanState() {
    return Promise.resolve({ ...this.scan });
  }
  saveScanState(s: ScanState) {
    this.scan = { ...s };
    return Promise.resolve();
  }
  headSequence() {
    return Promise.resolve(
      this.events.length
        ? Math.max(...this.events.map((e) => e.sequence_number))
        : null,
    );
  }
  readInboundEmails(after: number, before: string, limit: number) {
    return Promise.resolve(
      this.events
        .filter((e) =>
          e.channel === "email" && e.direction === "inbound" &&
          e.sequence_number > after && e.recorded_at < before &&
          e.privacy_classification !== "restricted_pii"
        )
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, limit)
        .map(capturedEmailOf),
    );
  }
  conversationIdsFor(keys: string[]) {
    const out = new Map<string, string>();
    for (const e of this.events) {
      if (keys.includes(e.provider_message_id) && e.payload.conversation_id) {
        out.set(e.provider_message_id, e.payload.conversation_id);
      }
    }
    return Promise.resolve(out);
  }
  supplierContacts() {
    return Promise.resolve([
      {
        id: S_STRATCO,
        name: "Stratco (WA) Pty Ltd",
        email: "accounts@stratcowa.com.au",
      },
      {
        id: S_CMI,
        name: "Combined Metal Industries",
        email: "kris.idnay@cmiwa.com.au",
      },
      { id: S_FW, name: "Fencing Warehouse WA", email: null },
      {
        id: S_BUNNINGS,
        name: "Bunnings Group Ltd",
        email: "news@bunnings-mail.com.au",
      },
    ]);
  }
  jobsByNumbers(_org: string, numbers: string[]) {
    const forms = numbers.flatMap(jobNumberForms);
    return Promise.resolve(
      this.jobs.filter((j) => forms.includes(String(j.job_number))),
    );
  }
  jobsByIds(_org: string, ids: string[]) {
    return Promise.resolve(this.jobs.filter((j) => ids.includes(j.job_id)));
  }
  refLinks(_org: string, refs: string[]) {
    return Promise.resolve(this.refs.filter((r) => refs.includes(r.ref)));
  }
  insertRefLinks(org: string, rows: RefLinkRow[]) {
    for (const r of rows) {
      if (
        !this.refs.some((x) => x.order_id === r.order_id && x.ref === r.ref)
      ) {
        this.refs.push({ ...r, org_id: org });
      }
    }
    return Promise.resolve();
  }
  storedEventIds(ids: string[]) {
    return Promise.resolve(
      new Set(
        this.emails.map((e) => e.business_event_id).filter((x) =>
          ids.includes(x)
        ),
      ),
    );
  }
  insertEmail(row: any) {
    if (
      this.emails.some((e) => e.business_event_id === row.business_event_id)
    ) {
      return Promise.resolve(null);
    }
    const full = { ...row, id: this.id(), created_at: NOW, updated_at: NOW };
    this.emails.push(full);
    return Promise.resolve({ ...full });
  }
  getEmail(_org: string, id: string) {
    const e = this.emails.find((x) => x.id === id);
    return Promise.resolve(e ? { ...e } : null);
  }
  updateEmail(_org: string, id: string, expect: string, patch: any) {
    const e = this.emails.find((x) => x.id === id && x.state === expect);
    if (!e) return Promise.resolve(null);
    Object.assign(e, patch);
    return Promise.resolve({ ...e });
  }
  emailsForJob(_org: string, jobId: string, limit: number) {
    return Promise.resolve(
      this.emails.filter((e) =>
        e.job_id === jobId &&
        ["matched", "needs_confirmation"].includes(e.state)
      ).slice(0, limit),
    );
  }
  tray(_org: string, opts: { includeOther: boolean; limit: number }) {
    const rows = this.emails.filter((e) =>
      (e.state === "unmatched" && (opts.includeOther || e.order_desk)) ||
      e.state === "needs_confirmation"
    ).slice(0, opts.limit);
    const count = (f: (e: EmailRow) => boolean) => this.emails.filter(f).length;
    return Promise.resolve({
      rows,
      counts: {
        needs_confirmation: count((e) => e.state === "needs_confirmation"),
        unmatched_order_desk: count((e) =>
          e.state === "unmatched" && e.order_desk
        ),
        unmatched_other: count((e) => e.state === "unmatched" && !e.order_desk),
      },
    });
  }
  insertSuggestion(row: any) {
    if (this.suggestions.some((s) => s.email_id === row.email_id)) {
      return Promise.resolve(null);
    }
    const full = { ...row, id: this.id(), created_at: NOW, updated_at: NOW };
    this.suggestions.push(full);
    return Promise.resolve({ ...full });
  }
  getSuggestion(_org: string, id: string) {
    const s = this.suggestions.find((x) => x.id === id);
    return Promise.resolve(s ? { ...s } : null);
  }
  updateSuggestion(_org: string, id: string, expect: string, patch: any) {
    const s = this.suggestions.find((x) => x.id === id && x.state === expect);
    if (!s) return Promise.resolve(null);
    Object.assign(s, patch);
    return Promise.resolve({ ...s });
  }
  supersedeOpenForOrder(_org: string, orderId: string, keepId: string | null) {
    for (const s of this.suggestions) {
      if (s.order_id === orderId && s.state === "open" && s.id !== keepId) {
        s.state = "superseded";
      }
    }
    return Promise.resolve();
  }
  suggestionsForJob(_org: string, jobId: string) {
    return Promise.resolve(this.suggestions.filter((s) => s.job_id === jobId));
  }
  suggestionsForEmails(_org: string, ids: string[]) {
    return Promise.resolve(
      this.suggestions.filter((s) => ids.includes(s.email_id)).map((s) => ({
        ...s,
      })),
    );
  }
  userByEmail(_org: string, email: string) {
    return Promise.resolve(
      email.toLowerCase() === SHAUN.email ? { ...SHAUN } : null,
    );
  }
  logJobEvent(jobId: string, userId: string | null, type: string, detail: any) {
    this.jobEvents.push({
      job_id: jobId,
      user_id: userId,
      event_type: type,
      detail,
    });
    return Promise.resolve(true);
  }
}

class FakeSources implements DispatchRepliesSources {
  wired = true;
  orders = baseOrders();
  writes: SetConfirmedDeliveryInput[] = [];
  listOrders(_org: string, opts: { sentSince: string; jobIds?: string[] }) {
    if (!this.wired) return Promise.resolve({ available: false, rows: [] });
    return Promise.resolve({
      available: true,
      rows: this.orders.filter((o) =>
        (o.sent_at ?? "") >= opts.sentSince ||
        (opts.jobIds ?? []).includes(o.job_id)
      ).map((o) => ({ ...o })),
    });
  }
  getOrder(_org: string, id: string) {
    if (!this.wired) return Promise.resolve({ available: false, rows: [] });
    return Promise.resolve({
      available: true,
      rows: this.orders.filter((o) => o.order_id === id).map((o) => ({ ...o })),
    });
  }
  listApprovedSenders() {
    return Promise.resolve({
      available: true,
      rows: [
        {
          supplier_key: "stratcowa",
          supplier_name: "Stratco WA",
          supplier_ids: [S_STRATCO],
          emails: ["tradewa@stratcowa.com.au", "tony.bacich@stratcowa.com.au"],
        },
        {
          supplier_key: "fencingwarehousewa",
          supplier_name: "Fencing Warehouse WA",
          supplier_ids: [S_FW],
          emails: ["sales@fencingwarehousewa.au"],
        },
        {
          supplier_key: "cmicombinedmetalindustries",
          supplier_name: "CMI (Combined Metal Industries)",
          supplier_ids: [S_CMI],
          emails: ["kris.idnay@cmiwa.com.au"],
        },
      ],
    });
  }
  setConfirmedDeliveryDate(input: SetConfirmedDeliveryInput) {
    if (!this.wired) {
      return Promise.resolve({
        ok: false as const,
        status: 503,
        code: "orders_not_wired",
        message: "not wired",
      });
    }
    this.writes.push(input);
    const o = this.orders.find((x) => x.order_id === input.order.order_id)!;
    o.confirmed_delivery_date = input.date;
    return Promise.resolve({
      ok: true as const,
      confirmed_delivery_date: input.date,
    });
  }
}

function setup(via: "screen" | "terminal" = "screen") {
  const store = new MemoryStore();
  const sources = new FakeSources();
  const ctx: DispatchV2RepliesContext = {
    orgId: ORG,
    actor: via === "screen"
      ? { userId: SHAUN.id, email: SHAUN.email, orgId: ORG }
      : { userId: null, email: null, orgId: null },
    via,
    store,
    sources,
    now: () => NOW,
  };
  const run = (
    action: string,
    body: any = {},
    params: Record<string, string> = {},
  ) =>
    runDispatchV2RepliesAction(
      action,
      new URLSearchParams(params),
      body,
      ctx,
    ) as Promise<any>;
  return { store, sources, ctx, run };
}

async function refused(p: Promise<unknown>, status: number, code: string) {
  const e = await assertRejects(() => p, DispatchMaterialsError);
  assertEquals((e as DispatchMaterialsError).status, status);
  assertEquals((e as DispatchMaterialsError).body.code, code);
}

// The day's mail: one of each kind.
const MAIL: Captured[] = [
  // 1. Reply in our order email's thread, with a date.
  {
    seq: 101,
    from: "Trade WA <tradewa@stratcowa.com.au>",
    subject: "RE: Material Order Ref SWF-261387",
    body:
      "Hi Shaun,\n\nThanks for the order. We can deliver Tue 27 Oct.\n\nRegards",
    conv: "CONV-O1",
  },
  // 2. A customer. Not a supplier: never stored.
  {
    seq: 102,
    from: "jo@example.com",
    subject: "Fence question",
    body: "When are you coming?",
    sender_kind: "customer",
  },
  // 3. Our job number, from a supplier with no order on that job.
  {
    seq: 103,
    from: "sales@fencingwarehousewa.au",
    subject: "RE: Material Order Ref SWF-261387",
    body: "Delivery will be Thursday 29 October.",
  },
  // 4. Best guess: CMI has one open order.
  {
    seq: 104,
    from: "kris.idnay@cmiwa.com.au",
    subject: "Combined Metal Industries - Sales Order 238780",
    body: "Your order is booked for delivery on 30/10.",
  },
  // 5. Stratco with two open orders and nothing to tell them apart.
  {
    seq: 105,
    from: "tradewa@stratcowa.com.au",
    subject: "Order update",
    body: "Your order is in production.",
  },
  // 6. An out-of-office reply.
  {
    seq: 106,
    from: "tradewa@stratcowa.com.au",
    subject: "Automatic reply: Material Order Ref SWP-26701",
    body: "I am away until Monday.",
  },
  // 7. A supplier's marketing list (a Xero contact address, not an order
  // desk, no open order): the tray's "other" view only.
  {
    seq: 107,
    from: "news@bunnings-mail.com.au",
    subject: "Spring specials",
    body: "Big savings this month.",
  },
  // 8. From the deep history load: skipped.
  {
    seq: 108,
    from: "tradewa@stratcowa.com.au",
    subject: "RE: Material Order Ref SWP-26701",
    body: "Old mail.",
    history_tier: "deep",
  },
  // 9. Owner-private mailbox: never read.
  {
    seq: 109,
    from: "tradewa@stratcowa.com.au",
    subject: "RE: Material Order Ref SWP-26701",
    body: "Private.",
    privacy: "restricted_pii",
  },
  // 10. Saved one minute ago: waits for the next run.
  {
    seq: 110,
    from: "tradewa@stratcowa.com.au",
    subject: "RE: Material Order Ref SWP-26701",
    body: "Late row.",
    recorded_at: "2026-10-23T07:59:00Z",
  },
];

async function scanned() {
  const t = setup();
  t.store.events = MAIL.map(eventRow);
  t.store.scan.cursor_sequence = 100;
  const result = await t.run("dispatch_v2_replies_scan");
  const bySeq = (seq: number) =>
    t.store.emails.find((e) => e.sequence_number === seq);
  return { ...t, result, bySeq };
}

// ── The scan ──────────────────────────────────────────────────────────────

Deno.test("scan: does nothing while the flag is off", async () => {
  const t = setup();
  t.store.flag = false;
  t.store.events = MAIL.map(eventRow);
  t.store.scan.cursor_sequence = 100;
  const r = await t.run("dispatch_v2_replies_scan");
  assertEquals(r.skipped, "flag_off");
  assertEquals(t.store.emails.length, 0);
});

Deno.test("scan: the first run starts at the newest captured row and stores nothing", async () => {
  const t = setup();
  t.store.events = MAIL.map(eventRow);
  const r = await t.run("dispatch_v2_replies_scan");
  assertEquals(r.first_run, true);
  assertEquals(r.cursor_sequence, 110);
  assertEquals(t.store.scan.cursor_sequence, 110);
  assertEquals(t.store.emails.length, 0);
});

Deno.test("scan: counts each kind of mail and moves the cursor", async () => {
  const { result } = await scanned();
  assertEquals(result.read, 8); // 109 private and 110 too new are not read
  assertEquals(result.not_supplier, 1);
  assertEquals(result.auto_reply, 1);
  assertEquals(result.deep_history, 1);
  assertEquals(result.stored, 5);
  assertEquals(result.matched, 2);
  assertEquals(result.needs_confirmation, 1);
  assertEquals(result.unmatched, 2);
  assertEquals(result.cursor_sequence, 108);
});

Deno.test("scan: rung 1, same thread, with a delivery suggestion", async () => {
  const { bySeq, store } = await scanned();
  const e = bySeq(101)!;
  assertEquals(e.state, "matched");
  assertEquals(e.rung, "thread");
  assertEquals(e.order_id, O1);
  assertEquals(e.job_id, J1);
  assertEquals(e.supplier_name, "Stratco WA");
  assertEquals(e.delivery_date, "2026-10-27");
  const s = store.suggestions.find((x) => x.email_id === e.id)!;
  assertEquals(s.label, "Stratco WA: delivery Tue 27 Oct");
  assertEquals(s.order_id, O1);
  assertEquals(s.state, "open");
});

Deno.test("scan: rung 1 also knows the thread from the captured copy of our sent email", async () => {
  const t = setup();
  t.sources.orders[1].sent_conversation_id = null; // O2: Outlook gave no thread id
  t.store.events = [
    // The captured Sent Items copy of O2's email.
    {
      ...eventRow({
        seq: 90,
        from: "admin@secureworkswa.com.au",
        subject: "Material Order Ref SWP-26701",
        body: "Order",
        conv: "CONV-SENT-O2",
      }),
      direction: "outbound",
      provider_message_id: "email:o2@outlook.com",
    },
    eventRow({
      seq: 120,
      from: "tradewa@stratcowa.com.au",
      subject: "RE: your order",
      body: "Noted.",
      conv: "CONV-SENT-O2",
    }),
  ];
  t.store.scan.cursor_sequence = 100;
  await t.run("dispatch_v2_replies_scan");
  const e = t.store.emails[0];
  assertEquals(e.rung, "thread");
  assertEquals(e.order_id, O2);
});

Deno.test("scan: rung 2, job number, with no order from that supplier on the job", async () => {
  const { bySeq, store } = await scanned();
  const e = bySeq(103)!;
  assertEquals(e.state, "matched");
  assertEquals(e.rung, "job_number");
  assertEquals(e.job_id, J1);
  assertEquals(e.order_id, null);
  const s = store.suggestions.find((x) => x.email_id === e.id)!;
  assertEquals(s.order_id, null);
  assertEquals(s.label, "Fencing Warehouse WA: delivery Thu 29 Oct");
});

Deno.test("scan: rung 4, best guess waits for a person and makes no suggestion yet", async () => {
  const { bySeq, store } = await scanned();
  const e = bySeq(104)!;
  assertEquals(e.state, "needs_confirmation");
  assertEquals(e.rung, "best_guess");
  assertEquals(e.order_id, O3);
  assertEquals(e.supplier_refs, ["238780"]);
  assertEquals(store.suggestions.some((s) => s.email_id === e.id), false);
});

Deno.test("scan: two open orders and nothing to choose by goes to the tray with both", async () => {
  const { bySeq } = await scanned();
  const e = bySeq(105)!;
  assertEquals(e.state, "unmatched");
  assertEquals(e.job_id, null);
  assertEquals(
    (e.candidates as any[]).map((c) => c.order_id).sort(),
    [O1, O2].sort(),
  );
  assertEquals(e.order_desk, true);
  assertEquals(bySeq(107)!.order_desk, false);
});

Deno.test("scan: a second run over the same rows stores nothing twice", async () => {
  const t = await scanned();
  const r = await t.run("dispatch_v2_replies_scan", { from_sequence: 100 });
  assertEquals(r.stored, 0);
  assertEquals(r.already_stored, 5);
  assertEquals(t.store.emails.length, 5);
  assertEquals(t.store.suggestions.length, 2);
});

Deno.test("scan: a newer date for the same order replaces the older suggestion", async () => {
  const t = await scanned();
  t.store.events.push(
    eventRow({
      seq: 130,
      from: "tradewa@stratcowa.com.au",
      subject: "RE: Material Order Ref SWF-261387",
      body: "Sorry, delivery is now Wednesday 28 October.",
      conv: "CONV-O1",
    }),
  );
  await t.run("dispatch_v2_replies_scan");
  const forO1 = t.store.suggestions.filter((s) => s.order_id === O1);
  assertEquals(forO1.map((s) => [s.delivery_date, s.state]), [
    ["2026-10-27", "superseded"],
    ["2026-10-28", "open"],
  ]);
});

Deno.test("scan: no suggestion when the order already has that date, or the date is past", async () => {
  const t = setup();
  t.sources.orders[0].confirmed_delivery_date = "2026-10-27";
  t.store.events = [
    eventRow({
      seq: 201,
      from: "tradewa@stratcowa.com.au",
      subject: "RE: Material Order Ref SWF-261387",
      body: "Delivery Tue 27 Oct as booked.",
      conv: "CONV-O1",
    }),
    // Captured late from an email sent on 1 Oct: its date is gone.
    eventRow({
      seq: 202,
      from: "tradewa@stratcowa.com.au",
      subject: "RE: Material Order Ref SWP-26701",
      body: "Delivery Monday 5 October.",
      event_at: "2026-10-01T02:00:00Z",
    }),
  ];
  t.store.scan.cursor_sequence = 200;
  const r = await t.run("dispatch_v2_replies_scan");
  assertEquals(r.matched, 2);
  assertEquals(r.suggestions, 0);
});

Deno.test("scan: without the orders table it still matches by job number", async () => {
  const t = setup();
  t.sources.wired = false;
  t.store.events = MAIL.map(eventRow);
  t.store.scan.cursor_sequence = 100;
  const r = await t.run("dispatch_v2_replies_scan");
  assertEquals(r.orders_wired, false);
  const e = t.store.emails.find((x) => x.sequence_number === 101)!;
  assertEquals(e.rung, "job_number");
  assertEquals(e.order_id, null);
});

// ── The reads ─────────────────────────────────────────────────────────────

Deno.test("dispatch_v2_replies: a job's emails, suggestions and orders", async () => {
  const t = await scanned();
  const r = await t.run("dispatch_v2_replies", {}, { job_id: J1 });
  assertEquals(r.job_number, "SWF-261387");
  assertEquals(r.emails.length, 2);
  assertEquals(r.emails.every((e: any) => e.job_number === "SWF-261387"), true);
  const thread = r.emails.find((e: any) => e.rung === "thread");
  assertEquals(thread.rung_label, "Same thread");
  assertEquals(thread.delivery_label, "Tue 27 Oct");
  assert(thread.suggestion_id);
  assertEquals(r.suggestions.length, 2);
  assertEquals(
    r.suggestions.find((s: any) => s.order_id === null).needs_order_pick,
    true,
  );
  assertEquals(r.orders.map((o: any) => o.order_id), [O1]);
  assertEquals(r.scan.enabled, true);
  await refused(
    t.run("dispatch_v2_replies", {}, { job_id: "nope" }),
    400,
    "invalid_request",
  );
  await refused(
    t.run("dispatch_v2_replies", {}, {
      job_id: "44444444-4444-4444-8444-444444444444",
    }),
    404,
    "job_not_found",
  );
});

Deno.test("dispatch_v2_replies_unmatched: order desk mail by default, the rest on ask", async () => {
  const t = await scanned();
  const def = await t.run("dispatch_v2_replies_unmatched");
  assertEquals(def.emails.map((e: any) => e.state).sort(), [
    "needs_confirmation",
    "unmatched",
  ]);
  assertEquals(def.counts, {
    needs_confirmation: 1,
    unmatched_order_desk: 1,
    unmatched_other: 1,
  });
  const all = await t.run("dispatch_v2_replies_unmatched", {}, {
    include_other: "1",
  });
  assertEquals(all.emails.length, 3);
});

// ── The presses ───────────────────────────────────────────────────────────

Deno.test("confirm_guess: links the supplier's number, so the next email matches by it", async () => {
  const t = await scanned();
  const guess = t.bySeq(104)!;
  const r = await t.run("dispatch_v2_replies_confirm_guess", {
    email_id: guess.id,
  });
  assertEquals(r.email.state, "matched");
  assertEquals(r.email.rung, "best_guess");
  assertEquals(r.email.decision, "confirmed");
  assertEquals(r.email.decided_by_email, SHAUN.email);
  assertEquals(r.supplier_refs_linked, ["238780"]);
  assertEquals(
    r.suggestion.label,
    "CMI (Combined Metal Industries): delivery Fri 30 Oct",
  );
  assertEquals(
    t.store.jobEvents.at(-1).event_type,
    "dispatch_v2_reply_guess_confirmed",
  );

  // CMI now has a second open order, so only the linked number can tell.
  t.sources.orders.push({
    ...t.sources.orders[2],
    order_id: "aaaaaaa4-0000-4000-8000-000000000004",
    job_id: J1,
    job_number: "SWF-261387",
  });
  t.store.events.push(
    eventRow({
      seq: 140,
      from: "kris.idnay@cmiwa.com.au",
      subject: "Tax Invoice 10094986",
      body: "Sales Order 238780 has been dispatched.",
    }),
  );
  await t.run("dispatch_v2_replies_scan");
  const next = t.store.emails.find((e) => e.sequence_number === 140)!;
  assertEquals(next.rung, "supplier_ref");
  assertEquals(next.order_id, O3);
  await refused(
    t.run("dispatch_v2_replies_confirm_guess", { email_id: guess.id }),
    409,
    "not_a_best_guess",
  );
});

Deno.test("confirm_guess: a supplier number too long for the table is not linked", async () => {
  const t = await scanned();
  const guess = t.bySeq(104)!;
  t.store.emails.find((e) => e.id === guess.id)!.supplier_refs = [
    "238780",
    "Q1234567890123456789012345",
  ];
  const r = await t.run("dispatch_v2_replies_confirm_guess", {
    email_id: guess.id,
  });
  assertEquals(r.supplier_refs_linked, ["238780"]);
});

Deno.test("reject_guess: back to the tray, and that order is remembered as wrong", async () => {
  const t = await scanned();
  const guess = t.bySeq(104)!;
  const r = await t.run("dispatch_v2_replies_reject_guess", {
    email_id: guess.id,
  });
  assertEquals(r.email.state, "unmatched");
  assertEquals(r.email.job_id, null);
  assertEquals(r.email.decision, "rejected");
  assertEquals(
    t.store.emails.find((e) => e.id === guess.id)!.rejected_order_ids,
    [O3],
  );
  assertEquals(t.store.refs.length, 0);
});

Deno.test("assign: an unmatched email to a job and order, with its suggestion", async () => {
  const t = await scanned();
  const tray = t.bySeq(105)!;
  t.store.emails.find((e) => e.id === tray.id)!.delivery_date = "2026-11-04";
  const r = await t.run("dispatch_v2_replies_assign", {
    email_id: tray.id,
    job_id: J2,
    order_id: O2,
  });
  assertEquals(r.email.state, "matched");
  assertEquals(r.email.rung, "manual");
  assertEquals(r.email.rung_label, "Picked by hand");
  assertEquals(r.email.job_number, "SWP-26701");
  assertEquals(r.suggestion.label, "Stratco WA: delivery Wed 4 Nov");
  assertEquals(
    t.store.jobEvents.at(-1).event_type,
    "dispatch_v2_reply_assigned",
  );
  assertEquals(t.store.jobEvents.at(-1).job_id, J2);
});

Deno.test("assign: refuses an order on a different job, and a missing job", async () => {
  const t = await scanned();
  const tray = t.bySeq(105)!;
  await refused(
    t.run("dispatch_v2_replies_assign", {
      email_id: tray.id,
      job_id: J1,
      order_id: O2,
    }),
    409,
    "order_not_on_job",
  );
  await refused(
    t.run("dispatch_v2_replies_assign", {
      email_id: tray.id,
      job_id: "44444444-4444-4444-8444-444444444444",
    }),
    404,
    "job_not_found",
  );
  await refused(
    t.run("dispatch_v2_replies_assign", { job_id: J1 }),
    400,
    "invalid_request",
  );
});

Deno.test("hide: only an unmatched email", async () => {
  const t = await scanned();
  const r = await t.run("dispatch_v2_replies_hide", {
    email_id: t.bySeq(107)!.id,
  });
  assertEquals(r.email.state, "hidden");
  await refused(
    t.run("dispatch_v2_replies_hide", { email_id: t.bySeq(101)!.id }),
    409,
    "not_unmatched",
  );
});

Deno.test("accept: sets the order's confirmed date and never the job status", async () => {
  const t = await scanned();
  const s = t.store.suggestions.find((x) => x.order_id === O1)!;
  const jobsBefore = JSON.stringify(t.store.jobs);
  const r = await t.run("dispatch_v2_suggestion_accept", {
    suggestion_id: s.id,
  });
  assertEquals(r.suggestion.state, "accepted");
  assertEquals(r.suggestion.acted_by_email, SHAUN.email);
  assertEquals(r.order, {
    order_id: O1,
    supplier_name: "Stratco WA",
    confirmed_delivery_date: "2026-10-27",
    previous_confirmed_delivery_date: null,
  });
  assertEquals(r.job_status_changed, false);
  assertEquals(r.stage_move_offer, {
    from_status: "awaiting_supplier",
    to_status: "order_confirmed",
    label: "Move to Order Confirmed?",
    job_id: J1,
    action: "update_job_status",
  });
  assertEquals(t.sources.writes.length, 1);
  assertEquals(t.sources.writes[0].date, "2026-10-27");
  assertEquals(t.sources.writes[0].operator, {
    userId: SHAUN.id,
    email: SHAUN.email,
  });
  assertEquals(JSON.stringify(t.store.jobs), jobsBefore);
  assertEquals(
    t.store.jobEvents.at(-1).event_type,
    "dispatch_v2_delivery_accepted",
  );
  await refused(
    t.run("dispatch_v2_suggestion_accept", { suggestion_id: s.id }),
    409,
    "suggestion_not_open",
  );
});

Deno.test("accept: a suggestion with no order needs the order picked", async () => {
  const t = await scanned();
  const s = t.store.suggestions.find((x) => x.order_id === null)!;
  await refused(
    t.run("dispatch_v2_suggestion_accept", { suggestion_id: s.id }),
    400,
    "order_required",
  );
  await refused(
    t.run("dispatch_v2_suggestion_accept", {
      suggestion_id: s.id,
      order_id: O2,
    }),
    409,
    "order_not_on_job",
  );
  const r = await t.run("dispatch_v2_suggestion_accept", {
    suggestion_id: s.id,
    order_id: O1,
  });
  assertEquals(r.order.order_id, O1);
  assertEquals(r.order.confirmed_delivery_date, "2026-10-29");
  // The other open suggestion for O1 is replaced by this answer.
  assertEquals(
    t.store.suggestions.find((x) => x.order_id === O1 && x.id !== s.id)!.state,
    "superseded",
  );
});

Deno.test("accept: refuses plainly while the order date is not in the database", async () => {
  const t = await scanned();
  t.sources.wired = false;
  const s = t.store.suggestions.find((x) => x.order_id === O1)!;
  await refused(
    t.run("dispatch_v2_suggestion_accept", { suggestion_id: s.id }),
    503,
    "orders_not_wired",
  );
  assertEquals(t.store.suggestions.find((x) => x.id === s.id)!.state, "open");
});

Deno.test("accept: no stage offer on a repair job", async () => {
  const t = await scanned();
  const s = t.store.suggestions.find((x) => x.order_id === O1)!;
  t.store.jobs.find((j) => j.job_id === J1)!.type = "repair";
  const r = await t.run("dispatch_v2_suggestion_accept", {
    suggestion_id: s.id,
  });
  assertEquals(r.stage_move_offer, null);
});

Deno.test("dismiss: hides the suggestion and writes no date", async () => {
  const t = await scanned();
  const s = t.store.suggestions.find((x) => x.order_id === O1)!;
  const r = await t.run("dispatch_v2_suggestion_dismiss", {
    suggestion_id: s.id,
  });
  assertEquals(r.suggestion.state, "dismissed");
  assertEquals(r.suggestion.can_accept, false);
  assertEquals(t.sources.writes.length, 0);
  await refused(
    t.run("dispatch_v2_suggestion_dismiss", { suggestion_id: s.id }),
    409,
    "suggestion_not_open",
  );
});

Deno.test("presses from the terminal must name a person in users", async () => {
  const t = setup("terminal");
  t.store.events = MAIL.map(eventRow);
  t.store.scan.cursor_sequence = 100;
  await t.run("dispatch_v2_replies_scan");
  const s = t.store.suggestions[0];
  await refused(
    t.run("dispatch_v2_suggestion_dismiss", { suggestion_id: s.id }),
    400,
    "operator_required",
  );
  await refused(
    t.run("dispatch_v2_suggestion_dismiss", {
      suggestion_id: s.id,
      operator_email: "nobody@example.com",
    }),
    400,
    "operator_required",
  );
  const r = await t.run("dispatch_v2_suggestion_dismiss", {
    suggestion_id: s.id,
    operator_email: "Shaun@SecureWorksWA.com.au",
  });
  assertEquals(r.suggestion.acted_by_email, SHAUN.email);
  assertEquals(t.store.suggestions[0].acted_by, null);
});

Deno.test("an unknown action is refused", async () => {
  const t = setup();
  await refused(t.run("dispatch_v2_replies_nope"), 400, "unknown_action");
});
