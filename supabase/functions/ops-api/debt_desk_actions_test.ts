// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSupabaseDebtDeskStore,
  DEBT_SENDING_SWITCH,
  type DebtDeskDeps,
  DebtDeskError,
  type DebtDeskStore,
  debtDraftDecide,
  debtDraftSend,
  debtLogOutcome,
  debtPromises,
  debtSendingEnabled,
} from "./debt_desk_actions.ts";
import { debtDraftStates } from "./debt_desk_drafts.ts";
import { debtChaseEventFromLogRow } from "./debt_chase_schedule.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const SHAUN = {
  user_id: "20000000-0000-4000-8000-0000000000aa",
  email: "shaun@example.test",
};
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
/** 09:00 Perth, Thursday 2026-10-01. */
const THU_9AM = "2026-10-01T01:00:00Z";
const ITEM = "2026-10-01:contact-a:text:friendly_text";
const DRAFT = `${ITEM}|10000,5000`;
const JAN_DRAFT = "2026-10-01:contact-a:jan:jan_visit|10000";

function memoryStore(seed: Record<string, unknown>[] = []) {
  const rows: Record<string, unknown>[] = [...seed];
  let clock = 0;
  const store: DebtDeskStore & { rows: typeof rows; failInsert?: boolean } = {
    rows,
    insertChaseRows(next) {
      if ((store as any).failInsert) {
        return Promise.reject(
          new DebtDeskError("write failed", 502, "debt_desk_write_failed"),
        );
      }
      clock += 1;
      const at = new Date(Date.parse(THU_9AM) + clock * 1000).toISOString();
      for (const r of next) {
        rows.push({ id: `r${rows.length + 1}`, created_at: at, ...r });
      }
      return Promise.resolve();
    },
    draftRows: (id) => Promise.resolve(rows.filter((r) => r.draft_id === id)),
    chaseLogRows: (ids) =>
      Promise.resolve(
        rows.filter((r) => ids.includes(String(r.xero_invoice_id))),
      ),
    invoiceJobLinks: (ids) =>
      Promise.resolve(ids.map((id) => ({ xero_invoice_id: id, job_id: "j1" }))),
    jobGhlContacts: (ids) =>
      Promise.resolve(
        ids.map((id) => ({ id, ghl_contact_id: "ghl-contact-1" })),
      ),
    promiseRows: () =>
      Promise.resolve(rows.filter((r) => r.outcome_code === "promised")),
  };
  return store;
}

function xeroInvoice(id: string, over: Record<string, unknown> = {}) {
  return {
    InvoiceID: id,
    InvoiceNumber: id === A ? "INV-1" : "INV-2",
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: id === A ? 100 : 50,
    AmountPaid: 0,
    AmountCredited: 0,
    ...over,
  };
}

function deps(
  store: DebtDeskStore,
  over: Partial<DebtDeskDeps> & {
    invoices?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const reads: string[] = [];
  const sends: any[] = [];
  const d: DebtDeskDeps = {
    store,
    sendingEnabled: false,
    now: () => new Date(THU_9AM),
    readInvoice: (id) => {
      reads.push(id);
      return Promise.resolve(over.invoices?.[id] ?? xeroInvoice(id));
    },
    sendSms: (body) => {
      sends.push(body);
      return Promise.resolve({
        success: true,
        message_id: `msg-${sends.length}`,
      });
    },
    ...over,
  };
  return { d, reads, sends };
}

const approve = (
  store: DebtDeskStore,
  text = "Hi Sam, a friendly reminder. Thanks, SecureWorks",
) =>
  debtDraftDecide(
    {
      draft_id: DRAFT,
      decision: "approve",
      text,
      xero_invoice_ids: [A, B],
    },
    SHAUN,
    deps(store).d,
  );

// ── debt_draft_decide ──

Deno.test("decide: an approval records the signed-in user and the text, one row per invoice", async () => {
  const store = memoryStore();
  const res = await approve(store);
  assertEquals(res.ok, true);
  assertEquals(res.draft.status, "approved");
  assertEquals(res.draft.approved_by_user_id, SHAUN.user_id);
  assertEquals(
    res.draft.text,
    "Hi Sam, a friendly reminder. Thanks, SecureWorks",
  );
  assertEquals(store.rows.length, 2);
  for (const [k, r] of store.rows.entries()) {
    assertEquals(r.xero_invoice_id, [A, B][k]);
    assertEquals(r.method, "sms");
    assertEquals(r.schedule_step, "friendly_text");
    assertEquals(r.draft_id, DRAFT);
    assertEquals(r.draft_amount, [100, 50][k]);
    assertEquals(r.covers_invoice_ids, [A, B]);
    assertEquals(r.outcome_code, null);
    assertEquals(r.approved_by_user_id, SHAUN.user_id);
    assertEquals(r.chased_by, SHAUN.email);
    assertEquals(r.automated, false);
  }
  // The approval is not a step: the ladder does not move until the message is sent.
  assert(store.rows.every((r) => debtChaseEventFromLogRow(r) === null));
  assertEquals(
    debtDraftStates(store.rows).get(DRAFT)?.decision?.kind,
    "approved",
  );
});

Deno.test("decide: a skip is recorded, and a later approval wins", async () => {
  const store = memoryStore();
  const skipped = await debtDraftDecide(
    {
      draft_id: DRAFT,
      decision: "skip",
      text: "shown text",
      xero_invoice_ids: [A, B],
    },
    SHAUN,
    deps(store).d,
  );
  assertEquals(skipped.draft.status, "skipped");
  assertEquals(store.rows.map((r) => [r.outcome_code, r.approved_by_user_id]), [
    ["skipped", null],
    ["skipped", null],
  ]);
  await approve(store);
  assertEquals(
    debtDraftStates(store.rows).get(DRAFT)?.decision?.kind,
    "approved",
  );
});

Deno.test("decide: refuses without a signed-in user, a stale or unknown draft, a bad text or the wrong invoices", async () => {
  const store = memoryStore();
  const d = deps(store).d;
  const cases: Array<[unknown, unknown, number, string]> = [
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, B],
      },
      null,
      403,
      "debt_desk_user_required",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, B],
      },
      { user_id: "not-a-uuid", email: null },
      403,
      "debt_desk_user_required",
    ],
    [
      {
        draft_id: "nonsense",
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A],
      },
      SHAUN,
      400,
      "debt_draft_unknown",
    ],
    [
      {
        draft_id: DRAFT.replace("2026-10-01", "2026-09-30"),
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, B],
      },
      SHAUN,
      409,
      "debt_draft_not_today",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "send",
        text: "ok",
        xero_invoice_ids: [A, B],
      },
      SHAUN,
      400,
      "debt_desk_bad_request",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A],
      },
      SHAUN,
      400,
      "debt_desk_bad_request",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, "nope"],
      },
      SHAUN,
      400,
      "debt_desk_bad_request",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, A],
      },
      SHAUN,
      400,
      "debt_desk_bad_request",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "We will take legal action",
        xero_invoice_ids: [A, B],
      },
      SHAUN,
      400,
      "debt_draft_text_not_allowed",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "Pay — now",
        xero_invoice_ids: [A, B],
      },
      SHAUN,
      400,
      "debt_draft_text_not_allowed",
    ],
    [
      {
        draft_id: DRAFT,
        decision: "approve",
        text: "ok",
        xero_invoice_ids: [A, B],
        send: true,
      },
      SHAUN,
      400,
      "debt_desk_bad_request",
    ],
  ];
  for (const [body, actor, status, code] of cases) {
    const error = await assertRejects(
      () => debtDraftDecide(body, actor as any, d),
      DebtDeskError,
    );
    assertEquals(
      [error.status, error.code],
      [status, code],
      JSON.stringify(body),
    );
  }
  assertEquals(store.rows, []);
});

Deno.test("decide: a draft already sent cannot be decided again", async () => {
  const store = memoryStore([{
    id: "s",
    created_at: THU_9AM,
    xero_invoice_id: A,
    draft_id: DRAFT,
    outcome_code: "sent",
    schedule_step: "friendly_text",
  }]);
  const error = await assertRejects(() => approve(store), DebtDeskError);
  assertEquals([error.status, error.code], [409, "debt_draft_already_sent"]);
});

// ── debt_log_outcome ──

Deno.test("outcome: a call outcome is logged per invoice with its step; no Xero read", async () => {
  const store = memoryStore();
  const x = deps(store);
  const res = await debtLogOutcome(
    {
      payer_key: "contact-a",
      xero_invoice_ids: [A, B],
      outcome_code: "no_answer",
      channel: "call",
      schedule_step: "call",
      note: "rang twice",
    },
    SHAUN,
    x.d,
  );
  assertEquals(res.ok, true);
  assertEquals(res.logged.rows, 2);
  assertEquals(x.reads, []);
  assertEquals(
    store.rows.map((
      r,
    ) => [
      r.xero_invoice_id,
      r.method,
      r.outcome_code,
      r.schedule_step,
      r.notes,
    ]),
    [
      [A, "call", "no_answer", "call", "rang twice"],
      [B, "call", "no_answer", "call", "rang twice"],
    ],
  );
  assertEquals(debtChaseEventFromLogRow(store.rows[0])?.step, "call");
});

Deno.test("outcome: Jan's visit is logged as a visit", async () => {
  const store = memoryStore();
  await debtLogOutcome(
    {
      payer_key: "contact-a",
      xero_invoice_ids: [A],
      outcome_code: "spoke",
      channel: "call",
      schedule_step: "jan_visit",
    },
    SHAUN,
    deps(store).d,
  );
  assertEquals(store.rows[0].method, "visit");
});

Deno.test("outcome: a promise stamps the amount due read live from Xero when it is logged", async () => {
  const store = memoryStore();
  const x = deps(store, {
    invoices: {
      [A]: xeroInvoice(A, { AmountDue: 80 }),
      [B]: xeroInvoice(B, { AmountDue: 50 }),
    },
  });
  const res = await debtLogOutcome(
    {
      payer_key: "contact-a",
      xero_invoice_ids: [A, B],
      outcome_code: "promised",
      promised_amount: 100,
      promised_date: "2026-10-03",
      channel: "call",
      schedule_step: null,
      note: null,
    },
    SHAUN,
    x.d,
  );
  assertEquals(x.reads, [A, B]);
  assertEquals(res.logged.amount_due_at_promise, 130);
  for (const r of store.rows) {
    assertEquals([
      r.promised_amount,
      r.promised_date,
      r.amount_due_at_promise,
      r.covers_invoice_ids,
    ], [
      100,
      "2026-10-03",
      130,
      [A, B],
    ]);
  }
  const ev = debtChaseEventFromLogRow(store.rows[0]);
  assertEquals([ev?.outcome, ev?.amount_due_at_promise, ev?.covers], [
    "promised",
    130,
    [A, B],
  ]);
});

Deno.test("outcome: refuses a bad promise, a paid invoice, or an unreadable Xero, and writes nothing", async () => {
  const base = {
    payer_key: "contact-a",
    xero_invoice_ids: [A],
    outcome_code: "promised",
    promised_amount: 50,
    promised_date: "2026-10-03",
    channel: "call",
    schedule_step: null,
  };
  const cases: Array<
    [
      Record<string, unknown>,
      Partial<DebtDeskDeps> & { invoices?: any },
      number,
      string,
    ]
  > = [
    [{ ...base, promised_amount: 0 }, {}, 400, "debt_desk_bad_request"],
    [
      { ...base, promised_date: "2026-09-30" },
      {},
      400,
      "debt_desk_bad_request",
    ],
    [{ ...base, promised_date: undefined }, {}, 400, "debt_desk_bad_request"],
    [{ ...base, outcome_code: "paid" }, {}, 400, "debt_desk_bad_request"],
    [{ ...base, schedule_step: "firm_text" }, {}, 400, "debt_desk_bad_request"],
    [{ ...base, promised_amount: 101 }, {}, 409, "debt_promise_more_than_due"],
    [
      base,
      { invoices: { [A]: xeroInvoice(A, { Status: "PAID", AmountDue: 0 }) } },
      409,
      "debt_invoice_not_open",
    ],
    [
      base,
      { readInvoice: () => Promise.reject(new Error("timeout")) },
      502,
      "debt_xero_read_failed",
    ],
  ];
  for (const [body, over, status, code] of cases) {
    const store = memoryStore();
    const error = await assertRejects(
      () => debtLogOutcome(body, SHAUN, deps(store, over).d),
      DebtDeskError,
    );
    assertEquals(
      [error.status, error.code],
      [status, code],
      JSON.stringify(body),
    );
    assertEquals(store.rows, []);
  }
});

// ── debt_draft_send ──

async function approvedStore() {
  const store = memoryStore();
  await approve(store);
  return store;
}

Deno.test("send: while the switch is off every attempt is refused and logged, with no Xero read and no SMS", async () => {
  const store = await approvedStore();
  const x = deps(store, { sendingEnabled: false });
  const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(res.sending_enabled, false);
  assertEquals(res.results, [{
    draft_id: DRAFT,
    sent: false,
    code: "sending_off",
    reason: "Sending is off until Shaun says start sending",
    logged: true,
  }]);
  assertEquals(x.reads, []);
  assertEquals(x.sends, []);
  const refusals = store.rows.filter((r) => r.outcome_code === "failed");
  assertEquals(
    refusals.map((r) => [r.xero_invoice_id, r.outcome, r.draft_id]),
    [
      [A, "refused: sending_off", DRAFT],
      [B, "refused: sending_off", DRAFT],
    ],
  );
  // A refusal never moves the ladder and leaves the draft approved.
  assert(refusals.every((r) => debtChaseEventFromLogRow(r) === null));
  assertEquals(
    debtDraftStates(store.rows).get(DRAFT)?.decision?.kind,
    "approved",
  );
});

Deno.test("send: the switch is exactly DEBT_SENDING_ENABLED=true, off by default", () => {
  assertEquals(DEBT_SENDING_SWITCH, "DEBT_SENDING_ENABLED");
  assertEquals(debtSendingEnabled(() => undefined), false);
  for (const v of ["1", "TRUE", "yes", " true", "on", ""]) {
    assertEquals(debtSendingEnabled(() => v), false, v);
  }
  assertEquals(debtSendingEnabled(() => "true"), true);
});

Deno.test("send: with the switch on, re-reads each invoice live, sends through send_chase_sms and logs the send", async () => {
  const store = await approvedStore();
  const x = deps(store, { sendingEnabled: true });
  const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(x.reads, [A, B]);
  assertEquals(x.sends, [{
    ghl_contact_id: "ghl-contact-1",
    job_id: "j1",
    xero_invoice_id: A,
    message: "Hi Sam, a friendly reminder. Thanks, SecureWorks",
    operator_email: SHAUN.email,
  }]);
  assertEquals(res.results, [{
    draft_id: DRAFT,
    sent: true,
    provider_message_id: "msg-1",
    logged: true,
  }]);
  const sent = store.rows.filter((r) => r.outcome_code === "sent");
  assertEquals(
    sent.map((
      r,
    ) => [
      r.xero_invoice_id,
      r.provider_message_id,
      r.approved_by_user_id,
      r.schedule_step,
    ]),
    [
      [A, "msg-1", SHAUN.user_id, "friendly_text"],
      [B, "msg-1", SHAUN.user_id, "friendly_text"],
    ],
  );
  assertEquals(debtChaseEventFromLogRow(sent[0])?.step, "friendly_text");
  // Sending it again is refused.
  const again = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(again.results[0].code, "already_sent");
  assertEquals(x.sends.length, 1);
});

Deno.test("send: the last Xero check refuses paid, part-paid, voided and credited invoices, with the reason", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ Status: "PAID", AmountDue: 0 }, "paid"],
    [{ AmountDue: 0 }, "paid"],
    [{ AmountDue: 60, AmountPaid: 40 }, "part_paid"],
    [{ Status: "VOIDED" }, "voided"],
    [{ Status: "DELETED" }, "voided"],
    [{ AmountCredited: 10, AmountDue: 90 }, "credited"],
    [{ CreditNotes: [{ CreditNoteID: "c1" }] }, "credited"],
    [{ Status: "DRAFT" }, "not_authorised"],
  ];
  for (const [over, code] of cases) {
    const store = await approvedStore();
    const x = deps(store, {
      sendingEnabled: true,
      invoices: { [A]: xeroInvoice(A, over) },
    });
    const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].sent, false);
    assertEquals(res.results[0].code, code, JSON.stringify(over));
    assert(String(res.results[0].reason).includes("INV-1"));
    assertEquals(x.sends, []);
    assertEquals(
      store.rows.filter((r) => r.outcome === `refused: ${code}`).length,
      2,
    );
  }
});

Deno.test("send: refuses an unapproved, skipped, stale, Jan or since-chased draft, and a payer with no contact", async () => {
  const on = { sendingEnabled: true };
  // Not approved.
  {
    const store = memoryStore();
    const x = deps(store, on);
    const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].code, "not_approved");
    assertEquals(x.reads, []);
  }
  // Skipped after the approval.
  {
    const store = await approvedStore();
    await debtDraftDecide(
      {
        draft_id: DRAFT,
        decision: "skip",
        text: "x",
        xero_invoice_ids: [A, B],
      },
      SHAUN,
      deps(store).d,
    );
    const res = await debtDraftSend(
      { draft_ids: [DRAFT] },
      SHAUN,
      deps(store, on).d,
    );
    assertEquals(res.results[0].code, "skipped");
  }
  // Approved yesterday.
  {
    const store = await approvedStore();
    const x = deps(store, {
      ...on,
      now: () => new Date("2026-10-02T01:00:00Z"),
    });
    const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].code, "approval_stale");
  }
  // Jan's text is plan step 5.
  {
    const store = memoryStore();
    await debtDraftDecide(
      {
        draft_id: JAN_DRAFT,
        decision: "approve",
        text: "Hi Jan",
        xero_invoice_ids: [A],
      },
      SHAUN,
      deps(store).d,
    );
    const x = deps(store, on);
    const res = await debtDraftSend({ draft_ids: [JAN_DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].code, "jan_text_not_wired");
    assertEquals(x.sends, []);
  }
  // A promise logged after the approval stops the text.
  {
    const store = await approvedStore();
    await debtLogOutcome(
      {
        payer_key: "contact-a",
        xero_invoice_ids: [A],
        outcome_code: "disputed",
        channel: "call",
        schedule_step: null,
      },
      SHAUN,
      deps(store).d,
    );
    const x = deps(store, on);
    const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].code, "chased_since_approval");
    assertEquals(x.sends, []);
  }
  // No GHL contact on the job.
  {
    const store = await approvedStore();
    store.jobGhlContacts = (ids) =>
      Promise.resolve(ids.map((id) => ({ id, ghl_contact_id: null })));
    const x = deps(store, on);
    const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
    assertEquals(res.results[0].code, "no_contact");
    assertEquals(x.sends, []);
  }
});

Deno.test("send: drafts go one at a time; a Xero rate limit stops the rest of the batch unsent", async () => {
  const store = await approvedStore();
  const other = "2026-10-01:contact-b:text:friendly_text|5000";
  await debtDraftDecide(
    {
      draft_id: other,
      decision: "approve",
      text: "Hi Alex. Thanks, SecureWorks",
      xero_invoice_ids: [B],
    },
    SHAUN,
    deps(store).d,
  );
  let inFlight = 0;
  let most = 0;
  const x = deps(store, {
    sendingEnabled: true,
    readInvoice: () =>
      Promise.reject(
        new XeroCooldownError("Xero is rate limited", 429, "XERO_RATE_LIMITED"),
      ),
  });
  x.d.sendSms = async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return { success: true, message_id: "m" };
  };
  const res = await debtDraftSend({ draft_ids: [DRAFT, other] }, SHAUN, x.d);
  assertEquals(res.results.map((r) => [r.draft_id, r.sent, r.code]), [
    [DRAFT, false, "last_check_unavailable"],
    [other, false, "last_check_unavailable"],
  ]);
  assertEquals(most, 0);

  // A provider failure is logged as failed and the batch carries on, one send at a time.
  const store2 = await approvedStore();
  await debtDraftDecide(
    {
      draft_id: other,
      decision: "approve",
      text: "Hi Alex. Thanks, SecureWorks",
      xero_invoice_ids: [B],
    },
    SHAUN,
    deps(store2).d,
  );
  let n = 0;
  const y = deps(store2, { sendingEnabled: true });
  y.d.sendSms = async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    n += 1;
    if (n === 1) throw new Error("SMS send failed");
    return { success: true, message_id: "m2" };
  };
  const res2 = await debtDraftSend({ draft_ids: [DRAFT, other] }, SHAUN, y.d);
  assertEquals(res2.results.map((r) => [r.sent, r.code ?? null]), [[
    false,
    "send_failed",
  ], [true, null]]);
  assertEquals(most, 1);
  assertEquals(
    store2.rows.filter((r) => r.outcome === "send failed").length,
    2,
  );
});

Deno.test("send: refuses without a signed-in user and caps a batch at 20", async () => {
  const store = await approvedStore();
  const e1 = await assertRejects(
    () => debtDraftSend({ draft_ids: [DRAFT] }, null, deps(store).d),
    DebtDeskError,
  );
  assertEquals(e1.code, "debt_desk_user_required");
  const e2 = await assertRejects(
    () =>
      debtDraftSend(
        { draft_ids: Array.from({ length: 21 }, () => DRAFT) },
        SHAUN,
        deps(store).d,
      ),
    DebtDeskError,
  );
  assertEquals(e2.code, "debt_desk_bad_request");
});

// ── debt_promises ──

Deno.test("promises: open, kept and broken, judged against the live book", async () => {
  const store = memoryStore();
  const log = (
    ids: string[],
    amount: number,
    date: string,
    dueAtPromise: number,
  ) =>
    debtLogOutcome(
      {
        payer_key: "contact-a",
        xero_invoice_ids: ids,
        outcome_code: "promised",
        promised_amount: amount,
        promised_date: date,
        channel: "call",
        schedule_step: null,
      },
      SHAUN,
      deps(store, {
        invoices: Object.fromEntries(
          ids.map((
            id,
          ) => [id, xeroInvoice(id, { AmountDue: dueAtPromise / ids.length })]),
        ),
      }).d,
    );
  await log([A], 40, "2026-10-01", 100);
  await log([B], 50, "2026-10-01", 50);
  // Read on Friday: A still owes 100 (broken); B is gone from the open book (kept).
  const book = {
    perth_date: "2026-10-02",
    read_at: "2026-10-02T07:00:00+08:00",
    invoices: [{
      xero_invoice_id: A,
      invoice_number: "INV-1",
      contact_name: "Sam Example",
      amount_due: 100,
    }],
  };
  const res = await debtPromises(
    {},
    { ...deps(store).d, readBook: () => Promise.resolve(book) } as any,
  );
  assertEquals(res.perth_date, "2026-10-02");
  assertEquals(
    res.promises.map((
      p: any,
    ) => [p.invoice_numbers, p.status, p.amount_due_now, p.current]),
    [
      [["INV-1"], "broken", 100, true],
      [[null], "kept", 0, true],
    ],
  );
  assertEquals(res.summary, { open: 0, broken: 1, kept: 1, superseded: 0 });
});

Deno.test("promises: a later outcome supersedes an earlier promise", async () => {
  const store = memoryStore();
  const x = deps(store);
  await debtLogOutcome(
    {
      payer_key: "p",
      xero_invoice_ids: [A],
      outcome_code: "promised",
      promised_amount: 10,
      promised_date: "2026-10-05",
      channel: "call",
      schedule_step: null,
    },
    SHAUN,
    x.d,
  );
  await debtLogOutcome(
    {
      payer_key: "p",
      xero_invoice_ids: [A],
      outcome_code: "disputed",
      channel: "call",
      schedule_step: null,
    },
    SHAUN,
    x.d,
  );
  const book = {
    perth_date: "2026-10-01",
    read_at: "x",
    invoices: [{
      xero_invoice_id: A,
      invoice_number: "INV-1",
      contact_name: "Sam",
      amount_due: 100,
    }],
  };
  const res = await debtPromises(
    {},
    { ...x.d, readBook: () => Promise.resolve(book) } as any,
  );
  assertEquals(res.promises.map((p: any) => [p.status, p.current]), [[
    "open",
    false,
  ]]);
  assertEquals(res.summary.superseded, 1);
});

Deno.test("promises: refuses unknown parameters", async () => {
  const error = await assertRejects(
    () =>
      debtPromises(
        { days: "9" },
        {
          ...deps(memoryStore()).d,
          readBook: () => Promise.reject(new Error("no")),
        } as any,
      ),
    DebtDeskError,
  );
  assertEquals(error.status, 400);
});

// ── The Supabase store ──

function fakeSupabase(
  answer: (
    table: string,
    calls: Array<[string, unknown[]]>,
  ) => { data: unknown; error: unknown },
) {
  const log: Array<{ table: string; calls: Array<[string, unknown[]]> }> = [];
  const client = {
    from(table: string) {
      const calls: Array<[string, unknown[]]> = [];
      const q: any = {};
      for (
        const m of ["select", "eq", "in", "gte", "order", "range", "insert"]
      ) {
        q[m] = (...args: unknown[]) => {
          calls.push([m, args]);
          return q;
        };
      }
      for (const m of ["update", "upsert", "delete", "rpc"]) {
        q[m] = () => {
          throw new Error(`unexpected ${m}`);
        };
      }
      q.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        log.push({ table, calls });
        return Promise.resolve(answer(table, calls)).then(resolve, reject);
      };
      return q;
    },
  };
  return { client, log };
}

Deno.test("store: inserts are one org-scoped batch and a PostgREST error is a refusal, not a silent success", async () => {
  const ok = fakeSupabase(() => ({ data: null, error: null }));
  await createSupabaseDebtDeskStore(ok.client, ORG).insertChaseRows([{
    method: "sms",
  }, { method: "sms" }]);
  assertEquals(ok.log.length, 1);
  assertEquals(ok.log[0].calls[0], ["insert", [[
    { method: "sms", org_id: ORG },
    { method: "sms", org_id: ORG },
  ]]]);

  const bad = fakeSupabase(() => ({
    data: null,
    error: { code: "23514", message: "check violated" },
  }));
  const error = await assertRejects(
    () =>
      createSupabaseDebtDeskStore(bad.client, ORG).insertChaseRows([{
        method: "sms",
      }]),
    DebtDeskError,
  );
  assertEquals([error.status, error.code], [502, "debt_desk_write_failed"]);
  for (
    const read of [
      "draftRows",
      "invoiceJobLinks",
      "jobGhlContacts",
      "promiseRows",
      "chaseLogRows",
    ] as const
  ) {
    const e = await assertRejects(
      () =>
        (createSupabaseDebtDeskStore(bad.client, ORG) as any)[read](
          read === "draftRows"
            ? "d"
            : read === "promiseRows"
            ? "2026-01-01"
            : ["x"],
        ),
      DebtDeskError,
    );
    assertEquals(e.code, "debt_desk_read_failed", read);
  }
});
