// Tests for the finance review email builder + send-ledger decision (M4 U3).
// Wiki issue #112; contract profit-trade-invoice-intelligence-2026-07-03.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFinanceReviewEmail,
  computeFlagSetHash,
  decideLedgerAction,
  FINANCE_REVIEW_INBOX,
  type FlaggedReviewLine,
  xeroDraftBillUrl,
} from "./finance_review_email.ts";

const line = (over: Partial<FlaggedReviewLine> = {}): FlaggedReviewLine => ({
  jobId: "job-1",
  jobNumber: "SWMS-26878",
  clientName: "AJS Building",
  allowedHours: 2,
  source: "rule_default",
  chargedHours: 6,
  justification: "storm damage worse than scoped",
  ...over,
});

// ── Flag-set hash ─────────────────────────────────────────────────────────
Deno.test("computeFlagSetHash is deterministic for the same set", () => {
  const a = computeFlagSetHash([
    line(),
    line({ jobId: "job-2", jobNumber: "SWMS-2" }),
  ]);
  const b = computeFlagSetHash([
    line(),
    line({ jobId: "job-2", jobNumber: "SWMS-2" }),
  ]);
  assertEquals(a, b);
});

Deno.test("computeFlagSetHash is order-independent (line order must not matter)", () => {
  const l1 = line();
  const l2 = line({ jobId: "job-2", jobNumber: "SWMS-2", chargedHours: 4 });
  assertEquals(computeFlagSetHash([l1, l2]), computeFlagSetHash([l2, l1]));
});

Deno.test("computeFlagSetHash changes when charged hours change (a changed flag set)", () => {
  const before = computeFlagSetHash([line({ chargedHours: 6 })]);
  const after = computeFlagSetHash([line({ chargedHours: 8 })]);
  assertEquals(before === after, false);
});

Deno.test("computeFlagSetHash changes when the justification changes", () => {
  const before = computeFlagSetHash([line({ justification: "a" })]);
  const after = computeFlagSetHash([line({ justification: "b" })]);
  assertEquals(before === after, false);
});

Deno.test("computeFlagSetHash changes when allowance/source changes", () => {
  const a = computeFlagSetHash([
    line({ allowedHours: 2, source: "rule_default" }),
  ]);
  const b = computeFlagSetHash([line({ allowedHours: 4, source: "ops_set" })]);
  assertEquals(a === b, false);
});

// ── Email builder: subject + format ───────────────────────────────────────
Deno.test("subject follows the approved template with the flagged-line count", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "SW-INV-JC-260705-001",
    tradeInvoiceId: "ti-1",
    flaggedLines: [line()],
  });
  assertEquals(
    email.subject,
    "Review: trade invoice SW-INV-JC-260705-001 on SWMS-26878 (1 flagged line)",
  );
});

Deno.test("subject pluralises + summarises multiple flagged jobs", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "SW-INV-JC-260705-002",
    tradeInvoiceId: "ti-2",
    flaggedLines: [line(), line({ jobId: "job-2", jobNumber: "SWMS-2" })],
  });
  assertEquals(
    email.subject,
    "Review: trade invoice SW-INV-JC-260705-002 on SWMS-26878 +1 more (2 flagged lines)",
  );
});

Deno.test("update subject is prefixed 'Updated review:'", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "SW-INV-JC-260705-001",
    tradeInvoiceId: "ti-1",
    flaggedLines: [line()],
    isUpdate: true,
  });
  assertEquals(email.subject.startsWith("Updated review: trade invoice"), true);
});

Deno.test("body carries Allowed / source / Charged / justification per the ruling", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "SW-INV-JC-260705-001",
    tradeInvoiceId: "ti-1",
    flaggedLines: [
      line({
        allowedHours: 2,
        source: "rule_default",
        chargedHours: 6,
        justification: "storm worse than scoped",
      }),
    ],
  });
  assertEquals(
    email.text.includes("Allowed: 2 hrs (source: rule default (2hr minimum))"),
    true,
  );
  assertEquals(email.text.includes("Charged: 6 hrs"), true);
  assertEquals(
    email.text.includes("Trade's justification: storm worse than scoped"),
    true,
  );
  assertEquals(email.text.includes("Please review before payment."), true);
});

Deno.test("source label reflects ops_set vs report vs rule_default", () => {
  const ops = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line({ source: "ops_set", allowedHours: 4 })],
  });
  assertEquals(ops.text.includes("source: ops-set expectation"), true);
});

Deno.test("missing justification renders a calm placeholder, not a blank", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line({ justification: null })],
  });
  assertEquals(
    email.text.includes("Trade's justification: no explanation provided"),
    true,
  );
});

Deno.test("tone is calm/routine — no alarm words", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line()],
  });
  const body = (email.text + " " + email.html).toLowerCase();
  for (
    const alarm of [
      "urgent",
      "alert",
      "warning",
      "immediately",
      "overcharge",
      "fraud",
      "!",
    ]
  ) {
    assertEquals(body.includes(alarm), false);
  }
  assertEquals(email.text.includes("routine"), true);
});

Deno.test("one email aggregates every flagged line", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [
      line(),
      line({ jobId: "job-2", jobNumber: "SWMS-2" }),
      line({ jobId: "job-3", jobNumber: "SWMS-3" }),
    ],
  });
  assertEquals(email.flaggedLineCount, 3);
  assertEquals(email.text.includes("SWMS-26878"), true);
  assertEquals(email.text.includes("SWMS-2"), true);
  assertEquals(email.text.includes("SWMS-3"), true);
});

// ── Links ─────────────────────────────────────────────────────────────────
Deno.test("email links the Xero draft bill and the per-job cost report", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line({ jobId: "job-1" })],
    xeroDraftBillUrl: xeroDraftBillUrl("xbill-123"),
    jobCostReportUrls: { "job-1": "https://ops.example/job-cost?job=job-1" },
  });
  assertEquals(
    email.text.includes(
      "https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=xbill-123",
    ),
    true,
  );
  assertEquals(
    email.text.includes("https://ops.example/job-cost?job=job-1"),
    true,
  );
});

Deno.test("xeroDraftBillUrl is null when there is no bill id", () => {
  assertEquals(xeroDraftBillUrl(null), null);
  assertEquals(xeroDraftBillUrl(undefined), null);
});

Deno.test("recipient is the confirmed finance inbox", () => {
  const email = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line()],
  });
  assertEquals(email.recipient, FINANCE_REVIEW_INBOX);
  assertEquals(FINANCE_REVIEW_INBOX, "finance@secureworkswa.com.au");
});

// ── Send-ledger decision (exactly-one + supersede) ────────────────────────
Deno.test("no prior ledger row -> send the first notice", () => {
  const d = decideLedgerAction([], "abc123");
  assertEquals(d.action, "send");
  assertEquals(d.isUpdate, false);
  assertEquals(d.supersedesIds, []);
});

Deno.test("same hash already active -> skip (idempotent double-submit)", () => {
  const d = decideLedgerAction(
    [{ id: "l1", flag_set_hash: "abc123" }],
    "abc123",
  );
  assertEquals(d.action, "skip");
  assertEquals(d.supersedesIds, []);
});

Deno.test("different hash active -> supersede exactly the prior active row(s)", () => {
  const d = decideLedgerAction(
    [{ id: "l1", flag_set_hash: "old111" }],
    "new222",
  );
  assertEquals(d.action, "supersede");
  assertEquals(d.isUpdate, true);
  assertEquals(d.supersedesIds, ["l1"]);
});

Deno.test("supersede collects every stale active row", () => {
  const d = decideLedgerAction(
    [{ id: "l1", flag_set_hash: "old1" }, { id: "l2", flag_set_hash: "old2" }],
    "new",
  );
  assertEquals(d.action, "supersede");
  assertEquals(d.supersedesIds, ["l1", "l2"]);
});

// End-to-end idempotency at the pure level: build -> hash -> decide, twice.
Deno.test("double build with identical flags yields the same hash -> second decision skips", () => {
  const flags = [line()];
  const first = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: flags,
  });
  // After the first send the ledger holds first.flagSetHash. A resubmit with the
  // same flags computes the same hash and must skip.
  const second = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: flags,
  });
  assertEquals(first.flagSetHash, second.flagSetHash);
  const d = decideLedgerAction(
    [{ id: "l1", flag_set_hash: first.flagSetHash }],
    second.flagSetHash,
  );
  assertEquals(d.action, "skip");
});

Deno.test("changed flags -> new hash -> exactly one superseding update", () => {
  const first = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line({ chargedHours: 6 })],
  });
  const second = buildFinanceReviewEmail({
    invoiceNumber: "X",
    tradeInvoiceId: "t",
    flaggedLines: [line({ chargedHours: 9 })],
  });
  assertEquals(first.flagSetHash === second.flagSetHash, false);
  const d = decideLedgerAction(
    [{ id: "l1", flag_set_hash: first.flagSetHash }],
    second.flagSetHash,
  );
  assertEquals(d.action, "supersede");
  assertEquals(d.supersedesIds, ["l1"]);
});
