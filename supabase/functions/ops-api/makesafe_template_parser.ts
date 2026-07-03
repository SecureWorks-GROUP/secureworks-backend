// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — PER-BUILDER TEMPLATE PARSERS (cost hardening, M1.5)
// Mission: makesafe/intake-cost-hardening (Auto-Intake v2 Wave 1 M1.5)
// ════════════════════════════════════════════════════════════
//
// The second cost lever: the highest-volume builders send work orders with a stable
// layout, so the required fields can be lifted deterministically with regexes instead
// of a model call. When a builder's rules parse ALL required fields, the classifier
// call is SKIPPED entirely (parser:'template', model_called:false) — a free extraction.
//
// The rules are DATA, not code. They live in makesafe_companies.parsing_rules (jsonb,
// per builder) so the Captain can add/tune a builder's regexes with one DB update, no
// redeploy. The shape below is a backward-compatible extension of the empty `{}` the
// column has held since the make-safe contract migration.
//
// SAFE ROLLOUT. `template_first` defaults FALSE per builder: until it is flipped to
// true (only after the golden-replay agreement check proves the template matches the
// live model on that builder's real emails), the live scan STILL calls the model —
// the template parse only runs as a preview. So no builder goes template-first blind.

export interface TemplateFieldRule {
  /** Regex source (JS syntax). The whole match is used unless `group` is set. */
  regex: string;
  /** Optional regex flags (default "i"). */
  flags?: string;
  /** Capture-group index to take as the value (default 1, or 0 for whole match). */
  group?: number;
  /** Where to look: 'subject' | 'body' | 'pdf' | 'all' (default 'all'). */
  source?: "subject" | "body" | "pdf" | "all";
  /** Optional post-parse transform. */
  transform?: "trim" | "collapse_ws" | "upper" | "lower";
}

export interface TemplateParsingRules {
  version?: number;
  /** Per-builder toggle. FALSE (default) = template runs as a preview only; the live
   * scan still calls the model. TRUE = a full deterministic parse SKIPS the model. */
  template_first?: boolean;
  /** Field name → rule. Field names match the draft/extraction contract. */
  fields?: Record<string, TemplateFieldRule>;
  /** Fields that must ALL parse for the parse to count as "full" (model-skippable).
   * Defaults to the intake required set if omitted. */
  required?: string[];
  /** Confidence to stamp on a full deterministic parse (default 'high'). */
  confidence?: string;
}

export interface TemplateParseContext {
  subject: string;
  body: string;
  /** Extracted PDF text-layer (from makesafe_pdf_text); "" when unavailable. */
  pdfText?: string;
}

export interface TemplateParseResult {
  /** 'template' when a full deterministic parse succeeded; else 'none'. */
  parser: "template" | "none";
  /** TRUE only when the live scan may skip the model (template_first AND full_parse). */
  model_skipped: boolean;
  /** TRUE when every required field parsed (independent of the template_first toggle). */
  full_parse: boolean;
  /** Whether this builder is flipped to template-first. */
  template_first: boolean;
  /** Parsed field values (only fields that matched). */
  fields: Record<string, string>;
  /** Which required fields did NOT parse. */
  missing_required: string[];
  /** Confidence to assign when full_parse (mirrors the model's high-confidence path). */
  confidence: string;
}

// Same required set the human/auto approve gate enforces (company is matched by the
// scan separately, so the template covers the extraction-side required fields).
export const TEMPLATE_DEFAULT_REQUIRED = ["external_ref", "client_name", "site_address"];

function applyTransform(value: string, t?: TemplateFieldRule["transform"]): string {
  switch (t) {
    case "trim": return value.trim();
    case "collapse_ws": return value.replace(/\s+/g, " ").trim();
    case "upper": return value.trim().toUpperCase();
    case "lower": return value.trim().toLowerCase();
    default: return value.trim();
  }
}

function pickSource(ctx: TemplateParseContext, source?: TemplateFieldRule["source"]): string {
  switch (source) {
    case "subject": return ctx.subject || "";
    case "body": return ctx.body || "";
    case "pdf": return ctx.pdfText || "";
    case "all":
    default:
      return [ctx.subject, ctx.body, ctx.pdfText].filter(Boolean).join("\n");
  }
}

/** Parse the fields a builder's rules can extract. Pure + deterministic. Returns null
 * ONLY when the builder has no usable rules (no `fields`); otherwise always returns a
 * result (possibly with missing required fields). Never throws — a bad regex in the
 * data yields a miss for that field, not a crash. */
export function parseWithTemplate(
  rules: TemplateParsingRules | null | undefined,
  ctx: TemplateParseContext,
): TemplateParseResult | null {
  if (!rules || typeof rules !== "object") return null;
  const fields = rules.fields;
  if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) return null;

  const templateFirst = rules.template_first === true;
  const required = Array.isArray(rules.required) && rules.required.length
    ? rules.required
    : TEMPLATE_DEFAULT_REQUIRED;
  const confidence = typeof rules.confidence === "string" ? rules.confidence : "high";

  const parsed: Record<string, string> = {};
  for (const [name, rule] of Object.entries(fields)) {
    if (!rule || typeof rule.regex !== "string") continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.regex, rule.flags ?? "i");
    } catch (_) {
      continue; // malformed rule data — skip this field, never crash the scan
    }
    const hay = pickSource(ctx, rule.source);
    const m = re.exec(hay);
    if (!m) continue;
    const groupIdx = typeof rule.group === "number" ? rule.group : 1;
    const raw = m[groupIdx] ?? m[0];
    if (raw == null) continue;
    const val = applyTransform(String(raw), rule.transform);
    if (val) parsed[name] = val;
  }

  const missingRequired = required.filter((f) => !parsed[f]);
  const fullParse = missingRequired.length === 0;

  return {
    parser: fullParse ? "template" : "none",
    model_skipped: fullParse && templateFirst,
    full_parse: fullParse,
    template_first: templateFirst,
    fields: parsed,
    missing_required: missingRequired,
    confidence,
  };
}

/** Compare a template parse against the fields on the actual historical draft/job.
 * Per-field: true = both present and equal (normalised), false = both present but
 * differ, null = one side missing (nothing to compare). Feeds the golden-replay proof
 * that a builder is safe to flip template-first. */
export function compareTemplateToActual(
  parsed: Record<string, string>,
  actual: Record<string, string | null | undefined>,
): { per_field: Record<string, boolean | null>; agrees: boolean; compared: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.,]/g, "").trim();
  const per: Record<string, boolean | null> = {};
  let compared = 0;
  let disagreements = 0;
  const names = new Set([...Object.keys(parsed), ...Object.keys(actual)]);
  for (const name of names) {
    const p = parsed[name];
    const a = actual[name];
    if (p == null || a == null || String(a).trim() === "") {
      per[name] = null;
      continue;
    }
    const eq = norm(String(p)) === norm(String(a));
    per[name] = eq;
    compared++;
    if (!eq) disagreements++;
  }
  return { per_field: per, agrees: compared > 0 && disagreements === 0, compared };
}
