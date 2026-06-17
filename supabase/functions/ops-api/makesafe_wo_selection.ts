// ════════════════════════════════════════════════════════════
// MAKE-SAFE WO PDF SELECTION — deterministic work-order designation
// Mission: makesafe-wo-capture-recovery-2026-06-17 (GAP-A)
// ════════════════════════════════════════════════════════════
//
// WHY THIS MODULE EXISTS
// ----------------------
// scanSesMakesafes captures every status='uploaded' PDF attachment from the
// group-sync projection and pushes them all into attachments_json — in arbitrary
// DB order, undifferentiated. When an email carries multiple PDFs (e.g. a WO +
// an asbestos report + a site photo saved as PDF), two problems arise:
//   1. The WRONG PDF may be fed to Haiku first (order-dependent extraction).
//   2. Two PDFs whose filename tails collide under the shared key
//      makesafe-intake/<hash(msg.id)>/<safeName.slice(-80)> overwrite each other
//      because upsert:true makes the second upload silently win.
//
// FIX
// ---
// 1. scoreWorkOrder(name): pure filename heuristic. WO signal >> PO signal >> none.
//    A name containing BOTH "work order" and "PO" scores as WO (the real MLB WO
//    filename "work_order_MLB-25096PO-53582_...pdf" must win over a bare PO PDF).
// 2. selectWorkOrderPdf(atts): ranking — highest score, tiebreak largest, tiebreak
//    first. Returns the designated WO + the full list reordered WO-first.
// 3. attachmentKeyComponent(att): per-attachment unique token so every PDF in one
//    email gets a DISTINCT storage key. Uses att.id (UUID PK) if present, falls
//    back to att.graph_attachment_id (non-null on all group-sync rows), last resort
//    a short hash of name+size to handle hypothetical missing-ids edge cases.

// ── Public interface ─────────────────────────────────────────────────────────────

/** Minimal shape of an email_attachments row as used by this module. */
export interface WoAttachmentInput {
  id?: string | null;
  graph_attachment_id?: string | null;
  name?: string | null;
  content_type?: string | null;
  storage_path?: string | null;
  size_bytes?: number | null;
}

// ── scoreWorkOrder ────────────────────────────────────────────────────────────────

// Strong WO filename signals — case-insensitive (filenames vary in case).
const STRONG_WO_RE = /work[\s_-]*order|works[\s_-]*order|\bWO\b/i;

// Weak PO filename signals (less relevant than WO but still useful as tiebreaker
// when there is NO strong WO signal at all). We intentionally score PO weakly: the
// real MLB WO filename "work_order_MLB-25096PO-53582_...pdf" contains BOTH "work
// order" and "PO", so the work-order signal must dominate.
// Note: \bPO\b only works when PO is flanked by non-word chars (spaces/dots/hyphens).
// PO_53582.pdf has PO followed by _ which is a word char, so we also match PO
// followed by underscore or at start. Use a broad enough pattern:
// - "PO " or "PO-" or "PO_" or "PO." or at end = standalone PO reference.
// - "purchase order" phrase
const WEAK_PO_RE = /(?<![a-zA-Z])PO(?![a-zA-Z])|purchase[\s_-]*order/i;

/**
 * Score a PDF filename for "how likely is it to be the work order?"
 *
 * Returns:
 *   100  — strong WO signal (filename contains "work order" / "works order" / standalone "WO")
 *    10  — weak PO signal only (bare "PO_xxx.pdf" — may be a purchase order reference)
 *     0  — no signal
 *
 * IMPORTANT: a name with BOTH "work order" AND "PO" (e.g. MLB filenames) scores 100
 * (strong wins). Only a name with NO "work order" but WITH "PO" scores 10.
 */
export function scoreWorkOrder(name: string | null | undefined): number {
  const n = name || "";
  if (STRONG_WO_RE.test(n)) return 100;
  if (WEAK_PO_RE.test(n)) return 10;
  return 0;
}

// ── selectWorkOrderPdf ────────────────────────────────────────────────────────────

export interface WoSelectionResult {
  selected: WoAttachmentInput | null;
  ordered: WoAttachmentInput[];
}

/**
 * Designate the work-order PDF among a list of uploaded PDF attachments.
 *
 * Ranking priority:
 *   1. Highest scoreWorkOrder(name)
 *   2. Largest size_bytes (tiebreak)
 *   3. Original position in the input array (stable order tiebreak)
 *
 * For n=0: { selected: null, ordered: [] }.
 * For n=1: { selected: atts[0], ordered: [atts[0]] } — NO reordering side effects.
 * For n>1: the designated WO is placed first; the rest follow in their original
 *          relative order (stable).
 *
 * Caller is expected to pass only PDF rows (content_type includes 'pdf' or name
 * ends '.pdf'), but this function is defensive and processes whatever it receives.
 */
export function selectWorkOrderPdf(atts: WoAttachmentInput[]): WoSelectionResult {
  if (!atts || atts.length === 0) return { selected: null, ordered: [] };
  if (atts.length === 1) return { selected: atts[0], ordered: [atts[0]] };

  // Score each attachment, retaining its original index for stable tiebreaking.
  const scored = atts.map((att, idx) => ({
    att,
    score: scoreWorkOrder(att.name),
    size: att.size_bytes ?? -1,
    idx,
  }));

  // Sort: descending score -> descending size -> ascending original index.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.size !== a.size) return b.size - a.size;
    return a.idx - b.idx;
  });

  const selected = scored[0].att;

  // Reorder: WO first, then the rest in their original (stable) order.
  const rest = atts.filter((a) => a !== selected);
  const ordered = [selected, ...rest];

  return { selected, ordered };
}

// ── attachmentKeyComponent ───────────────────────────────────────────────────────

/**
 * Derive a short, Storage-safe, per-attachment unique token.
 *
 * Priority:
 *   1. att.id (UUID PK — strongest, always unique)
 *   2. att.graph_attachment_id (non-null on all group-sync rows)
 *   3. Fallback: base on name+size (for hypothetical completely-missing-ids cases)
 *
 * The token is derived by taking the raw value, stripping non-[a-zA-Z0-9] chars,
 * and slicing the LAST 16 characters. UUIDs end in a highly-entropic hex segment so
 * slicing the last 16 gives excellent collision resistance while keeping the key
 * short. Graph attachment ids also end in high-entropy segments.
 *
 * The result is appended to the hash(msg.id) prefix in the caller, producing:
 *   makesafe-intake/<hash(msg.id)>-<component>/<safeName>
 * Two different attachments in the same email always get different components.
 */
export function attachmentKeyComponent(att: WoAttachmentInput): string {
  const raw = att.id || att.graph_attachment_id;
  if (raw) {
    return raw.replace(/[^a-zA-Z0-9]/g, "").slice(-16);
  }
  // Fallback: combine name + size into a simple hash-like token.
  const fallbackRaw = `${att.name || ""}:${att.size_bytes ?? 0}`;
  let h = 0;
  for (let i = 0; i < fallbackRaw.length; i++) {
    h = (Math.imul(31, h) + fallbackRaw.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).padStart(8, "0");
}
