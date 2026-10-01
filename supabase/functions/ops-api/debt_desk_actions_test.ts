// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSupabaseDebtDeskStore,
  DEBT_DESK_OWNERS_SETTING,
  DEBT_SENDING_SWITCH,
  type DebtDeskDeps,
  DebtDeskError,
  debtDeskOwnerIds,
  type DebtDeskStore,
  debtDraftDecide,
  debtDraftSend,
  debtLogOutcome,
  debtSendingEnabled,
} from "./debt_desk_actions.ts";
import { debtDraftStates } from "./debt_desk_drafts.ts";
import { debtNotes } from "./debt_picture.ts";
import { listOverdueInvoices } from "./index.ts";
import { debtChaseEventFromLogRow } from "./debt_chase_schedule.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const SHAUN = {
  user_id: "20000000-0000-4000-8000-0000000000aa",
  email: "shaun@example.test",
};
/** Another staff user (an admin) who is not the desk owner. */
const OTHER_STAFF = {
  user_id: "20000000-0000-4000-8000-0000000000bb",
  email: "admin@example.test",
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
  const push = (next: Record<string, unknown>[]) => {
    clock += 1;
    const at = new Date(Date.parse(THU_9AM) + clock * 1000).toISOString();
    for (const r of next) {
      rows.push({ id: `r${rows.length + 1}`, created_at: at, ...r });
    }
  };
  const claimed = (r: Record<string, unknown>) =>
    r.outcome_code === "sending" || r.outcome_code === "sent";
  const store: DebtDeskStore & {
    rows: typeof rows;
    failInsert?: boolean;
    failSettleSent?: boolean;
  } = {
    rows,
    insertChaseRows(next) {
      if ((store as any).failInsert) {
        return Promise.reject(
          new DebtDeskError("write failed", 502, "debt_desk_write_failed"),
        );
      }
      push(next);
      return Promise.resolve();
    },
    // The unique claim index: one sending-or-sent row per draft and invoice.
    claimSend(next) {
      const taken = next.some((n) =>
        rows.some((r) =>
          claimed(r) && r.draft_id === n.draft_id &&
          r.xero_invoice_id === n.xero_invoice_id
        )
      );
      if (taken) return Promise.resolve(false);
      push(next);
      return Promise.resolve(true);
    },
    settleSend(draftId, ids, patch) {
      if (store.failSettleSent && patch.outcome_code === "sent") {
        return Promise.reject(
          new DebtDeskError("write failed", 502, "debt_desk_write_failed"),
        );
      }
      const hit = rows.filter((r) =>
        r.draft_id === draftId && r.outcome_code === "sending" &&
        ids.includes(String(r.xero_invoice_id))
      );
      if (hit.length !== ids.length) {
        return Promise.reject(
          new DebtDeskError("write failed", 502, "debt_desk_write_failed"),
        );
      }
      for (const r of hit) Object.assign(r, patch);
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
    opsManagerUserId: () => Promise.resolve(SHAUN.user_id),
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
    deskOwnerIds: () => Promise.resolve([SHAUN.user_id]),
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

Deno.test("send: an older credit note with the drafted balance still owing does not block the text", async () => {
  const store = await approvedStore();
  const x = deps(store, {
    sendingEnabled: true,
    invoices: {
      [A]: xeroInvoice(A, {
        AmountDue: 100,
        AmountCredited: 25,
        CreditNotes: [{ CreditNoteID: "c1" }],
      }),
    },
  });
  const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(res.results[0].sent, true);
  assertEquals(x.sends.length, 1);
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
    // Credited since the draft: the amount due fell below what the text says.
    [{ AmountCredited: 10, AmountDue: 90 }, "part_paid"],
    [{ AmountCredited: 100, AmountDue: 0 }, "paid"],
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

  // A provider failure is not confirmed: the draft stays claimed, the batch carries on, one
  // send at a time, and the failed draft is never sent again.
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
    "send_not_confirmed",
  ], [true, null]]);
  assertEquals(most, 1);
  assertEquals(
    store2.rows.filter((r) =>
      r.outcome_code === "sending" &&
      r.outcome === "send not confirmed: SMS send failed"
    ).length,
    2,
  );
  const state = debtDraftStates(store2.rows).get(DRAFT);
  assertEquals(state?.decision?.kind, "sending");
  assertEquals(state?.decision?.reason, "send not confirmed: SMS send failed");
  const again = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, y.d);
  assertEquals(again.results[0].code, "already_sending");
  assertEquals(n, 2);
  // An unconfirmed claim never moves the ladder.
  assert(
    store2.rows.filter((r) => r.outcome_code === "sending").every((r) =>
      debtChaseEventFromLogRow(r) === null
    ),
  );
});

/** A read-only PostgREST stand-in: eq, in and or filter; other modifiers pass through. */
function tableClient(tables: Record<string, Record<string, unknown>[]>) {
  const split = (text: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const term = (t: string): (r: any) => boolean => {
    const and = /^and\((.*)\)$/.exec(t);
    if (and) {
      const parts = split(and[1]).map(term);
      return (r) => parts.every((f) => f(r));
    }
    const [c, op, ...rest] = t.split(".");
    const v = rest.join(".");
    if (op === "is" && v === "null") {
      return (r) => r[c] === null || r[c] === undefined;
    }
    if (op === "eq") return (r) => String(r[c]) === v;
    throw new Error(`unsupported or() term ${t}`);
  };
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const q: any = {};
      for (const m of ["select", "gt", "lt", "not", "order", "limit"]) {
        q[m] = () => q;
      }
      q.eq = (c: string, v: unknown) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      q.in = (c: string, v: unknown[]) => {
        filters.push((r) => v.includes(r[c]));
        return q;
      };
      q.or = (expr: string) => {
        const terms = split(expr).map(term);
        filters.push((r) => terms.some((f) => f(r)));
        return q;
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
          error: null,
        }).then(resolve);
      return q;
    },
  };
}

Deno.test("send: a two-invoice desk send reads as one chase on each invoice in Clear Debt and the notes thread", async () => {
  const store = await approvedStore();
  const x = deps(store, { sendingEnabled: true });
  // send_chase_sms logs its own row, on the first covered invoice only.
  x.d.sendSms = (body) => {
    store.rows.push({
      id: "legacy",
      created_at: "2026-10-01T01:00:30Z",
      xero_invoice_id: body.xero_invoice_id,
      job_id: body.job_id,
      ghl_contact_id: body.ghl_contact_id,
      method: "sms",
      outcome: "SMS sent",
      notes: body.message,
      chased_by: body.operator_email,
    });
    return Promise.resolve({ success: true, message_id: "m1" });
  };
  const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(res.sent, 1);
  // A second press is refused, and a refusal is not a chase.
  await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);

  const invoice = (id: string, n: string) => ({
    xero_invoice_id: id,
    xero_contact_id: "xc-1",
    contact_name: "Sam Example",
    invoice_number: n,
    amount_due: 100,
    due_date: "2026-09-20",
    invoice_type: "ACCREC",
    org_id: ORG,
    status: "AUTHORISED",
    job_id: "j1",
  });
  const client = tableClient({
    xero_invoices: [invoice(A, "INV-1"), invoice(B, "INV-2")],
    jobs: [{ id: "j1", job_number: "SWF-1", status: "complete" }],
    payment_chase_logs: store.rows,
  });
  const overdue: any = await listOverdueInvoices(client);
  const counts = Object.fromEntries(
    overdue.clients[0].invoices.map((
      i: any,
    ) => [i.invoice_number, i.chase_log_count]),
  );
  assertEquals(counts, { "INV-1": 1, "INV-2": 1 });
  for (const id of [A, B]) {
    const thread = await debtNotes(client, id, null);
    assertEquals(thread.length, 1, id);
  }
});

Deno.test("send: two overlapping sends of one draft text the client once", async () => {
  const store = await approvedStore();
  const x = deps(store, { sendingEnabled: true });
  const [one, two] = await Promise.all([
    debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d),
    debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d),
  ]);
  assertEquals(x.sends.length, 1);
  assertEquals(
    [one.results[0], two.results[0]].map((r) => r.code ?? "sent").sort(),
    ["already_sending", "sent"],
  );
  assertEquals(store.rows.filter((r) => r.outcome_code === "sent").length, 2);
});

Deno.test("send: when the sent row cannot be written the draft stays claimed and is never re-sent", async () => {
  const store = await approvedStore();
  store.failSettleSent = true;
  const x = deps(store, { sendingEnabled: true });
  const res = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(res.results[0], {
    draft_id: DRAFT,
    sent: true,
    provider_message_id: "msg-1",
    logged: false,
  });
  assertEquals(
    debtDraftStates(store.rows).get(DRAFT)?.decision?.kind,
    "sending",
  );
  store.failSettleSent = false;
  const again = await debtDraftSend({ draft_ids: [DRAFT] }, SHAUN, x.d);
  assertEquals(again.results[0].code, "already_sending");
  assertEquals(x.sends.length, 1);
  // Nor can the claimed draft be approved or skipped again.
  const error = await assertRejects(() => approve(store), DebtDeskError);
  assertEquals([error.status, error.code], [409, "debt_draft_sending"]);
});

Deno.test("desk owner: only the owner approves, skips and sends; any staff user logs an outcome", async () => {
  const store = await approvedStore();
  const d = deps(store, { sendingEnabled: true }).d;
  for (
    const call of [
      () =>
        debtDraftDecide(
          {
            draft_id: DRAFT,
            decision: "skip",
            text: "x",
            xero_invoice_ids: [A, B],
          },
          OTHER_STAFF,
          d,
        ),
      () => debtDraftSend({ draft_ids: [DRAFT] }, OTHER_STAFF, d),
    ]
  ) {
    const error = await assertRejects(call, DebtDeskError);
    assertEquals([error.status, error.code], [403, "debt_desk_owner_required"]);
  }
  const before = store.rows.length;
  await debtLogOutcome(
    {
      xero_invoice_ids: [A],
      outcome_code: "no_answer",
      channel: "call",
      schedule_step: "call",
    },
    OTHER_STAFF,
    d,
  );
  assertEquals(store.rows.length, before + 1);
  assertEquals(store.rows.at(-1)?.chased_by, OTHER_STAFF.email);
});

Deno.test("desk owner: the configured ids, else the ops manager; an unusable setting means nobody", async () => {
  const store = memoryStore();
  const env = (v: string | undefined) => (name: string) =>
    name === DEBT_DESK_OWNERS_SETTING ? v : undefined;
  assertEquals(await debtDeskOwnerIds(store, env(undefined)), [SHAUN.user_id]);
  assertEquals(await debtDeskOwnerIds(store, env("  ")), [SHAUN.user_id]);
  assertEquals(
    await debtDeskOwnerIds(
      store,
      env(` ${OTHER_STAFF.user_id.toUpperCase()} , ${SHAUN.user_id}`),
    ),
    [OTHER_STAFF.user_id, SHAUN.user_id],
  );
  assertEquals(await debtDeskOwnerIds(store, env("shaun")), []);
  store.opsManagerUserId = () => Promise.resolve(null);
  assertEquals(await debtDeskOwnerIds(store, env(undefined)), []);
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
  const e3 = await assertRejects(
    () => debtDraftSend({ draft_id: DRAFT }, SHAUN, deps(store).d),
    DebtDeskError,
  );
  assertEquals(e3.code, "debt_desk_bad_request");
});

Deno.test("outcome: payer_key is not a field", async () => {
  const error = await assertRejects(
    () =>
      debtLogOutcome(
        {
          payer_key: "contact-a",
          xero_invoice_ids: [A],
          outcome_code: "spoke",
        },
        SHAUN,
        deps(memoryStore()).d,
      ),
    DebtDeskError,
  );
  assertEquals(error.code, "debt_desk_bad_request");
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
        const m of [
          "select",
          "eq",
          "in",
          "order",
          "range",
          "limit",
          "insert",
          "update",
        ]
      ) {
        q[m] = (...args: unknown[]) => {
          calls.push([m, args]);
          return q;
        };
      }
      for (const m of ["upsert", "delete", "rpc"]) {
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
      "opsManagerUserId",
      "chaseLogRows",
    ] as const
  ) {
    const e = await assertRejects(
      () =>
        (createSupabaseDebtDeskStore(bad.client, ORG) as any)[read](
          read === "draftRows" ? "d" : ["x"],
        ),
      DebtDeskError,
    );
    assertEquals(e.code, "debt_desk_read_failed", read);
  }
});

Deno.test("store: a claim is refused by the unique index, never by a silent success, and a settle must change every claim row", async () => {
  const taken = fakeSupabase(() => ({
    data: null,
    error: { code: "23505", message: "duplicate key" },
  }));
  assertEquals(
    await createSupabaseDebtDeskStore(taken.client, ORG).claimSend([{
      draft_id: "d",
    }]),
    false,
  );
  const ok = fakeSupabase(() => ({ data: null, error: null }));
  assertEquals(
    await createSupabaseDebtDeskStore(ok.client, ORG).claimSend([{
      draft_id: "d",
    }]),
    true,
  );
  const broken = fakeSupabase(() => ({
    data: null,
    error: { code: "23514", message: "check violated" },
  }));
  const e1 = await assertRejects(
    () =>
      createSupabaseDebtDeskStore(broken.client, ORG).claimSend([{
        draft_id: "d",
      }]),
    DebtDeskError,
  );
  assertEquals(e1.code, "debt_desk_write_failed");

  const settled = fakeSupabase(() => ({
    data: [{ id: "1" }, { id: "2" }],
    error: null,
  }));
  await createSupabaseDebtDeskStore(settled.client, ORG).settleSend(
    "d",
    [A, B],
    { outcome_code: "sent" },
  );
  assertEquals(settled.log[0].calls, [
    ["update", [{ outcome_code: "sent" }]],
    ["eq", ["org_id", ORG]],
    ["eq", ["draft_id", "d"]],
    ["eq", ["outcome_code", "sending"]],
    ["in", ["xero_invoice_id", [A, B]]],
    ["select", ["id"]],
  ]);
  const short = fakeSupabase(() => ({ data: [{ id: "1" }], error: null }));
  const e2 = await assertRejects(
    () =>
      createSupabaseDebtDeskStore(short.client, ORG).settleSend("d", [A, B], {
        outcome_code: "sent",
      }),
    DebtDeskError,
  );
  assertEquals(e2.code, "debt_desk_write_failed");
});
