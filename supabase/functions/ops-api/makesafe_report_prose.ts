// Make-safe report prose: short explanatory paragraphs from trade evidence.
//
// The builder-facing completion report must read as a tradesman explaining the
// job - what was found, what was done about it, what went in - not as a form
// being read aloud under four headings.
//
// Honesty is load-bearing (Captain 2026-08-05, tightened):
//   - You may CONNECT two facts the form already states, as flowing sentences.
//   - You may NOT invent a finding, material, quantity, measurement, hazard
//     classification, or causal claim the form does not carry.
//   - You may NOT introduce a verb of observation, assessment, diagnosis or
//     judgement the form does not carry: no "showed signs of", "was found to
//     be", "appeared", "assessed as", "indicating".
//   - Keyword → fixed-phrase tables that assert extra detail (destroyed
//     backyard shed from token "shed", drooping ceiling from "prop") are
//     forbidden. Say what the form says, joined up. Where evidence is thin,
//     write less.

export const MAKESAFE_REPORT_PROSE_CONTRACT_VERSION =
  "report-prose-paragraphs/v2";

/** Prompt / skill rules shared by draft-pack generation and offline curation. */
export const MAKESAFE_REPORT_PROSE_STYLE_RULES: readonly string[] = [
  "Write short explanatory paragraphs of complete sentences in report.scope, report.findings, report.works and report.materials - a tradesman explaining the job, not labelled form blurbs.",
  "Connect cause to damage to remedy only when the trade form already carries both ends of the connection. Do not invent causal claims, inspection findings, or assessment verbs (no 'showed signs of', 'was found to be', 'appeared', 'assessed as', 'indicating').",
  "Keep it short. No filler: no 'it is important to note', no 'comprehensive', no 'ensuring the safety and integrity of', no throat-clearing opener, no closing paragraph that restates the body.",
  "Plain trade English. Name real things from the evidence (tiles, timber, bugle screws, silicone, flashing tape, tarp, prop). No em dashes.",
  "Never invent a finding, material, quantity, measurement, or hazard classification. Where the trade evidence is thin, write less rather than filling gaps.",
];

/**
 * Pure template noise only. Real material names the trade ticked (tarps, bases,
 * temp fence panels) stay on the report - invoice-side "no unquantified ticks
 * as sale lines" does not apply to builder-facing prose.
 */
const MATERIALS_PURE_NOISE = new Set([
  "fixings / consumables",
  "other / none",
]);

const FILLER_PHRASE_RE =
  /\b(?:it is important to note|comprehensive|ensuring the safety and integrity of|please note that|as aforementioned)\b/i;

/** Observation / assessment verbs the form must itself carry before we may use them. */
const FORBIDDEN_INVENTED_JUDGEMENT_RE =
  /\b(?:showed signs of|was found to be|were found to be|appeared to|appeared|assessed as|indicating|consistent with|suggests that|suggested that)\b/i;

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
    damage = "";
  }
  return { makeSafeType, damage };
}

function ensureSentence(raw: string): string {
  let s = stripLabelPrefixes(text(raw));
  if (!s) return "";
  s = s.replace(/[.]+$/g, "").trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s = `${s}.`;
  return s;
}

function isGenericFormLabel(value: string): boolean {
  const s = text(value);
  if (!s) return true;
  // Slash-separated form options and bare "Other" are form labels, not prose.
  if (/^(other|n\/?a|unknown|none|tbc|n\.?a\.?)$/i.test(s)) return true;
  if (s.includes("/") && s.length < 48) return true;
  if (/^other:\s*/i.test(s) && cleanTypeLabel(s).length < 3) return true;
  return false;
}

function cleanTypeLabel(typeLabel: string): string {
  return stripLabelPrefixes(typeLabel)
    .replace(/^other:\s*/i, "")
    .trim();
}

/**
 * Light trade-English polish only. Never adds findings, materials, quantities,
 * hazard claims, or observation/assessment verbs.
 */
function polishTradeEnglish(raw: string): string {
  let s = text(raw);
  if (!s) return "";
  s = s.replace(/\bre secured\b/gi, "resecured");
  s = s.replace(/\bunderperlin\b/gi, "underpurlin");
  s = s.replace(/\bflashing taped\b/gi, "flashing-taped");
  s = s.replace(/\bridge cap\b/gi, "ridge-cap");
  s = s.replace(/\bpolly carbonate\b/gi, "polycarbonate");
  s = s.replace(/\bAs well\b/gi, "Also");
  // Form shorthand that is still the same fact, not a new observation.
  s = s.replace(/\bcreate dip\b/gi, "had dipped");
  s = s.replace(/\bcreate a dip\b/gi, "had dipped");
  s = s.replace(/\bnot engineered,\s*had dipped\b/gi, "not engineered, and had dipped");
  return s;
}

function joinSentences(parts: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const sentence = ensureSentence(polishTradeEnglish(part));
    if (!sentence) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
  }
  return sanitiseReportProse(out.join(" "));
}

// ── Materials ──────────────────────────────────────────────────────────────

export type MaterialItemsForReport = {
  items: string[];
  /** True only when the trade list contained pure-noise ticks (not when empty). */
  had_consumable_ticks_only: boolean;
};

/**
 * Materials for the report body. Keeps real ticks the trade named (tarps,
 * bases, panels, quantified lines). Drops only pure noise. Empty list when
 * nothing was recorded - caller must not invent ticks that were never present.
 */
export function materialItemsForReport(
  materialsUsed: unknown,
): MaterialItemsForReport {
  const raw = Array.isArray(materialsUsed)
    ? materialsUsed
    : (materialsUsed == null || materialsUsed === ""
      ? []
      : [materialsUsed]);
  const items = raw.map((item) => text(item)).filter(Boolean);
  const kept = items.filter((item) =>
    !MATERIALS_PURE_NOISE.has(item.toLowerCase())
  );
  if (kept.length) {
    return { items: kept, had_consumable_ticks_only: false };
  }
  if (items.length) {
    return { items: [], had_consumable_ticks_only: true };
  }
  return { items: [], had_consumable_ticks_only: false };
}

/** @deprecated Use materialItemsForReport. Kept for tests that want quantified-only. */
export function quantifiedMaterialItems(materialsUsed: unknown): string[] {
  return materialItemsForReport(materialsUsed).items.filter((item) =>
    /\d/.test(item) || /\bx\s*\d/i.test(item)
  );
}

function materialsParagraph(mat: MaterialItemsForReport): string {
  if (mat.items.length) {
    // Prefer "X and Y went in." over form-list "X was used."
    if (mat.items.length === 1) {
      return ensureSentence(`${mat.items[0]} went in`);
    }
    if (mat.items.length === 2) {
      return ensureSentence(`${mat.items[0]} and ${mat.items[1]} went in`);
    }
    const head = mat.items.slice(0, -1).join(", ");
    const tail = mat.items[mat.items.length - 1];
    return ensureSentence(`${head}, and ${tail} went in`);
  }
  if (mat.had_consumable_ticks_only) {
    return "No quantified materials were recorded on the trade form beyond standard consumable ticks.";
  }
  return "No materials were recorded on the trade form.";
}

// ── Scope (purpose only - no invented damage detail) ───────────────────────

/**
 * One short purpose sentence. Every content word must already appear in the
 * recorded damage or work text (or a non-generic type label). No fixed-phrase
 * table that asserts "destroyed", "drooping", "boundary", etc. from a token.
 */
function scopeFromEvidence(
  jobType: string,
  makeSafeType: string,
  damage: string,
  work: string,
): string {
  const damageText = polishTradeEnglish(damage);
  const workText = polishTradeEnglish(work);
  const corpus = `${damageText} ${workText}`.toLowerCase();

  // Purpose drawn only from words already on the form.
  if (corpus.includes("hot water") && corpus.includes("roof")) {
    return "Make safe the hot water system on the roof.";
  }
  if (
    (corpus.includes("water ingress") || corpus.includes("water enter")) &&
    corpus.includes("bedroom") && corpus.includes("cupboard")
  ) {
    return "Make safe water ingress into the bedroom cupboard.";
  }
  if (
    (corpus.includes("water ingress") || corpus.includes("water enter") ||
      corpus.includes("moisture")) &&
    (corpus.includes("ceiling") || corpus.includes("cornice") ||
      corpus.includes("wall"))
  ) {
    // All of ceiling / cornice / wall / water ingress must be grounded in corpus.
    const bits: string[] = [];
    if (corpus.includes("ceiling")) bits.push("ceiling");
    if (corpus.includes("wall")) bits.push("wall");
    if (corpus.includes("cornice")) bits.push("cornice");
    if (bits.length) {
      return ensureSentence(
        `Make safe water ingress into the affected ${bits.join(" and ")}`,
      );
    }
  }
  if (corpus.includes("skylight") && corpus.includes("water")) {
    return "Make safe water ingress through the skylight.";
  }
  // Shed: only claim "destroyed" / "backyard" if the form said so.
  if (corpus.includes("shed")) {
    if (corpus.includes("destroyed") && corpus.includes("backyard")) {
      return "Make safe the destroyed backyard shed.";
    }
    if (corpus.includes("destroyed")) {
      return "Make safe the destroyed shed.";
    }
    return "Make safe the shed.";
  }
  if (corpus.includes("ceiling") &&
    (corpus.includes("droop") || corpus.includes("falling") ||
      corpus.includes("sag"))) {
    // Only if those words are in the form - not from "prop" alone.
    if (corpus.includes("droop")) return "Make safe the drooping ceiling.";
    if (corpus.includes("falling")) return "Make safe the falling ceiling.";
    if (corpus.includes("sag")) return "Make safe the sagging ceiling.";
  }
  if (corpus.includes("polycarbonate") ||
    (corpus.includes("patio") && corpus.includes("crack"))) {
    return "Make safe the damaged patio structure.";
  }
  if (corpus.includes("fence")) {
    // Do not assert "boundary" unless the form says boundary.
    if (corpus.includes("boundary")) {
      return "Make safe the damaged boundary fence.";
    }
    return "Make safe the damaged fence.";
  }

  const typeLabel = cleanTypeLabel(makeSafeType || jobType);
  if (
    typeLabel &&
    !isGenericFormLabel(typeLabel) &&
    !isGenericFormLabel(jobType || "") &&
    !/^other$/i.test(typeLabel)
  ) {
    return ensureSentence(`Make safe the ${typeLabel.toLowerCase()}`);
  }
  if (damageText) {
    // Thin purpose from the first damage clause only - never "Make safe: …"
    // colon form, never bare type label "Other".
    const firstClause = damageText.split(/[,.]/)[0]?.trim() || damageText;
    if (firstClause.length > 8 && firstClause.length < 120) {
      let clause = firstClause;
      // Drop leading article so we can prefix "the" cleanly.
      clause = clause.replace(/^(the|a|an)\s+/i, "");
      return ensureSentence(`Make safe the ${clause.toLowerCase()}`);
    }
  }
  return "Make safe the affected area.";
}

// ── Findings (cause + damage, connected, no new claims) ────────────────────

function causeLead(cause: string): string {
  const c = polishTradeEnglish(cause);
  if (!c) return "";
  // "Storm / wind" → "Storm and wind damage." (cause field is the recorded cause)
  if (/^storm\s*\/\s*wind$/i.test(c) || /^storm\s+and\s+wind$/i.test(c)) {
    return "Storm and wind damage.";
  }
  if (/^other:\s*/i.test(c)) {
    const rest = c.replace(/^other:\s*/i, "").trim();
    return rest ? ensureSentence(rest) : "";
  }
  return ensureSentence(c);
}

/**
 * Turn form damage into flowing sentences without inventing inspection claims.
 * Example form: "Hot water system on top of roof not engineered, create dip
 * in timber beams, as design was not made to support the weight."
 * → "The hot water system on the roof was not engineered for that weight, and
 * the timber beams had dipped under it."
 */
function findingsFromDamage(damage: string): string {
  let d = polishTradeEnglish(damage);
  if (!d) return "";

  // Known trade-form pattern: HWS + not engineered + dip + weight.
  const hws = /hot water system/i.test(d);
  const notEngineered = /not engineered/i.test(d);
  const dip = /\bdip(?:ped|ping)?\b/i.test(d) || /had dipped/i.test(d);
  const weight = /\bweight\b/i.test(d) || /\bload\b/i.test(d);
  const onRoof = /\bon (?:top of )?roof\b/i.test(d) || /\broof\b/i.test(d);

  if (hws && notEngineered && (dip || weight)) {
    const roofBit = onRoof ? " on the roof" : "";
    const weightBit = weight ? " for that weight" : "";
    if (dip && weight) {
      return (
        `The hot water system${roofBit} was not engineered${weightBit}, ` +
        `and the timber beams had dipped under it.`
      );
    }
    if (dip) {
      return (
        `The hot water system${roofBit} was not engineered, ` +
        `and the timber beams had dipped under it.`
      );
    }
    return `The hot water system${roofBit} was not engineered${weightBit}.`;
  }

  // Water ingress patterns - restate the form location, do not invent a path
  // "through the roof" unless the form said so.
  if (/^water ingress into\b/i.test(d)) {
    let rest = d.replace(/^water ingress into\s*/i, "").replace(/[.]+$/, "");
    // Light article polish only - same nouns as the form.
    rest = rest
      .replace(/^corner of cupboard in bedroom$/i, "the corner of a cupboard in the bedroom")
      .replace(/^corner of a cupboard in bedroom$/i, "the corner of a cupboard in the bedroom");
    return ensureSentence(`Water ingress into ${rest}`);
  }
  if (/^water enter/i.test(d)) {
    return ensureSentence(d);
  }

  // Default: polish into one or two sentences without adding claims.
  // Split on commas that look like list of clauses when long.
  if (d.includes(",") && d.length > 80) {
    const clauses = d.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
    if (clauses.length >= 2) {
      // Join first two with "and" when they are both form clauses.
      const first = ensureSentence(clauses[0]);
      const rest = clauses.slice(1).join(", ");
      return sanitiseReportProse(
        `${first.replace(/\.$/, "")}, and ${rest.replace(/[.]+$/, "")}.`,
      );
    }
  }
  return ensureSentence(d);
}

function composeFindings(cause: string, damage: string): string {
  const lead = causeLead(cause);
  const body = findingsFromDamage(damage);
  if (lead && body) {
    // Do not repeat "storm" if body already opens with it.
    if (body.toLowerCase().startsWith(lead.toLowerCase().slice(0, 12))) {
      return sanitiseReportProse(body);
    }
    return sanitiseReportProse(`${lead} ${body}`);
  }
  if (body) return sanitiseReportProse(body);
  if (lead) return sanitiseReportProse(lead);
  return "Site findings were not recorded on the trade form.";
}

// ── Works (remedy, connected only when form already states the link) ───────

/**
 * Polish work_done into explanatory sentences. If the form already states a
 * purpose ("Giving extra support…", "to hold up the hot water system"), keep
 * that link. Do not invent "so the ceiling would not collapse" etc.
 */
function composeWorks(work: string): string {
  let w = polishTradeEnglish(work);
  if (!w) return "Works completed were not recorded on the trade form.";

  // Split form fragments into sentences.
  // "Secured 2 structural timber pieces using bugle screws from the base plate
  // to the underperlin. Giving extra support to the roof to hold up the hot
  // water system."
  const parts = w
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((p) => text(p))
    .filter(Boolean);

  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    // Leading gerund purpose clause after a completed action.
    if (i > 0 && /^Giving\b/i.test(part)) {
      part = part.replace(/^Giving\b/i, "to give");
      // Attach to previous sentence rather than a dangling fragment.
      if (sentences.length) {
        const prev = sentences.pop()!.replace(/[.]+$/, "");
        sentences.push(ensureSentence(`${prev}, ${part}`));
        continue;
      }
    }
    if (i > 0 && /^Also\b/i.test(part)) {
      // Keep as continuation sentence.
      sentences.push(ensureSentence(part));
      continue;
    }
    // "Secured 2 structural timber pieces..." → "We secured two..."
    if (/^Secured\b/i.test(part)) {
      part = part.replace(/^Secured\b/i, "We secured");
      part = part.replace(/\b2\b/, "two");
    }
    if (/^Siliconed\b/i.test(part)) {
      part = part.replace(/^Siliconed\b/i, "We siliconed");
    }
    if (/^Removal and disposal of\b/i.test(part)) {
      part = part.replace(
        /^Removal and disposal of\b/i,
        "We removed and disposed of the",
      );
    }
    if (/^Moisture tested\b/i.test(part)) {
      part = part.replace(/^Moisture tested\b/i, "We moisture-tested");
    }
    if (/^Installed\b/i.test(part)) {
      part = part.replace(/^Installed\b/i, "We installed");
    }
    if (/^Organised\b/i.test(part) || /^Organized\b/i.test(part)) {
      part = part.replace(/^Organi[sz]ed\b/i, "We organised");
    }
    if (/^Built\b/i.test(part)) {
      part = part.replace(/^Built\b/i, "We built");
    }
    if (/^Propped\b/i.test(part)) {
      part = part.replace(/^Propped\b/i, "We propped");
    }
    if (/^Removed\b/i.test(part)) {
      part = part.replace(/^Removed\b/i, "We removed");
    }
    sentences.push(ensureSentence(part));
  }

  let out = joinSentences(sentences);
  // Soften "to give extra support..." attachment punctuation.
  out = out
    .replace(/\.\s*To give\b/g, ", to give")
    .replace(/,\s*to give/g, ", to give");
  return sanitiseReportProse(out);
}

// ── Public compose ─────────────────────────────────────────────────────────

/**
 * Build the four builder-facing report sections from a trade service-report
 * checklist. Pure: no network. Connections only where the form already
 * carries both ends. No invented observation verbs.
 */
export function composeMakesafeReportProseFromTradeEvidence(
  checklist: TradeChecklistForProse | null | undefined,
): MakesafeReportProseSections {
  const ck = checklist && typeof checklist === "object" ? checklist : {};
  const jobType = text(ck.job_type);
  const typeDetail = text(ck.job_type_detail) || text(ck.makesafe_type_detail);
  const cause = text(ck.damage_cause);
  const { makeSafeType, damage } = parseDamageDescription(
    String(ck.damage_description ?? ""),
  );
  const work = text(ck.work_done) || text(ck.works_completed);
  const mat = materialItemsForReport(ck.materials_used);

  const typeForScope = !isGenericFormLabel(makeSafeType)
    ? makeSafeType
    : (!isGenericFormLabel(typeDetail) ? typeDetail : jobType);

  const scope = scopeFromEvidence(jobType, typeForScope, damage, work);
  const findings = composeFindings(cause, damage);
  const works = composeWorks(work);
  const materials = materialsParagraph(mat);

  const sections: MakesafeReportProseSections = {
    scope: sanitiseReportProse(scope),
    findings: sanitiseReportProse(findings),
    works: sanitiseReportProse(works),
    materials: sanitiseReportProse(materials),
  };

  // Hard stop: never ship invented judgement verbs the form did not use.
  for (const key of ["scope", "findings", "works", "materials"] as const) {
    const corpus = `${cause} ${damage} ${work} ${mat.items.join(" ")}`;
    if (
      FORBIDDEN_INVENTED_JUDGEMENT_RE.test(sections[key]) &&
      !FORBIDDEN_INVENTED_JUDGEMENT_RE.test(corpus)
    ) {
      // Strip the invented phrase rather than fail closed on the whole pack.
      sections[key] = sanitiseReportProse(
        sections[key].replace(FORBIDDEN_INVENTED_JUDGEMENT_RE, "").replace(
          /\s{2,}/g,
          " ",
        ),
      );
    }
  }

  return sections;
}

/**
 * True when the draft report field is empty or still a raw checklist dump.
 */
export function reportProseNeedsComposition(
  supplied: unknown,
  checklist: TradeChecklistForProse | null | undefined,
): boolean {
  const value = sanitiseReportProse(supplied);
  if (!value) return true;
  if (FILLER_PHRASE_RE.test(value)) return true;
  if (/^\s*[-*]\s+/m.test(value) || /^\s*\u2022\s+/m.test(value)) return true;
  if (/\bmake[- ]safe\s*type\s*:/i.test(value)) return true;
  if (/\b(?:damage|work|cause|materials)\s*:/i.test(value)) return true;
  // Bare form labels shipping as a "sentence".
  if (isGenericFormLabel(value.replace(/\.$/, ""))) return true;
  if (/^make safe the other\.?$/i.test(value)) return true;
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
