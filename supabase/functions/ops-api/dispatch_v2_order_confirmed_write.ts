// deno-lint-ignore-file no-explicit-any
// Dispatch v2: the writer for what happens once a supplier order is confirmed
// (Tweak 1, Shaun 4 Nov 2026). The rules are in dispatch_v2_order_confirmed.ts;
// the contract is docs/dispatch-v2-board-contract.md, section 3e.
//
// Called from three places, each AFTER its own write has succeeded:
//   * Accept on a supplier reply's date suggestion (dispatch_v2_replies.ts,
//     through DispatchRepliesSources.orderConfirmed): trigger 'accept'.
//   * A person moving a box's material stage to Order confirmed
//     (dispatch_v2_material_stage_write.ts): trigger 'stage_set'.
//   * A person changing a box's delivery date by hand
//     (dispatch_v2_delivery_date.ts): trigger 'date_set'. This one only ever
//     FOLLOWS UP an order that already has a line ("moved to ..."); it never
//     writes the first line, because a date typed by hand is not, by itself,
//     the order being confirmed.
//
// What it writes, and nothing else:
//   * one dispatch_v2_order_crew_lines row per line (the memory that the line
//     was written, so it is never written twice);
//   * the crew thread note itself, through deps.writeNote, which is the same
//     add_note the Dispatch "Add a note" button uses (internal only, Office
//     tag, never client-visible, never synced to GHL);
//   * on Accept and the stage press (not a by-hand date): the supplier's PDFs
//     from the order's matched replies, saved to the job's documents once
//     each (dispatch_v2_order_documents.ts, contract section 3e.2); when
//     none of those replies carries a PDF, our own one-page Material order
//     sheet instead, once per order (dispatch_v2_order_sheet_pdf.ts,
//     contract section 3e.3), and the photos that went on our order email,
//     once each (Tweak 5, contract section 3e.4). A photo-only order gets
//     its photos and no sheet: a sheet with no lines says nothing.
// Never a job, job status, stage, supplier, Xero, GHL, SMS or email.
//
// It never throws and never undoes the press that called it: a failure is
// logged and answered as { written: false, reason }.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`.

import {
  dispatchCrewLineDecision,
  type DispatchCrewLineKind,
  dispatchCrewLineRef,
  dispatchCrewLineText,
  dispatchCrewLineWhen,
  dispatchOrderBranchOf,
  dispatchOrderFulfilmentOf,
} from "./dispatch_v2_order_confirmed.ts";
import {
  dispatchOrderIsPhotoOnly,
  type DispatchOrderDocumentsResult,
  saveDispatchOrderPhotos,
  saveDispatchSupplierDocuments,
} from "./dispatch_v2_order_documents.ts";
import { saveDispatchOrderSheet } from "./dispatch_v2_order_sheet_pdf.ts";

export type DispatchOrderConfirmedTrigger = "accept" | "stage_set" | "date_set";

export type DispatchOrderConfirmedInput = {
  orgId: string;
  jobId: string;
  supplierId: string | null;
  // The order Accept was pressed for. Left out (a stage or date press on a
  // box): the box's newest sent order, as the board shows it.
  orderId?: string | null;
  trigger: DispatchOrderConfirmedTrigger;
  operator: { userId: string | null; email: string | null };
  // Accept only: the supplier email whose date was accepted, so its
  // supplier reference goes on the line first.
  acceptedEmailId?: string | null;
};

export type DispatchOrderConfirmedDeps = {
  // Writes one crew thread note exactly as the Dispatch "Add a note" button
  // does, and answers the job_events id. Throws when the note was not saved.
  writeNote(input: {
    jobId: string;
    text: string;
    userId: string | null;
  }): Promise<{ id: string | null }>;
  // The clock (tests pin it); left out, the real time.
  now?: () => string;
};

export type DispatchCrewLineResult =
  | {
    written: true;
    kind: DispatchCrewLineKind;
    text: string;
    order_id: string;
    job_event_id: string | null;
  }
  | {
    written: false;
    reason:
      | "no_sent_order"
      | "no_change"
      | "not_confirmed_yet"
      | "already_written"
      | "read_failed"
      | "write_failed"
      | "note_failed";
    order_id: string | null;
  };

export type DispatchOrderConfirmedResult = {
  crew_line: DispatchCrewLineResult;
  // The supplier's documents saved to the job; null when not run (a by-hand
  // date press) or when there is no sent order.
  documents: DispatchOrderDocumentsResult | null;
};

// The order email columns the line needs.
export const DISPATCH_CONFIRMED_ORDER_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, status, sent_at, delivery_date, body_text";
// The same, plus the material lines the order sheet prints and the photos
// that went on the email (Tweak 5).
const DISPATCH_ORDER_SHEET_SELECT =
  `${DISPATCH_CONFIRMED_ORDER_SELECT}, order_lines, photo_ids`;
const ORDER_STATUSES_SENT = ["sent", "send_unknown"];
const BOX_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, delivery_date, delivery_date_set_at";
const CREW_LINE_SELECT = "id, seq, line_date, line_kind";

function log(label: string, error: unknown) {
  console.error(`[dispatch_v2_order_confirmed] ${label}:`, error);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The order the line is for: the one named, or the box's newest sent order
 * (status sent, newest sent_at), as the board picks the current order. */
export async function loadConfirmedOrder(
  client: any,
  input: Pick<
    DispatchOrderConfirmedInput,
    "orgId" | "jobId" | "supplierId" | "orderId"
  >,
  select = DISPATCH_CONFIRMED_ORDER_SELECT,
): Promise<{ order: any | null; error: boolean }> {
  if (input.orderId) {
    const { data, error } = await client.from("dispatch_supplier_order_emails")
      .select(select)
      .eq("id", input.orderId)
      .eq("job_id", input.jobId)
      .maybeSingle();
    if (error) {
      log("order read failed", error);
      return { order: null, error: true };
    }
    const ok = data && String(data.org_id ?? input.orgId) === input.orgId &&
      ORDER_STATUSES_SENT.includes(String(data.status ?? "")) &&
      text(data.sent_at);
    return { order: ok ? data : null, error: false };
  }
  if (!input.supplierId) return { order: null, error: false };
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select(select)
    .eq("job_id", input.jobId)
    .eq("supplier_id", input.supplierId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) {
    log("order read failed", error);
    return { order: null, error: true };
  }
  const row = (data || []).find((o: any) =>
    String(o.org_id ?? input.orgId) === input.orgId && text(o.sent_at)
  );
  return { order: row ?? null, error: false };
}

async function loadBox(client: any, orgId: string, order: any) {
  if (!order.supplier_id) return null;
  const { data, error } = await client.from("job_material_suppliers")
    .select(BOX_SELECT)
    .eq("job_id", order.job_id)
    .eq("supplier_id", order.supplier_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // Without the box the line falls back to the date the order asked for.
    log("box read failed", error);
    return null;
  }
  return data ?? null;
}

// Tweak 4: the approved name of the order's supplier ("RnR Fencing") when its
// Xero contact is linked to an active approved supplier, so an order made
// before the rename still gets the name Shaun uses. Null when it is not
// linked, or when a read fails (the line then uses the name on the order).
async function loadApprovedName(
  client: any,
  orgId: string,
  supplierId: unknown,
): Promise<string | null> {
  if (typeof supplierId !== "string" || !supplierId) return null;
  try {
    const link = await client.from("dispatch_approved_supplier_email_links")
      .select("approved_id")
      .eq("supplier_id", supplierId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (link.error) {
      log("approved link read failed", link.error);
      return null;
    }
    if (!link.data?.approved_id) return null;
    const entry = await client.from("dispatch_approved_supplier_emails")
      .select("name, active")
      .eq("id", link.data.approved_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (entry.error) {
      log("approved name read failed", entry.error);
      return null;
    }
    return entry.data?.active === true ? text(entry.data.name) : null;
  } catch (error) {
    log("approved name read failed", error);
    return null;
  }
}

// The supplier references, in the order the line prefers them: the accepted
// reply's own, then those saved on the order by the reply matcher, then
// those on the order's other matched replies (oldest first). A failed read
// only means no ref.
async function loadRefs(
  client: any,
  orgId: string,
  orderId: string,
  acceptedEmailId: string | null | undefined,
): Promise<Array<string[] | string | null>> {
  const groups: Array<string[] | string | null> = [];
  if (acceptedEmailId) {
    const { data, error } = await client.from("dispatch_v2_supplier_emails")
      .select("id, supplier_refs")
      .eq("id", acceptedEmailId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) log("accepted email refs read failed", error);
    else if (Array.isArray(data?.supplier_refs)) groups.push(data.supplier_refs);
  }
  const saved = await client.from("dispatch_v2_supplier_order_refs")
    .select("ref, created_at")
    .eq("order_id", orderId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .limit(20);
  if (saved.error) log("order refs read failed", saved.error);
  else for (const r of saved.data || []) groups.push(r.ref ?? null);
  const replies = await client.from("dispatch_v2_supplier_emails")
    .select("id, supplier_refs, received_at")
    .eq("order_id", orderId)
    .eq("org_id", orgId)
    .eq("state", "matched")
    .order("received_at", { ascending: true })
    .limit(20);
  if (replies.error) log("matched replies refs read failed", replies.error);
  else {
    for (const r of replies.data || []) {
      if (Array.isArray(r.supplier_refs)) groups.push(r.supplier_refs);
    }
  }
  return groups;
}

/** Write the crew pickup line for one order, once (rules at the top of
 * dispatch_v2_order_confirmed.ts). Never throws. */
export async function writeDispatchCrewLine(
  client: any,
  input: DispatchOrderConfirmedInput,
  deps: DispatchOrderConfirmedDeps,
): Promise<DispatchCrewLineResult> {
  try {
    const found = await loadConfirmedOrder(client, input);
    if (found.error) {
      return { written: false, reason: "read_failed", order_id: null };
    }
    const order = found.order;
    if (!order) {
      return { written: false, reason: "no_sent_order", order_id: null };
    }
    const orderId = String(order.id);
    const box = await loadBox(client, input.orgId, order);
    const when = dispatchCrewLineWhen({ box, order });

    const prevRead = await client.from("dispatch_v2_order_crew_lines")
      .select(CREW_LINE_SELECT)
      .eq("order_id", orderId)
      .eq("org_id", input.orgId)
      .order("seq", { ascending: false })
      .limit(1);
    if (prevRead.error) {
      log("crew line read failed", prevRead.error);
      return { written: false, reason: "read_failed", order_id: orderId };
    }
    const previous = (prevRead.data || [])[0] ?? null;
    const kind = dispatchCrewLineDecision({
      previous: previous ? { line_date: previous.line_date ?? null } : null,
      when,
      followUpOnly: input.trigger === "date_set",
    });
    if (!kind) {
      return {
        written: false,
        reason: previous ? "no_change" : "not_confirmed_yet",
        order_id: orderId,
      };
    }

    const supplier =
      (await loadApprovedName(client, input.orgId, order.supplier_id)) ||
      text(order.supplier_name) || text(box?.supplier_name) || "Supplier";
    const fulfilment = dispatchOrderFulfilmentOf(order.body_text);
    const branch = kind === "confirmed"
      ? dispatchOrderBranchOf(order.body_text)
      : null;
    const ref = kind === "confirmed"
      ? dispatchCrewLineRef(
        await loadRefs(client, input.orgId, orderId, input.acceptedEmailId),
      )
      : null;
    const lineText = dispatchCrewLineText({
      kind,
      supplier,
      fulfilment,
      when,
      branch,
      ref,
    });

    // Claim the line first. The (order_id, seq) unique key means a second
    // press racing this one is refused here, so only one note is written.
    const seq = previous ? Number(previous.seq) + 1 : 1;
    const claim = await client.from("dispatch_v2_order_crew_lines")
      .insert({
        org_id: input.orgId,
        job_id: order.job_id,
        order_id: orderId,
        supplier_id: order.supplier_id ?? null,
        seq,
        line_kind: kind,
        fulfilment,
        line_date: when.kind === "date" ? when.date : null,
        branch,
        supplier_ref: ref,
        line_text: lineText,
        trigger: input.trigger,
        created_by_email: input.operator.email,
      })
      .select("id")
      .maybeSingle();
    if (claim.error) {
      if (String(claim.error.code ?? "") === "23505") {
        return { written: false, reason: "already_written", order_id: orderId };
      }
      log("crew line claim failed", claim.error);
      return { written: false, reason: "write_failed", order_id: orderId };
    }
    const claimId = claim.data?.id ?? null;

    let note: { id: string | null };
    try {
      note = await deps.writeNote({
        jobId: String(order.job_id),
        text: lineText,
        userId: input.operator.userId,
      });
    } catch (e) {
      // The note did not land: give the claim back so the next press can
      // write it.
      log("crew note write failed", e);
      if (claimId) {
        const { error } = await client.from("dispatch_v2_order_crew_lines")
          .delete()
          .eq("id", claimId);
        if (error) log("crew line claim release failed", error);
      }
      return { written: false, reason: "note_failed", order_id: orderId };
    }
    if (claimId && note?.id) {
      const { error } = await client.from("dispatch_v2_order_crew_lines")
        .update({ job_event_id: note.id })
        .eq("id", claimId);
      if (error) log("crew line link failed", error);
    }
    return {
      written: true,
      kind,
      text: lineText,
      order_id: orderId,
      job_event_id: note?.id ?? null,
    };
  } catch (e) {
    log("crew line failed", e);
    return { written: false, reason: "write_failed", order_id: null };
  }
}

/** Everything that happens once an order is confirmed. Never throws. */
export async function runDispatchV2OrderConfirmed(
  client: any,
  input: DispatchOrderConfirmedInput,
  deps: DispatchOrderConfirmedDeps,
): Promise<DispatchOrderConfirmedResult> {
  const crewLine = await writeDispatchCrewLine(client, input, deps);
  // A by-hand date press only follows up the crew line.
  if (input.trigger === "date_set") {
    return { crew_line: crewLine, documents: null };
  }
  let documents: DispatchOrderDocumentsResult | null = null;
  try {
    const found = await loadConfirmedOrder(
      client,
      input,
      DISPATCH_ORDER_SHEET_SELECT,
    );
    const read = found.order;
    if (read) {
      // Tweak 4: the documents are named with the approved name too
      // ("RnR Fencing invoice"), when the supplier is linked.
      const approvedName = await loadApprovedName(
        client,
        input.orgId,
        read.supplier_id,
      );
      const order = approvedName ? { ...read, supplier_name: approvedName } : read;
      const now = deps.now ? deps.now() : new Date().toISOString();
      documents = await saveDispatchSupplierDocuments(client, {
        orgId: input.orgId,
        order,
        trigger: input.trigger,
        operatorUserId: input.operator.userId,
        now,
      });
      // No PDF on any matched reply (and the replies WERE read, so we know
      // there is none): our own Material order sheet, once per order, and
      // the photos that went on our order email, once each. A photo-only
      // order gets only its photos (Tweak 5): a sheet with no lines is
      // useless to the crew.
      if (documents.read === "ok" && documents.found === 0) {
        if (!dispatchOrderIsPhotoOnly(order)) {
          const box = await loadBox(client, input.orgId, order);
          const sheet = await saveDispatchOrderSheet(client, {
            orgId: input.orgId,
            order,
            fulfilment: dispatchOrderFulfilmentOf(order.body_text),
            branch: dispatchOrderBranchOf(order.body_text),
            when: dispatchCrewLineWhen({ box, order }),
            supplierRef: dispatchCrewLineRef(
              await loadRefs(
                client,
                input.orgId,
                String(order.id),
                input.acceptedEmailId,
              ),
            ),
            trigger: input.trigger,
            operatorUserId: input.operator.userId,
            now,
          });
          if (sheet?.saved) {
            documents.saved.push({
              job_document_id: sheet.job_document_id,
              name: sheet.name,
            });
          } else if (sheet) {
            documents.skipped.push({ sha256: sheet.sha256, reason: sheet.reason });
          }
        }
        const photos = await saveDispatchOrderPhotos(client, {
          orgId: input.orgId,
          order,
          trigger: input.trigger,
          operatorUserId: input.operator.userId,
          now,
        });
        documents.saved.push(...photos.saved);
        documents.skipped.push(...photos.skipped);
      }
    }
  } catch (e) {
    log("documents failed", e);
  }
  return { crew_line: crewLine, documents };
}
