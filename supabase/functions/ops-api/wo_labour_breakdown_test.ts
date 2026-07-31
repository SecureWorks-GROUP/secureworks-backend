// Regression tests for the WO labour breakdown path.
//
// Captain's worked example: WO $559.50, Tendo 11.5h x $25 = $287.50, net
// payable to the holder $272.00. The holder keeps the structured facts and
// the office manually reconciles the named crew invoices. No payout invoice
// is created by generate_trade_invoice.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _cleanWoLabourLines,
  _cleanWoName,
  _extractWoLabourEntries,
  _formatWoLabourBreakdown,
  _tradeInvoiceXeroTax,
  _woLabourProblemNote,
  _woNetMismatch,
} from "./wo_labour_fanout.ts";

const ALYX_WO_ITEM = {
  row_type: "work_order",
  quantity: 1,
  rate: 272,
  wo_allocated: 559.5,
  wo_labour_deduction: 287.5,
  wo_labour_lines: [{
    trade_name: "Tendo",
    hours: 11.5,
    rate: 25,
    amount: 287.5,
  }],
  job_id: "j-26767",
  job_number: "SWF-26767",
  client_name: "Kelvin Gillies",
  division: "fencing",
  date: "2026-07-14",
};

const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("_cleanWoName trims and collapses whitespace", () => {
  assertEquals(_cleanWoName("Tendo  "), "Tendo");
  assertEquals(_cleanWoName("  Jean   Crous "), "Jean Crous");
  assertEquals(_cleanWoName(null), "");
});

Deno.test("_extractWoLabourEntries keeps named lines and flags unroutable lines", () => {
  const { entries, problems } = _extractWoLabourEntries({
    ...ALYX_WO_ITEM,
    wo_labour_lines: [
      { trade_name: "", hours: null, rate: null },
      { trade_name: "", hours: 2, rate: 30 },
      { trade_name: "Kim", hours: 0, rate: 25 },
      { trade_name: "Tendo", hours: 11.5, rate: 25 },
    ],
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0], {
    trade_name: "Tendo",
    hours: 11.5,
    rate: 25,
    amount: 287.5,
  });
  assertEquals(problems.map((p) => p.reason), ["unnamed", "incomplete"]);
  assertEquals(problems[0].amount, 60);
});

Deno.test("_woNetMismatch accepts the captain's case and rejects gross payout claims", () => {
  assertEquals(_woNetMismatch(ALYX_WO_ITEM), null);
  const bad = _woNetMismatch({ ...ALYX_WO_ITEM, rate: 559.5 });
  assertEquals(bad?.expectedNet, 272);
  assertEquals(bad?.claimedNet, 559.5);
  assertEquals(bad?.labourSum, 287.5);
});

Deno.test("_woNetMismatch uses per-line rounding", () => {
  assertEquals(
    _woNetMismatch({
      wo_allocated: 500,
      rate: 399.99,
      wo_labour_lines: [{ trade_name: "Jean", hours: 3, rate: 33.335 }],
    }),
    null,
  );
});

Deno.test("_cleanWoLabourLines preserves structured facts and recomputes amounts", () => {
  assertEquals(
    _cleanWoLabourLines({
      wo_labour_lines: [
        { trade_name: "Tendo  ", hours: 11.5, rate: 25, amount: 999 },
        { trade_name: "", hours: null, rate: null },
        { trade_name: "Kim", hours: 0, rate: 25 },
      ],
    }),
    [
      { trade_name: "Tendo", hours: 11.5, rate: 25, amount: 287.5 },
      { trade_name: "Kim", hours: 0, rate: 25, amount: 0 },
    ],
  );
});

Deno.test("_formatWoLabourBreakdown is loud and PDF-safe for the captain's case", () => {
  const text = _formatWoLabourBreakdown(
    ALYX_WO_ITEM.wo_allocated,
    ALYX_WO_ITEM.wo_labour_lines,
  );
  assertEquals(
    text,
    [
      "Work order $559.50.",
      "Less labour: Tendo 11.5h x $25 = $287.50.",
      "Total labour deducted $287.50.",
      "Net payable to holder $272.00.",
      "Named crew bill SecureWorks Group directly; office to check their invoices against this breakdown.",
    ].join("\n"),
  );
  assert(!text.includes("—"), "holder breakdown must not use em dashes");
});

Deno.test("_formatWoLabourBreakdown renders one named labourer per line", () => {
  const text = _formatWoLabourBreakdown(1000, [
    { trade_name: "Tendo", hours: 4, rate: 25 },
    { trade_name: "Jean Crous", hours: 6, rate: 45 },
  ]);
  assert(
    text.includes("Tendo 4h x $25 = $100.00\nJean Crous 6h x $45 = $270.00"),
  );
  assert(text.includes("Total labour deducted $370.00."));
  assert(text.includes("Net payable to holder $630.00."));
});

Deno.test("_woLabourProblemNote remains an office-facing unresolved event note", () => {
  const note = _woLabourProblemNote([{
    trade_name: "Riley",
    reason: "incomplete",
    amount: 0,
    job_number: "SWF-26556",
  }]);
  assert(note.includes("Riley"));
  assert(note.includes("SWF-26556"));
  assert(note.includes("reconcile"));
});

Deno.test("trade invoice Xero tax conventions remain unchanged", () => {
  assertEquals(_tradeInvoiceXeroTax(35), {
    taxType: "INPUT",
    lineAmountTypes: "Exclusive",
  });
  assertEquals(_tradeInvoiceXeroTax(0), {
    taxType: "NONE",
    lineAmountTypes: "NoTax",
  });
});

Deno.test("generate_trade_invoice does not contain the old payout-invoice fan-out", () => {
  for (
    const stale of [
      "_buildWoLabourPayoutInvoice",
      "_resolveWoLabourUsers",
      "wo_labour_payouts",
      "trade.wo_labour_payout_created",
      "trade.wo_labour_payout_failed",
    ]
  ) {
    assert(
      !INDEX_SRC.includes(stale),
      `stale payout fan-out reference remains: ${stale}`,
    );
  }
  assert(INDEX_SRC.includes("_formatWoLabourBreakdown"));
  assert(INDEX_SRC.includes("trade.wo_labour_unresolved"));
  assert(INDEX_SRC.includes("(e.description || e.line_type || 'Extra')"));
});
