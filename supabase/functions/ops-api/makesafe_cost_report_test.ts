// Tests for the finance job cost report (M4 U5).
// Wiki issue #112; contract profit-trade-invoice-intelligence-2026-07-03.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allowanceSourceLabel,
  assembleCostReport,
  buildCostReportLink,
  costReportToken,
  costReportUrl,
  renderCostReportError,
  renderCostReportHtml,
  verifyCostReportToken,
  xeroBillUrl,
} from "./makesafe_cost_report.ts";

const SECRET = "test-secret-123";
const JOB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GEN = "2026-06-30T09:00:00.000Z";

// ── Token: round-trip, tamper, wrong-job, empties ──
Deno.test("token: verifies its own token", async () => {
  const t = await costReportToken(JOB, SECRET);
  assert(await verifyCostReportToken(JOB, t, SECRET), "valid token accepted");
});
Deno.test("token: rejects tampered token", async () => {
  const t = await costReportToken(JOB, SECRET);
  const bad = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
  assertEquals(await verifyCostReportToken(JOB, bad, SECRET), false);
});
Deno.test("token: rejects token minted for another job", async () => {
  const t = await costReportToken("other-job", SECRET);
  assertEquals(await verifyCostReportToken(JOB, t, SECRET), false);
});
Deno.test("token: rejects empties and wrong secret", async () => {
  const t = await costReportToken(JOB, SECRET);
  assertEquals(await verifyCostReportToken(JOB, "", SECRET), false);
  assertEquals(await verifyCostReportToken("", t, SECRET), false);
  assertEquals(await verifyCostReportToken(JOB, t, "different-secret"), false);
});
Deno.test("url: builds the openable ops-api link", async () => {
  const t = await costReportToken(JOB, SECRET);
  const u = costReportUrl("https://ref.supabase.co", JOB, t);
  assertStringIncludes(u, "/functions/v1/ops-api?action=makesafe_job_cost_report");
  assertStringIncludes(u, `job_id=${JOB}`);
  assertStringIncludes(u, `token=${t}`);
  const u2 = await buildCostReportLink("https://ref.supabase.co", JOB, SECRET);
  assertEquals(u2, u);
});

// ── Fixtures: v_trade_charge_resolved rows for one job ──
const rawLines = [
  { // flagged over-allowance make-safe line
    line_id: "L1", trade_invoice_id: "INV1", xero_bill_id: "xero-bill-778",
    description: "Make safe - board up", line_type: "make safe",
    total_hours: 3, hourly_rate: 100, line_total_ex: 300,
    baseline_hours: 2, baseline_source: "rule_default",
    flag_type: "hours_over_baseline", hours_justification: "Roof unsafe, extra board-up",
    flagged_at: "2026-06-30T04:00:00Z", is_hours_flagged: true, line_date: "2026-06-30",
    is_probable_test_line: false,
  },
  { // within-allowance make-safe line (baseline set, not flagged)
    line_id: "L2", trade_invoice_id: "INV1", xero_bill_id: "xero-bill-778",
    description: "Make safe - fence prop", line_type: "make safe",
    total_hours: 2, hourly_rate: 100, line_total_ex: 200,
    baseline_hours: 2, baseline_source: "ops_set",
    flag_type: null, hours_justification: null, flagged_at: null,
    is_hours_flagged: false, line_date: "2026-06-30", is_probable_test_line: false,
  },
  { // non-make-safe labour
    line_id: "L3", trade_invoice_id: "INV1", xero_bill_id: "xero-bill-778",
    description: "Patio labour", line_type: "labour",
    total_hours: 5, hourly_rate: 100, line_total_ex: 500,
    baseline_hours: null, baseline_source: null, flag_type: null,
    hours_justification: null, flagged_at: null, is_hours_flagged: false,
    line_date: "2026-06-30", is_probable_test_line: false,
  },
  { // QA/test line — must be excluded
    line_id: "L4", trade_invoice_id: "INV1", xero_bill_id: "xero-bill-778",
    description: "QA TEST make-safe hours - delete", line_type: "make safe",
    total_hours: 9, hourly_rate: 100, line_total_ex: 900,
    baseline_hours: 2, baseline_source: "rule_default",
    flag_type: "hours_over_baseline", hours_justification: "test",
    flagged_at: "2026-06-30T04:00:00Z", is_hours_flagged: true, line_date: "2026-06-30",
    is_probable_test_line: true,
  },
];
const rawJob = { id: JOB, job_number: "SWMS-26671", client_name: "AJ Building", site_address: "12 Test St", site_suburb: "Padbury", type: "makesafe" };
const rawFin = { cost_labour_ex: 1000, cost_materials_ex: 0, cost_commission_ex: 0, cost_other_ex: 0, client_invoiced_ex: 1600, net_margin_ex: 600, margin_pct: 37.5 };
const rawInvoices = [{ id: "INV1", invoice_number: "SW-INV-TT-260630-001", week_start: "2026-06-30", status: "submitted", xero_bill_id: "xero-bill-778" }];

Deno.test("assemble: classifies lines and excludes QA/test", () => {
  const d = assembleCostReport(rawJob, rawLines, rawFin, rawInvoices, GEN);
  assertEquals(d.all_lines.length, 3, "test line excluded");
  assertEquals(d.makesafe_lines.map((l) => l.line_id), ["L1", "L2"], "make-safe lines only (L4 excluded)");
  assertEquals(d.flagged_lines.map((l) => l.line_id), ["L1"], "only the real over-allowance line is flagged");
  assertEquals(d.flagged_lines[0].allowed_hours, 2);
  assertEquals(d.flagged_lines[0].charged_hours, 3);
  assertEquals(d.flagged_lines[0].baseline_source, "rule_default");
  assertEquals(d.flagged_lines[0].hours_justification, "Roof unsafe, extra board-up");
  assertEquals(d.financials?.margin_pct, 37.5);
  assertEquals(d.job.site, "12 Test St, Padbury");
});

Deno.test("render: shows Allowed/Charged/Source/Justification the U3 email lists (reconciliation)", () => {
  const d = assembleCostReport(rawJob, rawLines, rawFin, rawInvoices, GEN);
  const html = renderCostReportHtml(d);
  // The per-flagged-line figures the U3 email reports must all appear on the page.
  assertStringIncludes(html, "2h"); // allowed
  assertStringIncludes(html, "3h"); // charged
  assertStringIncludes(html, allowanceSourceLabel("rule_default")); // source label
  assertStringIncludes(html, "Roof unsafe, extra board-up"); // justification
  assertStringIncludes(html, xeroBillUrl("xero-bill-778")!); // Xero bill link
  assertStringIncludes(html, "SWMS-26671"); // job identity
  assertStringIncludes(html, "SW-INV-TT-260630-001"); // invoice identity
});

Deno.test("render: read-only — no mutation affordances", () => {
  const d = assembleCostReport(rawJob, rawLines, rawFin, rawInvoices, GEN);
  const html = renderCostReportHtml(d).toLowerCase();
  assert(!html.includes("<form"), "no form");
  assert(!html.includes("<button"), "no button");
  assert(!html.includes("<input"), "no input");
  assert(!html.includes("onclick"), "no onclick");
  assert(!html.includes("<script"), "no script");
  assertStringIncludes(html, "read-only");
});

Deno.test("render: no-flags job shows the clear-all message, not an empty table", () => {
  const clean = rawLines.filter((l) => l.line_id === "L2"); // within-allowance only
  const d = assembleCostReport(rawJob, clean, rawFin, rawInvoices, GEN);
  const html = renderCostReportHtml(d);
  assertStringIncludes(html, "No over-allowance flags on this job");
});

Deno.test("render: QA/test line never reaches the page", () => {
  const d = assembleCostReport(rawJob, rawLines, rawFin, rawInvoices, GEN);
  const html = renderCostReportHtml(d);
  assert(!html.includes("QA TEST"), "excluded test line absent from render");
});

Deno.test("error page renders branded and escapes", () => {
  const html = renderCostReportError("This link is invalid or has expired.");
  assertStringIncludes(html, "This link is invalid or has expired.");
  assertStringIncludes(html, "SecureWorks Group");
});
