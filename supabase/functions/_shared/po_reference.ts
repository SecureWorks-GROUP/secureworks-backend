// ════════════════════════════════════════════════════════════
// OUTBOUND PO REFERENCE DISCIPLINE — SINGLE SOURCE OF TRUTH
// Mission: profit-materials-actuals-2026-07-03 · U2 (reference discipline)
// ════════════════════════════════════════════════════════════
//
// Every dollar a supplier bills must land on a job. Today it cannot: the U1
// measurement (2026-07-05) found only 2 of 359 ACCPAY bills in 60 days carry a
// reference the inbound bill-linker can catch, so per-job materials cost is
// fiction. The fix is discipline at the OUTBOUND edge — every PO we send carries
// the canonical job number AND asks the supplier to quote it back on their
// invoice, so the inbound linker (xero-sync) has something deterministic to match.
//
// This module is the ONE canonical implementation of PO reference discipline:
//   - canonicalJobRef()        coerce any stored PO reference to the exact
//                              SW[PFD]-##### form the bill-linker recognises
//   - isCanonicalJobRef()      predicate for the same
//   - quoteBackInstruction()   the plain-text "please quote X on your invoice" ask
//   - poEmailReferenceBanner() the HTML banner injected at the TOP of the Resend
//                              PO email body (send-po-email)
//   - poDeliveryInstruction()  the Xero PurchaseOrder.DeliveryInstructions string —
//                              the free-text field that carries the ask onto Xero's
//                              own PO PDF/email, which we cannot otherwise template
//
// BOTH outbound PO channels import from here so the reference and the phrasing can
// NEVER drift between them:
//   - ops-api/pushPOToXero  → Xero /PurchaseOrders (Reference + DeliveryInstructions)
//   - send-po-email         → Resend supplier email (body banner + footer)
// There is deliberately NO local copy of this logic in either caller (mirrors the
// makesafe_refs.ts single-source doctrine).
//
// PROVEN (U1 §3, 2026-07-05) against BOTH live bill-linking regexes:
//   xero-sync/index.ts:486   /SWMS-\d{4,5}|SW[A-Z]?-?\d{3,5}/i   (primary linker)
//   xero-sync/index.ts:743   /SW[PFDRIM]-\d{5}/i                 (reconcile pass)
// The canonical form SWF-25010 (division letter + hyphen + 5 digits), with an
// optional multi-order suffix SWF-25010-01, passes BOTH. Bare SW-25010,
// hyphenless SWF25010, and (for a materials order) SWMS-##### do NOT pass both, so
// this module never EMITS them for a materials PO — it recovers the canonical form
// from the job number instead.
//
// Pure + dependency-free (no supabase-js, no Deno APIs) so it unit-tests directly.

// A fully-canonical outbound ref: division letter + hyphen + 5 digits, with an
// optional multi-order / per-run suffix (-01, -PO1, -REAR-A, ...). SWMS is accepted
// too so a make-safe PO pushed through the same generic code path keeps its own
// valid ref rather than being mangled.
const CANONICAL_REF = /^SW(?:MS-\d{4,5}|[PFDRIM]-\d{5})(?:-[A-Za-z0-9]+)*$/i;

// The same canonical token embedded anywhere in a longer string
// ("Job SWF-25010 Bunnings order", "PO-SWF-25010").
const EMBEDDED_REF = /SW(?:MS-\d{4,5}|[PFDRIM]-\d{5})(?:-[A-Za-z0-9]+)*/i;

/**
 * Coerce a raw stored PO reference to the canonical outbound job reference.
 *
 * Preference order:
 *   1. the reference is already fully canonical  → return it verbatim (keeps any
 *      -nn multi-order suffix), upper-cased.
 *   2. the reference EMBEDS a canonical token    → return just that token.
 *   3. the reference is non-canonical (bare SW-#####, hyphenless SWF25010, empty)
 *      → recover from the authoritative job_number instead.
 *   4. nothing canonical anywhere                → return the best raw value we had
 *      (never INVENT a ref; a wrong ref is worse than none — see recovery path).
 *
 * @param rawRef     purchase_orders.reference (what the scoping tool stamped)
 * @param jobNumber  jobs.job_number (authoritative canonical ref) — the fallback
 */
export function canonicalJobRef(
  rawRef: string | null | undefined,
  jobNumber?: string | null,
): string {
  const clean = (s: unknown) => String(s ?? "").trim();
  const ref = clean(rawRef);
  const job = clean(jobNumber);

  if (CANONICAL_REF.test(ref)) return ref.toUpperCase();
  const embedded = ref.match(EMBEDDED_REF);
  if (embedded) return embedded[0].toUpperCase();

  if (CANONICAL_REF.test(job)) return job.toUpperCase();
  const jobEmbedded = job.match(EMBEDDED_REF);
  if (jobEmbedded) return jobEmbedded[0].toUpperCase();

  // Last resort: whatever we had. Callers treat a non-canonical return as a
  // reference-discipline WARNING (the supplier can still quote it, but the
  // inbound linker may not auto-catch it → it lands in the reconciliation queue).
  return ref || job;
}

/** True when `ref` is already the exact canonical outbound form. */
export function isCanonicalJobRef(ref: string | null | undefined): boolean {
  return CANONICAL_REF.test(String(ref ?? "").trim());
}

/**
 * The single canonical quote-back ask. This exact sentence is what a supplier is
 * asked to honour, so it must read the same on the Xero PO PDF and the Resend
 * email. No em dashes (outbound-comms rule).
 */
export function quoteBackInstruction(ref: string): string {
  return `Please quote ${String(ref ?? "").trim()} on your invoice so we can match your payment to this job.`;
}

/** Minimal HTML escape — the ref is alnum+hyphen, this is defence-in-depth. */
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The reference banner injected at the TOP of the Resend PO email body
 * (send-po-email). Prominent by construction: brand-orange border, the job ref in
 * 20px bold, then the quote-back ask. Brand palette per house style
 * (#F15A29 orange, #293C46 dark blue, #4C6A7C mid blue).
 */
export function poEmailReferenceBanner(ref: string): string {
  const r = escapeHtml(String(ref ?? "").trim());
  const ask = escapeHtml(quoteBackInstruction(ref));
  return `<div style="border:2px solid #F15A29;background:#FFF4EF;border-radius:6px;padding:12px 16px;margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;">
  <div style="font-size:12px;color:#293C46;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px;">Job reference</div>
  <div style="font-size:20px;font-weight:bold;color:#293C46;margin-bottom:4px;letter-spacing:0.5px;">${r}</div>
  <div style="font-size:13px;color:#4C6A7C;">${ask}</div>
</div>`;
}

/**
 * The Xero PurchaseOrder.DeliveryInstructions string.
 *
 * WHY this field: Xero's PO email is sent by Xero from a template we cannot edit
 * via the API; the only levers that render on the standard Xero PO PDF are the
 * Reference header and this free-text DeliveryInstructions block. It is a
 * TOP-LEVEL string field, so setting it can never cause the /PurchaseOrders PUT to
 * be rejected — unlike injecting a description-only line item, which risks failing
 * the whole push. Any real delivery note already captured is preserved ahead of
 * the ask. (Moving the ask into a line-item row is a follow-up to validate once
 * CP3's live push confirms Xero accepts description-only PO lines.)
 */
export function poDeliveryInstruction(ref: string, existing?: string | null): string {
  const ask = quoteBackInstruction(ref);
  const note = String(existing ?? "").trim();
  return note ? `${note}\n${ask}` : ask;
}

// ── PO delivery address encoding ─────────────────────────────────────────────
// purchase_orders has NO delivery_address column: the address is encoded into
// the free-text `notes` field as a leading 'Deliver to: <address>' line. The
// writer (createPO) and every reader (trade app pickup/delivery badge) MUST use
// the pair below, so the prefix can never drift between the two sides — a drift
// silently reads every PO as a pickup.

const DELIVER_TO_PREFIX = "Deliver to: ";

/** Encode an optional delivery address + free notes into the stored notes field. */
export function formatPoDeliveryNotes(
  deliveryAddress: string | null | undefined,
  notes: string | null | undefined,
): string | null {
  const addr = String(deliveryAddress ?? "").trim();
  const rest = String(notes ?? "").trim();
  if (!addr) return rest || null;
  return rest ? `${DELIVER_TO_PREFIX}${addr}\n${rest}` : `${DELIVER_TO_PREFIX}${addr}`;
}

/** Recover the delivery address from stored notes. Null when it is a pickup. */
export function parsePoDeliveryAddress(notes: string | null | undefined): string | null {
  const match = String(notes ?? "").match(/^[ \t]*Deliver to:[ \t]*(.+)$/im);
  const addr = match?.[1]?.trim();
  return addr ? addr : null;
}

/** True when the PO is collected rather than delivered. */
export function isPoPickup(notes: string | null | undefined): boolean {
  const raw = String(notes ?? "");
  return raw.toUpperCase().includes("PICKUP") || !parsePoDeliveryAddress(raw);
}
