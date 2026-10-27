// deno-lint-ignore-file no-explicit-any
// Dispatch v2, slice 8: the ONE place the reply matcher reads (and the one
// write it makes to) tables that other Dispatch v2 slices own.
//
// Everything the matcher needs from them goes through DispatchRepliesSources,
// so wiring this slice to the finished sibling work means changing this file
// only. The default below reads the tables as the sibling branches define
// them on 23 Oct 2026 (contract: replies.md, "Assumed from the sibling work"):
//
//   Orders (slice 5/6, branch feat dispatch supplier order emails):
//     dispatch_supplier_order_emails  id, org_id, job_id, supplier_id,
//       supplier_name, status ('draft' | 'sending' | 'sent' | 'send_unknown'
//       | 'discarded'), sent_at, sent_internet_message_id,
//       sent_conversation_id. One row per supplier order email; that row's id
//       is the "order" this slice matches replies to.
//   Approved supplier order emails (same branch):
//     dispatch_approved_supplier_emails       id, org_id, name, to_emails,
//                                             cc_emails, active
//     dispatch_approved_supplier_email_links  supplier_id, approved_id
//   The confirmed delivery date (board v2 branch, migration
//   20261023160000_dispatch_v2_board_arrival_dates.sql), on the supplier box
//   (job_material_suppliers, matched by job_id and supplier_id):
//     delivery_date, delivery_date_source ('by_hand' | 'supplier_reply'),
//     delivery_date_set_at, delivery_date_set_by_email,
//     delivery_date_confirmed_at (set = confirmed), delivery_date_confirmed_by,
//     delivery_date_confirmed_by_email
//
// A table or column that is not there yet reads as "not wired": the matcher
// still runs (job numbers still match), it just knows no orders, and Accept
// refuses with 503 orders_not_wired instead of guessing where to write.
//
// Nothing here writes suppliers.email (the 06:55 Xero sync owns it), Xero, a
// job, a job status or an order email. The one write is the supplier box's
// confirmed delivery date, and only when a person presses Accept.

import {
  type ApprovedSupplierSender,
  supplierKeyOf,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";

export type SourceRead<T> = { available: boolean; rows: T[] };

export type SetConfirmedDeliveryInput = {
  orgId: string;
  order: V2Order;
  // YYYY-MM-DD, a Perth calendar day.
  date: string;
  now: string;
  suggestionId: string;
  // The person who pressed Accept.
  operator: { userId: string | null; email: string };
};

export type SetConfirmedDeliveryResult =
  | { ok: true; confirmed_delivery_date: string }
  | { ok: false; status: number; code: string; message: string };

export interface DispatchRepliesSources {
  /** Sent orders (sent or send_unknown), newest first: those sent on or
   * after `sentSince`, plus every sent order on `jobIds`. */
  listOrders(
    orgId: string,
    opts: { sentSince: string; jobIds?: string[] },
  ): Promise<SourceRead<V2Order>>;
  /** One order by id, any status (null when not found). */
  getOrder(orgId: string, orderId: string): Promise<SourceRead<V2Order>>;
  /** The approved supplier order email list, active entries only. */
  listApprovedSenders(
    orgId: string,
  ): Promise<SourceRead<ApprovedSupplierSender>>;
  /** Accept: set the order's confirmed delivery date. */
  setConfirmedDeliveryDate(
    input: SetConfirmedDeliveryInput,
  ): Promise<SetConfirmedDeliveryResult>;
}

// The supplier box's delivery_date_source for a date taken from a supplier's
// email (board v2 allows 'by_hand' or 'supplier_reply').
export const DELIVERY_SOURCE_SUPPLIER_REPLY = "supplier_reply";

const ORDER_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, status, sent_at, sent_internet_message_id, sent_conversation_id";
const SENT_STATUSES = ["sent", "send_unknown"];

/** Postgres / PostgREST codes for "that table or column is not there". */
export function isNotWired(error: any): boolean {
  const code = String(error?.code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST205" ||
    code === "PGRST204";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A sibling table read or write that failed for a reason other than "not
 * there yet". The engine turns it into a 500 and logs `detail`. */
export class SourceReadError extends Error {
  detail: unknown;
  constructor(label: string, detail: unknown) {
    super(`${label} failed`);
    this.detail = detail;
  }
}

/** The default: PostgREST reads of the sibling tables. */
export function postgrestDispatchRepliesSources(
  client: any,
): DispatchRepliesSources {
  // job number and the box's confirmed date, for a set of order rows.
  async function decorate(orgId: string, rows: any[]): Promise<V2Order[]> {
    if (rows.length === 0) return [];
    const jobIds = [...new Set(rows.map((r) => String(r.job_id)))];
    const jobNumbers = new Map<string, string | null>();
    const confirmed = new Map<string, string | null>();
    for (const ids of chunks(jobIds, 100)) {
      const { data, error } = await client.from("jobs")
        .select("id, job_number")
        .eq("org_id", orgId)
        .in("id", ids);
      if (error) throw new SourceReadError("order jobs read", error);
      for (const j of data || []) {
        jobNumbers.set(String(j.id), j.job_number ?? null);
      }

      const boxes = await client.from("job_material_suppliers")
        .select(
          "job_id, supplier_id, delivery_date, delivery_date_confirmed_at",
        )
        .in("job_id", ids);
      if (boxes.error) {
        // Board v2's columns are not there yet: no confirmed dates known.
        if (!isNotWired(boxes.error)) {
          throw new SourceReadError("supplier box read", boxes.error);
        }
      } else {
        for (const b of boxes.data || []) {
          confirmed.set(
            `${b.job_id}:${b.supplier_id}`,
            b.delivery_date_confirmed_at && b.delivery_date
              ? String(b.delivery_date).slice(0, 10)
              : null,
          );
        }
      }
    }
    return rows.map((r) => ({
      order_id: String(r.id),
      job_id: String(r.job_id),
      job_number: jobNumbers.get(String(r.job_id)) ?? null,
      supplier_id: text(r.supplier_id),
      supplier_name: text(r.supplier_name) ?? "Supplier",
      status: String(r.status ?? ""),
      sent_at: text(r.sent_at),
      sent_internet_message_id: text(r.sent_internet_message_id),
      sent_conversation_id: text(r.sent_conversation_id),
      confirmed_delivery_date: confirmed.get(`${r.job_id}:${r.supplier_id}`) ??
        null,
    }));
  }

  return {
    async listOrders(orgId, opts) {
      const recent = await client.from("dispatch_supplier_order_emails")
        .select(ORDER_SELECT)
        .eq("org_id", orgId)
        .in("status", SENT_STATUSES)
        .gte("sent_at", opts.sentSince)
        .order("sent_at", { ascending: false })
        .limit(1000);
      if (recent.error) {
        if (isNotWired(recent.error)) return { available: false, rows: [] };
        throw new SourceReadError("orders read", recent.error);
      }
      const byId = new Map<string, any>();
      for (const r of recent.data || []) byId.set(String(r.id), r);
      for (const ids of chunks([...new Set(opts.jobIds ?? [])], 100)) {
        const { data, error } = await client.from(
          "dispatch_supplier_order_emails",
        )
          .select(ORDER_SELECT)
          .eq("org_id", orgId)
          .in("status", SENT_STATUSES)
          .in("job_id", ids);
        if (error) throw new SourceReadError("job orders read", error);
        for (const r of data || []) byId.set(String(r.id), r);
      }
      return {
        available: true,
        rows: await decorate(orgId, [...byId.values()]),
      };
    },

    async getOrder(orgId, orderId) {
      const { data, error } = await client.from(
        "dispatch_supplier_order_emails",
      )
        .select(ORDER_SELECT)
        .eq("org_id", orgId)
        .eq("id", orderId)
        .maybeSingle();
      if (error) {
        if (isNotWired(error)) return { available: false, rows: [] };
        throw new SourceReadError("order read", error);
      }
      return {
        available: true,
        rows: await decorate(orgId, data ? [data] : []),
      };
    },

    async listApprovedSenders(orgId) {
      const entries = await client.from("dispatch_approved_supplier_emails")
        .select("id, name, to_emails, cc_emails, active")
        .eq("org_id", orgId)
        .eq("active", true);
      if (entries.error) {
        if (isNotWired(entries.error)) return { available: false, rows: [] };
        throw new SourceReadError("approved emails read", entries.error);
      }
      const links = await client.from("dispatch_approved_supplier_email_links")
        .select("supplier_id, approved_id")
        .eq("org_id", orgId);
      if (links.error && !isNotWired(links.error)) {
        throw new SourceReadError("approved links read", links.error);
      }
      const idsByEntry = new Map<string, string[]>();
      for (const l of links.data || []) {
        const key = String(l.approved_id);
        idsByEntry.set(key, [
          ...(idsByEntry.get(key) ?? []),
          String(l.supplier_id),
        ]);
      }
      return {
        available: true,
        rows: (entries.data || []).map((e: any) => ({
          supplier_key: supplierKeyOf(e.name),
          supplier_name: String(e.name),
          supplier_ids: idsByEntry.get(String(e.id)) ?? [],
          emails: [...(e.to_emails || []), ...(e.cc_emails || [])]
            .map((x: unknown) => String(x).trim().toLowerCase())
            .filter(Boolean),
        })),
      };
    },

    async setConfirmedDeliveryDate(input) {
      if (!input.order.supplier_id) {
        return {
          ok: false,
          status: 409,
          code: "order_has_no_supplier_box",
          message: "This order has no supplier box to put the date on",
        };
      }
      const { data, error } = await client.from("job_material_suppliers")
        .update({
          delivery_date: input.date,
          delivery_date_source: DELIVERY_SOURCE_SUPPLIER_REPLY,
          delivery_date_set_at: input.now,
          delivery_date_set_by_email: input.operator.email,
          delivery_date_confirmed_at: input.now,
          delivery_date_confirmed_by: input.operator.userId,
          delivery_date_confirmed_by_email: input.operator.email,
        })
        .eq("job_id", input.order.job_id)
        .eq("supplier_id", input.order.supplier_id)
        .select("job_id, supplier_id, delivery_date");
      if (error) {
        if (isNotWired(error)) {
          return {
            ok: false,
            status: 503,
            code: "orders_not_wired",
            message:
              "The order's confirmed delivery date is not in the database yet",
          };
        }
        throw new SourceReadError("confirmed delivery write", error);
      }
      if (!data || data.length === 0) {
        return {
          ok: false,
          status: 409,
          code: "supplier_box_not_found",
          message: "The supplier box for this order is no longer on the job",
        };
      }
      return { ok: true, confirmed_delivery_date: input.date };
    },
  };
}
