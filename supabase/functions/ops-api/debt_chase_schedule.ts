// Debt chase schedule: the captain's chase ladders as data, and today's step per payer.
// Pure logic, no I/O. Plan: docs/debt-book/PLAN.md sections 4 and 6 step 2; the captain's
// rulings are word for word in docs/debt-book/DECISIONS.md. The book it reads is the
// debt_book action's `invoices[]` (debt_book.ts); the log it reads is payment_chase_logs,
// mapped by debtChaseEventFromLogRow. Screen contract: secureworks-ux docs/clear-debt-desk.md.
//
// How today's step is worked out:
//   - Homeowners (payer "client", debt): one ladder per payer, day 1 friendly text, day 2
//     firm text with the pay link, day 3 Shaun calls, day 7 Jan visits. The next step fires
//     only when the last outcome did not resolve it, never before its day, and never two
//     steps on one Perth day. The launch backlog starts everyone at the friendly text, one
//     step a day. After Jan's visit the payer stays on Jan's list until paid.
//   - Builders (MLB, AJ, other builders): each invoice goes on the Monday statement once it
//     is 14 days past its invoice date, every Monday while unpaid; any invoice 30 days past
//     its due date also gets one call from Shaun; a call logged before that day (such as a
//     broken-promise call) does not count as it. An invoice with an open or broken promise
//     stays on the statement; logging the statement does not clear a promise.
//   - Builder and deposit items are per invoice: each invoice line carries its own promise,
//     and the item's promise is set only when every line agrees. Homeowner items keep one
//     payer-level promise and null lines.
//   - Deposits and before-work invoices: one friendly reminder once overdue. A missed promise
//     returns at the top as a broken-promise reminder, even after the reminder was sent. The
//     60-day cancel list is plan step 7, not built here.
//   - Promises pause chasing until the promised date. The morning after it, the promise is
//     kept when Xero shows the promised amount paid since the promise (the invoice's amount
//     due at the promise less today's amount due covers the promised amount); the ladder
//     then carries on as normal. Otherwise, unpaid or short, it returns at the top marked
//     "promise broken", at the next step. A promise row without the amount due at the
//     promise cannot show a part payment, so an invoice still open after the date is
//     broken. Plan step 3 (logging) must add an amount_due_at_promise column to
//     payment_chase_logs and stamp it from Xero when a promise is logged. Disputed and
//     "says paid" hold the invoice for a check.
//   - Holds from the book (check first, fix first) show with their reason and no step.
//
// Every item carries `held_step`. On a hold item (group "hold": a book hold, check first or
// fix first, or an outcome hold, disputed or says paid) `step` stays null and `held_step`
// is the step the payer would be on if not held: for a homeowner the next ladder step after
// the last desk step (respecting the Jan start and the ladder end); for a builder
// builder_call when an invoice is 30 days overdue and not called since that day, else
// statement; for a deposit deposit_reminder when it is overdue and not yet reminded. It is
// null when no step applies (not yet due, no due date, already reminded), and null on
// every item that is not a hold.
//
// Only the desk's own chase-log rows (those carrying a schedule step or an outcome code)
// move the schedule. Older rows are history: that is what starts the launch backlog at the
// friendly text.

import { resolvePayer } from "./debt_book_rules.ts";
import type { DebtDeskDraft } from "./debt_draft_templates.ts";

export type DebtChaseStep =
  | "friendly_text"
  | "firm_text"
  | "call"
  | "jan_visit"
  | "statement"
  | "builder_call"
  | "deposit_reminder";
export type DebtChaseGroup =
  | "broken_promise"
  | "jan"
  | "call"
  | "text"
  | "statement"
  | "deposit_reminder";
export type DebtChaseOutcome =
  | "no_answer"
  | "spoke"
  | "promised"
  | "disputed"
  | "says_paid";

export const DEBT_CHASE_OUTCOMES: DebtChaseOutcome[] = [
  "no_answer",
  "spoke",
  "promised",
  "disputed",
  "says_paid",
];

/** Outcomes that resolve the step for now: the ladder stops until someone checks. */
const HOLDING_OUTCOMES: Partial<Record<DebtChaseOutcome, string>> = {
  disputed: "the payer disputed it",
  says_paid: "the payer says paid: check Xero first",
};

export const DEBT_CHASE_STEPS: Record<
  DebtChaseStep,
  { group: Exclude<DebtChaseGroup, "broken_promise">; label: string }
> = {
  friendly_text: { group: "text", label: "Day 1: friendly text" },
  firm_text: { group: "text", label: "Day 2: firm text with the pay link" },
  call: { group: "call", label: "Day 3: Shaun calls" },
  jan_visit: { group: "jan", label: "Day 7: Jan visits" },
  statement: { group: "statement", label: "Monday statement" },
  builder_call: { group: "call", label: "30 days overdue: Shaun calls" },
  deposit_reminder: {
    group: "deposit_reminder",
    label: "One friendly reminder about the job",
  },
};

export const DEBT_CHASE_SCHEDULES = {
  homeowner: {
    ladder: [
      { step: "friendly_text", day: 1 },
      { step: "firm_text", day: 2 },
      { step: "call", day: 3 },
      { step: "jan_visit", day: 7 },
    ] as ReadonlyArray<{ step: DebtChaseStep; day: number }>,
    steps_per_day: 1,
    decision:
      'Q12, 2026-09-29: "12 = 1 day, 2 days firm, 3 days call, 7 days it moves up to Jan."; round 6: "Everyone starts at the friendly text, one step a day"',
  },
  builder: {
    statement_after_invoice_days: 14,
    statement_weekday: "monday" as const,
    call_at_days_overdue: 30,
    decision:
      'Q13: "give them 14 days. then a statement."; round 6: "14 days from invoice date, Monday statements, same for all builders"; round 5: the call at 30 days overdue',
  },
  deposit: {
    reminders: 1,
    cancel_list_after_days: 60,
    decision:
      'round 2: "Maybe there can be 1 chase message, more friendly one to remind about the job."; Q11: "deposit cancel after 60 days no payment/reply/job progress"',
  },
  promise: {
    broken_returns_next_morning: true,
    decision:
      'Q14: "record amount + date; missed promise returns to top next day"',
  },
} as const;

export const DEBT_CHASE_GROUP_ORDER: DebtChaseGroup[] = [
  "broken_promise",
  "jan",
  "call",
  "text",
  "statement",
  "deposit_reminder",
];

/** Deposits the plan names as not genuinely unpaid: no reminder goes to them. */
export const DEBT_CHASE_NO_REMINDER: ReadonlyArray<
  { invoice_number: string; reason: string; decision: string }
> = [
  {
    invoice_number: "INV-1601",
    reason:
      "deposit raised late to match a bank transfer already received: nothing to remind",
    decision: 'Q16: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-1602",
    reason:
      "deposit raised late to match a bank transfer already received: nothing to remind",
    decision: 'Q16: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-1603",
    reason:
      "deposit raised late to match a bank transfer already received: nothing to remind",
    decision: 'Q16: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-1119",
    reason: "a likely duplicate deposit: check it in Xero, do not remind",
    decision: "PLAN.md section 2, not debt",
  },
  {
    invoice_number: "INV-0560",
    reason: "leftover cents on a deposit: do not remind",
    decision: "PLAN.md section 2, not debt",
  },
];

/** The fields of a debt_book `invoices[]` row the schedule reads. */
export interface DebtChaseBookInvoice {
  xero_invoice_id: string;
  invoice_number: string;
  contact_id: string | null;
  contact_name: string;
  payer: string;
  kind: string;
  is_debt: boolean;
  not_debt_reason: string | null;
  hold: string | null;
  hold_reason: string | null;
  invoice_date: string | null;
  due_date: string | null;
  amount_due: number;
  days_overdue: number | null;
  start_step: string | null;
  job_id: string | null;
}

/** One desk row of the chase log, as the schedule reads it. */
export interface DebtChaseEvent {
  xero_invoice_id: string;
  at: string;
  step: DebtChaseStep | null;
  outcome: DebtChaseOutcome | null;
  promised_amount: number | null;
  promised_date: string | null;
  /**
   * The amount due when the promise was logged; null on rows that never recorded it. With
   * `covers`, it is the total due on every covered invoice.
   */
  amount_due_at_promise: number | null;
  /** Every invoice one message or promise covers (lower-case ids); null on single-invoice rows. */
  covers: string[] | null;
  by: string | null;
}

export interface DebtChaseContact {
  phone: string | null;
  email: string | null;
}

export interface DebtChasePromise {
  amount: number | null;
  date: string;
  status: "open" | "broken" | "kept";
}

export interface DebtMorningItem {
  id: string;
  payer_key: string;
  payer_name: string;
  payer: string;
  group: DebtChaseGroup | "hold";
  step: DebtChaseStep | null;
  step_label: string;
  amount: number;
  days_overdue: number | null;
  invoices: Array<{
    xero_invoice_id: string;
    invoice_number: string;
    /** The debt book's kind (deposit, progress_claim, materials, final, ...). */
    kind: string;
    amount_due: number;
    due_date: string | null;
    invoice_date: string | null;
    days_overdue: number | null;
    /** On a builder or deposit item: this invoice's own promise. Null on homeowner items. */
    promise: DebtChasePromise | null;
  }>;
  hold: "check_first" | "fix_first" | null;
  hold_reason: string | null;
  held_step: DebtChaseStep | null;
  phone: string | null;
  email: string | null;
  promise: DebtChasePromise | null;
  last_outcome:
    | { code: DebtChaseOutcome; at: string; by: string | null }
    | null;
  /** Filled by the morning list (debt_desk_drafts.ts); null on calls, statements and holds. */
  draft: DebtDeskDraft | null;
  /** Why a step that is drafted has no draft today (a missing pay link). */
  draft_problem: string | null;
}

export interface DebtMorningWaiting {
  payer_key: string;
  payer_name: string;
  invoice_numbers: string[];
  reason:
    | "not_due"
    | "no_due_date"
    | "done_today"
    | "next_step_later"
    | "statement_not_due"
    | "reminder_sent";
  next_step: DebtChaseStep | null;
  next_date: string | null;
}

export interface DebtMorningPaused {
  payer_key: string;
  payer_name: string;
  payer: string;
  invoices: DebtMorningItem["invoices"];
  amount: number;
  promise: DebtChasePromise;
  resumes_on: string;
}

// ── Chase log ──

const STEP_IDS = Object.keys(DEBT_CHASE_STEPS) as DebtChaseStep[];

function isoDateOrNull(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)
    ? v.slice(0, 10)
    : null;
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A payment_chase_logs row as a schedule event, or null when the row is not the desk's own.
 * Reads the desk columns (schedule_step, outcome_code, promised_amount, promised_date,
 * amount_due_at_promise, covers_invoice_ids) when they are present; never guesses a step or
 * outcome from free-text legacy columns.
 *
 * A draft's own decision rows (approved, skipped, a failed or refused send) carry the step the
 * draft is for, but nothing was carried out, so they never move the ladder. A step counts when
 * its message was sent (outcome_code "sent"), when a person logged what happened (a call
 * outcome), or on a step row that belongs to no draft.
 */
export function debtChaseEventFromLogRow(
  row: Record<string, unknown>,
): DebtChaseEvent | null {
  const code = typeof row.outcome_code === "string" ? row.outcome_code : null;
  const carriedOut = code === "sent" ||
    DEBT_CHASE_OUTCOMES.includes(code as DebtChaseOutcome) ||
    (code === null && !row.draft_id);
  const step = carriedOut &&
      STEP_IDS.includes(row.schedule_step as DebtChaseStep)
    ? row.schedule_step as DebtChaseStep
    : null;
  const outcome =
    DEBT_CHASE_OUTCOMES.includes(row.outcome_code as DebtChaseOutcome)
      ? row.outcome_code as DebtChaseOutcome
      : null;
  if (!step && !outcome) return null;
  if (!row.xero_invoice_id || typeof row.created_at !== "string") return null;
  return {
    xero_invoice_id: String(row.xero_invoice_id).toLowerCase(),
    at: row.created_at,
    step,
    outcome,
    promised_amount: numberOrNull(row.promised_amount),
    promised_date: isoDateOrNull(row.promised_date),
    amount_due_at_promise: numberOrNull(row.amount_due_at_promise),
    covers:
      Array.isArray(row.covers_invoice_ids) && row.covers_invoice_ids.length
        ? row.covers_invoice_ids.map((id) => String(id).toLowerCase())
        : null,
    by: typeof row.chased_by === "string" && row.chased_by
      ? row.chased_by
      : null,
  };
}

// ── Dates (Perth calendar days) ──

function perthDay(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);
}

function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(isoDate + "T00:00:00Z") / 86_400_000);
}

function addDays(isoDate: string, days: number): string {
  return new Date((dayNumber(isoDate) + days) * 86_400_000).toISOString()
    .slice(0, 10);
}

function weekday(isoDate: string): number {
  return new Date(isoDate + "T00:00:00Z").getUTCDay();
}

/** Today when it is Monday, else the coming Monday. */
export function nextStatementDate(perthDate: string): string {
  return addDays(perthDate, (8 - weekday(perthDate)) % 7);
}

// ── State from the log ──

const cents = (n: number) => Math.round(Number(n || 0) * 100);

interface ChaseState {
  lastStep: DebtChaseEvent | null;
  lastOutcome: DebtChaseEvent | null;
  /** The outcome still in force: no step was logged after it. */
  activeOutcome: DebtChaseEvent | null;
  promise: DebtChasePromise | null;
}

/**
 * Kept when Xero shows the promised amount paid since the promise: the amount due at the
 * promise less today's amount due covers it. A promise covering several invoices compares their
 * totals, and a covered invoice gone from the open book counts as nothing owing on it.
 */
function promiseKept(
  p: DebtChaseEvent,
  amountDueById: Map<string, number>,
): boolean {
  if (p.promised_amount === null || p.amount_due_at_promise === null) {
    return false;
  }
  let now: number;
  if (p.covers) {
    now = p.covers.reduce((a, id) => a + cents(amountDueById.get(id) ?? 0), 0);
  } else {
    const due = amountDueById.get(p.xero_invoice_id.toLowerCase());
    if (due === undefined) return false;
    now = cents(due);
  }
  return cents(p.amount_due_at_promise) - now >= cents(p.promised_amount);
}

/** A promise's status on a Perth date: open through its date, then kept or broken. */
function debtPromiseStatus(
  p: DebtChaseEvent,
  perthDate: string,
  amountDueById: Map<string, number>,
): DebtChasePromise["status"] {
  if (p.promised_date && perthDate <= p.promised_date) return "open";
  return promiseKept(p, amountDueById) ? "kept" : "broken";
}

function chaseState(
  events: DebtChaseEvent[],
  perthDate: string,
  amountDueById: Map<string, number>,
): ChaseState {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  let lastStep: DebtChaseEvent | null = null;
  let lastOutcome: DebtChaseEvent | null = null;
  for (const e of sorted) {
    if (e.step && e.step !== "statement") lastStep = e;
    if (e.outcome) lastOutcome = e;
  }
  const activeOutcome =
    lastOutcome && (!lastStep || lastOutcome.at >= lastStep.at)
      ? lastOutcome
      : null;
  const promise = activeOutcome?.outcome === "promised" &&
      activeOutcome.promised_date
    ? {
      amount: activeOutcome.promised_amount,
      date: activeOutcome.promised_date,
      status: debtPromiseStatus(activeOutcome, perthDate, amountDueById),
    }
    : null;
  return { lastStep, lastOutcome, activeOutcome, promise };
}

function lastOutcomeOf(s: ChaseState): DebtMorningItem["last_outcome"] {
  return s.lastOutcome
    ? {
      code: s.lastOutcome.outcome!,
      at: s.lastOutcome.at,
      by: s.lastOutcome.by,
    }
    : null;
}

// ── Payers ──

function payerKey(inv: DebtChaseBookInvoice): string {
  if (inv.payer === "client") {
    return inv.contact_id || `name:${inv.contact_name.toLowerCase()}`;
  }
  if (inv.payer === "mlb" || inv.payer === "aj") return inv.payer;
  return `${inv.payer}:${resolvePayer(inv.contact_name).label}`;
}

function payerName(inv: DebtChaseBookInvoice): string {
  return inv.payer === "client"
    ? inv.contact_name
    : resolvePayer(inv.contact_name).label;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) || []), x]);
  return out;
}

const byNumber = (a: DebtChaseBookInvoice, b: DebtChaseBookInvoice) =>
  a.invoice_number.localeCompare(b.invoice_number);

function invoiceLines(
  invoices: DebtChaseBookInvoice[],
  promiseOf: (i: DebtChaseBookInvoice) => DebtChasePromise | null = () => null,
) {
  return [...invoices].sort(byNumber).map((i) => ({
    xero_invoice_id: i.xero_invoice_id,
    invoice_number: i.invoice_number,
    kind: i.kind,
    amount_due: i.amount_due,
    due_date: i.due_date,
    invoice_date: i.invoice_date,
    days_overdue: i.days_overdue,
    promise: promiseOf(i),
  }));
}

function maxDays(invoices: DebtChaseBookInvoice[]): number | null {
  const days = invoices.map((i) => i.days_overdue).filter((d): d is number =>
    d !== null
  );
  return days.length ? Math.max(...days) : null;
}

const isDeposit = (i: DebtChaseBookInvoice) =>
  i.payer === "client" && !i.is_debt &&
  (i.kind === "deposit" || i.not_debt_reason === "before_first_payment");

// ── The morning list ──

export function planDebtMorningList(
  invoices: DebtChaseBookInvoice[],
  events: DebtChaseEvent[],
  opts: {
    perthDate: string;
    contactsByJobId?: Map<string, DebtChaseContact>;
  },
) {
  const today = opts.perthDate;
  const isMonday = weekday(today) === 1;
  const eventsByInvoice = groupBy(
    events,
    (e) => e.xero_invoice_id.toLowerCase(),
  );
  const eventsFor = (invs: DebtChaseBookInvoice[]) =>
    invs.flatMap((i) =>
      eventsByInvoice.get(i.xero_invoice_id.toLowerCase()) || []
    );
  const amountDueById = new Map(
    invoices.map((i) => [i.xero_invoice_id.toLowerCase(), i.amount_due]),
  );
  const stateFor = (invs: DebtChaseBookInvoice[]) =>
    chaseState(eventsFor(invs), today, amountDueById);

  const items: DebtMorningItem[] = [];
  const paused: DebtMorningPaused[] = [];
  const waiting: DebtMorningWaiting[] = [];
  const notChased: Array<
    { invoice_number: string; payer_name: string; reason: string }
  > = [];

  const contactFor = (invs: DebtChaseBookInvoice[]): DebtChaseContact => {
    for (const i of invs) {
      const c = i.job_id ? opts.contactsByJobId?.get(i.job_id) : undefined;
      if (c && (c.phone || c.email)) return c;
    }
    return { phone: null, email: null };
  };

  const item = (
    invs: DebtChaseBookInvoice[],
    fields: {
      group: DebtMorningItem["group"];
      step: DebtChaseStep | null;
      step_label: string;
      hold?: DebtMorningItem["hold"];
      hold_reason?: string | null;
      held_step?: DebtChaseStep | null;
      state?: ChaseState | null;
      perInvoice?: boolean;
    },
  ) => {
    const first = invs[0];
    const lines = invoiceLines(
      invs,
      fields.perInvoice ? (i) => stateFor([i]).promise : undefined,
    );
    const agreed =
      lines.every((l) =>
          JSON.stringify(l.promise) === JSON.stringify(lines[0].promise)
        )
        ? lines[0].promise
        : null;
    const state = fields.perInvoice ? stateFor(invs) : fields.state;
    const key = payerKey(first);
    const contact = first.payer === "client"
      ? contactFor(invs)
      : { phone: null, email: null };
    items.push({
      // Stable for the day. A payer can carry a call and a broken-promise call, or several
      // holds, so the group is in the key and a hold also names its invoices.
      id: `${today}:${key}:${fields.group}:${fields.step ?? fields.hold}${
        fields.step
          ? ""
          : ":" + invs.map((i) => i.invoice_number).sort().join(",")
      }`,
      payer_key: key,
      payer_name: payerName(first),
      payer: first.payer,
      group: fields.group,
      step: fields.step,
      step_label: fields.step_label,
      amount: invs.reduce((a, i) => a + cents(i.amount_due), 0) / 100,
      days_overdue: maxDays(invs),
      invoices: lines,
      hold: fields.hold ?? null,
      hold_reason: fields.hold_reason ?? null,
      held_step: fields.held_step ?? null,
      phone: contact.phone,
      email: contact.email,
      promise: fields.perInvoice ? agreed : state?.promise ?? null,
      last_outcome: state ? lastOutcomeOf(state) : null,
      draft: null,
      draft_problem: null,
    });
  };

  const wait = (
    invs: DebtChaseBookInvoice[],
    reason: DebtMorningWaiting["reason"],
    next: { step?: DebtChaseStep; date?: string } = {},
  ) =>
    waiting.push({
      payer_key: payerKey(invs[0]),
      payer_name: payerName(invs[0]),
      invoice_numbers: invs.map((i) => i.invoice_number).sort(),
      reason,
      next_step: next.step ?? null,
      next_date: next.date ?? null,
    });

  const pause = (invs: DebtChaseBookInvoice[], promise: DebtChasePromise) =>
    paused.push({
      payer_key: payerKey(invs[0]),
      payer_name: payerName(invs[0]),
      payer: invs[0].payer,
      invoices: invoiceLines(invs),
      amount: invs.reduce((a, i) => a + cents(i.amount_due), 0) / 100,
      promise,
      resumes_on: addDays(promise.date, 1),
    });

  const ladder = DEBT_CHASE_SCHEDULES.homeowner.ladder;
  const b = DEBT_CHASE_SCHEDULES.builder;
  const homeownerNext = (overdue: DebtChaseBookInvoice[], s: ChaseState) => {
    const startIndex = overdue.some((i) => i.start_step === "jan")
      ? ladder.findIndex((l) => l.step === "jan_visit")
      : 0;
    const doneIndex = s.lastStep
      ? ladder.findIndex((l) => l.step === s.lastStep!.step)
      : -1;
    const nextIndex = Math.min(
      Math.max(doneIndex + 1, startIndex),
      ladder.length - 1,
    );
    return { startIndex, nextIndex, next: ladder[nextIndex] };
  };
  const loggedStep = (i: DebtChaseBookInvoice, step: DebtChaseStep) =>
    eventsFor([i]).some((e) => e.step === step);
  const isOverdue = (i: DebtChaseBookInvoice) => (i.days_overdue ?? 0) > 0;
  const callDue = (i: DebtChaseBookInvoice) => {
    const days = i.days_overdue ?? 0;
    if (days < b.call_at_days_overdue) return false;
    const reachedOn = addDays(today, b.call_at_days_overdue - days);
    return !eventsFor([i]).some((e) =>
      e.step === "builder_call" && perthDay(e.at) >= reachedOn
    );
  };

  const heldStepFor = (invs: DebtChaseBookInvoice[]): DebtChaseStep | null => {
    if (invs.every(isDeposit)) {
      return invs.some((i) =>
          isOverdue(i) && !loggedStep(i, "deposit_reminder")
        )
        ? "deposit_reminder"
        : null;
    }
    const payer = invs[0].payer;
    if (payer === "client") {
      const overdue = invs.filter(isOverdue);
      return overdue.length
        ? homeownerNext(overdue, stateFor(overdue)).next.step
        : null;
    }
    if (payer === "mlb" || payer === "aj" || payer === "other_builder") {
      return invs.some(callDue) ? "builder_call" : "statement";
    }
    return null;
  };

  const holdItem = (
    invs: DebtChaseBookInvoice[],
    kind: "check_first" | "fix_first",
    reason: string,
    state: ChaseState | null = null,
  ) =>
    item(invs, {
      group: "hold",
      step: null,
      step_label: `${
        kind === "fix_first" ? "Fix first" : "Check first"
      }: ${reason}`,
      hold: kind,
      hold_reason: reason,
      held_step: heldStepFor(invs),
      state,
    });

  const holdByOutcome = (s: ChaseState) =>
    s.activeOutcome?.outcome
      ? HOLDING_OUTCOMES[s.activeOutcome.outcome] ?? null
      : null;
  const outcomeHoldReason = (s: ChaseState, why: string) =>
    `${why} (${perthDay(s.activeOutcome!.at)}${
      s.activeOutcome!.by ? `, ${s.activeOutcome!.by}` : ""
    })`;

  // Book holds: one item per payer and hold kind, with every reason.
  const chaseable: DebtChaseBookInvoice[] = [];
  const held = invoices.filter((i) => i.is_debt && i.hold);
  for (
    const invs of groupBy(held, (i) => `${payerKey(i)}|${i.hold}`).values()
  ) {
    // One payer, several held invoices: each reason names its invoice.
    const reason = [...invs].sort(byNumber).map((i) =>
      invs.length > 1
        ? `${i.invoice_number}: ${i.hold_reason || "held"}`
        : i.hold_reason || "held"
    ).join("; ");
    holdItem(
      invs,
      invs[0].hold === "fix_first" ? "fix_first" : "check_first",
      reason,
    );
  }
  for (const i of invoices) {
    if (i.is_debt && !i.hold && i.payer !== "not_chased") chaseable.push(i);
  }

  // Homeowners: one ladder per payer.
  const clientDebt = chaseable.filter((i) => i.payer === "client");
  for (const invs of groupBy(clientDebt, payerKey).values()) {
    const overdue = invs.filter(isOverdue);
    const noDue = invs.filter((i) => i.days_overdue === null);
    if (noDue.length && !overdue.length) wait(noDue, "no_due_date");
    if (!overdue.length) {
      const notDue = invs.filter((i) => i.days_overdue !== null);
      if (notDue.length) wait(notDue, "not_due");
      continue;
    }
    const s = stateFor(overdue);
    const why = holdByOutcome(s);
    if (why) {
      holdItem(overdue, "check_first", outcomeHoldReason(s, why), s);
      continue;
    }
    if (s.promise?.status === "open") {
      pause(overdue, s.promise);
      continue;
    }
    const { startIndex, nextIndex, next } = homeownerNext(overdue, s);
    if (s.promise?.status === "broken") {
      item(overdue, {
        group: "broken_promise",
        step: next.step,
        step_label: `Promise broken: ${DEBT_CHASE_STEPS[next.step].label}`,
        state: s,
      });
      continue;
    }
    if (s.lastStep && perthDay(s.lastStep.at) >= today) {
      wait(overdue, "done_today", { step: next.step, date: addDays(today, 1) });
      continue;
    }
    const days = maxDays(overdue)!;
    if (nextIndex !== startIndex && days < next.day) {
      wait(overdue, "next_step_later", {
        step: next.step,
        date: addDays(today, next.day - days),
      });
      continue;
    }
    item(overdue, {
      group: DEBT_CHASE_STEPS[next.step].group,
      step: next.step,
      step_label: DEBT_CHASE_STEPS[next.step].label,
      state: s,
    });
  }

  // Builders: a Monday statement per payer, and a call per invoice at 30 days overdue.
  const builderDebt = chaseable.filter((i) =>
    i.payer === "mlb" || i.payer === "aj" || i.payer === "other_builder"
  );
  for (const invs of groupBy(builderDebt, payerKey).values()) {
    const statement: DebtChaseBookInvoice[] = [];
    const calls: DebtChaseBookInvoice[] = [];
    const broken: DebtChaseBookInvoice[] = [];
    const tooYoung: DebtChaseBookInvoice[] = [];
    const openPromises: Array<[DebtChaseBookInvoice, DebtChasePromise]> = [];
    for (const i of invs) {
      const s = stateFor([i]);
      const why = holdByOutcome(s);
      if (why) {
        holdItem([i], "check_first", outcomeHoldReason(s, why), s);
        continue;
      }
      const promise = s.promise?.status === "open" ||
          s.promise?.status === "broken"
        ? s.promise
        : null;
      const ageFromInvoice = i.invoice_date
        ? dayNumber(today) - dayNumber(i.invoice_date)
        : null;
      if (
        ageFromInvoice !== null &&
        ageFromInvoice >= b.statement_after_invoice_days
      ) {
        statement.push(i);
      } else if (!promise) tooYoung.push(i);
      if (promise?.status === "open") openPromises.push([i, promise]);
      else if (promise?.status === "broken") broken.push(i);
      else if (callDue(i)) calls.push(i);
    }
    for (const [i, p] of openPromises) pause([i], p);
    if (broken.length) {
      item(broken, {
        group: "broken_promise",
        step: "builder_call",
        step_label: `Promise broken: ${DEBT_CHASE_STEPS.builder_call.label}`,
        perInvoice: true,
      });
    }
    if (calls.length) {
      item(calls, {
        group: "call",
        step: "builder_call",
        step_label: DEBT_CHASE_STEPS.builder_call.label,
        perInvoice: true,
      });
    }
    if (statement.length) {
      const sentToday = eventsFor(invs).some((e) =>
        e.step === "statement" && perthDay(e.at) === today
      );
      if (isMonday && !sentToday) {
        item(statement, {
          group: "statement",
          step: "statement",
          step_label: DEBT_CHASE_STEPS.statement.label,
          perInvoice: true,
        });
      } else {
        wait(statement, sentToday ? "done_today" : "statement_not_due", {
          step: "statement",
          date: nextStatementDate(sentToday ? addDays(today, 1) : today),
        });
      }
    }
    if (tooYoung.length) {
      const soonest = Math.min(
        ...tooYoung.map((i) =>
          i.invoice_date
            ? dayNumber(i.invoice_date) + b.statement_after_invoice_days
            : Infinity
        ),
      );
      wait(tooYoung, "statement_not_due", {
        step: "statement",
        date: Number.isFinite(soonest)
          ? nextStatementDate(
            new Date(soonest * 86_400_000).toISOString().slice(0, 10),
          )
          : undefined,
      });
    }
  }

  // Deposits and before-work invoices: one friendly reminder once overdue.
  const deposits = invoices.filter(isDeposit);
  const remindable: DebtChaseBookInvoice[] = [];
  for (const i of deposits) {
    const named = DEBT_CHASE_NO_REMINDER.find((n) =>
      n.invoice_number === i.invoice_number
    );
    if (named) {
      notChased.push({
        invoice_number: i.invoice_number,
        payer_name: payerName(i),
        reason: named.reason,
      });
    } else remindable.push(i);
  }
  for (const invs of groupBy(remindable, payerKey).values()) {
    const due: DebtChaseBookInvoice[] = [];
    const broken: DebtChaseBookInvoice[] = [];
    for (const i of invs) {
      const s = stateFor([i]);
      const why = holdByOutcome(s);
      if (why) {
        holdItem([i], "check_first", outcomeHoldReason(s, why), s);
      } else if (s.promise?.status === "open") pause([i], s.promise);
      else if (s.promise?.status === "broken") broken.push(i);
      else if (loggedStep(i, "deposit_reminder")) wait([i], "reminder_sent");
      else if (isOverdue(i)) due.push(i);
    }
    if (broken.length) {
      item(broken, {
        group: "broken_promise",
        step: "deposit_reminder",
        step_label:
          `Promise broken: ${DEBT_CHASE_STEPS.deposit_reminder.label}`,
        perInvoice: true,
      });
    }
    if (due.length) {
      item(due, {
        group: "deposit_reminder",
        step: "deposit_reminder",
        step_label: DEBT_CHASE_STEPS.deposit_reminder.label,
        perInvoice: true,
      });
    }
  }

  const rank = (g: DebtMorningItem["group"]) => {
    const r = DEBT_CHASE_GROUP_ORDER.indexOf(g as DebtChaseGroup);
    return r === -1 ? DEBT_CHASE_GROUP_ORDER.length : r;
  };
  items.sort((a, z) =>
    rank(a.group) - rank(z.group) ||
    cents(z.amount) - cents(a.amount) ||
    (z.days_overdue ?? -Infinity) - (a.days_overdue ?? -Infinity) ||
    a.payer_name.localeCompare(z.payer_name) ||
    a.id.localeCompare(z.id)
  );
  paused.sort((a, z) =>
    a.promise.date.localeCompare(z.promise.date) ||
    a.payer_name.localeCompare(z.payer_name)
  );
  waiting.sort((a, z) =>
    a.payer_name.localeCompare(z.payer_name) || a.reason.localeCompare(z.reason)
  );

  const groups: Record<string, { count: number; amount: number }> = {};
  for (const g of [...DEBT_CHASE_GROUP_ORDER, "hold"]) {
    const inGroup = items.filter((i) => i.group === g);
    groups[g] = {
      count: inGroup.length,
      amount: inGroup.reduce((a, i) => a + cents(i.amount), 0) / 100,
    };
  }

  return {
    perth_date: today,
    is_statement_day: isMonday,
    next_statement_date: nextStatementDate(today),
    items,
    paused,
    waiting,
    not_chased: notChased,
    summary: {
      items: items.filter((i) => !i.hold).length,
      held: items.filter((i) => i.hold).length,
      paused: paused.length,
      groups,
    },
  };
}
