// deno-lint-ignore-file no-explicit-any
// Dispatch v2 Tweak 1, part 3 (Shaun, 4 Nov 2026): our own one-page
// "Material order" sheet, saved to the job when an order is confirmed and no
// matched supplier reply carries a PDF. Contract:
// docs/dispatch-v2-board-contract.md, section 3e.3.
//
// It is made from the order email we sent (dispatch_supplier_order_emails),
// with the same jsPDF setup as the purchase order PDF (dispatch_order_pdf.ts),
// so the same order makes the same bytes (fixed creation date, file id from
// the order's facts). It says what the crew needs at the yard or on site:
// the supplier, pickup or delivery (and from which branch), the day or ASAP,
// the job number, the supplier's reference when we have one, and the
// materials. Nothing else: no price, no client name, no phone number, no
// email address, no notes.
//
// One page only: a long order shows as many lines as fit, then says how many
// more are on the order email.
//
// A photo-only order (Tweak 5) never gets a sheet: with no lines it would say
// nothing, so the order's photos are saved to the job instead
// (saveDispatchOrderPhotos in dispatch_v2_order_documents.ts). The caller,
// dispatch_v2_order_confirmed_write.ts, makes that choice.

import { dispatchPdfText } from "./dispatch_order_pdf.ts";
import { perthDate, sha256Hex } from "./dispatch_orders.ts";
import { dayLabel } from "./dispatch_v2_replies_rules.ts";
import type { DispatchCrewLineWhen } from "./dispatch_v2_order_confirmed.ts";
import type { DispatchV2Fulfilment } from "./dispatch_v2_emails.ts";
import {
  type DispatchSaveDocResult,
  saveDispatchOrderDocument,
} from "./dispatch_v2_order_documents.ts";

export type DispatchOrderSheetInput = {
  orderId: string;
  jobNumber: string | null;
  supplierName: string;
  fulfilment: DispatchV2Fulfilment;
  branch: string | null;
  when: DispatchCrewLineWhen;
  // When our order email went (an instant).
  sentAt: string | null;
  supplierRef: string | null;
  // The material lines as ordered, one string each (a line may hold
  // several rows, e.g. "10 x 6.1m Lengths\nColour: Surfmist").
  lines: string[];
};

export type DispatchOrderSheet = {
  bytes: Uint8Array;
  sha256: string;
  // How many material rows were drawn, and how many did not fit.
  rowsShown: number;
  rowsLeftOut: number;
};

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 18;
const ROW_H = 5.2;
const ORANGE: [number, number, number] = [241, 90, 41];
const STEEL: [number, number, number] = [41, 60, 70];
const MUTE: [number, number, number] = [76, 106, 124];

/** The material lines of an order: its saved order_lines (their text), or,
 * when there are none, the body of the email between its opening line and
 * its Date line. */
export function dispatchOrderSheetLines(order: {
  order_lines?: unknown;
  body_text?: unknown;
}): string[] {
  const saved = Array.isArray(order.order_lines)
    ? order.order_lines
      .map((l: any) => typeof l?.text === "string" ? l.text.trim() : "")
      .filter((t: string) => t !== "")
    : [];
  if (saved.length > 0) return saved;
  const rows = String(order.body_text ?? "").split(/\r?\n/);
  const first = rows.findIndex((r) => r.trim() !== "");
  const out: string[] = [];
  for (const row of rows.slice(first + 1)) {
    if (/^\s*Date:/i.test(row)) break;
    if (row.trim()) out.push(row.trim());
  }
  return out;
}

/** "Tue 3 Nov 2026", "ASAP" or "No date yet". */
export function dispatchOrderSheetWhen(when: DispatchCrewLineWhen): string {
  if (when.kind === "date") {
    return `${dayLabel(when.date)} ${when.date.slice(0, 4)}`;
  }
  return when.kind === "asap" ? "ASAP" : "No date yet";
}

export async function renderDispatchOrderSheet(
  input: DispatchOrderSheetInput,
): Promise<DispatchOrderSheet> {
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc: any = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });
  doc.setCreationDate(new Date("2020-01-01T00:00:00.000Z"));
  doc.setFileId(
    (await sha256Hex(
      JSON.stringify([
        "dispatch_v2_order_sheet",
        input.orderId,
        input.jobNumber,
        input.supplierName,
        input.fulfilment,
        input.branch,
        input.when,
        input.sentAt,
        input.supplierRef,
        input.lines,
      ]),
    )).slice(0, 32),
  );
  doc.setProperties({ title: "Material order" });

  doc.setFillColor(...ORANGE);
  doc.rect(0, 0, PAGE_W, 5, "F");
  doc.setTextColor(...STEEL);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("MATERIAL ORDER", MARGIN, 20);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("SecureWorks Group", PAGE_W - MARGIN, 15, { align: "right" });

  let y = 32;
  const field = (label: string, value: string) => {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...MUTE);
    doc.setFontSize(9);
    doc.text(label.toUpperCase(), MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...STEEL);
    doc.setFontSize(12);
    const wrapped = doc.splitTextToSize(
      dispatchPdfText(value),
      PAGE_W - MARGIN * 2 - 42,
    );
    doc.text(wrapped, MARGIN + 42, y);
    y += Math.max(1, wrapped.length) * 6 + 1.5;
  };
  const how = input.fulfilment === "pickup"
    ? (input.branch ? `Pickup from ${input.branch}` : "Pickup")
    : "Delivery";
  field("Supplier", input.supplierName || "Supplier");
  field(input.fulfilment === "pickup" ? "Pickup" : "Delivery", how);
  field("When", dispatchOrderSheetWhen(input.when));
  field("Job number", input.jobNumber || "Not recorded");
  if (input.supplierRef) field("Supplier ref", input.supplierRef);
  field("Ordered", perthDate(input.sentAt ?? "") || "Not recorded");

  y += 4;
  doc.setFillColor(238, 242, 244);
  doc.rect(MARGIN, y - 4.5, PAGE_W - MARGIN * 2, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTE);
  doc.text("MATERIALS", MARGIN + 2, y);
  y += 8;

  // Every row of every line, wrapped to the page width.
  const rows: string[][] = [];
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  for (const line of input.lines) {
    for (const part of String(line).split(/\r?\n/)) {
      if (!part.trim()) continue;
      rows.push(
        doc.splitTextToSize(dispatchPdfText(part.trim()), PAGE_W - MARGIN * 2 - 8),
      );
    }
  }
  const footerY = PAGE_H - 22;
  const bottom = footerY - 12;
  let shown = 0;
  for (let i = 0; i < rows.length; i++) {
    const height = rows[i].length * ROW_H + 1.5;
    // Keep room for the "more lines" note when this is not the last row.
    const room = i < rows.length - 1 ? bottom - ROW_H : bottom;
    if (y + height > room) break;
    doc.setTextColor(...STEEL);
    doc.text("-", MARGIN + 2, y);
    doc.text(rows[i], MARGIN + 7, y);
    y += height;
    shown++;
  }
  const leftOut = rows.length - shown;
  if (rows.length === 0) {
    doc.setTextColor(...MUTE);
    doc.text("No material lines were saved on the order.", MARGIN + 2, y);
  } else if (leftOut > 0) {
    doc.setTextColor(...MUTE);
    doc.setFont("helvetica", "bold");
    doc.text(
      `and ${leftOut} more line${leftOut === 1 ? "" : "s"} on the order email`,
      MARGIN + 7,
      y,
    );
  }

  doc.setDrawColor(217, 225, 230);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, footerY - 5, PAGE_W - MARGIN, footerY - 5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTE);
  doc.text(
    "Made by SecureWorks Group from our order email. The supplier sent no document for this order.",
    MARGIN,
    footerY,
  );

  const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    rowsShown: shown,
    rowsLeftOut: leftOut,
  };
}

// ── Saving the sheet to the job ─────────────────────────────────────────────

function log(label: string, error: unknown) {
  console.error(`[dispatch_v2_order_sheet] ${label}:`, error);
}

/** Make the order's Material order sheet and save it to the job, once per
 * order. The caller decides WHEN: only after the matched replies were read
 * and none carries a PDF (dispatch_v2_order_confirmed_write.ts). order: a
 * dispatch_supplier_order_emails row with id, job_id, supplier_id,
 * supplier_name, sent_at, body_text and order_lines. Never throws. */
export async function saveDispatchOrderSheet(
  client: any,
  input: {
    orgId: string;
    order: any;
    fulfilment: DispatchV2Fulfilment;
    branch: string | null;
    when: DispatchCrewLineWhen;
    supplierRef: string | null;
    trigger: string;
    operatorUserId?: string | null;
    now: string;
  },
): Promise<DispatchSaveDocResult | null> {
  try {
    const orderId = String(input.order.id);
    const jobId = String(input.order.job_id);
    // One sheet per order: if one is saved (or being saved), stop before
    // making another. A sheet made later from a changed date would have
    // different bytes, so the content hash alone would not catch it; the
    // database's one-sheet-per-order index is the backstop.
    const have = await client.from("dispatch_v2_order_documents")
      .select("id, content_sha256")
      .eq("order_id", orderId)
      .eq("source", "order_sheet")
      .limit(1);
    if (have.error) {
      log("sheet memory read failed", have.error);
      return null;
    }
    if ((have.data || []).length > 0) {
      return {
        saved: false,
        reason: "already_saved",
        sha256: String(have.data[0].content_sha256 ?? ""),
      };
    }
    const job = await client.from("jobs").select("id, job_number")
      .eq("id", jobId)
      .maybeSingle();
    if (job.error) log("job number read failed", job.error);
    const supplier = String(input.order.supplier_name ?? "").trim() ||
      "Supplier";
    const sheet = await renderDispatchOrderSheet({
      orderId,
      jobNumber: job.data?.job_number ? String(job.data.job_number) : null,
      supplierName: supplier,
      fulfilment: input.fulfilment,
      branch: input.branch,
      when: input.when,
      sentAt: input.order.sent_at ?? null,
      supplierRef: input.supplierRef,
      lines: dispatchOrderSheetLines(input.order),
    });
    return await saveDispatchOrderDocument(client, {
      orgId: input.orgId,
      jobId,
      orderId,
      supplierId: input.order.supplier_id ?? null,
      source: "order_sheet",
      kind: "order_sheet",
      displayName: `${supplier} material order`,
      sha256: sheet.sha256,
      bytes: () => Promise.resolve(sheet.bytes),
      trigger: input.trigger,
      operatorUserId: input.operatorUserId ?? null,
      now: input.now,
    });
  } catch (e) {
    log("order sheet failed", e);
    return null;
  }
}
