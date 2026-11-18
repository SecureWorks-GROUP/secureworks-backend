// Follow-up 66, director rulings 00:45 and 02:21: a small raiser for supplier
// credit notes that no bill carries.
//
// A credit that follows a bill never gets its own item: it rides its bill and
// job_cost_lines_refollow moves it when the bill is decided. A credit with
// money left unallocated in Xero has a line `unallocated`, reason
// credit_not_allocated (job_cost_lines_sync_credit_notes), and nothing raises
// an item for it, so the Reconcile list cannot show it. This proposes for
// those only.
//
// Only a credit note whose every counted line is `unallocated`: a credit with
// any allocation line follows a bill and is left alone (`has_allocations`),
// because match_apply would set its reason on the following lines too.
//
// PROPOSALS ONLY. The one clue is a job number in the credit's number,
// reference or Xero line words; the result passes proposalOnly, so it is never
// `auto`. Through match_apply with item kind `credit`. The line keeps its
// reason; the suggestion and any stop ride the item.
//
// A credit of a person's labour is skipped (`labour_credit`), with no clue,
// shadow row or item, as the bill runner skips a labour bill: a credit from a
// Xero contact that is a Trade App user (director 01:03), or one with a line
// on an installer account, 301 or 306 (director 02:21). A credit with a line on
// an account hidden from Reconcile that is not labour (475, director 03:36) is
// skipped the same way, counted `hidden_account_credit`. Both sets are
// people_account_codes (_shared/people_accounts.ts).
//
// Where it runs, both behind reconcile_matcher_v1 (director 02:21):
// - The sync: syncMatchStep runs the bill step, then credits in what is left of
//   the same 50 documents and the same 20 s. With the switch off, nothing.
//   Credits keep their own position (xero_sync_state match_credit_backlog), by
//   document id, wrapping at the end; a credit the budget does not reach is
//   where the next run starts.
// - The credit_sweep door (server key, POST): reads the switch first. Off,
//   unreadable or missing, it writes nothing and reads nothing else.
//
// A failed read is never "no clue" and never "no item": the credit is
// skipped and counted, or the run takes nothing and keeps its position or
// cursor. Logs carry codes and counts only.

import { jobNumbersIn } from "../bill_prematch.ts";
import {
  hiddenSkip,
  labourAccounts,
  type PeopleAccounts,
  peopleAccountsCode,
  readPeopleAccounts,
  reconcileHiddenAccounts,
} from "../../_shared/people_accounts.ts";
import { decideMatch } from "./decide.ts";
import { documentStops, jobNumberClue, type MatchDocument, type MatchJob } from "./doc_clues.ts";
import {
  clueJson,
  MATCH_RUN_BUDGET_MS,
  MATCH_RUN_LIMIT,
  MATCH_STATEMENT_TIMEOUT_MS,
  proposalOnly,
  readMatcherSwitch,
  type SyncMatchReport,
  syncMatchRun,
} from "./match_run.ts";
import type { Clue, ClueType } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

export const CREDIT_REASON = "credit_not_allocated";
/** xero_sync_state key holding the sync's credit position (note = the last credit document id reached). */
export const CREDIT_BACKLOG_STATE_KEY = "match_credit_backlog";
/** Credits looked at per sync run (open-item reads in chunks of CREDIT_CHUNK). */
export const CREDIT_BACKLOG_DOCS = 100;
const CREDIT_CHUNK = 50;

class ReadFailed extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function read<T>(code: string, q: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  let res: { data: T; error: unknown };
  try {
    res = await q;
  } catch {
    throw new ReadFailed(code);
  }
  if (res.error) throw new ReadFailed(code);
  return res.data;
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const timed = <T>(q: { abortSignal: (s: AbortSignal) => PromiseLike<T> }) =>
  q.abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS));

export interface CreditRunReport {
  run: number;
  applied: Record<string, number>;
  skipped: Record<string, number>;
  failed: Record<string, number>;
}
const emptyCreditReport = (): CreditRunReport => ({ run: 0, applied: {}, skipped: {}, failed: {} });

async function creditOne(
  sb: Sb,
  creditId: string,
  { types, accounts }: RunInputs,
): Promise<{ applied: string } | { skipped: string }> {
  const subjectId = `xero_credit_note:${creditId}`;
  // job_cost_lines_document_idx
  const lines = await read<Array<Record<string, unknown>>>("read_credit_lines",
    sb.from("job_cost_lines").select("org_id,line_key,amount_ex,state,needs_reason,account_code,document_number,document_date,party_id,party_name")
      .eq("document_kind", "xero_credit_note").eq("document_id", creditId));
  const counted = (lines ?? []).filter((l) => l.state != null);
  if (!counted.length) return { skipped: "no_counted_lines" };
  if (counted.some((l) => l.line_key !== "unallocated")) return { skipped: "has_allocations" };
  const waiting = counted.find((l) => l.state === "needs_person" && l.needs_reason === CREDIT_REASON);
  if (!waiting) return { skipped: "nothing_waiting" };

  // xero_supplier_credit_notes primary key (org_id, xero_credit_note_id).
  const note = await read<Record<string, unknown> | null>("read_credit_note",
    sb.from("xero_supplier_credit_notes")
      .select("credit_note_number,reference,xero_contact_id,contact_name,credit_note_date,line_items:raw_json->LineItems")
      .eq("org_id", waiting.org_id).eq("xero_credit_note_id", creditId).maybeSingle());
  if (!note) return { skipped: "credit_note_missing" };
  const xeroLines = (Array.isArray(note.line_items) ? note.line_items : []) as Array<Record<string, unknown>>;
  // A hidden account (301, 306, 475) on any line, ours or Xero's: never proposed.
  const hidden = hiddenSkip(accounts, [...(lines ?? []).map((l) => l.account_code), ...xeroLines.map((l) => l?.AccountCode)]);
  if (hidden) return { skipped: hidden === "labour" ? "labour_credit" : "hidden_account_credit" };
  const partyId = (note.xero_contact_id as string) ?? (waiting.party_id as string) ?? null;
  if (partyId) {
    const people = await read<Array<{ id: string }>>("read_trade_user",
      sb.from("users").select("id").eq("xero_contact_id", partyId).limit(1));
    if (people?.length) return { skipped: "labour_credit" };
  }
  const words = xeroLines
    .map((l) => (typeof l?.Description === "string" ? l.Description : ""))
    .filter(Boolean).join("\n");
  const doc: MatchDocument = {
    subject_id: subjectId,
    document_kind: "xero_credit_note",
    document_id: creditId,
    party_id: partyId,
    party_name: (note.contact_name as string) ?? (waiting.party_name as string) ?? null,
    document_number: (note.credit_note_number as string) ?? (waiting.document_number as string) ?? null,
    reference: (note.reference as string) ?? null,
    document_date: ((note.credit_note_date as string) ?? (waiting.document_date as string) ?? null)?.slice(0, 10) ?? null,
    total_ex: num(waiting.amount_ex),
    lines: [{
      line_key: "unallocated",
      description: words || null,
      account_code: null,
      tracking_option: null,
      amount_ex: num(waiting.amount_ex),
    }],
  };

  const texts = [doc.document_number, doc.reference, words].join("\n");
  const digits = [...new Set(jobNumbersIn(texts).map((n) => n.replace(/\D/g, "")).filter(Boolean))].slice(0, 10);
  let jobs: MatchJob[] = [];
  if (digits.length) {
    const rows = await read<Array<Record<string, unknown>>>("read_jobs",
      sb.from("jobs").select("id,job_number,status,created_at,site_address,site_suburb,holding:metadata->>do_not_schedule")
        .or(digits.map((d) => `job_number.ilike.%${d}`).join(",")).limit(50));
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

  const fresh = [jobNumberClue(doc, jobs)]
    .filter((c): c is Clue => !!c && !!types[c.clue_code] && types[c.clue_code].mode !== "off");
  const stops = documentStops(doc, jobs, accounts.labour);
  // The line keeps its reason: with the switch on, match_apply writes the
  // result's reason onto waiting lines, and "money left on the credit" is why
  // a person is needed. The suggestion and any stop travel on the item.
  const result = { ...proposalOnly(decideMatch(fresh, types, stops)), reason: CREDIT_REASON };
  const { data, error } = await sb.rpc("match_apply", {
    p_subject_kind: "cost_document",
    p_subject_id: subjectId,
    p_run_id: crypto.randomUUID(),
    p_item_kind: "credit",
    p_clues: fresh.map(clueJson),
    p_result: result,
    p_stops: stops,
    p_summary: {
      party: doc.party_name,
      number: doc.document_number,
      date: doc.document_date,
      amount_ex: doc.total_ex,
      lines: 1,
    },
    p_rule_version: "v1",
  });
  if (error) {
    const code = /\b(match_[a-z_]+|reconcile_[a-z_]+)\b/.exec(String((error as { message?: unknown }).message ?? ""))?.[1];
    throw new ReadFailed(code ? `apply:${code}` : "apply_failed");
  }
  return { applied: String((data as { applied?: unknown })?.applied ?? "unknown") };
}

type RunInputs = { types: Record<string, ClueType>; accounts: PeopleAccounts };

/** The clue types and the people accounts, once a run; either unreadable throws its code. */
async function readInputs(sb: Sb): Promise<RunInputs> {
  const rows = await read<ClueType[]>("read_clue_types", sb.from("match_clue_types").select("code,class,family,mode"));
  const types = Object.fromEntries((rows ?? []).map((t) => [t.code, t]));
  if (!Object.keys(types).length) throw new ReadFailed("read_clue_types");
  try {
    return { types, accounts: await readPeopleAccounts(sb, { timeoutMs: MATCH_STATEMENT_TIMEOUT_MS }) };
  } catch (e) {
    throw new ReadFailed(peopleAccountsCode(e) ?? "people_accounts_unreadable");
  }
}

/** Runs the credits in order until the deadline; returns the ones it reached. */
async function runCredits(
  sb: Sb,
  ids: string[],
  inputs: RunInputs,
  deadline: number,
  now: () => number,
  report: CreditRunReport,
): Promise<Set<string>> {
  const reached = new Set<string>();
  for (const id of ids) {
    if (now() > deadline) break;
    report.run++;
    reached.add(id);
    try {
      const out = await creditOne(sb, id, inputs);
      if ("applied" in out) bump(report.applied, out.applied);
      else bump(report.skipped, out.skipped);
    } catch (e) {
      bump(report.failed, e instanceof ReadFailed ? e.code : "threw");
    }
  }
  return reached;
}

/** Credits of `ids` with an open Reconcile item of any kind, in chunks (reconcile_items_open_subject_idx). */
async function openCredits(sb: Sb, ids: string[]): Promise<Set<string>> {
  const open = new Set<string>();
  for (let i = 0; i < ids.length; i += CREDIT_CHUNK) {
    const chunk = ids.slice(i, i + CREDIT_CHUNK).map((d) => `xero_credit_note:${d}`);
    const rows = await read<Array<{ subject_id: string }>>("credit_items",
      timed(sb.from("reconcile_items").select("subject_id").eq("subject_table", "cost_document").eq("status", "open")
        .in("subject_id", chunk)));
    for (const r of rows ?? []) open.add(r.subject_id);
  }
  return open;
}

/** The waiting selector: unallocated credit lines waiting for a person with reason credit_not_allocated. */
const waitingCredits = (sb: Sb) =>
  sb.from("job_cost_lines").select("document_id")
    .eq("document_kind", "xero_credit_note").eq("line_key", "unallocated")
    .eq("state", "needs_person").eq("needs_reason", CREDIT_REASON);

export type SyncCreditReport = CreditRunReport & { switch: "on" | "off"; taken: number; errors: string[] };
export type SyncMatchStepReport = SyncMatchReport & { credits: SyncCreditReport };

/**
 * The sync's credit step: at most `room` waiting credits with no open item,
 * from the kept position by document id, run until `deadline`. The position
 * moves to the last credit reached, or back to the start when every credit to
 * the end was run. A failed read takes nothing and keeps the position.
 */
export async function syncCreditRun(
  sb: Sb,
  opts: { on: boolean; room: number; deadline: number; now?: () => number },
): Promise<SyncCreditReport> {
  const report: SyncCreditReport = { ...emptyCreditReport(), switch: opts.on ? "on" : "off", taken: 0, errors: [] };
  const now = opts.now ?? Date.now;
  if (!opts.on || opts.room <= 0 || now() > opts.deadline) return report;
  let picks: string[];
  let after: string | null;
  let hadPosition: boolean;
  let inputs: RunInputs;
  try {
    const state = await read<{ note: string | null } | null>("credit_state",
      sb.from("xero_sync_state").select("note").eq("key", CREDIT_BACKLOG_STATE_KEY)
        .abortSignal(AbortSignal.timeout(MATCH_STATEMENT_TIMEOUT_MS)).maybeSingle());
    const position = state?.note ?? null;
    hadPosition = position != null;
    let q = waitingCredits(sb);
    if (position != null) q = q.gt("document_id", position);
    const rows = await read<Array<{ document_id: string }>>("credit_lines",
      timed(q.order("document_id", { ascending: true }).limit(CREDIT_BACKLOG_DOCS)));
    const docs = [...new Set((rows ?? []).map((r) => r.document_id).filter((d) => typeof d === "string" && d))];
    const open = await openCredits(sb, docs);
    picks = [];
    let last: string | null = null;
    let stopped = false;
    for (const d of docs) {
      if (picks.length >= opts.room) {
        stopped = true;
        break;
      }
      last = d;
      if (!open.has(`xero_credit_note:${d}`)) picks.push(d);
    }
    const reachedEnd = (rows ?? []).length < CREDIT_BACKLOG_DOCS && !stopped;
    after = reachedEnd ? null : last;
    if (!picks.length && !hadPosition && after === null) return report;
    inputs = picks.length ? await readInputs(sb) : { types: {}, accounts: { labour: labourAccounts([]), hidden: reconcileHiddenAccounts([]) } };
  } catch (e) {
    report.errors.push(e instanceof ReadFailed ? e.code : "credit_plan_failed");
    console.error("[credit_run] sync step", JSON.stringify({ errors: report.errors }));
    return report;
  }
  report.taken = picks.length;
  const reached = await runCredits(sb, picks, inputs, opts.deadline, now, report);
  const ran = picks.filter((d) => reached.has(d));
  let position: string | null | undefined;
  if (ran.length === picks.length) position = after;
  else if (ran.length) position = ran[ran.length - 1];
  else position = undefined; // none reached: leave the position where it is
  if (position !== undefined && (position !== null || hadPosition)) {
    try {
      const { error } = await timed<{ error: unknown }>(sb.from("xero_sync_state").upsert(
        { key: CREDIT_BACKLOG_STATE_KEY, cursor_at: null, note: position, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      ));
      if (error) report.errors.push("credit_position_write");
    } catch {
      report.errors.push("credit_position_write");
    }
  }
  if (Object.keys(report.failed).length || report.errors.length) {
    console.error("[credit_run] sync step", JSON.stringify({ failed: report.failed, errors: report.errors }));
  }
  return report;
}

/**
 * The sync's one matcher step (director 02:21): bills first (syncMatchRun),
 * then credits in what is left of the same MATCH_RUN_LIMIT documents and the
 * same budget. With the switch off it touches nothing.
 */
export async function syncMatchStep(
  sb: Sb,
  opts: { on: boolean; changed: string[]; now?: () => number; budgetMs?: number },
): Promise<SyncMatchStepReport> {
  const now = opts.now ?? Date.now;
  const deadline = opts.on ? now() + (opts.budgetMs ?? MATCH_RUN_BUDGET_MS) : 0;
  const bills = await syncMatchRun(sb, { on: opts.on, changed: opts.changed, now, deadline, budgetMs: opts.budgetMs });
  const credits = await syncCreditRun(sb, { on: opts.on, room: MATCH_RUN_LIMIT - bills.run, deadline, now });
  return { ...bills, credits };
}

/**
 * The credit_sweep action: unallocated credits waiting for a person with no
 * open Reconcile item, at most MATCH_RUN_LIMIT a call, by document id
 * descending. The caller holds the cursor: pass `after` = `next` until `done`.
 * Nothing is requeued: a failed credit is counted and the next pass from the
 * top retries it. With reconcile_matcher_v1 off, missing or unreadable it
 * reads nothing else and writes nothing.
 */
export async function creditSweep(
  sb: Sb,
  opts: { after?: string | null; now?: () => number; budgetMs?: number } = {},
): Promise<Record<string, unknown>> {
  const after = opts.after ?? null;
  const matcher = await readMatcherSwitch(sb);
  if (matcher.error) return { swept: 0, switch: "off", error: matcher.error, next: after, done: false };
  // An error code, so a caller following `next` until `done` stops here.
  if (!matcher.on) return { swept: 0, switch: "off", error: "matcher_switch_off", next: after, done: false };
  let q = waitingCredits(sb);
  if (after) q = q.lt("document_id", after);
  let lines: { data: unknown; error: unknown } | null = null;
  try {
    lines = await q.order("document_id", { ascending: false }).limit(MATCH_RUN_LIMIT + 1);
  } catch {
    lines = null;
  }
  if (lines?.error || !Array.isArray(lines?.data)) {
    console.error("[credit_sweep] waiting lines unreadable");
    return { swept: 0, error: "lines_unreadable", next: after, done: false };
  }
  // One `unallocated` line per credit note, so lines are credits.
  const ids = [...new Set((lines.data as Array<{ document_id: string }>).map((r) => r.document_id).filter(Boolean))];
  const taken = ids.slice(0, MATCH_RUN_LIMIT);
  const done = ids.length <= MATCH_RUN_LIMIT;
  const next = done ? null : taken[taken.length - 1];
  if (!taken.length) return { swept: 0, with_open_item: 0, next, done };

  let open: Set<string>;
  try {
    open = await openCredits(sb, taken);
  } catch {
    console.error("[credit_sweep] open items unreadable");
    return { swept: 0, error: "items_unreadable", next: after, done: false };
  }
  const toRun = taken.filter((d) => !open.has(`xero_credit_note:${d}`));

  const report = { ...emptyCreditReport(), left_for_next_pass: 0 };
  let inputs: RunInputs;
  try {
    inputs = await readInputs(sb);
  } catch (e) {
    const code = e instanceof ReadFailed && e.code !== "read_clue_types" ? e.code : "clue_types_unreadable";
    console.error("[credit_sweep]", code);
    return { swept: 0, error: code, next: after, done: false };
  }
  const now = opts.now ?? Date.now;
  const reached = await runCredits(sb, toRun, inputs, now() + (opts.budgetMs ?? MATCH_RUN_BUDGET_MS), now, report);
  report.left_for_next_pass = toRun.length - reached.size;
  if (Object.keys(report.failed).length) console.error("[credit_sweep] failures", JSON.stringify(report.failed));
  return { swept: taken.length, with_open_item: taken.length - toRun.length, ...report, next, done };
}

/**
 * The credit_sweep door: only a POST with the exact server key, as
 * match_sweep. With the switch on every call writes clue and shadow rows and
 * raises items; with it off it writes nothing.
 */
export async function creditSweepRequest(
  req: Request,
  sb: Sb,
  serviceKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!serviceKey || req.headers.get("authorization") !== `Bearer ${serviceKey}`) {
    return { status: 403, body: { error: "service_key_required" } };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "post_required" } };
  const after = new URL(req.url).searchParams.get("after");
  if (after != null && (after.length === 0 || after.length > 200)) {
    return { status: 400, body: { error: "invalid_after" } };
  }
  return { status: 200, body: await creditSweep(sb, { after }) };
}
