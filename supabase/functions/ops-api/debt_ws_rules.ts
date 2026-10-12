// Debt Workshop rules (secureworks-wiki coding/capabilities/debt-follow-up/debt-workshop-spec.md,
// sections 2 to 6). Pure functions only: no database, no Xero, no clock. Every rule here is
// plain and tested in debt_ws_rules_test.ts; nothing is decided by AI.
//
//   Section 2  what counts as debt: scope, lane, invoice kind, share, the debt rule,
//              not chased, possible duplicate
//   Section 3  due dates, day 0, day, category, neighbour label
//   Section 4  the homeowner follow-up steps (weekend shift, latest due step only),
//              Jan's visit list text, the company statement email
//   Section 5  the message templates, with Perth dates like "Friday the 17th of October"
//   Section 6  the bank-feed possible-payment matcher
//
// Never import the retired debt desk modules (debt_desk_*, debt_book*, debt_morning_list,
// debt_jan_text, debt_chase_schedule, debt_draft_templates): a later PR deletes them.

export const DEBT_WS_VERSION = "debt-ws/v1";
export const DEBT_WS_PLAYBOOK_VERSION = "debt-ws-playbook/v1";

// ── Dates (all calendar dates are YYYY-MM-DD strings in Perth, UTC+8, no daylight saving) ──

const DAY_MS = 86_400_000;
const PERTH_OFFSET_MS = 8 * 3_600_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

/** The Perth calendar date of an instant. */
export function perthDate(at: Date): string {
  return new Date(at.getTime() + PERTH_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Perth calendar date of a timestamp string (or a plain date), or null. */
export function perthDateOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (ISO_DATE.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? perthDate(new Date(ms)) : null;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (to minus from). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

/** A Saturday or Sunday moves to the Monday after it. */
export function shiftWeekend(date: string): string {
  const d = weekday(date);
  return d === 6 ? addDays(date, 2) : d === 0 ? addDays(date, 1) : date;
}

/** The Monday of the Monday-to-Sunday week holding this date. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** The first Monday strictly after this date (Jan's visit day). */
export function nextMonday(date: string): string {
  return addDays(mondayOf(date), 7);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const unit = n % 10;
  return `${n}${
    unit === 1 ? "st" : unit === 2 ? "nd" : unit === 3 ? "rd" : "th"
  }`;
}

/** "Friday the 17th of October" (the wiki style guide's date form). */
export function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} the ${ordinal(d.getUTCDate())} of ${
    MONTHS[d.getUTCMonth()]
  }`;
}

/** "$1,234.50". */
export function money(amount: number): string {
  const cents = Math.round(Number(amount || 0) * 100);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export const cents = (n: unknown) => Math.round(Number(n || 0) * 100);

// ── Section 2: what counts as debt ──

/** One invoice row from our Xero copy (xero_invoices), with the first line's description. */
export interface WsInvoice {
  xero_invoice_id: string;
  xero_contact_id: string | null;
  contact_name: string | null;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  reference: string | null;
  total: number | null;
  amount_due: number | null;
  invoice_date: string | null;
  due_date?: string | null;
  fully_paid_on?: string | null;
  job_id: string | null;
  first_description: string | null;
}

export interface WsJob {
  id: string;
  status: string | null;
  type: string | null;
  job_number: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  site_address: string | null;
  site_suburb: string | null;
  ghl_contact_id: string | null;
}

export function isSampleReference(reference: unknown): boolean {
  return String(reference ?? "").toUpperCase().includes("SAMPLE-");
}

/** Scope: ACCREC, AUTHORISED, amount due above zero, and not a SAMPLE- reference. */
export function inScope(inv: WsInvoice): boolean {
  return String(inv.invoice_type ?? "").toUpperCase() === "ACCREC" &&
    String(inv.status ?? "").toUpperCase() === "AUTHORISED" &&
    Number(inv.amount_due) > 0 &&
    !isSampleReference(inv.reference);
}

export type Lane = "homeowner" | "account" | "needs_a_look";

const COMPANY_WORDS =
  /\b(pty|ltd|builders|building|restoration|housing|strata|insurance|services|group|construction|trust|council|department)\b/i;

export function looksLikeCompany(name: unknown): boolean {
  return COMPANY_WORDS.test(String(name ?? ""));
}

const HOMEOWNER_TYPES = new Set(["fencing", "patio"]);
// "insurance" is the SWMS- insurance job type; "roof_report" covers a roof report however it
// is spelled. Both are company work like make-safes and repairs.
const ACCOUNT_TYPES = new Set([
  "makesafe",
  "repair",
  "roof_report",
  "roof report",
  "roofreport",
  "insurance",
]);

export const NEEDS_LOOK_REASONS = {
  not_linked: "not linked to a job",
  unknown_type: "unknown job type",
  unknown_kind: "can't tell what this invoice is",
  duplicate: "looks like a duplicate",
} as const;

export function laneFor(
  job: Pick<WsJob, "type"> | null | undefined,
  contactName: string | null,
): { lane: Lane; reason: string | null } {
  if (!job) {
    return looksLikeCompany(contactName)
      ? { lane: "account", reason: null }
      : { lane: "needs_a_look", reason: NEEDS_LOOK_REASONS.not_linked };
  }
  const type = String(job.type ?? "").trim().toLowerCase();
  if (HOMEOWNER_TYPES.has(type)) return { lane: "homeowner", reason: null };
  if (ACCOUNT_TYPES.has(type)) return { lane: "account", reason: null };
  return { lane: "needs_a_look", reason: NEEDS_LOOK_REASONS.unknown_type };
}

/**
 * The reference split into the neighbour letter and the ending. "SWF-26091-A-FINBAL" gives
 * letter A and ending FINBAL; a trailing letter ("SWF-26091-FINBAL-B") is the letter too.
 */
export function parseReference(reference: unknown): {
  letter: string | null;
  ending: string | null;
} {
  const segments = String(reference ?? "").toUpperCase().split("-").map((s) =>
    s.trim()
  ).filter(Boolean);
  let letter: string | null = null;
  let ending = "";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (index > 0 && /^[A-Z]$/.test(segment)) {
      letter ??= segment;
      continue;
    }
    ending = segment;
  }
  const clean = ending.split(/\s+/)[0].replace(/[^A-Z0-9]/g, "");
  return { letter, ending: clean || null };
}

/** Final endings: FIN, FINBAL or BAL with up to three digits (FIN25, FINBAL50), FINAL, PRIVATE. */
const FINAL_ENDING = /^(?:(?:FIN|FINBAL|BAL)\d{0,3}|FINAL|PRIVATE)$/;
const FINAL_DESCRIPTIONS = ["balance", "remaining", "remainder"];
/** Not-final endings, the description each must start with, and the stage it names. */
const NOT_FINAL_ENDINGS: Array<
  { ending: RegExp; starts: string; stage: string }
> = [
  { ending: /^DEP\d{0,3}$/, starts: "deposit", stage: "deposit" },
  { ending: /^MAT\d{0,3}$/, starts: "materials", stage: "materials" },
  { ending: /^PROG\d{0,3}$/, starts: "progress", stage: "progress" },
  { ending: /^PLAN$/, starts: "planning fee", stage: "planning fee" },
  { ending: /^VAR$/, starts: "extra labour", stage: "extra labour" },
];

export interface InvoiceKind {
  kind: "final" | "not_final" | null;
  /** The stage a not-final invoice names ("materials"), for "materials invoice". */
  stage: string | null;
}

/** The reference ending and the start of the description must agree (spec section 2). */
export function invoiceKindOf(
  reference: unknown,
  description: unknown,
): InvoiceKind {
  const { ending } = parseReference(reference);
  const desc = String(description ?? "").trim().toLowerCase();
  if (!ending || !desc) return { kind: null, stage: null };
  if (FINAL_ENDING.test(ending)) {
    return FINAL_DESCRIPTIONS.some((d) => desc.startsWith(d))
      ? { kind: "final", stage: null }
      : { kind: null, stage: null };
  }
  const notFinal = NOT_FINAL_ENDINGS.find((n) => n.ending.test(ending));
  if (notFinal && desc.startsWith(notFinal.starts)) {
    return { kind: "not_final", stage: notFinal.stage };
  }
  return { kind: null, stage: null };
}

/** "SWF-26091/A", or "SWF-26091/main" with no neighbour letter. Null without a job number. */
export function shareLabel(
  jobNumber: string | null | undefined,
  reference: unknown,
): { share: string | null; letter: string } {
  const letter = parseReference(reference).letter ?? "main";
  const number = String(jobNumber ?? "").trim().toUpperCase();
  return { share: number ? `${number}/${letter}` : null, letter };
}

function compareInvoiceOrder(a: WsInvoice, b: WsInvoice): number {
  const da = String(a.invoice_date ?? "");
  const db = String(b.invoice_date ?? "");
  if (da !== db) return da < db ? -1 : 1;
  return String(a.invoice_number ?? "").localeCompare(
    String(b.invoice_number ?? ""),
    "en",
    { numeric: true },
  );
}

export type DebtKind = "final" | "progress" | "account";

export type Classification =
  | {
    status: "debt";
    lane: "homeowner" | "account";
    kind: DebtKind;
    stage: string | null;
    share: string | null;
    letter: string;
  }
  | {
    status: "go_ahead";
    lane: "homeowner";
    kind: null;
    stage: string | null;
    share: string | null;
    letter: string;
  }
  | {
    status: "needs_a_look";
    lane: Lane;
    reason: string;
    share: string | null;
    letter: string;
  };

/**
 * The debt rule for one invoice (spec section 2). `shareHistory` is every invoice on the
 * invoice's job (any status; only AUTHORISED and PAID count for order and duplicates).
 */
export function classifyInvoice(
  inv: WsInvoice,
  job: WsJob | null,
  shareHistory: WsInvoice[],
): Classification {
  const { share, letter } = shareLabel(job?.job_number, inv.reference);
  const lane = laneFor(job, inv.contact_name);
  if (lane.lane === "needs_a_look") {
    return {
      status: "needs_a_look",
      lane: lane.lane,
      reason: lane.reason!,
      share,
      letter,
    };
  }
  if (lane.lane === "account") {
    return {
      status: "debt",
      lane: "account",
      kind: "account",
      stage: null,
      share,
      letter,
    };
  }
  const kind = invoiceKindOf(inv.reference, inv.first_description);
  if (!kind.kind) {
    return {
      status: "needs_a_look",
      lane: "homeowner",
      reason: NEEDS_LOOK_REASONS.unknown_kind,
      share,
      letter,
    };
  }
  const counted = shareHistory.filter((h) =>
    ["AUTHORISED", "PAID"].includes(String(h.status ?? "").toUpperCase()) &&
    shareLabel(job?.job_number, h.reference).share === share
  );
  const ref = String(inv.reference ?? "").trim().toUpperCase();
  const duplicate = counted.some((h) =>
    h.xero_invoice_id !== inv.xero_invoice_id &&
    String(h.status ?? "").toUpperCase() === "PAID" &&
    cents(h.total) === cents(inv.total) &&
    String(h.reference ?? "").trim().toUpperCase() === ref
  );
  if (duplicate) {
    return {
      status: "needs_a_look",
      lane: "homeowner",
      reason: NEEDS_LOOK_REASONS.duplicate,
      share,
      letter,
    };
  }
  if (kind.kind === "final") {
    return {
      status: "debt",
      lane: "homeowner",
      kind: "final",
      stage: null,
      share,
      letter,
    };
  }
  const notFinal = counted.filter((h) =>
    invoiceKindOf(h.reference, h.first_description).kind === "not_final"
  );
  if (!notFinal.some((h) => h.xero_invoice_id === inv.xero_invoice_id)) {
    notFinal.push(inv);
  }
  notFinal.sort(compareInvoiceOrder);
  return notFinal[0].xero_invoice_id === inv.xero_invoice_id
    ? {
      status: "go_ahead",
      lane: "homeowner",
      kind: null,
      stage: kind.stage,
      share,
      letter,
    }
    : {
      status: "debt",
      lane: "homeowner",
      kind: "progress",
      stage: kind.stage,
      share,
      letter,
    };
}

const CONTACT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A contact in debt_ws_settings.not_chased_contacts. An entry that is a Xero contact id
 * matches the invoice's contact id or its canonical company id (contactIds); any other
 * entry matches the contact name (whole words, any case).
 */
export function isNotChased(
  contactName: unknown,
  notChased: readonly string[],
  contactIds: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const name = normaliseName(contactName);
  const ids = new Set(
    contactIds.filter((id): id is string => !!id).map((id) => id.toLowerCase()),
  );
  return notChased.some((entry) => {
    const raw = String(entry ?? "").trim();
    if (CONTACT_ID.test(raw)) return ids.has(raw.toLowerCase());
    const n = normaliseName(raw);
    return !!name && !!n && ` ${name} `.includes(` ${n} `);
  });
}

// ── Section 3: due dates, days and categories ──

/** Shaun, 8 Oct: final on the invoice date, progress +7 days, account +10 days. */
export function dueDateFor(kind: DebtKind, invoiceDate: string): string {
  return kind === "final"
    ? invoiceDate
    : addDays(invoiceDate, kind === "progress" ? 7 : 10);
}

/**
 * Day 0: the due date; for a final whose job left rectification after the due date, the
 * Perth date it left.
 */
export function dayZeroFor(
  kind: DebtKind,
  dueDate: string,
  rectificationExit: string | null,
): string {
  return kind === "final" && rectificationExit && rectificationExit > dueDate
    ? rectificationExit
    : dueDate;
}

export type Category =
  | "active"
  | "escalating"
  | "bad_debt"
  | "says_paid"
  | "rectification";

export const CATEGORIES: Category[] = [
  "active",
  "escalating",
  "bad_debt",
  "says_paid",
  "rectification",
];

/** First match wins. Null means not due yet (day 0 or earlier). */
export function categoryFor(input: {
  day: number;
  saysPaid: boolean;
  jobStatus: string | null;
}): Category | null {
  if (input.saysPaid) return "says_paid";
  if (String(input.jobStatus ?? "").toLowerCase() === "rectification") {
    return "rectification";
  }
  if (input.day <= 0) return null;
  if (input.day <= 7) return "active";
  if (input.day <= 20) return "escalating";
  return "bad_debt";
}

export function normaliseName(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
}

/**
 * The same payer: equal once tidied, or every word of the shorter name is in the longer
 * ("Sam" on the job and "Sam Example" in Xero). Live data has jobs named by first name only.
 */
export function sameName(a: unknown, b: unknown): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t) => long.includes(t));
}

/** "<payer> (neighbour of <client>)" on the homeowner side, else the payer. */
export function payerLabel(
  payer: string | null,
  clientName: string | null,
  letter: string,
): { label: string; neighbourOf: string | null } {
  const p = String(payer ?? "").trim() || String(clientName ?? "").trim() ||
    "Unknown payer";
  const client = String(clientName ?? "").trim();
  const neighbour = !!client && (letter !== "main" || !sameName(p, client));
  return neighbour
    ? { label: `${p} (neighbour of ${client})`, neighbourOf: client }
    : { label: p, neighbourOf: null };
}

// ── Section 4: follow-up steps (homeowner) ──

export const LADDER_STEPS = ["d1", "d3", "d7", "d12", "d17", "d21"] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];
export const TEXT_STEPS = ["d1", "d3", "d7", "d12", "d17"] as const;
export type TextStep = (typeof TEXT_STEPS)[number];
export const REPLY_STEPS = [
  "reply_says_paid",
  "reply_promise",
  "reply_problem",
] as const;
export type ReplyStep = (typeof REPLY_STEPS)[number];

export const STEP_DAYS: Record<LadderStep, number> = {
  d1: 1,
  d3: 3,
  d7: 7,
  d12: 12,
  d17: 17,
  d21: 21,
};

export const STEP_LABELS: Record<LadderStep | ReplyStep, string> = {
  d1: "Day 1 text: warm heads-up",
  d3: "Day 3 text: check-in with pay link",
  d7: "Day 7 call and text",
  d12: "Day 12 text: firm, pay-by date",
  d17: "Day 17 text: final, we will come by",
  d21: "Jan's visit list",
  reply_says_paid: "Reply: says paid",
  reply_promise: "Reply: promise to pay",
  reply_problem: "Reply: problem with the job",
};

export const isTextStep = (s: unknown): s is TextStep =>
  (TEXT_STEPS as readonly unknown[]).includes(s);
export const isReplyStep = (s: unknown): s is ReplyStep =>
  (REPLY_STEPS as readonly unknown[]).includes(s);
export const isLadderStep = (s: unknown): s is LadderStep =>
  (LADDER_STEPS as readonly unknown[]).includes(s);

/** The date a step shows: day 0 plus its day, a weekend moved to Monday. */
export function stepDate(dayZero: string, step: LadderStep): string {
  return shiftWeekend(addDays(dayZero, STEP_DAYS[step]));
}

/** The latest step whose date has come, or null (spec: only the latest due step is offered). */
export function latestReachedStep(
  dayZero: string,
  today: string,
): LadderStep | null {
  let latest: LadderStep | null = null;
  for (const step of LADDER_STEPS) {
    if (stepDate(dayZero, step) <= today) latest = step;
  }
  return latest;
}

export type LadderStatus =
  | "done"
  | "due"
  | "upcoming"
  | "skipped"
  | "not_applicable";

export interface LadderInput {
  kind: DebtKind;
  dayZero: string;
  today: string;
  category: Category | null;
  pausedUntil: string | null;
  notChased: boolean;
  /** Steps sent (or claimed by a send) in the current cycle. */
  sent: ReadonlySet<string>;
  /** Steps skipped in the current cycle. */
  skipped: ReadonlySet<string>;
}

export interface LadderResult {
  step_due: { step: LadderStep; label: string } | null;
  next_step: { step: LadderStep; date: string } | null;
  ladder: Array<{
    step: LadderStep;
    label: string;
    day: number;
    date: string;
    status: LadderStatus;
  }>;
  /** The latest step whose date has come (Jan's list reads d21 from this). */
  reached: LadderStep | null;
  paused: boolean;
}

export function ladderFor(input: LadderInput): LadderResult {
  const paused = !!input.pausedUntil && input.pausedUntil > input.today;
  const ladderDates = LADDER_STEPS.map((step) => ({
    step,
    date: stepDate(input.dayZero, step),
  }));
  if (input.kind === "account") {
    return {
      step_due: null,
      next_step: null,
      reached: null,
      paused,
      ladder: ladderDates.map(({ step, date }) => ({
        step,
        label: STEP_LABELS[step],
        day: STEP_DAYS[step],
        date,
        status: "not_applicable" as const,
      })),
    };
  }
  const reached = latestReachedStep(input.dayZero, input.today);
  const held = input.category === "says_paid" ||
    input.category === "rectification";
  const blocked = input.notChased || held || paused ||
    input.category === null || isWeekend(input.today);
  const progressHold = (step: LadderStep) =>
    input.kind === "progress" && step === "d21";
  const done = (step: string) =>
    input.sent.has(step) || input.skipped.has(step);
  const due = !blocked && reached && !progressHold(reached) && !done(reached)
    ? reached
    : null;

  let next: { step: LadderStep; date: string } | null = null;
  if (!input.notChased && !held) {
    const upcoming = ladderDates.find(({ step, date }) =>
      date > input.today && !progressHold(step)
    );
    if (upcoming) {
      const date = paused && input.pausedUntil! >= upcoming.date
        ? shiftWeekend(addDays(input.pausedUntil!, 1))
        : upcoming.date;
      next = { step: upcoming.step, date };
    }
  }

  return {
    step_due: due ? { step: due, label: STEP_LABELS[due] } : null,
    next_step: next,
    reached,
    paused,
    ladder: ladderDates.map(({ step, date }) => {
      let status: LadderStatus;
      if (input.sent.has(step)) status = "done";
      else if (input.skipped.has(step)) status = "skipped";
      else if (progressHold(step)) status = "not_applicable";
      else if (due === step) status = "due";
      else if (date > input.today) status = "upcoming";
      else if (step === reached && !input.notChased) status = "due";
      else status = "not_applicable";
      return {
        step,
        label: STEP_LABELS[step],
        day: STEP_DAYS[step],
        date,
        status,
      };
    }),
  };
}

/** Jan's visit list: finals at d21 or later, not paused, says-paid or in rectification. */
export function onJanList(input: {
  kind: DebtKind;
  reached: LadderStep | null;
  paused: boolean;
  category: Category | null;
  notChased: boolean;
  removed: boolean;
}): boolean {
  return input.kind === "final" && input.reached === "d21" && !input.paused &&
    input.category !== "says_paid" && input.category !== "rectification" &&
    input.category !== null && !input.notChased && !input.removed;
}

// ── Section 5: message templates ──

export interface TemplateVars {
  /** Payer first name. */
  name: string;
  /** Street name only ("Smith Street"). */
  street: string | null;
  /** fence or patio. */
  work: string;
  amount: number;
  /** Xero online invoice URL, or null (the line then says the link is in the invoice email). */
  pay_link: string | null;
  date17: string;
  date21: string;
  overdue_days: number;
}

interface StepTemplate {
  withLink: string;
  noLink: string;
}

const SIGN = "\n\nCheers,\nShaun";

const STEP_TEMPLATES: Record<TextStep, StepTemplate> = {
  d1: {
    withLink:
      "Hi {name},\n\nHope you're well! Hope you're enjoying the new {work} at {street}.\n\nI've sent through the final invoice by email. If you could get that sorted when you get a chance, that would be great.\n\nLet us know if you have any questions." +
      SIGN,
    noLink:
      "Hi {name},\n\nHope you're well! Hope you're enjoying the new {work} at {street}.\n\nI've sent through the final invoice by email. If you could get that sorted when you get a chance, that would be great.\n\nLet us know if you have any questions." +
      SIGN,
  },
  d3: {
    withLink:
      "Hi {name},\n\nHope you're well! Just checking the final invoice for {street} came through OK.\n\nIf you've already paid, please reply with a screenshot of the payment, or ignore this message. If not, you can pay here: {pay_link}" +
      SIGN,
    noLink:
      "Hi {name},\n\nHope you're well! Just checking the final invoice for {street} came through OK.\n\nIf you've already paid, please reply with a screenshot of the payment, or ignore this message. If not, the link is in the invoice email." +
      SIGN,
  },
  d7: {
    withLink:
      "Hi {name},\n\nI tried giving you a call today about the final invoice for the {work} at {street}. There's {amount} still outstanding.\n\nIf you could get that sorted this week, that would be great: {pay_link}\n\nIf you've already paid, please reply with a screenshot of the payment, or ignore this message." +
      SIGN,
    noLink:
      "Hi {name},\n\nI tried giving you a call today about the final invoice for the {work} at {street}. There's {amount} still outstanding.\n\nIf you could get that sorted this week, that would be great. The link is in the invoice email.\n\nIf you've already paid, please reply with a screenshot of the payment, or ignore this message." +
      SIGN,
  },
  d12: {
    withLink:
      "Hi {name},\n\nFollowing up again on the final invoice for {street}. The {amount} is now {overdue_days} days overdue.\n\nPlease get this paid by {date17}: {pay_link}\n\nIf there's a problem with the job, just reply here and I'll give you a call." +
      SIGN,
    noLink:
      "Hi {name},\n\nFollowing up again on the final invoice for {street}. The {amount} is now {overdue_days} days overdue.\n\nPlease get this paid by {date17}. The link is in the invoice email.\n\nIf there's a problem with the job, just reply here and I'll give you a call." +
      SIGN,
  },
  d17: {
    withLink:
      "Hi {name},\n\nI haven't been able to reach you about the {amount} still owing for the {work} at {street}.\n\nIf it's not paid by {date21}, one of our team will come by your home to sort it out in person.\n\nYou can pay here: {pay_link}. If you've already paid, please reply with a screenshot of the payment." +
      SIGN,
    noLink:
      "Hi {name},\n\nI haven't been able to reach you about the {amount} still owing for the {work} at {street}.\n\nIf it's not paid by {date21}, one of our team will come by your home to sort it out in person.\n\nThe link is in the invoice email. If you've already paid, please reply with a screenshot of the payment." +
      SIGN,
  },
};

export interface ReplyVars {
  name: string;
  promise_date?: string | null;
  issue?: string | null;
  installer?: string | null;
  street?: string | null;
}

const REPLY_TEMPLATES = {
  says_paid:
    "Thanks {name}! It hasn't shown up our end yet. Could you send through a screenshot of the payment so we can match it up?" +
    SIGN,
  promise:
    "Thanks {name}, appreciate that! I'll keep an eye out for it on {promise_date}." +
    SIGN,
  problem:
    "Thanks {name}, sorry about that. I'll get someone out to sort the {issue} and I'll text you a time shortly." +
    SIGN,
  problem_fixed:
    "Hi {name},\n\nHope you're well! {installer} sorted the {issue} today. I've resent the final invoice for {street}.\n\nLet us know if you have any questions." +
    SIGN,
} as const;

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(
    /\{([a-z0-9_]+)\}/g,
    (whole, key) => key in vars ? vars[key] : whole,
  );
}

/** Payer first name, tidied when the name is all upper or all lower case. */
export function firstNameOf(payer: unknown): string {
  const first = String(payer ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return "there";
  const plain = first.replace(/[^A-Za-z'-]/g, "");
  if (!plain) return "there";
  return plain === plain.toUpperCase() || plain === plain.toLowerCase()
    ? plain.charAt(0).toUpperCase() + plain.slice(1).toLowerCase()
    : plain;
}

const STREET_TYPES = new Set(
  (
    "street st road rd avenue ave av drive dr way place pl court ct crescent cres close cl " +
    "lane ln parade pde terrace tce boulevard blvd bvd highway hwy circuit cct loop rise grove gr " +
    "view vista retreat gardens gdns mews square sq esplanade esp entrance chase link ramble " +
    "promenade turn heights glade walk approach bend brace cove green meander outlook pass quays " +
    "ridge row run strand trail vale circle cir crest"
  ).split(" "),
);

function titleWord(word: string): string {
  return word === word.toUpperCase() || word === word.toLowerCase()
    ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    : word;
}

/** The street name only: "12A/3 Smith Street, Perth WA 6000" gives "Smith Street". */
export function streetOf(address: unknown): string | null {
  const head = String(address ?? "").split(",")[0].trim();
  if (!head) return null;
  const words = head.split(/\s+/);
  let i = 0;
  while (
    i < words.length &&
    (/\d/.test(words[i]) ||
      /^(unit|lot|apt|apartment|u|no\.?)$/i.test(words[i]))
  ) i++;
  const rest = words.slice(i);
  const typeAt = rest.findIndex((w, k) =>
    k > 0 && STREET_TYPES.has(w.toLowerCase().replace(/[^a-z]/g, ""))
  );
  const street = (typeAt >= 0 ? rest.slice(0, typeAt + 1) : rest).map(
    titleWord,
  ).join(" ");
  return street || null;
}

export function workOf(jobType: unknown): string {
  const type = String(jobType ?? "").toLowerCase();
  return type === "fencing" ? "fence" : type === "patio" ? "patio" : "work";
}

/**
 * The template draft for a due text step (spec section 5). Progress payments swap "final
 * invoice" for the stage ("materials invoice").
 */
export function stepTemplateText(
  step: TextStep,
  kind: "final" | "progress",
  stage: string | null,
  vars: TemplateVars,
): string {
  const template = vars.pay_link
    ? STEP_TEMPLATES[step].withLink
    : STEP_TEMPLATES[step].noLink;
  const text = fill(template, {
    name: vars.name,
    street: vars.street || "your place",
    work: vars.work,
    amount: money(vars.amount),
    pay_link: vars.pay_link ?? "",
    date17: vars.date17,
    date21: vars.date21,
    overdue_days: String(vars.overdue_days),
  });
  return kind === "progress"
    ? text.replace(/final invoice/g, `${stage || "progress"} invoice`)
    : text;
}

export type ReplyTemplate = keyof typeof REPLY_TEMPLATES;

export function replyTemplateText(
  which: ReplyTemplate,
  vars: ReplyVars,
): string {
  return fill(REPLY_TEMPLATES[which], {
    name: vars.name,
    promise_date: vars.promise_date && isIsoDate(vars.promise_date)
      ? longDate(vars.promise_date)
      : String(vars.promise_date ?? "the day you mentioned"),
    issue: String(vars.issue ?? "problem"),
    installer: String(vars.installer ?? "Our installer"),
    street: String(vars.street ?? "your place"),
  });
}

export const MAX_TEXT_LENGTH = 1600;

const NEVER_SAY =
  /\blegal\b|\blawyers?\b|\bsolicitors?\b|debt collect|collection agenc|\bcollectors?\b|credit (report|rating|file|score|bureau|history)|\bmagistrates?\b|small claims|\btribunal\b|\bsue\b|\bsuing\b/i;

/** Dashes and emojis are never written anywhere (spec section 1.7). */
export function styleProblem(text: string): string | null {
  if (/[\u2013\u2014]/.test(text)) {
    return "Use a comma or a full stop instead of a long dash";
  }
  if (/\p{Extended_Pictographic}/u.test(text)) return "Remove the emoji";
  return null;
}

/** Why a client message must not go, or null. */
export function clientTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "The message is empty";
  if (text.length > MAX_TEXT_LENGTH) {
    return `The message is longer than ${MAX_TEXT_LENGTH} characters`;
  }
  const style = styleProblem(text);
  if (style) return style;
  if (NEVER_SAY.test(text)) {
    return "Never mention legal action, debt collectors or credit reporting";
  }
  if (/\{[a-z0-9_]+\}/.test(text)) {
    return "The message still has a blank to fill in";
  }
  return null;
}

// ── Section 6: the bank-feed check ──

export interface BankTransaction {
  bank_transaction_id: string;
  type: string | null;
  date: string | null;
  total: number | null;
  reference: string | null;
  contact_name: string | null;
  line_item_descriptions: string[];
}

export interface PossiblePayment {
  bank_transaction_id: string;
  date: string | null;
  amount: number;
  contact_name: string | null;
  reference: string | null;
  description: string | null;
  /** The payer text to show: contact, else reference, else description. */
  payer_text: string;
  reason: string;
}

const STOP_WORDS = new Set(
  (
    "the and mrs miss mr ms dr pty ltd limited family trust payment transfer deposit invoice " +
    "inv bank fence fencing patio balance final from for with fast osko bpay paid pay internet " +
    "online direct credit debit ref reference secureworks secure works group"
  ).split(" "),
);

/** Meaningful name tokens: 3+ letters, not a stop word. */
export function nameTokens(names: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of String(name ?? "").toLowerCase().split(/[^a-z]+/)) {
      if (token.length >= 3 && !STOP_WORDS.has(token)) out.add(token);
    }
  }
  return [...out];
}

/**
 * Unreconciled bank transactions that may be this invoice's payment (spec section 6). An
 * amount match alone counts: better to ask than to chase someone who paid.
 */
export function possiblePayments(
  invoice: {
    invoice_number: string | null;
    amount_due: number | null;
    total: number | null;
    invoice_date: string | null;
  },
  names: Array<string | null | undefined>,
  transactions: BankTransaction[],
): PossiblePayment[] {
  const from = invoice.invoice_date && isIsoDate(invoice.invoice_date)
    ? addDays(invoice.invoice_date, -1)
    : null;
  const number = String(invoice.invoice_number ?? "").trim().toLowerCase();
  const tokens = nameTokens(names);
  const out: PossiblePayment[] = [];
  for (const tx of transactions) {
    if (!String(tx.type ?? "").toUpperCase().startsWith("RECEIVE")) continue;
    const total = Number(tx.total);
    if (!Number.isFinite(total)) continue;
    const date = tx.date ? String(tx.date).slice(0, 10) : null;
    if (from && date && date < from) continue;
    const near = (target: number | null) =>
      target !== null && Number.isFinite(Number(target)) &&
      Math.abs(cents(total) - cents(target)) <= 100;
    if (!near(invoice.amount_due) && !near(invoice.total)) continue;
    const description = tx.line_item_descriptions.join(" ").trim() || null;
    const haystack = [tx.reference, description].filter(Boolean).join(" ")
      .toLowerCase();
    const nameHaystack = [tx.contact_name, tx.reference, description].filter(
      Boolean,
    ).join(" ").toLowerCase();
    let reason = "amount matches, name unclear";
    if (number && haystack.includes(number)) {
      reason = "amount and invoice number match";
    } else if (
      tokens.some((t) => new RegExp(`\\b${t}\\b`).test(nameHaystack))
    ) reason = "amount and name match";
    out.push({
      bank_transaction_id: tx.bank_transaction_id,
      date,
      amount: cents(total) / 100,
      contact_name: tx.contact_name,
      reference: tx.reference,
      description,
      payer_text: tx.contact_name || tx.reference || description || "unknown",
      reason,
    });
  }
  return out;
}

// ── Section 4: Jan's visit list text ──

export interface JanListItem {
  share_key: string;
  xero_invoice_id: string;
  invoice_number: string | null;
  name: string;
  site_address: string | null;
  phone: string | null;
  amount: number;
  history: string;
}

/** "Texted 1st, 3rd, 7th · called 7th" from the share's log (Perth day of month). */
export function historyLine(
  log: Array<{ kind: string; created_at: string }>,
): string {
  const days = (kind: string) =>
    log.filter((r) => r.kind === kind)
      .map((r) => perthDateOf(r.created_at))
      .filter((d): d is string => !!d)
      .sort()
      .map((d) => ordinal(Number(d.slice(8, 10))));
  const texts = days("text_sent");
  const calls = days("call");
  const parts: string[] = [];
  if (texts.length) parts.push(`Texted ${texts.join(", ")}`);
  if (calls.length) parts.push(`called ${calls.join(", ")}`);
  return parts.length ? parts.join(" · ") : "No texts or calls logged";
}

export function janListText(visitDate: string, items: JanListItem[]): string {
  const lines = items.map((item, k) =>
    `${k + 1}. ${item.name}, ${item.site_address || "address not set"}, ${
      item.phone || "no phone"
    }, ${money(item.amount)}. ${item.history}`
  );
  return `Hi Jan,\n\nHere's the visit list for ${longDate(visitDate)}:\n\n${
    lines.join("\n\n")
  }${SIGN}`;
}

// ── Section 4: the company statement email ──

export interface StatementLine {
  xero_invoice_id: string;
  invoice_number: string | null;
  job_ref: string | null;
  invoice_date: string | null;
  amount: number;
  days_overdue: number;
  pay_link: string | null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function statementSubject(companyName: string, weekStart: string) {
  return `${companyName}: statement of overdue invoices, week of ${
    longDate(weekStart)
  }`;
}

/** The statement HTML: one table row per invoice with its Xero online invoice link, then the total. */
export function statementHtml(input: {
  company_name: string;
  week_start: string;
  lines: StatementLine[];
}): string {
  const total = input.lines.reduce((sum, l) => sum + cents(l.amount), 0) / 100;
  const cell = 'style="padding:6px 10px;border-bottom:1px solid #ddd"';
  const right =
    'style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right"';
  const rows = input.lines.map((l) =>
    `<tr><td ${cell}>${escapeHtml(l.invoice_number || "")}</td><td ${cell}>${
      escapeHtml(l.job_ref || "")
    }</td><td ${cell}>${
      escapeHtml(l.invoice_date ? longDate(l.invoice_date) : "")
    }</td><td ${right}>${escapeHtml(money(l.amount))}</td><td ${right}>${
      escapeHtml(String(l.days_overdue))
    }</td><td ${cell}>${
      l.pay_link
        ? `<a href="${escapeHtml(l.pay_link)}">View and pay</a>`
        : "Link to follow"
    }</td></tr>`
  ).join("");
  return [
    `<p>Hi ${escapeHtml(input.company_name)} accounts team,</p>`,
    `<p>Hope you're well! Below are the invoices from SecureWorks Group that are now past their due date. Each one links to the invoice in Xero, where it can be viewed and paid.</p>`,
    `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">`,
    `<thead><tr><th ${cell}>Invoice</th><th ${cell}>Job or address</th><th ${cell}>Invoice date</th><th ${right}>Amount</th><th ${right}>Days overdue</th><th ${cell}>Invoice</th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `<tfoot><tr><td ${cell} colspan="3"><strong>Total overdue</strong></td><td ${right}><strong>${
      escapeHtml(money(total))
    }</strong></td><td ${cell} colspan="2"></td></tr></tfoot>`,
    `</table>`,
    `<p>If any of these have already been paid, please let us know the payment date so we can match it up.</p>`,
    `<p>Cheers,<br>Shaun<br>SecureWorks Group</p>`,
  ].join("\n");
}
