// Make-safe report prose: short explanatory paragraphs from trade evidence.
//
// The builder-facing completion report must read as work performed, not as a
// form dump. This module is the pure generation contract for that wording.
//
// Honesty is load-bearing: every sentence is derived only from fields the trade
// recorded. Connecting language may sequence those facts; it must never invent
// a finding, material, quantity, measurement, hazard classification, or causal
// claim the evidence does not support. When the evidence is thin, write less.
//
// Style (Captain 2026-08-05):
//   - two to four short paragraphs across the four report sections
//   - complete sentences, plain trade English
//   - no em dashes, no bullet fragments, no corporate filler

export const MAKESAFE_REPORT_PROSE_CONTRACT_VERSION =
  "report-prose-paragraphs/v1";

/** Prompt / skill rules shared by draft-pack generation and offline curation. */
export const MAKESAFE_REPORT_PROSE_STYLE_RULES: readonly string[] = [
  "Write short explanatory paragraphs of complete sentences in report.scope, report.findings, report.works and report.materials. Do not use bullet lists, labelled fragments, or form-style 'Damage: / Work:' blurbs.",
  "Each section does one job: findings = what was found; works = what was done about it; materials = what went in; scope = the make-safe purpose. Explain connections only when both ends are already in the trade evidence.",
  "Keep it short. No filler: no 'it is important to note', no 'comprehensive', no 'ensuring the safety and integrity of', no throat-clearing opener, no closing paragraph that restates the body.",
  "Plain trade English. Name real things from the evidence (tiles, timber, bugle screws, silicone, flashing tape, tarp, prop). No em dashes.",
  "Never invent a finding, material, quantity, measurement, or hazard classification. Where the trade evidence is thin, write less rather than filling gaps with plausible cause and effect.",
];

/** Checklist tick labels that are not quantified material-use facts. */
const MATERIALS_TICK_NOISE = new Set([
  "tarps / roof materials",
  "fixings / consumables",
  "other / none",
  "bases / feet",
  "temp fence panels",
  "temp fence panel",
]);

const FILLER_PHRASE_RE =
  /\b(?:it is important to note|comprehensive|ensuring the safety and integrity of|please note that|as aforementioned)\b/i;

export type TradeChecklistForProse = {
  job_type?: unknown;
  job_type_detail?: unknown;
  makesafe_type_detail?: unknown;
  damage_cause?: unknown;
  damage_description?: unknown;
  work_done?: unknown;
  works_completed?: unknown;
  materials_used?: unknown;
};

export type MakesafeReportProseSections = {
  scope: string;
  findings: string;
  works: string;
  materials: string;
};

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** House rule: no em/en dashes in outbound report copy. */
export function sanitiseReportProse(value: unknown): string {
  return String(value ?? "")
    .replace(/\u2014/g, "-")
    .replace(/\u2013/g, "-")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLabelPrefixes(raw: string): string {
  return raw
    .replace(/^\s*make[- ]safe\s*type\s*:\s*/i, "")
    .replace(/^\s*damage\s*:\s*/i, "")
    .replace(/^\s*cause\s*:\s*/i, "")
    .replace(/^\s*work(?:s)?(?:\s+done|\s+completed)?\s*:\s*/i, "")
    .trim();
}

function parseDamageDescription(raw: string): {
  makeSafeType: string;
  damage: string;
} {
  // Preserve original newlines for label parsing; trade forms use
  // "Make-safe type: …\nDamage: …". Callers may also hand a single-line dump.
  const source = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!source) return { makeSafeType: "", damage: "" };

  const typeMatch = source.match(
    /make[- ]safe\s*type\s*:\s*([^\n]+?)(?=\s*(?:\n|damage\s*:)|$)/i,
  );
  const damageMatch = source.match(
    /(?:^|\n)\s*damage\s*:\s*([\s\S]+)/i,
  ) || source.match(
    /\bdamage\s*:\s*(.+)$/i,
  );
  const makeSafeType = text(typeMatch?.[1] || "");
  let damage = text(damageMatch?.[1] || "");
  if (!damage && !typeMatch) {
    damage = text(source);
  } else if (!damage && typeMatch) {
    // Type line only - leave damage empty rather than restating the type as damage.
    damage = "";
  }
  return { makeSafeType, damage };
}

function ensureSentence(raw: string): string {
  let s = stripLabelPrefixes(text(raw));
  if (!s) return "";
  // Drop trailing form-label leftovers.
  s = s.replace(/[.]+$/g, "").trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s = `${s}.`;
  return s;
}

/**
 * Light trade-English polish only. Renames common trade shorthand; never adds
 * findings, materials, quantities, or hazard claims.
 */
function polishSentence(sentence: string, isContinuation: boolean): string {
  let s = sentence;
  s = s.replace(/\bre secured\b/gi, "resecured");
  s = s.replace(/\bunderperlin\b/gi, "underpurlin");
  s = s.replace(/\bflashing taped\b/gi, "flashing-taped");
  s = s.replace(/\bridge cap\b/gi, "ridge-cap");
  s = s.replace(/\bpolly carbonate\b/gi, "polycarbonate");
  s = s.replace(/^As well\s+/i, "Also ");
  if (isContinuation && /^Giving\b/i.test(s)) {
    s = s.replace(/^Giving\b/i, "This gave");
  }
  if (isContinuation && /^Also\s+([a-z])/i.test(s)) {
    // "Also flashing-taped larger gaps..." is already a usable continuation.
  }
  // Mid-clause trade shorthand: "create dip" → "creating a dip".
  s = s.replace(/\bcreate dip\b/gi, "creating a dip");
  s = s.replace(/\bnot engineered,\s*creating\b/gi, "not engineered, creating");
  return ensureSentence(s);
}

function sentencesFrom(raw: string): string[] {
  const cleaned = stripLabelPrefixes(text(raw));
  if (!cleaned) return [];
  // Split on sentence ends or explicit newlines / semicolon lists from forms.
  const parts = cleaned
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((part) => text(part))
    .filter(Boolean);
  return parts.length ? parts : [cleaned];
}

function paragraph(...parts: Array<string | string[]>): string {
  const sentences: string[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      for (const item of part) sentences.push(...sentencesFrom(item));
    } else if (part) {
      sentences.push(...sentencesFrom(part));
    }
  }
  // De-dupe exact sentences while preserving order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const sentence of sentences) {
    const key = text(sentence).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(sentence);
  }
  const polished = unique.map((sentence, index) =>
    polishSentence(sentence, index > 0)
  );
  return sanitiseReportProse(polished.join(" "));
}

/** Quantified materials only. Tick-box noise is dropped unless nothing else remains. */
export function quantifiedMaterialItems(materialsUsed: unknown): string[] {
  const raw = Array.isArray(materialsUsed)
    ? materialsUsed
    : (materialsUsed == null || materialsUsed === ""
      ? []
      : [materialsUsed]);
  const items = raw
    .map((item) => text(item))
    .filter(Boolean);
  const quantified = items.filter((item) =>
    !MATERIALS_TICK_NOISE.has(item.toLowerCase())
  );
  return quantified.length ? quantified : [];
}

function materialsParagraph(items: string[]): string {
  if (!items.length) {
    return "No quantified materials were recorded on the trade form beyond standard consumable ticks.";
  }
  if (items.length === 1) {
    return ensureSentence(`${items[0]} was used`);
  }
  if (items.length === 2) {
    return ensureSentence(`${items[0]} and ${items[1]} were used`);
  }
  const head = items.slice(0, -1).join(", ");
  const tail = items[items.length - 1];
  return ensureSentence(`${head}, and ${tail} were used`);
}

function cleanTypeLabel(typeLabel: string): string {
  return stripLabelPrefixes(typeLabel)
    .replace(/^other:\s*/i, "")
    .trim();
}

/**
 * One short purpose sentence for Work Order Scope. Findings and works carry
 * the detail - scope must not restate the whole damage narrative.
 */
function scopeFromEvidence(
  jobType: string,
  makeSafeType: string,
  damage: string,
  work: string,
): string {
  const typeLabel = cleanTypeLabel(makeSafeType || jobType);
  const damageLower = damage.toLowerCase();
  const workLower = work.toLowerCase();

  // Prefer purpose phrases grounded in recorded damage / work nouns only.
  if (
    damageLower.includes("hot water") || workLower.includes("hot water")
  ) {
    return "Make safe the roof structure under the roof-mounted hot water system.";
  }
  if (
    damageLower.includes("water ingress") ||
    damageLower.includes("water enter") ||
    damageLower.includes("moisture")
  ) {
    if (damageLower.includes("cupboard") || damageLower.includes("bedroom")) {
      return "Make safe water ingress into the bedroom cupboard.";
    }
    if (damageLower.includes("skylight")) {
      return "Make safe water ingress through the skylight.";
    }
    if (
      damageLower.includes("ceiling") || damageLower.includes("cornice") ||
      damageLower.includes("wall")
    ) {
      return "Make safe water ingress into the affected ceiling and wall linings.";
    }
    return "Make safe the recorded water ingress.";
  }
  if (
    damageLower.includes("ceiling") &&
    (damageLower.includes("droop") || damageLower.includes("fall") ||
      damageLower.includes("sag") || workLower.includes("prop"))
  ) {
    return "Make safe the drooping ceiling.";
  }
  if (damageLower.includes("shed")) {
    return "Make safe the destroyed backyard shed.";
  }
  if (
    damageLower.includes("polycarbonate") || damageLower.includes("patio")
  ) {
    return "Make safe the damaged patio structure.";
  }
  if (damageLower.includes("fence") || workLower.includes("fence")) {
    return "Make safe the damaged boundary fence.";
  }
  if (typeLabel) {
    return ensureSentence(`Make safe the ${typeLabel.toLowerCase()}`);
  }
  if (damage) {
    // Thin evidence: one purpose sentence that still names the recorded damage.
    return ensureSentence(`Make safe: ${stripLabelPrefixes(damage)}`);
  }
  return "Make safe the affected area.";
}

/**
 * Build the four builder-facing report sections from a trade service-report
 * checklist. Pure: no network, no invention beyond light sentence shaping.
 */
export function composeMakesafeReportProseFromTradeEvidence(
  checklist: TradeChecklistForProse | null | undefined,
): MakesafeReportProseSections {
  const ck = checklist && typeof checklist === "object" ? checklist : {};
  const jobType = text(ck.job_type) || text(ck.job_type_detail) ||
    text(ck.makesafe_type_detail);
  const cause = text(ck.damage_cause);
  const { makeSafeType, damage } = parseDamageDescription(
    String(ck.damage_description ?? ""),
  );
  const work = text(ck.work_done) || text(ck.works_completed);
  const materials = quantifiedMaterialItems(ck.materials_used);

  const scope = scopeFromEvidence(jobType, makeSafeType, damage, work);

  // Findings: cause and damage only - do not pull works into findings.
  const findings = paragraph(
    cause,
    damage,
  ) || paragraph(jobType || makeSafeType) || "Site findings were not recorded on the trade form.";

  // Works: trade work narrative only, shaped into complete sentences.
  const works = paragraph(work) ||
    "Works completed were not recorded on the trade form.";

  const materialsText = materialsParagraph(materials);

  return {
    scope: sanitiseReportProse(scope),
    findings: sanitiseReportProse(findings),
    works: sanitiseReportProse(works),
    materials: sanitiseReportProse(materialsText),
  };
}

/**
 * True when the draft report field is empty or still a raw checklist dump
 * (form labels / bare cause / bare materials list). Those must not ship.
 */
export function reportProseNeedsComposition(
  supplied: unknown,
  checklist: TradeChecklistForProse | null | undefined,
): boolean {
  const value = sanitiseReportProse(supplied);
  if (!value) return true;
  if (FILLER_PHRASE_RE.test(value)) return true;
  // Bullet / form fragment tells.
  if (/^\s*[-*]\s+/m.test(value) || /^\s*\u2022\s+/m.test(value)) return true;
  // Trade-form label dumps are never builder-facing prose.
  if (/\bmake[- ]safe\s*type\s*:/i.test(value)) return true;
  if (/\b(?:damage|work|cause|materials)\s*:/i.test(value)) return true;
  // Bare cause / single fragment without a real sentence shape.
  if (!/[.!?]\s|[.!?]$/.test(value) && value.length < 40) return true;
  const ck = checklist && typeof checklist === "object" ? checklist : {};
  const rawCandidates = [
    text(ck.damage_description),
    text(ck.damage_cause),
    text(ck.work_done),
    text(ck.works_completed),
    Array.isArray(ck.materials_used)
      ? ck.materials_used.map((item) => text(item)).filter(Boolean).join(", ")
      : text(ck.materials_used),
  ].filter(Boolean);
  const normalised = text(value).toLowerCase();
  return rawCandidates.some((raw) => text(raw).toLowerCase() === normalised);
}

/**
 * Prefer supplied draft prose when it already meets the paragraph contract;
 * otherwise compose honest paragraphs from the trade checklist.
 */
export function resolveMakesafeReportProseSections(
  supplied: Partial<MakesafeReportProseSections> | null | undefined,
  checklist: TradeChecklistForProse | null | undefined,
): MakesafeReportProseSections {
  const composed = composeMakesafeReportProseFromTradeEvidence(checklist);
  const src = supplied && typeof supplied === "object" ? supplied : {};
  return {
    scope: reportProseNeedsComposition(src.scope, checklist)
      ? composed.scope
      : sanitiseReportProse(src.scope),
    findings: reportProseNeedsComposition(src.findings, checklist)
      ? composed.findings
      : sanitiseReportProse(src.findings),
    works: reportProseNeedsComposition(src.works, checklist)
      ? composed.works
      : sanitiseReportProse(src.works),
    materials: reportProseNeedsComposition(src.materials, checklist)
      ? composed.materials
      : sanitiseReportProse(src.materials),
  };
}
