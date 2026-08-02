/**
 * The storey a builder ORDERED, read off the work-order instruction at intake.
 *
 * Why this exists. A roof report's fee is a fixed function of storeys - single
 * $250 ex, double $350 ex - and the canon is explicit that storeys are
 * "explicitly classified, never inferred from narrative". U4 honours that: with
 * no storey fact it refuses with `pricing_evidence_missing` rather than guess.
 *
 * But U4 can only read a storey from a structured record fact or from OUR own
 * roof report draft, and an `ordinary_roof_portal` card is filled in on the
 * BUILDER's Prime form, so it never has one of our drafts. Measured 2026-08-02:
 * zero of 61 roof-report cards on the record had a roof draft, and only two
 * carried a structured storey fact - while 49 of 61 named the storey in the
 * builder's own instruction text, which nothing read.
 *
 * So the fact was ours all along and we were refusing work on it. The fix is to
 * read it ONCE, at intake, off the ordered product, and record it as a
 * structured fact - NOT to regex free text at pricing time, which is exactly
 * what the canon forbids and what this module exists to avoid.
 *
 * THE MATCH IS DELIBERATELY NARROW. It only reads a storey that directly
 * qualifies the roof product the family classifier already matched: "single
 * storey roof report", "two storey roof inspection". It will NOT read a storey
 * from anywhere else in the prose. That is not fussiness - live work orders
 * contain phrases like "request for single storey property" describing the
 * building rather than the product ordered, and a looser match would price off
 * the wrong sentence. Widening this pattern re-introduces narrative inference
 * on the money path; do not widen it to "make more cards work".
 */

/** The sealed schedule prices these two and only these two. */
export type MakesafeRoofStorey = "single" | "double";

export type MakesafeRoofStoreyFact =
  | { storeys: MakesafeRoofStorey; matched: string }
  | { refused: MakesafeRoofStoreyRefusal; matched: string }
  | null;

export type MakesafeRoofStoreyRefusal =
  /**
   * Three or more storeys. `roof_report_template.ts` prices single and double
   * only and says access or scope beyond a plain double storey is "scaled
   * manually on the docket at release". Rounding a three-storey job down to the
   * double rate would be precisely the money error the never-infer rule exists
   * to prevent, so this refuses and the card keeps blocking for a human price.
   */
  | "storeys_above_double_have_no_sealed_price"
  /** The instruction names more than one distinct storey for the product. */
  | "conflicting_storey_counts";

/**
 * The roof products the family classifier treats as an ordered roof report.
 * Kept deliberately in step with the roof branch of `decideMakeSafeJobFamily`
 * (`makesafe_intake_gate.ts`) and the roof arm of
 * `inferMakesafeFamilyForActiveBackfill` (`index.ts`), which already match
 * exactly these phrasings - including the two that spell the storey out.
 */
/**
 * Inter-word gap that CANNOT cross a line break. Callers hand this matcher
 * several instruction fields joined with newlines, and `\s` matches a newline -
 * so a plain `\s+` lets the end of one field fuse with the start of the next and
 * form a phrase neither field contains ("...the dwelling is single storey" +
 * "Roof report required" would read as an ordered single storey roof report).
 * That is the property-descriptor trap re-opened across a field boundary, so the
 * gap is deliberately newline-free: an ordered product is a phrase, not a
 * paragraph.
 */
const GAP = String.raw`[^\S\r\n]+`;

const ROOF_PRODUCT = String
  .raw`roof${GAP}(?:report|inspection(?:${GAP}report)?|assessment${GAP}report)`;

const STOREY_WORD = String.raw`stor(?:ey|ies|y)`;

/** single | one -> single storey. */
const SINGLE_QUALIFIER = String.raw`single|one|1`;
/** double | two -> double storey. */
const DOUBLE_QUALIFIER = String.raw`double|two|2`;
/** Anything at or above three has no sealed price and must refuse, not round. */
const ABOVE_DOUBLE_QUALIFIER = String.raw`three|third|triple|3|four|4|multi`;

/**
 * `<qualifier> storey <roof product>` and nothing else. The qualifier must sit
 * immediately before the storey word, and the storey word immediately before
 * the ordered product, so a storey describing the building rather than the
 * product can never match.
 */
function orderedProductPattern(qualifier: string): RegExp {
  return new RegExp(
    String
      .raw`\b(?:${qualifier})(?:${GAP}|-)+${STOREY_WORD}${GAP}${ROOF_PRODUCT}`,
    "i",
  );
}

const SINGLE_RE = orderedProductPattern(SINGLE_QUALIFIER);
const DOUBLE_RE = orderedProductPattern(DOUBLE_QUALIFIER);
const ABOVE_DOUBLE_RE = orderedProductPattern(ABOVE_DOUBLE_QUALIFIER);

/**
 * Read the ordered storey off a work-order instruction.
 *
 * Returns `null` when the instruction does not name a storey against the roof
 * product. `null` is the correct, expected answer for a large share of cards
 * and MUST leave the card blocking on `pricing_evidence_missing` - it is a
 * genuine fact gap, not something to fill in.
 */
export function roofStoreyOrderedProductFact(
  text: string | null | undefined,
): MakesafeRoofStoreyFact {
  const haystack = String(text || "");
  if (!haystack.trim()) return null;

  const above = ABOVE_DOUBLE_RE.exec(haystack);
  const single = SINGLE_RE.exec(haystack);
  const double = DOUBLE_RE.exec(haystack);

  const hits = [above, single, double].filter((hit) => hit !== null).length;
  if (hits > 1) {
    return {
      refused: "conflicting_storey_counts",
      matched: [above?.[0], single?.[0], double?.[0]]
        .filter(Boolean).join(" | "),
    };
  }

  // Checked before single/double so "three storey" can never be read as a
  // qualifier that merely contains a digit or a shorter word.
  if (above) {
    return {
      refused: "storeys_above_double_have_no_sealed_price",
      matched: above[0],
    };
  }
  if (single) return { storeys: "single", matched: single[0] };
  if (double) return { storeys: "double", matched: double[0] };
  return null;
}

/**
 * The structured fact to merge onto `jobs.metadata` at intake, or `null` when
 * there is nothing provable to record.
 *
 * The key is `storeys` because that is the alias U4's `structuredSourceFact`
 * already resolves against `jobs.metadata` - this deliberately adds a value to
 * a source U4 reads today rather than teaching U4 a new place to look.
 *
 * A refusal records NOTHING. An unpriceable or conflicting instruction must
 * leave the card exactly as blocked as an instruction that said nothing at all.
 */
export function roofStoreyIntakeMetadata(
  text: string | null | undefined,
): { storeys: MakesafeRoofStorey } | null {
  const fact = roofStoreyOrderedProductFact(text);
  return fact && "storeys" in fact ? { storeys: fact.storeys } : null;
}
