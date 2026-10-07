// deno-lint-ignore-file no-explicit-any
//
// search_jobs with include_closed (ask the story, 6 Oct 2026).
//
// The dashboard's search box (searchJobs in index.ts, unchanged) reads only
// open jobs: the newest 20 substring matches on the job, then 15 in all. Jarvis's
// sw_job_story asks about ANY job by the words said (a surname, an address, a
// phone) and checks every match against those words itself. Two things made it
// answer about the wrong job: a lost, cancelled or draft job could never be
// found by words, so another client with the same surname was read instead;
// and a short surname ("Ng" sits inside a thousand names, emails and suburbs)
// pushed the job asked about past the newest 20.
//
// This mode, asked for with include_closed=true:
//   - reads lost, cancelled and draft jobs too, in their own read after the open
//     ones, so they never push an open job out; each result carries its status;
//   - reads old-system records (jobs.legacy: the CRM imports and abandoned
//     scopes marked legacy on 4 Apr 2026, which the dashboard hides; 903 of the
//     906 have no job number) in reads of their own, and returns them last, each
//     marked legacy, so a question about one finds it and a client who has one
//     is never read as another client's job; the answer says include_legacy;
//   - adds whole-word reads (PostgreSQL ~*, through PostgREST imatch) of the
//     client's name, the suburb, the job number, a contact's name and an invoice
//     reference or number, so every job whose name holds the words as a whole
//     word is found however many longer words also hold them; whole-word matches
//     come first;
//   - reads a phone by its digits however it is stored (+61412345678,
//     0412 345 678, +61 412 345 678, (08) 9123 4567), on the job and on its
//     contacts, since the substring reads compare the text as stored;
//   - says when a read hit its limit or failed (capped), and when a whole-word
//     read did (words_capped), so the caller never reads a cut list as complete.
// Test records stay out, as in the dashboard's search. The broken quote-number
// read (quote_revisions has no quote_number column; see AGENTS.md) is not
// repeated here. Read only: no write, no provider call.

import { pgrestIlikeOrContains, quotePgrestFilterValue } from "../_shared/pgrest.ts";

export const SEARCH_CLOSED_JOB_STATUSES = ["lost", "cancelled", "draft"] as const;

const JOB_COLUMNS = "id, job_number, client_name, client_email, client_phone, site_address, site_suburb, type, status, legacy";
const NOT_LEGACY = "legacy.is.null,legacy.eq.false";

/** How many rows each read takes, and how many of each kind come back: wider than the dashboard's, since the caller checks every match. */
export const SEARCH_WITH_CLOSED_LIMITS = {
  /** Whole-word reads (jobs, contacts, invoices), every status. */
  words: 60,
  /** Substring reads of the job, open and closed each. */
  substring: 30,
  /** Substring reads of contacts, invoices and builder references. */
  secondary: 20,
  /** Results returned, open and closed each. */
  open: 40,
  closed: 40,
  /** Old-system (legacy) records returned, after the closed ones. */
  legacy: 20,
  /** A phone's reads by its digits, of jobs and of contacts. */
  phone: 60,
} as const;

/**
 * A case-insensitive PostgreSQL regex (PostgREST imatch) that holds the words
 * only as whole words: never inside a longer word, so "Ng" holds "Al Ng" and
 * not "Young". Regex characters in the words match as written; a run of spaces
 * matches any run of white space.
 */
export function searchWordPattern(q: string): string {
  const escaped = q.trim().split(/\s+/).map((word) => word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("\\s+");
  return `(^|[^[:alnum:]])${escaped}($|[^[:alnum:]])`;
}

/**
 * The words as a phone, as a PostgreSQL regex that finds the number however it
 * is stored: its national digits (without the 0 or +61 before them), any run
 * of other characters (spaces, brackets, dashes, dots) allowed between each, so
 * 0412345678, +61 412 345 678, 0412 345 678, 04 1234 5678 and (08) 9123 4567
 * each find the others. Null when the words are not a phone: 8 to 12 digits,
 * with nothing else but those separators and a leading +.
 */
export function searchPhonePattern(q: string): string | null {
  const text = q.trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 12) return null;
  const national = /^61\d{9}$/.test(digits) ? digits.slice(2) : /^0\d{9}$/.test(digits) ? digits.slice(1) : digits.slice(-9);
  return national.split("").join("[^0-9]*");
}

type SearchResult = Record<string, any>;
export interface SearchWithClosedAnswer {
  results: SearchResult[];
  include_closed: true;
  /** Old-system (legacy) records were read too: they come last, each with legacy true. */
  include_legacy: true;
  /** A read hit its limit or failed, or a list was cut: some matches may be missing. */
  capped: boolean;
  /** A whole-word read hit its limit or failed: a whole-word match may be missing. */
  words_capped: boolean;
}

export async function searchJobsIncludingClosed(
  client: any,
  q: string,
  opts: { orgId: string; isTestRecord: (name: string | null | undefined) => boolean },
): Promise<SearchWithClosedAnswer> {
  const L = SEARCH_WITH_CLOSED_LIMITS;
  if (!q || q.length < 2) return { results: [], include_closed: true, include_legacy: true, capped: false, words_capped: false };
  const closedList = `(${SEARCH_CLOSED_JOB_STATUSES.map((s) => `"${s}"`).join(",")})`;
  const substring = pgrestIlikeOrContains(
    ["client_name", "job_number", "site_address", "site_suburb", "client_email", "client_phone"],
    q,
  );
  const pattern = quotePgrestFilterValue(searchWordPattern(q));
  const wordsOn = (columns: string[]) => columns.map((column) => `${column}.imatch.${pattern}`).join(",");
  const phone = searchPhonePattern(q);
  const phoneOn = phone ? `client_phone.imatch.${quotePgrestFilterValue(phone)}` : null;
  const notRead = Promise.resolve({ data: [], error: null });

  const reads = await Promise.all([
    // 0, 1: the job's own fields as substrings, open then closed.
    client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).or(NOT_LEGACY).or(substring)
      .not("status", "in", closedList).order("updated_at", { ascending: false }).limit(L.substring),
    client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).or(NOT_LEGACY).or(substring)
      .in("status", [...SEARCH_CLOSED_JOB_STATUSES]).order("updated_at", { ascending: false }).limit(L.substring),
    // 2: whole words of the client's name, the suburb and the job number, every status.
    client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).or(NOT_LEGACY)
      .or(wordsOn(["client_name", "site_suburb", "job_number"])).order("updated_at", { ascending: false }).limit(L.words),
    // 3, 4: invoices by reference or number, substring then whole word.
    client.from("xero_invoices").select("job_id, reference, invoice_number, status, invoice_type")
      .or(pgrestIlikeOrContains(["reference", "invoice_number"], q)).not("status", "in", '("VOIDED","DELETED")').limit(L.secondary),
    client.from("xero_invoices").select("job_id, reference, invoice_number, status, invoice_type")
      .or(wordsOn(["reference", "invoice_number"])).not("status", "in", '("VOIDED","DELETED")').limit(L.words),
    // 5, 6: job contacts (neighbours, other payers): name, email or phone, then the name as whole words.
    client.from("job_contacts").select("job_id, client_name, contact_label, client_email, client_phone").eq("status", "active")
      .or(pgrestIlikeOrContains(["client_name", "client_email", "client_phone"], q)).limit(L.secondary),
    client.from("job_contacts").select("job_id, client_name, contact_label, client_email, client_phone").eq("status", "active")
      .or(wordsOn(["client_name"])).limit(L.words),
    // 7: MakeSafe builder references.
    client.from("makesafe_job_details").select("job_id, external_ref, requesting_company_name")
      .ilike("external_ref", `%${q}%`).limit(L.secondary),
    // 8, 9: old-system (legacy) records, every status: the job's own fields as substrings, then whole words.
    client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).eq("legacy", true).or(substring)
      .order("updated_at", { ascending: false }).limit(L.substring),
    client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).eq("legacy", true)
      .or(wordsOn(["client_name", "site_suburb", "job_number"])).order("updated_at", { ascending: false }).limit(L.words),
    // 10, 11: a phone by its digits, on the job (every status, old-system records too) and on its contacts.
    phoneOn
      ? client.from("jobs").select(JOB_COLUMNS).eq("org_id", opts.orgId).or(phoneOn).order("updated_at", { ascending: false }).limit(L.phone)
      : notRead,
    phoneOn
      ? client.from("job_contacts").select("job_id, client_name, contact_label, client_email, client_phone").eq("status", "active")
        .or(phoneOn).limit(L.phone)
      : notRead,
  ]);
  const limits = [L.substring, L.substring, L.words, L.secondary, L.words, L.secondary, L.words, L.secondary, L.substring, L.words, L.phone, L.phone];
  const wordReads = new Set([2, 4, 6, 9]);
  let capped = false;
  let wordsCapped = false;
  reads.forEach((read: any, i: number) => {
    const full = read?.error || !Array.isArray(read?.data) || read.data.length >= limits[i];
    if (read?.error) console.error(`[ops-api] search_jobs include_closed read ${i} failed:`, read.error.message || read.error);
    if (full) {
      capped = true;
      if (wordReads.has(i)) wordsCapped = true;
    }
  });
  const rows = (i: number): any[] => (Array.isArray(reads[i]?.data) ? reads[i].data : []);

  // Why each job matched, when not by its own fields: the last writer wins, as in the dashboard's search.
  const matchContext = new Map<string, string>();
  for (const inv of [...rows(3), ...rows(4)]) {
    if (inv.job_id) matchContext.set(inv.job_id, `Invoice: ${inv.invoice_number || inv.reference || ""}`);
  }
  for (const c of [...rows(5), ...rows(6), ...rows(11)]) {
    if (c.job_id) matchContext.set(c.job_id, `Contact: ${c.client_name || ""} (${c.contact_label || "neighbour"})`);
  }
  for (const ms of rows(7)) {
    if (ms.job_id) matchContext.set(ms.job_id, `Builder ref: ${ms.external_ref || ""}`);
  }

  // The job's own matches: whole words first, then the phone by its digits, then substrings; old-system records after.
  const direct = new Map<string, SearchResult>();
  for (const job of [...rows(2), ...rows(10), ...rows(0), ...rows(1), ...rows(9), ...rows(8)]) {
    if (job?.id && !direct.has(job.id)) direct.set(job.id, { ...job, match_source: "job" });
  }
  const extraIds = [...matchContext.keys()].filter((id) => !direct.has(id));
  let extra: SearchResult[] = [];
  if (extraIds.length > 0) {
    const read = await client.from("jobs").select(JOB_COLUMNS).in("id", extraIds);
    if (read?.error) {
      console.error("[ops-api] search_jobs include_closed related jobs read failed:", read.error.message || read.error);
      capped = true;
    }
    extra = (Array.isArray(read?.data) ? read.data : []).map((job: any) => ({ ...job, match_source: matchContext.get(job.id) || "related" }));
  }

  const isClosed = (job: SearchResult) => (SEARCH_CLOSED_JOB_STATUSES as readonly string[]).includes(String(job.status));
  const all = [...direct.values(), ...extra].filter((job) => !opts.isTestRecord(job.client_name))
    .map((job) => ({ ...job, legacy: job.legacy === true }));
  const legacy = all.filter((job) => job.legacy);
  const current = all.filter((job) => !job.legacy);
  const open = current.filter((job) => !isClosed(job));
  const closed = current.filter(isClosed);
  if (open.length > L.open || closed.length > L.closed || legacy.length > L.legacy) capped = true;
  return {
    results: [...open.slice(0, L.open), ...closed.slice(0, L.closed), ...legacy.slice(0, L.legacy)],
    include_closed: true,
    include_legacy: true,
    capped,
    words_capped: wordsCapped,
  };
}
