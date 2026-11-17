import {
  amountWithinTolerance,
  dateWithinWindow,
} from "../materials_ingest.ts";
import type { MatchDocument } from "./doc_clues.ts";
import type { Clue } from "./types.ts";

export interface MatchOrder {
  order_kind: "dispatch_order" | "purchase_order";
  order_id: string;
  order_number: string | null;
  job_id: string;
  job_live: boolean;
  party_id: string | null;
  party_name_key: string | null;
  sent_on: string | null;
  cost_ex: number | null;
  from_sealed_scope: boolean;
  matched: boolean;
}
export function supplierNameKey(name: string | null): string {
  return (name ?? "").toLowerCase().replace(/\b(pty|ltd|limited)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

function orderClue(
  doc: MatchDocument,
  orders: MatchOrder[],
  kind: MatchOrder["order_kind"],
): Clue | null {
  const nameKey = supplierNameKey(doc.party_name);
  const candidates = orders.filter((o) =>
    o.order_kind === kind &&
    (kind !== "dispatch_order" || o.from_sealed_scope) &&
    !o.matched && o.job_live && !!o.job_id && o.cost_ex != null &&
    Number.isFinite(o.cost_ex) && o.cost_ex > 0 &&
    doc.total_ex != null && Number.isFinite(doc.total_ex) &&
    (o.party_id
      ? o.party_id === doc.party_id
      : !!nameKey && supplierNameKey(o.party_name_key) === nameKey) &&
    amountWithinTolerance(doc.total_ex, o.cost_ex) &&
    dateWithinWindow(doc.document_date, o.sent_on)
  );
  if (candidates.length !== 1) return null;
  const o = candidates[0];
  return {
    clue_code: kind === "dispatch_order"
      ? "sealed_scope_order"
      : "order_amount",
    class: kind === "dispatch_order" ? "key" : "clue",
    family: "order",
    root: `order:${o.order_id}`,
    outcome: "job",
    job_id: o.job_id,
    names_one: true,
    detail: {
      order_kind: o.order_kind,
      order_id: o.order_id,
      order_cost_ex: o.cost_ex,
      bill_ex: doc.total_ex,
      difference: Math.round((doc.total_ex! - o.cost_ex!) * 100) / 100,
    },
  };
}
export function sealedScopeOrderClue(
  doc: MatchDocument,
  orders: MatchOrder[],
): Clue | null {
  return orderClue(doc, orders, "dispatch_order");
}
export function orderAmountClue(
  doc: MatchDocument,
  orders: MatchOrder[],
): Clue | null {
  return orderClue(doc, orders, "purchase_order");
}
