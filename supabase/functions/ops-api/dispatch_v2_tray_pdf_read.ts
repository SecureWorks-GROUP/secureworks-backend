// deno-lint-ignore-file no-explicit-any
// Dispatch v2 item 16b (Shaun, 18 Nov 2026): read the PDFs on the emails in
// the tray, and suggest the job they are for.
// Contract: docs/dispatch-v2-board-contract.md, section 3j.
//
// The rules, in business words:
//   * A supplier often answers with a scan (a delivery docket, an order
//     confirmation) and nothing in the email says which job it is. The words
//     printed on the scan usually do: our job number, the site address, the
//     client's name, or the supplier's own order number.
//   * Each kept PDF or picture on an email in Emails to sort is read once by
//     the document reader the business already runs (gap plan B-5 for a PDF
//     with words in it, B-5b for a scan: the subscription picture reader, at
//     most 5 pages of it). There is no new service, key or paid call. The reply
//     scan asks for the reads (migration 20261118160000: at most 4 a run, 12
//     an hour); the reader works through them on its own timetable and its own
//     daily limit.
//   * The tray card then says what was read ("Read from the PDF: 13 Woodall
//     Ct, Ref SWP-26100") and puts the most likely job first under "Could be".
//   * It is a suggestion only. Nothing here puts an email on a job, moves a
//     job, writes an order or sends anything. Staff still press the job.
//
// How a job is found in the words (all of it pure, below):
//   * Our job number (SWF-, SWP-, SWR- and digits, with or without the
//     hyphen) that is a real job: the strongest sign.
//   * A supplier order number (5 or more digits) Dispatch already learned
//     against exactly one job.
//   * A live job's street number and street name together ("13 Woodall"),
//     with the street type left out because scans print it many ways. Its
//     suburb in the words adds to that.
//   * The client's first and last name together. A surname alone counts
//     only beside one of the signs above.
//   A job needs at least a street address, a learned order number, a job
//   number or a full client name to be suggested. At most 3 jobs come from the
//   PDF, strongest first.
//
// Each file is read once: the reader keeps its answer against the file (and
// a second email carrying the same bytes is looked up by its SHA-256), so a
// tray refresh only looks the answer up and matches it again. The matching is
// plain text work, costs nothing and is never stored.

import { jobNumbersInPdfText } from "./dispatch_v2_reply_pdf.ts";
import {
  type JobHint,
  jobNumberForms,
  learnableSupplierRefs,
  type MatchCandidate,
  normaliseJobNumber,
  supplierRefsIn,
} from "./dispatch_v2_replies_rules.ts";

// The most the scan asks the reader for in one run (the database caps it at
// 10 a call and 12 an hour whatever is passed).
export const TRAY_PDF_REQUESTS_PER_RUN = 4;
// The reader only takes files up to this size (its default PDF limit).
export const TRAY_PDF_MAX_BYTES = 5_000_000;
// The most jobs the PDF puts under "Could be".
export const TRAY_PDF_MAX_SUGGESTIONS = 3;
// A job is suggested from this score up (see scoreJob).
export const TRAY_PDF_MIN_SCORE = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Job statuses never suggested from an address or a name: the job is gone or
// never started. A job number printed on the PDF is still shown whatever the
// status, because the supplier named it.
const CLOSED_STATUSES = new Set(["cancelled", "archived", "lost", "draft"]);

export type TrayPdfReadState =
  | "read"
  | "no_words"
  | "cannot_read"
  | "waiting"
  | "not_read";

/** One row of dispatch_v2_tray_pdf_reads. */
export type TrayPdfReadRow = {
  attachment_id: string;
  read_state: TrayPdfReadState;
  method: string | null;
  words: string | null;
  read_at: string | null;
};

export type TrayRefLink = { ref: string; job_id: string };

export type TrayPdfStore = {
  /** dispatch_v2_tray_pdf_reads(ids): what the reader made of each file. */
  pdfReads(attachmentIds: string[]): Promise<TrayPdfReadRow[]>;
  jobsByNumbers(orgId: string, numbers: string[]): Promise<JobHint[]>;
  /** Jobs an address or a name may point at: not cancelled, archived, lost,
   * a draft or an old-system record, with a site address. */
  liveJobs(orgId: string): Promise<JobHint[]>;
  /** Supplier numbers Dispatch has learned, and the jobs they were seen on. */
  refLinks(orgId: string, refs: string[]): Promise<TrayRefLink[]>;
  /** dispatch_v2_tray_pdf_read_request(limit): how many reads were asked for. */
  requestReads(limit: number): Promise<number>;
};

/** What the tray card shows about its PDFs. */
export type TrayPdfSummary = {
  // read: words from at least one file. reading: a file is being read.
  // no_words: read, nothing legible. cannot_read: the reader cannot take it.
  // none: no PDF or picture the reader takes.
  state: "read" | "reading" | "no_words" | "cannot_read" | "none";
  line: string | null;
  files_read: number;
  // What was found in the words, for the screen and for tests.
  found: { job_numbers: string[]; supplier_refs: string[] };
  // The job ids the PDF suggests, strongest first.
  suggested_job_ids: string[];
};

export type PdfCandidate = MatchCandidate & {
  from_pdf: true;
  score: number;
};

// ── Words ───────────────────────────────────────────────────────────────────

/** The reader starts its words with a line about itself ("[Document text:
 * Email attachment ..., 1 page. Words read from ...]"). It names the file,
 * not what is printed, so it is dropped before matching. Pure. */
export function stripReaderHeader(words: string): string {
  return String(words ?? "").replace(/^\s*\[Document text:[^\]]*\]\s*/i, "");
}

/** Upper case, every run of anything but letters, digits and "/" as one
 * space, with a space at each end, so a phrase is found as whole words. */
export function normaliseForMatch(text: string): string {
  return " " +
    String(text ?? "").toUpperCase().replace(/[^A-Z0-9/]+/g, " ").trim() + " ";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Street types as an address ends with them, in full and as printed short.
// Only used to cut the type off a job's address: the match itself leaves the
// type out, because scans print it so many ways (Ct, Court, Crt).
const STREET_TYPES = new Set([
  "ST",
  "STREET",
  "RD",
  "ROAD",
  "AVE",
  "AV",
  "AVENUE",
  "CT",
  "CRT",
  "COURT",
  "PL",
  "PLACE",
  "LA",
  "LN",
  "LANE",
  "DR",
  "DRV",
  "DRIVE",
  "CRES",
  "CR",
  "CRESCENT",
  "WAY",
  "WY",
  "CL",
  "CLOSE",
  "TCE",
  "TERRACE",
  "PDE",
  "PARADE",
  "BVD",
  "BLVD",
  "BOULEVARD",
  "HWY",
  "HIGHWAY",
  "CIR",
  "CIRCLE",
  "CCT",
  "CIRCUIT",
  "GR",
  "GRV",
  "GROVE",
  "RISE",
  "LOOP",
  "VIEW",
  "VW",
  "VISTA",
  "GDNS",
  "GARDENS",
  "SQ",
  "SQUARE",
  "PROM",
  "PROMENADE",
  "RTT",
  "RETREAT",
  "ENT",
  "ENTRANCE",
  "BEND",
  "MEWS",
  "PASS",
  "GLADE",
  "GLD",
  "HTS",
  "HEIGHTS",
  "ESP",
  "ESPLANADE",
  "CHASE",
  "APP",
  "APPROACH",
  "PKWY",
  "PARKWAY",
  "LINK",
  "TRL",
  "TRAIL",
  "GATE",
  "GTE",
  "QUAYS",
  "QY",
  "QUAY",
  "OUTLOOK",
  "WALK",
  "PATH",
  "RIDGE",
  "BRAE",
  "BROW",
  "DALE",
  "END",
  "FAIRWAY",
  "GREEN",
  "HILL",
  "PARK",
  "POINT",
  "REACH",
  "RAMBLE",
  "ROW",
  "STRAND",
  "VALE",
  "WOOD",
]);

/** The part of a job's site address the PDF is checked for: its street
 * number and street name, and how to print it back. Null when the address
 * has no street number or a street name too short to be safe. Pure.
 *
 *   "13 Woodall Ct, High Wycombe WA 6057" -> 13, [WOODALL], "13 Woodall Ct"
 *   "Unit 2/15 Smith Street"               -> 15, [SMITH],   "2/15 Smith Street"
 */
export function streetKeyOf(
  siteAddress: string | null | undefined,
  siteSuburb?: string | null,
): { number: string; street: string[]; printed: string } | null {
  let first = String(siteAddress ?? "").split(",")[0].trim();
  if (!first) return null;
  // With no comma the suburb, state and postcode may follow the street.
  const suburb = String(siteSuburb ?? "").trim();
  if (suburb) {
    first = first.replace(
      new RegExp(`\\s+${escapeRe(suburb)}(\\s+WA)?(\\s+\\d{4})?\\s*$`, "i"),
      "",
    );
  }
  first = first.replace(/\s+WA(\s+\d{4})?\s*$/i, "").trim();
  const printed = first.replace(/\s+/g, " ");
  const tokens = normaliseForMatch(first).trim().split(" ").filter(Boolean);
  // Skip "UNIT 2", "LOT 5", "SHOP 1" before the number.
  // "UNIT 2 15 SMITH" and "UNIT 2/15 SMITH" both leave 15 as the number.
  // A lot number alone ("LOT 5 GREAT EASTERN HWY") is not a street number.
  const houseNumber = /^(?:\d+[A-Z]?\/)?\d+[A-Z]?(?:-\d+[A-Z]?)?$/;
  let i = 0;
  const lot = tokens[0] === "LOT";
  if (/^(UNIT|U|LOT|SHOP|APT|FLAT|VILLA)$/.test(tokens[i] ?? "")) i++;
  if (
    /^\d+[A-Z]?$/.test(tokens[i] ?? "") && houseNumber.test(tokens[i + 1] ?? "")
  ) {
    i++;
  } else if (lot) {
    return null;
  }
  // The number: "15", "15A", "2/15", "15-17". The house number is the last.
  const numTok = tokens[i] ?? "";
  const m = /^(?:\d+[A-Z]?\/)?(\d+[A-Z]?)(?:-\d+[A-Z]?)?$/.exec(numTok);
  if (!m) return null;
  let street = tokens.slice(i + 1);
  if (street.length > 1 && STREET_TYPES.has(street[street.length - 1])) {
    street = street.slice(0, -1);
  }
  if (street.length === 0 || street.join("").length < 3) return null;
  if (street.some((w) => !/^[A-Z][A-Z']*$/.test(w))) return null;
  return { number: m[1], street, printed };
}

/** True when the words (normaliseForMatch'd) carry the street number then
 * the street name: "13 WOODALL", or "2/13 WOODALL". Pure. */
export function streetInText(
  key: { number: string; street: string[] },
  norm: string,
): boolean {
  const re = new RegExp(
    `(?<![A-Z0-9/])(?:\\d+[A-Z]?/)?${escapeRe(key.number)} ${
      key.street.map(escapeRe).join(" ")
    } `,
  );
  return re.test(norm);
}

function phraseIn(phrase: string, norm: string): boolean {
  const p = normaliseForMatch(phrase).trim();
  return p.length > 0 && norm.includes(` ${p} `);
}

// Words that are names in our jobs but are everywhere on a supplier's paper.
const NAME_NOISE = new Set([
  "SECUREWORKS",
  "GROUP",
  "PTY",
  "LTD",
  "THE",
  "AND",
  "MR",
  "MRS",
  "MS",
  "DR",
  "JOB",
  "SITE",
  "ORDER",
  "DELIVERY",
  "COLOUR",
  "COLOR",
]);

/** The client's first and last name, upper case, or null. Pure. */
export function clientNameParts(
  clientName: string | null | undefined,
): { first: string; last: string } | null {
  const words = normaliseForMatch(String(clientName ?? "")).trim().split(" ")
    .filter((w) => /^[A-Z][A-Z']+$/.test(w) && !NAME_NOISE.has(w));
  if (words.length < 2) return null;
  return { first: words[0], last: words[words.length - 1] };
}

// ── Scoring one job ─────────────────────────────────────────────────────────

/** How strongly the words point at one job, and the evidence in staff words
 * (as the card prints it). Score 0: nothing. Pure.
 *
 *   job number printed             100  "Ref SWP-26100"
 *   learned supplier order number   60  "Order 11041521"
 *   street number and name          60  "13 Woodall Ct"
 *   suburb, beside a street match   10  "High Wycombe"
 *   client first and last name      30  "Rose Smith"
 *   client surname, beside another  10  "Smith"
 */
export function scoreJob(
  job: JobHint,
  norm: string,
  signs: { jobNumbers: Set<string>; refsByJob: Map<string, string[]> },
): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  const number = job.job_number ? normaliseJobNumber(job.job_number) : null;
  if (number && signs.jobNumbers.has(number)) {
    score += 100;
    evidence.push(`Ref ${number}`);
  }
  const refs = signs.refsByJob.get(job.job_id) ?? [];
  if (refs.length > 0) {
    score += 60;
    evidence.push(`Order ${refs[0]}`);
  }
  const closed = CLOSED_STATUSES.has(String(job.status ?? "").toLowerCase());
  const key = closed ? null : streetKeyOf(job.site_address, job.site_suburb);
  const street = !!key && streetInText(key, norm);
  if (key && street) {
    score += 60;
    evidence.unshift(key.printed);
    // Only a suburb that is just a name (some records hold a whole address).
    const suburb = String(job.site_suburb ?? "").trim();
    if (/^[A-Za-z][A-Za-z' -]+$/.test(suburb) && phraseIn(suburb, norm)) {
      score += 10;
      evidence.splice(1, 0, titleCase(suburb));
    }
  }
  const name = closed ? null : clientNameParts(job.client_name);
  if (name) {
    if (norm.includes(` ${name.first} ${name.last} `)) {
      score += 30;
      evidence.push(titleCase(`${name.first} ${name.last}`));
    } else if (
      score > 0 && name.last.length >= 4 && norm.includes(` ${name.last} `)
    ) {
      score += 10;
      evidence.push(titleCase(name.last));
    }
  }
  return { score, evidence };
}

function titleCase(s: string): string {
  return String(s ?? "").toLowerCase().replace(
    /(^|[\s'-])([a-z])/g,
    (_m, a, b) => a + b.toUpperCase(),
  );
}

// On a tie (two jobs at one address: a second stage, a neighbour's quote),
// a job already going ahead comes before a quote.
const GOING_AHEAD = new Set([
  "accepted",
  "partially_accepted",
  "awaiting_deposit",
  "processing",
  "order_materials",
  "awaiting_supplier",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
]);

/** Every job the words point at, strongest first, at most
 * TRAY_PDF_MAX_SUGGESTIONS, each at least TRAY_PDF_MIN_SCORE. On an equal
 * score, a job in `prefer` (the tray already has an open order from this
 * sender on it) comes first, then a job going ahead, then by job number.
 * Pure. */
export function rankJobsFromWords(
  words: string,
  jobs: JobHint[],
  signs: { jobNumbers: Set<string>; refsByJob: Map<string, string[]> },
  prefer: Set<string> = new Set(),
): { job: JobHint; score: number; evidence: string[] }[] {
  const norm = normaliseForMatch(stripReaderHeader(words));
  const seen = new Set<string>();
  const out: { job: JobHint; score: number; evidence: string[] }[] = [];
  for (const job of jobs) {
    if (seen.has(job.job_id)) continue;
    seen.add(job.job_id);
    const r = scoreJob(job, norm, signs);
    if (r.score >= TRAY_PDF_MIN_SCORE) out.push({ job, ...r });
  }
  const going = (j: JobHint) =>
    GOING_AHEAD.has(String(j.status ?? "").toLowerCase()) ? 1 : 0;
  out.sort((a, b) =>
    b.score - a.score ||
    Number(prefer.has(b.job.job_id)) - Number(prefer.has(a.job.job_id)) ||
    going(b.job) - going(a.job) ||
    String(a.job.job_number ?? "").localeCompare(String(b.job.job_number ?? ""))
  );
  return out.slice(0, TRAY_PDF_MAX_SUGGESTIONS);
}

/** The words' own signs: our job numbers, and the supplier numbers worth
 * looking up (5 digits or more, never one of our job numbers). Pure. */
export function signsInWords(words: string): {
  job_numbers: string[];
  supplier_refs: string[];
} {
  const body = stripReaderHeader(words);
  const jobNumbers = jobNumbersInPdfText(body);
  const refs = learnableSupplierRefs(supplierRefsIn("", body), jobNumbers);
  return { job_numbers: jobNumbers, supplier_refs: refs };
}

// ── Which tray files the reader takes ──────────────────────────────────────

/** A tray file (as addTrayAttachments lists it) the reader can read: kept,
 * a PDF or a picture, within the size limit. Pure. */
export function isReadableTrayFile(a: any): boolean {
  if (!a || a.openable !== true || !UUID_RE.test(String(a.id ?? ""))) {
    return false;
  }
  const size = Number(a.size_bytes);
  if (Number.isFinite(size) && size > TRAY_PDF_MAX_BYTES) return false;
  const kind = String(a.kind_label ?? "");
  const type = String(a.content_type ?? "").toLowerCase();
  const name = String(a.file_name ?? "").toLowerCase();
  return kind === "PDF" || type === "application/pdf" ||
    ["image/jpeg", "image/jpg", "image/png"].includes(type) ||
    /\.(pdf|jpe?g|png)$/.test(name);
}

/** The card's state and line from its files' reads, before any job is
 * matched. Pure. */
export function summaryState(
  reads: TrayPdfReadRow[],
): TrayPdfSummary["state"] {
  if (reads.length === 0) return "none";
  if (reads.some((r) => r.read_state === "read")) return "read";
  if (
    reads.some((r) => r.read_state === "waiting" || r.read_state === "not_read")
  ) {
    return "reading";
  }
  if (reads.some((r) => r.read_state === "no_words")) return "no_words";
  return "cannot_read";
}

const STATE_LINES: Record<string, string> = {
  reading: "Reading the PDF to suggest a job (can take an hour or so)",
  no_words: "The PDF was read: no words on it could be made out",
  cannot_read: "The PDF could not be read",
};

/** The card line. read with a job: "Read from the PDF: 13 Woodall Ct, Ref
 * SWP-26100". read with no job: says so. Pure. */
export function summaryLine(
  state: TrayPdfSummary["state"],
  best: { evidence: string[] } | null,
): string | null {
  if (state === "none") return null;
  if (state === "read") {
    return best && best.evidence.length > 0
      ? `Read from the PDF: ${best.evidence.join(", ")}`
      : "Read from the PDF: no job number, address or client name we know";
  }
  return STATE_LINES[state] ?? null;
}

/** "Could be": the PDF's jobs first (the email's own order on that job kept
 * when the tray already had it), then the tray's own candidates. Pure. */
export function mergeCandidates(
  pdf: PdfCandidate[],
  existing: MatchCandidate[],
): (MatchCandidate | PdfCandidate)[] {
  const byJob = new Map(existing.map((c) => [c.job_id, c]));
  const out: (MatchCandidate | PdfCandidate)[] = pdf.map((p) => {
    const same = byJob.get(p.job_id);
    return same?.order_id ? { ...p, order_id: same.order_id } : p;
  });
  const pdfJobs = new Set(pdf.map((p) => p.job_id));
  for (const c of existing) if (!pdfJobs.has(c.job_id)) out.push(c);
  return out;
}

// ── The tray read ───────────────────────────────────────────────────────────

/** Adds pdf_read to every email of a tray answer that addTrayAttachments has
 * already filled, and puts the PDF's jobs first in its candidates.
 * pdf_reads_read 'ok' | 'failed'. A failure leaves every email as it was
 * (pdf_read null) and the tray still works. Read only. */
export async function addTrayPdfReads<T extends { emails?: any[] }>(
  store: TrayPdfStore,
  orgId: string,
  answer: T,
): Promise<T & { pdf_reads_read: "ok" | "failed" }> {
  const emails = Array.isArray(answer?.emails) ? answer.emails : [];
  if (emails.length === 0) return { ...answer, pdf_reads_read: "ok" };
  try {
    const filesByEmail = new Map<string, string[]>();
    for (const e of emails) {
      const ids = (Array.isArray(e?.attachments) ? e.attachments : [])
        .filter(isReadableTrayFile).map((a: any) => String(a.id));
      filesByEmail.set(String(e?.id ?? ""), ids);
    }
    const allIds = [...new Set([...filesByEmail.values()].flat())];
    const reads = allIds.length ? await store.pdfReads(allIds) : [];
    const readById = new Map(reads.map((r) => [r.attachment_id, r]));

    // The words of each email's files, joined.
    const wordsByEmail = new Map<string, string>();
    for (const [emailId, ids] of filesByEmail) {
      const w = ids.map((id) => readById.get(id))
        .filter((r): r is TrayPdfReadRow =>
          !!r && r.read_state === "read" && !!r.words
        )
        .map((r) => stripReaderHeader(String(r.words)));
      if (w.length) wordsByEmail.set(emailId, w.join("\n"));
    }

    // One look-up for every sign on the page.
    const signsByEmail = new Map<string, ReturnType<typeof signsInWords>>();
    for (const [emailId, w] of wordsByEmail) {
      signsByEmail.set(emailId, signsInWords(w));
    }
    const allNumbers = [
      ...new Set([...signsByEmail.values()].flatMap((s) => s.job_numbers)),
    ];
    const allRefs = [
      ...new Set([...signsByEmail.values()].flatMap((s) => s.supplier_refs)),
    ];
    const [numbered, live, links] = wordsByEmail.size
      ? await Promise.all([
        allNumbers.length ? store.jobsByNumbers(orgId, allNumbers) : [],
        store.liveJobs(orgId),
        allRefs.length ? store.refLinks(orgId, allRefs) : [],
      ])
      : [[], [], []];
    // A supplier number counts only when it was seen on exactly one job.
    const jobsByRef = new Map<string, Set<string>>();
    for (const l of links) {
      const set = jobsByRef.get(l.ref) ?? new Set<string>();
      set.add(l.job_id);
      jobsByRef.set(l.ref, set);
    }
    // The jobs to score: every live job, and any job a printed job number
    // names whatever its status. A learned supplier number counts only for a
    // live job (a closed one is not a delivery we are waiting on).
    const jobById = new Map<string, JobHint>();
    for (const j of [...live, ...numbered]) jobById.set(j.job_id, j);

    return {
      ...answer,
      emails: emails.map((e) => {
        const emailId = String(e?.id ?? "");
        const ids = filesByEmail.get(emailId) ?? [];
        const fileReads = ids.map((id) =>
          readById.get(id) ?? {
            attachment_id: id,
            read_state: "not_read" as const,
            method: null,
            words: null,
            read_at: null,
          }
        );
        const state = summaryState(fileReads);
        const words = wordsByEmail.get(emailId) ?? null;
        const signs = signsByEmail.get(emailId) ??
          { job_numbers: [], supplier_refs: [] };
        let ranked: ReturnType<typeof rankJobsFromWords> = [];
        if (words) {
          const refsByJob = new Map<string, string[]>();
          for (const ref of signs.supplier_refs) {
            const jobsForRef = jobsByRef.get(ref);
            if (jobsForRef?.size === 1) {
              const jobId = [...jobsForRef][0];
              refsByJob.set(jobId, [...(refsByJob.get(jobId) ?? []), ref]);
            }
          }
          const onTray = new Set<string>(
            (Array.isArray(e?.candidates) ? e.candidates : [])
              .map((c: any) => String(c?.job_id ?? "")).filter(Boolean),
          );
          ranked = rankJobsFromWords(words, [...jobById.values()], {
            jobNumbers: new Set(signs.job_numbers.map(normaliseJobNumber)),
            refsByJob,
          }, onTray);
        }
        const best = ranked[0] ?? null;
        const pdfCandidates: PdfCandidate[] = ranked.map((r) => ({
          order_id: null,
          job_id: r.job.job_id,
          job_number: r.job.job_number,
          supplier_name: e?.supplier_name ?? null,
          reason: `Read from the PDF: ${r.evidence.join(", ")}`,
          from_pdf: true,
          score: r.score,
        }));
        const pdf_read: TrayPdfSummary = {
          state,
          line: summaryLine(state, best),
          files_read: fileReads.filter((r) => r.read_state === "read").length,
          found: signs,
          suggested_job_ids: ranked.map((r) => r.job.job_id),
        };
        return {
          ...e,
          pdf_read,
          candidates: mergeCandidates(
            pdfCandidates,
            Array.isArray(e?.candidates) ? e.candidates : [],
          ),
        };
      }),
      pdf_reads_read: "ok",
    };
  } catch (err) {
    console.error("[dispatch_v2_tray_pdf_read] tray read failed:", err);
    return {
      ...answer,
      emails: emails.map((m) => ({ ...m, pdf_read: null })),
      pdf_reads_read: "failed",
    };
  }
}

// ── The scan: ask for the reads ─────────────────────────────────────────────

/** Asks the document reader to read the tray's new files (at most
 * TRAY_PDF_REQUESTS_PER_RUN a run; the database keeps the hourly cap). Never
 * throws: a failure only means no new reads asked for this run. */
export async function requestTrayPdfReads(
  store: Pick<TrayPdfStore, "requestReads">,
): Promise<{ ok: boolean; requested: number }> {
  try {
    const n = await store.requestReads(TRAY_PDF_REQUESTS_PER_RUN);
    return { ok: true, requested: Number.isFinite(n) ? n : 0 };
  } catch (e) {
    console.error("[dispatch_v2_tray_pdf_read] read request failed:", e);
    return { ok: false, requested: 0 };
  }
}

// ── The real store ──────────────────────────────────────────────────────────

const JOB_SELECT =
  "id, job_number, client_name, site_address, site_suburb, status, type";

function hintOf(j: any): JobHint {
  return {
    job_id: String(j.id),
    job_number: j.job_number ?? null,
    client_name: j.client_name ?? null,
    site_address: j.site_address ?? null,
    site_suburb: j.site_suburb ?? null,
    status: j.status ?? null,
    type: j.type ?? null,
  };
}

function must<T>(res: { data: T; error: any }, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message ?? res.error}`);
  return res.data;
}

// The live job list is read in pages; this many at most.
const LIVE_JOB_PAGE = 1000;
const LIVE_JOB_PAGES = 5;

export function postgrestTrayPdfStore(client: any): TrayPdfStore {
  return {
    async pdfReads(ids) {
      const out: TrayPdfReadRow[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const data = must(
          await client.rpc("dispatch_v2_tray_pdf_reads", {
            p_attachment_ids: ids.slice(i, i + 500),
          }),
          "tray pdf reads",
        ) as any[];
        for (const r of data || []) {
          out.push({
            attachment_id: String(r.attachment_id),
            read_state: r.read_state,
            method: r.method ?? null,
            words: r.words ?? null,
            read_at: r.read_at ?? null,
          });
        }
      }
      return out;
    },
    async jobsByNumbers(orgId, numbers) {
      const forms = [...new Set(numbers.flatMap(jobNumberForms))];
      if (forms.length === 0) return [];
      const data = must(
        await client.from("jobs").select(JOB_SELECT).eq("org_id", orgId)
          .in("job_number", forms),
        "tray pdf jobs by number",
      ) as any[];
      return (data || []).map(hintOf);
    },
    async liveJobs(orgId) {
      const out: JobHint[] = [];
      for (let page = 0; page < LIVE_JOB_PAGES; page++) {
        const data = must(
          await client.from("jobs").select(JOB_SELECT).eq("org_id", orgId)
            .not("status", "in", `(${[...CLOSED_STATUSES].join(",")})`)
            .not("site_address", "is", null)
            .or("legacy.is.null,legacy.eq.false")
            .order("id")
            .range(page * LIVE_JOB_PAGE, (page + 1) * LIVE_JOB_PAGE - 1),
          "tray pdf live jobs",
        ) as any[];
        out.push(...(data || []).map(hintOf));
        if (!data || data.length < LIVE_JOB_PAGE) break;
      }
      return out;
    },
    async refLinks(orgId, refs) {
      if (refs.length === 0) return [];
      const data = must(
        await client.from("dispatch_v2_supplier_order_refs").select(
          "ref, job_id",
        )
          .eq("org_id", orgId).in("ref", [...new Set(refs)]),
        "tray pdf supplier numbers",
      ) as any[];
      return (data || []).map((r) => ({
        ref: String(r.ref),
        job_id: String(r.job_id),
      }));
    },
    async requestReads(limit) {
      const data = must(
        await client.rpc("dispatch_v2_tray_pdf_read_request", {
          p_limit: limit,
        }),
        "tray pdf read request",
      );
      return Number(data ?? 0);
    },
  };
}
