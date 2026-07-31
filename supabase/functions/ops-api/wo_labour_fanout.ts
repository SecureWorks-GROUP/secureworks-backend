// WO labour breakdown — pure helpers for validating and recording the named
// worked-out work order (trade.html Pay tab, Work Order mode).
//
// The trade app's WO-mode job card carries structured labour lines
// (wo_labour_lines: [{trade_name, hours, rate, amount}]) on each work-order
// extra item. The WO holder's own line is already net of that labour
// (rate = wo_allocated − Σ labour). The structured facts remain on the
// holder's line for the future reconciliation system; labourers bill
// SecureWorks Group directly and the office checks their invoices manually.
//
// All functions are pure (no I/O) so they are unit-testable; index.ts owns the
// DB reads/writes.

export type WoLabourEntry = {
  trade_name: string;
  hours: number;
  rate: number;
  amount: number;
};

export type WoLabourProblem = {
  trade_name: string;
  reason: "unnamed" | "incomplete";
  amount: number;
  job_number: string | null;
};

// Xero chart-of-accounts destination for trade/subcontractor ACCPAY bill lines.
// Captain's ruling 2026-07-31: trade invoices go to 306 "Internal
// Subcontractors" (previously 620). Shared by push_trade_invoice_to_xero,
// submit_work_order_invoice, generate_trade_invoice and submitTradeInvoice so
// every trade push path routes identically. Must stay an EXPENSE code —
// revenue codes from accountCodeForJob are invalid with INPUT tax on ACCPAY.
// Client/sales (ACCREC) invoice routing is deliberately untouched.
export const TRADE_INVOICE_XERO_ACCOUNT_CODE = "306";

export function _tradeInvoiceXeroTax(
  gst: unknown,
): { taxType: "INPUT" | "NONE"; lineAmountTypes: "Exclusive" | "NoTax" } {
  return Number(gst || 0) > 0
    ? { taxType: "INPUT", lineAmountTypes: "Exclusive" }
    : { taxType: "NONE", lineAmountTypes: "NoTax" };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Trim + collapse internal whitespace. Production data carries names like
// "Tendo " and "Tendo  " that must all read as one person.
export function _cleanWoName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

// Read the cleaned labour lines off ONE work-order extra item.
// Returns valid named lines plus problems (lines that carry money or a name but
// are missing required hours or rate data). Fully-empty template rows are
// dropped.
export function _extractWoLabourEntries(
  // deno-lint-ignore no-explicit-any -- request payload shape is validated by the caller.
  item: any,
): { entries: WoLabourEntry[]; problems: WoLabourProblem[] } {
  const entries: WoLabourEntry[] = [];
  const problems: WoLabourProblem[] = [];
  const lines = Array.isArray(item?.wo_labour_lines)
    ? item.wo_labour_lines
    : [];
  for (const raw of lines) {
    const name = _cleanWoName(raw?.trade_name);
    const hours = Number(raw?.hours || 0);
    const rate = Number(raw?.rate || 0);
    const amount = round2(hours * rate);
    if (!name && amount <= 0) continue; // empty template row
    if (!name) {
      problems.push({
        trade_name: "(unnamed)",
        reason: "unnamed",
        amount,
        job_number: item?.job_number || null,
      });
      continue;
    }
    if (!(hours > 0) || !(rate > 0)) {
      problems.push({
        trade_name: name,
        reason: "incomplete",
        amount,
        job_number: item?.job_number || null,
      });
      continue;
    }
    entries.push({
      trade_name: name,
      hours,
      rate,
      amount,
    });
  }
  return { entries, problems };
}

// Cleaned copy of EVERY money- or name-carrying labour line on the item —
// this is what gets persisted to trade_invoice_lines.wo_labour_lines as the
// queryable record of the deduction (payable or not). Empty template rows drop.
export function _cleanWoLabourLines(
  // deno-lint-ignore no-explicit-any -- request payload shape is validated by the caller.
  item: any,
): Array<{ trade_name: string; hours: number; rate: number; amount: number }> {
  const lines = Array.isArray(item?.wo_labour_lines)
    ? item.wo_labour_lines
    : [];
  const out: Array<
    { trade_name: string; hours: number; rate: number; amount: number }
  > = [];
  for (const raw of lines) {
    const trade_name = _cleanWoName(raw?.trade_name);
    const hours = Number(raw?.hours || 0);
    const rate = Number(raw?.rate || 0);
    const amount = round2(hours * rate);
    if (!trade_name && amount <= 0) continue;
    out.push({ trade_name, hours, rate, amount });
  }
  return out;
}

function _formatNumber(n: number): string {
  return Number.isInteger(n)
    ? String(n)
    : String(n).replace(/0+$/, "").replace(/\.$/, "");
}

function _formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Human-readable audit trail used as both the stored holder-line description
// and the Xero line-item description. Newlines are intentional: Xero renders
// them in the invoice PDF, keeping each named labourer visible as its own line.
export function _formatWoLabourBreakdown(
  allocatedRaw: unknown,
  lines: Array<{
    trade_name?: unknown;
    hours?: unknown;
    rate?: unknown;
    amount?: unknown;
  }>,
): string {
  const allocated = round2(Number(allocatedRaw) || 0);
  const details = (lines || []).map((line) => {
    const name = _cleanWoName(line?.trade_name) || "Unnamed crew member";
    const hours = Number(line?.hours || 0);
    const rate = Number(line?.rate || 0);
    const amount = round2(hours * rate);
    return `${name} ${_formatNumber(hours)}h x $${_formatNumber(rate)} = ${
      _formatMoney(amount)
    }`;
  });
  const deduction = round2((lines || []).reduce((sum, line) => {
    return sum + round2(Number(line?.hours || 0) * Number(line?.rate || 0));
  }, 0));
  const labourText = details.length > 0 ? details.join("\n") : "none declared";
  const net = round2(allocated - deduction);
  return [
    `Work order ${_formatMoney(allocated)}.`,
    `Less labour: ${labourText}.`,
    `Total labour deducted ${_formatMoney(deduction)}.`,
    `Net payable to holder ${_formatMoney(net)}.`,
    "Named crew bill SecureWorks Group directly; office to check their invoices against this breakdown.",
  ].join("\n");
}

// Server-side money check for one work-order extra item: the holder's payable
// net (item.rate) must equal wo_allocated − Σ labour within 1c. The client
// computes exactly this; a mismatch means a buggy or tampered payload and the
// submission must not create money records.
export function _woNetMismatch(
  // deno-lint-ignore no-explicit-any -- request payload shape is validated by the caller.
  item: any,
): {
  allocated: number;
  labourSum: number;
  expectedNet: number;
  claimedNet: number;
} | null {
  const allocated = Number(item?.wo_allocated || 0);
  const lines = Array.isArray(item?.wo_labour_lines)
    ? item.wo_labour_lines
    : [];
  // deno-lint-ignore no-explicit-any -- request payload shape is validated by the caller.
  const labourSum = round2(lines.reduce((s: number, l: any) => {
    const name = _cleanWoName(l?.trade_name);
    const amt = round2(Number(l?.hours || 0) * Number(l?.rate || 0));
    if (!name && amt <= 0) return s; // dropped template row carries no money
    return s + amt;
  }, 0));
  const expectedNet = round2(allocated - labourSum);
  const claimedNet = round2(
    Number(item?.quantity || 1) * Number(item?.rate || 0),
  );
  if (Math.abs(expectedNet - claimedNet) > 0.01) {
    return { allocated, labourSum, expectedNet, claimedNet };
  }
  return null;
}

// One office-facing sentence for labour lines that could NOT be routed to a
// person. Empty string when there is nothing to say.
export function _woLabourProblemNote(problems: WoLabourProblem[]): string {
  if (!problems || problems.length === 0) return "";
  const parts = problems.map((p) => {
    const where = p.job_number ? ` on ${p.job_number}` : "";
    const money = p.amount > 0 ? ` ($${p.amount.toFixed(2)})` : "";
    switch (p.reason) {
      case "unnamed":
        return `an unnamed labour line${where}${money}`;
      case "incomplete":
        return `${p.trade_name}${where}: hours/rate missing${money}`;
    }
  });
  return "WO LABOUR: could not route " + parts.join("; ") +
    ". The office must reconcile these labour lines manually.";
}
