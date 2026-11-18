// P1-05.8: a send never fails. With trade_line_hold_v1 on and the pay rule
// applying to the week, the lines a trade sends are sorted by the pure
// classifier (trade_line_hold.ts): backed lines become the week's invoice as
// before, held lines are saved on one holding invoice for the office, and the
// office is told line by line. With the switch off, or the pay rule not
// applying, neither door calls anything here (switch off equals main).
import {
  classifyLines,
  type ClassifiedLine,
  type HoldLine,
  type HoldReason,
  type LineHoldFacts,
  readLineHoldFacts,
} from "./trade_line_hold.ts";
import {
  readTradePayRule,
  type readTradePaySettings,
  tradePayBasisFor,
} from "./trade_pay_rule.ts";
import { WEEKLY_INVOICE_DEDUCTION_LINE_TYPES } from "./trade_invoice_weekly.ts";
import { countsAgainstWorkOrder } from "./work_order_total_cap.ts";

/** Director rule 21: logs and error text carry codes and ids only, never a
 * database message (it can quote row values). */
export class LineSendFault extends Error {}
export function lineSendLogCode(error: unknown): string {
  if (error instanceof LineSendFault) return error.message;
  if (typeof error === "string" && /^[a-z_]{1,40}$/.test(error)) return error;
  const code = (error as any)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : "error";
}
const fault = (what: string, error?: unknown) =>
  new LineSendFault(error === undefined ? what : `${what}:${lineSendLogCode(error)}`);


export const TRADE_LINE_HOLD_FLAG = "trade_line_hold_v1";
export const HOLDING_INVOICE_DESCRIPTION_SUFFIX = " (part over the job's amount)";

// Ruling 2 (18 Nov 2026): a deduction is never held and never dropped, so it
// always stays on the standard invoice, and holding a line never raises pay.
const DEDUCTION_TYPES = new Set<string>(WEEKLY_INVOICE_DEDUCTION_LINE_TYPES);
// The reasons a job needs a work order (step 9: one office item per job).
const NO_WORK_ORDER_REASONS = new Set<string>([
  "no_work_order",
  "no_amount",
  "hourly_no_maximum",
]);
const OFFICE_WORDS: Record<string, string> = {
  no_work_order: "This job has no work order yet.",
  no_amount: "This job's work order has no amount yet.",
  over_amount: "This line goes over the job's work order amount.",
  hourly_no_maximum: "This hourly job has no maximum yet.",
  no_job: "This line is not on a job.",
  not_job_work: "This work is not on a job and needs approval.",
  reimbursement: "This receipt is waiting for approval.",
  not_on_crew: "This trade is not booked on the job that week.",
  commission_no_figure: "This job has no commission figure yet.",
  rate_above_rule: "Held for the office to check",
};
export const OPEN_WORK_ORDER_WORDS =
  "Open a work order for this job and set its amount. The waiting lines are released when it is approved.";

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100);
const money = (v: unknown) => cents(v) / 100;
const key = (v: unknown) => String(v ?? "").trim().toLowerCase();

export type SendRow = Record<string, any>;
export type HeldRow = SendRow & {
  hold_reason: HoldReason;
  hold_detail: Record<string, unknown>;
  office_review_status: "awaiting";
  sent_amount_ex: number;
  words: string;
};
export type SortedSend = {
  backed: SendRow[];
  held: HeldRow[];
  skipped: Array<{ row: SendRow; reason: "not_yours" | "claimed" }>;
};

/** Step 1: the switch is on and the new pay rule applies to the week.
 * Anything unreadable reads as off, so the door behaves exactly as today. */
export async function lineHoldSendApplies(
  client: any,
  payDay: unknown,
  settingsRead?: ReturnType<typeof readTradePaySettings>,
): Promise<boolean> {
  try {
    const flag = await client.from("feature_flags").select("enabled")
      .eq("flag_name", TRADE_LINE_HOLD_FLAG).limit(1);
    if (flag?.error || !Array.isArray(flag?.data)) return false;
    if (flag.data[0]?.enabled !== true) return false;
    const rule = await readTradePayRule(client, settingsRead);
    if (!rule.ok) return false;
    return tradePayBasisFor(rule, payDay) !== null;
  } catch {
    return false;
  }
}

export function isKeptDeduction(row: SendRow): boolean {
  return DEDUCTION_TYPES.has(key(row?.line_type)) ||
    cents(row?.line_total_ex) < 0;
}

function hasUnitRate(row: SendRow): boolean {
  return row?.unit_rate !== null && row?.unit_rate !== undefined &&
    Number(row.unit_rate) !== 0;
}

/** The sorter's view of an invoice line row. */
export function holdLineFromRow(
  row: SendRow,
  weekStart: string | null,
  index: number,
): HoldLine {
  const unit = hasUnitRate(row);
  const rate = unit
    ? Number(row.unit_rate)
    : Number(row.hourly_rate ?? row.rate ?? 0);
  const hours = row.total_hours === null || row.total_hours === undefined
    ? null
    : Number(row.total_hours);
  return {
    _src: index,
    job_id: row.job_id || null,
    line_type: String(row.line_type || "labour"),
    line_total_ex: money(row.line_total_ex),
    rate,
    rate_source: row._serverPriced === true || row._weeklyServerResolved === true
      ? "server_resolved"
      : "trade",
    total_hours: hours,
    ...(row.quantity === null || row.quantity === undefined
      ? {}
      : { quantity: Number(row.quantity) }),
    ...(weekStart ? { week_start: weekStart } : {}),
    ...(row.work_date || row.line_date
      ? { work_date: String(row.work_date || row.line_date) }
      : {}),
    ...(row.start_time ? { start_time: row.start_time } : {}),
    ...(row.finish_time ? { finish_time: row.finish_time } : {}),
    description: String(row.description ?? ""),
    expense_receipt_id: row.expense_receipt_id || null,
    not_job_work_type_id: row.not_job_work_type_id || null,
    suggested: row.suggested ?? null,
  };
}

/** One classified part back onto the row it came from. Only the hold mode
 * keys and what the sorter changed move; everything else is the trade's. */
function rowFromPart(row: SendRow, part: ClassifiedLine): SendRow {
  const out: SendRow = {
    ...row,
    line_total_ex: money(part.line_total_ex),
    sent_amount_ex: money(part.sent_amount_ex),
  };
  if (part.split_group_id) {
    // Ruling 1: only a same-rate hours split, exact to the cent.
    out.split_group_id = part.split_group_id;
    out.description = part.description;
    out.total_hours = part.total_hours;
    if (row.quantity !== null && row.quantity !== undefined) {
      out.quantity = part.total_hours;
    }
  }
  if (key(row.line_type) === "commission" && cents(part.line_total_ex) !== cents(row.line_total_ex)) {
    // The server's figure (or zero while the job has none) replaces the ask.
    if (row.quantity !== null && row.quantity !== undefined) out.quantity = 1;
    if (hasUnitRate(row) || row.unit_rate === 0) out.unit_rate = money(part.line_total_ex);
    else if (row.hourly_rate !== null && row.hourly_rate !== undefined) {
      out.hourly_rate = money(part.line_total_ex);
      if (row.total_hours !== null && row.total_hours !== undefined) out.total_hours = 1;
    }
  }
  return out;
}

/** Pure: sort the send's rows into what is paid this week and what waits for
 * the office. Deductions always stay backed. Row order is kept. */
export function sortSendRows(
  rows: readonly SendRow[],
  facts: LineHoldFacts,
  weekStart: string | null,
): SortedSend {
  const candidates: HoldLine[] = [];
  rows.forEach((row, index) => {
    if (!isKeptDeduction(row)) candidates.push(holdLineFromRow(row, weekStart, index));
  });
  const result = classifyLines(candidates, facts, { sameRateSplitOnly: true });
  const backedBySrc = new Map<number, ClassifiedLine[]>();
  for (const part of result.backed) {
    const list = backedBySrc.get(part._src) ?? [];
    list.push(part);
    backedBySrc.set(part._src, list);
  }
  const backed: SendRow[] = [];
  rows.forEach((row, index) => {
    if (isKeptDeduction(row)) {
      backed.push({ ...row, sent_amount_ex: money(row.line_total_ex) });
      return;
    }
    for (const part of backedBySrc.get(index) ?? []) backed.push(rowFromPart(row, part));
  });
  const held: HeldRow[] = result.held.map((part) => {
    const row = rows[part._src];
    const { _rateHold: _r, ...rest } = rowFromPart(row, part);
    return {
      ...rest,
      hold_reason: part.hold_reason!,
      hold_detail: { ...(part.hold_detail ?? {}) },
      office_review_status: "awaiting" as const,
      words: part.words ?? "",
    } as HeldRow;
  });
  const skipped = result.skipped_items.map((s) => ({
    row: rows[candidates[s.index]._src],
    reason: s.reason,
  }));
  return { backed, held, skipped };
}

/** Reads the facts (one batch) and sorts. A failed read throws
 * LineHoldFactsUnreadable; the caller saves nothing and answers 503. */
export async function readAndSortSend(
  client: any,
  userId: string,
  rows: readonly SendRow[],
  weekStart: string | null,
): Promise<{ sorted: SortedSend; facts: LineHoldFacts }> {
  const lines = rows
    .map((row, index) => isKeptDeduction(row) ? null : holdLineFromRow(row, weekStart, index))
    .filter((line): line is HoldLine => line !== null);
  const facts = await readLineHoldFacts(client, userId, lines);
  return { sorted: sortSendRows(rows, facts, weekStart), facts };
}

/** Step 8: after a guard refusal, every line on that job is held over_amount. */
export function holdWholeJob(sorted: SortedSend, jobId: string): SortedSend {
  const moved = sorted.backed.filter((row) =>
    String(row.job_id || "") === jobId && !isKeptDeduction(row)
  );
  if (moved.length === 0) return sorted;
  const backed = sorted.backed.filter((row) => !moved.includes(row));
  const held = [...sorted.held];
  for (const part of moved) {
    // A split part goes back together with its held part: one whole line.
    let row: SendRow = part;
    if (part.split_group_id) {
      const sibling = held.findIndex((h) => h.split_group_id === part.split_group_id);
      if (sibling >= 0) {
        const other = held.splice(sibling, 1)[0];
        const add = (a: unknown, b: unknown) =>
          a === null || a === undefined ? a : money(Number(a) + Number(b ?? 0));
        row = {
          ...part,
          line_total_ex: money(cents(part.line_total_ex) / 100 + cents(other.line_total_ex) / 100),
          sent_amount_ex: money(Number(part.sent_amount_ex ?? 0) + Number(other.sent_amount_ex ?? 0)),
          total_hours: add(part.total_hours, other.total_hours),
          quantity: add(part.quantity, other.quantity),
        };
      }
      delete row.split_group_id;
    }
    const { _rateHold: _r, ...rest } = row;
    held.push({
      ...rest,
      hold_reason: "over_amount",
      hold_detail: {
        job_number: row.job_number ?? null,
        allowed_ex: null,
        left_ex: null,
        asked_ex: money(row.line_total_ex),
        expected: row.suggested ?? null,
        job_amount_guard: true,
      },
      office_review_status: "awaiting",
      sent_amount_ex: money(row.sent_amount_ex ?? row.line_total_ex),
      words: "With the office: this goes over the job's work order amount.",
    });
  }
  return { ...sorted, backed, held };
}

/** P1-05.9's database guard: a backed line that would take a job over its
 * amount when another invoice took the room in the same moment. */
export function jobAmountGuardJob(error: unknown): string | null | undefined {
  const e = error as { message?: unknown; details?: unknown; detail?: unknown } | null;
  const text = `${e?.message ?? ""} ${e?.details ?? ""} ${e?.detail ?? ""}`;
  if (!text.includes("job_amount_guard")) return undefined;
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(
    `${e?.details ?? ""} ${e?.detail ?? ""}`,
  );
  return id ? id[0] : null;
}

/** Stamps the send on the standard invoice the door just saved. Backed lines
 * carry their own amount as sent; a split part also carries its group. */
export async function stampStandardSend(
  client: any,
  invoiceId: string,
  sendId: string,
): Promise<void> {
  const { error } = await client.from("trade_invoices")
    .update({ send_id: sendId }).eq("id", invoiceId);
  if (error) throw fault("send_stamp_failed", error);
  const { data: lines, error: readError } = await client.from("trade_invoice_lines")
    .select("id, line_total_ex").eq("trade_invoice_id", invoiceId);
  if (readError || !Array.isArray(lines)) {
    throw fault("send_stamp_lines_unreadable");
  }
  for (const line of lines) {
    const { error: lineError } = await client.from("trade_invoice_lines")
      .update({ sent_amount_ex: money(line.line_total_ex) }).eq("id", line.id);
    if (lineError) throw fault("send_stamp_failed", lineError);
  }
}

/** Split parts keep one group id on both invoices. Stamped by position after
 * the standard save, because the persist functions insert fixed columns. */
export async function stampSplitGroups(
  client: any,
  invoiceId: string,
  backed: readonly SendRow[],
): Promise<void> {
  for (const [position, row] of backed.entries()) {
    if (!row.split_group_id) continue;
    const { error } = await client.from("trade_invoice_lines")
      .update({ split_group_id: row.split_group_id })
      .eq("trade_invoice_id", invoiceId)
      .eq("line_position", row.line_position ?? position);
    if (error) throw fault("split_stamp_failed", error);
  }
}

export type HoldingInvoiceInput = {
  orgId: string | null;
  userId: string;
  sendId: string;
  followsInvoiceId: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  invoiceSource: string;
  gstOn: boolean;
  superRate: number;
  superBasis: string | null;
  notes?: string | null;
  workOrderId?: string | null;
  jobId?: string | null;
  nextNumber: (attempt: number) => Promise<string>;
  isNumberTaken: (error: unknown) => boolean;
  lineRow: (invoiceId: string, row: SendRow) => SendRow;
  held: readonly HeldRow[];
  now?: string;
};

/** Step 5: one holding invoice. All money on the header is zero (the held
 * money check); each line owns what was sent. Saved as a draft first so no
 * live-claim trigger reads it half-built, then made pending_ops_review. */
export async function saveHoldingInvoice(
  client: any,
  input: HoldingInvoiceInput,
): Promise<{ id: string; orgId: string | null; lines: Array<{ id: string; row: HeldRow }> }> {
  const heldAt = input.now ?? new Date().toISOString();
  let invoiceId = "";
  let orgId: string | null = null;
  for (let attempt = 0;; attempt++) {
    const header = {
      ...(input.orgId ? { org_id: input.orgId } : {}),
      user_id: input.userId,
      week_start: input.weekStart,
      week_end: input.weekEnd,
      invoice_kind: "held",
      send_id: input.sendId,
      follows_invoice_id: input.followsInvoiceId,
      status: "draft",
      invoice_source: input.invoiceSource,
      ...(input.workOrderId ? { work_order_id: input.workOrderId } : {}),
      ...(input.jobId ? { job_id: input.jobId } : {}),
      subtotal_ex: 0,
      gst: 0,
      total_inc: 0,
      gst_on: input.gstOn,
      super_rate: input.superRate,
      super_amount: 0,
      gross_earned: 0,
      net_pay: 0,
      ...(input.superBasis ? { super_basis: input.superBasis } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      total_hours: 0,
      invoice_number: await input.nextNumber(attempt),
      submitted_at: heldAt,
    };
    const { data, error } = await client.from("trade_invoices")
      .insert(header).select("id, org_id").single();
    if (!error && data?.id) {
      invoiceId = String(data.id);
      orgId = data.org_id ? String(data.org_id) : null;
      break;
    }
    if (attempt < 2 && input.isNumberTaken(error)) continue;
    throw fault("holding_invoice_not_saved", error ?? "no_id");
  }
  try {
    const rows = input.held.map((row, position) => {
      const { words: _w, ...rest } = row;
      return {
        ...input.lineRow(invoiceId, { ...rest, line_position: position }),
        office_review_status: "awaiting",
        hold_reason: row.hold_reason,
        hold_detail: row.hold_detail,
        held_at: heldAt,
        sent_amount_ex: money(row.sent_amount_ex),
        split_group_id: row.split_group_id ?? null,
        line_position: position,
      };
    });
    const { data: saved, error: lineError } = await client.from("trade_invoice_lines")
      .insert(rows).select("id, line_position");
    if (lineError || !Array.isArray(saved) || saved.length !== rows.length) {
      throw fault("holding_lines_not_saved", lineError ?? "row_count");
    }
    const { error: liveError } = await client.from("trade_invoices")
      .update({ status: "pending_ops_review" }).eq("id", invoiceId).eq("status", "draft");
    if (liveError) throw fault("holding_invoice_not_opened", liveError);
    const byPosition = new Map(saved.map((s: any) => [Number(s.line_position), String(s.id)]));
    return {
      id: invoiceId,
      orgId,
      lines: input.held.map((row, position) => ({ id: byPosition.get(position) ?? "", row })),
    };
  } catch (error) {
    await deleteHoldingInvoice(client, invoiceId);
    throw error;
  }
}

/** Removes a holding invoice this send made (its lines first). */
export async function deleteHoldingInvoice(client: any, invoiceId: string): Promise<void> {
  if (!invoiceId) return;
  try {
    // PostgREST returns errors rather than throwing; a failed delete is logged.
    const { error: lineError } = await client.from("trade_invoice_lines").delete().eq("trade_invoice_id", invoiceId);
    if (lineError) throw lineError;
    const { error: headerError } = await client.from("trade_invoices").delete().eq("id", invoiceId).eq("invoice_kind", "held");
    if (headerError) throw headerError;
  } catch (error) {
    console.error("[ops-api] holding invoice clean-up failed:", lineSendLogCode(error), invoiceId);
  }
}

/** Step 7: the standard invoice is released the way a failed save already is
 * (status draft, so the next send replaces it), never pushed. */
export async function releaseStandardInvoice(
  client: any,
  invoiceId: string,
  note: string,
): Promise<void> {
  const { error } = await client.from("trade_invoices").update({
    status: "draft",
    query_note: note.slice(0, 500),
  }).eq("id", invoiceId).is("xero_bill_id", null);
  if (error) console.error("[ops-api] standard invoice release failed:", lineSendLogCode(error), invoiceId);
}

export type RaiseContext = {
  tradeUserId: string;
  tradeName: string | null;
  tradeRole: string | null;
  weekStart: string | null;
  facts: LineHoldFacts;
  backed: readonly SendRow[];
  /** The holding invoice's stored org_id. trade_invoice_lines has no org_id,
   * so reconcile_item_org cannot find a held line's organisation; the raise
   * passes this one (director ruling C11). Null leaves the call as before. */
  orgId?: string | null;
};

/** The four over-the-amount figures, worked in cents. Over by is claimed plus
 * the line less the job amount, never below zero; it is not the held amount
 * (a line held whole can be over by less than itself). Spec example:
 * 4,000.00 / 3,600.00 / 800.00 / 400.00. */
export function overAmountFigures(
  allowedCents: number,
  claimedCents: number,
  lineCents: number,
): { work_order_amount_ex: number; claimed_so_far_ex: number; line_amount_ex: number; over_by_ex: number } {
  return {
    work_order_amount_ex: allowedCents / 100,
    claimed_so_far_ex: claimedCents / 100,
    line_amount_ex: lineCents / 100,
    over_by_ex: Math.max(0, claimedCents + lineCents - allowedCents) / 100,
  };
}

/** Step 9: the office is told line by line, and once per job that needs a
 * work order. Each call is wrapped: a failure never changes the send. */
export async function raiseHeldLines(
  client: any,
  saved: ReadonlyArray<{ id: string; row: HeldRow }>,
  ctx: RaiseContext,
): Promise<{ raised: number; failed: number }> {
  let raised = 0, failed = 0;
  const call = async (args: Record<string, unknown>) => {
    try {
      const { error } = await client.rpc("reconcile_item_raise", args);
      if (error) throw error;
      raised++;
    } catch (error) {
      failed++;
      console.error("[ops-api] pay line raise failed (send unchanged):", lineSendLogCode(error));
    }
  };
  // The cap's own count (countsAgainstWorkOrder): a same-job deduction is
  // signed negative and lowers what this send claims, as on the invoice.
  const backedOnJob = new Map<string, number>();
  for (const row of ctx.backed) {
    if (!row.job_id || !countsAgainstWorkOrder(row.line_type)) continue;
    backedOnJob.set(String(row.job_id), (backedOnJob.get(String(row.job_id)) ?? 0) + cents(row.line_total_ex));
  }
  const ownPaidPart = new Map<string, number>();
  for (const row of ctx.backed) {
    if (row.split_group_id) ownPaidPart.set(row.split_group_id, (ownPaidPart.get(row.split_group_id) ?? 0) + cents(row.line_total_ex));
  }
  const splitWhole = new Map<string, number>();
  for (const row of [...ctx.backed, ...saved.map((s) => s.row)]) {
    if (!row.split_group_id) continue;
    splitWhole.set(row.split_group_id, (splitWhole.get(row.split_group_id) ?? 0) + cents(row.sent_amount_ex ?? row.line_total_ex));
  }
  const heldByJob = new Map<string, { reason: string; cents: number; row: HeldRow }>();
  for (const { id, row } of saved) {
    const jobId = row.job_id ? String(row.job_id) : null;
    const job = jobId ? ctx.facts.jobs[jobId] : undefined;
    const amount = money(row.sent_amount_ex);
    const over = row.hold_reason === "over_amount" && job
      ? overAmountFigures(
        cents(job.allowed_ex),
        // This send's other backed lines count; the line's own paid part does not.
        cents(job.backed_billed_ex) + (backedOnJob.get(jobId!) ?? 0) -
          (row.split_group_id ? ownPaidPart.get(row.split_group_id) ?? 0 : 0),
        row.split_group_id ? (splitWhole.get(row.split_group_id) ?? cents(amount)) : cents(amount),
      )
      : {};
    await call({
      p_kind: "pay_line_held",
      p_subject_table: "trade_invoice_lines",
      p_subject_id: id,
      p_job_ids: jobId ? [jobId] : [],
      p_suggestion: { action: "pay_line_review", expected: row.hold_detail?.expected ?? null },
      p_evidence: {
        reason: row.hold_reason,
        amount_ex: amount,
        document_date: row.work_date || row.line_date || ctx.weekStart || null,
        line_id: id,
        summary: {
          words: OFFICE_WORDS[row.hold_reason] ?? "Held for the office to check",
          trade_user_id: ctx.tradeUserId,
          trade_name: ctx.tradeName,
          trade_role: ctx.tradeRole,
          job_number: job?.job_number ?? row.job_number ?? null,
          week_start: ctx.weekStart,
          description: row.description ?? null,
          hours: row.total_hours ?? null,
          amount_ex: amount,
        },
        ...over,
        receipt_id: row.hold_reason === "reimbursement" ? (row.expense_receipt_id ?? null) : null,
        fallback_reason: (row.hold_detail?.fallback_reason as string | null | undefined) ?? null,
      },
      p_raised_by: "phase1:work_order_gate",
      ...(ctx.orgId ? { p_org_id: ctx.orgId } : {}),
    });
    const reason = row.hold_reason === "not_on_crew"
      ? String(row.hold_detail?.fallback_reason ?? "")
      : row.hold_reason;
    if (jobId && NO_WORK_ORDER_REASONS.has(reason)) {
      const entry = heldByJob.get(jobId) ?? { reason, cents: 0, row };
      entry.cents += cents(amount);
      heldByJob.set(jobId, entry);
    }
  }
  for (const [jobId, entry] of heldByJob) {
    await call({
      p_kind: "invoice_no_work_order",
      p_subject_table: "jobs",
      p_subject_id: jobId,
      p_job_ids: [jobId],
      p_suggestion: { action: "open_work_order" },
      p_evidence: {
        reason: entry.reason,
        amount_ex: entry.cents / 100,
        summary: {
          words: OPEN_WORK_ORDER_WORDS,
          job_number: ctx.facts.jobs[jobId]?.job_number ?? entry.row.job_number ?? null,
          trade_name: ctx.tradeName,
          trade_role: ctx.tradeRole,
        },
      },
      p_raised_by: "phase1:work_order_gate",
    });
  }
  return { raised, failed };
}

const dollars = (v: number) =>
  `$${money(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Step 11: what the trade is told. */
export function sendAnswer(
  sendId: string,
  backed: readonly SendRow[],
  held: ReadonlyArray<{ id: string; row: HeldRow }>,
  skipped: SortedSend["skipped"],
) {
  const inPay = backed.reduce((s, r) => s + cents(r.line_total_ex), 0);
  const heldEx = held.reduce((s, h) => s + cents(h.row.line_total_ex), 0);
  const sent = backed.reduce((s, r) => s + cents(r.sent_amount_ex ?? r.line_total_ex), 0) +
    held.reduce((s, h) => s + cents(h.row.sent_amount_ex), 0);
  return {
    send: {
      send_id: sendId,
      sent_ex: sent / 100,
      in_pay_ex: inPay / 100,
      held_ex: heldEx / 100,
      declined_ex: 0,
    },
    held_lines: held.map(({ id, row }) => ({
      line_id: id,
      job_number: row.job_number ?? (row.hold_detail?.job_number as string | null) ?? null,
      reason: row.hold_reason,
      words: row.words,
      amount_ex: money(row.line_total_ex),
    })),
    // Step 2: the existing commission refusal words, now a skipped item.
    skipped_items: skipped.map(({ row, reason }) => {
      const job = row.job_number ? `job ${row.job_number}` : "this job";
      return {
        job_number: row.job_number ?? null,
        description: row.description ?? null,
        code: reason === "not_yours" ? "commission_not_salesperson" : "commission_over_amount",
        words: reason === "not_yours"
          ? `Left out: commission on ${job} can only be claimed by the salesperson named on its accepted quote.`
          : `Left out: the commission on ${job} is already claimed in full.`,
      };
    }),
    send_words: `Sent. ${dollars(inPay / 100)} is in this week's pay. ${dollars(heldEx / 100)} is with the office.`,
  };
}

/** Step 6: the bookings behind held lines are marked invoiced by the holding
 * invoice, so my_hours does not offer them again. A booking already on a live
 * invoice is left where it is; one on a released invoice (a draft) is taken. */
export async function stampHeldBookings(
  client: any,
  userId: string,
  holdingId: string,
  ids: readonly string[],
  releasedStatuses: ReadonlySet<string>,
): Promise<void> {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (wanted.length === 0) return;
  const { data, error } = await client.from("job_assignments")
    .select("id, invoiced_in").eq("user_id", userId).in("id", wanted);
  if (error || !Array.isArray(data)) throw fault("held_bookings_unreadable");
  const refs = [...new Set(data.map((a: any) => a.invoiced_in).filter(Boolean).map(String))];
  const released = new Set<string>();
  if (refs.length > 0) {
    const { data: invoices, error: refError } = await client.from("trade_invoices")
      .select("id, status").in("id", refs);
    if (refError || !Array.isArray(invoices)) throw fault("held_booking_invoices_unreadable");
    for (const inv of invoices) {
      if (releasedStatuses.has(String(inv.status || ""))) released.add(String(inv.id));
    }
  }
  const claim = data
    .filter((a: any) => !a.invoiced_in || released.has(String(a.invoiced_in)))
    .map((a: any) => String(a.id));
  if (claim.length === 0) return;
  const claimable = [...released];
  const { error: stampError } = await client.from("job_assignments")
    .update({ invoiced_in: holdingId })
    .eq("user_id", userId)
    .in("id", claim)
    .or(claimable.length > 0
      ? "invoiced_in.is.null,invoiced_in.in.(" + claimable.join(",") + ")"
      : "invoiced_in.is.null");
  if (stampError) throw fault("held_bookings_not_stamped", stampError);
}

/** Jobs to hold whole after a second guard refusal that named no job: every
 * job this send pays against an amount. */
export function guardedJobs(sorted: SortedSend, facts: LineHoldFacts | null): string[] {
  const jobs = new Set<string>();
  for (const row of sorted.backed) {
    const jobId = String(row.job_id || "");
    if (!jobId || isKeptDeduction(row)) continue;
    if (facts?.jobs[jobId]?.workOrder?.status === "approved") jobs.add(jobId);
  }
  return [...jobs];
}
