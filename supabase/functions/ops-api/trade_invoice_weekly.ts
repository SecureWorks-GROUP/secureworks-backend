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

function lineDate(workOrder: Record<string, unknown>): string | null {
  const candidate = String(
    workOrder.completed_at || workOrder.scheduled_date || "",
  ).slice(0, 10);
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

function workOrderJob(
  workOrder: Record<string, unknown>,
): Record<string, unknown> {
  const raw = workOrder.jobs;
  if (Array.isArray(raw)) return (raw[0] || {}) as Record<string, unknown>;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function sourceDeductionBasis(
  source: Record<string, unknown>,
  amountEx: number,
) {
  const quantity = Number(source.quantity);
  const rate = Number(source.source_unit_rate);
  if (
    Number.isFinite(quantity) && quantity > 0 && Number.isFinite(rate) &&
    rate > 0 &&
    Math.abs(roundMoney(quantity * rate) - Math.abs(amountEx)) <= 0.01
  ) {
    return {
      quantity,
      unit: String(source.unit || "ea"),
      unit_rate: -roundMoney(rate),
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
    if (!line.job_id || !line.job_number) {
      throw new WeeklyInvoiceError(
        "every non-final weekly line requires a job",
      );
    }
    let block = blocks.get(line.job_id);
    if (!block) {
      block = {
        job_id: line.job_id,
        job_number: line.job_number,
        client_name: line.client_name,
        site_address: line.site_address,
        line_date: line.line_date,
        subtotal: 0,
        lines: [],
      };
      blocks.set(line.job_id, block);
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
    if (String(workOrder.status || "") !== "complete") {
      throw new WeeklyInvoiceError(
        "work order must be complete before invoicing",
      );
    }
    const job = workOrderJob(workOrder);
    const jobId = requiredText(workOrder.job_id || job.id, "job id");
    const jobNumber = requiredText(job.job_number, "job number");
    const clientName = String(job.client_name || "").trim() || null;
    const address = [
      workOrder.site_address || job.site_address,
      job.site_suburb,
    ].filter(Boolean).join(", ") || null;
    const workDate = lineDate(workOrder);
    const division = String(job.type || "").trim() || null;
    const scopeItems = Array.isArray(workOrder.scope_items)
      ? workOrder.scope_items as Array<Record<string, unknown>>
      : [];
    if (scopeItems.length === 0) {
      throw new WeeklyInvoiceError(
        `${jobNumber} has no work order scope items`,
      );
    }

    for (const item of scopeItems) {
      const quantity = positiveNumber(
        item.quantity ?? item.metres ?? item.qty ?? 1,
        `${jobNumber} scope quantity`,
      );
      const unitRate = positiveNumber(
        item.unit_price ?? item.rate ?? item.price,
        `${jobNumber} scope rate`,
      );
      lines.push({
        line_type: weeklyScopeLineType(item),
        description: requiredText(
          item.description || item.name,
          `${jobNumber} scope description`,
        ),
        quantity,
        unit: String(item.unit || (item.metres !== undefined ? "m" : "ea")),
        unit_rate: roundMoney(unitRate),
        line_total_ex: roundMoney(quantity * unitRate),
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
      const hours = positiveNumber(labour.hours, `${jobNumber} labour hours`);
      const rate = positiveNumber(labour.rate, `${jobNumber} labour rate`);
      lines.push({
        line_type: "labour_deduction",
        description: `Labour - ${userName}`,
        quantity: hours,
        unit: "hr",
        unit_rate: -roundMoney(rate),
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
    const quantity = positiveNumber(
      deduction.quantity ?? 1,
      `${description} quantity`,
    );
    const rate = positiveNumber(
      deduction.unit_rate ?? deduction.rate,
      `${description} final deduction rate`,
    );
    lines.push({
      line_type: "final_payout_deduction",
      description,
      quantity,
      unit: String(deduction.unit || "ea"),
      unit_rate: -roundMoney(rate),
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
