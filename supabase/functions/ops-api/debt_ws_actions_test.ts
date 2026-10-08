// deno-lint-ignore-file no-import-prefix no-explicit-any
// Debt Workshop actions (debt_ws_actions.ts) over an in-memory store and recorded sends.
// Synthetic fixture (debt_ws_test_fakes.ts): today is Thursday 8 October 2026, Perth.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetDebtWsBankCacheForTest,
  DEBT_WS_ACTIONS,
  debtWsOwnerIds,
  debtWsSendingOn,
  normaliseAuMobile,
  runDebtWsAction,
} from "./debt_ws_actions.ts";
import {
  fakeDeps,
  FakeStore,
  IDS,
  JOBS,
  MLB_CONTACT,
  NOW,
  ON,
  SERVER,
  SHAUN,
  SHAUN_ID,
  STAFF,
} from "./debt_ws_test_fakes.ts";
import { DEBT_WS_SETTINGS_OFF } from "./debt_ws_store.ts";

type Deps = ReturnType<typeof fakeDeps>["deps"];

async function call(
  deps: Deps,
  action: string,
  caller = SHAUN,
  input: Record<string, unknown> = {},
) {
  const method = DEBT_WS_ACTIONS[action].method;
  const params = new URLSearchParams(
    method === "GET"
      ? Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, String(v)]),
      )
      : {},
  );
  _resetDebtWsBankCacheForTest();
  return await runDebtWsAction(
    action,
    method,
    params,
    method === "POST" ? input : {},
    caller,
    deps,
  );
}

function sendingOn(store: FakeStore) {
  store.settingsRow.sending_enabled = true;
  return ON;
}

const D7_SEND = {
  xero_invoice_id: IDS.final,
  step: "d7",
  action: "send",
  text: "Hi Alex,\n\nThere's $1,000.00 still outstanding.\n\nCheers,\nShaun",
};

// ── Switches and owner ──

Deno.test("switches: sending needs the env AND the settings row; both default off", () => {
  const settings = { ...DEBT_WS_SETTINGS_OFF };
  const env = (v: Record<string, string>) => (n: string) => v[n];
  assertEquals(debtWsSendingOn(env({}), settings), false);
  assertEquals(debtWsSendingOn(env(ON), settings), false);
  assertEquals(
    debtWsSendingOn(env({}), { ...settings, sending_enabled: true }),
    false,
  );
  assertEquals(
    debtWsSendingOn(env({ DEBT_WS_SENDING_ENABLED: "TRUE" }), {
      ...settings,
      sending_enabled: true,
    }),
    false,
  );
  assertEquals(
    debtWsSendingOn(env(ON), { ...settings, sending_enabled: true }),
    true,
  );
});

Deno.test("owner: env DEBT_WS_OWNER_USER_IDS overrides the settings row; junk means nobody", () => {
  const settings = { ...DEBT_WS_SETTINGS_OFF, owner_user_ids: [SHAUN_ID] };
  assertEquals(debtWsOwnerIds(() => undefined, settings), [SHAUN_ID]);
  const other = "40000000-0000-4000-8000-000000000001";
  assertEquals(
    debtWsOwnerIds(
      (n) =>
        n === "DEBT_WS_OWNER_USER_IDS"
          ? ` ${other.toUpperCase()} ,x`
          : undefined,
      settings,
    ),
    [other],
  );
  assertEquals(
    debtWsOwnerIds(
      (n) => n === "DEBT_WS_OWNER_USER_IDS" ? "nobody" : undefined,
      settings,
    ),
    [],
  );
});

// ── Dispatcher: methods and who ──

Deno.test("dispatcher: wrong method is 405; owner, server and staff gates", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const r405 = await runDebtWsAction(
    "debt_ws_overview",
    "POST",
    new URLSearchParams(),
    {},
    SHAUN,
    deps,
  );
  assertEquals(r405.status, 405);
  assertEquals(
    (await call(deps, "debt_ws_decide", STAFF, D7_SEND)).body.code,
    "not_owner",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SERVER, D7_SEND)).body.code,
    "not_owner",
  );
  assertEquals(
    (await call(deps, "debt_ws_jan_list_lock", SHAUN)).body.code,
    "server_key_required",
  );
  assertEquals((await call(deps, "debt_ws_agent_queue", STAFF)).status, 403);
  assertEquals((await call(deps, "debt_ws_agent_queue", SERVER)).status, 200);
  assertEquals((await call(deps, "debt_ws_agent_queue", SHAUN)).status, 200);
  assertEquals(
    (await call(deps, "debt_ws_overview", {
      kind: "user",
      user_id: SHAUN_ID,
      staff: false,
    })).status,
    403,
  );
  assertEquals(
    (await call(deps, "debt_ws_overview", { kind: "none" })).status,
    403,
  );
  store.settingsRow.owner_user_ids = [];
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, D7_SEND)).body.code,
    "owner_not_set",
  );
  const unknown = await runDebtWsAction(
    "debt_ws_nope",
    "GET",
    new URLSearchParams(),
    {},
    SHAUN,
    deps,
  );
  assertEquals(unknown.status, 400);
});

// ── Overview ──

Deno.test("overview: categories, rows, companies, not due, not chased, needs a look, paid, Jan", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const res = await call(deps, "debt_ws_overview", SHAUN);
  assertEquals(res.status, 200);
  const b = res.body as any;
  assertEquals(b.version, "debt-ws/v1");
  assertEquals(b.perth_date, "2026-10-08");
  assertEquals(b.settings, {
    tab_visible: false,
    sending_on: false,
    agent_on: false,
    viewer_is_owner: true,
    owner_set: true,
  });
  assertEquals(b.categories.active, { count: 1, amount: 1000 });
  assertEquals(b.categories.escalating, { count: 1, amount: 2000 });
  assertEquals(b.categories.bad_debt, { count: 3, amount: 1641 });
  assertEquals(b.categories.says_paid, { count: 0, amount: 0 });
  assertEquals(b.not_due, { count: 1, amount: 440 });
  // The go-ahead deposit is hidden; the unlinked person needs a look.
  const ids = b.rows.map((r: any) => r.xero_invoice_id);
  assert(!ids.includes(IDS.goAhead));
  assert(!ids.includes(IDS.unlinked));
  assertEquals(b.needs_a_look.map((n: any) => [n.xero_invoice_id, n.reason]), [[
    IDS.unlinked,
    "not linked to a job",
  ]]);
  assertEquals(b.not_chased, [{
    name: "Builderwest Pty Ltd",
    amount: 561,
    count: 1,
    xero_invoice_ids: [IDS.notChased],
  }]);

  const final = b.rows.find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(final.kind, "final");
  assertEquals(final.lane, "homeowner");
  assertEquals(final.day, 7);
  assertEquals(final.category, "active");
  assertEquals(final.step_due, { step: "d7", label: "Day 7 call and text" });
  assertEquals(final.next_step, { step: "d12", date: "2026-10-13" });
  assertEquals(final.suggestion, {
    id: null,
    source: "template",
    status: "pending",
  });
  assertEquals(final.ghl_linked, true);
  assertEquals(final.payer_label, "Alex Sample");
  assertEquals(final.flag_count, 0);
  for (
    const key of [
      "share_key",
      "xero_invoice_id",
      "invoice_number",
      "reference",
      "job_id",
      "job_number",
      "job_type",
      "lane",
      "payer_name",
      "payer_label",
      "neighbour_of",
      "kind",
      "amount_due",
      "invoice_date",
      "due_date",
      "day",
      "category",
      "step_due",
      "next_step",
      "paused_until",
      "suggestion",
      "ghl_linked",
      "last_touch",
      "on_jan_list",
    ]
  ) assert(key in final, key);

  const progress = b.rows.find((r: any) => r.xero_invoice_id === IDS.progress);
  assertEquals(progress.kind, "progress");
  assertEquals(progress.due_date, "2026-09-27");
  assertEquals(progress.day, 11);
  assertEquals(progress.category, "escalating");
  assertEquals(progress.stage, "materials");

  const jan = b.rows.find((r: any) => r.xero_invoice_id === IDS.janFinal);
  assertEquals(jan.on_jan_list, true);
  assertEquals(jan.payer_label, "Robin Next (neighbour of Taylor Main)");
  assertEquals(jan.neighbour_of, "Taylor Main");
  assertEquals(jan.step_due?.step, "d21");
  assertEquals(b.rows[0].category, "bad_debt");

  assertEquals(b.companies.length, 1);
  assertEquals(b.companies[0].company_key, MLB_CONTACT);
  assertEquals(b.companies[0].past_due, {
    count: 1,
    amount: 330,
    oldest_days: 27,
  });
  assertEquals(b.companies[0].in_grace, { count: 1, amount: 440 });
  assertEquals(b.companies[0].category, "bad_debt");
  assertEquals(b.companies[0].statement, {
    week_start: "2026-10-05",
    status: "ready",
  });

  assertEquals(b.paid_this_week.count, 1);
  assertEquals(b.paid_this_week.items[0].paid_on, "2026-10-06");
  assertEquals(b.jan_list, {
    visit_date: "2026-10-12",
    status: "open",
    count: 1,
  });
});

Deno.test("overview: a viewer who is not the owner sees viewer_is_owner false", async () => {
  const { deps } = fakeDeps(new FakeStore());
  const b = (await call(deps, "debt_ws_overview", STAFF)).body as any;
  assertEquals(b.settings.viewer_is_owner, false);
});

Deno.test("overview: a rectification exit after the due date restarts a final's clock", async () => {
  const store = new FakeStore();
  store.exits.push({ job_id: JOBS.fence, occurred_at: "2026-10-05T04:00:00Z" });
  const { deps } = fakeDeps(store);
  const b = (await call(deps, "debt_ws_overview", SHAUN)).body as any;
  const final = b.rows.find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(final.cycle_start, "2026-10-05");
  assertEquals(final.day, 3);
  store.jobRows.find((j) => j.id === JOBS.fence)!.status = "rectification";
  const b2 = (await call(deps, "debt_ws_overview", SHAUN)).body as any;
  const again = b2.rows.find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(again.category, "rectification");
  assertEquals(again.step_due, null);
});

// ── debt_ws_decide ──

Deno.test("decide: sending off refuses, logs the refusal, and texts nobody", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(res.status, 409);
  assertEquals(res.body.code, "sending_off");
  assertEquals(res.body.error, "Sending is off until you switch it on");
  assertEquals(rec.sms.length, 0);
  assertEquals(rec.liveReads.length, 0);
  assertEquals(store.sendRows.length, 0);
  const log = store.logRows.at(-1)!;
  assertEquals(log.kind, "send_refused");
  assertEquals(log.meta.code, "sending_off");
  assertEquals(log.created_by, SHAUN_ID);
  // The env alone is not enough either.
  const { deps: envOnly } = fakeDeps(store, { env: ON });
  assertEquals(
    (await call(envOnly, "debt_ws_decide", SHAUN, D7_SEND)).body.code,
    "sending_off",
  );
});

Deno.test("decide: not the owner is refused before anything is read", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  const res = await call(deps, "debt_ws_decide", STAFF, D7_SEND);
  assertEquals(res.status, 403);
  assertEquals(res.body.code, "not_owner");
  assertEquals(rec.sms.length + rec.liveReads.length, 0);
});

Deno.test("decide: part paid since the draft refuses on the live Xero check", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, {
    env: sendingOn(store),
    live: {
      [IDS.final]: {
        InvoiceID: IDS.final,
        InvoiceNumber: "INV-2001",
        Status: "AUTHORISED",
        AmountDue: 400,
      },
    },
  });
  const res = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(res.body.code, "part_paid");
  assert(String(res.body.error).includes("$400.00"));
  assertEquals(rec.sms.length, 0);
  assertEquals(store.sendRows.length, 0);
  assertEquals(store.logRows.at(-1)!.meta.code, "part_paid");
});

Deno.test("decide: paid or voided in Xero refuses", async () => {
  for (
    const [live, code] of [
      [{ Status: "PAID", AmountDue: 0 }, "paid"],
      [{ Status: "AUTHORISED", AmountDue: 0 }, "paid"],
      [{ Status: "VOIDED", AmountDue: 0 }, "not_open"],
    ] as const
  ) {
    const store = new FakeStore();
    const { deps, rec } = fakeDeps(store, {
      env: sendingOn(store),
      live: { [IDS.final]: { InvoiceID: IDS.final, ...live } },
    });
    assertEquals(
      (await call(deps, "debt_ws_decide", SHAUN, D7_SEND)).body.code,
      code,
    );
    assertEquals(rec.sms.length, 0);
  }
});

Deno.test("decide: a possible payment refuses; Send anyway overrides and is logged", async () => {
  const store = new FakeStore();
  const bank = [{
    bank_transaction_id: "b0000000-0000-4000-8000-000000000001",
    type: "RECEIVE",
    date: "2026-10-06T00:00:00",
    total: 1000,
    reference: "Transfer",
    contact_name: null,
    line_item_descriptions: [],
  }];
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store), bank });
  const refused = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(refused.status, 409);
  assertEquals(refused.body.code, "possible_payment");
  assertEquals(
    (refused.body.possible_payments as any[])[0].reason,
    "amount matches, name unclear",
  );
  assertEquals(rec.bankReads, ["2026-09-30"]);
  assertEquals(rec.sms.length, 0);

  const sent = await call(deps, "debt_ws_decide", SHAUN, {
    ...D7_SEND,
    override_possible_payment: true,
  });
  assertEquals(sent.status, 200);
  assertEquals(sent.body.override_possible_payment, true);
  assertEquals(rec.sms.length, 1);
  const log = store.logRows.find((l) => l.kind === "text_sent")!;
  assertEquals(log.meta.override_possible_payment, true);
  assertEquals((log.meta.possible_payments as any[]).length, 1);
});

Deno.test("decide: a claim conflict refuses and never texts", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  store.loseNextClaim = true;
  const res = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(res.body.code, "already_sent");
  assertEquals(rec.sms.length, 0);
  // A step already claimed (or sent) is refused before Xero is read.
  store.sendRows.push({
    id: "x",
    share_key: IDS.final,
    cycle_start: "2026-10-01",
    step: "d7",
    suggestion_id: null,
    status: "sending",
    provider_message_id: null,
    error: null,
    actor: "Shaun",
    created_at: NOW.toISOString(),
  });
  rec.liveReads.length = 0;
  const again = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(again.body.code, "step_not_due");
  assertEquals(rec.liveReads.length, 0);
});

Deno.test("decide: a successful send claims, texts once through sendChaseSms, logs and marks the suggestion", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  const suggestion = await store.insertSuggestion({
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: JOBS.fence,
    cycle_start: "2026-10-01",
    step: "d7",
    kind: "draft",
    channel: "sms",
    text: "draft",
    why: "Day 7",
    proposed_category: null,
    amount: 1000,
    source: "agent",
    agent_version: "debt-ws-playbook/v1",
  });
  const res = await call(deps, "debt_ws_decide", SHAUN, {
    ...D7_SEND,
    suggestion_id: suggestion.id,
    channel: "sms",
  });
  assertEquals(res.status, 200);
  assertEquals(res.body.sent, true);
  assertEquals(res.body.provider_message_id, "msg-1");
  assertEquals(rec.sms, [{
    ghl_contact_id: "ghlcontact0000000001",
    job_id: JOBS.fence,
    xero_invoice_id: IDS.final,
    message: D7_SEND.text,
    operator_email: "owner@example.test",
  }]);
  assertEquals(rec.liveReads, [IDS.final]);
  assertEquals(store.sendRows.length, 1);
  assertEquals(store.sendRows[0].status, "sent");
  assertEquals(store.sendRows[0].provider_message_id, "msg-1");
  assertEquals(store.sendRows[0].cycle_start, "2026-10-01");
  assertEquals(store.sendRows[0].suggestion_id, suggestion.id);
  assertEquals(store.suggestionRows[0].status, "sent");
  const log = store.logRows.find((l) => l.kind === "text_sent")!;
  assertEquals(log.step, "d7");
  assertEquals(log.body, D7_SEND.text);
  assertEquals(log.created_by_name, "Shaun");
  assertEquals(log.meta.cycle_start, "2026-10-01");
  // The step is done: it is not offered again, and a second send is refused.
  const ov = (await call(deps, "debt_ws_overview", SHAUN)).body as any;
  const row = ov.rows.find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(row.step_due, null);
  assertEquals(row.last_touch.kind, "text_sent");
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, D7_SEND)).body.code,
    "step_not_due",
  );
  assertEquals(rec.sms.length, 1);
});

Deno.test("decide: the draft's amount is the bar for the live check", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, {
    env: sendingOn(store),
    live: {
      [IDS.final]: {
        InvoiceID: IDS.final,
        Status: "AUTHORISED",
        AmountDue: 900,
      },
    },
  });
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, { ...D7_SEND, amount: 1000 }))
      .body.code,
    "part_paid",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, { ...D7_SEND, amount: 900 }))
      .status,
    200,
  );
  assertEquals(rec.sms.length, 1);
});

Deno.test("decide: a guard refusal inside sendChaseSms releases the claim; an unconfirmed send keeps it", async () => {
  const { DebtWsSendRefusedError } = await import("./debt_ws_actions.ts");
  const store = new FakeStore();
  const { deps } = fakeDeps(store, {
    env: sendingOn(store),
    smsError: new DebtWsSendRefusedError("contact does not match the job"),
  });
  const refused = await call(deps, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(refused.body.code, "send_refused_by_guard");
  assertEquals(store.sendRows[0].status, "refused");

  const store2 = new FakeStore();
  const { deps: deps2 } = fakeDeps(store2, {
    env: sendingOn(store2),
    smsError: new Error("timeout"),
  });
  const unknown = await call(deps2, "debt_ws_decide", SHAUN, D7_SEND);
  assertEquals(unknown.status, 502);
  assertEquals(unknown.body.code, "send_not_confirmed");
  assertEquals(store2.sendRows[0].status, "sending");
});

Deno.test("decide: refuses texts the guard forbids, steps not due, company invoices and no contact", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      text: "Hi \u2014 pay now",
    })).body.code,
    "text_not_allowed",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      text: "Or a debt collector",
    })).body.code,
    "text_not_allowed",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, { ...D7_SEND, step: "d3" })).body
      .code,
    "step_not_due",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, { ...D7_SEND, step: "d21" }))
      .status,
    400,
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      xero_invoice_id: IDS.account,
      step: "d1",
    })).body.code,
    "not_chased_by_text",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      xero_invoice_id: IDS.goAhead,
    })).body.code,
    "not_in_book",
  );
  store.jobRows.find((j) => j.id === JOBS.fence)!.ghl_contact_id = null;
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, D7_SEND)).body.code,
    "no_contact",
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, { ...D7_SEND, extra: 1 }))
      .status,
    400,
  );
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      channel: "email",
    })).status,
    400,
  );
  assertEquals(rec.sms.length, 0);
});

Deno.test("decide: a reply is sent from its suggestion, whatever the step due", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  const reply = await store.insertSuggestion({
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: JOBS.fence,
    cycle_start: "2026-10-01",
    step: "reply_says_paid",
    kind: "move",
    channel: "sms",
    text: "Thanks Alex!",
    why: "Client said: I paid yesterday",
    proposed_category: "says_paid",
    amount: 1000,
    source: "agent",
    agent_version: "debt-ws-playbook/v1",
  });
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      ...D7_SEND,
      step: "reply_says_paid",
    })).status,
    400,
  );
  // "Move + send reply": the screen moves the card first, then sends the reply. Says paid
  // holds the ladder but never blocks the reply.
  const moved = await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "says_paid",
    suggestion_id: reply.id,
  });
  assertEquals(moved.status, 200);
  assertEquals(store.suggestionRows[0].status, "accepted");
  const res = await call(deps, "debt_ws_decide", SHAUN, {
    xero_invoice_id: IDS.final,
    action: "send",
    step: "reply_says_paid",
    suggestion_id: reply.id,
    text: "Thanks Alex! It hasn't shown up our end yet.\n\nCheers,\nShaun",
  });
  assertEquals(res.status, 200);
  assertEquals(rec.sms.length, 1);
  assertEquals(store.sendRows[0].step, "reply_says_paid");
  assertEquals(store.suggestionRows[0].status, "sent");
  // Once sent, the reply cannot go again.
  const again = await call(deps, "debt_ws_decide", SHAUN, {
    xero_invoice_id: IDS.final,
    action: "send",
    step: "reply_says_paid",
    suggestion_id: reply.id,
    text: "Thanks Alex!\n\nCheers,\nShaun",
  });
  assertEquals(again.body.code, "suggestion_not_pending");
  assertEquals(rec.sms.length, 1);
});

Deno.test("set_category: Keep chasing (clear with the move's suggestion_id) dismisses the move", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const move = await store.insertSuggestion({
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: JOBS.fence,
    cycle_start: "2026-10-01",
    step: "reply_problem",
    kind: "move",
    channel: "sms",
    text: "Thanks Alex, sorry about that.",
    why: "Client said the gate sticks",
    proposed_category: "rectification",
    amount: 1000,
    source: "agent",
    agent_version: "debt-ws-playbook/v1",
  });
  const res = await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "clear",
    suggestion_id: move.id,
  });
  assertEquals(res.status, 200);
  assertEquals(store.suggestionRows[0].status, "dismissed");
  assertEquals(
    store.logRows.at(-1)!.body,
    "Kept chasing: dismissed the suggested move",
  );
});

Deno.test("decide: skip logs the step for this cycle; dismiss closes a flag", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_decide", SHAUN, {
    xero_invoice_id: IDS.final,
    step: "d7",
    action: "skip",
  });
  assertEquals(res.status, 200);
  const log = store.logRows.at(-1)!;
  assertEquals([log.kind, log.step, log.meta.cycle_start], [
    "skip",
    "d7",
    "2026-10-01",
  ]);
  const ov = (await call(deps, "debt_ws_overview", SHAUN)).body as any;
  assertEquals(
    ov.rows.find((r: any) => r.xero_invoice_id === IDS.final).step_due,
    null,
  );
  assertEquals(rec.sms.length, 0);

  const flag = await store.insertSuggestion({
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: JOBS.fence,
    cycle_start: "2026-10-01",
    step: null,
    kind: "flag",
    channel: null,
    text: "Client mentioned a loose gate",
    why: "Call on 7 Oct",
    proposed_category: null,
    amount: 1000,
    source: "agent",
    agent_version: null,
  });
  const dismissed = await call(deps, "debt_ws_decide", SHAUN, {
    suggestion_id: flag.id,
    action: "dismiss",
  });
  assertEquals(dismissed.status, 200);
  assertEquals(
    store.suggestionRows.find((s) => s.id === flag.id)!.status,
    "dismissed",
  );
  assertEquals(store.logRows.at(-1)!.meta.dismissed_suggestion_id, flag.id);
  assertEquals(
    (await call(deps, "debt_ws_decide", SHAUN, {
      suggestion_id: flag.id,
      action: "dismiss",
    })).body.code,
    "suggestion_not_pending",
  );
});

// ── Notes, categories, contacts ──

Deno.test("note: any staff user; a promise date pauses the steps and logs a promise", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const res = await call(deps, "debt_ws_note", STAFF, {
    xero_invoice_id: IDS.final,
    share_key: IDS.final,
    job_id: JOBS.fence,
    body: "Called, will pay Monday",
    note: "Called, will pay Monday",
    promise_date: "2026-10-12",
  });
  assertEquals(res.status, 200);
  assertEquals(store.logRows.map((l) => l.kind), ["note", "promise"]);
  assertEquals(store.logRows[0].job_id, JOBS.fence);
  assertEquals(store.logRows[0].created_by_name, "Staff Member");
  assertEquals(store.stateRows[0].paused_until, "2026-10-12");
  const row = ((await call(deps, "debt_ws_overview", SHAUN)).body as any).rows
    .find((
      r: any,
    ) => r.xero_invoice_id === IDS.final);
  assertEquals(row.paused_until, "2026-10-12");
  assertEquals(row.step_due, null);
  assertEquals(row.category, "active");
  assertEquals(
    (await call(deps, "debt_ws_note", STAFF, {
      xero_invoice_id: IDS.final,
      promise_date: "2026-10-01",
    })).status,
    400,
  );
  assertEquals(
    (await call(deps, "debt_ws_note", STAFF, { xero_invoice_id: IDS.final }))
      .status,
    400,
  );
  assertEquals(
    (await call(deps, "debt_ws_note", SERVER, {
      xero_invoice_id: IDS.final,
      text: "x",
    })).status,
    403,
  );
  const company = await call(deps, "debt_ws_note", STAFF, {
    company_key: MLB_CONTACT,
    text: "Rang accounts",
  });
  assertEquals(company.status, 200);
  assertEquals(store.logRows.at(-1)!.share_key, MLB_CONTACT);
});

Deno.test("set_category: says paid, rectification through updateJobStatus, and clear", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  assertEquals(
    (await call(deps, "debt_ws_set_category", STAFF, {
      xero_invoice_id: IDS.final,
      category: "says_paid",
    })).status,
    403,
  );
  await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "says_paid",
  });
  let row = ((await call(deps, "debt_ws_overview", SHAUN)).body as any).rows
    .find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(row.category, "says_paid");
  assertEquals(row.says_paid_since, "2026-10-08");
  await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "clear",
  });
  row = ((await call(deps, "debt_ws_overview", SHAUN)).body as any).rows.find((
    r: any,
  ) => r.xero_invoice_id === IDS.final);
  assertEquals(row.category, "active");

  const res = await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "rectification",
  });
  assertEquals(res.body.job_status, "rectification");
  assertEquals(rec.statusMoves, [{
    job_id: JOBS.fence,
    status: "rectification",
    source: "debt_workshop",
    operator_email: "owner@example.test",
    userId: SHAUN_ID,
  }]);
  assertEquals(
    store.logRows.filter((l) => l.kind === "category_change").length,
    3,
  );
  // Already in rectification: no second move.
  await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "rectification",
  });
  assertEquals(rec.statusMoves.length, 1);
  const cleared = await call(deps, "debt_ws_set_category", SHAUN, {
    xero_invoice_id: IDS.final,
    category: "clear",
  });
  assert(String(cleared.body.note).includes("stays in Rectification"));
  assertEquals(
    (await call(deps, "debt_ws_set_category", SHAUN, {
      xero_invoice_id: IDS.final,
      category: "paid",
    })).status,
    400,
  );
});

Deno.test("link_contact: owner only, sets the job's contact, refuses to overwrite without replace", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const body = {
    job_id: JOBS.makesafe,
    ghl_contact_id: "ghlcandidate00000001",
  };
  assertEquals(
    (await call(deps, "debt_ws_link_contact", STAFF, body)).status,
    403,
  );
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, body)).status,
    200,
  );
  assertEquals(
    store.jobRows.find((j) => j.id === JOBS.makesafe)!.ghl_contact_id,
    "ghlcandidate00000001",
  );
  assertEquals(store.logRows.at(-1)!.kind, "link_contact");
  const other = {
    job_id: JOBS.makesafe,
    ghl_contact_id: "ghlcandidate00000002",
  };
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, other)).body.code,
    "contact_already_linked",
  );
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, {
      ...other,
      replace: true,
    })).status,
    200,
  );
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, {
      job_id: JOBS.makesafe,
      ghl_contact_id: "x y",
    })).status,
    400,
  );
});

// ── The job view and documents ──

Deno.test("job: row, job, story, invoices, documents, conversation, ladder, template draft, contact", async () => {
  const store = new FakeStore();
  store.stateRows.push({
    share_key: IDS.final,
    says_paid_since: null,
    paused_until: null,
    agent_reviewed_at: null,
    note: null,
    pay_link: "https://in.xero.com/cached",
    pay_link_read_at: null,
  });
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.final,
  });
  assertEquals(res.status, 200);
  const b = res.body as any;
  assertEquals(b.row.step_due.step, "d7");
  assertEquals(b.job.job_number, "SWF-90001");
  assertEquals(b.story.version, "job-story-v1");
  assertEquals(b.invoices.map((i: any) => [i.number, i.kind]), [[
    "INV-2001",
    "final",
  ]]);
  assertEquals(b.documents.map((d: any) => d.mime), [
    "application/pdf",
    "image/jpeg",
  ]);
  assertEquals(b.conversation.messages.length, 2);
  assertEquals(b.ladder.length, 6);
  assertEquals(b.suggestion.source, "template");
  assertEquals(b.suggestion.step, "d7");
  assert(b.suggestion.text.includes("https://in.xero.com/cached"));
  assert(b.suggestion.text.includes("at Example Street"));
  assertEquals(b.pay_link, "https://in.xero.com/cached");
  assertEquals(rec.payLinkReads.length, 0);
  assertEquals(b.flags, []);
  assertEquals(b.possible_payments, []);
  assertEquals(b.contact, {
    ghl_contact_id: "ghlcontact0000000001",
    candidates: [],
  });

  // The patio's job lists its go-ahead deposit and the progress invoice.
  const patio =
    (await call(deps, "debt_ws_job", STAFF, { xero_invoice_id: IDS.progress }))
      .body as any;
  assertEquals(patio.invoices.map((i: any) => i.kind), [
    "go_ahead",
    "progress",
  ]);
  assert(patio.suggestion.text.includes("materials invoice"));
  assertEquals(rec.payLinkReads, [IDS.progress]);
  assertEquals(
    store.stateRows.find((s) => s.share_key === IDS.progress)!.pay_link,
    `https://in.xero.com/pay-${IDS.progress.slice(-4)}`,
  );

  // No GHL contact: candidates, phone match first.
  const ms =
    (await call(deps, "debt_ws_job", STAFF, { xero_invoice_id: IDS.account }))
      .body as any;
  assertEquals(ms.contact.ghl_contact_id, null);
  assertEquals(ms.contact.candidates[0], {
    id: "ghlcandidate00000001",
    name: "Insured Person",
    phone: "0400 000 001",
    email: "",
    match: "phone",
  });
  assertEquals(ms.suggestion, null);

  assertEquals(
    (await call(deps, "debt_ws_job", STAFF, { xero_invoice_id: IDS.unlinked }))
      .body.code,
    "not_in_book",
  );
  assertEquals(
    (await call(deps, "debt_ws_job", STAFF, { xero_invoice_id: "nope" }))
      .status,
    400,
  );
});

Deno.test("job: a pending agent draft is the suggestion and flags are notices", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const base = {
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: JOBS.fence,
    cycle_start: "2026-10-01",
    channel: "sms" as const,
    why: "Day 7",
    proposed_category: null,
    amount: 1000,
    source: "agent" as const,
    agent_version: "debt-ws-playbook/v1",
  };
  const draft = await store.insertSuggestion({
    ...base,
    step: "d7",
    kind: "draft",
    text: "Agent draft",
  });
  await store.insertSuggestion({
    ...base,
    step: null,
    kind: "flag",
    channel: null,
    text: "Gate issue mentioned",
  });
  // A stale draft for an earlier step is not shown.
  await store.insertSuggestion({
    ...base,
    step: "d3",
    kind: "draft",
    text: "Old",
  });
  const b =
    (await call(deps, "debt_ws_job", STAFF, { xero_invoice_id: IDS.final }))
      .body as any;
  assertEquals(b.suggestion.id, draft.id);
  assertEquals(b.suggestion.text, "Agent draft");
  assertEquals(b.flags.map((f: any) => f.text), ["Gate issue mentioned"]);
  assertEquals(b.row.flag_count, 1);
  assertEquals(b.row.suggestion, {
    id: draft.id,
    source: "agent",
    status: "pending",
  });
});

Deno.test("document: a job document through getJobDocument, or the invoice PDF", async () => {
  const { deps } = fakeDeps(new FakeStore());
  const doc = await call(deps, "debt_ws_document", STAFF, {
    job_id: JOBS.fence,
    document_id: "d0000000-0000-4000-8000-000000000001",
  });
  assertEquals(doc.status, 200);
  assertEquals((doc.body as any).content.base64, "QUJD");
  const pdf = await call(deps, "debt_ws_document", STAFF, {
    xero_invoice_id: IDS.final,
  });
  assertEquals((pdf.body as any).content.base64, "JVBERi0");
  assertEquals((pdf.body as any).file_name, `${IDS.final}.pdf`);
  assertEquals((doc.body as any).file_name, "document");
  assertEquals(
    (await call(deps, "debt_ws_document", STAFF, { job_id: JOBS.fence }))
      .status,
    400,
  );
});

// ── Statements ──

Deno.test("statement: preview has the table, links and total; send needs sending on and an email", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  const preview = await call(deps, "debt_ws_statement_preview", STAFF, {
    company_key: MLB_CONTACT,
  });
  assertEquals(preview.status, 200);
  const p = preview.body as any;
  assertEquals(p.to_email, "accounts@builders.example.test");
  assertEquals(p.invoices.map((i: any) => i.xero_invoice_id), [IDS.account]);
  assertEquals(p.total, 330);
  assert(p.html.includes(`https://in.xero.com/pay-${IDS.account.slice(-4)}`));
  assertEquals(p.status, "ready");
  assertEquals(
    (await call(deps, "debt_ws_statement_preview", STAFF, {
      company_key: "c0000000-0000-4000-8000-0000000000b1",
    })).body.code,
    "not_chased",
  );

  assertEquals(
    (await call(deps, "debt_ws_statement_send", SHAUN, {
      company_key: MLB_CONTACT,
    })).body.code,
    "sending_off",
  );
  assertEquals(rec.emails.length, 0);
  assertEquals(
    (await call(deps, "debt_ws_statement_send", STAFF, {
      company_key: MLB_CONTACT,
    })).status,
    403,
  );
});

Deno.test("statement: send emails HTML once a week, after the live re-check", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  const res = await call(deps, "debt_ws_statement_send", SHAUN, {
    company_key: MLB_CONTACT,
  });
  assertEquals(res.status, 200);
  assertEquals(rec.emails.length, 1);
  assertEquals(rec.emails[0].from, "admin@secureworkswa.com.au");
  assertEquals(rec.emails[0].to, "accounts@builders.example.test");
  assert(!("attachments" in rec.emails[0]));
  assertEquals(rec.liveReads, [IDS.account]);
  assertEquals(store.statementRows[0].status, "sent");
  assertEquals(store.logRows.at(-1)!.kind, "statement_sent");
  const again = await call(deps, "debt_ws_statement_send", SHAUN, {
    company_key: MLB_CONTACT,
  });
  assertEquals(again.body.code, "already_sent");
  assertEquals(rec.emails.length, 1);
  const ov = (await call(deps, "debt_ws_overview", SHAUN)).body as any;
  assertEquals(ov.companies[0].statement.status, "sent");
});

Deno.test("statement: everything paid since drops to nothing due; no email set refuses", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, {
    env: sendingOn(store),
    live: {
      [IDS.account]: { InvoiceID: IDS.account, Status: "PAID", AmountDue: 0 },
    },
  });
  const res = await call(deps, "debt_ws_statement_send", SHAUN, {
    company_key: MLB_CONTACT,
  });
  assertEquals(res.body.code, "nothing_due");
  assertEquals(rec.emails.length, 0);
  assertEquals(store.statementRows[0].status, "refused");

  const store2 = new FakeStore();
  store2.settingsRow.statement_emails = {};
  const { deps: d2 } = fakeDeps(store2, { env: sendingOn(store2) });
  assertEquals(
    (await call(d2, "debt_ws_statement_send", SHAUN, {
      company_key: MLB_CONTACT,
    })).body.code,
    "no_email",
  );
  const ov = (await call(d2, "debt_ws_overview", SHAUN)).body as any;
  assertEquals(ov.companies[0].statement.status, "no_email");
});

// ── Jan's visit list ──

Deno.test("Jan's list: live while open; remove drops a share for the week", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const list = (await call(deps, "debt_ws_jan_list", STAFF)).body as any;
  assertEquals(list.visit_date, "2026-10-12");
  assertEquals(list.lock_at, "2026-10-09T09:00:00+08:00");
  assertEquals(list.send_at, "2026-10-11T19:00:00+08:00");
  assertEquals(list.status, "open");
  assertEquals(list.items.map((i: any) => i.xero_invoice_id), [IDS.janFinal]);
  assertEquals(list.items[0].site_address, "4 Boundary Lane, Testville");
  assertEquals(list.jan, {
    name: "Jan Visitor",
    mobile_set: true,
    problem: null,
  });
  assert(list.text_preview.includes("Monday the 12th of October"));
  assertEquals(
    (await call(deps, "debt_ws_jan_list_remove", STAFF, {
      share_key: IDS.janFinal,
    })).status,
    403,
  );
  assertEquals(
    (await call(deps, "debt_ws_jan_list_remove", SHAUN, {
      share_key: IDS.janFinal,
    })).status,
    200,
  );
  const after = (await call(deps, "debt_ws_jan_list", STAFF)).body as any;
  assertEquals(after.items, []);
  assertEquals(after.removed_share_keys, [IDS.janFinal]);
});

Deno.test("Jan's list: lock and send are no-ops while switched off", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store, { env: ON });
  const lock = await call(deps, "debt_ws_jan_list_lock", SERVER);
  assertEquals(lock.body.skipped, true);
  assertEquals(lock.body.reason, "jan_list_auto_send_off");
  assertEquals(store.janRows.length, 0);
  const send = await call(deps, "debt_ws_jan_list_send", SERVER);
  assertEquals(send.body.reason, "jan_list_auto_send_off");
  // Auto-send on but sending off: the lock runs, the send does not.
  store.settingsRow.jan_list_auto_send = true;
  const { deps: offDeps } = fakeDeps(store);
  assertEquals(
    (await call(offDeps, "debt_ws_jan_list_lock", SERVER)).body.locked,
    true,
  );
  assertEquals(
    (await call(offDeps, "debt_ws_jan_list_send", SERVER)).body.reason,
    "sending_off",
  );
  assertEquals(rec.staffSms.length, 0);
});

Deno.test("Jan's list: Friday lock, Sunday send to Jan's mobile, dropping anyone paid since", async () => {
  const store = new FakeStore();
  store.settingsRow.jan_list_auto_send = true;
  store.settingsRow.sending_enabled = true;
  // Friday 9 Oct 09:00 Perth.
  const { deps: friday } = fakeDeps(store, {
    env: ON,
    now: new Date("2026-10-09T01:00:00Z"),
  });
  const lock = await call(friday, "debt_ws_jan_list_lock", SERVER);
  assertEquals(lock.body.locked, true);
  assertEquals(lock.body.count, 1);
  assertEquals(store.janRows[0].status, "locked");
  assertEquals(
    (await call(friday, "debt_ws_jan_list_lock", SERVER)).body.reason,
    "already_locked",
  );
  const stored = (await call(friday, "debt_ws_jan_list", STAFF)).body as any;
  assertEquals(stored.live, false);
  assertEquals(stored.items.length, 1);

  // Sunday 11 Oct 19:00 Perth.
  const { deps: sunday, rec } = fakeDeps(store, {
    env: ON,
    now: new Date("2026-10-11T11:00:00Z"),
  });
  const send = await call(sunday, "debt_ws_jan_list_send", SERVER);
  assertEquals(send.body.sent, true);
  assertEquals(rec.staffSms.length, 1);
  assertEquals(rec.staffSms[0].phone, "+61411222333");
  assert(rec.staffSms[0].message.startsWith("Hi Jan,"));
  assert(
    rec.staffSms[0].message.includes("Robin Next (neighbour of Taylor Main)"),
  );
  assertEquals(store.janRows[0].status, "sent");
  assertEquals(store.logRows.at(-1)!.kind, "jan_list");
  assertEquals(
    (await call(sunday, "debt_ws_jan_list_send", SERVER)).body.reason,
    "status_sent",
  );

  // A list whose only visit paid since the lock sends nothing.
  const store2 = new FakeStore();
  store2.settingsRow.jan_list_auto_send = true;
  store2.settingsRow.sending_enabled = true;
  const { deps: f2 } = fakeDeps(store2, {
    env: ON,
    now: new Date("2026-10-09T01:00:00Z"),
  });
  await call(f2, "debt_ws_jan_list_lock", SERVER);
  const { deps: s2, rec: rec2 } = fakeDeps(store2, {
    env: ON,
    now: new Date("2026-10-11T11:00:00Z"),
    live: {
      [IDS.janFinal]: { InvoiceID: IDS.janFinal, Status: "PAID", AmountDue: 0 },
    },
  });
  const none = await call(s2, "debt_ws_jan_list_send", SERVER);
  assertEquals(none.body.status, "skipped");
  assertEquals(rec2.staffSms.length, 0);

  // No mobile for Jan: failed, nothing sent.
  const store3 = new FakeStore();
  store3.settingsRow.jan_list_auto_send = true;
  store3.settingsRow.sending_enabled = true;
  store3.staff = [{
    id: "s1",
    name: "Jan Visitor",
    phone: null as unknown as string,
  }];
  const { deps: f3 } = fakeDeps(store3, {
    env: ON,
    now: new Date("2026-10-09T01:00:00Z"),
  });
  await call(f3, "debt_ws_jan_list_lock", SERVER);
  const { deps: s3, rec: rec3 } = fakeDeps(store3, {
    env: ON,
    now: new Date("2026-10-11T11:00:00Z"),
  });
  const failed = await call(s3, "debt_ws_jan_list_send", SERVER);
  assertEquals(failed.body.status, "failed");
  assertEquals(rec3.staffSms.length, 0);
});

Deno.test("Australian mobile normalising", () => {
  assertEquals(normaliseAuMobile("0411 222 333"), "+61411222333");
  assertEquals(normaliseAuMobile("+61 411 222 333"), "+61411222333");
  assertEquals(normaliseAuMobile("61411222333"), "+61411222333");
  assertEquals(normaliseAuMobile("08 9000 0000"), null);
  assertEquals(normaliseAuMobile("+1 411 222 333"), null);
  assertEquals(normaliseAuMobile(null), null);
});

// ── The agent ──

Deno.test("agent queue: off by default, then due steps without a suggestion, with a full bundle", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const off = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  assertEquals(off.agent_on, false);
  assertEquals(off.items, []);
  assertEquals(off.playbook_version, "debt-ws-playbook/v1");

  store.settingsRow.agent_enabled = true;
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  // Homeowner items only: the day 7 final and the materials invoice (day 21 has no text step).
  assertEquals(
    q.items.map((i: any) => i.row.xero_invoice_id).sort(),
    [IDS.final, IDS.progress].sort(),
  );
  const item = q.items.find((i: any) => i.row.xero_invoice_id === IDS.final);
  assertEquals(item.template_draft.step, "d7");
  assertEquals(item.template_draft.source, "template");
  assertEquals(item.story.events, undefined);
  assertEquals(item.story.timeline.length, 20);
  assertEquals(item.messages.map((m: any) => m.type), ["sms", "call"]);
  assertEquals(item.messages[1].transcript, "Transcript: I will pay Friday");
  assertEquals(item.playbook_version, "debt-ws-playbook/v1");
  assertEquals(item.possible_payments, []);
  assert(Array.isArray(item.notes));
});

Deno.test("agent submit: draft supersedes drafts and moves, a flag is logged and supersedes nothing, no_action only stamps", async () => {
  const store = new FakeStore();
  store.settingsRow.agent_enabled = true;
  const { deps, rec } = fakeDeps(store);
  const draft = {
    xero_invoice_id: IDS.final,
    step: "d7",
    kind: "draft",
    channel: "sms",
    text: "Hi Alex,\n\nThere's $1,000.00 still outstanding.\n\nCheers,\nShaun",
    why: "Day 7. The client was friendly on the last call.",
    proposed_category: null,
    agent_version: "debt-ws-playbook/v1",
  };
  const first = await call(deps, "debt_ws_agent_submit", SERVER, draft);
  assertEquals(first.status, 200);
  const flag = await call(deps, "debt_ws_agent_submit", SERVER, {
    ...draft,
    kind: "flag",
    channel: null,
    text: "Client says the gate latch is loose",
  });
  assertEquals(flag.status, 200);
  const second = await call(deps, "debt_ws_agent_submit", SERVER, {
    ...draft,
    text: "Hi Alex, second.\n\nCheers,\nShaun",
  });
  const statuses = store.suggestionRows.map((s) => [s.kind, s.status]);
  assertEquals(statuses, [["draft", "superseded"], ["flag", "pending"], [
    "draft",
    "pending",
  ]]);
  assertEquals(store.suggestionRows[2].agent_version, "debt-ws-playbook/v1");
  assertEquals(store.suggestionRows[2].source, "agent");
  assertEquals(store.suggestionRows[2].cycle_start, "2026-10-01");
  assertEquals((second.body as any).auto_send, { attempted: false });
  assertEquals(store.logRows.filter((l) => l.kind === "agent_flag").length, 1);
  assertEquals(
    store.logRows.find((l) => l.kind === "agent_flag")!.created_by_name,
    "agent",
  );
  // A move supersedes the draft but keeps the flag.
  await call(deps, "debt_ws_agent_submit", SERVER, {
    ...draft,
    kind: "move",
    step: "reply_says_paid",
    proposed_category: "says_paid",
    text: "Thanks Alex! It hasn't shown up our end yet.\n\nCheers,\nShaun",
    why: 'Client wrote "paid it yesterday".',
  });
  assertEquals(store.suggestionRows.map((s) => s.status), [
    "superseded",
    "pending",
    "superseded",
    "pending",
  ]);
  assert(
    store.stateRows.find((s) => s.share_key === IDS.final)!.agent_reviewed_at,
  );

  // no_action: no suggestion, only the stamp.
  const before = store.suggestionRows.length;
  const none = await call(deps, "debt_ws_agent_submit", SERVER, {
    xero_invoice_id: IDS.progress,
    step: "d7",
    kind: "no_action",
    channel: null,
    text: "",
    why: "Nothing to do",
    proposed_category: null,
    agent_version: "debt-ws-playbook/v1",
  });
  assertEquals(none.status, 200);
  assertEquals(store.suggestionRows.length, before);
  assert(
    store.stateRows.find((s) => s.share_key === IDS.progress)!
      .agent_reviewed_at,
  );
  // Both items are handled: the queue is empty.
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  assertEquals(q.items, []);
  assertEquals(rec.sms.length, 0);
});

Deno.test("agent submit: refuses bad shapes, banned words, steps not due and company invoices", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const draft = {
    xero_invoice_id: IDS.final,
    step: "d7",
    kind: "draft",
    channel: "sms",
    text: "Hi Alex, pay now.\n\nCheers,\nShaun",
    why: "Day 7",
    proposed_category: null,
    agent_version: "debt-ws-playbook/v1",
  };
  const code = async (over: Record<string, unknown>) =>
    (await call(deps, "debt_ws_agent_submit", SERVER, { ...draft, ...over }))
      .body.code;
  assertEquals(await code({ kind: "nudge" }), "debt_ws_bad_request");
  assertEquals(await code({ step: "d3" }), "step_not_due");
  assertEquals(await code({ channel: "email" }), "debt_ws_bad_request");
  assertEquals(
    await code({ text: "We will hand this to a debt collector" }),
    "text_not_allowed",
  );
  assertEquals(await code({ why: "Long \u2014 dash" }), "text_not_allowed");
  assertEquals(await code({ why: "" }), "debt_ws_bad_request");
  assertEquals(
    await code({ proposed_category: "says_paid" }),
    "debt_ws_bad_request",
  );
  assertEquals(
    await code({ kind: "move", step: "d7", proposed_category: "says_paid" }),
    "debt_ws_bad_request",
  );
  assertEquals(
    await code({
      kind: "move",
      step: "reply_promise",
      proposed_category: "bad_debt",
    }),
    "debt_ws_bad_request",
  );
  assertEquals(await code({ kind: "flag", text: "" }), "debt_ws_bad_request");
  assertEquals(
    await code({ xero_invoice_id: IDS.account }),
    "debt_ws_bad_request",
  );
  assertEquals(await code({ xero_invoice_id: IDS.goAhead }), "not_in_book");
  assertEquals(await code({ surprise: true }), "debt_ws_bad_request");
  assertEquals(store.suggestionRows.length, 0);
});

Deno.test("agent queue: new evidence after the last review brings an item back", async () => {
  const store = new FakeStore();
  store.settingsRow.agent_enabled = true;
  const { deps } = fakeDeps(store);
  for (const id of [IDS.final, IDS.progress, IDS.janFinal]) {
    await store.upsertState(id, { agent_reviewed_at: "2026-10-08T01:00:00Z" });
  }
  assertEquals(
    ((await call(deps, "debt_ws_agent_queue", SERVER)).body as any).items,
    [],
  );
  store.evidence.push({
    job_id: JOBS.janFence,
    at: "2026-10-08T01:30:00Z",
    event_type: "client.reply",
  });
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  assertEquals(q.items.map((i: any) => i.row.xero_invoice_id), [IDS.janFinal]);
  assertEquals(q.items[0].queued_because, {
    step_due_without_suggestion: false,
    new_evidence: true,
  });
  assertEquals(q.items[0].template_draft, null);
});

Deno.test("auto-send: off by default; runs the same guarded send only when every switch is on", async () => {
  const draft = {
    xero_invoice_id: IDS.final,
    step: "d7",
    kind: "draft",
    channel: "sms",
    text: "Hi Alex,\n\nThere's $1,000.00 still outstanding.\n\nCheers,\nShaun",
    why: "Day 7",
    proposed_category: null,
    agent_version: "debt-ws-playbook/v1",
  };
  // Step switched on and sending on, but env DEBT_WS_AUTO_SEND_ENABLED unset.
  const store = new FakeStore();
  store.settingsRow.auto_send_steps = { d7: true };
  const { deps, rec } = fakeDeps(store, { env: sendingOn(store) });
  const off = await call(deps, "debt_ws_agent_submit", SERVER, draft);
  assertEquals((off.body as any).auto_send, { attempted: false });
  assertEquals(rec.sms.length, 0);

  // Everything on but a possible payment: not attempted.
  const store2 = new FakeStore();
  store2.settingsRow.auto_send_steps = { d7: true };
  store2.settingsRow.sending_enabled = true;
  const env = { ...ON, DEBT_WS_AUTO_SEND_ENABLED: "true" };
  const { deps: d2, rec: r2 } = fakeDeps(store2, {
    env,
    bank: [{
      bank_transaction_id: "b0000000-0000-4000-8000-000000000001",
      type: "RECEIVE",
      date: "2026-10-06",
      total: 1000,
      reference: null,
      contact_name: "A Sample",
      line_item_descriptions: [],
    }],
  });
  const held = await call(d2, "debt_ws_agent_submit", SERVER, draft);
  assertEquals((held.body as any).auto_send, {
    attempted: false,
    reason: "possible_payment",
  });
  assertEquals(r2.sms.length, 0);

  // Everything on: sent as agent-auto through the guarded path.
  const store3 = new FakeStore();
  store3.settingsRow.auto_send_steps = { d7: true };
  store3.settingsRow.sending_enabled = true;
  const { deps: d3, rec: r3 } = fakeDeps(store3, { env });
  const sent = await call(d3, "debt_ws_agent_submit", SERVER, draft);
  assertEquals((sent.body as any).auto_send.sent, true);
  assertEquals(r3.sms.length, 1);
  assertEquals(r3.liveReads, [IDS.final]);
  assertEquals(store3.sendRows[0].actor, "agent-auto");
  assertEquals(
    store3.logRows.find((l) => l.kind === "text_sent")!.created_by_name,
    "agent-auto",
  );
  assertEquals(store3.suggestionRows[0].status, "sent");

  // A step not switched on is never auto-sent.
  const store4 = new FakeStore();
  store4.settingsRow.auto_send_steps = { d3: true };
  store4.settingsRow.sending_enabled = true;
  const { deps: d4, rec: r4 } = fakeDeps(store4, { env });
  await call(d4, "debt_ws_agent_submit", SERVER, draft);
  assertEquals(r4.sms.length, 0);
});
