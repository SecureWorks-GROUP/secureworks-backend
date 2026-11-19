import {
  addressKey,
  addressKeysIn,
  BILL_BEFORE_JOB_GRACE_DAYS,
  buildAddressIndex,
  buildJobMaps,
  DEAD_JOB_STATUSES,
  GROUP_BUSINESS_UNIT,
  jobNumbersIn,
  OVERHEAD_ACCOUNTS,
  poIsDead,
  poNamedIn,
  type PrematchJob,
} from "../bill_prematch.ts";
import type { Clue, Stop } from "./types.ts";
import { type LabourAccounts, onLabourAccount } from "../../_shared/people_accounts.ts";

/** Off until a person turns it on. The matcher reads bill-PDF findings only then. */
export const BILL_ATTACHMENT_READ_FLAG = "xero_bill_attachment_read_v1";

export interface MatchDocument {
  subject_id: string;
  document_kind: string;
  document_id: string;
  party_id: string | null;
  party_name: string | null;
  document_number: string | null;
  reference: string | null;
  document_date: string | null;
  total_ex: number | null;
  lines: Array<{
    line_key: string;
    description: string | null;
    account_code: string | null;
    tracking_option: string | null;
    amount_ex: number | null;
  }>;
  /** Findings already extracted from a bill PDF. Absent when the switch is off. */
  attachment_texts?: Array<{ where: string; text: string }>;
}
export interface MatchJob extends PrematchJob {
  site_suburb: string | null;
}
export interface NamedOrder {
  order_kind: string;
  order_id: string;
  order_number: string | null;
  job_id: string | null;
  party_id: string | null;
  status: string | null;
  matched: boolean;
}

export function documentTexts(
  doc: MatchDocument,
): Array<{ where: string; text: string }> {
  return [
    { where: "Xero reference box", text: doc.document_number ?? "" },
    { where: "reference", text: doc.reference ?? "" },
    ...doc.lines.map((line, i) => ({
      where: `line ${i + 1} description`,
      text: line.description ?? "",
    })),
    ...(doc.attachment_texts ?? []),
  ];
}

export interface AttachmentFinding {
  job_numbers?: string[] | null;
  po_numbers?: string[] | null;
  order_ref?: string | null;
  delivery_address?: string | null;
}

function clipFinding(raw: unknown, max: number): string {
  return String(raw ?? "").trim().slice(0, max);
}

/** Clue texts from stored PDF findings. The document text itself is never here. */
export function attachmentFindingTexts(
  rows: AttachmentFinding[],
): Array<{ where: string; text: string }> {
  const jobs: string[] = [];
  const pos: string[] = [];
  const refs: string[] = [];
  const addresses: string[] = [];
  const add = (into: string[], raw: unknown, max: number) => {
    const value = clipFinding(raw, max);
    if (value && !into.includes(value)) into.push(value);
  };
  for (const row of rows ?? []) {
    for (const n of row?.job_numbers ?? []) add(jobs, n, 40);
    for (const n of row?.po_numbers ?? []) add(pos, n, 40);
    add(refs, row?.order_ref, 80);
    add(addresses, row?.delivery_address, 160);
  }
  const where = "bill attachment";
  const out: Array<{ where: string; text: string }> = [];
  if (jobs.length) out.push({ where, text: jobs.join(" ") });
  if (pos.length) out.push({ where, text: pos.join(" ") });
  if (refs.length) out.push({ where, text: refs.join(" ") });
  if (addresses.length) out.push({ where, text: addresses.join(" ") });
  return out;
}
const live = (job: PrematchJob) =>
  !job.holding && !DEAD_JOB_STATUSES.has((job.status ?? "").toLowerCase());
const mapsFor = (jobs: MatchJob[]) =>
  buildJobMaps(
    jobs.map((j) => ({ ...j, job_number: j.job_number.toUpperCase() })),
  );
const namedNumbers = (
  doc: MatchDocument,
) => [...new Set(documentTexts(doc).flatMap((t) => jobNumbersIn(t.text)))];

export function jobNumberClue(
  doc: MatchDocument,
  jobs: MatchJob[],
): Clue | null {
  const numbers = namedNumbers(doc);
  if (numbers.length !== 1) return null;
  const maps = mapsFor(jobs);
  const job = maps.jobsByNumber.get(numbers[0]);
  if (!job || !live(job) || maps.digitTwins.has(numbers[0])) return null;
  const seen = documentTexts(doc).find((t) =>
    jobNumbersIn(t.text).includes(numbers[0])
  )!;
  return {
    clue_code: "job_number",
    class: "key",
    family: "doc_text",
    root: `doc:${doc.document_id}`,
    outcome: "job",
    job_id: job.id,
    names_one: true,
    seen_where: seen.where,
    seen_value: numbers[0],
  };
}

/** Jobs supply the live/holding facts absent from a named-order row. No facts means no clue. */
export function orderNumberClue(
  doc: MatchDocument,
  orders: NamedOrder[],
  jobs: MatchJob[] = [],
): Clue | null {
  const jobMap = mapsFor(jobs).jobsById;
  const found = orders.filter((o) =>
    o.order_kind === "purchase_order" && o.job_id && jobMap.has(o.job_id) &&
    live(jobMap.get(o.job_id)!) && !o.matched && !poIsDead(o) &&
    !["draft", "billed"].includes((o.status ?? "").toLowerCase()) &&
    !!doc.party_id && o.party_id === doc.party_id &&
    documentTexts(doc).some((t) =>
      poNamedIn({ po_number: o.order_number }, t.text)
    )
  );
  if (found.length !== 1) return null;
  const o = found[0];
  const seen = documentTexts(doc).find((t) =>
    poNamedIn({ po_number: o.order_number }, t.text)
  )!;
  return {
    clue_code: "order_number",
    class: "key",
    family: "order",
    root: `order:${o.order_id}`,
    outcome: "job",
    job_id: o.job_id!,
    names_one: true,
    seen_where: seen.where,
    seen_value: o.order_number!,
    detail: { order_kind: o.order_kind, order_id: o.order_id },
  };
}

const moneyLines = (doc: MatchDocument) =>
  doc.lines.filter((l) => l.amount_ex != null && l.amount_ex !== 0);
export function overheadAccountClue(doc: MatchDocument): Clue | null {
  const lines = moneyLines(doc);
  return lines.length &&
      lines.every((l) => OVERHEAD_ACCOUNTS.has(l.account_code ?? ""))
    ? {
      clue_code: "overhead_account",
      class: "clue",
      family: "account",
      root: `doc:${doc.document_id}`,
      outcome: "overhead",
      names_one: true,
    }
    : null;
}
export function groupTagClue(doc: MatchDocument): Clue | null {
  const lines = moneyLines(doc);
  return lines.length &&
      lines.every((l) => l.tracking_option === GROUP_BUSINESS_UNIT)
    ? {
      clue_code: "group_tag",
      class: "clue",
      family: "tag",
      root: `doc:${doc.document_id}`,
      outcome: "overhead",
      names_one: true,
    }
    : null;
}

export function deliveryAddressClue(
  doc: MatchDocument,
  jobs: MatchJob[],
): Clue | null {
  const sites = buildAddressIndex(jobs);
  const matches = jobs.filter((j) =>
    live(j) && j.site_suburb?.trim() && addressKey(j.site_address) &&
    sites.get(addressKey(j.site_address)!)?.length === 1 &&
    documentTexts(doc).some((t) => {
      const suburb = j.site_suburb!.toLowerCase().replace(/[^a-z0-9]+/g, " ")
        .trim();
      const words = ` ${
        t.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
      } `;
      return addressKeysIn(t.text).includes(addressKey(j.site_address)!) &&
        words.includes(` ${suburb} `);
    })
  );
  if (matches.length !== 1) return null;
  const j = matches[0];
  return {
    clue_code: "delivery_address",
    class: "clue",
    family: "address",
    root: `job:${j.id}:site`,
    outcome: "job",
    job_id: j.id,
    names_one: true,
  };
}

export function documentStops(doc: MatchDocument, jobs: MatchJob[], labour: LabourAccounts): Stop[] {
  const out: Stop[] = [];
  const stop = (code: string, words: string) => out.push({ code, words });
  const numbers = namedNumbers(doc);
  const maps = mapsFor(jobs);
  if (
    numbers.filter((n) =>
      jobs.some((j) => j.job_number.toUpperCase() === n && live(j))
    ).length > 1
  ) {
    stop("two_jobs_named", "The document names more than one live job");
  }
  if (
    numbers.some((n) => maps.digitTwins.has(n) || maps.duplicateNumbers.has(n))
  ) {
    stop(
      "digit_twin",
      "The named job number shares its digits with another job",
    );
  }
  if (numbers.length === 1) {
    const j = maps.jobsByNumber.get(numbers[0]);
    if (j && !live(j)) {
      stop("job_not_live", "The named job is not live or is a holding job");
    }
    if (
      j?.created_at && doc.document_date &&
      Date.parse(j.created_at.slice(0, 10) + "T00:00:00Z") -
            Date.parse(doc.document_date.slice(0, 10) + "T00:00:00Z") >
        BILL_BEFORE_JOB_GRACE_DAYS * 86_400_000
    ) {
      stop(
        "document_before_job",
        "The document predates the job beyond the grace period",
      );
    }
  }
  if (
    doc.total_ex == null || !Number.isFinite(doc.total_ex) ||
    doc.lines.some((l) => l.amount_ex == null || !Number.isFinite(l.amount_ex))
  ) {
    stop("amount_unknown", "The document or a line has an unknown amount");
  } else {
    const sum = doc.lines.reduce(
      (s, l) => s + Math.round(l.amount_ex! * 100),
      0,
    );
    // A whole cent must be accounted for, including the ticket's one-cent mismatch case.
    if (Math.abs(sum - Math.round(doc.total_ex * 100)) >= 1) {
      stop(
        "document_does_not_conserve",
        "The lines do not add up to the document total",
      );
    }
  }
  if (
    doc.lines.some((l) => l.account_code != null && onLabourAccount(labour, l.account_code))
  ) {
    stop(
      "installer_bill_outside_app",
      "Installer bill requires review against Trade App costs",
    );
  }
  return out;
}

export function divisionTagNarrower(
  doc: MatchDocument,
  job: Pick<MatchJob, "id">,
  expectedTag: string,
): Clue {
  const tags = [...new Set(moneyLines(doc).map((l) => l.tracking_option))];
  const tag = tags.length === 1 ? tags[0] : tags.join(", ");
  return {
    clue_code: "division_tag",
    class: "narrower",
    family: "tag",
    root: `doc:${doc.document_id}`,
    outcome: "job",
    job_id: job.id,
    names_one: true,
    detail: {
      tag,
      expected: expectedTag,
      agrees: tags.length === 1 && tag === expectedTag,
    },
  };
}
