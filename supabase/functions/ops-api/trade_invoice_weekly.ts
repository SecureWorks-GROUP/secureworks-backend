export const WEEKLY_INVOICE_DEDUCTION_LINE_TYPES = [
  "crew_work_order_deduction",
  "labour_deduction",
  "travel_logistics_deduction",
  "materials_deduction",
  "final_payout_deduction",
] as const;

export type WeeklyInvoiceDeductionLineType =
  typeof WEEKLY_INVOICE_DEDUCTION_LINE_TYPES[number];

export type WeeklyInvoiceLine = {
  line_type: string;
  description: string;
  quantity: number;
  unit: string;
  unit_rate: number;
  line_total_ex: number;
  job_id: string | null;
  job_number: string | null;
  client_name: string | null;
  site_address: string | null;
  line_date: string | null;
  division: string | null;
  source_work_order_id: string | null;
  source_trade_invoice_line_id: string | null;
  deduction_user_id: string | null;
  deduction_assignment_id: string | null;
  deduction_trade_rate_id: string | null;
};

export type WeeklyInvoiceJobBlock = {
  source_work_order_id: string;
  job_id: string;
  job_number: string;
  client_name: string | null;
  site_address: string | null;
  line_date: string | null;
  subtotal: number;
  lines: WeeklyInvoiceLine[];
};

export type WeeklyWorkOrderInvoice = {
  lines: WeeklyInvoiceLine[];
  job_blocks: WeeklyInvoiceJobBlock[];
  final_deductions: WeeklyInvoiceLine[];
  grand_total: number;
  final_deductions_total: number;
  to_be_paid: number;
};

export class WeeklyInvoiceError extends Error {
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "WeeklyInvoiceError";
  }
}

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const perthDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Perth",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new WeeklyInvoiceError(`${label} is required`);
  return text;
}

function positiveNumber(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new WeeklyInvoiceError(`${label} must be positive`);
  }
  return numeric;
}

export function firstWorkOrderNumericValue(
  candidates: unknown[],
  fallback: number,
): number {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === "string" && candidate.trim() === "") continue;
    const numeric = Number(candidate);
    if (!Number.isFinite(numeric)) continue;
    return numeric;
  }
  return fallback;
}

// Live fencing crew-pay lines use qty/item/rate/total. Quote/material drafts
// use quantity/description/unit_price_ex. Never read unit_price_ex as trade pay.
export const WORK_ORDER_INVOICE_LIST_STATUSES = [
  "complete",
  "sent",
  "accepted",
] as const;

// Same finished set as `_JOB_STATUS_FINISHED` in index.ts — one vocabulary.
export const JOB_STATUS_FINISHED = [
  "complete",
  "completed",
  "invoiced",
  "paid",
  "closed",
  "archived",
] as const;

const FINISHED_JOB_STATUSES = new Set<string>(JOB_STATUS_FINISHED);

export function workOrderScopeLineDescription(
  item: Record<string, unknown> | null | undefined,
): string {
  for (const candidate of [item?.description, item?.name, item?.item]) {
    const text = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

export function resolveWorkOrderScopeLine(
  item: Record<string, unknown> | null | undefined,
): { qty: number; price: number; amount_ex: number } {
  const qty = roundMoney(firstWorkOrderNumericValue(
    [item?.quantity, item?.metres, item?.qty],
    1,
  ));
  const price = roundMoney(firstWorkOrderNumericValue(
    [item?.unit_price, item?.rate, item?.price],
    0,
  ));
  return { qty, price, amount_ex: roundMoney(qty * price) };
}

export function workOrderHasPricedScope(scopeItems: unknown): boolean {
  return (Array.isArray(scopeItems) ? scopeItems : []).some((raw) => {
    const item = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    const { price, amount_ex } = resolveWorkOrderScopeLine(item);
    return price > 0 && amount_ex > 0;
  });
}

export type PricedWorkOrderScopeLine = {
  item: Record<string, unknown>;
  qty: number;
  price: number;
  amount_ex: number;
  description: string;
  unit: string;
};

export function pricedWorkOrderScopeLines(
  scopeItems: unknown,
  jobNumber: string,
): PricedWorkOrderScopeLine[] {
  const items = Array.isArray(scopeItems) ? scopeItems : [];
  if (items.length === 0) {
    throw new WeeklyInvoiceError(
      `${jobNumber} has no work order scope items`,
    );
  }
  const priced: PricedWorkOrderScopeLine[] = [];
  for (const raw of items) {
    const item = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    const { qty, price, amount_ex } = resolveWorkOrderScopeLine(item);
    if (!(price > 0) || !(amount_ex > 0)) continue;
    priced.push({
      item,
      qty: roundMoney(positiveNumber(qty, `${jobNumber} scope quantity`)),
      price: roundMoney(positiveNumber(price, `${jobNumber} scope rate`)),
      amount_ex,
      description: requiredText(
        workOrderScopeLineDescription(item),
        `${jobNumber} scope description`,
      ),
      unit: String(item.unit || (item.metres !== undefined ? "m" : "ea")),
    });
  }
  if (priced.length === 0) {
    throw new WeeklyInvoiceError(
      `${jobNumber} has no priced work-order scope items`,
    );
  }
  return priced;
}

function workOrderJob(
  workOrder: Record<string, unknown>,
): Record<string, unknown> {
  const raw = workOrder.jobs;
  if (Array.isArray(raw)) return (raw[0] || {}) as Record<string, unknown>;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

export function workOrderIsInvoiceReady(
  workOrder: Record<string, unknown> | null | undefined,
): boolean {
  const status = String(workOrder?.status || "").trim().toLowerCase();
  if (status === "complete") return true;
  if (status !== "sent" && status !== "accepted") return false;
  const job = workOrderJob(workOrder || {});
  return FINISHED_JOB_STATUSES.has(
    String(job.status || "").trim().toLowerCase(),
  );
}

export function weeklyWorkOrderBusinessDate(
  workOrder: Record<string, unknown>,
): string | null {
  const completedAt = String(workOrder.completed_at ?? "").trim();
  if (completedAt) {
    const completed = new Date(completedAt);
    if (!Number.isNaN(completed.getTime())) {
      const parts = perthDateFormatter.formatToParts(completed);
      const value = (type: string) =>
        parts.find((part) => part.type === type)?.value || "";
      const candidate = `${value("year")}-${value("month")}-${value("day")}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
    }
  }
  const candidate = String(workOrder.scheduled_date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function normalizedLineHint(...values: unknown[]): string {
  return values.map((value) => String(value ?? "").toLowerCase()).join(" ");
}

export function weeklyScopeLineType(item: Record<string, unknown>): string {
  const hint = normalizedLineHint(
    item.line_type,
    item.type,
    item.category,
    item.description,
    item.name,
    item.item,
  );
  if (/travel|logistics|disposal|pickup/.test(hint)) return "travel";
  if (/material|plinth|tube|lattice/.test(hint)) return "materials";
  if (/patio/.test(hint)) return "patio";
  if (/fence|removal|install|gate|labour|labor/.test(hint)) return "labour";
  return "other";
}

export function weeklyCrewDeductionLineType(
  source: Record<string, unknown>,
): WeeklyInvoiceDeductionLineType {
  const hint = normalizedLineHint(
    source.source_line_type,
    source.description,
  );
  if (/travel|logistics|disposal|pickup/.test(hint)) {
    return "travel_logistics_deduction";
  }
  if (/material|plinth|tube|lattice/.test(hint)) {
    return "materials_deduction";
  }
  return "crew_work_order_deduction";
}

function sourceDeductionBasis(
  source: Record<string, unknown>,
  amountEx: number,
) {
  const quantity = roundMoney(Number(source.quantity));
  const rate = roundMoney(Number(source.source_unit_rate));
  if (
    Number.isFinite(quantity) && quantity > 0 && Number.isFinite(rate) &&
    rate > 0 &&
    Math.abs(roundMoney(quantity * rate) - Math.abs(amountEx)) <= 0.01
  ) {
    return {
      quantity,
      unit: String(source.unit || "ea"),
      unit_rate: -rate,
    };
  }
  // An acknowledged override/extended amount outranks stale display quantity
  // and rate facts. Persist it as one exact negative unit so every stored and
  // Xero reconstruction still multiplies to the approved source amount.
  return { quantity: 1, unit: "ea", unit_rate: amountEx };
}

export function calculateWeeklyInvoiceBreakdown(
  lines: WeeklyInvoiceLine[],
): WeeklyWorkOrderInvoice {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new WeeklyInvoiceError("weekly invoice requires at least one line");
  }

  const deductionTypes = new Set<string>(WEEKLY_INVOICE_DEDUCTION_LINE_TYPES);
  const blocks = new Map<string, WeeklyInvoiceJobBlock>();
  const finalDeductions: WeeklyInvoiceLine[] = [];
  let finalDeductionSignedTotal = 0;

  for (const line of lines) {
    if (!Number.isFinite(line.line_total_ex)) {
      throw new WeeklyInvoiceError("weekly invoice line amount is invalid");
    }
    if (deductionTypes.has(line.line_type) && line.line_total_ex >= 0) {
      throw new WeeklyInvoiceError(`${line.line_type} must be negative`);
    }
    if (line.line_type === "final_payout_deduction") {
      if (line.job_id || line.job_number) {
        throw new WeeklyInvoiceError(
          "final payout deductions cannot belong to a job",
        );
      }
      finalDeductionSignedTotal = roundMoney(
        finalDeductionSignedTotal + line.line_total_ex,
      );
      finalDeductions.push(line);
      continue;
    }
    if (!line.job_id || !line.job_number || !line.source_work_order_id) {
      throw new WeeklyInvoiceError(
        "every non-final weekly line requires a work order and job",
      );
    }
    let block = blocks.get(line.source_work_order_id);
    if (!block) {
      block = {
        source_work_order_id: line.source_work_order_id,
        job_id: line.job_id,
        job_number: line.job_number,
        client_name: line.client_name,
        site_address: line.site_address,
        line_date: line.line_date,
        subtotal: 0,
        lines: [],
      };
      blocks.set(line.source_work_order_id, block);
    } else if (block.job_id !== line.job_id) {
      throw new WeeklyInvoiceError(
        "a weekly work order cannot contain lines from multiple jobs",
      );
    }
    block.lines.push(line);
    block.subtotal = roundMoney(block.subtotal + line.line_total_ex);
  }

  const jobBlocks = [...blocks.values()];
  if (jobBlocks.length === 0) {
    throw new WeeklyInvoiceError(
      "weekly invoice requires at least one job block",
    );
  }
  for (const block of jobBlocks) {
    if (block.subtotal <= 0) {
      throw new WeeklyInvoiceError(
        `deductions cannot reduce ${block.job_number} to zero or below`,
      );
    }
  }

  const grandTotal = roundMoney(
    jobBlocks.reduce((sum, block) => sum + block.subtotal, 0),
  );
  const finalDeductionsTotal = roundMoney(-finalDeductionSignedTotal);
  const toBePaid = roundMoney(grandTotal - finalDeductionsTotal);
  const lineSum = roundMoney(
    lines.reduce((sum, line) => sum + line.line_total_ex, 0),
  );
  if (toBePaid <= 0) {
    throw new WeeklyInvoiceError(
      "final deductions cannot reduce the weekly invoice to zero or below",
    );
  }
  if (Math.abs(lineSum - toBePaid) > 0.01) {
    throw new WeeklyInvoiceError(
      "weekly invoice lines do not equal TO BE PAID",
    );
  }

  return {
    lines,
    job_blocks: jobBlocks,
    final_deductions: finalDeductions,
    grand_total: grandTotal,
    final_deductions_total: finalDeductionsTotal,
    to_be_paid: toBePaid,
  };
}

export function buildWeeklyWorkOrderInvoice(input: {
  job_blocks: Array<{
    work_order: Record<string, unknown>;
    work_date?: string | null;
    crew_deductions?: Array<Record<string, unknown>>;
    labour_deductions?: Array<Record<string, unknown>>;
  }>;
  final_deductions?: Array<Record<string, unknown>>;
}): WeeklyWorkOrderInvoice {
  if (!Array.isArray(input.job_blocks) || input.job_blocks.length === 0) {
    throw new WeeklyInvoiceError("at least one work order block is required");
  }

  const lines: WeeklyInvoiceLine[] = [];
  const seenWorkOrders = new Set<string>();
  for (const block of input.job_blocks) {
    const workOrder = block.work_order || {};
    const workOrderId = requiredText(workOrder.id, "work order id");
    if (seenWorkOrders.has(workOrderId)) {
      throw new WeeklyInvoiceError(
        `work order ${workOrderId} was selected twice`,
      );
    }
    seenWorkOrders.add(workOrderId);
    if (!workOrderIsInvoiceReady(workOrder)) {
      throw new WeeklyInvoiceError(
        "work order must be complete, or sent/accepted on a finished job, before invoicing",
      );
    }
    const job = workOrderJob(workOrder);
    const jobId = requiredText(workOrder.job_id || job.id, "job id");
    const jobNumber = requiredText(job.job_number, "job number");
    const clientName = String(job.client_name || "").trim() || null;
    const workOrderAddress = String(workOrder.site_address ?? "").trim();
    const jobAddress = String(job.site_address ?? "").trim();
    const jobSuburb = String(job.site_suburb ?? "").trim();
    const fallbackAddress = [jobAddress, jobSuburb].filter(Boolean).join(", ");
    const address = workOrderAddress || fallbackAddress || null;
    const requestedWorkDate = String(block.work_date ?? "");
    const workDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedWorkDate)
      ? requestedWorkDate
      : weeklyWorkOrderBusinessDate(workOrder);
    const division = String(job.type || "").trim() || null;
    const scopeItems = Array.isArray(workOrder.scope_items)
      ? workOrder.scope_items as Array<Record<string, unknown>>
      : [];
    for (const priced of pricedWorkOrderScopeLines(scopeItems, jobNumber)) {
      lines.push({
        line_type: weeklyScopeLineType(priced.item),
        description: priced.description,
        quantity: priced.qty,
        unit: priced.unit,
        unit_rate: priced.price,
        line_total_ex: priced.amount_ex,
        job_id: jobId,
        job_number: jobNumber,
        client_name: clientName,
        site_address: address,
        line_date: workDate,
        division,
        source_work_order_id: workOrderId,
        source_trade_invoice_line_id: null,
        deduction_user_id: null,
        deduction_assignment_id: null,
        deduction_trade_rate_id: null,
      });
    }

    for (const source of block.crew_deductions || []) {
      const sourceLineId = requiredText(
        source.line_id,
        `${jobNumber} crew charge line id`,
      );
      const amountEx = roundMoney(Number(source.amount_ex));
      if (!Number.isFinite(amountEx) || amountEx >= 0) {
        throw new WeeklyInvoiceError("crew deduction must be negative");
      }
      const basis = sourceDeductionBasis(source, amountEx);
      const tradeName = requiredText(
        source.trade_name,
        `${jobNumber} crew trade name`,
      );
      lines.push({
        line_type: weeklyCrewDeductionLineType(source),
        description: `Work Order - ${tradeName}: ${
          requiredText(
            source.description,
            `${jobNumber} crew charge description`,
          )
        }`,
        ...basis,
        line_total_ex: amountEx,
        job_id: jobId,
        job_number: jobNumber,
        client_name: clientName,
        site_address: address,
        line_date: workDate,
        division,
        source_work_order_id: workOrderId,
        source_trade_invoice_line_id: sourceLineId,
        deduction_user_id: null,
        deduction_assignment_id: null,
        deduction_trade_rate_id: null,
      });
    }

    for (const labour of block.labour_deductions || []) {
      const userId = requiredText(
        labour.user_id,
        `${jobNumber} labour user id`,
      );
      const userName = requiredText(
        labour.user_name,
        `${jobNumber} labour user name`,
      );
      const assignmentId = requiredText(
        labour.assignment_id,
        `${jobNumber} labour assignment id`,
      );
      const tradeRateId = requiredText(
        labour.trade_rate_id,
        `${jobNumber} labour trade rate id`,
      );
      const hours = roundMoney(
        positiveNumber(labour.hours, `${jobNumber} labour hours`),
      );
      const rate = roundMoney(
        positiveNumber(labour.rate, `${jobNumber} labour rate`),
      );
      lines.push({
        line_type: "labour_deduction",
        description: `Labour - ${userName}`,
        quantity: hours,
        unit: "hr",
        unit_rate: -rate,
        line_total_ex: -roundMoney(hours * rate),
        job_id: jobId,
        job_number: jobNumber,
        client_name: clientName,
        site_address: address,
        line_date: workDate,
        division,
        source_work_order_id: workOrderId,
        source_trade_invoice_line_id: null,
        deduction_user_id: userId,
        deduction_assignment_id: assignmentId,
        deduction_trade_rate_id: tradeRateId,
      });
    }
  }

  for (const deduction of input.final_deductions || []) {
    const description = requiredText(
      deduction.description,
      "final deduction description",
    );
    const quantity = roundMoney(positiveNumber(
      deduction.quantity ?? 1,
      `${description} quantity`,
    ));
    const rate = roundMoney(positiveNumber(
      deduction.unit_rate ?? deduction.rate,
      `${description} final deduction rate`,
    ));
    lines.push({
      line_type: "final_payout_deduction",
      description,
      quantity,
      unit: String(deduction.unit || "ea"),
      unit_rate: -rate,
      line_total_ex: -roundMoney(quantity * rate),
      job_id: null,
      job_number: null,
      client_name: null,
      site_address: null,
      line_date: null,
      division: null,
      source_work_order_id: null,
      source_trade_invoice_line_id: null,
      deduction_user_id: null,
      deduction_assignment_id: null,
      deduction_trade_rate_id: null,
    });
  }

  return calculateWeeklyInvoiceBreakdown(lines);
}

// ── Per-metre weekly work orders (Henry-class fencing managers) ────────────
//
// A per-metre trade is paid per metre of fence installed, minus the crew
// work-order charges and labour on the same job. The weekly builder only reads
// `work_orders` rows, so a completed fencing job with no ops-issued work order
// has nothing to invoice from. These helpers let the trade materialise that
// work order himself: metres are the trade's declared quantity (like hours on
// an hourly invoice), the rate is server-owned, and the row lands as a normal
// complete work order so eligibility, deductions, super and Xero run unchanged.

export const PER_METRE_FENCING_RATE = 35;
export const PER_METRE_WORK_ORDER_MARKER = "trade-app:per-metre-weekly";
export const PER_METRE_WORK_ORDER_DESCRIPTION = "Fencing installation";
export const PER_METRE_MAX_METRES = 5000;

function runLengthMetres(run: Record<string, unknown>): number {
  for (const candidate of [run.length, run.lengthM, run.totalLength]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

/** Sum of fence run lengths recorded by the scoping tool. 0 when unknown. */
export function perMetreScopeMetres(scopeJson: unknown): number {
  let scope: unknown = scopeJson;
  if (typeof scope === "string") {
    try {
      scope = JSON.parse(scope);
    } catch {
      return 0;
    }
  }
  if (!scope || typeof scope !== "object") return 0;
  const root = scope as Record<string, unknown>;
  const job = (root.job && typeof root.job === "object")
    ? root.job as Record<string, unknown>
    : (root.config && typeof root.config === "object")
    ? root.config as Record<string, unknown>
    : root;
  const runs = Array.isArray(job.runs) ? job.runs : [];
  let total = 0;
  for (const raw of runs) {
    if (raw && typeof raw === "object") {
      total += runLengthMetres(raw as Record<string, unknown>);
    }
  }
  if (total === 0) {
    for (const candidate of [job.totalLength, job.totalMetres]) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        total = numeric;
        break;
      }
    }
  }
  return roundMoney(total);
}

export function perMetreQuantity(value: unknown): number {
  const metres = Number(value);
  if (!Number.isFinite(metres) || metres <= 0) {
    throw new WeeklyInvoiceError("Enter the metres installed (more than zero)");
  }
  if (metres > PER_METRE_MAX_METRES) {
    throw new WeeklyInvoiceError(
      `Metres installed cannot exceed ${PER_METRE_MAX_METRES}`,
    );
  }
  return roundMoney(metres);
}

/** Scope in the crew-pay grammar the weekly builder already prices. */
export function buildPerMetreWorkOrderScope(
  metres: unknown,
  rate: number = PER_METRE_FENCING_RATE,
): Array<Record<string, unknown>> {
  const quantity = perMetreQuantity(metres);
  const unitRate = roundMoney(positiveNumber(rate, "per-metre rate"));
  return [{
    description: PER_METRE_WORK_ORDER_DESCRIPTION,
    quantity,
    unit: "m",
    rate: unitRate,
    total: roundMoney(quantity * unitRate),
  }];
}

export function isPerMetreWorkOrder(
  workOrder: Record<string, unknown> | null | undefined,
): boolean {
  return String(workOrder?.special_instructions || "").includes(
    PER_METRE_WORK_ORDER_MARKER,
  );
}

export type PerMetreWorkOrderPlan = {
  mode: "create" | "update";
  existing_work_order_id: string | null;
  work_date: string;
  metres: number;
  rate: number;
  scope_items: Array<Record<string, unknown>>;
  amount_ex: number;
};

/**
 * Decide whether a per-metre trade may create (or re-measure) the work order
 * for one job. Pure: every fact is passed in, nothing is read here.
 */
export function planPerMetreWorkOrder(input: {
  viewer: { id: string; orgId: string; managedVerticals: string[] };
  isPerMetreUser: boolean;
  job: Record<string, unknown> | null | undefined;
  jobVertical: string;
  assignments: Array<Record<string, unknown>>;
  existingWorkOrders: Array<Record<string, unknown>>;
  existingWorkOrderInvoiceUses: Array<Record<string, unknown>>;
  metres: unknown;
  work_date?: unknown;
  rate?: number;
}): PerMetreWorkOrderPlan {
  if (!input.isPerMetreUser) {
    throw new WeeklyInvoiceError(
      "Only per-metre trades can create a weekly work order for a job",
    );
  }
  const job = input.job;
  if (!job || String(job.org_id || "") !== String(input.viewer.orgId)) {
    throw new WeeklyInvoiceError("Job not found in your business");
  }
  const vertical = String(input.jobVertical || "").trim().toLowerCase();
  const managed = (input.viewer.managedVerticals || []).map((value) =>
    String(value || "").trim().toLowerCase()
  );
  if (!vertical || !managed.includes(vertical)) {
    throw new WeeklyInvoiceError(
      "This job is outside the work you manage, so it cannot be invoiced per metre",
    );
  }
  const ownAssignments = input.assignments.filter((assignment) =>
    String(assignment.user_id || "") === String(input.viewer.id) &&
    String(assignment.status || "").toLowerCase() !== "cancelled"
  );
  if (ownAssignments.length === 0) {
    throw new WeeklyInvoiceError(
      "You are not assigned to this job, so it cannot be invoiced per metre. Ask the office to add the assignment.",
    );
  }
  const requestedDate = String(input.work_date ?? "").slice(0, 10);
  let workDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : "";
  if (!workDate) {
    const dates = ownAssignments
      .map((assignment) => String(assignment.scheduled_date || "").slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    workDate = dates[dates.length - 1] || "";
  }
  if (!workDate) {
    throw new WeeklyInvoiceError("A work date is required for this job");
  }
  const metres = perMetreQuantity(input.metres);
  const rate = roundMoney(positiveNumber(
    input.rate ?? PER_METRE_FENCING_RATE,
    "per-metre rate",
  ));
  const scopeItems = buildPerMetreWorkOrderScope(metres, rate);

  const live = input.existingWorkOrders.filter((workOrder) => {
    const status = String(workOrder.status || "").toLowerCase();
    return status !== "cancelled" && status !== "deleted";
  });
  if (live.length === 0) {
    return {
      mode: "create",
      existing_work_order_id: null,
      work_date: workDate,
      metres,
      rate,
      scope_items: scopeItems,
      amount_ex: roundMoney(metres * rate),
    };
  }
  const own = live.find((workOrder) =>
    isPerMetreWorkOrder(workOrder) &&
    String(workOrder.assigned_user_id || "") === String(input.viewer.id)
  );
  if (!own || live.length > 1) {
    throw new WeeklyInvoiceError(
      "This job already has a work order. Use that work order on the weekly invoice, or ask the office to fix it.",
    );
  }
  const heldByInvoice = input.existingWorkOrderInvoiceUses.some((use) =>
    String(use.source_work_order_id || use.work_order_id || "") ===
      String(own.id || "") &&
    String(use.status || "").toLowerCase() !== "draft" &&
    String(use.status || "").toLowerCase() !== "ops-reject" &&
    String(use.status || "").toLowerCase() !== "failed"
  );
  if (heldByInvoice) {
    throw new WeeklyInvoiceError(
      "This work order has already been invoiced, so its metres cannot change",
    );
  }
  return {
    mode: "update",
    existing_work_order_id: String(own.id || ""),
    work_date: workDate,
    metres,
    rate,
    scope_items: scopeItems,
    amount_ex: roundMoney(metres * rate),
  };
}
