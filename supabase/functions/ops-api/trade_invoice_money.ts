// Canonical subcontractor invoice money split.
//
// Statutory source (checked 2026-08-27): the Australian Taxation Office's
// "Super guarantee percentage" table sets the general SG rate to 12.00% from
// 1 July 2025, including 1 July 2026-30 June 2027 and 1 July 2027 onwards.
// https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee
//
// Keep rate resolution here. Callers must fail closed when this module cannot
// resolve a rate; they must never guess or silently fall back to zero.

export const TRADE_INVOICE_GST_RATE = 0.10;
export const TRADE_INVOICE_SUPER_RATE = 0.12;
export const TRADE_INVOICE_SUPER_EFFECTIVE_FROM = "2025-07-01";

export type TradeInvoiceMoneyErrorCode =
  | "GST_CHOICE_INVALID"
  | "GST_CHOICE_REQUIRED"
  | "GROSS_EARNED_INVALID"
  | "SUPER_RATE_UNRESOLVED"
  | "MONEY_SPLIT_MISSING"
  | "MONEY_SPLIT_INVALID"
  | "LINE_AMOUNT_UNRESOLVED"
  | "XERO_GROSS_MISMATCH"
  | "XERO_RETURNED_SPLIT_INVALID";

export class TradeInvoiceMoneyError extends Error {
  readonly code: TradeInvoiceMoneyErrorCode;

  constructor(code: TradeInvoiceMoneyErrorCode, message: string) {
    super(message);
    this.name = "TradeInvoiceMoneyError";
    this.code = code;
  }
}

export type TradeInvoiceMoney = {
  gst_on: boolean;
  super_rate: number;
  gross_earned: number;
  super_amount: number;
  net_pay: number;
  gst_amount: number;
  trade_payable: number;
  total_inc: number;
};

export type TradeInvoiceXeroLine = Record<string, unknown> & {
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  AccountCode?: string;
  TaxType?: "INPUT" | "NONE" | string;
  Tracking?: unknown[];
};

export type PersistedTradeInvoiceLineAmount = {
  quantity: number;
  unitAmount: number;
  lineTotalEx: number;
  basis: "hours_rate" | "quantity_rate" | "line_total_ex";
};

export type TradeInvoiceXeroIdentity = {
  xeroBillId: string;
  xeroBillNumber: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (value: number): number => value / 100;
const closeMoney = (left: number, right: number): boolean =>
  Math.abs(left - right) <= 0.01;

function validDateOnly(raw: unknown): string | null {
  const text = String(raw ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

export function resolveSuperGuaranteeRate(
  earningsDate: unknown,
): number | null {
  const date = validDateOnly(earningsDate);
  if (!date || date < TRADE_INVOICE_SUPER_EFFECTIVE_FROM) return null;
  return TRADE_INVOICE_SUPER_RATE;
}

export function resolveTradeInvoiceGstOn(
  request: unknown,
): boolean {
  const record = request && typeof request === "object"
    ? request as Record<string, unknown>
    : {};
  for (const key of ["gst_on", "gst_registered", "gst"] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (typeof record[key] !== "boolean") {
      throw new TradeInvoiceMoneyError(
        "GST_CHOICE_INVALID",
        "GST choice must be true or false",
      );
    }
    return record[key];
  }
  throw new TradeInvoiceMoneyError(
    "GST_CHOICE_REQUIRED",
    "GST choice is required before creating a trade invoice",
  );
}

export function calculateTradeInvoiceMoney(input: {
  grossEarned: unknown;
  gstOn: unknown;
  earningsDate: unknown;
}): TradeInvoiceMoney {
  const grossEarned = Number(input.grossEarned);
  if (!Number.isFinite(grossEarned) || grossEarned < 0) {
    throw new TradeInvoiceMoneyError(
      "GROSS_EARNED_INVALID",
      "Gross earned must be a finite amount of zero or more",
    );
  }
  if (typeof input.gstOn !== "boolean") {
    throw new TradeInvoiceMoneyError(
      "GST_CHOICE_INVALID",
      "GST choice must be true or false",
    );
  }

  const superRate = resolveSuperGuaranteeRate(input.earningsDate);
  if (superRate === null) {
    throw new TradeInvoiceMoneyError(
      "SUPER_RATE_UNRESOLVED",
      `No statutory Superannuation Guarantee rate is configured for ${
        String(input.earningsDate ?? "the invoice date")
      }`,
    );
  }

  const gross = round2(grossEarned);
  const superAmount = round2(gross * superRate);
  const netPay = round2(gross - superAmount);
  // GST remains 10% of the original contractor supply (gross earned). Super is
  // a split of that amount, not an extra taxable amount.
  const gstAmount = input.gstOn ? round2(gross * TRADE_INVOICE_GST_RATE) : 0;

  return {
    gst_on: input.gstOn,
    super_rate: superRate,
    gross_earned: gross,
    super_amount: superAmount,
    net_pay: netPay,
    gst_amount: gstAmount,
    trade_payable: round2(netPay + gstAmount),
    total_inc: round2(gross + gstAmount),
  };
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  if (record[key] === null || record[key] === undefined || record[key] === "") {
    throw new TradeInvoiceMoneyError(
      "MONEY_SPLIT_MISSING",
      "Trade invoice is missing its super/GST split and cannot be pushed to Xero",
    );
  }
  const value = Number(record[key]);
  if (!Number.isFinite(value)) {
    throw new TradeInvoiceMoneyError(
      "MONEY_SPLIT_INVALID",
      `Trade invoice ${key} is invalid`,
    );
  }
  return value;
}

export function validatePersistedTradeInvoiceMoney(
  value: unknown,
): TradeInvoiceMoney {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (typeof record.gst_on !== "boolean") {
    throw new TradeInvoiceMoneyError(
      "MONEY_SPLIT_MISSING",
      "Trade invoice is missing its super/GST split and cannot be pushed to Xero",
    );
  }

  const superRate = requiredNumber(record, "super_rate");
  const gross = requiredNumber(record, "gross_earned");
  const superAmount = requiredNumber(record, "super_amount");
  const netPay = requiredNumber(record, "net_pay");
  const gstAmount = requiredNumber(record, "gst");
  const totalInc = requiredNumber(record, "total_inc");
  const subtotalEx = requiredNumber(record, "subtotal_ex");
  const earningsDate = record.week_end ?? record.week_start ??
    record.submitted_at ?? record.created_at;
  const statutoryRate = resolveSuperGuaranteeRate(earningsDate);
  if (statutoryRate === null) {
    throw new TradeInvoiceMoneyError(
      "SUPER_RATE_UNRESOLVED",
      `No statutory Superannuation Guarantee rate is configured for ${
        String(earningsDate ?? "the invoice date")
      }`,
    );
  }

  if (
    !(superRate > 0 && superRate <= 1) || gross < 0 || superAmount < 0 ||
    netPay < 0 || gstAmount < 0 ||
    Math.abs(superRate - statutoryRate) > 0.000001 ||
    !closeMoney(gross, subtotalEx) ||
    !closeMoney(superAmount, round2(gross * superRate)) ||
    !closeMoney(netPay, round2(gross - superAmount)) ||
    !closeMoney(
      gstAmount,
      record.gst_on ? round2(gross * TRADE_INVOICE_GST_RATE) : 0,
    ) ||
    !closeMoney(totalInc, round2(gross + gstAmount))
  ) {
    throw new TradeInvoiceMoneyError(
      "MONEY_SPLIT_INVALID",
      "Trade invoice super/GST split does not reconcile and cannot be pushed to Xero",
    );
  }

  return {
    gst_on: record.gst_on,
    super_rate: superRate,
    gross_earned: round2(gross),
    super_amount: round2(superAmount),
    net_pay: round2(netPay),
    gst_amount: round2(gstAmount),
    trade_payable: round2(netPay + gstAmount),
    total_inc: round2(totalInc),
  };
}

const PERSISTED_SPLIT_FIELDS = [
  "gst_on",
  "super_rate",
  "super_amount",
  "gross_earned",
  "net_pay",
] as const;

export function presentTradeInvoiceMoney<
  T extends Record<string, unknown>,
>(invoice: T): T & { trade_payable: number | null } {
  const hasPersistedSplit = PERSISTED_SPLIT_FIELDS.some((field) =>
    invoice[field] !== null && invoice[field] !== undefined
  );
  if (!hasPersistedSplit) {
    return { ...invoice, trade_payable: null };
  }

  return {
    ...invoice,
    trade_payable: validatePersistedTradeInvoiceMoney(invoice).trade_payable,
  };
}

export function resolvePersistedTradeInvoiceLineAmount(
  value: unknown,
): PersistedTradeInvoiceLineAmount {
  const line = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const rawLineTotalEx = line.line_total_ex;
  if (
    rawLineTotalEx === null || rawLineTotalEx === undefined ||
    (typeof rawLineTotalEx === "string" && rawLineTotalEx.trim() === "") ||
    (typeof rawLineTotalEx !== "number" &&
      typeof rawLineTotalEx !== "string")
  ) {
    throw new TradeInvoiceMoneyError(
      "LINE_AMOUNT_UNRESOLVED",
      "Trade invoice line is missing a validated line_total_ex amount",
    );
  }
  const lineTotalEx = Number(rawLineTotalEx);
  if (!Number.isFinite(lineTotalEx)) {
    throw new TradeInvoiceMoneyError(
      "LINE_AMOUNT_UNRESOLVED",
      "Trade invoice line is missing a validated line_total_ex amount",
    );
  }

  const hours = Number(line.total_hours);
  const hourlyRate = Number(line.hourly_rate);
  if (
    Number.isFinite(hours) && hours > 0 && Number.isFinite(hourlyRate) &&
    hourlyRate !== 0
  ) {
    const derived = round2(hours * hourlyRate);
    if (!closeMoney(derived, lineTotalEx)) {
      throw new TradeInvoiceMoneyError(
        "LINE_AMOUNT_UNRESOLVED",
        "Trade invoice hours and rate do not match line_total_ex",
      );
    }
    return {
      quantity: hours,
      unitAmount: hourlyRate,
      lineTotalEx: round2(lineTotalEx),
      basis: "hours_rate",
    };
  }

  const quantity = Number(line.quantity);
  const unitRate = Number(line.unit_rate);
  if (
    Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitRate) &&
    unitRate !== 0
  ) {
    const derived = round2(quantity * unitRate);
    if (!closeMoney(derived, lineTotalEx)) {
      throw new TradeInvoiceMoneyError(
        "LINE_AMOUNT_UNRESOLVED",
        "Trade invoice quantity and rate do not match line_total_ex",
      );
    }
    return {
      quantity,
      unitAmount: unitRate,
      lineTotalEx: round2(lineTotalEx),
      basis: "quantity_rate",
    };
  }

  // Older work-order rows persisted the authoritative extended amount but no
  // reconstructable quantity/rate pair. Retry from that validated amount as a
  // single line; never reinterpret metres as hours or invent a synthetic rate.
  return {
    quantity: 1,
    unitAmount: round2(lineTotalEx),
    lineTotalEx: round2(lineTotalEx),
    basis: "line_total_ex",
  };
}

function lineGrossCents(line: TradeInvoiceXeroLine): number {
  const quantity = Number(line.Quantity ?? 1);
  const unitAmount = Number(line.UnitAmount ?? 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(unitAmount)) {
    throw new TradeInvoiceMoneyError(
      "XERO_GROSS_MISMATCH",
      "Trade invoice has a non-numeric Xero line amount",
    );
  }
  return toCents(quantity * unitAmount);
}

function rateLabel(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function moneyLabel(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function isTradeInvoiceSuperXeroLine(
  line: TradeInvoiceXeroLine | null | undefined,
): boolean {
  return /superannuation guarantee/i.test(String(line?.Description || ""));
}

export function withTradeIdentityOnXeroDescription(
  description: unknown,
  tradeName: unknown,
): string {
  const text = String(description || "").trim() || "Trade invoice line";
  const name = String(tradeName || "").trim();
  if (!name) return text;
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  if (firstLine.toLowerCase() === name.toLowerCase()) return text;
  return `${name}\n${text}`;
}

export function formatTradeInvoiceSuperWithheldDescription(
  money: TradeInvoiceMoney,
  tradeName?: unknown,
): string {
  const name = String(tradeName || "").trim() || "the trade";
  return [
    `Superannuation Guarantee ${rateLabel(money.super_rate)} withheld from ${name}`,
    `Paid to the super fund separately — not part of the amount payable to ${name}`,
    `Gross labour ${moneyLabel(money.gross_earned)}. Super withheld ${
      moneyLabel(money.super_amount)
    }.`,
  ].join("\n");
}

export function splitTradeInvoiceXeroLines(
  grossLines: TradeInvoiceXeroLine[],
  money: TradeInvoiceMoney,
  options: { superAccountCode: string; tradeName?: string | null },
): TradeInvoiceXeroLine[] {
  if (!Array.isArray(grossLines) || grossLines.length === 0) {
    throw new TradeInvoiceMoneyError(
      "XERO_GROSS_MISMATCH",
      "Trade invoice has no Xero lines to split",
    );
  }

  const sourceCents = grossLines.map(lineGrossCents);
  const sourceTotalCents = sourceCents.reduce((sum, amount) => sum + amount, 0);
  const grossCents = toCents(money.gross_earned);
  if (grossCents <= 0 || Math.abs(sourceTotalCents - grossCents) > 1) {
    throw new TradeInvoiceMoneyError(
      "XERO_GROSS_MISMATCH",
      `Xero gross lines ${
        moneyLabel(fromCents(sourceTotalCents))
      } do not match gross earned ${moneyLabel(money.gross_earned)}`,
    );
  }

  const taxType = money.gst_on ? "INPUT" : "NONE";
  // Labour stays at the work amounts. Super is a MINUS so the bill total is
  // the cash payable to the trade (OSCO payout). Super is paid to the fund
  // separately and is not a taxable supply, so it is always TaxType NONE.
  const labourLines = grossLines.map((line) => {
    const { LineAmount: _lineAmount, ...rest } = line;
    return {
      ...rest,
      Description: withTradeIdentityOnXeroDescription(
        line.Description || "Trade invoice line",
        options.tradeName,
      ),
      TaxType: taxType,
    };
  });

  labourLines.push({
    Description: formatTradeInvoiceSuperWithheldDescription(
      money,
      options.tradeName,
    ),
    Quantity: 1,
    UnitAmount: -round2(money.super_amount),
    AccountCode: options.superAccountCode,
    TaxType: "NONE",
    Tracking: [],
  });

  return labourLines;
}

export function assertReturnedTradeInvoiceXeroSplit(
  value: unknown,
  money: TradeInvoiceMoney,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TradeInvoiceMoneyError(
      "XERO_RETURNED_SPLIT_INVALID",
      "Xero did not return trade invoice lines to verify the super split",
    );
  }

  const lines = value as TradeInvoiceXeroLine[];
  const superLines = lines.filter((line) => isTradeInvoiceSuperXeroLine(line));
  const labourLines = lines.filter((line) => !isTradeInvoiceSuperXeroLine(line));
  const expectedLabourTaxType = money.gst_on ? "INPUT" : "NONE";
  const totalCents = lines.reduce(
    (sum, line) => sum + lineGrossCents(line),
    0,
  );
  const labourCents = labourLines.reduce(
    (sum, line) => sum + lineGrossCents(line),
    0,
  );
  const superCents = superLines.reduce(
    (sum, line) => sum + lineGrossCents(line),
    0,
  );
  const expectedSuperCents = -toCents(money.super_amount);
  const expectedNetCents = toCents(money.net_pay);
  const expectedGrossCents = toCents(money.gross_earned);

  if (
    superLines.length !== 1 ||
    Math.abs(labourCents - expectedGrossCents) > 1 ||
    Math.abs(superCents - expectedSuperCents) > 1 ||
    Math.abs(totalCents - expectedNetCents) > 1 ||
    superLines.some((line) => line.TaxType !== "NONE") ||
    labourLines.some((line) => line.TaxType !== expectedLabourTaxType)
  ) {
    throw new TradeInvoiceMoneyError(
      "XERO_RETURNED_SPLIT_INVALID",
      "Xero returned a trade bill without labour at the work amounts and super withheld as a minus",
    );
  }
}

export function assertExistingTradeInvoiceXeroBill(
  bill: unknown,
  expectedBillId: unknown,
  money: TradeInvoiceMoney,
): TradeInvoiceXeroIdentity {
  const record = bill && typeof bill === "object"
    ? bill as Record<string, unknown>
    : {};
  const identity = {
    xeroBillId: String(record.InvoiceID || "").trim(),
    xeroBillNumber: String(record.InvoiceNumber || "").trim(),
  };
  if (
    !identity.xeroBillId ||
    identity.xeroBillId !== String(expectedBillId || "").trim()
  ) {
    throw new TradeInvoiceMoneyError(
      "XERO_RETURNED_SPLIT_INVALID",
      "Xero did not return the exact checkpointed trade bill",
    );
  }
  assertReturnedTradeInvoiceXeroSplit(record.LineItems, money);
  return identity;
}

export async function checkpointAndAssertReturnedTradeInvoiceXeroSplit(
  input: {
    bill: unknown;
    money: TradeInvoiceMoney;
    checkpointIdentity: (
      identity: TradeInvoiceXeroIdentity,
    ) => Promise<void>;
  },
): Promise<TradeInvoiceXeroIdentity> {
  const bill = input.bill && typeof input.bill === "object"
    ? input.bill as Record<string, unknown>
    : {};
  const identity = {
    xeroBillId: String(bill.InvoiceID || "").trim(),
    xeroBillNumber: String(bill.InvoiceNumber || "").trim(),
  };
  if (!identity.xeroBillId) {
    throw new TradeInvoiceMoneyError(
      "XERO_RETURNED_SPLIT_INVALID",
      "Xero did not return an invoice ID for the trade bill",
    );
  }

  // Xero has already created the bill at this boundary. Persist its identity
  // before inspecting returned lines so a mixed-version/gross-only response is
  // recoverable and can never become an invisible duplicate on retry.
  await input.checkpointIdentity(identity);
  assertReturnedTradeInvoiceXeroSplit(bill.LineItems, input.money);
  return identity;
}
