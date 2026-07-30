// WO labour fan-out — pure helpers for paying the named labourers on a
// worked-out work order (trade.html Pay tab, Work Order mode).
//
// The trade app's WO-mode job card carries structured labour lines
// (wo_labour_lines: [{trade_name, hours, rate, amount}]) on each work-order
// extra item. The WO holder's own line is already net of that labour
// (rate = wo_allocated − Σ labour). These helpers turn those labour lines into
// payout invoices for the NAMED crew members so the money the holder gave up
// actually reaches the people who worked the site.
//
// Control model: every payout invoice lands in status 'pending_ops_review' —
// the office verifies (name match is heuristic, and the labourer may have
// self-invoiced the same hours) and then Approve & push sends it to Xero via
// the existing approve_trade_invoice / push_trade_invoice_to_xero actions.
// Nothing here touches Xero directly.
//
// All functions are pure (no I/O) so they are unit-testable; index.ts owns the
// DB reads/writes.

export type WoLabourEntry = {
  trade_name: string;
  hours: number;
  rate: number;
  amount: number;
  job_id: string | null;
  job_number: string | null;
  client_name: string | null;
  division: string | null;
  line_date: string | null;
};

export type WoLabourProblem = {
  trade_name: string;
  reason: "unnamed" | "incomplete" | "unmatched" | "ambiguous" | "self";
  amount: number;
  job_number: string | null;
};

export type WoLabourUser = {
  id: string;
  name: string;
  trade_details?: { gstRegistered?: boolean } | null;
};

export type WoLabourGroup = {
  user: WoLabourUser;
  entries: WoLabourEntry[];
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

function normName(raw: unknown): string {
  return _cleanWoName(raw).toLowerCase();
}

// Read the cleaned labour lines off ONE work-order extra item.
// Returns entries (payable lines) plus problems (lines that carry money or a
// name but cannot be paid as-is). Fully-empty template rows are dropped.
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
      job_id: item?.job_id || null,
      job_number: item?.job_number || null,
      client_name: item?.client_name || null,
      division: item?.division || null,
      line_date: item?.date || null,
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

// Deterministic free-text name → org user resolution.
// A labour-line name resolves only when it matches exactly ONE org user:
//   1. full-name equality (case/whitespace-insensitive), else
//   2. unique first-token match ("Tendo" → "Tendo Lugesera Adrian"), else
//   3. unique name-prefix match ("Jean C" → "Jean Crous").
// Anything else (no match, several matches, or the submitter naming
// themselves) is reported as a problem for the office instead of guessing.
export function _resolveWoLabourUsers(
  entries: WoLabourEntry[],
  users: WoLabourUser[],
  submitterId: string,
): { groups: WoLabourGroup[]; problems: WoLabourProblem[] } {
  const groups = new Map<string, WoLabourGroup>();
  const problems: WoLabourProblem[] = [];
  const usable = (users || []).filter((u) => u && u.id && _cleanWoName(u.name));
  for (const entry of entries) {
    const needle = normName(entry.trade_name);
    let matches = usable.filter((u) => normName(u.name) === needle);
    if (matches.length === 0) {
      matches = usable.filter((u) => normName(u.name).split(" ")[0] === needle);
    }
    if (matches.length === 0) {
      matches = usable.filter((u) => normName(u.name).startsWith(needle));
    }
    if (matches.length === 0) {
      problems.push({
        trade_name: entry.trade_name,
        reason: "unmatched",
        amount: entry.amount,
        job_number: entry.job_number,
      });
      continue;
    }
    if (matches.length > 1) {
      problems.push({
        trade_name: entry.trade_name,
        reason: "ambiguous",
        amount: entry.amount,
        job_number: entry.job_number,
      });
      continue;
    }
    const user = matches[0];
    if (String(user.id) === String(submitterId)) {
      problems.push({
        trade_name: entry.trade_name,
        reason: "self",
        amount: entry.amount,
        job_number: entry.job_number,
      });
      continue;
    }
    const g = groups.get(user.id) || { user, entries: [] };
    g.entries.push(entry);
    groups.set(user.id, g);
  }
  return { groups: [...groups.values()], problems };
}

// Build the payout invoice + line rows for one labourer (pure — caller inserts).
// Lines use the labour shape (total_hours/hourly_rate) AND the extras shape
// (quantity/unit_rate) with equal totals so push_trade_invoice_to_xero's
// reconciliation guard passes on either branch.
export function _buildWoLabourPayoutInvoice(
  group: WoLabourGroup,
  opts: {
    orgId: string;
    weekStart: string | null;
    weekEnd: string | null;
    invoiceNumber: string;
    sourceInvoiceNumber: string;
    sourceTradeName: string;
    nowIso: string;
  },
): { invoice: Record<string, unknown>; lines: Record<string, unknown>[] } {
  const gstRegistered = group.user.trade_details?.gstRegistered === true;
  const subtotal = round2(group.entries.reduce((s, e) => s + e.amount, 0));
  const gst = gstRegistered ? round2(subtotal * 0.1) : 0;
  const totalHours = round2(group.entries.reduce((s, e) => s + e.hours, 0));
  const provenance =
    `Auto-created from ${opts.sourceTradeName}'s work order invoice ${opts.sourceInvoiceNumber}`;
  const invoice = {
    org_id: opts.orgId,
    user_id: group.user.id,
    week_start: opts.weekStart,
    week_end: opts.weekEnd,
    total_hours: totalHours,
    total_breaks_minutes: 0,
    subtotal_ex: subtotal,
    gst,
    total_inc: round2(subtotal + gst),
    has_manual_overrides: false,
    override_details: null,
    notes: provenance,
    invoice_number: opts.invoiceNumber,
    submitted_at: opts.nowIso,
    status: "pending_ops_review",
    query_note:
      `${provenance} — pay ${group.user.name} for the labour deducted from that work order. ` +
      `Verify ${group.user.name} has not also invoiced these hours before approving.`,
  };
  const lines = group.entries.map((e) => ({
    line_type: "labour",
    description:
      `WO labour — ${
        [e.job_number, e.client_name].filter(Boolean).join(" — ") || "job"
      } — ` +
      `${e.hours}h @ $${e.rate}/hr (from ${opts.sourceTradeName}'s work order ${opts.sourceInvoiceNumber})`,
    total_hours: e.hours,
    hourly_rate: e.rate,
    quantity: e.hours,
    unit: "hr",
    unit_rate: e.rate,
    line_total_ex: e.amount,
    line_date: e.line_date,
    division: e.division,
    job_id: e.job_id,
    job_number: e.job_number,
    client_name: e.client_name,
    query_note:
      `${provenance}. Rate entered by ${opts.sourceTradeName} — office verifies before payment.`,
  }));
  return { invoice, lines };
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
      case "unmatched":
        return `"${p.trade_name}"${where}${money}: no matching crew member`;
      case "ambiguous":
        return `"${p.trade_name}"${where}${money}: matches more than one crew member`;
      case "self":
        return `"${p.trade_name}"${where}${money}: names the submitter — not auto-paid`;
    }
  });
  return "WO LABOUR: could not auto-pay " + parts.join("; ") +
    ". The office must arrange these payment(s) manually.";
}
