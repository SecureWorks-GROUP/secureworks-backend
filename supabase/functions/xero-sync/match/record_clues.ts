import { buildDocumentIndex, duplicateDocumentsOf } from "../bill_prematch.ts";
import type { MatchDocument } from "./doc_clues.ts";
import { supplierNameKey } from "./order_clues.ts";
import type { Clue, Stop } from "./types.ts";

export interface BillEvidenceRow {
  decision: string;
  job_id: string | null;
  strong: Array<
    { job_id: string; lanes: Array<{ lane: string; detail: string }> }
  >;
  weak?: unknown;
}
export function supplierMailClue(evidenceRows: BillEvidenceRow[]): Clue | null {
  // context_job_evidence_for_bills returns decision='named' only for a unique
  // strong job. Only its s_mail lane is mail placed by a rule or a person.
  const mail = evidenceRows.flatMap((r) =>
    r.decision === "named" && r.job_id
      ? r.strong.filter((s) => s.job_id === r.job_id).flatMap((s) =>
        s.lanes.filter((l) => l.lane === "supplier_mail" && !!l.detail).map(
          (l) => ({ job_id: s.job_id, mail_id: l.detail }),
        )
      )
      : []
  );
  if (new Set(mail.map((m) => m.job_id)).size !== 1) return null;
  const m = mail[0];
  return {
    clue_code: "supplier_mail",
    class: "clue",
    family: "mail",
    root: `message:${m.mail_id}`,
    outcome: "job",
    job_id: m.job_id,
    names_one: true,
  };
}

/** The caller supplies app provenance, not an inferred job link. */
export interface MatchReceipt {
  id: string;
  job_id: string | null;
  submitted_by: string | null;
  receipt_date: string | null;
  saved_by_trade_app: boolean;
}
export function tradeAppLinkClue(receipt: MatchReceipt): Clue | null {
  if (!receipt.job_id || !receipt.submitted_by || !receipt.saved_by_trade_app) {
    return null;
  }
  return {
    clue_code: "trade_app_link",
    class: "key",
    family: "trade_app",
    root: `receipt:${receipt.id}`,
    outcome: "job",
    job_id: receipt.job_id,
    names_one: true,
  };
}
export interface MatchAssignment {
  id: string;
  job_id: string;
  user_id: string;
  scheduled_date: string | null;
  scheduled_end?: string | null;
  status: string | null;
  is_ghost: boolean;
}
export function bookedTradeDayClue(
  receipt: MatchReceipt,
  assignments: MatchAssignment[],
): Clue | null {
  if (!receipt.submitted_by || !receipt.receipt_date) return null;
  const day = receipt.receipt_date.slice(0, 10);
  const matches = assignments.filter((a) =>
    a.user_id === receipt.submitted_by && !a.is_ghost &&
    a.status?.toLowerCase() !== "cancelled" && !!a.scheduled_date &&
    a.scheduled_date.slice(0, 10) <= day &&
    (a.scheduled_end ?? a.scheduled_date).slice(0, 10) >= day
  );
  if (new Set(matches.map((a) => a.job_id)).size !== 1) return null;
  const a = matches[0];
  return {
    clue_code: "booked_trade_day",
    class: "clue",
    family: "roster",
    root: `assignment:${a.id}`,
    outcome: "job",
    job_id: a.job_id,
    names_one: true,
  };
}

export interface MatchBudgetLine {
  budget_id: string;
  job_id: string;
  lane: string;
  supplier_id: string | null;
  supplier_name: string | null;
  description: string | null;
}
const tokens = (s: string | null) =>
  new Set(
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(
      (t) => t.length >= 3,
    ),
  );
export function scopeItemsClue(
  doc: MatchDocument,
  budgetLinesByJob: MatchBudgetLine[],
): Clue | null {
  const money = doc.lines.filter((l) =>
    l.amount_ex != null && l.amount_ex !== 0
  ).map((l) => tokens(l.description));
  if (money.length < 2) return null;
  const nameKey = supplierNameKey(doc.party_name);
  const budgets = new Map<string, MatchBudgetLine[]>();
  for (const l of budgetLinesByJob) {
    if (
      l.lane !== "materials" ||
      !(l.supplier_id
        ? l.supplier_id === doc.party_id
        : !!nameKey && supplierNameKey(l.supplier_name) === nameKey)
    ) continue;
    const key = JSON.stringify([l.job_id, l.budget_id]);
    budgets.set(key, [...(budgets.get(key) ?? []), l]);
  }
  const qualified = [...budgets.values()].filter((lines) => {
    const required = lines.map((l) => tokens(l.description)).filter((t) =>
      t.size
    );
    const count = money.filter((actual) =>
      required.some((wanted) =>
        [...wanted].filter((t) =>
              actual.has(t)
            ).length / wanted.size >= 0.6
      )
    ).length;
    return count >= 2 && count >= money.length / 2;
  });
  if (qualified.length !== 1) return null;
  const l = qualified[0][0];
  return {
    clue_code: "scope_items",
    class: "clue",
    family: "scope",
    root: `budget:${l.budget_id}`,
    outcome: "job",
    job_id: l.job_id,
    names_one: true,
  };
}

export interface OtherCostDocument extends MatchDocument {
  status: string | null;
  state_words: string;
}
export function duplicateStop(
  doc: MatchDocument,
  others: OtherCostDocument[],
): Stop | null {
  if (doc.total_ex == null || !Number.isFinite(doc.total_ex)) return null;
  const row = (d: MatchDocument, status: string | null) => ({
    xero_invoice_id: d.subject_id,
    invoice_number: d.document_number,
    xero_contact_id: d.party_id,
    contact_name: d.party_name,
    sub_total: d.total_ex,
    status,
  });
  const sameSupplier = (other: MatchDocument) =>
    doc.party_id && other.party_id
      ? doc.party_id === other.party_id
      : !!supplierNameKey(doc.party_name) &&
        supplierNameKey(doc.party_name) === supplierNameKey(other.party_name);
  const prior = others.filter((o) =>
    o.subject_id !== doc.subject_id && o.total_ex != null &&
    Number.isFinite(o.total_ex) &&
    sameSupplier(o) && ((o.document_date ?? "") < (doc.document_date ?? "") ||
      o.document_date === doc.document_date && o.document_id < doc.document_id)
  );
  const other = prior.find((o) =>
    duplicateDocumentsOf(row(doc, null), buildDocumentIndex([row(o, o.status)]))
      .length > 0
  );
  return other
    ? {
      code: "possible_duplicate",
      words:
        "An earlier live document has the same supplier, number and amount",
      detail: {
        other_document_id: other.document_id,
        other_number: other.document_number,
        other_state_words: other.state_words,
      },
    }
    : null;
}

export interface MatchTradeUser {
  id: string;
  xero_contact_id: string | null;
  candidate_job_id: string;
}
export interface NearbyTradeLine {
  user_id: string;
  job_id: string;
  line_date: string | null;
  total_ex: number | null;
}
export function samePersonStop(
  doc: MatchDocument,
  tradeUser: MatchTradeUser | null,
  tradeLinesNearby: NearbyTradeLine[],
): Stop | null {
  if (
    !doc.party_id || !tradeUser || doc.party_id !== tradeUser.xero_contact_id ||
    !doc.document_date
  ) return null;
  const day = Date.parse(doc.document_date.slice(0, 10) + "T00:00:00Z");
  const lines = tradeLinesNearby.filter((l) =>
    l.user_id === tradeUser.id && l.job_id === tradeUser.candidate_job_id &&
    !!l.line_date &&
    Math.abs(Date.parse(l.line_date.slice(0, 10) + "T00:00:00Z") - day) <=
      14 * 86_400_000
  );
  if (!lines.length) return null;
  const total =
    lines.every((l) => l.total_ex != null && Number.isFinite(l.total_ex))
      ? lines.reduce((s, l) => s + Math.round(l.total_ex! * 100), 0) / 100
      : null;
  return {
    code: "same_person_also_in_app",
    words: "This supplier also has Trade App costs on the candidate job nearby",
    detail: { trade_lines_total_ex: total },
  };
}
