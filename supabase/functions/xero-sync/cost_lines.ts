import { onPeopleAccount, type PeopleAccounts } from "../_shared/people_accounts.ts";

type Line = {
  line_key: string;
  line_no: number;
  kind: string;
  description: string | null;
  account_code: string | null;
  xero_tracking_option: string | null;
  lane: string;
  event_lane_detail: string;
  amount_ex: number | null;
  gst: number;
  is_actual: boolean;
  paid: boolean;
  paid_on: string | null;
  event_source: string;
  event_source_id: string;
  follows_line_key?: string;
};
type Bill = {
  invoice_type?: string;
  xero_invoice_id: string;
  status?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  xero_contact_id?: string | null;
  contact_name?: string | null;
  fully_paid_on?: string | null;
  line_items?: unknown;
  sub_total?: number | null;
  raw_json?: { LineAmountTypes?: string };
};

// PostgreSQL numeric round breaks ties away from zero on either sign.
function roundSix(amount: number): number {
  return Math.sign(amount) *
    Math.round((Math.abs(amount) + Number.EPSILON) * 1e6) / 1e6;
}

type Context = {
  mirrorBillIds: Set<string>;
  orgId: string;
  /** The one set of people accounts (read once per run by the caller). */
  people: PeopleAccounts;
  employerSuperOn?: boolean;
};

// Ports job_cost_super_withheld_line and job_cost_super_company_contribution.
function withheld(line: Record<string, unknown>): boolean {
  return /superannuation|super guarantee/i.test(
    String(line.Description ?? ""),
  ) && Number(line.LineAmount ?? 0) < 0;
}
function exAmount(
  line: Record<string, unknown>,
  inclusive: boolean,
): number | null {
  return "_header_ex" in line
    ? (line._header_ex == null ? null : Number(line._header_ex))
    : Number(line.LineAmount ?? 0) -
      (inclusive ? Number(line.TaxAmount ?? 0) : 0);
}

// Same inclusive/exclusive expression as bill_line in the cost view.
export function billCostDocument(bill: Bill, ctx: Context) {
  if (
    bill.invoice_type !== "ACCPAY" ||
    ctx.mirrorBillIds.has(bill.xero_invoice_id)
  ) return null;
  const lines: Line[] = [];
  const stored = Array.isArray(bill.line_items) ? bill.line_items : [];
  const rawLines = stored.length ? stored : [{
    _header_ex: bill.sub_total ?? null,
    Description: "Bill total (no lines stored)",
  }];
  const inclusive = bill.raw_json?.LineAmountTypes === "Inclusive";
  let companySuper = 0;
  let baseEx = 0;
  for (const raw of stored) {
    const line = raw as Record<string, unknown>;
    if (withheld(line)) {
      const stated = String(line.Description ?? "").match(
        /company contribution \$?([0-9][0-9,]*(\.[0-9]+)?)/i,
      );
      if (stated) companySuper += Number(stated[1].replaceAll(",", ""));
    } else baseEx += exAmount(line, inclusive) ?? 0;
  }
  for (const [i, raw] of rawLines.entries()) {
    const l = raw as Record<string, unknown>;
    if (withheld(l)) continue;
    const gst = Number(l.TaxAmount ?? 0);
    const amount = exAmount(l, inclusive);
    if (amount === 0) continue;
    const account = l.AccountCode == null ? null : String(l.AccountCode);
    const description = l.Description == null ? null : String(l.Description);
    const installer = onPeopleAccount(ctx.people, account);
    const lane = /commission/i.test(description ?? "")
      ? "commission"
      : installer
      ? "labour"
      : /^3[0-9]{2}$/.test(account ?? "")
      ? "materials"
      : "other";
    const tracking = Array.isArray(l.Tracking)
      ? l.Tracking[0]?.Option ?? null
      : null;
    lines.push({
      line_key: l.LineItemID ? String(l.LineItemID) : `n:${i + 1}`,
      line_no: i + 1,
      kind: installer ? "installer_bill" : "supplier_bill",
      description,
      account_code: account,
      xero_tracking_option: tracking,
      lane,
      event_lane_detail: lane,
      amount_ex: amount,
      gst,
      is_actual: true,
      paid: bill.status === "PAID",
      paid_on: bill.fully_paid_on ?? null,
      event_source: "supplier_bill",
      event_source_id: `${bill.xero_invoice_id}:${i + 1}`,
    });
  }
  if (
    ctx.employerSuperOn && companySuper > 0.005 && baseEx > 0 &&
    ["AUTHORISED", "PAID"].includes(bill.status ?? "")
  ) {
    // The legacy formula rounds to six places; numeric(12,2) storage rounds
    // each cost line to cents. Keep the parent allocation coordinate explicit.
    for (const parent of [...lines]) {
      if (parent.amount_ex == null) continue;
      lines.push({
        ...parent,
        kind: "employer_super",
        line_key: `${parent.line_key}:employer_super`,
        follows_line_key: parent.line_key,
        amount_ex: roundSix(parent.amount_ex * companySuper / baseEx),
        gst: 0,
        paid: false,
        paid_on: null,
        event_source: "bill_employer_super",
        event_source_id: `${parent.event_source_id}:employer_super`,
        event_lane_detail: "employer_super",
        description: `Employer super on: ${parent.description ?? ""}`,
      });
    }
  }
  return {
    org_id: ctx.orgId,
    document_kind: "xero_bill",
    document_id: bill.xero_invoice_id,
    document_number: bill.invoice_number ?? null,
    document_date: bill.invoice_date?.slice(0, 10) ?? null,
    document_status: bill.status ?? null,
    live: bill.status === "AUTHORISED" || bill.status === "PAID",
    party_kind: "supplier",
    party_id: bill.xero_contact_id ?? null,
    party_name: bill.contact_name ?? null,
    lines,
  };
}

// Conversion is shadow work too. A malformed source must not abort the sync.
export function collectBillCostDocument(
  bill: Bill,
  ctx: Context,
  documents: NonNullable<ReturnType<typeof billCostDocument>>[],
  errors: string[],
): void {
  try {
    const document = billCostDocument(bill, ctx);
    if (document) documents.push(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("[xero-sync] Bill cost document failed:", message);
  }
}
