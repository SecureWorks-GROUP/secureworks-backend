// The grain of the reference SES actually mints onto a Xero invoice.
//
// Why this exists
// ---------------
// The assembler's `source.builder_reference` prefers `builder_wo_canonical` and DROPS the card's
// own `builder_po_canonical`, so a card whose intake case knows both mints a claim-only reference.
// Koondoola SWMS-261025 is the worked case: its intake case carried
// `builder_wo_canonical = MLB-27093` and `builder_po_canonical = PO-56481`, it minted DRAFT
// INV-1140 with reference `MLB-27093`, and the already-AUTHORISED INV-1080 for the same work carried
// `MLB-27093PO-56481`. The two strings never matched, so a $255 second invoice was raised against
// work already billed at $390 (2026-08-06 live readback).
//
// The purchase order is the instruction key (`AGENTS.md`, Captain 2026-08-02). Carrying it onto the
// reference makes the minted grain match the identity grain the rest of the system already keys on,
// and makes the SAME pair collide at the guard's exact-reference tier rather than at a fuzzy one.
//
// Where this is applied, and why not earlier
// ------------------------------------------
// Composition happens at the INVOICE OBLIGATION layer, not in the assembler adapter and not in the
// docket's local invoice proposal:
//
//   - `SesAssemblerInputV1.source.builder_reference` is inside the docket INPUT hash, which is what
//     `docketRevisionId` is derived from. Changing it re-keys every docket revision on the board and
//     drops every Docs Ready signoff, for no pricing effect.
//   - `local_invoice_proposal` is inside the docket OUTPUT hash, so recomposing the reference there
//     would make stored artifacts disagree with a recomputed docket.
//
// The obligation's own content hash does move, which mints a fresh obligation revision id on the
// next prepare. That is ordinary churn: an obligation already `create_executed` or `authorised` is
// refused from re-prepare before this code is reached.
//
// This module is pure. It never invents a purchase order: no PO evidence means the reference is
// returned exactly as the docket produced it.

import { splitRefPo } from "./makesafe_send_pack.ts";

/** The shape MLB itself writes, and the shape every PO-bearing live reference already uses. */
const PO_JOIN = "PO-";

/** A purchase-order number is a digit run this long or longer. Shorter tokens collide. */
export const MIN_PURCHASE_ORDER_DIGITS = 4;

/**
 * The purchase-order digits a canonical PO value contributes, or null.
 *
 * Accepts the stored `PO-56481` form and a bare `56481`. Deliberately rejects anything else,
 * including a claim reference: `external_ref_canonical` is frequently the CLAIM (`MLB-27093`), and
 * reading its digit run as a purchase order would compose the fabricated `MLB-27093PO-27093`.
 */
export function purchaseOrderDigits(rawPurchaseOrder: unknown): string | null {
  const value = String(rawPurchaseOrder ?? "").trim();
  if (!value) return null;
  const tagged = splitRefPo(value);
  if (tagged.po && tagged.po.length >= MIN_PURCHASE_ORDER_DIGITS) {
    return tagged.po;
  }
  return /^\d{4,}$/.test(value) ? value : null;
}

export interface ComposedInvoiceReference {
  reference: string;
  /** Why the reference has the grain it has — stamped on the proposal for later attribution. */
  grain:
    | "builder_reference_with_composed_po"
    | "builder_reference_already_carries_po"
    | "builder_reference_without_known_po";
  purchase_order: string | null;
}

/**
 * Compose the card's purchase order onto its builder reference for the minted invoice.
 *
 * Never changes the claim base, never overwrites a PO the reference already names, and never
 * fabricates one. `MLB-27093` + `PO-56481` -> `MLB-27093PO-56481`.
 */
export function composeInvoiceReferenceWithPo(
  builderReference: unknown,
  rawPurchaseOrder: unknown,
): ComposedInvoiceReference {
  const reference = String(builderReference ?? "").trim();
  if (!reference) {
    return {
      reference,
      grain: "builder_reference_without_known_po",
      purchase_order: null,
    };
  }
  const existing = splitRefPo(reference);
  if (existing.po) {
    return {
      reference,
      grain: "builder_reference_already_carries_po",
      purchase_order: existing.po,
    };
  }
  const digits = purchaseOrderDigits(rawPurchaseOrder);
  if (!digits) {
    return {
      reference,
      grain: "builder_reference_without_known_po",
      purchase_order: null,
    };
  }
  return {
    reference: `${reference}${PO_JOIN}${digits}`,
    grain: "builder_reference_with_composed_po",
    purchase_order: digits,
  };
}
