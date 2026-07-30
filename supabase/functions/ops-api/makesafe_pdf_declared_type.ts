// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — WO PDF DECLARED-TYPE HEADER READER (Track A, D2)
// ════════════════════════════════════════════════════════════
//
// Captain Ruling 5 (sealed 2026-07-30): the work-order PDF carries an internal
// header section — under "Allocation Work Order" and the WO/PO number, above the
// appointment/site/customer details — that explicitly states the deliverable
// type. That section is the TOP family-classification authority (charter S1a);
// it usually decides the case on its own and beats scope/draft/body inference
// wherever they disagree. The free-text Notes field is generic per-WO context
// and is never family evidence; nothing below reads it.
//
// Real text-layer shape (verified against persisted `work_order_pdf_text` of
// live MLB work orders, 2026-07-30):
//
//   Work Order
//   Work Order Assigned <company> Work Order Number <WO><PO>
//   … contact/detail lines …
//   Allocation Work Order
//   <site-contact line>
//   Makesafe/Emergency Repairs        <- the declared-type line
//   Make Safe                         <- sub-line
//   <scope text …>
//
// Observed declared-type values: "Makesafe/Emergency Repairs" (+ "Make Safe"),
// "Roof Reports" (+ "EXTERNAL"), "Assessment Report & Quote" (+ "INTERNAL"),
// "Temporary Fencing" + "Make Safe", "Restoration" + "Make Safe"
// (MLB-27093, Ruling 9: the restoration label corroborates only — the type is
// make safe), and "Scaffolding/Access Equipment" (MLB-25147 PO-56236,
// Ruling 8: its own repair deliverable).
//
// SAFETY POSTURE. Label-anchored and standalone-line only: a declared-type
// token must be its own header line, so scope sentences that merely mention
// "roof report" can never fire it. Zero or conflicting matches abstain (null),
// and the classifier ladder falls through to the scope-based signals — the
// unsure lane is never force-classified.

export type PdfDeclaredType = "assessment" | "roof" | "makesafe" | "repair";

export interface PdfDeclaredTypeResult {
  /** The family the header declares, or null when no unambiguous header line. */
  declaredType: PdfDeclaredType | null;
  /** True when the makesafe declaration is the temporary-fencing allocation. */
  fenceSubtype: boolean;
  /**
   * True when a standalone "Restoration" label rides next to the type line.
   * Ruling 9: it corroborates only and never moves the family; Ruling 15 keeps
   * the restoration recipe unsealed, so a restoration label ALONE yields null.
   */
  restorationLabel: boolean;
  /** The verbatim header line the type was read from (evidence trail). */
  headerLine: string | null;
  /** True when the "Allocation Work Order" anchor line was found. */
  anchored: boolean;
}

const ANCHOR_RE = /^allocation\s+work\s+order$/i;
// Detail labels that mark the end of the header block when scanning unanchored.
const HEADER_STOP_RE =
  /^(?:appointment|site\s+contact|customer|policy\s*holders?|insured|site\s+address|risk\s+address|work\s+order\s+terms|notes?\s*:)/i;

interface TypeLinePattern {
  re: RegExp;
  type: PdfDeclaredType;
  fence?: boolean;
}

// Standalone-line declared-type values. Order matters only for documentation;
// each line is tested against every pattern and multi-type headers abstain.
const TYPE_LINES: readonly TypeLinePattern[] = [
  { re: /^makesafe\s*\/\s*emergency\s+repairs?$/i, type: "makesafe" },
  { re: /^roof\s+reports?(?:\s+external)?$/i, type: "roof" },
  {
    re: /^assessment\s+report\s*(?:&|and)\s*quote(?:\s+internal)?$/i,
    type: "assessment",
  },
  {
    re: /^temporary\s+fencing(?:\s+make\s*-?\s*safe)?$/i,
    type: "makesafe",
    fence: true,
  },
  {
    re: /^scaffolding\s*\/?\s*access\s+equipment(?:\s+external)?$/i,
    type: "repair",
  },
] as const;

// The bare sub-line "Make Safe" is only decisive when it follows the anchor and
// no richer type line was found (older/compact layouts). It must never match
// scope text, so it stays standalone-line and header-region bounded.
const BARE_MAKE_SAFE_RE = /^make\s*-?\s*safe$/i;
const RESTORATION_LABEL_RE = /^restoration$/i;

const HEADER_SCAN_LINES = 25;
const POST_ANCHOR_SCAN_LINES = 6;

function cleanLines(text: string | null | undefined): string[] {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Read the declared-type header line from recovered WO PDF text. Deterministic
 * and abstaining: no anchor and no standalone type line in the header region
 * returns declaredType null so the caller falls back to scope evidence.
 */
export function extractPdfDeclaredType(
  text: string | null | undefined,
): PdfDeclaredTypeResult {
  const empty: PdfDeclaredTypeResult = {
    declaredType: null,
    fenceSubtype: false,
    restorationLabel: false,
    headerLine: null,
    anchored: false,
  };
  const lines = cleanLines(text);
  if (!lines.length) return empty;

  const anchorIndex = lines.findIndex((line) => ANCHOR_RE.test(line));
  const anchored = anchorIndex >= 0;
  const start = anchored ? anchorIndex + 1 : 0;
  const end = anchored
    ? Math.min(lines.length, start + POST_ANCHOR_SCAN_LINES)
    : Math.min(lines.length, HEADER_SCAN_LINES);

  const matches: Array<{ pattern: TypeLinePattern; line: string }> = [];
  let restorationLabel = false;
  let bareMakeSafeLine: string | null = null;
  for (let index = start; index < end; index++) {
    const line = lines[index];
    if (!anchored && HEADER_STOP_RE.test(line)) break;
    if (RESTORATION_LABEL_RE.test(line)) {
      restorationLabel = true;
      continue;
    }
    if (anchored && bareMakeSafeLine === null && BARE_MAKE_SAFE_RE.test(line)) {
      bareMakeSafeLine = line;
      continue;
    }
    for (const pattern of TYPE_LINES) {
      if (pattern.re.test(line)) {
        matches.push({ pattern, line });
        break;
      }
    }
  }

  const distinctTypes = new Set(matches.map((match) => match.pattern.type));
  if (distinctTypes.size > 1) {
    // Conflicting declared types in one header can only be a parse artefact;
    // abstain rather than guess (standing rule: never force-classify).
    return { ...empty, anchored, restorationLabel };
  }
  const selected = matches[0] || null;
  if (selected) {
    return {
      declaredType: selected.pattern.type,
      fenceSubtype: Boolean(selected.pattern.fence),
      restorationLabel,
      headerLine: selected.line,
      anchored,
    };
  }
  // Anchored bare "Make Safe" (incl. a "Restoration" + "Make Safe" pair —
  // Ruling 9: the scope/type is make safe, the restoration label corroborates).
  if (anchored && bareMakeSafeLine !== null) {
    return {
      declaredType: "makesafe",
      fenceSubtype: false,
      restorationLabel,
      headerLine: bareMakeSafeLine,
      anchored,
    };
  }
  return { ...empty, anchored, restorationLabel };
}
