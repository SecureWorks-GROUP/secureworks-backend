// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  auditShapedCohort,
  billJobNumberFields,
  classifyJobNumberMatch,
  classifySupplierBill,
  extractJobNumberTokens,
  isInstallerBill,
  isTradeMirrorBill,
  summariseSupplierBills,
  type KnownJob,
} from "./job_profit_bill_match.ts";

function known(numbers: string[], status: string | null = null, holding = false): Map<string, KnownJob[]> {
  const map = new Map<string, KnownJob[]>();
  numbers.forEach((number, i) => {
    map.set(number, [{
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      status,
      holding,
    }]);
  });
  return map;
}

Deno.test("job numbers match only the whole token", () => {
  assertEquals(extractJobNumberTokens("Materials for SWF-261308 thanks"), ["SWF-261308"]);
  assertEquals(extractJobNumberTokens("ref swf-261308"), ["SWF-261308"]);
  assertEquals(extractJobNumberTokens("SWMS-261114 roof"), ["SWMS-261114"]);
  assertEquals(extractJobNumberTokens("SWP-261247 and SWF-261305"), ["SWP-261247", "SWF-261305"]);
  assertEquals(extractJobNumberTokens("SWF-261041,SWF-261042"), ["SWF-261041", "SWF-261042"]);
  assertEquals(extractJobNumberTokens("SWB-99999"), ["SWB-99999"]);
  assertEquals(extractJobNumberTokens("SWF-26111"), ["SWF-26111"]);
  assertEquals(extractJobNumberTokens("SWF-261111"), ["SWF-261111"]);
  assert(!extractJobNumberTokens("SWF-261111").includes("SWF-2611"));

  for (const text of [
    "PO-54000",
    "INV-0850",
    "SWF-PDF-BUCKET",
    "SWF-2613081",
    "SWF-2611111",
    "SWF-2611",
    "SW - FENCING",
    "SW-261111",
    "SWD-261111",
    "Business Unit",
    "XSWF-261308",
    "SWF-261111X",
    "see SWF-261",
    "",
  ]) {
    assertEquals(extractJobNumberTokens(text), [], text);
  }
});

Deno.test("a bill is exact from line text, reference or tracking", () => {
  const jobs = known(["SWF-261308", "SWP-261247"]);
  const fromLine = billJobNumberFields({
    reference: "PO-54000",
    line_items: [{ Description: "Timber SWF-261308", Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }] }],
  });
  assertEquals(fromLine.lines, ["SWF-261308"]);
  assertEquals(fromLine.reference, []);
  assertEquals(fromLine.tracking, []);
  assertEquals(classifyJobNumberMatch(fromLine.all, jobs).outcome, "exact");
  assertEquals(classifyJobNumberMatch(fromLine.all, jobs).job_number, "SWF-261308");

  const fromRef = billJobNumberFields({ reference: "SWP-261247", line_items: [] });
  assertEquals(fromRef.reference, ["SWP-261247"]);
  assertEquals(classifyJobNumberMatch(fromRef.all, jobs).outcome, "exact");

  const fromTrack = billJobNumberFields({
    reference: null,
    line_items: [{ description: "Sheets", tracking: [{ name: "Job", option: "swf-261308" }] }],
  });
  assertEquals(fromTrack.tracking, ["SWF-261308"]);
  assertEquals(classifyJobNumberMatch(fromTrack.all, jobs).job_number, "SWF-261308");
});

Deno.test("two tokens are a split and one number on two jobs is ambiguous", () => {
  const jobs = known(["SWF-261041", "SWF-261042", "SWF-261308", "SWF-261111", "SWP-261247"]);
  const both = classifyJobNumberMatch(
    extractJobNumberTokens("SWF-261042 then SWF-261041"),
    jobs,
  );
  assertEquals(both.outcome, "split");
  assertEquals(both.job_id, null);
  assertEquals(both.real_job_numbers, ["SWF-261041", "SWF-261042"]);

  const oneReal = classifyJobNumberMatch(["SWF-261308", "SWF-999001"], jobs);
  assertEquals(oneReal.outcome, "split");
  assertEquals(oneReal.job_id, null);

  const mixed = classifySupplierBill({
    xero_invoice_id: "B-MIX",
    reference: "SWF-261111 SWP-261247",
    line_items: [{ AccountCode: "305", LineAmount: 40, Description: "Sheets" }],
  }, jobs);
  assertEquals(mixed.outcome, "split");

  const unknown = classifyJobNumberMatch(["SWB-99999"], jobs);
  assertEquals(unknown.outcome, "unmatched");
  assertEquals(unknown.job_id, null);

  const doubled = new Map(jobs);
  doubled.set("SWF-261308", [
    { id: "id-a", status: null, holding: false },
    { id: "id-b", status: "complete", holding: false },
  ]);
  const multi = classifyJobNumberMatch(["SWF-261308"], doubled);
  assertEquals(multi.outcome, "ambiguous");
  assertEquals(multi.job_id, null);

  const cancelled = new Map<string, KnownJob[]>();
  cancelled.set("SWF-261308", [{ id: "id-c", status: "cancelled", holding: false }]);
  assertEquals(classifyJobNumberMatch(["SWF-261308"], cancelled).outcome, "unmatched");

  const holding = new Map<string, KnownJob[]>();
  holding.set("SWF-261308", [{ id: "id-h", status: "in_progress", holding: true }]);
  assertEquals(classifyJobNumberMatch(["SWF-261308"], holding).outcome, "unmatched");
});

Deno.test("a trade mirror is excluded and a make-safe number is not read as SW-", () => {
  assertEquals(extractJobNumberTokens("report SWMS-261114"), ["SWMS-261114"]);
  assert(!extractJobNumberTokens("report SWMS-261114").some((token) => token.startsWith("SW-")));
  const tradeIds = new Set(["BILL-T1"]);
  assert(isTradeMirrorBill("BILL-T1", [], tradeIds));
  assert(isTradeMirrorBill("BILL-S1", [{ Description: "JP-FENCE | SW - FENCING\nLabour" }], new Set()));
  assert(!isTradeMirrorBill("BILL-S1", [{ Description: "Sheets SWF-261308", Tracking: [{ Option: "SW - FENCING" }] }], new Set()));
});

Deno.test("an installer account is held even when the line names one job", () => {
  const jobs = known(["SWF-26698"]);
  assert(isInstallerBill([{ AccountCode: "306", LineAmount: 880, Description: "SWF-26698 Fence Installation" }]));
  assert(isInstallerBill([{ AccountCode: "301", Description: "Labour" }]));
  assert(!isInstallerBill([{ AccountCode: "306", LineAmount: 0, Description: "SWF-26698" }]));
  assert(!isInstallerBill([{ AccountCode: "305", LineAmount: 40, Description: "SWF-26698 timber" }]));
  const held = classifySupplierBill({
    xero_invoice_id: "BILL-ALYX",
    reference: "SWF-26698",
    line_items: [{ AccountCode: "306", LineAmount: 880, Description: "SWF-26698 Fence Installation" }],
  }, jobs);
  assertEquals(held.outcome, "installer_hold");
  assertEquals(held.job_id, null);
});

Deno.test("a bill that already has a materials fact is not proposed", () => {
  const jobs = known(["SWF-261111"]);
  const classified = classifySupplierBill({
    xero_invoice_id: "BILL-FACT",
    reference: "SWF-261111",
    line_items: [{ AccountCode: "305", LineAmount: 40, Description: "Sheets" }],
  }, jobs, new Set(["BILL-FACT"]));
  assertEquals(classified.outcome, "already_fact");
  assertEquals(classified.job_id, null);
});

Deno.test("a trade-app bill is not an exact match", () => {
  const jobs = known(["SWF-261308"]);
  const classified = classifySupplierBill({
    xero_invoice_id: "BILL-T1",
    reference: "SWF-261308",
    line_items: [{ AccountCode: "305", LineAmount: 40, Description: "SWF-261308 timber" }],
    trade_mirror: true,
  }, jobs);
  assertEquals(classified.outcome, "trade_app");
});

Deno.test("the audit-shaped cohort sends two-job bills to the split queue", () => {
  const { bills, jobsByNumber } = auditShapedCohort();
  const summary = summariseSupplierBills(bills, jobsByNumber);
  assertEquals(summary.scanned, 653);
  assertEquals(summary.trade_mirrors_excluded, 4);
  assertEquals(summary.already_linked, 33);
  assertEquals(summary.installer_hold, 0);
  assertEquals(summary.already_fact, 0);
  assertEquals(
    summary.already_linked + summary.exact_unique + summary.split + summary.ambiguous +
      summary.unmatched + summary.installer_hold + summary.already_fact,
    649,
  );
  assertEquals(summary.line_text_hits, 53);
  assertEquals(summary.reference_hits, 0);
  assertEquals(summary.tracking_hits, 0);
  assertEquals(summary.exact_unique, 40);
  assertEquals(summary.split, 8);
  assertEquals(summary.ambiguous, 0);
  assertEquals(summary.unmatched, 568);
  assertEquals(summary.apply_count, 40);
  assert(summary.apply_count <= summary.line_text_hits);
});

Deno.test("ops-api does not dispatch a second bill queue and the script does not write job_id", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(index.includes("job_profit_unmatched_bills"), false);
  assertEquals(index.includes("job_profit_link_bill"), false);
  const script = await Deno.readTextFile(new URL("../../../scripts/job-profit-bill-match.ts", import.meta.url));
  assertEquals(script.includes('method: "PATCH"'), false);
  assertEquals(script.includes("xero_invoices?id="), false);
  assertEquals(script.includes("job_profit_link_bill"), false);
  assertEquals(script.includes("rpc/job_profit_link_bill"), false);
  assert(script.includes("does not write proposals"));
});
