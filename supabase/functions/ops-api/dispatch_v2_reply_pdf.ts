// Dispatch v2, Tweak 2 piece 2 (Shaun, 5 Nov 2026): the job number inside a
// supplier's PDF. Contract: docs/dispatch-v2-board-contract.md section 3f.2.
//
// Suppliers often reply with no job number in the email words: it is only on
// the PDF they attach (an order confirmation, a quote, an invoice). When a
// supplier email is still not matched after the text rungs, the reply scan
// reads the text of the PDFs the capture reader already stored for it
// (context_email_attachments and the storage bucket, the same copies Tweak 1
// saves to the job). Outlook is never called.
//
//   * Exactly one of our existing jobs named across its PDFs: the email is
//     matched to that job (rung 'pdf_job_number'), and to the sender's order
//     on that job when it has one.
//   * None, or more than one (a statement listing many jobs): the email is
//     left as it was.
//
// Bounded: at most PDF_FILES_PER_EMAIL files an email and PDF_EMAILS_PER_RUN
// emails a scan run, each file within the PDF text reader's own limits
// (5 MB, 25 pages, 40,000 characters). Every read here is read-only and none
// of it ever throws: a file that cannot be read counts as no job number.

import {
  hasPdfMagic,
  isDispatchPdfCandidate,
} from "./dispatch_v2_order_documents.ts";
import { extractPdfText } from "./makesafe_pdf_text.ts";
import {
  type ApprovedSupplierSender,
  type JobHint,
  normaliseJobNumber,
  type SenderIdentity,
  senderOrderOnJob,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";

// At most this many PDFs are read for one email, and this many emails a run.
// Five minutes of supplier mail is far fewer; an email past the run's budget
// keeps the result its words gave it.
export const PDF_FILES_PER_EMAIL = 3;
export const PDF_EMAILS_PER_RUN = 10;

// Our job numbers as a PDF prints them: SWF (fencing), SWP (patio) or SWR
// (repair), an optional hyphen or space, then 4 to 7 digits. Upper case only
// (a supplier's system prints our reference as we gave it). The character
// before may be a lower-case letter, because PDF text often runs a label into
// the number ("YourRefSWF-261586"), but never a capital or a digit.
const PDF_JOB_NUMBER_RE = /(?<![A-Z0-9])SW([FPR])[- ]?(\d{4,7})(?!\d)/g;

/** Our job numbers in a PDF's text, normalised to SWF-261586, distinct, in
 * the order first seen. Pure. */
export function jobNumbersInPdfText(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(PDF_JOB_NUMBER_RE)) {
    const n = `SW${m[1]}-${m[2]}`;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** What the stored PDFs of one email say. read: 'ok' (at least one PDF read,
 * possibly with no job number), 'none' (no stored PDF), 'failed' (the files
 * could not be listed or none could be read). */
export type ReplyPdfRead = {
  read: "ok" | "none" | "failed";
  job_numbers: string[];
  files: string[];
};

/** The read the scan needs. postgrestReplyPdfReader is the real one; tests
 * pass a fake. */
export interface ReplyPdfReader {
  jobNumbersInPdfs(providerMessageId: string): Promise<ReplyPdfRead>;
}

/** Which job the PDFs point at. Pure. 'one' only when exactly one of the
 * numbers is an existing job; numbers that are not our jobs are ignored. */
export function pickPdfJob(
  jobNumbers: string[],
  jobsByNumber: Map<string, JobHint>,
):
  | { kind: "one"; job: JobHint; job_number: string }
  | { kind: "none" }
  | { kind: "several"; jobs: JobHint[] } {
  const jobs = new Map<string, { job: JobHint; job_number: string }>();
  for (const n of jobNumbers) {
    const job = jobsByNumber.get(normaliseJobNumber(n));
    if (job && !jobs.has(job.job_id)) jobs.set(job.job_id, { job, job_number: n });
  }
  if (jobs.size === 0) return { kind: "none" };
  if (jobs.size > 1) {
    return { kind: "several", jobs: [...jobs.values()].map((j) => j.job) };
  }
  const [only] = jobs.values();
  return { kind: "one", job: only.job, job_number: only.job_number };
}

/** The match the PDF gives, in the scan's MatchResult shape: the job, and the
 * sender's order on it when there is one (the same choice the job number
 * rung makes). Pure. */
export function pdfMatch(
  job: JobHint,
  jobNumber: string,
  orders: V2Order[],
  sender: SenderIdentity,
  approved: ApprovedSupplierSender[],
  file: string | null,
) {
  const order = senderOrderOnJob(job.job_id, orders, sender, approved);
  return {
    state: "matched" as const,
    rung: "pdf_job_number" as const,
    job_id: job.job_id,
    job_number: job.job_number,
    order_id: order?.order_id ?? null,
    reason: `Job number ${job.job_number ?? jobNumber} in the attached PDF${
      file ? ` (${file})` : ""
    }`,
  };
}

function log(label: string, error: unknown) {
  console.error(`[dispatch_v2_reply_pdf] ${label}:`, error);
}

const ATTACHMENT_SELECT =
  "id, provider_message_id, file_name, content_type, sha256, storage_bucket, storage_path, status";

/** The real reader: the email's stored attachments (stored, or a duplicate
 * of a file kept from another email, found by its SHA-256), the PDF bytes
 * from storage, then their text. Never throws. */
export function postgrestReplyPdfReader(client: any): ReplyPdfReader {
  return {
    async jobNumbersInPdfs(providerMessageId: string): Promise<ReplyPdfRead> {
      try {
        const atts = await client.from("context_email_attachments")
          .select(ATTACHMENT_SELECT)
          .eq("provider_message_id", providerMessageId)
          .in("status", ["stored", "skipped_duplicate"])
          .limit(20);
        if (atts.error) {
          log("attachments read failed", atts.error);
          return { read: "failed", job_numbers: [], files: [] };
        }
        const pdfs = (atts.data || []).filter((a: any) =>
          isDispatchPdfCandidate(a) && typeof a.sha256 === "string" &&
          /^[0-9a-f]{64}$/i.test(a.sha256)
        );
        if (pdfs.length === 0) return { read: "none", job_numbers: [], files: [] };

        // One copy per file (by its hash): its own when stored, else the copy
        // kept from the email that brought it first.
        const bySha = new Map<string, any>();
        for (const a of pdfs) {
          const sha = String(a.sha256).toLowerCase();
          const own = a.status === "stored" && a.storage_path && a.storage_bucket;
          if (!bySha.has(sha) || own) bySha.set(sha, { ...a, own: !!own });
        }
        const needCopy = [...bySha.entries()].filter(([, a]) => !a.own)
          .map(([sha]) => sha);
        if (needCopy.length > 0) {
          const stored = await client.from("context_email_attachments")
            .select(ATTACHMENT_SELECT)
            .in("sha256", needCopy)
            .eq("status", "stored")
            .limit(needCopy.length * 4);
          if (stored.error) log("stored copies read failed", stored.error);
          for (const c of stored.data || []) {
            const sha = String(c.sha256).toLowerCase();
            const a = bySha.get(sha);
            if (a && !a.own && c.storage_path && c.storage_bucket) {
              bySha.set(sha, {
                ...c,
                file_name: a.file_name ?? c.file_name,
                own: true,
              });
            }
          }
        }

        const numbers: string[] = [];
        const files: string[] = [];
        let readAny = false;
        const copies = [...bySha.values()].filter((a) => a.own)
          .slice(0, PDF_FILES_PER_EMAIL);
        for (const a of copies) {
          const dl = await client.storage.from(String(a.storage_bucket))
            .download(String(a.storage_path));
          if (dl.error || !dl.data) {
            log("pdf download failed", dl.error ?? "no data");
            continue;
          }
          const bytes = new Uint8Array(await dl.data.arrayBuffer());
          if (!hasPdfMagic(bytes)) continue;
          const pdf = await extractPdfText(bytes);
          readAny = true;
          const found = jobNumbersInPdfText(pdf.rawText || pdf.text);
          if (found.length > 0 && typeof a.file_name === "string") {
            files.push(a.file_name);
          }
          for (const n of found) if (!numbers.includes(n)) numbers.push(n);
        }
        if (!readAny) return { read: "failed", job_numbers: [], files: [] };
        return { read: "ok", job_numbers: numbers, files };
      } catch (e) {
        log("pdf read failed", e);
        return { read: "failed", job_numbers: [], files: [] };
      }
    },
  };
}
