// Debt Workshop read model: the debt book worked out from our Xero copy (xero_invoices), the
// jobs, and the workshop tables, with the rules in debt_ws_rules.ts. The overview, the job
// view, the statement preview, Jan's visit list and the agent queue all read through
// loadBook, so the screen, the sends and the agent see one answer.
//
// Reads only. No Xero call is made here: the live Xero checks, pay links and bank feed sit
// in debt_ws_actions.ts behind injected dependencies.

import {
  addDays,
  type BankTransaction,
  CATEGORIES,
  type Category,
  categoryFor,
  type Classification,
  classifyInvoice,
  daysBetween,
  dayZeroFor,
  type DebtKind,
  dueDateFor,
  firstNameOf,
  historyLine,
  inScope,
  isLadderStep,
  isNotChased,
  isReplyStep,
  isTextStep,
  type JanListItem,
  ladderFor,
  type LadderResult,
  longDate,
  mondayOf,
  nextMonday,
  normaliseName,
  onJanList,
  payerLabel,
  perthDate,
  perthDateOf,
  type PossiblePayment,
  possiblePayments,
  STEP_LABELS,
  stepDate,
  stepTemplateText,
  streetOf,
  type TextStep,
  workOf,
  type WsInvoice,
  type WsJob,
} from "./debt_ws_rules.ts";
import type {
  DebtWsSettings,
  DebtWsStore,
  WsJanListRow,
  WsLogRow,
  WsSendRow,
  WsState,
  WsStatementRow,
  WsSuggestion,
} from "./debt_ws_store.ts";

export interface OverviewRow {
  share_key: string;
  xero_invoice_id: string;
  invoice_number: string | null;
  reference: string | null;
  job_id: string | null;
  job_number: string | null;
  job_type: string | null;
  lane: "homeowner" | "account";
  payer_name: string;
  payer_label: string;
  neighbour_of: string | null;
  kind: DebtKind;
  amount_due: number;
  invoice_date: string | null;
  due_date: string;
  day: number;
  category: Category | null;
  step_due: { step: string; label: string } | null;
  next_step: { step: string; date: string } | null;
  paused_until: string | null;
  suggestion: { id: string | null; source: string; status: string } | null;
  ghl_linked: boolean;
  last_touch: { kind: string; at: string; label: string } | null;
  on_jan_list: boolean;
  // Additions beyond the spec shape (a superset; the screen may ignore them).
  flag_count: number;
  share: string | null;
  share_letter: string;
  stage: string | null;
  company_key: string | null;
  not_chased: boolean;
  says_paid_since: string | null;
  cycle_start: string;
  open: boolean;
}

export interface BookEntry {
  inv: WsInvoice;
  job: WsJob | null;
  cls: Classification & { status: "debt" };
  kind: DebtKind;
  open: boolean;
  notChased: boolean;
  dueDate: string;
  dayZero: string;
  day: number;
  category: Category | null;
  ladder: LadderResult;
  state: WsState | null;
  logs: WsLogRow[];
  sends: WsSendRow[];
  suggestions: WsSuggestion[];
  /** The pending draft or move the screen shows, or null. */
  suggestion: WsSuggestion | null;
  flags: WsSuggestion[];
  companyKey: string | null;
  row: OverviewRow;
}

export interface NeedsALook {
  xero_invoice_id: string;
  invoice_number: string | null;
  payer_name: string;
  amount_due: number;
  reason: string;
  job_id: string | null;
  job_number: string | null;
}

export interface Book {
  today: string;
  readAt: Date;
  settings: DebtWsSettings;
  entries: BookEntry[];
  needsALook: NeedsALook[];
  /** Go-ahead payments: never debt, hidden (kept for the job view's invoice list). */
  goAhead: WsInvoice[];
  jobs: Map<string, WsJob>;
  history: Map<string, WsInvoice[]>;
  janVisitDate: string;
  janRow: WsJanListRow | null;
}

const uniq = (
  xs: Array<string | null | undefined>,
) => [...new Set(xs.filter((x): x is string => !!x))];

function groupBy<T>(xs: T[], key: (x: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!k) continue;
    out.set(k, [...(out.get(k) || []), x]);
  }
  return out;
}

const LAST_TOUCH_LABELS: Record<string, string> = {
  note: "Note",
  text_sent: "Texted",
  email_sent: "Emailed",
  call: "Called",
  statement_sent: "Statement sent",
  jan_list: "On Jan's visit list",
  category_change: "Category changed",
  promise: "Promise to pay",
  link_contact: "Contact linked",
  agent_flag: "Agent flag",
  send_refused: "Send refused",
  skip: "Skipped",
};

function lastTouch(logs: WsLogRow[]): OverviewRow["last_touch"] {
  const latest = logs[0];
  if (!latest) return null;
  const base = LAST_TOUCH_LABELS[latest.kind] ?? latest.kind;
  const step = latest.step && STEP_LABELS[latest.step as TextStep]
    ? ` (${latest.step})`
    : "";
  return { kind: latest.kind, at: latest.created_at, label: `${base}${step}` };
}

/** Steps sent or claimed by a send in this cycle. */
function sentSteps(sends: WsSendRow[], cycleStart: string): Set<string> {
  return new Set(
    sends.filter((s) =>
      s.cycle_start === cycleStart &&
      (s.status === "sending" || s.status === "sent")
    ).map((s) => s.step),
  );
}

function skippedSteps(logs: WsLogRow[], cycleStart: string): Set<string> {
  return new Set(
    logs.filter((l) =>
      l.kind === "skip" && l.step && l.meta?.cycle_start === cycleStart
    ).map((l) => l.step as string),
  );
}

/**
 * The pending draft or move the screen shows. A ladder draft counts only for the step due
 * now in this cycle; a move or a reply draft counts whatever the step.
 */
export function shownSuggestion(
  suggestions: WsSuggestion[],
  stepDue: string | null,
  cycleStart: string,
): WsSuggestion | null {
  const pending = suggestions.filter((s) =>
    s.status === "pending" && (s.kind === "draft" || s.kind === "move")
  ).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return pending.find((s) =>
    s.kind === "move" || isReplyStep(s.step) ||
    (isLadderStep(s.step) && s.step === stepDue &&
      (!s.cycle_start || s.cycle_start === cycleStart))
  ) ?? null;
}

/**
 * The company an account invoice belongs to: the canonical Xero contact id after
 * debt_ws_settings.company_aliases (one builder can sit on several Xero contacts), else
 * "name:" and the normalised contact name when the invoice has no contact id.
 */
export function companyKeyOf(
  inv: Pick<WsInvoice, "xero_contact_id" | "contact_name">,
  aliases: Record<string, string> = {},
): string {
  if (!inv.xero_contact_id) return `name:${normaliseName(inv.contact_name)}`;
  return canonicalCompanyKey(String(inv.xero_contact_id), aliases);
}

/** A company key (or an alias contact id) as its canonical key, lower case. */
export function canonicalCompanyKey(
  key: string,
  aliases: Record<string, string> = {},
): string {
  const id = key.trim().toLowerCase();
  return aliases[id] ?? id;
}

export interface LoadBookOptions {
  now: Date;
  /** Read only these invoices (any status), with their jobs' history. Default: the open book. */
  invoiceIds?: string[];
}

export async function loadBook(
  store: DebtWsStore,
  options: LoadBookOptions,
): Promise<Book> {
  const today = perthDate(options.now);
  const settings = await store.settings();
  const explicit = !!options.invoiceIds;
  const invoices = explicit
    ? (await store.invoicesByIds(options.invoiceIds!)).filter((i) =>
      !String(i.reference ?? "").toUpperCase().includes("SAMPLE-")
    )
    : (await store.openInvoices()).filter(inScope);

  const jobIds = uniq(invoices.map((i) => i.job_id));
  const janVisitDate = nextMonday(today);
  const [jobRows, historyRows, exits, janRow] = await Promise.all([
    jobIds.length ? store.jobs(jobIds) : Promise.resolve([]),
    jobIds.length ? store.jobInvoices(jobIds) : Promise.resolve([]),
    jobIds.length ? store.rectificationExits(jobIds) : Promise.resolve([]),
    store.janList(janVisitDate),
  ]);
  const jobs = new Map(jobRows.map((j) => [String(j.id), j]));
  const history = groupBy(historyRows, (i) => i.job_id);
  const exitByJob = new Map(
    exits.map((e) => [e.job_id, perthDateOf(e.occurred_at)]),
  );
  const removed = new Set(janRow?.removed_share_keys ?? []);

  const debt: Array<{
    inv: WsInvoice;
    job: WsJob | null;
    cls: Classification & { status: "debt" };
  }> = [];
  const needsALook: NeedsALook[] = [];
  const goAhead: WsInvoice[] = [];
  for (const inv of invoices) {
    const job = inv.job_id ? jobs.get(String(inv.job_id)) ?? null : null;
    const shareHistory = job ? history.get(String(job.id)) ?? [] : [];
    const cls = classifyInvoice(inv, job, shareHistory);
    if (cls.status === "debt") debt.push({ inv, job, cls });
    else if (cls.status === "go_ahead") goAhead.push(inv);
    else if (inScope(inv)) {
      needsALook.push({
        xero_invoice_id: inv.xero_invoice_id,
        invoice_number: inv.invoice_number,
        payer_name: inv.contact_name || job?.client_name || "Unknown payer",
        amount_due: Number(inv.amount_due || 0),
        reason: cls.reason,
        job_id: job?.id ?? null,
        job_number: job?.job_number ?? null,
      });
    }
  }

  const shareKeys = debt.map((d) => d.inv.xero_invoice_id);
  const [states, logs, sends, suggestions] = shareKeys.length
    ? await Promise.all([
      store.states(shareKeys),
      store.logs(shareKeys),
      store.sends(shareKeys),
      store.suggestions(shareKeys),
    ])
    : [[], [], [], []];
  const stateBy = new Map(states.map((s) => [s.share_key, s]));
  const logsBy = groupBy(logs, (l) => l.share_key);
  const sendsBy = groupBy(sends, (s) => s.share_key);
  const suggestionsBy = groupBy(suggestions, (s) => s.share_key);

  const entries: BookEntry[] = [];
  for (const { inv, job, cls } of debt) {
    const key = inv.xero_invoice_id;
    const kind = cls.kind;
    const invoiceDate = inv.invoice_date ?? today;
    const dueDate = dueDateFor(kind, invoiceDate);
    const dayZero = dayZeroFor(
      kind,
      dueDate,
      job ? exitByJob.get(String(job.id)) ?? null : null,
    );
    const day = daysBetween(dayZero, today);
    const state = stateBy.get(key) ?? null;
    const open = inScope(inv);
    const category = open
      ? categoryFor({
        day,
        saysPaid: !!state?.says_paid_since,
        jobStatus: job?.status ?? null,
      })
      : null;
    const rawContact = inv.xero_contact_id
      ? String(inv.xero_contact_id).toLowerCase()
      : null;
    const notChased = isNotChased(
      inv.contact_name,
      settings.not_chased_contacts,
      [
        rawContact,
        rawContact ? companyKeyOf(inv, settings.company_aliases) : null,
      ],
    );
    const shareLogs = (logsBy.get(key) ?? []).sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at))
    );
    const shareSends = sendsBy.get(key) ?? [];
    const ladder = ladderFor({
      kind,
      dayZero,
      today,
      category,
      pausedUntil: state?.paused_until ?? null,
      notChased: notChased || !open,
      sent: sentSteps(shareSends, dayZero),
      skipped: skippedSteps(shareLogs, dayZero),
    });
    const shareSuggestions = suggestionsBy.get(key) ?? [];
    const suggestion = shownSuggestion(
      shareSuggestions,
      ladder.step_due?.step ?? null,
      dayZero,
    );
    const flags = shareSuggestions.filter((s) =>
      s.kind === "flag" && s.status === "pending"
    );
    const payer = inv.contact_name || job?.client_name || "Unknown payer";
    const label = cls.lane === "homeowner"
      ? payerLabel(payer, job?.client_name ?? null, cls.letter)
      : { label: payer, neighbourOf: null };
    const companyKey = cls.lane === "account"
      ? companyKeyOf(inv, settings.company_aliases)
      : null;
    const templateReady = !!ladder.step_due && isTextStep(ladder.step_due.step);
    const row: OverviewRow = {
      share_key: key,
      xero_invoice_id: key,
      invoice_number: inv.invoice_number,
      reference: inv.reference,
      job_id: job?.id ?? null,
      job_number: job?.job_number ?? null,
      job_type: job?.type ?? null,
      lane: cls.lane,
      payer_name: payer,
      payer_label: label.label,
      neighbour_of: label.neighbourOf,
      kind,
      amount_due: Number(inv.amount_due || 0),
      invoice_date: inv.invoice_date,
      due_date: dueDate,
      day,
      category,
      step_due: ladder.step_due,
      next_step: ladder.next_step,
      paused_until: state?.paused_until ?? null,
      suggestion: suggestion
        ? { id: suggestion.id, source: suggestion.source, status: "pending" }
        : templateReady
        ? { id: null, source: "template", status: "pending" }
        : null,
      ghl_linked: !!job?.ghl_contact_id,
      last_touch: lastTouch(shareLogs),
      on_jan_list: onJanList({
        kind,
        reached: ladder.reached,
        paused: ladder.paused,
        category,
        notChased,
        removed: removed.has(key),
      }),
      flag_count: flags.length,
      share: cls.share,
      share_letter: cls.letter,
      stage: cls.stage,
      company_key: companyKey,
      not_chased: notChased,
      says_paid_since: state?.says_paid_since ?? null,
      cycle_start: dayZero,
      open,
    };
    entries.push({
      inv,
      job,
      cls,
      kind,
      open,
      notChased,
      dueDate,
      dayZero,
      day,
      category,
      ladder,
      state,
      logs: shareLogs,
      sends: shareSends,
      suggestions: shareSuggestions,
      suggestion,
      flags,
      companyKey,
      row,
    });
  }

  return {
    today,
    readAt: options.now,
    settings,
    entries,
    needsALook,
    goAhead,
    jobs,
    history,
    janVisitDate,
    janRow,
  };
}

const CATEGORY_RANK: Record<Category, number> = {
  bad_debt: 0,
  escalating: 1,
  active: 2,
  rectification: 3,
  says_paid: 4,
};

export function sortRows(rows: OverviewRow[]): OverviewRow[] {
  return [...rows].sort((a, b) => {
    const ca = a.category ? CATEGORY_RANK[a.category] : 9;
    const cb = b.category ? CATEGORY_RANK[b.category] : 9;
    if (ca !== cb) return ca - cb;
    if (a.day !== b.day) return b.day - a.day;
    return a.share_key.localeCompare(b.share_key);
  });
}

// ── Template drafts ──

export interface DraftView {
  id: string | null;
  step: string;
  kind: "draft" | "move" | "flag";
  channel: "sms" | "email" | null;
  text: string;
  why: string;
  source: "agent" | "template";
  proposed_category: "says_paid" | "rectification" | null;
  amount: number;
}

/** The code's draft for the due text step, or null when no text step is due. */
export function templateDraftFor(
  entry: BookEntry,
  payLink: string | null,
): DraftView | null {
  const step = entry.ladder.step_due?.step;
  if (!isTextStep(step) || entry.kind === "account") return null;
  const text = stepTemplateText(
    step,
    entry.kind,
    entry.cls.stage,
    {
      name: firstNameOf(entry.row.payer_name),
      street: streetOf(entry.job?.site_address),
      work: workOf(entry.job?.type),
      amount: entry.row.amount_due,
      pay_link: payLink,
      date17: longDate(stepDate(entry.dayZero, "d17")),
      date21: longDate(stepDate(entry.dayZero, "d21")),
      overdue_days: Math.max(entry.day, 0),
    },
  );
  return {
    id: null,
    step,
    kind: "draft",
    channel: "sms",
    text,
    why: `Day ${entry.day}: ${
      STEP_LABELS[step]
    } is due. This is the standard template; no agent suggestion yet.`,
    source: "template",
    proposed_category: null,
    amount: entry.row.amount_due,
  };
}

export function suggestionView(s: WsSuggestion): DraftView {
  return {
    id: s.id,
    step: s.step ?? "",
    kind: s.kind,
    channel: s.channel,
    text: s.text ?? "",
    why: s.why ?? "",
    source: s.source,
    proposed_category: s.proposed_category,
    amount: Number(s.amount ?? 0),
  };
}

// ── The overview ──

export interface ViewerSettings {
  sending_on: boolean;
  viewer_is_owner: boolean;
  owner_set: boolean;
}

/**
 * The accounts email for a company: statement_emails keyed by the canonical contact id
 * (any case); a key that is the company's name is a fallback only.
 */
function statementEmailFor(
  settings: DebtWsSettings,
  companyKey: string,
  name: string | null,
): string | null {
  const map = settings.statement_emails;
  const byKey = Object.entries(map).find(([k]) =>
    k.trim().toLowerCase() === companyKey
  )?.[1];
  const wanted = normaliseName(name);
  const byName = Object.entries(map).find(([k]) =>
    normaliseName(k) === wanted && !!wanted
  )?.[1];
  const email = typeof byKey === "string"
    ? byKey
    : typeof byName === "string"
    ? byName
    : null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? email.trim()
    : null;
}

export type StatementStatus = "ready" | "sent" | "no_email" | "nothing_due";

export interface CompanyView {
  company_key: string;
  name: string;
  past_due: { count: number; amount: number; oldest_days: number };
  in_grace: { count: number; amount: number };
  category: Category | null;
  statement: { week_start: string; status: StatementStatus };
  // Additions beyond the spec shape.
  to_email: string | null;
  xero_invoice_ids: string[];
}

const sumCents = (xs: number[]) =>
  Math.round(xs.reduce((s, x) => s + Math.round(x * 100), 0)) / 100;

export function companiesOf(
  book: Book,
  statements: WsStatementRow[],
): CompanyView[] {
  const weekStart = mondayOf(book.today);
  const groups = groupBy(
    book.entries.filter((e) => e.kind === "account" && e.open && !e.notChased),
    (e) => e.companyKey,
  );
  const out: CompanyView[] = [];
  for (const [companyKey, entries] of groups) {
    // The name on the canonical contact when one of its invoices is open, else the first.
    const named = entries.find((e) =>
      String(e.inv.xero_contact_id ?? "").toLowerCase() === companyKey
    ) ?? entries[0];
    const name = named.inv.contact_name || "Unknown company";
    const pastDue = entries.filter((e) =>
      e.day >= 1
    );
    const inGrace = entries.filter((e) => e.day < 1);
    const toEmail = statementEmailFor(book.settings, companyKey, name);
    const sent = statements.some((s) =>
      s.company_key === companyKey &&
      (s.status === "sent" || s.status === "sending")
    );
    const status: StatementStatus = !pastDue.length
      ? "nothing_due"
      : sent
      ? "sent"
      : !toEmail
      ? "no_email"
      : "ready";
    const worst =
      pastDue.map((e) => e.category).filter((c): c is Category => !!c).sort((
        a,
        b,
      ) => CATEGORY_RANK[a] - CATEGORY_RANK[b])[0] ?? null;
    out.push({
      company_key: companyKey,
      name,
      past_due: {
        count: pastDue.length,
        amount: sumCents(pastDue.map((e) => e.row.amount_due)),
        oldest_days: pastDue.reduce((m, e) => Math.max(m, e.day), 0),
      },
      in_grace: {
        count: inGrace.length,
        amount: sumCents(inGrace.map((e) => e.row.amount_due)),
      },
      category: worst,
      statement: { week_start: weekStart, status },
      to_email: toEmail,
      xero_invoice_ids: entries.map((e) => e.inv.xero_invoice_id),
    });
  }
  return out.sort((a, b) => b.past_due.amount - a.past_due.amount);
}

export async function paidThisWeek(store: DebtWsStore, today: string) {
  const from = mondayOf(today);
  const to = addDays(from, 6);
  const paid = (await store.paidBetween(from, to)).filter((i) =>
    !String(i.reference ?? "").toUpperCase().includes("SAMPLE-")
  );
  const jobIds = uniq(paid.map((i) => i.job_id));
  const [jobRows, historyRows] = jobIds.length
    ? await Promise.all([store.jobs(jobIds), store.jobInvoices(jobIds)])
    : [[], []];
  const jobs = new Map(jobRows.map((j) => [String(j.id), j]));
  const history = groupBy(historyRows, (i) => i.job_id);
  // A go-ahead payment was never debt, so it is not "paid this week" either.
  const items = paid.filter((inv) => {
    const job = inv.job_id ? jobs.get(String(inv.job_id)) ?? null : null;
    return classifyInvoice(
      inv,
      job,
      job ? history.get(String(job.id)) ?? [] : [],
    ).status !== "go_ahead";
  }).map((inv) => ({
    invoice_number: inv.invoice_number,
    payer_name: inv.contact_name || "Unknown payer",
    amount: Number(inv.total || 0),
    paid_on: inv.fully_paid_on ?? null,
    xero_invoice_id: inv.xero_invoice_id,
  })).sort((a, b) => String(b.paid_on).localeCompare(String(a.paid_on)));
  return {
    count: items.length,
    amount: sumCents(items.map((i) => i.amount)),
    items,
    week_start: from,
    week_end: to,
  };
}

export function categoryTotals(entries: BookEntry[]) {
  const out = Object.fromEntries(
    CATEGORIES.map((c) => [c, { count: 0, amount: 0 }]),
  ) as Record<Category, { count: number; amount: number }>;
  for (const e of entries) {
    if (!e.open || !e.category) continue;
    out[e.category].count += 1;
    out[e.category].amount = sumCents([
      out[e.category].amount,
      e.row.amount_due,
    ]);
  }
  return out;
}

// ── Jan's visit list ──

export function janItemsLive(book: Book): JanListItem[] {
  return book.entries.filter((e) => e.row.on_jan_list).map((e) => ({
    share_key: e.row.share_key,
    xero_invoice_id: e.inv.xero_invoice_id,
    invoice_number: e.inv.invoice_number,
    name: e.row.payer_label,
    site_address: [e.job?.site_address, e.job?.site_suburb].filter(Boolean)
      .filter((part, k, all) =>
        k === 0 ||
        !String(all[0]).toLowerCase().includes(String(part).toLowerCase())
      ).join(", ") || null,
    phone: e.job?.client_phone ?? null,
    amount: e.row.amount_due,
    history: historyLine(e.logs),
  }));
}

// ── Possible payments for display (cached bank feed) ──

export function possiblePaymentsFor(
  entry: BookEntry,
  transactions: BankTransaction[],
): PossiblePayment[] {
  return possiblePayments(
    entry.inv,
    [entry.inv.contact_name, entry.job?.client_name],
    transactions,
  );
}
