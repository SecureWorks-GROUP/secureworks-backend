// deno-lint-ignore-file no-import-prefix no-explicit-any
// The debt report (debt_ws_report.ts, and the four report actions in debt_ws_actions.ts)
// over the in-memory store and recorded sends in debt_ws_test_fakes.ts. Synthetic fixture:
// today is Thursday 8 October 2026, Perth. Nothing here reaches Xero, email or a database.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetDebtWsBankCacheForTest,
  DEBT_WS_ACTIONS,
  DEBT_WS_REPORT_MAX_COPY_AGE_MS,
  reportAddressesInternal,
  reportCopyProblem,
  runDebtWsAction,
} from "./debt_ws_actions.ts";
import {
  fakeDeps,
  FakeStore,
  IDS,
  NOW,
  SERVER,
  SHAUN,
  STAFF,
} from "./debt_ws_test_fakes.ts";
import { categoryTotals, loadBook } from "./debt_ws_book.ts";
import {
  bankGroup,
  type DebtReport,
  debtReportEmail,
  debtReportHtml,
  REPORT_BUCKETS,
} from "./debt_ws_report.ts";

type Deps = ReturnType<typeof fakeDeps>["deps"];

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

const cents = (n: number) => Math.round(n * 100);
const LONG_DASH_OR_EMOJI = /[\u2013\u2014]|\p{Extended_Pictographic}/u;

async function report(store = new FakeStore(), options = {}) {
  const { deps, rec } = fakeDeps(store, options);
  const res = await call(deps, "debt_ws_report", STAFF);
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return { body: res.body as any, report: (res.body as any).report as DebtReport, rec, store, deps };
}

// ── The figures ──

Deno.test("report: every open invoice lands in exactly one bucket, and the buckets tie to Xero's open total to the cent", async () => {
  const { report: r } = await report();
  const open = new FakeStore().invoices.filter((i) =>
    i.status === "AUTHORISED" && Number(i.amount_due) > 0
  );
  const xero = open.reduce((s, i) => s + cents(Number(i.amount_due)), 0) / 100;
  assertEquals(r.xero_open, { count: open.length, amount: xero });
  assertEquals(r.tie.ok, true);
  assertEquals(r.tie.sum, xero);
  assertEquals(r.tie.unplaced, []);
  const rows = r.sections.flatMap((s) => s.rows);
  assertEquals(rows.length, open.length);
  assertEquals(new Set(rows.map((x) => x.xero_invoice_id)).size, open.length);
});

Deno.test("report: the debt categories are the tab's own, with the not-chased contacts left out as the tab's chart does", async () => {
  const store = new FakeStore();
  const { report: r } = await report(store);
  assertEquals(r.buckets.active, { count: 1, amount: 1000 });
  assertEquals(r.buckets.escalating, { count: 1, amount: 2000 });
  assertEquals(r.buckets.bad_debt, { count: 2, amount: 1080 }); // MLB day 27, Robin day 30
  assertEquals(r.debt.count, 4);
  assertEquals(r.debt.amount, 4080);
  // Not counted as debt.
  assertEquals(r.buckets.not_due, { count: 1, amount: 440 });
  assertEquals(r.buckets.go_ahead, { count: 1, amount: 5000 });
  assertEquals(r.buckets.needs_a_look, { count: 1, amount: 50 });
  assertEquals(r.buckets.not_chased, { count: 1, amount: 561 });
  assert(r.not_chased_names.includes("Builderwest"));
  // The same book, worked out the tab's way, gives the same category totals.
  const book = await loadBook(store, { now: NOW });
  const tab = categoryTotals(book.entries.filter((e) => e.open && !e.notChased));
  for (const b of REPORT_BUCKETS.filter((x) => x.debt)) {
    assertEquals(r.buckets[b.key], (tab as any)[b.key], b.key);
  }
  assertEquals(r.tie.tab_match, true);
});

Deno.test("report: a SAMPLE- test invoice is listed as ignored and still ties to Xero", async () => {
  const store = new FakeStore();
  store.invoices.push({
    ...store.invoices[0],
    xero_invoice_id: "10000000-0000-4000-8000-0000000000ee",
    invoice_number: "INV-TEST",
    reference: "SAMPLE-1",
    amount_due: 352,
    total: 352,
  });
  const { report: r } = await report(store);
  assertEquals(r.buckets.excluded, { count: 1, amount: 352 });
  assertEquals(r.tie.ok, true);
  assertEquals(r.xero_open.amount, 10131 + 352);
});

Deno.test("report: cash at bank per Xero account, grouped, with provisions set aside", async () => {
  const { report: r } = await report();
  assertEquals(r.bank.status, "ok");
  assertEquals(r.bank.total, 108266.51);
  assertEquals(r.bank.operations, 60444.05);
  assertEquals(r.bank.provisions, 43590.14);
  // An account Xero gave no figure for is left out, never read as zero.
  assertEquals(r.bank.accounts.map((a) => a.name), [
    "Operations",
    "GST Provision",
    "PAYGO",
    "Cash Reserve",
  ]);
  assertEquals(bankGroup("Super Provision"), "Provisions (set aside)");
  assertEquals(bankGroup("Westpac AU 0362"), "Other accounts");
});

Deno.test("report: Xero down for the bank balances still gives the report, saying so", async () => {
  const { report: r, body } = await report(new FakeStore(), {
    bankSummary: new Error("xero down"),
  });
  assertEquals(r.bank.status, "unavailable");
  assertStringIncludes(body.html, "could not be read for the bank balances");
  assertEquals(r.tie.ok, true);
});

Deno.test("report: money received in the last 7 and 30 days, split fencing and patio, with deposits", async () => {
  const { report: r } = await report();
  assertEquals(r.received.status, "ok");
  assertEquals(r.received.d7.from, "2026-10-02");
  assertEquals(r.received.d7.amount, 1700);
  assertEquals(r.received.d7.count, 2);
  assertEquals(r.received.d7.fencing_patio, 1700);
  assertEquals(r.received.d7.deposits, 800);
  assertEquals(r.received.d30.from, "2026-09-09");
  assertEquals(r.received.d30.amount, 2030);
  assertEquals(r.received.d30.other, 330);
});

Deno.test("report: debt expected in the next 7 and 30 days comes from not-due invoices by the tab's due dates", async () => {
  const { report: r } = await report();
  // MLB INV-2008, dated 5 Oct: due 15 Oct (company terms, 10 days).
  assertEquals(r.expected.d7, { count: 1, amount: 440 });
  assertEquals(r.expected.d30, { count: 1, amount: 440 });
});

Deno.test("report: companies after aliases, with this week's statement status; top debtors; possible payments", async () => {
  const store = new FakeStore();
  const { report: r } = await report(store, {
    bank: [{
      bank_transaction_id: "bt1",
      type: "RECEIVE",
      date: "2026-10-07",
      total: 1000,
      reference: "INV-2001",
      contact_name: "A Sample",
      line_item_descriptions: [],
    }, {
      bank_transaction_id: "bt2",
      type: "RECEIVE-TRANSFER",
      date: "2026-10-07",
      total: 5000,
      reference: "transfer",
      contact_name: null,
      line_item_descriptions: [],
    }],
  });
  const mlb = r.companies.find((c) => c.name === "Major Loss Builders")!;
  assertEquals(mlb.past, { count: 1, amount: 330, oldest: 27 });
  assertEquals(mlb.grace.count, 1);
  assertEquals(mlb.grace.next_due, "2026-10-15");
  assertEquals(mlb.statement, "ready");
  const bw = r.companies.find((c) => c.name === "Builderwest Pty Ltd")!;
  assertEquals(bw.statement, "not_chased");
  assertEquals(r.top_debtors[0].name, "Casey Example");
  assertEquals(r.top_debtors.length, 4);
  assertEquals(r.top_total, 4080);
  assertEquals(r.bank_feed.receipts, { count: 1, amount: 1000 });
  assertEquals(r.bank_feed.transfers, { count: 1, amount: 5000 });
  assertEquals(r.bank_feed.matches.map((m) => m.invoice_number), ["INV-2001"]);
  assert(r.key_points.some((k) => k.includes("may already be paid")));
});

Deno.test("report: every invoice row carries the payer, job, type, invoice, date, amount, days, next step and last chase", async () => {
  const store = new FakeStore();
  store.logRows.push({
    id: "l1",
    share_key: IDS.final,
    xero_invoice_ids: [IDS.final],
    job_id: null,
    kind: "text_sent",
    step: "d3",
    body: "Hi Alex",
    meta: {},
    created_by: null,
    created_by_name: "Shaun",
    created_at: "2026-10-04T01:00:00Z",
  });
  const { report: r } = await report(store);
  const active = r.sections.find((s) => s.key === "active")!;
  const row = active.rows[0];
  assertEquals(row.invoice_number, "INV-2001");
  assertEquals(row.payer, "Alex Sample");
  assertEquals(row.job_number, "SWF-90001");
  assertEquals(row.job_type, "Fencing");
  assertEquals(row.days, 7);
  assertEquals(row.chase, "4 Oct 26 Texted (d3)");
  assertStringIncludes(row.next, "Day 7");
  // Worst first: the sections run bad debt, escalating, active, then not counted as debt.
  assertEquals(r.sections.map((s) => s.key), [
    "bad_debt",
    "escalating",
    "active",
    "not_due",
    "go_ahead",
    "needs_a_look",
    "not_chased",
  ]);
  // The neighbour share on a fence reads "Robin Next (neighbour of Taylor Main)".
  const robin = r.sections[0].rows.find((x) => x.invoice_number === "INV-2006")!;
  assertEquals(robin.payer, "Robin Next (neighbour of Taylor Main)");
  assertStringIncludes(robin.next, "Jan's visit list");
});

Deno.test("report: the HTML, the notes and the email carry no long dash and no emoji, and name the tie", async () => {
  const { body, report: r } = await report();
  assert(!LONG_DASH_OR_EMOJI.test(body.html), "the HTML has a long dash or emoji");
  assert(!LONG_DASH_OR_EMOJI.test(JSON.stringify(r)), "the data has a long dash or emoji");
  assertStringIncludes(body.html, "Debt position");
  assertStringIncludes(body.html, "to the cent");
  assertStringIncludes(body.html, "Not counted as debt");
  assertEquals(debtReportHtml(r), body.html);
  const email = debtReportEmail(r, { greeting: "Marnin", sentBy: "Shaun" });
  assertEquals(email.subject, "Debt position: Thursday the 8th of October 2026");
  assertStringIncludes(email.html, "Hi Marnin,");
  assertStringIncludes(email.html, "attached as a PDF");
  assertStringIncludes(email.html, "suppress-auto-appended-default-signature");
  assert(!LONG_DASH_OR_EMOJI.test(email.html + email.text));
});

Deno.test("report: who it goes to, who can send, and the last send are on the view", async () => {
  const store = new FakeStore();
  const { body } = await report(store);
  assertEquals(body.delivery.from, "admin@secureworkswa.com.au");
  assertEquals(body.delivery.to, ["marnin@secureworkswa.com.au"]);
  assertEquals(body.delivery.cc, ["shaun@secureworkswa.com.au"]);
  assertEquals(body.delivery.auto_send, false);
  // Staff can read it but not send it; sending is off in the fixture too.
  assertEquals(body.delivery.viewer_is_owner, false);
  assertEquals(body.delivery.can_send, false);
  assertEquals(body.last_sent, null);
  // The owner, with sending on.
  store.settingsRow.sending_enabled = true;
  const { deps } = fakeDeps(store);
  const owner = (await call(deps, "debt_ws_report", SHAUN)).body as any;
  assertEquals(owner.delivery.can_send, true);
  assertEquals(owner.delivery.why_not, null);
});

Deno.test("report: still reads before the report migration is applied (the report settings unreadable)", async () => {
  const store = new FakeStore();
  store.reportReadsFail = true;
  const { body, report: r } = await report(store);
  assertEquals(r.received.status, "unavailable");
  assertEquals(body.delivery.can_send, false);
  assertEquals(body.last_sent, null);
});

Deno.test("report pdf: staff can download it; the bytes come back as base64 with a dated file name", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_report_pdf", STAFF);
  assertEquals(res.status, 200);
  const b = res.body as any;
  assertEquals(b.filename, "Debt position 2026-10-08.pdf");
  assertEquals(b.content_type, "application/pdf");
  assertStringIncludes(atob(b.pdf_base64), "%PDF");
  assertEquals(rec.pdfs, 1);
  assertEquals(rec.emails.length, 0);
  const { deps: broken } = fakeDeps(store, { pdfError: new Error("jspdf") });
  const fail = await call(broken, "debt_ws_report_pdf", STAFF);
  assertEquals(fail.status, 502);
  assertEquals((fail.body as any).code, "report_pdf_failed");
});

// ── Sending ──

Deno.test("send: only the owner, only with sending on; nothing goes otherwise", async () => {
  const store = new FakeStore();
  const { deps, rec } = fakeDeps(store);
  const staff = await call(deps, "debt_ws_report_send", STAFF);
  assertEquals(staff.status, 403);
  assertEquals((staff.body as any).code, "not_owner");
  const server = await call(deps, "debt_ws_report_send", SERVER);
  assertEquals(server.status, 403);
  const off = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(off.status, 409);
  assertEquals((off.body as any).code, "sending_off");
  assertEquals(rec.emails.length, 0);
  assertEquals(store.reportRows.length, 0);
  assert(store.logRows.some((l) => l.kind === "send_refused" && l.share_key === "debt-report"));
  const extra = await call(deps, "debt_ws_report_send", SHAUN, { to: "x@example.com" });
  assertEquals(extra.status, 400);
});

Deno.test("send: emails the PDF from admin@ to Marnin, cc Shaun, marked internal, and keeps a copy and a log line", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(res.status, 200, JSON.stringify(res.body));
  const b = res.body as any;
  assertEquals(b.sent, true);
  assertEquals(rec.emails.length, 1);
  const email = rec.emails[0];
  assertEquals(email.from, "admin@secureworkswa.com.au");
  assertEquals(email.to, "marnin@secureworkswa.com.au");
  assertEquals(email.cc, ["shaun@secureworkswa.com.au"]);
  assertEquals(email.internal_report, "debt_report");
  assertEquals(email.attachments?.length, 1);
  assertEquals(email.attachments![0].name, "Debt position 2026-10-08.pdf");
  assertEquals(email.attachments![0].contentType, "application/pdf");
  assertStringIncludes(atob(email.attachments![0].contentBytes), "%PDF");
  assertStringIncludes(email.htmlBody, "Hi Marnin,");
  // The copy.
  assertEquals(store.reportRows.length, 1);
  const row = store.reportRows[0] as any;
  assertEquals(row.status, "sent");
  assertEquals(row.kind, "manual");
  assertEquals(row.sent_by_name, "Shaun");
  assert(String(row.html).startsWith("<!doctype html>"));
  assertEquals(row.pdf_base64, email.attachments![0].contentBytes);
  assertEquals(String(row.pdf_sha256).length, 64);
  assertEquals(row.totals.debt, { count: 4, amount: 4080 });
  // The log line on the workshop log.
  const line = store.logRows.find((l) => l.kind === "email_sent" && l.share_key === "debt-report");
  assert(line, "no log line");
  // "Last sent" now shows on the view.
  const view = (await call(deps, "debt_ws_report", SHAUN)).body as any;
  assertEquals(view.last_sent.status, "sent");
  assertEquals(view.last_sent.to, ["marnin@secureworkswa.com.au"]);
  assertEquals(view.last_sent.by, "Shaun");
});

Deno.test("send: a second click within two minutes is refused; after that it can go again", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store);
  assertEquals((await call(deps, "debt_ws_report_send", SHAUN)).status, 200);
  const again = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(again.status, 409);
  assertEquals((again.body as any).code, "recently_sent");
  assertEquals(rec.emails.length, 1);
  const later = new Date(NOW.getTime() + 3 * 60_000);
  const { deps: d2, rec: r2 } = fakeDeps(store, { now: later });
  assertEquals((await call(d2, "debt_ws_report_send", SHAUN)).status, 200);
  assertEquals(r2.emails.length, 1);
});

Deno.test("send: our own domain only; an outside address in the settings refuses before anything is built", async () => {
  assertEquals(reportAddressesInternal(["marnin@secureworkswa.com.au"]), true);
  assertEquals(reportAddressesInternal(["marnin@secureworkswa.com.au.evil.test"]), false);
  assertEquals(reportAddressesInternal(["someone@example.com"]), false);
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  store.reportSettingsRow.cc = ["boss@example.com"];
  const { deps, rec } = fakeDeps(store);
  const res = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(res.status, 409);
  assertEquals((res.body as any).code, "recipient_not_internal");
  assertEquals(rec.emails.length, 0);
  assertEquals(rec.pdfs, 0);
  store.reportSettingsRow = { recipients: [], cc: [], auto_send: false };
  const none = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals((none.body as any).code, "no_recipients");
});

Deno.test("send: a refused email keeps the copy as failed; an unconfirmed one stays claimed", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const { deps } = fakeDeps(store, {
    emailResult: { ok: false, status: 409, error: "fence" },
  });
  const res = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(res.status, 502);
  assertEquals((res.body as any).code, "email_failed");
  assertEquals(store.reportRows[0].status, "failed");
  const s2 = new FakeStore();
  s2.settingsRow.sending_enabled = true;
  const { deps: d2 } = fakeDeps(s2, { emailError: new Error("timeout") });
  const unsure = await call(d2, "debt_ws_report_send", SHAUN);
  assertEquals((unsure.body as any).code, "send_not_confirmed");
  assertEquals(s2.reportRows[0].status, "sending");
  // While it is unconfirmed, a second click inside two minutes is still refused.
  const again = await call(d2, "debt_ws_report_send", SHAUN);
  assertEquals((again.body as any).code, "recently_sent");
});

Deno.test("send: a PDF that cannot be drawn sends nothing and releases the claim", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store, { pdfError: new Error("jspdf") });
  const res = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(res.status, 502);
  assertEquals((res.body as any).code, "report_pdf_failed");
  assertEquals(rec.emails.length, 0);
  assertEquals(store.reportRows[0].status, "failed");
});

// ── Consolidate first: the copy of the debt must be fresh ──

Deno.test("fresh copy: a sync up to 20 minutes old is fresh; older, or unknown, is refused", () => {
  const now = new Date("2026-10-14T04:00:00Z"); // Wednesday 14 Oct, 12:00 Perth
  assertEquals(reportCopyProblem("2026-10-14T03:55:00Z", now), null);
  assertEquals(reportCopyProblem("2026-10-14T03:40:00Z", now), null);
  assertEquals(DEBT_WS_REPORT_MAX_COPY_AGE_MS, 20 * 60_000);
  const stale = reportCopyProblem("2026-10-14T03:39:00Z", now);
  assertStringIncludes(String(stale), "last synced at 11:39am Perth time, more than 20 minutes ago");
  const yesterday = reportCopyProblem("2026-10-13T03:39:00Z", now);
  assertStringIncludes(String(yesterday), "11:39am Perth time on Tuesday the 13th of October");
  assertStringIncludes(String(reportCopyProblem(null, now)), "is unknown");
  assertStringIncludes(String(reportCopyProblem("not a date", now)), "is unknown");
  for (const text of [stale, yesterday]) assert(!LONG_DASH_OR_EMOJI.test(String(text)));
});

Deno.test("fresh copy: a stale copy refuses a manual send, draws no PDF, and says why on the view", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  store.syncedAt = "2026-10-08T01:30:00Z"; // 30 minutes before NOW
  const { deps, rec } = fakeDeps(store);
  const view = (await call(deps, "debt_ws_report", SHAUN)).body as any;
  assertEquals(view.delivery.can_send, false);
  assertStringIncludes(view.delivery.why_not, "more than 20 minutes ago");
  const res = await call(deps, "debt_ws_report_send", SHAUN);
  assertEquals(res.status, 409);
  assertEquals((res.body as any).code, "xero_copy_stale");
  assertEquals(rec.emails.length, 0);
  assertEquals(rec.pdfs, 0);
  assertEquals(store.reportRows.length, 1);
  assertEquals(store.reportRows[0].status, "refused");
  assertStringIncludes(String(store.reportRows[0].error), "xero copy not fresh");
  assert(store.logRows.some((l) =>
    l.kind === "send_refused" && l.share_key === "debt-report" &&
    (l.meta as any)?.code === "xero_copy_stale"
  ));
  // An unknown sync time is refused the same way.
  const s2 = new FakeStore();
  s2.settingsRow.sending_enabled = true;
  s2.syncedAt = null;
  const { deps: d2, rec: r2 } = fakeDeps(s2);
  assertEquals(((await call(d2, "debt_ws_report_send", SHAUN)).body as any).code, "xero_copy_stale");
  assertEquals(r2.emails.length, 0);
});

// ── The Wednesday 12pm auto-send ──

Deno.test("auto: does nothing while report_auto_send is off (the default), or while sending is off", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store);
  const off = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals(off.status, 200);
  assertEquals((off.body as any).sent, false);
  assertEquals((off.body as any).reason, "auto_send_off");
  store.reportSettingsRow.auto_send = true;
  store.settingsRow.sending_enabled = false;
  const noSend = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals((noSend.body as any).reason, "sending_off");
  assertEquals(rec.emails.length, 0);
  assertEquals(store.reportRows.length, 0);
  // Only the server key runs it.
  assertEquals((await call(deps, "debt_ws_report_auto", SHAUN)).status, 403);
});

Deno.test("auto: when switched on it sends once a week, as the Wednesday 12pm auto-send", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  store.reportSettingsRow.auto_send = true;
  const { deps, rec } = fakeDeps(store);
  const first = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals((first.body as any).sent, true);
  assertEquals(rec.emails.length, 1);
  assertStringIncludes(rec.emails[0].htmlBody, "the Wednesday 12pm auto-send");
  assertEquals(store.reportRows[0].kind, "auto");
  assertEquals(store.reportRows[0].week_start, "2026-10-05");
  const second = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals((second.body as any).sent, false);
  assertEquals((second.body as any).reason, "already_sent");
  assertEquals(rec.emails.length, 1);
});

Deno.test("auto: at Wednesday 12:00 Perth it reads the copy synced at 11:55 and files the week from Monday", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  store.reportSettingsRow.auto_send = true;
  store.syncedAt = "2026-10-07T03:55:01Z"; // the 11:55 refresh
  const wednesdayNoon = new Date("2026-10-07T04:00:00Z");
  store.clock = () => wednesdayNoon;
  const { deps, rec } = fakeDeps(store, { now: wednesdayNoon });
  const res = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals((res.body as any).sent, true, JSON.stringify(res.body));
  assertEquals(rec.emails.length, 1);
  assertEquals(store.reportRows[0].week_start, "2026-10-05");
  assertEquals(store.reportRows[0].sent_by_name, "the Wednesday 12pm auto-send");
  assertEquals(store.reportRows[0].status, "sent");
});

Deno.test("auto: a stale copy at 12:00 sends nothing and is recorded as refused, without taking the week", async () => {
  const store = new FakeStore();
  store.settingsRow.sending_enabled = true;
  store.reportSettingsRow.auto_send = true;
  store.syncedAt = "2026-10-07T03:19:00Z"; // the 11:55 refresh and the 11:49 sync both missed
  const wednesdayNoon = new Date("2026-10-07T04:00:00Z");
  store.clock = () => wednesdayNoon;
  const { deps, rec } = fakeDeps(store, { now: wednesdayNoon });
  const res = await call(deps, "debt_ws_report_auto", SERVER);
  assertEquals(res.status, 409);
  assertEquals((res.body as any).code, "xero_copy_stale");
  assertEquals(rec.emails.length, 0);
  assertEquals(rec.pdfs, 0);
  assertEquals(store.reportRows.length, 1);
  assertEquals(store.reportRows[0].kind, "auto");
  assertEquals(store.reportRows[0].status, "refused");
  // The refused row does not hold the week: once the copy is fresh the auto send can go.
  store.syncedAt = "2026-10-07T04:04:00Z";
  const later = new Date("2026-10-07T04:10:00Z");
  store.clock = () => later;
  const { deps: d2, rec: r2 } = fakeDeps(store, { now: later });
  const again = await call(d2, "debt_ws_report_auto", SERVER);
  assertEquals((again.body as any).sent, true, JSON.stringify(again.body));
  assertEquals(r2.emails.length, 1);
});

// ── Total owed to us (Shaun approved 20 Oct 2026) ──

function mirrorRow(over: Record<string, unknown> = {}) {
  return {
    checked_at: "2026-10-08T01:30:00Z",
    complete: true,
    matches: true,
    xero_count: 8,
    xero_total: 10131,
    copy_count: 8,
    copy_total: 10131,
    differ_count: 0,
    differences: [],
    drafts_count: 2,
    drafts_total: 1500,
    error: null,
    ...over,
  } as any;
}

async function overview(store = new FakeStore()) {
  const { deps } = fakeDeps(store);
  const res = await call(deps, "debt_ws_overview", STAFF);
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return res.body as any;
}

Deno.test("total owed: every open invoice, and the lines add up to it to the cent", async () => {
  const ov = await overview();
  const t = ov.total_owed;
  assertEquals(t.count, 8);
  assertEquals(t.amount, 10131);
  assertEquals(t.adds_up, true);
  const line = (k: string) => t.lines.find((l: any) => l.key === k);
  assertEquals(t.lines.map((l: any) => l.key), [
    "debt",
    "not_due",
    "progress",
    "companies",
    "deposits",
    "not_chased",
    "needs_a_look",
  ]);
  // Debt is the chart's figure: the five categories, not-chased left out.
  assertEquals([line("debt").count, line("debt").amount], [4, 4080]);
  const book = await loadBook(new FakeStore(), { now: NOW });
  const tab = categoryTotals(book.entries.filter((e) => e.open && !e.notChased));
  assertEquals(
    cents(line("debt").amount),
    Object.values(tab).reduce((s, x) => s + cents(x.amount), 0),
  );
  // MLB's second make-safe is in grace: a company invoice, not due yet.
  assertEquals([line("companies").count, line("companies").amount], [1, 440]);
  assertEquals(line("companies").invoices[0].invoice_number, "INV-2008");
  assertEquals([line("deposits").count, line("deposits").amount], [1, 5000]);
  assertEquals([line("not_chased").count, line("not_chased").amount], [1, 561]);
  assertStringIncludes(line("not_chased").sub, "Builderwest");
  assertEquals([line("needs_a_look").count, line("needs_a_look").amount], [1, 50]);
  assertEquals([line("not_due").count, line("progress").count], [0, 0]);
  const sum = t.lines.reduce((s: number, l: any) => s + cents(l.amount), 0) / 100;
  assertEquals(sum, t.amount);
  // Each invoice is in exactly one line.
  const ids = t.lines.flatMap((l: any) => l.invoices.map((i: any) => i.xero_invoice_id));
  assertEquals(ids.length, t.count);
  assertEquals(new Set(ids).size, t.count);
});

Deno.test("total owed: not due yet splits by the kind the tab already gives (progress, company, other)", async () => {
  const store = new FakeStore();
  const base = store.invoices.find((i) => i.xero_invoice_id === IDS.progress)!;
  // A progress payment invoiced today: due in 7 days.
  store.invoices.push({
    ...base,
    xero_invoice_id: "10000000-0000-4000-8000-0000000000f1",
    invoice_number: "INV-3001",
    reference: "SWP-90002-PROG25",
    first_description: "Progress (25%)",
    amount_due: 700,
    total: 700,
    invoice_date: "2026-10-08",
  });
  const fin = store.invoices.find((i) => i.xero_invoice_id === IDS.final)!;
  // A final dated tomorrow: not due yet.
  store.invoices.push({
    ...fin,
    xero_invoice_id: "10000000-0000-4000-8000-0000000000f2",
    invoice_number: "INV-3002",
    amount_due: 300,
    total: 300,
    invoice_date: "2026-10-09",
  });
  const t = (await overview(store)).total_owed;
  const line = (k: string) => t.lines.find((l: any) => l.key === k);
  assertEquals(line("progress").invoices.map((i: any) => i.invoice_number), ["INV-3001"]);
  assertEquals(line("not_due").invoices.map((i: any) => i.invoice_number), ["INV-3002"]);
  assertStringIncludes(line("not_due").invoices[0].detail, "Due");
  assertEquals(t.amount, 10131 + 700 + 300);
  assertEquals(t.adds_up, true);
});

Deno.test("total owed: the debt report shows the same total and lines as the Debt tab", async () => {
  const ov = await overview();
  const { report: r } = await report();
  assertEquals(r.total_owed.amount, ov.total_owed.amount);
  assertEquals(
    r.total_owed.lines.map((l) => [l.key, l.count, l.amount]),
    ov.total_owed.lines.map((l: any) => [l.key, l.count, l.amount]),
  );
  assertEquals(r.total_owed.amount, r.xero_open.amount);
  const html = debtReportHtml(r);
  assertStringIncludes(html, "Total owed to us");
  assertStringIncludes(html, "Adds up to total owed to us");
  assert(!LONG_DASH_OR_EMOJI.test(html));
});

Deno.test("xero check: matches, differs (with the invoice numbers), not checked, and unreadable", async () => {
  // None recorded yet.
  let ov = await overview();
  assertEquals(ov.xero_check.status, "not_checked");
  assertEquals(ov.xero_check.words, "Not checked against Xero yet");

  const store = new FakeStore();
  store.mirrorCheckRows = [mirrorRow()];
  ov = await overview(store);
  assertEquals(ov.xero_check.status, "matches");
  assertEquals(ov.xero_check.words, "Matches Xero");
  assertEquals(ov.xero_check.drafts, { count: 2, amount: 1500 });

  store.mirrorCheckRows.push(mirrorRow({
    checked_at: "2026-10-08T01:45:00Z",
    matches: false,
    xero_count: 9,
    xero_total: 11217.48,
    differ_count: 2,
    differences: [
      { invoice_number: "INV-0034", reason: "missing_from_copy", xero_amount_due: 734.48, copy_amount_due: null, copy_status: "DELETED" },
      { invoice_number: "INV-0177", reason: "missing_from_copy", xero_amount_due: 352, copy_amount_due: null, copy_status: "DELETED" },
    ],
  }));
  ov = await overview(store);
  assertEquals(ov.xero_check.status, "differs");
  assertEquals(ov.xero_check.words, "Does not match Xero: 2 invoices differ (INV-0034, INV-0177)");
  assertEquals(ov.xero_check.differences[0].words, "Xero says $734.48 is owed; our copy says deleted");

  // A failed newer attempt is reported, and the last complete answer still stands.
  store.mirrorCheckRows.push(mirrorRow({
    checked_at: "2026-10-08T01:55:00Z",
    complete: false,
    matches: null,
    error: "Xero asked us to wait (rate limit), so the check did not finish",
  }));
  ov = await overview(store);
  assertEquals(ov.xero_check.status, "differs");
  assertEquals(ov.xero_check.last_failed.at, "2026-10-08T01:55:00Z");

  // The table cannot be read: never "Matches Xero", and the tab still loads.
  const broken = new FakeStore();
  broken.mirrorReadFails = true;
  ov = await overview(broken);
  assertEquals(ov.xero_check.status, "not_checked");
  assertEquals(ov.xero_check.words, "Could not read the check against Xero");
  assertEquals(ov.total_owed.amount, 10131);
});

Deno.test("xero check: the report says it under the total, in the notes and in the email", async () => {
  const store = new FakeStore();
  store.mirrorCheckRows = [mirrorRow({
    matches: false,
    differ_count: 1,
    differences: [{ invoice_number: "INV-0704", reason: "missing_from_copy", xero_amount_due: 561, copy_status: "DELETED" }],
  })];
  const { report: r } = await report(store);
  assertEquals(r.xero_check?.status, "differs");
  const html = debtReportHtml(r);
  assertStringIncludes(html, "does not match Xero");
  assertStringIncludes(html, "Does not match Xero: 1 invoice differs (INV-0704)");
  assert(r.key_points.some((k) => k.includes("INV-0704")));
  assert(r.notes.some((n) => n.startsWith("Check against Xero")));
  const mail = debtReportEmail(r, { greeting: "Marnin", sentBy: "Shaun" });
  assertStringIncludes(mail.text, "Check against Xero: Does not match Xero: 1 invoice differs (INV-0704).");
  assertStringIncludes(mail.text, "Total owed to us: $10,131.00 across 8 invoices.");
  assert(!LONG_DASH_OR_EMOJI.test(html + mail.text));
});
