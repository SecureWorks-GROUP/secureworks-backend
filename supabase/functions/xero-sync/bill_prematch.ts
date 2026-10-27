// ════════════════════════════════════════════════════════════
// BILL PRE-MATCH — which job an open Bills to place row belongs to (JP-06).
//
// Owner, 15 Oct 2026: "agent should be able to work it out based off job
// numbers on the PO sheet. each PO sheet should have a job number. otherwise
// intelligently worked out through the context system right".
//
// PURE. No I/O: the caller (bill_prematch_run.ts) reads the bill, the FULL job
// population, the purchase orders and the email attachments the context system
// filed, and this file decides. One decision per bill, rules in this order:
//
//   0. Any money line on subcontractor labour (306, 301): an installer bill.
//      Decided by the rules below like any bill, but a certain match is only
//      ever a proposal a person confirms (JP-12, 20 Oct 2026). Trade-app
//      mirrors never reach here (the caller excludes them).
//   1. A job number in the bill reference or any line, or the job of the PO the
//      bill is linked to or names, naming exactly ONE live job with nothing
//      disagreeing: confident (high). The caller places it.
//   2. Context signals (invoice email filed on one job, one street address,
//      supplier plus amount equals one PO, Xero links a real job), all naming
//      the same one job: medium. A proposal for one staff press.
//   3. Two or more jobs from any of the above (a split bill, or signals that
//      disagree): review, with the candidates listed and nothing picked.
//   4. Every money line on an overhead account, or every money line tagged
//      Business Unit SW - GROUP: not job related (a proposal).
//   5. Anything else: no proposal.
//
// Never proposes a cancelled or lost job, or a holding job (metadata
// do_not_schedule, such as SWF-PDF-BUCKET). Two signals were tested on the live
// list and dropped: amount near quoted materials and date window alone.
// ════════════════════════════════════════════════════════════

import { amountWithinTolerance, DEFAULT_MATCH_CONFIG, type MatchConfig } from "./materials_ingest.ts";

// The canonical job-number grammar (materials_ingest.ts JOB_NUMBER_RE), global,
// widened for how suppliers write it: "SWF261060" and "SWF 261060" are
// SWF-261060 (5 or 6 digits when the hyphen is missing). Never part of a longer
// word or number, so "SWF-261060" is never SWF-26106 and a product code such
// as "SWF261009XL" is no job number. jobNumbersIn normalises.
export const JOB_NUMBER_RE_GLOBAL = /(?<![A-Z0-9])SW(MS|[A-Z])(?:-(\d{4,6})|[ \t]?-?[ \t]?(\d{5,6}))(?![A-Z0-9])/gi;

// Subcontractor labour: out of the agent for now (owner call, 15 Oct 2026).
export const LABOUR_ACCOUNTS = new Set(["306", "301"]);

// Overhead accounts: never a job's cost (fuel, advertising, accounting, training,
// meals, insurance, licences, motor vehicle, marketing, staff amenities, wages
// and admin, subscriptions, GST and PAYG). Job-ish accounts (305 materials, 310
// permits, 311 small tools, 407 engineering, 408 tip fees, 429 drawings, 612
// verge bonds) are deliberately NOT here.
export const OVERHEAD_ACCOUNTS = new Set([
  "302", "400", "412", "413", "420", "433", "441", "449", "461", "474", "475", "485", "820", "825",
]);

export const GROUP_BUSINESS_UNIT = "SW - GROUP";
// Jobs that were never won: a bill is never placed on one by rule ("SWF-26058"
// is a cancelled fencing job; the bill's real job was patio SWP-26058).
export const DEAD_JOB_STATUSES = new Set(["cancelled", "lost", "draft", "quoted"]);
// A bill dated this many days before its job existed disagrees with that job.
export const BILL_BEFORE_JOB_GRACE_DAYS = 14;

export interface PrematchLine {
  description: string | null;
  account_code: string | null;
  amount: number | null;
  business_unit: string | null;
}

export interface PrematchBill {
  xero_invoice_id: string;
  invoice_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  reference: string | null;
  sub_total: number | null;
  invoice_date: string | null;
  xero_job_id: string | null; // xero_invoices.job_id (legacy link)
  lines: PrematchLine[];
}

export interface PrematchJob {
  id: string;
  job_number: string;
  status: string | null;
  created_at: string | null;
  site_address: string | null;
  holding: boolean; // metadata.do_not_schedule
}

export interface PrematchPO {
  id: string;
  po_number: string | null;
  job_id: string | null;
  xero_contact_id: string | null;
  supplier_name: string | null;
  subtotal: number | null;
  status: string | null;
  xero_bill_id: string | null;
}

export interface PrematchContext {
  jobsById: Map<string, PrematchJob>;
  jobsByNumber: Map<string, PrematchJob>; // unique numbers only
  duplicateNumbers?: Set<string>; // a number two jobs share names neither
  digitTwins?: Map<string, string[]>; // job number -> other job numbers with the same digits (SWF-26328 / SWP-26328)
  addressIndex: Map<string, string[]>; // "12 smith" -> job ids
  pos: PrematchPO[];
  emailJobIds: string[]; // jobs the context system filed this bill's invoice email on
  poFactBills?: Map<string, string[]>; // PO id -> bills whose fact is already matched to it
  duplicateDocuments?: string[]; // other live bills that look like this same supplier document
  config?: MatchConfig;
}

export type SignalName =
  | "job_number"
  | "po_job_number"
  | "invoice_email"
  | "street_address"
  | "supplier_amount_po"
  | "xero_job_link";

export interface PrematchCandidate {
  job_id: string;
  job_number: string;
  signals: SignalName[];
}

export type PrematchDecision =
  | { kind: "excluded"; rule: "subcontractor_labour"; reason: string }
  | { kind: "none"; rule: "no_match"; reason: string }
  | {
    kind: "job";
    confidence: "high" | "medium";
    rule: string;
    reason: string;
    job_id: string;
    job_number: string;
    po_id: string | null; // the one rule-1b PO the placement is matched to
    candidates: PrematchCandidate[];
  }
  | { kind: "not_job_related"; confidence: "medium"; rule: string; reason: string }
  | { kind: "review"; confidence: "low"; rule: string; reason: string; candidates: PrematchCandidate[] };

const SIGNAL_WORDS: Record<SignalName, string> = {
  job_number: "job number on the bill",
  po_job_number: "job on the purchase order",
  invoice_email: "invoice email filed on that job",
  street_address: "site street address on the bill",
  supplier_amount_po: "supplier and amount equal one purchase order",
  xero_job_link: "Xero links the bill to that job",
};

// ─────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────
export function jobIsLive(job: PrematchJob | null | undefined): boolean {
  if (!job) return false;
  if (job.holding) return false;
  return !DEAD_JOB_STATUSES.has(String(job.status || "").toLowerCase());
}

export function billTexts(bill: PrematchBill): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  if (bill.reference && bill.reference.trim()) out.push({ where: "reference", text: bill.reference });
  bill.lines.forEach((l, i) => {
    if (l.description && l.description.trim()) out.push({ where: `line ${i + 1}`, text: l.description });
  });
  return out;
}

export function jobNumbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(JOB_NUMBER_RE_GLOBAL)) out.push(`SW${m[1].toUpperCase()}-${m[2] ?? m[3]}`);
  return out;
}

function normWords(s: string | null | undefined): string {
  return ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Street key for an address: the first "number word" pair, e.g. "12 smith". */
export function addressKey(address: string | null | undefined): string | null {
  const m = String(address || "").toLowerCase().match(/(\d+[a-z]?)\s+([a-z]{3,})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

const ADDRESS_NOISE = new Set([
  "pcs", "pack", "packs", "box", "boxes", "bag", "bags", "each", "sheets", "sheet", "lengths", "length",
  "metres", "meters", "mtrs", "days", "day", "hours", "hrs", "weeks", "mins", "litre", "litres", "rolls",
]);

/** Every "number word" pair in a bill text that could be a street key. */
export function addressKeysIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/(?<![a-z0-9.-])(\d+[a-z]?)\s+([a-z]{3,})\b/g)) {
    if (ADDRESS_NOISE.has(m[2])) continue;
    out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/** The job maps a decision reads; a number two jobs share names neither. */
export function buildJobMaps(jobs: PrematchJob[]): {
  jobsById: Map<string, PrematchJob>;
  jobsByNumber: Map<string, PrematchJob>;
  duplicateNumbers: Set<string>;
  digitTwins: Map<string, string[]>;
} {
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  const jobsByNumber = new Map<string, PrematchJob>();
  const duplicateNumbers = new Set<string>();
  for (const j of jobs) {
    if (jobsByNumber.has(j.job_number)) duplicateNumbers.add(j.job_number);
    else jobsByNumber.set(j.job_number, j);
  }
  for (const n of duplicateNumbers) jobsByNumber.delete(n);
  const byDigits = new Map<string, string[]>();
  for (const j of jobs) {
    const d = j.job_number.replace(/\D/g, "");
    if (!byDigits.has(d)) byDigits.set(d, []);
    if (!byDigits.get(d)!.includes(j.job_number)) byDigits.get(d)!.push(j.job_number);
  }
  const digitTwins = new Map<string, string[]>();
  for (const nums of byDigits.values()) {
    if (nums.length < 2) continue;
    for (const n of nums) digitTwins.set(n, nums.filter((x) => x !== n));
  }
  return { jobsById, jobsByNumber, duplicateNumbers, digitTwins };
}

export function buildAddressIndex(jobs: PrematchJob[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const j of jobs) {
    if (!jobIsLive(j)) continue;
    const key = addressKey(j.site_address);
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key)!.push(j.id);
  }
  return idx;
}

/** The invoice number as a bounded word run, or null when too short to trust. */
export function invoiceNumberKey(invoiceNumber: string | null | undefined): string | null {
  const key = normWords(invoiceNumber).trim();
  return key.replace(/ /g, "").length >= 5 ? key : null;
}

/** Does an attachment file name carry this invoice number as whole words? */
export function fileNameCarriesInvoice(fileName: string | null | undefined, invoiceKey: string): boolean {
  const grams = new Set(fileNameGrams(fileName));
  return invoiceKeyForms(invoiceKey).some((k) => grams.has(k));
}

/**
 * The invoice keys a file name can carry: every run of up to six whole words,
 * spaced ("inv 83831") and run together ("inv83831"), plus a word with its letter
 * prefix dropped ("INV00004047.pdf" carries "00004047"). Never a part of a number.
 */
export function fileNameGrams(fileName: string | null | undefined): string[] {
  const words = normWords(fileName).trim().split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 6 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      out.add(run.join(" "));
      out.add(run.join(""));
    }
    const tail = words[i].match(/^[a-z]+(\d[a-z0-9]*)$/);
    if (tail && tail[1].length >= 5) out.add(tail[1]);
  }
  return [...out];
}

/** The forms of an invoice key a file name gram can equal. */
export function invoiceKeyForms(key: string): string[] {
  const forms = [key, key.replace(/ /g, "")];
  // "INV-83831" is also carried by a file named "83831.pdf".
  const tail = key.match(/^[a-z]+ ?(\d[a-z0-9 ]*)$/);
  if (tail && tail[1].replace(/ /g, "").length >= 5) forms.push(tail[1], tail[1].replace(/ /g, ""));
  return [...new Set(forms)];
}

export function poIsDead(po: { status?: string | null }): boolean {
  return ["cancelled", "canceled", "voided", "deleted"].includes(String(po.status || "").toLowerCase());
}

export function poNamedIn(po: { po_number: string | null }, text: string): boolean {
  const n = String(po.po_number || "").trim();
  if (n.length < 5 || !/\d/.test(n)) return false;
  if (normWords(text).includes(normWords(n))) return true;
  // Suppliers write our "PO-1000123" as "PO1000123", "PO 1000123" or "PO#1000123"
  // (INT-25.1). The letters and the whole number must both be there, never
  // inside a longer word or number, and never the bare digits alone.
  const m = n.match(/^([A-Za-z]+)[\s#:.-]*(\d+)$/);
  if (!m) return false;
  return new RegExp(`(?<![A-Za-z0-9])${m[1]}[\\s#:.-]{0,3}${m[2]}(?![A-Za-z0-9])`, "i").test(text);
}

/** A purchase order with no price (a Dispatch order: subtotal 0) has no amount to equal. */
export function poPriced(po: { subtotal: number | null }): boolean {
  return po.subtotal != null && Number.isFinite(Number(po.subtotal)) && Number(po.subtotal) > 0;
}

function moneyLines(bill: PrematchBill): PrematchLine[] {
  return bill.lines.filter((l) => l.amount != null && Number(l.amount) !== 0);
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso.slice(0, 10) + "T00:00:00Z") - Date.parse(fromIso.slice(0, 10) + "T00:00:00Z")) /
    86_400_000;
}

// ─────────────────────────────────────────────────────────────
// THE decision.
// ─────────────────────────────────────────────────────────────

// ── Duplicate supplier documents (CFO-16, 19 Oct 2026) ──
// One supplier document can be entered in Xero more than once, even under two
// contacts for the same supplier (Metecno 1449582: "Metecno" PAID, "Metecno Pty
// Ltd" AUTHORISED, and "Qute 1449582"). The already-matched guard cannot see
// that, so a bill whose document looks duplicated is held for a person.

/** The supplier document key: the longest run of 5 or more digits in the number. */
export function documentKey(invoiceNumber: string | null | undefined): string | null {
  const runs = String(invoiceNumber || "").match(/\d{5,}/g);
  if (!runs) return null;
  return runs.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Every key a document number is known by: its longest 5+ digit run, and all
 * its digits joined without leading zeros (3+ digits), so "1 449 582",
 * "144-9582", "01449582" and "Qute 1449582" all meet "1449582". Letters are
 * dropped on purpose: A12345 and B12345 from one supplier at one amount go to
 * a person, which is the safe side.
 */
export function documentKeys(invoiceNumber: string | null | undefined): string[] {
  const keys = new Set<string>();
  const run = documentKey(invoiceNumber);
  if (run) keys.add(run.replace(/^0+/, ""));
  const joined = String(invoiceNumber || "").replace(/\D/g, "").replace(/^0+/, "");
  if (joined.length >= 3) keys.add(joined);
  return [...keys];
}

const LEGAL_WORDS = new Set(["pty", "ltd", "limited", "proprietary", "inc", "co", "company", "corp", "group", "the", "australia", "aust", "wa", "trust", "trustee", "for", "atf", "and"]);

/** A supplier's name without legal words: "Metecno Pty Ltd" and "Metecno" are one supplier; "National Steel" and "National Hire" are not. */
export function supplierKey(name: string | null | undefined): string | null {
  const words = String(name || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const kept = words.filter((w) => !LEGAL_WORDS.has(w));
  return kept.length ? kept.join(" ") : null;
}

export interface DocumentRow {
  xero_invoice_id: string;
  invoice_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  sub_total: number | null;
  status: string | null;
}

/** Index every live supplier bill by each of its document keys. */
export function buildDocumentIndex(rows: DocumentRow[]): Map<string, DocumentRow[]> {
  const idx = new Map<string, DocumentRow[]>();
  for (const r of rows) {
    const st = String(r.status || "").toUpperCase();
    if (st === "VOIDED" || st === "DELETED") continue;
    for (const k of documentKeys(r.invoice_number)) {
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k)!.push(r);
    }
  }
  return idx;
}

function sameSupplier(a: { xero_contact_id: string | null; contact_name: string | null }, b: { xero_contact_id: string | null; contact_name: string | null }): boolean {
  if (a.xero_contact_id && b.xero_contact_id && a.xero_contact_id === b.xero_contact_id) return true;
  const ka = supplierKey(a.contact_name);
  const kb = supplierKey(b.contact_name);
  if (ka !== null && ka === kb) return true;
  // A side with no supplier identity at all cannot clear the guard.
  return (!a.xero_contact_id && ka === null) || (!b.xero_contact_id && kb === null);
}

function sameAmount(a: number | null, b: number | null): boolean {
  // An unknown amount cannot clear the guard either.
  if (!amountKnown(a) || !amountKnown(b)) return true;
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function amountKnown(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

/**
 * Other live bills that look like the same document: a shared document key,
 * the same ex-GST amount to the cent (or an amount not known), and the same
 * supplier (same contact, or the same name without legal words, or no identity
 * known). Each is described for a person. Uncertainty holds; it never clears.
 */
export function duplicateDocumentsOf(
  bill: { xero_invoice_id: string; invoice_number: string | null; xero_contact_id: string | null; contact_name: string | null; sub_total: number | null },
  index: Map<string, DocumentRow[]>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of documentKeys(bill.invoice_number)) {
    for (const r of index.get(k) || []) {
      if (r.xero_invoice_id === bill.xero_invoice_id || seen.has(r.xero_invoice_id)) continue;
      if (!sameAmount(bill.sub_total, r.sub_total) || !sameSupplier(bill, r)) continue;
      seen.add(r.xero_invoice_id);
      out.push(`${r.invoice_number} (${r.contact_name}, ${String(r.status || "").toUpperCase()})`);
    }
  }
  return out.sort();
}

// True when any money line is subcontractor labour (306, 301): an installer bill.
export function isInstallerBill(bill: PrematchBill): boolean {
  return moneyLines(bill).some((l) => LABOUR_ACCOUNTS.has(String(l.account_code || "")));
}

export function decideBillPrematch(bill: PrematchBill, ctx: PrematchContext): PrematchDecision {
  const d = decideBillPrematchCore(bill, ctx);
  // 0. Installer bills (JP-12, owner 20 Oct 2026: "Include installer bills
  // with human confirmation for now"): the agent proposes, a person confirms
  // each. A certain match is never placed by the agent; it becomes a proposal.
  if (!isInstallerBill(bill)) return d;
  if (d.kind === "job" && d.confidence === "high") {
    return {
      ...d,
      confidence: "medium",
      rule: `${d.rule}+installer_confirm`,
      reason: `Installer bill (account 306 or 301): a person confirms each placement (JP-12). ${d.reason}`,
    };
  }
  return d;
}

function decideBillPrematchCore(bill: PrematchBill, ctx: PrematchContext): PrematchDecision {
  const cfg = ctx.config || DEFAULT_MATCH_CONFIG;
  const money = moneyLines(bill);

  // 0b. The same supplier document entered more than once: a person decides
  // which bill is real before any of them is placed.
  if (ctx.duplicateDocuments?.length) {
    return {
      kind: "review",
      confidence: "low",
      rule: "duplicate_document",
      reason: `This supplier document also appears as ${ctx.duplicateDocuments.join("; ")}. A person confirms which bill is real (supplier statement) before any is placed.`,
      candidates: [],
    };
  }

  // Evidence per job: which signals name it, and where.
  const hits = new Map<string, { job: PrematchJob; signals: Set<SignalName>; where: string[] }>();
  const add = (job: PrematchJob, signal: SignalName, where: string) => {
    if (!hits.has(job.id)) hits.set(job.id, { job, signals: new Set(), where: [] });
    const h = hits.get(job.id)!;
    h.signals.add(signal);
    if (!h.where.includes(where)) h.where.push(where);
  };
  const problems: string[] = [];
  const texts = billTexts(bill);

  // 1a. Job numbers written on the bill.
  for (const t of texts) {
    for (const num of jobNumbersIn(t.text)) {
      const job = ctx.jobsByNumber.get(num);
      if (ctx.duplicateNumbers?.has(num)) problems.push(`${num} (${t.where}) is held by more than one job`);
      else if (!job) problems.push(`${num} (${t.where}) is not a job on record`);
      // A holding job is never evidence for a placement, but it is a second job
      // named: the bill is for a person, never placed whole elsewhere.
      else if (job.holding) problems.push(`${num} (${t.where}) is a holding job`);
      else if (!jobIsLive(job)) problems.push(`${num} (${t.where}) is ${String(job.status).toLowerCase()}`);
      else {
        add(job, "job_number", t.where);
        const twins = ctx.digitTwins?.get(num);
        if (twins?.length) problems.push(`${num} (${t.where}) has the same digits as ${twins.join(", ")}`);
      }
    }
  }
  // 1b. The purchase order the bill is linked to, or names: its job.
  const poByJob = new Map<string, PrematchPO[]>();
  let poTaken = false;
  for (const po of ctx.pos) {
    if (poIsDead(po)) continue;
    if (!po.job_id) {
      if (po.xero_bill_id && po.xero_bill_id === bill.xero_invoice_id) {
        problems.push(`the bill is linked to ${po.po_number || "a purchase order"}, which has no job`);
      } else {
        const t = texts.find((x) => poNamedIn(po, x.text));
        if (t) problems.push(`${po.po_number} (${t.where}) has no job`);
      }
      continue;
    }
    let where: string | null = null;
    if (po.xero_bill_id && po.xero_bill_id === bill.xero_invoice_id) where = `linked ${po.po_number || "PO"}`;
    else {
      const t = texts.find((x) => poNamedIn(po, x.text));
      if (t) {
        // A PO named in the text counts only when it is this supplier's PO and
        // was actually issued; otherwise it is a question for a person.
        const sameSupplier = (bill.xero_contact_id && po.xero_contact_id === bill.xero_contact_id) ||
          (normWords(bill.contact_name).trim().length > 0 && normWords(po.supplier_name).trim() === normWords(bill.contact_name).trim());
        if (String(po.status || "").toLowerCase() === "draft") {
          problems.push(`${po.po_number} (${t.where}) is a draft purchase order`);
          continue;
        }
        if (!sameSupplier) {
          problems.push(`${po.po_number} (${t.where}) is another supplier's purchase order`);
          continue;
        }
        where = `${po.po_number} on ${t.where}`;
      }
    }
    if (!where) continue;
    const job = ctx.jobsById.get(po.job_id);
    if (job && jobIsLive(job)) {
      add(job, "po_job_number", where);
      if (!poByJob.has(job.id)) poByJob.set(job.id, []);
      poByJob.get(job.id)!.push(po);
      const linkedElsewhere = !!po.xero_bill_id && po.xero_bill_id !== bill.xero_invoice_id;
      const factElsewhere = (ctx.poFactBills?.get(po.id) || []).some((b) => b !== bill.xero_invoice_id);
      if (linkedElsewhere || factElsewhere) {
        poTaken = true;
        problems.push(`${po.po_number || "the purchase order"} is already matched to another bill`);
      }
    } else if (job && job.holding) problems.push(`${po.po_number} is on the holding job ${job.job_number}`);
    else if (job) problems.push(`${po.po_number} is on ${job.job_number}, which is ${String(job.status).toLowerCase()}`);
    else problems.push(`${po.po_number} is on a job not on record`);
  }

  // 2. Context signals.
  const emailJobs = [...new Set(ctx.emailJobIds)]
    .map((id) => ctx.jobsById.get(id))
    .filter((j): j is PrematchJob => !!j && jobIsLive(j));
  for (const job of emailJobs) add(job, "invoice_email", "invoice email");

  const addrJobIds = new Set<string>();
  for (const t of texts) {
    for (const key of addressKeysIn(t.text)) {
      for (const id of ctx.addressIndex.get(key) || []) addrJobIds.add(id);
    }
  }
  for (const id of addrJobIds) {
    const job = ctx.jobsById.get(id);
    if (job && jobIsLive(job)) add(job, "street_address", "street address");
  }

  const contactKey = normWords(bill.contact_name).trim();
  for (const po of ctx.pos) {
    if (!po.job_id || poIsDead(po)) continue;
    const sameSupplier = (bill.xero_contact_id && po.xero_contact_id === bill.xero_contact_id) ||
      (contactKey.length > 0 && normWords(po.supplier_name).trim() === contactKey);
    // An unpriced PO is unknown, never $0: a small bill does not "equal" it.
    if (!sameSupplier || !poPriced(po) || !amountWithinTolerance(bill.sub_total, po.subtotal, cfg)) continue;
    const job = ctx.jobsById.get(po.job_id);
    if (job && jobIsLive(job)) add(job, "supplier_amount_po", `${po.po_number || "PO"} amount`);
  }

  if (bill.xero_job_id) {
    const job = ctx.jobsById.get(bill.xero_job_id);
    if (job && jobIsLive(job)) add(job, "xero_job_link", "Xero link");
    // The bill already sits on another real job: placing it elsewhere would
    // count it twice (the cost view only drops a fact on the same job).
    else if (job && job.holding) problems.push(`the bill is linked in Xero to the holding job ${job.job_number}`);
    else if (job) problems.push(`the bill is already linked in Xero to ${job.job_number} (${String(job.status).toLowerCase()})`);
    else if (!job) problems.push("the bill is already linked in Xero to a job not on record");
  }

  const candidates: PrematchCandidate[] = [...hits.values()]
    .map((h) => ({ job_id: h.job.id, job_number: h.job.job_number, signals: [...h.signals].sort() as SignalName[] }))
    .sort((a, b) => a.job_number.localeCompare(b.job_number));
  const strong = candidates.filter((c) => c.signals.includes("job_number") || c.signals.includes("po_job_number"));

  // 3. More than one job: a split bill or signals that disagree. Nothing picked.
  if (candidates.length > 1) {
    const rule = strong.length > 1 ? "split_bill" : strong.length === 1 ? "job_disagrees" : "several_candidates";
    const list = candidates.map((c) => `${c.job_number} (${c.signals.map((s) => SIGNAL_WORDS[s]).join(", ")})`).join("; ");
    return {
      kind: "review",
      confidence: "low",
      rule,
      reason: (rule === "split_bill" ? "The bill names more than one job: " : "Signals point at more than one job: ") + list +
        (problems.length ? `. Also: ${problems.join("; ")}.` : "."),
      candidates,
    };
  }

  if (candidates.length === 1) {
    const c = candidates[0];
    const h = hits.get(c.job_id)!;
    const why = c.signals.map((s) => SIGNAL_WORDS[s]).join(", ");
    const tooEarly = bill.invoice_date && h.job.created_at &&
      daysBetween(bill.invoice_date, h.job.created_at) > BILL_BEFORE_JOB_GRACE_DAYS;
    if (tooEarly) problems.push(`the bill is dated ${bill.invoice_date} but ${c.job_number} was created ${h.job.created_at!.slice(0, 10)}`);
    const jobPos = poByJob.get(c.job_id) || [];
    if (jobPos.length > 1) {
      problems.push(`the bill names more than one purchase order (${jobPos.map((p) => p.po_number || p.id).join(", ")})`);
    }
    if (problems.length) {
      return {
        kind: "review",
        confidence: "low",
        rule: poTaken ? "po_already_matched" : "job_disagrees",
        reason: `${c.job_number} (${why}), but ${problems.join("; ")}.`,
        candidates,
      };
    }
    if (strong.length === 1) {
      return {
        kind: "job",
        confidence: "high",
        rule: c.signals.includes("job_number") ? "job_number" : "po_job_number",
        reason: `${c.job_number}: ${why} (${h.where.join(", ")}); it names one live job and nothing points elsewhere.`,
        job_id: c.job_id,
        job_number: c.job_number,
        po_id: jobPos.length === 1 ? jobPos[0].id : null,
        candidates,
      };
    }
    return {
      kind: "job",
      confidence: "medium",
      rule: c.signals.join("+"),
      reason: `${c.job_number}: ${why}. Needs a look before placing.`,
      job_id: c.job_id,
      job_number: c.job_number,
      po_id: null,
      candidates,
    };
  }

  // A job number that names no live job, and nothing else.
  if (problems.length) {
    return { kind: "review", confidence: "low", rule: "job_number_not_live", reason: `${problems.join("; ")}.`, candidates: [] };
  }

  // 4. Not job related.
  if (money.length > 0 && money.every((l) => OVERHEAD_ACCOUNTS.has(String(l.account_code || "")))) {
    const codes = [...new Set(money.map((l) => String(l.account_code)))].sort().join(", ");
    return { kind: "not_job_related", confidence: "medium", rule: "overhead_account", reason: `Every line is on an overhead account (${codes}).` };
  }
  if (money.length > 0 && money.every((l) => String(l.business_unit || "").trim().toUpperCase() === GROUP_BUSINESS_UNIT)) {
    return { kind: "not_job_related", confidence: "medium", rule: "group_business_unit", reason: "Every line is tagged Business Unit SW - GROUP." };
  }

  return { kind: "none", rule: "no_match", reason: "No job number, purchase order, email, address or Xero link names a job." };
}

/** Stable fingerprint of what a decision says, so an unchanged proposal is not rewritten. */
export function decisionFingerprint(d: PrematchDecision): string {
  const job = d.kind === "job" ? `${d.job_id}:${d.po_id ?? ""}` : "";
  const cands = "candidates" in d ? d.candidates.map((c) => `${c.job_id}:${c.signals.join(",")}`).join("|") : "";
  const conf = "confidence" in d ? d.confidence : "";
  return [d.kind, conf, d.rule, job, cands, d.reason].join("#");
}
