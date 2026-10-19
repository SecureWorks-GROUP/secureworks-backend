// deno-lint-ignore-file no-import-prefix no-explicit-any
// Statement and report emails claim their item before they are sent (debt_report:<org>,
// debt_statement:<company>), and only a named checked press releases an earlier
// unconfirmed send. Each test here failed on c3de7498 (two presses together sent twice, an
// old or automatic send slipped past the hold, or a contradictory answer read as sent).
// Synthetic fixture only; nothing reaches Xero, email or a database.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetDebtWsBankCacheForTest,
  DEBT_WS_ACTIONS,
  debtWsReportSend,
  runDebtWsAction,
} from "./debt_ws_actions.ts";
import {
  fakeDeps,
  FakeStore,
  MLB_CONTACT,
  NOW,
  SERVER,
  SHAUN,
} from "./debt_ws_test_fakes.ts";

type Deps = ReturnType<typeof fakeDeps>["deps"];
type Options = NonNullable<Parameters<typeof fakeDeps>[1]>;

const OK = { ok: true, status: 202, error: null, reply: { success: true, accepted: true, retry_safe: false } };
const MINUTE = 60_000;

async function call(
  deps: Deps,
  action: string,
  caller = SHAUN,
  input: Record<string, unknown> = {},
) {
  const method = DEBT_WS_ACTIONS[action].method;
  _resetDebtWsBankCacheForTest();
  return await runDebtWsAction(
    action,
    method,
    new URLSearchParams(),
    method === "POST" ? input : {},
    caller,
    deps,
  );
}

function setup(options: Options = {}) {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const opts: Options = { ...options };
  const { deps, rec } = fakeDeps(store, opts);
  return { store, deps, rec, opts };
}

/** Moves the send-claim clock on (the database's own clock), where there is one. */
function advanceClaims(store: FakeStore, ms: number) {
  (store as any).claims?.advance?.(ms);
}

/** Lets an email answer only when release() is called. */
function heldEmail(deps: Deps, rec: { emails: unknown[] }) {
  let release!: (v: unknown) => void;
  const gate = new Promise((r) => (release = r));
  deps.sendEmail = (payload) => {
    rec.emails.push(payload);
    return gate.then(() => OK) as any;
  };
  return () => release(null);
}

// ── Reports ──

Deno.test("DR1: two manual report presses together send one email", async () => {
  const { deps, rec } = setup();
  const [a, b] = await Promise.all([
    call(deps, "debt_ws_report_send"),
    call(deps, "debt_ws_report_send"),
  ]);
  assertEquals(rec.emails.length, 1);
  assertEquals([a.status, b.status].sort(), [200, 409]);
});

Deno.test("Codex 3: a manual report not confirmed holds the automatic report", async () => {
  const { store, deps, rec, opts } = setup({ emailError: new Error("timeout") });
  store.reportSettingsRow.auto_send = true;
  const manual = await call(deps, "debt_ws_report_send");
  assertEquals((manual.body as any).code, "send_not_confirmed");
  opts.emailError = undefined;
  opts.now = new Date(NOW.getTime() + 60 * MINUTE);
  const auto = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals((auto.body as any).sent, false);
  assertEquals((auto.body as any).reason, "send_not_confirmed");
  assertEquals(rec.emails.length, 1);
});

Deno.test("Codex 3: an unconfirmed report older than the newest 50 rows still holds", async () => {
  const { store, deps, rec, opts } = setup({ emailError: new Error("timeout") });
  store.clock = () => new Date(NOW.getTime() - 10 * 24 * 60 * MINUTE);
  await call(deps, "debt_ws_report_send");
  for (let i = 0; i < 60; i++) {
    store.reportRows.push({
      id: `filler-${i}`,
      kind: "auto",
      week_start: "2026-09-28",
      status: "sent",
      to_emails: [],
      cc_emails: [],
      subject: null,
      sent_by_name: null,
      error: null,
      created_at: new Date(NOW.getTime() - (5 * 24 * 60 - i) * MINUTE).toISOString(),
      sent_at: null,
    });
  }
  store.clock = () => NOW;
  opts.emailError = undefined;
  const again = await call(deps, "debt_ws_report_send");
  assertEquals((again.body as any).code, "send_not_confirmed");
  assertEquals(rec.emails.length, 1);
});

Deno.test("DR2: two checked report presses together after an unknown send one email", async () => {
  const { deps, rec, opts } = setup({ emailError: new Error("timeout") });
  await call(deps, "debt_ws_report_send");
  opts.emailError = undefined;
  opts.now = new Date(NOW.getTime() + 5 * MINUTE);
  const [a, b] = await Promise.all([
    call(deps, "debt_ws_report_send", SHAUN, { sent_items_checked: true }),
    call(deps, "debt_ws_report_send", SHAUN, { sent_items_checked: true }),
  ]);
  assertEquals(rec.emails.length, 2);
  assertEquals([a.status, b.status].sort(), [200, 409]);
});

Deno.test("Codex 6: a checked report press never releases an automatic report in flight", async () => {
  const { store, deps, rec } = setup();
  store.reportSettingsRow.auto_send = true;
  const release = heldEmail(deps, rec);
  const auto = call(deps, "debt_ws_report_auto", SERVER);
  for (let i = 0; i < 200 && rec.emails.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assertEquals(rec.emails.length, 1);
  const manual = await call(deps, "debt_ws_report_send", SHAUN, { sent_items_checked: true });
  assertEquals(manual.status, 409);
  assertEquals(rec.emails.length, 1);
  assertEquals(store.reportRows.filter((r) => r.status === "failed").length, 0);
  release();
  assertEquals(((await auto).body as any).sent, true);
});

Deno.test("Codex 6: a checked press with no named person is refused and sends nothing", async () => {
  const { deps, rec, opts } = setup({ emailError: new Error("timeout") });
  await call(deps, "debt_ws_report_send");
  opts.emailError = undefined;
  opts.now = new Date(NOW.getTime() + 5 * MINUTE);
  let code = "";
  try {
    await debtWsReportSend(deps, SERVER, { sent_items_checked: true });
  } catch (error) {
    code = (error as any).code;
  }
  assertEquals(code, "send_reconcile_actor_required");
  assertEquals(rec.emails.length, 1);
});

Deno.test("should-fix: an unconfirmed report is reported as uncertain, never 'just sent, wait two minutes'", async () => {
  const { deps, opts } = setup({ emailError: new Error("timeout") });
  await call(deps, "debt_ws_report_send");
  opts.emailError = undefined;
  const again = await call(deps, "debt_ws_report_send");
  assertEquals((again.body as any).code, "send_not_confirmed");
  assert(!/just sent|wait two minutes/i.test(String((again.body as any).error)));
});

// ── Statements ──

Deno.test("DS3: a statement whose settle was lost is held, then released only by a checked press", async () => {
  const { store, deps, rec, opts } = setup({ emailError: new Error("timeout") });
  (store as any).claims?.failNext?.("settle_outbound_send");
  const settle = store.settleStatement.bind(store);
  let lost = false;
  store.settleStatement = (id: string, patch: Record<string, unknown>) => {
    if (!lost) {
      lost = true;
      return Promise.reject(new Error("write lost"));
    }
    return settle(id, patch);
  };
  const first = await call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
  assertEquals((first.body as any).code, "send_not_confirmed");
  assertEquals(store.statementRows[0].status, "sending");
  assertEquals(store.statementRows[0].error, null);
  opts.emailError = undefined;
  // Long after: the press is held, and it never says the statement is being sent now.
  advanceClaims(store, 30 * MINUTE);
  opts.now = new Date(NOW.getTime() + 30 * MINUTE);
  const held = await call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
  assertEquals((held.body as any).code, "send_not_confirmed");
  assert(!/being sent now/i.test(String((held.body as any).error)));
  // A checked press is the way out.
  const checked = await call(deps, "debt_ws_statement_send", SHAUN, {
    company_key: MLB_CONTACT,
    sent_items_checked: true,
  });
  assertEquals(checked.status, 200);
  assertEquals(rec.emails.length, 2);
});

Deno.test("should-fix: an unconfirmed statement last week holds this week's statement to that customer", async () => {
  const { deps, rec, opts } = setup({ emailError: new Error("timeout") });
  const first = await call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
  assertEquals((first.body as any).code, "send_not_confirmed");
  opts.emailError = undefined;
  opts.now = new Date(NOW.getTime() + 7 * 24 * 60 * MINUTE);
  const next = await call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
  assertEquals((next.body as any).code, "send_not_confirmed");
  assertEquals(rec.emails.length, 1);
});

Deno.test("Codex 6: two checked statement presses together after an unknown send one email", async () => {
  const { deps, rec, opts } = setup({ emailError: new Error("timeout") });
  await call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
  opts.emailError = undefined;
  const [a, b] = await Promise.all([
    call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT, sent_items_checked: true }),
    call(deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT, sent_items_checked: true }),
  ]);
  assertEquals(rec.emails.length, 2);
  assertEquals([a.status, b.status].sort(), [200, 409]);
});

// ── What an answer proves (Codex 4 and 5) ──

const UNKNOWN_ANSWERS: Array<[string, Options["emailResult"]]> = [
  ["a 2xx whose body says it failed", { ok: true, status: 200, error: null, reply: { success: false, error: "x" } }],
  ["a 2xx whose body cannot be read", { ok: true, status: 200, error: null, reply: null }],
  ["a bare 403 with no body", { ok: false, status: 403, error: "", reply: null }],
  ["a 400 saying outcomeUnknown", { ok: false, status: 400, error: null, reply: { outcomeUnknown: true, retry_safe: true } }],
  ["a 400 whose error says outcome_unknown", {
    ok: false, status: 400, error: null, reply: { error: { outcome_unknown: true }, retry_safe: true },
  }],
  ["a 400 whose body cannot be read", { ok: false, status: 400, error: "<html>", reply: null }],
];

for (const [name, emailResult] of UNKNOWN_ANSWERS) {
  Deno.test(`Codex 4/5: ${name} is not confirmed, and holds the report and the statement`, async () => {
    const r = setup({ emailResult });
    const report = await call(r.deps, "debt_ws_report_send");
    assertEquals((report.body as any).code, "send_not_confirmed");
    assertEquals((report.body as any).retry_safe, false);
    assertEquals(r.store.reportRows[0].status, "sending");
    const s = setup({ emailResult });
    const statement = await call(s.deps, "debt_ws_statement_send", SHAUN, { company_key: MLB_CONTACT });
    assertEquals((statement.body as any).code, "send_not_confirmed");
    assertEquals(s.store.statementRows[0].status, "sending");
  });
}

Deno.test("Codex 4: a genuine send (202, success: true, retry_safe: false) reads as sent", async () => {
  const { store, deps } = setup({ emailResult: OK });
  const res = await call(deps, "debt_ws_report_send");
  assertEquals(res.status, 200);
  assertEquals(store.reportRows[0].status, "sent");
});

Deno.test("Codex 5: a readable refusal is still a definite failure that frees the item", async () => {
  const { store, deps, rec, opts } = setup({
    emailResult: { ok: false, status: 409, error: "fence", reply: { state: "refused", code: "fence" } },
  });
  const res = await call(deps, "debt_ws_report_send");
  assertEquals((res.body as any).code, "email_failed");
  assertEquals(store.reportRows[0].status, "failed");
  opts.emailResult = OK;
  opts.now = new Date(NOW.getTime() + 5 * MINUTE);
  assertEquals((await call(deps, "debt_ws_report_send")).status, 200);
  assertEquals(rec.emails.length, 2);
});
