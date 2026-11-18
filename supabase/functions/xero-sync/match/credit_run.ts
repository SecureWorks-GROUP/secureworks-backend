// Follow-up 66, director ruling 00:45: a small raiser for supplier credit notes
// that no bill carries.
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
// `auto`. Through match_apply with item kind `credit`: with
// reconcile_matcher_v1 off (as seeded) it writes the clues and one shadow row
// and raises nothing.
//
// A failed read is never "no clue" and never "no item": the credit is
// skipped and counted, or the page runs nothing and keeps its cursor. Logs
// carry codes and counts only.

import { jobNumbersIn } from "../bill_prematch.ts";
import { decideMatch } from "./decide.ts";
import { documentStops, jobNumberClue, type MatchDocument, type MatchJob } from "./doc_clues.ts";
import { clueJson, MATCH_RUN_BUDGET_MS, MATCH_RUN_LIMIT, proposalOnly } from "./match_run.ts";
import type { Clue, ClueType } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

export const CREDIT_REASON = "credit_not_allocated";

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

async function creditOne(
  sb: Sb,
  creditId: string,
  types: Record<string, ClueType>,
): Promise<{ applied: string } | { skipped: string }> {
  const subjectId = `xero_credit_note:${creditId}`;
  // job_cost_lines_document_idx
  const lines = await read<Array<Record<string, unknown>>>("read_credit_lines",
    sb.from("job_cost_lines").select("org_id,line_key,amount_ex,state,needs_reason,document_number,document_date,party_id,party_name")
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
  const words = (Array.isArray(note.line_items) ? note.line_items : [])
    .map((l: Record<string, unknown>) => (typeof l?.Description === "string" ? l.Description : ""))
    .filter(Boolean).join("\n");
  const doc: MatchDocument = {
    subject_id: subjectId,
    document_kind: "xero_credit_note",
    document_id: creditId,
    party_id: (note.xero_contact_id as string) ?? (waiting.party_id as string) ?? null,
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
  const stops = documentStops(doc, jobs);
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

/**
 * The credit_sweep action: unallocated credits waiting for a person with no
 * open Reconcile item, at most MATCH_RUN_LIMIT a call, by document id
 * descending. The caller holds the cursor: pass `after` = `next` until `done`.
 * Nothing is requeued: a failed credit is counted and the next pass from the
 * top retries it.
 */
export async function creditSweep(
  sb: Sb,
  opts: { after?: string | null; now?: () => number; budgetMs?: number } = {},
): Promise<Record<string, unknown>> {
  const after = opts.after ?? null;
  let q = sb.from("job_cost_lines").select("document_id")
    .eq("document_kind", "xero_credit_note").eq("line_key", "unallocated")
    .eq("state", "needs_person").eq("needs_reason", CREDIT_REASON);
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

  const subjects = taken.map((d) => `xero_credit_note:${d}`);
  // reconcile_items_open_subject_idx. Any open item on the credit, of any kind.
  let items: { data: unknown; error: unknown } | null = null;
  try {
    items = await sb.from("reconcile_items").select("subject_id")
      .eq("subject_table", "cost_document").eq("status", "open").in("subject_id", subjects);
  } catch {
    items = null;
  }
  if (items?.error || !Array.isArray(items?.data)) {
    console.error("[credit_sweep] open items unreadable");
    return { swept: 0, error: "items_unreadable", next: after, done: false };
  }
  const open = new Set((items.data as Array<{ subject_id: string }>).map((r) => r.subject_id));
  const toRun = taken.filter((d) => !open.has(`xero_credit_note:${d}`));

  const report = { run: 0, applied: {} as Record<string, number>, skipped: {} as Record<string, number>, failed: {} as Record<string, number>, left_for_next_pass: 0 };
  let types: Record<string, ClueType>;
  try {
    const rows = await read<ClueType[]>("read_clue_types", sb.from("match_clue_types").select("code,class,family,mode"));
    types = Object.fromEntries((rows ?? []).map((t) => [t.code, t]));
    if (!Object.keys(types).length) throw new ReadFailed("read_clue_types");
  } catch {
    console.error("[credit_sweep] clue types unreadable");
    return { swept: 0, error: "clue_types_unreadable", next: after, done: false };
  }
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? MATCH_RUN_BUDGET_MS);
  for (const id of toRun) {
    if (now() > deadline) {
      report.left_for_next_pass++;
      continue;
    }
    report.run++;
    try {
      const out = await creditOne(sb, id, types);
      if ("applied" in out) bump(report.applied, out.applied);
      else bump(report.skipped, out.skipped);
    } catch (e) {
      bump(report.failed, e instanceof ReadFailed ? e.code : "threw");
    }
  }
  if (Object.keys(report.failed).length) console.error("[credit_sweep] failures", JSON.stringify(report.failed));
  return { swept: taken.length, with_open_item: taken.length - toRun.length, ...report, next, done };
}

/**
 * The credit_sweep door: only a POST with the exact server key, as
 * match_sweep. Every call writes clue and shadow rows.
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
