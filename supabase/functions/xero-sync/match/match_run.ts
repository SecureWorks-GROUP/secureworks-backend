// P2-02.7 (Follow-up 66 b): run the matcher on cost documents the sync just
// changed, on the match queue, and in a bounded sweep over waiting bills with
// no open Reconcile item (match_sweep).
//
// PROPOSALS ONLY. The matcher may name a job for a bill from a job number, an
// order (a PO named on the bill, a sealed-scope order or one open order of the
// same amount) or other clues, but it never places one: a decideMatch result of
// `auto` is sent to match_apply as a `suggest` (reason `office_confirms`) with
// `would_place: true`, so the office confirms it on the Reconcile list. With
// reconcile_matcher_v1 off (as seeded) match_apply writes only the clues and a
// shadow row and raises nothing.
//
// Bills only (`xero_bill:<id>`). Every other subject is skipped and counted. A
// supplier credit that follows a bill is moved by job_cost_lines_refollow when
// the bill is decided, never by the matcher.
//
// A failed read never counts as "no clue": that subject is skipped, requeued
// and counted. Logs carry codes and counts only. Every read is per document.
//
// The sync (director 01:03): the matcher switch is read once at the start of
// the sync. Off, the sync makes no matcher read or write at all. On, matching
// starts after the Xero paging, with one 20 s budget and at most 50 bills a
// run: the bills the sync changed, then bills waiting in match_queue, then
// waiting bills (documents) with no open item, oldest first, to fill the 50
// (syncMatchRun). A backlog bill the budget does not reach is not requeued:
// the kept position stops before it. Every requeue of a run is one batched
// statement.
//
// The budget bounds one slow bill too (director 02:45): each bill's requests
// share one abort signal set to the time left when the bill starts. A request
// is never started once it has fired (the match_apply write included), and a
// request it cuts short counts `over_run_time` and the bill is requeued. A
// write cut short may still have committed in the database; it is requeued and
// counted `apply_over_run_time`, never `applied`, and a rerun is safe.
//
// The bill's reads go through match_bill_read (design read 03:26): one
// service-only function of fixed named reads with SET statement_timeout 5s,
// which PostgREST hoists onto the request, so a slow read ends in the database
// at 5 s, not only in the worker. A statement timeout (57014) is a cut too. A
// bill cut while it started with more than half the run's budget is counted in
// match_slow_bills; at two such cuts it is parked (`parked_slow_bill`, counted
// in `parked` and then in `skipped`) and passed over by every path until the
// sync reports its lines changed, except one more try once the park is 24
// hours old (cut again, parked again, count kept). A clean run clears the
// count. Deleting a bill's row in match_slow_bills is the manual undo.
//
// A bill with a person's labour on it is never matched here: no clue, no
// shadow row, no item. It is skipped and counted (`labour_bill`). That is a
// line of kind installer_bill or employer_super, a line on an installer account
// (301, 306: the installer_bill_outside_app stop), or a bill from a Xero
// contact that is a Trade App user. Each carries a name and a pay total.
// A bill with a line on an account hidden from Reconcile that is not labour
// (475, director 03:36) is skipped the same way, counted `hidden_account_bill`:
// never proposed, its kind unchanged. Both sets are people_account_codes
// (_shared/people_accounts.ts), checked on our cost lines and Xero's lines.

import { jobNumbersIn } from "../bill_prematch.ts";
import { hiddenSkip, type PeopleAccounts, peopleAccountsCode, readPeopleAccounts } from "../../_shared/people_accounts.ts";
import { decideMatch } from "./decide.ts";
import {
  deliveryAddressClue,
  documentStops,
  groupTagClue,
  jobNumberClue,
  type MatchDocument,
  type MatchJob,
  type NamedOrder,
  orderNumberClue,
  overheadAccountClue,
} from "./doc_clues.ts";
import {
  type MatchOrder,
  orderAmountClue,
  sealedScopeOrderClue,
  supplierNameKey,
} from "./order_clues.ts";
import {
  type BillEvidenceRow,
  duplicateStop,
  type OtherCostDocument,
  samePersonStop,
  supplierMailClue,
} from "./record_clues.ts";
import type { Clue, ClueType, MatchResult, Stop } from "./types.ts";

export const MATCH_RUN_LIMIT = 50;
export const MATCH_RUN_BUDGET_MS = 20_000;
/** Waiting bills (documents, not lines) with no open item a sync run takes, oldest first, inside the run's 50. */
export const MATCH_BACKLOG_LIMIT = 50;
/** Lines read per backlog page. */
export const MATCH_BACKLOG_LINE_PAGE = 300;
/** Bills of a page looked at per run (open-item and labour reads in chunks of MATCH_BACKLOG_CHUNK). */
export const MATCH_BACKLOG_DOCS = 100;
const MATCH_BACKLOG_CHUNK = 50;
/** Client-side limit on the batched requeue and the backlog reads. */
export const MATCH_STATEMENT_TIMEOUT_MS = 5_000;
/** A person's labour: never matched or raised here (#1678 hides these bills from the list). */
export const LABOUR_LINE_KINDS = new Set(["installer_bill", "employer_super"]);
/** xero_sync_state key holding the backlog position. */
export const MATCH_BACKLOG_STATE_KEY = "match_backlog";
const ORDER_WINDOW_DAYS = 60;

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface MatchRunReport {
  run: number;
  applied: Record<string, number>;
  requeued: number;
  /** Bills parked this run after their second cut (`parked_slow_bill`), a retried one parked again included. */
  parked: number;
  /** Parked bills tried once more this run because their park is 24 hours old. */
  parked_retried: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
}

class ReadFailed extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** A request the bill's signal cut short, or one not started because the signal had fired. */
export const OVER_TIME = "over_run_time";
const APPLY_OVER_TIME = "apply_over_run_time";
/** A bill parked after two cuts; passed over until the sync reports its lines changed. */
export const PARKED_SLOW_BILL = "parked_slow_bill";
/** A cut counts towards parking only when the bill started with more than this share of the run's budget. */
export const MATCH_SLOW_START_SHARE = 0.5;
/** Cuts that park a bill. */
export const MATCH_SLOW_PARK_CUTS = 2;
/** A parked bill is tried once more after this long (director 03:57); cut again, it is parked again with its count kept. */
export const MATCH_PARKED_RETRY_MS = 24 * 60 * 60 * 1000;

/** Postgres ended the statement at its statement_timeout (match_bill_read's 5 s). */
const statementTimedOut = (error: unknown) => (error as { code?: unknown } | null)?.code === "57014";

async function read<T>(code: string, q: PromiseLike<{ data: T; error: unknown }>, signal?: AbortSignal): Promise<T> {
  let res: { data: T; error: unknown };
  try {
    res = await q;
  } catch {
    throw new ReadFailed(signal?.aborted ? OVER_TIME : code);
  }
  if (res.error) throw new ReadFailed(signal?.aborted || statementTimedOut(res.error) ? OVER_TIME : code);
  return res.data;
}

/** Attaches the bill's signal to a request, or refuses to start it once the signal has fired. */
function bound(signal: AbortSignal) {
  return <B extends { abortSignal: (s: AbortSignal) => B }>(q: B): B => {
    if (signal.aborted) throw new ReadFailed(OVER_TIME);
    return q.abortSignal(signal);
  };
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

type Row = Record<string, unknown>;

/** One of the bill's fixed reads, through match_bill_read, carrying the bill's signal. */
function billReader(sb: Sb, signal: AbortSignal) {
  const on = bound(signal);
  return (code: string, name: string, args: Record<string, unknown>): Promise<Row[]> =>
    read<Row[]>(code, on(sb.rpc("match_bill_read", { p_read: name, p_args: args })), signal);
}

/** Pure. The matcher proposes; it never places. */
export function proposalOnly(result: MatchResult): Record<string, unknown> {
  if (result.result !== "auto") return result as unknown as Record<string, unknown>;
  return {
    result: "suggest",
    reason: "office_confirms",
    outcome: "job",
    job_id: result.job_id,
    from_clue_index: result.clue_indexes[0],
    would_place: true,
    clue_indexes: result.clue_indexes,
  };
}

const dayMinus = (day: string, days: number) =>
  new Date(Date.parse(day.slice(0, 10) + "T00:00:00Z") - days * 86_400_000).toISOString().slice(0, 10);

export function clueJson(c: Clue) {
  return {
    clue_code: c.clue_code,
    root: c.root,
    outcome: c.outcome,
    job_id: c.job_id ?? null,
    division: c.division ?? null,
    names_one: c.names_one,
    seen_where: c.seen_where ?? null,
    seen_value: c.seen_value ?? null,
    detail: c.detail ?? {},
  };
}

// deno-lint-ignore no-explicit-any
const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function matchOne(
  sb: Sb,
  subjectId: string,
  types: Record<string, ClueType>,
  accounts: PeopleAccounts,
  signal: AbortSignal,
): Promise<{ applied: string } | { skipped: string }> {
  const billRead = billReader(sb, signal);
  const kind = subjectId.split(":", 1)[0];
  const documentId = subjectId.slice(kind.length + 1);
  if (kind !== "xero_bill" || !documentId) return { skipped: "subject_not_a_bill" };

  const lines = await billRead("read_cost_lines", "cost_lines", { document_id: documentId });
  if (!lines?.length) return { skipped: "no_cost_lines" };
  // A person's labour, alone or beside supplier lines: no read of the bill, no
  // clue, no shadow row, no item.
  if (lines.some((l) => LABOUR_LINE_KINDS.has(String(l.kind ?? "")))) return { skipped: "labour_bill" };
  const hiddenOurs = hiddenSkip(accounts, lines.map((l) => l.account_code));
  if (hiddenOurs) return { skipped: hiddenOurs === "labour" ? "labour_bill" : "hidden_account_bill" };
  // A Trade App user's own bill is their pay (users is small; no index needed).
  const partyId = lines.find((l) => typeof l.party_id === "string" && l.party_id)?.party_id;
  if (partyId) {
    const people = await billRead("read_trade_user", "trade_user", { party_id: partyId });
    if (people?.length) return { skipped: "labour_bill" };
  }
  const counted = lines.filter((l) => l.state != null);
  if (!counted.length) return { skipped: "no_counted_lines" };
  // Proposals are for bills waiting for a person. A bill already on a job,
  // split or filed is left alone: no item is raised over it.
  if (!counted.some((l) => l.state === "needs_person")) return { skipped: "nothing_waiting" };

  const bill = (await billRead("read_bill", "bill", { document_id: documentId }))?.[0] ?? null;
  // Xero's own lines too (a zero line is not a cost line): still before any write.
  const hiddenXero = hiddenSkip(accounts, Array.isArray(bill?.line_items) ? bill.line_items.map((l: any) => l?.AccountCode) : []);
  if (hiddenXero) return { skipped: hiddenXero === "labour" ? "labour_bill" : "hidden_account_bill" };
  const first = lines[0];
  const money = counted.map((l) => num(l.amount_ex));
  const doc: MatchDocument = {
    subject_id: subjectId,
    document_kind: "xero_bill",
    document_id: documentId,
    party_id: (bill?.xero_contact_id as string) ?? (first.party_id as string) ?? null,
    party_name: (bill?.contact_name as string) ?? (first.party_name as string) ?? null,
    document_number: (bill?.invoice_number as string) ?? (first.document_number as string) ?? null,
    reference: (bill?.reference as string) ?? null,
    document_date: ((bill?.invoice_date as string) ?? (first.document_date as string) ?? null)?.slice(0, 10) ?? null,
    total_ex: money.every((m) => m != null) ? Math.round(money.reduce((s, m) => s + m! * 100, 0)) / 100 : null,
    lines: counted.map((l) => ({
      line_key: String(l.line_key),
      description: (l.description as string) ?? null,
      account_code: (l.account_code as string) ?? null,
      tracking_option: (l.xero_tracking_option as string) ?? null,
      amount_ex: num(l.amount_ex),
    })),
  };

  // Jobs named in the texts, by number and by shared digits (a twin stops the clue).
  const texts = [doc.document_number, doc.reference, ...doc.lines.map((l) => l.description)].join("\n");
  const digits = [...new Set(jobNumbersIn(texts).map((n) => n.replace(/\D/g, "")).filter(Boolean))].slice(0, 10);
  let jobs: MatchJob[] = [];
  if (digits.length) {
    const rows = await billRead("read_jobs", "jobs_by_number", { digits });
    jobs = (rows ?? []).filter((r) => typeof r.job_number === "string").map((r) => ({
      id: String(r.id),
      job_number: String(r.job_number),
      status: (r.status as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      site_address: (r.site_address as string) ?? null,
      site_suburb: (r.site_suburb as string) ?? null,
      holding: String(r.holding ?? "").toLowerCase() === "true",
    }));
  }

  // Orders from this supplier sent within 60 days before the bill.
  let orders: MatchOrder[] = [];
  let namedOrders: NamedOrder[] = [];
  if (doc.document_date && (doc.party_id || supplierNameKey(doc.party_name))) {
    const rows = await billRead("read_orders", "orders", {
      from: dayMinus(doc.document_date, ORDER_WINDOW_DAYS),
      to: doc.document_date,
      ...(doc.party_id ? { party_id: doc.party_id } : { party_name_key: supplierNameKey(doc.party_name) }),
    });
    orders = (rows ?? []).map((r) => ({
      order_kind: r.order_kind as MatchOrder["order_kind"],
      order_id: String(r.order_id),
      order_number: (r.order_number as string) ?? null,
      job_id: String(r.job_id ?? ""),
      job_live: r.job_live === true,
      party_id: (r.party_id as string) ?? null,
      party_name_key: (r.party_name_key as string) ?? null,
      sent_on: (r.sent_on as string) ?? null,
      cost_ex: num(r.cost_ex),
      from_sealed_scope: r.from_sealed_scope === true,
      matched: r.matched === true,
    }));
    namedOrders = orders.map((o) => ({
      order_kind: o.order_kind,
      order_id: o.order_id,
      order_number: o.order_number,
      job_id: o.job_id || null,
      party_id: o.party_id,
      status: null,
      matched: o.matched,
    }));
    // The order's job facts (live, holding) for the order-number clue.
    const orderJobIds = [...new Set(orders.map((o) => o.job_id).filter((id) => id && !jobs.some((j) => j.id === id)))].slice(0, 50);
    if (orderJobIds.length) {
      const rows = await billRead("read_order_jobs", "order_jobs", { job_ids: orderJobIds });
      for (const r of rows ?? []) {
        if (typeof r.job_number !== "string") continue;
        jobs.push({
          id: String(r.id),
          job_number: String(r.job_number),
          status: (r.status as string) ?? null,
          created_at: (r.created_at as string) ?? null,
          site_address: (r.site_address as string) ?? null,
          site_suburb: (r.site_suburb as string) ?? null,
          holding: String(r.holding ?? "").toLowerCase() === "true",
        });
      }
    }
  }

  const evidence = await billRead("read_bill_evidence", "evidence", { document_id: documentId }) as unknown as BillEvidenceRow[];

  // Other live documents of the same supplier with the same number.
  let others: OtherCostDocument[] = [];
  if (doc.document_number) {
    const rows = await billRead("read_other_documents", "other_documents", {
      document_number: doc.document_number,
      document_id: documentId,
      ...(doc.party_id ? { party_id: doc.party_id } : {}),
    });
    const byDoc = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows ?? []) byDoc.set(String(r.document_id), [...(byDoc.get(String(r.document_id)) ?? []), r]);
    others = [...byDoc.entries()].map(([id, rs]) => {
      const amounts = rs.filter((r) => r.state != null).map((r) => num(r.amount_ex));
      return {
        subject_id: `xero_bill:${id}`,
        document_kind: "xero_bill",
        document_id: id,
        party_id: (rs[0].party_id as string) ?? null,
        party_name: (rs[0].party_name as string) ?? null,
        document_number: (rs[0].document_number as string) ?? null,
        reference: null,
        document_date: (rs[0].document_date as string)?.slice(0, 10) ?? null,
        total_ex: amounts.length && amounts.every((a) => a != null)
          ? Math.round(amounts.reduce((s, a) => s + a! * 100, 0)) / 100
          : null,
        lines: [],
        status: (rs[0].document_status as string) ?? null,
        state_words: [...new Set(rs.map((r) => String(r.state ?? "not counted")))].join(", "),
      };
    });
  }

  // Clues another phase handed in (kept_from set), in id order: match_apply
  // appends them after this run's clues in the same order.
  const kept = await billRead("read_kept_clues", "kept_clues", { subject_id: subjectId });

  let rule: Record<string, unknown> | null = null;
  if (doc.party_id) {
    const rows = await billRead("read_rules", "rules", { party_id: doc.party_id });
    rule = rows?.length === 1 ? rows[0] : null;
  }

  const fresh: Clue[] = [
    jobNumberClue(doc, jobs),
    orderNumberClue(doc, namedOrders, jobs),
    sealedScopeOrderClue(doc, orders),
    orderAmountClue(doc, orders),
    supplierMailClue(evidence ?? []),
    deliveryAddressClue(doc, jobs),
    overheadAccountClue(doc),
    groupTagClue(doc),
    rule
      ? {
        clue_code: "learned_rule",
        class: "clue",
        family: "rule",
        root: `rule:${rule.id}`,
        outcome: rule.kind === "supplier_usually_overhead" ? "overhead" : "division_stock",
        ...(rule.division ? { division: String(rule.division) } : {}),
        names_one: true,
      } as Clue
      : null,
  ].filter((c): c is Clue => !!c && !!types[c.clue_code] && types[c.clue_code].mode !== "off");
  const keptClues: Clue[] = (kept ?? []).map((k) => ({
    clue_code: String(k.clue_code),
    class: k.class as Clue["class"],
    family: String(k.family),
    root: String(k.root),
    outcome: k.outcome as Clue["outcome"],
    ...(k.job_id ? { job_id: String(k.job_id) } : {}),
    ...(k.division ? { division: String(k.division) } : {}),
    names_one: k.names_one === true,
  }));
  const all = [...fresh, ...keptClues];

  const stops: Stop[] = [...documentStops(doc, jobs, accounts.labour)];
  const dup = duplicateStop(doc, others);
  if (dup) stops.push(dup);
  const candidate = all.find((c) => c.outcome === "job" && c.job_id && c.names_one && (c.class === "key" || c.class === "clue"));
  if (candidate?.job_id && doc.party_id) {
    const users = await billRead("read_trade_user", "trade_user", { party_id: doc.party_id }) as Array<
      { id: string; xero_contact_id: string | null }
    >;
    if (users?.length === 1) {
      const rows = await billRead("read_trade_lines", "trade_lines", { job_id: candidate.job_id, user_id: users[0].id });
      const same = samePersonStop(doc, { ...users[0], candidate_job_id: candidate.job_id },
        (rows ?? []).map((r) => ({
          user_id: users[0].id,
          job_id: String(r.job_id),
          line_date: ((r.work_date as string) ?? (r.created_at as string) ?? null)?.slice(0, 10) ?? null,
          total_ex: num(r.line_total_ex),
        })));
      if (same) stops.push(same);
    }
  }

  const result = proposalOnly(decideMatch(all, types, stops));
  // Never start the write once the bill's time is up (no write started: plain over time).
  if (signal.aborted) throw new ReadFailed(OVER_TIME);
  let applied: { data: unknown; error: unknown };
  try {
    applied = await sb.rpc("match_apply", {
      p_subject_kind: "cost_document",
      p_subject_id: subjectId,
      p_run_id: crypto.randomUUID(),
      p_item_kind: "bill",
      p_clues: fresh.map(clueJson),
      p_result: result,
      p_stops: stops,
      p_summary: {
        party: doc.party_name,
        number: doc.document_number,
        date: doc.document_date,
        amount_ex: doc.total_ex,
        lines: doc.lines.length,
      },
      p_rule_version: "v1",
    }).abortSignal(signal);
  } catch {
    throw new ReadFailed(signal.aborted ? APPLY_OVER_TIME : "apply_failed");
  }
  const { data, error } = applied;
  if (error) {
    if (signal.aborted) throw new ReadFailed(APPLY_OVER_TIME);
    // Ended by Postgres: the write rolled back, nothing committed.
    if (statementTimedOut(error)) throw new ReadFailed(OVER_TIME);
    const code = /\b(match_[a-z_]+|reconcile_[a-z_]+)\b/.exec(String((error as { message?: unknown }).message ?? ""))?.[1];
    throw new ReadFailed(code ? `apply:${code}` : "apply_failed");
  }
  return { applied: String((data as { applied?: unknown })?.applied ?? "unknown") };
}

/** Never throws: every failure is counted and the subject requeued. */
type Requeue = { id: string; reason: string };

/**
 * Every requeue of a run in one statement (an upsert on match_queue, one row
 * per subject, as match_requeue), with a client-side time limit.
 */
async function requeueAll(sb: Sb, rows: Requeue[], report: MatchRunReport): Promise<void> {
  const byId = new Map<string, string>();
  for (const r of rows) if (r.id.includes(":") && r.id.trim() && r.reason.trim()) byId.set(r.id, r.reason);
  if (!byId.size) return;
  try {
    const { error } = await sb.from("match_queue")
      .upsert([...byId].map(([subject_id, reason]) => ({ subject_kind: "cost_document", subject_id, reason })),
        { onConflict: "subject_kind,subject_id" })
      .abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));
    if (error) report.failed.requeue_failed = (report.failed.requeue_failed ?? 0) + byId.size;
    else report.requeued += byId.size;
  } catch {
    report.failed.requeue_failed = (report.failed.requeue_failed ?? 0) + byId.size;
  }
}

type SlowRow = { subject_id: string; cuts: number; reason: string; parked_at?: string | null };
/** What a run learned about slow bills: counts to write, parks, and counts to clear. */
type SlowPlan = { cut: Map<string, number>; clear: Set<string> };

/**
 * The slow-bill rows of these subjects (match_slow_bills primary key), in
 * chunks so a request stays short. Throws on a failed read.
 */
async function readSlowBills(sb: Sb, ids: string[]): Promise<Map<string, SlowRow>> {
  const out = new Map<string, SlowRow>();
  for (let i = 0; i < ids.length; i += MATCH_BACKLOG_CHUNK) {
    const rows = await timedRead<SlowRow[]>("read_slow_bills",
      sb.from("match_slow_bills").select("subject_id,cuts,reason,parked_at").eq("subject_kind", "cost_document")
        .in("subject_id", ids.slice(i, i + MATCH_BACKLOG_CHUNK)));
    for (const r of rows ?? []) out.set(r.subject_id, r);
  }
  return out;
}

/**
 * Writes the run's slow-bill counts and parks (one upsert) and clears (one
 * delete). A park that could not be written is requeued instead, so no bill is
 * lost; a failed write is counted, never thrown.
 */
async function settleSlowBills(sb: Sb, slow: SlowPlan, requeue: Requeue[], report: MatchRunReport, now: () => number): Promise<void> {
  if (slow.cut.size) {
    const at = new Date(now()).toISOString();
    const rows = [...slow.cut].map(([subject_id, cuts]) => ({
      subject_kind: "cost_document",
      subject_id,
      cuts,
      reason: cuts >= MATCH_SLOW_PARK_CUTS ? PARKED_SLOW_BILL : "slow_bill_cut",
      last_cut_at: at,
      parked_at: cuts >= MATCH_SLOW_PARK_CUTS ? at : null,
    }));
    const parks = rows.filter((r) => r.cuts >= MATCH_SLOW_PARK_CUTS).map((r) => r.subject_id);
    let written = false;
    try {
      const { error } = await sb.from("match_slow_bills").upsert(rows, { onConflict: "subject_kind,subject_id" })
        .abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));
      written = !error;
    } catch {
      written = false;
    }
    if (written) report.parked += parks.length;
    else {
      report.failed.slow_bill_write_failed = (report.failed.slow_bill_write_failed ?? 0) + rows.length;
      for (const id of parks) requeue.push({ id, reason: OVER_TIME });
    }
  }
  if (slow.clear.size) {
    try {
      const { error } = await sb.from("match_slow_bills").delete().eq("subject_kind", "cost_document")
        .in("subject_id", [...slow.clear]).abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));
      if (error) report.failed.slow_bill_clear_failed = (report.failed.slow_bill_clear_failed ?? 0) + slow.clear.size;
    } catch {
      report.failed.slow_bill_clear_failed = (report.failed.slow_bill_clear_failed ?? 0) + slow.clear.size;
    }
  }
}

/**
 * Runs the bills before the deadline; returns what must be requeued (never
 * writing it), the bills it reached, and what it learned about slow bills.
 * `fresh` are bills the sync reports changed: never passed over as parked, and
 * their slow-bill count is cleared.
 */
async function runCore(
  sb: Sb,
  ids: string[],
  deadline: number,
  now: () => number,
  report: MatchRunReport,
  opts: { budgetMs: number; fresh?: Set<string> },
): Promise<{ requeue: Requeue[]; reached: Set<string>; slow: SlowPlan }> {
  const out: Requeue[] = [];
  const reached = new Set<string>();
  const fresh = opts.fresh ?? new Set<string>();
  const slow: SlowPlan = { cut: new Map(), clear: new Set() };
  if (!ids.length && !fresh.size) return { requeue: out, reached, slow };
  if (!ids.length) {
    // Changed bills past the run cap: only their counts are cleared.
    for (const id of fresh) slow.clear.add(id);
    return { requeue: out, reached, slow };
  }
  let types: Record<string, ClueType>;
  try {
    const rows = await read<ClueType[]>("read_clue_types",
      sb.from("match_clue_types").select("code,class,family,mode").abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS)));
    types = Object.fromEntries((rows ?? []).map((t) => [t.code, t]));
    if (!Object.keys(types).length) throw new ReadFailed("read_clue_types");
  } catch {
    bump(report.failed, "read_clue_types");
    console.error("[match_run] clue types unreadable");
    // A changed bill's count is still cleared, so its retry is not passed over.
    for (const id of fresh) slow.clear.add(id);
    return { requeue: ids.map((id) => ({ id, reason: "read_failed" })), reached, slow };
  }
  // The people accounts (labour and hidden), once a run: unreadable or empty
  // runs nothing and writes nothing (every bill is requeued).
  let accounts: PeopleAccounts;
  try {
    accounts = await readPeopleAccounts(sb, { timeoutMs: MATCH_STATEMENT_TIMEOUT_MS });
  } catch (e) {
    const code = peopleAccountsCode(e) ?? "people_accounts_unreadable";
    bump(report.failed, code);
    console.error("[match_run]", code);
    // A changed bill's count is still cleared, so its retry is not passed over.
    for (const id of fresh) slow.clear.add(id);
    return { requeue: ids.map((id) => ({ id, reason: "read_failed" })), reached, slow };
  }
  // Which bills are parked or counted. A failed read is never "not parked":
  // only the changed bills run, the rest wait (requeued; a backlog bill stays
  // past the kept position).
  let slowRows: Map<string, SlowRow> | null = null;
  try {
    slowRows = await readSlowBills(sb, [...new Set([...ids, ...fresh])]);
  } catch {
    bump(report.failed, "read_slow_bills");
    for (const id of fresh) slow.clear.add(id);
  }
  if (slowRows) for (const id of fresh) if (slowRows.has(id)) slow.clear.add(id);
  for (const [i, id] of ids.entries()) {
    if (i >= MATCH_RUN_LIMIT) {
      out.push({ id, reason: "over_run_cap" });
      continue;
    }
    if (!slowRows && !fresh.has(id)) {
      out.push({ id, reason: "read_failed" });
      continue;
    }
    const known = fresh.has(id) ? undefined : slowRows?.get(id);
    if (known?.reason === PARKED_SLOW_BILL) {
      const parkedAt = Date.parse(String(known.parked_at ?? ""));
      // One more try once the park is 24 hours old (a spell of database strain
      // must not park a healthy bill for good); an unreadable time never retries.
      if (!(parkedAt <= now() - MATCH_PARKED_RETRY_MS)) {
        // Reached, so a backlog position moves past it; never requeued.
        bump(report.skipped, PARKED_SLOW_BILL);
        reached.add(id);
        continue;
      }
      report.parked_retried++;
    }
    const at = now();
    if (at > deadline) {
      out.push({ id, reason: OVER_TIME });
      continue;
    }
    report.run++;
    reached.add(id);
    try {
      // The bill gets the time left in the run, not a fresh budget.
      const res = await matchOne(sb, id, types, accounts, AbortSignal.timeout(Math.max(0, deadline - at)));
      if ("applied" in res) bump(report.applied, res.applied);
      else bump(report.skipped, res.skipped);
      if (known) slow.clear.add(id);
    } catch (e) {
      const code = e instanceof ReadFailed ? e.code : "threw";
      bump(report.failed, code);
      // A cut counts only when the bill started with most of the budget: a
      // bill that started late was cut by the bills before it.
      if ((code === OVER_TIME || code === APPLY_OVER_TIME) && deadline - at > opts.budgetMs * MATCH_SLOW_START_SHARE) {
        const cuts = Math.min(MATCH_SLOW_PARK_CUTS, (fresh.has(id) ? 0 : known?.cuts ?? 0) + 1);
        slow.cut.set(id, cuts);
        slow.clear.delete(id);
        if (cuts >= MATCH_SLOW_PARK_CUTS) continue; // parked when written; requeued if the write fails
      }
      // A data refusal from match_apply would refuse again: not requeued. An
      // unreadable switch is not a refusal and is retried.
      if (!code.startsWith("apply:match_") || code === "apply:match_switch_unreadable") {
        const reason = code === OVER_TIME || code === APPLY_OVER_TIME
          ? OVER_TIME
          : code.startsWith("apply") ? "apply_failed" : "read_failed";
        out.push({ id, reason });
      }
    }
  }
  return { requeue: out, reached, slow };
}

const emptyReport = (): MatchRunReport => ({ run: 0, applied: {}, requeued: 0, parked: 0, parked_retried: 0, skipped: {}, failed: {} });
const subjectsOf = (ids: unknown[]) =>
  [...new Set(ids.filter((s): s is string => typeof s === "string" && s.includes(":")))];

export async function runMatchFor(
  sb: Sb,
  subjectIds: string[],
  opts: { ruleVersion: "v1"; budgetMs?: number; reason?: string; now?: () => number },
): Promise<MatchRunReport> {
  const report = emptyReport();
  const ids = subjectsOf(subjectIds);
  if (!ids.length) return report;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? MATCH_RUN_BUDGET_MS;
  const { requeue, slow } = await runCore(sb, ids, now() + budgetMs, now, report, { budgetMs });
  await settleSlowBills(sb, slow, requeue, report, now);
  await requeueAll(sb, requeue, report);
  if (Object.keys(report.failed).length) console.error("[match_run] failures", JSON.stringify(report.failed));
  return report;
}

/**
 * Read once at the start of a sync. Unreadable is off, with a code: the sync
 * then makes no matcher read or write.
 */
export async function readMatcherSwitch(sb: Sb): Promise<{ on: boolean; error?: string }> {
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", "reconcile_matcher_v1").maybeSingle();
    if (error) return { on: false, error: "matcher_switch_unreadable" };
    return { on: data?.enabled === true };
  } catch {
    return { on: false, error: "matcher_switch_unreadable" };
  }
}

type BacklogLine = { document_id: string; created_at: string };

async function timedRead<T>(code: string, q: { abortSignal: (s: AbortSignal) => PromiseLike<{ data: T; error: unknown }> }) {
  return await read<T>(code, q.abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS)));
}

type BacklogPick = { subject: string; created_at: string; document_id: string };
type BacklogPlan = {
  picks: BacklogPick[];
  /** Where the position goes when every pick is run: past the last bill looked at, or null at the end. */
  after: { created_at: string; document_id: string } | null;
  /** The position was set before this run. */
  hadPosition: boolean;
  error?: string;
};

/**
 * Up to `room` waiting bills (documents) with no open item and no labour line,
 * oldest first by (line created_at, document id), from the position kept in
 * xero_sync_state. Reads only; the caller moves the position after the run, to
 * the last bill it reached. Bills in `exclude` (run already this sync) are
 * passed over. A failed read takes nothing and leaves the position alone.
 */
async function backlogPlan(sb: Sb, room: number, exclude: Set<string>): Promise<BacklogPlan> {
  const none: BacklogPlan = { picks: [], after: null, hadPosition: false };
  if (room <= 0) return none;
  try {
    const state = await read<{ cursor_at: string | null; note: string | null } | null>("backlog_state",
      sb.from("xero_sync_state").select("cursor_at,note").eq("key", MATCH_BACKLOG_STATE_KEY)
        .abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS)).maybeSingle());
    const at = state?.cursor_at ?? null;
    const after = at ? state?.note ?? "" : "";
    const base = () => sb.from("job_cost_lines").select("document_id,created_at")
      .eq("document_kind", "xero_bill").eq("state", "needs_person");
    let lines: BacklogLine[] = [];
    let full = false;
    if (at) {
      // Lines written in one statement share one created_at: the document id
      // breaks the tie.
      const same = await timedRead<BacklogLine[]>("backlog_lines",
        base().eq("created_at", at).gt("document_id", after).order("document_id", { ascending: true })
          .limit(MATCH_BACKLOG_LINE_PAGE));
      lines = same ?? [];
      full = lines.length >= MATCH_BACKLOG_LINE_PAGE;
    }
    if (!full) {
      let q = base();
      if (at) q = q.gt("created_at", at);
      const later = await timedRead<BacklogLine[]>("backlog_lines",
        q.order("created_at", { ascending: true }).order("document_id", { ascending: true })
          .limit(MATCH_BACKLOG_LINE_PAGE));
      lines = [...lines, ...(later ?? [])];
      full = (later ?? []).length >= MATCH_BACKLOG_LINE_PAGE;
    }
    // Each bill once, at its first line's position.
    const docs: BacklogLine[] = [];
    const seen = new Set<string>();
    let capped = false;
    for (const l of lines) {
      if (typeof l?.document_id !== "string" || !l.document_id || typeof l.created_at !== "string") continue;
      if (seen.has(l.document_id)) continue;
      if (docs.length >= MATCH_BACKLOG_DOCS) {
        capped = true;
        break;
      }
      seen.add(l.document_id);
      docs.push(l);
    }
    if (!docs.length) return { picks: [], after: null, hadPosition: !!at };
    const ids = docs.map((d) => d.document_id);
    const openSet = new Set<string>();
    const labourSet = new Set<string>();
    // reconcile_items_open_subject_idx; job_cost_lines_document_idx. In chunks,
    // so a request URL stays short.
    for (let i = 0; i < ids.length; i += MATCH_BACKLOG_CHUNK) {
      const chunk = ids.slice(i, i + MATCH_BACKLOG_CHUNK);
      const [open, labour] = await Promise.all([
        timedRead<Array<{ subject_id: string }>>("backlog_items",
          sb.from("reconcile_items").select("subject_id").eq("subject_table", "cost_document").eq("status", "open")
            .in("subject_id", chunk.map((d) => `xero_bill:${d}`))),
        timedRead<Array<{ document_id: string }>>("backlog_labour",
          sb.from("job_cost_lines").select("document_id").eq("document_kind", "xero_bill")
            .in("kind", [...LABOUR_LINE_KINDS]).in("document_id", chunk)),
      ]);
      for (const r of open ?? []) openSet.add(r.subject_id);
      for (const r of labour ?? []) labourSet.add(r.document_id);
    }
    const picks: BacklogPick[] = [];
    let last = docs[docs.length - 1];
    let stopped = false;
    for (const d of docs) {
      if (picks.length >= room) {
        stopped = true;
        break;
      }
      last = d;
      const subject = `xero_bill:${d.document_id}`;
      if (openSet.has(subject) || labourSet.has(d.document_id) || exclude.has(subject)) continue;
      picks.push({ subject, created_at: d.created_at, document_id: d.document_id });
    }
    const reachedEnd = !full && !capped && !stopped;
    return {
      picks,
      after: reachedEnd ? null : { created_at: last.created_at, document_id: last.document_id },
      hadPosition: !!at,
    };
  } catch (e) {
    return { ...none, error: e instanceof ReadFailed ? e.code : "backlog_failed" };
  }
}

async function writeBacklogPosition(sb: Sb, at: string | null, documentId: string | null): Promise<void> {
  // An abort or network fault throws; the caller counts it.
  const { error } = await sb.from("xero_sync_state").upsert(
    { key: MATCH_BACKLOG_STATE_KEY, cursor_at: at, note: documentId, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  ).abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));
  if (error) throw new ReadFailed("backlog_position_write");
}

export type SyncMatchReport = MatchRunReport & {
  switch: "on" | "off";
  changed: number;
  queued: number;
  backlog: number;
  errors: string[];
};

/**
 * The sync's matcher step, called once after the Xero paging. With the switch
 * off it returns at once and touches nothing. On: one budget from now, at most
 * MATCH_RUN_LIMIT bills (changed, then queued, then up to MATCH_BACKLOG_LIMIT
 * waiting with no open item), and one batched requeue of what did not fit.
 */
export async function syncMatchRun(
  sb: Sb,
  opts: { on: boolean; changed: string[]; now?: () => number; budgetMs?: number; deadline?: number },
): Promise<SyncMatchReport> {
  const report: SyncMatchReport = { ...emptyReport(), switch: opts.on ? "on" : "off", changed: 0, queued: 0, backlog: 0, errors: [] };
  if (!opts.on) return report;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? MATCH_RUN_BUDGET_MS;
  // A caller sharing one budget with a later step (syncMatchStep) passes its deadline.
  const deadline = opts.deadline ?? now() + budgetMs;
  const changed = subjectsOf(opts.changed).filter((s) => s.startsWith("xero_bill:"));
  const run = changed.slice(0, MATCH_RUN_LIMIT);
  const requeue: Requeue[] = changed.slice(MATCH_RUN_LIMIT).map((id) => ({ id, reason: "over_run_cap" }));
  report.changed = run.length;

  // Bills waiting in match_queue, oldest queued first, taken off before the run.
  let room = MATCH_RUN_LIMIT - run.length;
  if (room > 0) {
    try {
      const queued = await timedRead<Array<{ subject_id: string }>>("queue_read",
        sb.from("match_queue").select("subject_id").eq("subject_kind", "cost_document").like("subject_id", "xero_bill:%")
          .order("queued_at", { ascending: true }).limit(room));
      const taken = (queued ?? []).map((r) => r.subject_id);
      if (taken.length) {
        // Every id read comes off; one the sync also changed runs once.
        const del = await sb.from("match_queue").delete().eq("subject_kind", "cost_document").in("subject_id", taken)
          .abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));
        if (del.error) report.errors.push("queue_delete_failed");
        else {
          const fresh = taken.filter((id) => !run.includes(id));
          run.push(...fresh);
          report.queued = fresh.length;
        }
      }
    } catch (e) {
      report.errors.push(e instanceof ReadFailed ? e.code : "queue_read");
    }
  }

  room = Math.min(MATCH_BACKLOG_LIMIT, MATCH_RUN_LIMIT - run.length);
  let plan: BacklogPlan | null = null;
  if (room > 0 && now() <= deadline) {
    plan = await backlogPlan(sb, room, new Set([...run, ...requeue.map((r) => r.id)]));
    if (plan.error) report.errors.push(plan.error);
    run.push(...plan.picks.map((p) => p.subject));
  }

  const { requeue: failed, reached, slow } = await runCore(sb, run, deadline, now, report, { budgetMs, fresh: new Set(changed) });
  // A backlog bill the budget did not reach is not requeued: the position
  // stops before it, so the next run starts there.
  const backlogSubjects = new Set((plan?.picks ?? []).map((p) => p.subject));
  requeue.push(...failed.filter((r) => !(backlogSubjects.has(r.id) && !reached.has(r.id))));
  if (plan && !plan.error) {
    const ran = plan.picks.filter((p) => reached.has(p.subject));
    report.backlog = ran.length;
    let position: { created_at: string; document_id: string } | null | undefined;
    if (ran.length === plan.picks.length) position = plan.after;
    else if (ran.length) position = ran[ran.length - 1];
    else position = undefined; // none reached: leave the position where it is
    if (position !== undefined && (position !== null || plan.hadPosition)) {
      try {
        await writeBacklogPosition(sb, position?.created_at ?? null, position?.document_id ?? null);
      } catch {
        report.errors.push("backlog_position_write");
      }
    }
  }
  await settleSlowBills(sb, slow, requeue, report, now);
  await requeueAll(sb, requeue, report);
  if (Object.keys(report.failed).length || report.errors.length) {
    console.error("[match_run] sync step", JSON.stringify({ failed: report.failed, errors: report.errors }));
  }
  return report;
}

/**
 * A manual door (match_pending, match_sweep): only the exact server key, POST
 * only. Every call writes clue and shadow rows, even with the switch off.
 */
function serviceKeyRefusal(req: Request, serviceKey: string): { status: number; body: Record<string, unknown> } | null {
  if (!serviceKey || req.headers.get("authorization") !== `Bearer ${serviceKey}`) {
    return { status: 403, body: { error: "service_key_required" } };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "post_required" } };
  return null;
}

/** The match_pending door. */
export async function matchPendingRequest(
  req: Request,
  sb: Sb,
  serviceKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return serviceKeyRefusal(req, serviceKey) ?? { status: 200, body: await matchPending(sb) };
}

/** The match_pending action: one read when nothing waits. */
export async function matchPending(sb: Sb): Promise<Record<string, unknown>> {
  // match_queue_pkey. Bills only: a queued credit, receipt or message waits
  // for its own runner and is never deleted here.
  const { data, error } = await sb.from("match_queue").select("subject_kind,subject_id")
    .eq("subject_kind", "cost_document").like("subject_id", "xero_bill:%")
    .order("queued_at", { ascending: true }).limit(MATCH_RUN_LIMIT);
  if (error) return { matched: 0, error: "queue_unreadable" };
  const rows = (data ?? []) as Array<{ subject_kind: string; subject_id: string }>;
  if (!rows.length) return { matched: 0 };
  const ids = rows.map((r) => r.subject_id);
  const del = await sb.from("match_queue").delete().eq("subject_kind", "cost_document").in("subject_id", ids);
  if (del.error) return { matched: 0, error: "queue_delete_failed" };
  const report = await runMatchFor(sb, ids, { ruleVersion: "v1" });
  return { matched: report.run, ...report };
}

/** Lines read per sweep page. The page is cut to MATCH_RUN_LIMIT bills. */
export const MATCH_SWEEP_LINE_PAGE = 500;

/**
 * The match_sweep action: a bounded pass over bills that wait for a person and
 * have no open Reconcile item, so a bill the sync wrote before the matcher ran
 * (or the backfill twin wrote) still gets a proposal.
 *
 * Bills only, like the runner: a waiting credit note is not swept (no raiser
 * for credits yet; see the PR). By document id, descending (a Xero id, not a
 * date), at most MATCH_RUN_LIMIT bills a call. The caller holds the cursor: pass `after` = the `next` of the
 * last call until `done`. Nothing is stored between calls, so with
 * reconcile_matcher_v1 off (no item raised) a second pass from the top runs
 * the same bills again; each run re-marks the bill's clues and adds one shadow
 * row (match_apply).
 *
 * A failed read of the waiting lines or of the open items runs nothing and
 * returns the cursor it was given: an unread item is never "no item". A bill
 * the runner requeues (time, a failed read) is past the cursor: it waits in
 * match_queue for match_pending.
 */
export async function matchSweep(
  sb: Sb,
  opts: { after?: string | null; now?: () => number; budgetMs?: number } = {},
): Promise<Record<string, unknown>> {
  const after = opts.after ?? null;
  // job_cost_lines_document_idx (document_kind, document_id), read backwards.
  let q = sb.from("job_cost_lines").select("document_id")
    .eq("document_kind", "xero_bill").eq("state", "needs_person");
  if (after) q = q.lt("document_id", after);
  let lines: { data: unknown; error: unknown } | null = null;
  try {
    lines = await q.order("document_id", { ascending: false }).limit(MATCH_SWEEP_LINE_PAGE);
  } catch {
    lines = null;
  }
  if (lines?.error || !Array.isArray(lines?.data)) {
    console.error("[match_sweep] waiting lines unreadable");
    return { swept: 0, error: "lines_unreadable", next: after, done: false };
  }
  const rows = lines.data as Array<{ document_id: string }>;
  const docs = [...new Set(rows.map((r) => r.document_id).filter((d) => typeof d === "string" && d))];
  const taken = docs.slice(0, MATCH_RUN_LIMIT);
  const done = rows.length < MATCH_SWEEP_LINE_PAGE && docs.length <= MATCH_RUN_LIMIT;
  const next = done ? null : taken[taken.length - 1] ?? after;
  if (!taken.length) return { swept: 0, with_open_item: 0, next, done };

  const subjects = taken.map((d) => `xero_bill:${d}`);
  // reconcile_items_open_subject_idx. Any open item on the bill, of any kind.
  let items: { data: unknown; error: unknown } | null = null;
  try {
    items = await sb.from("reconcile_items").select("subject_id")
      .eq("subject_table", "cost_document").eq("status", "open").in("subject_id", subjects);
  } catch {
    items = null;
  }
  if (items?.error || !Array.isArray(items?.data)) {
    console.error("[match_sweep] open items unreadable");
    return { swept: 0, error: "items_unreadable", next: after, done: false };
  }
  const open = new Set((items.data as Array<{ subject_id: string }>).map((r) => r.subject_id));
  const toRun = subjects.filter((s) => !open.has(s));
  const report = await runMatchFor(sb, toRun, { ruleVersion: "v1", now: opts.now, budgetMs: opts.budgetMs });
  return { swept: subjects.length, with_open_item: subjects.length - toRun.length, ...report, next, done };
}

/**
 * The match_sweep door. Every call writes clue and shadow rows, even with the
 * matcher switch off, so only the exact server key may call it (as
 * cost_lines_backfill_documents): a signed-in user's JWT, the anon key or the
 * ops key is refused 403 before anything is read.
 */
export async function matchSweepRequest(
  req: Request,
  sb: Sb,
  serviceKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const refused = serviceKeyRefusal(req, serviceKey);
  if (refused) return refused;
  const after = new URL(req.url).searchParams.get("after");
  if (after != null && (after.length === 0 || after.length > 200)) {
    return { status: 400, body: { error: "invalid_after" } };
  }
  return { status: 200, body: await matchSweep(sb, { after }) };
}
