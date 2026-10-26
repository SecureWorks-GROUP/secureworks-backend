// Dispatch: client sign-off on the list, and the "ready to raise the final
// invoice" mark (DSP-11 follow-on, W2, 20 Oct 2026).
//
// Everything here is pure. `pipeline` (dispatch=1) owns the read through
// loadClientSignoffByJob (trade_client_signoff.ts), the one sign-off rule.
// While trade_invoice_requires_client_signoff_v1 is off (or unreadable) it
// reads only that flag: no settings and no sign-off rows. This module only
// says what a card shows.
//
// Read only. Nothing here sends, books, chases or writes. The mark says the
// office may raise the final invoice now; the office raises it as today, and
// every chase send stays held (Marnin's rule: sign-off starts the chase,
// payment is never the gate; the chase itself is not switched on here).
//
// Four questions stay apart: work complete (completion evidence), client
// signed off (this), final invoice raised (the card's has_final_invoice),
// customer paid (final_paid). Payment is never an input to the mark.

import type { ClientSignoff } from "./trade_client_signoff.ts";

export type DispatchSignoffState =
  | "signed_off"
  | "waived"
  | "not_signed"
  | "not_happy"
  | "unknown";

export type DispatchSignoffFields = {
  client_signoff: {
    state: DispatchSignoffState;
    method: string | null;
    signed_at: string | null;
  };
  /** True: signed off (or waived), and no final invoice is raised yet.
   *  Null when either answer is unknown (a failed read), never false. */
  final_invoice_ready: boolean | null;
};

export function dispatchSignoffState(ev: ClientSignoff): DispatchSignoffState {
  if (ev.read_failed || ev.missing === "evidence_unavailable") return "unknown";
  if (ev.missing === "not_signed") return "not_signed";
  if (ev.missing === "client_not_happy" || ev.missing === "rating_below_threshold") {
    return "not_happy";
  }
  return ev.current?.method === "office_waiver" ? "waived" : "signed_off";
}

/**
 * The sign-off fields for one Dispatch card. Empty (no keys) when the job is
 * outside the sign-off rule (another job type, or completed before
 * applies_from) or the read returned nothing for it.
 *
 * `finalInvoiceRaised`: a final sales invoice on the job that is not a
 * DRAFT (a DRAFT still waits on the office's approval, so the job stays
 * ready to raise); null when the invoice read failed. It is not the card's
 * has_final_invoice, which counts a DRAFT.
 */
export function dispatchSignoffFields(
  ev: ClientSignoff | undefined,
  finalInvoiceRaised: boolean | null,
): DispatchSignoffFields | Record<string, never> {
  if (!ev || !ev.applies) return {};
  const state = dispatchSignoffState(ev);
  const signedOff = state === "signed_off" || state === "waived";
  let ready: boolean | null;
  if (state === "unknown") ready = null;
  else if (!signedOff) ready = false;
  else if (finalInvoiceRaised === null) ready = null;
  else ready = !finalInvoiceRaised;
  return {
    client_signoff: {
      state,
      method: ev.current?.method ?? null,
      signed_at: ev.current?.created_at ?? null,
    },
    final_invoice_ready: ready,
  };
}

/** The list's top-level answer for the sign-off read. */
export type DispatchSignoffRead = "off" | "ok" | "failed";
