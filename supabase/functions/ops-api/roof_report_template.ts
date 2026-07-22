// SecureWorks own-letterhead Roof Report (Wave 3) -- PURE, testable template
// definition + field/pricing helpers. NO network, NO Supabase, NO jsPDF.
//
// This module is the SINGLE SOURCE OF TRUTH for the roof-report field set the
// trade app renders, the storey -> price rule, field validation, and the mapping
// from a saved field bag to the renderer job shape (roof_report_render.ts).
//
// The field set mirrors the structure of an MLB / Prime-portal "Roof Report"
// (generic + A&G/RAC variants) so a trade filling OUR form captures the same
// evidence a builder portal would, but the deliverable renders on SecureWorks
// Group letterhead. See the make-safe reporting skill references
// (portal-proof-and-roof-reports.md, pricing-and-invoice-rules.md).
//
// House rules honoured here: brand copy says "SecureWorks Group" (never
// "SecureWorks WA"); no em dashes in any label or option (the renderer also
// sanitises, but the static strings below are clean at the source).

// ── Template versioning ──
//
// Bumped when the field set changes shape. The trade app can cache a schema and
// compare versions; a saved fill records the version it was captured under so a
// later render knows which field set produced it.
export const ROOF_REPORT_TEMPLATE_VERSION = 1;

// The pack_kind that scopes a roof-report fill on a job (mirrors
// makesafe_report_packs.pack_kind = 'main'). One roof fill per job.
export const ROOF_REPORT_PACK_KIND = "roof";

export type RoofFieldType =
  | "text"
  | "textarea"
  | "toggle"
  | "select"
  | "date"
  | "time"
  | "photos";

export interface RoofReportField {
  key: string;
  label: string;
  type: RoofFieldType;
  section: string;
  required?: boolean;
  options?: string[];
  help?: string;
  placeholder?: string;
  // Marks the storey question that deterministically drives the report fee.
  pricingDriver?: boolean;
}

export interface RoofReportSection {
  key: string;
  title: string;
}

// ── Storey options (the pricing driver values) ──
export const STOREY_SINGLE = "Single Storey";
export const STOREY_DOUBLE = "Double Storey";
export const STOREY_OPTIONS = [STOREY_SINGLE, STOREY_DOUBLE];

// ── Locked roof-report pricing (Marnin/Shaun, 2026-07-16), every builder ──
//
// Single storey -> $250 ex GST / $275 inc GST
// Double storey -> $350 ex GST / $385 inc GST
// Source: skills/secureworks-makesafe-reporting/references/pricing-and-invoice-rules.md.
// Single/double is a FIXED figure, not a judgement call. Access/scope beyond a
// plain double storey can still be scaled manually on the docket at release; the
// template only fixes the two base figures.
export const ROOF_REPORT_PRICING = {
  single: { ex_gst: 250, inc_gst: 275 },
  double: { ex_gst: 350, inc_gst: 385 },
} as const;

export interface RoofReportPrice {
  storey: "single" | "double";
  storey_label: string;
  ex_gst: number;
  inc_gst: number;
}

// Normalise any storey input (dropdown label, 'single'/'double', '1'/'2', a
// number, or free text containing 'double'/'two') to the canonical key. Defaults
// to 'single' ONLY when the input clearly reads single; anything unrecognised
// returns null so callers can require an explicit answer rather than silently
// under-pricing a double-storey job.
export function normaliseStorey(input: unknown): "single" | "double" | null {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  if (
    s === "double" || s === "double storey" || s === "two" ||
    s === "two storey" || s === "2" || s.includes("double") || s.includes("two")
  ) {
    return "double";
  }
  if (
    s === "single" || s === "single storey" || s === "one" ||
    s === "one storey" || s === "1" || s.includes("single") || s.includes("one")
  ) {
    return "single";
  }
  return null;
}

// Deterministic storey -> price. Throws on an unrecognised storey so the fee is
// never guessed (a roof report cannot be priced without the storey answer).
export function roofReportPrice(input: unknown): RoofReportPrice {
  const storey = normaliseStorey(input);
  if (!storey) {
    throw new Error(
      `roofReportPrice: storey required (expected "${STOREY_SINGLE}" or "${STOREY_DOUBLE}"), got ${
        JSON.stringify(input)
      }`,
    );
  }
  const p = ROOF_REPORT_PRICING[storey];
  return {
    storey,
    storey_label: storey === "double" ? STOREY_DOUBLE : STOREY_SINGLE,
    ex_gst: p.ex_gst,
    inc_gst: p.inc_gst,
  };
}

// ── The template ──
export const ROOF_REPORT_SECTIONS: RoofReportSection[] = [
  { key: "inspection", title: "Inspection Details" },
  { key: "property", title: "Property Details" },
  { key: "findings", title: "Roof Findings" },
  { key: "maintenance", title: "Maintenance" },
  { key: "summary", title: "Summary" },
  { key: "photos", title: "Photo Evidence" },
];

// Field set. Toggles are Yes/No booleans; selects carry their option list; the
// storey select is flagged pricingDriver so the UI can surface the live fee.
export const ROOF_REPORT_FIELDS: RoofReportField[] = [
  // Inspection Details
  {
    key: "inspection_date",
    label: "Date of inspection",
    type: "date",
    section: "inspection",
    required: true,
  },
  {
    key: "inspection_time",
    label: "Time of inspection",
    type: "time",
    section: "inspection",
  },
  {
    key: "inspected_by",
    label: "Inspected by",
    type: "text",
    section: "inspection",
    required: true,
    placeholder: "Trade / inspector name",
  },
  {
    key: "weather",
    label: "Weather at time of inspection",
    type: "select",
    section: "inspection",
    options: ["Sunny / Fine", "Overcast", "Light rain", "Heavy rain", "Windy"],
  },
  // Property Details
  {
    key: "construction_type",
    label: "Construction type",
    type: "select",
    section: "property",
    options: [
      "Double Brick",
      "Brick Veneer",
      "Stone",
      "Render",
      "Weatherboard",
      "Other",
    ],
  },
  {
    key: "storeys",
    label: "Number of storeys",
    type: "select",
    section: "property",
    required: true,
    options: STOREY_OPTIONS,
    pricingDriver: true,
    help:
      "Sets the report fee: Single Storey $275 inc GST, Double Storey $385 inc GST. Access or scope beyond a plain double storey is scaled manually at release.",
  },
  {
    key: "property_condition",
    label: "Property condition",
    type: "select",
    section: "property",
    options: ["Good", "Fair", "Poor"],
  },
  {
    key: "roof_type",
    label: "Roof type",
    type: "select",
    section: "property",
    options: [
      "Terracotta Tiles",
      "Concrete Tiles",
      "Colorbond",
      "Zincalume",
      "Asbestos",
      "Other",
    ],
  },
  {
    key: "roof_pitch",
    label: "Roof pitch",
    type: "text",
    section: "property",
    placeholder: "e.g. 22.5 degrees",
  },
  {
    key: "roof_profile_correct",
    label: "Roof profile correct",
    type: "toggle",
    section: "property",
  },
  {
    key: "gutters_serviceable",
    label: "Gutters, valleys and downpipes serviceable",
    type: "toggle",
    section: "property",
  },
  {
    key: "roof_condition",
    label: "Roof condition",
    type: "select",
    section: "property",
    options: ["Good", "Fair", "Poor"],
  },
  {
    key: "services_penetrations",
    label: "Services / penetrations present on roof",
    type: "text",
    section: "property",
    placeholder: "e.g. solar, hot water, whirlybirds, aerials",
  },
  // Roof Findings
  {
    key: "storm_openings",
    label: "Storm-created openings in the roof",
    type: "toggle",
    section: "findings",
  },
  {
    key: "water_leak",
    label: "Water leak through the roof",
    type: "toggle",
    section: "findings",
  },
  {
    key: "leak_cause",
    label: "Cause of water leak",
    type: "text",
    section: "findings",
    placeholder: "Only if a leak was found",
  },
  {
    key: "overall_findings",
    label: "Roof condition and findings",
    type: "textarea",
    section: "findings",
    placeholder: "What was inspected and the condition observed.",
  },
  // Maintenance
  {
    key: "maintenance_issues",
    label: "Maintenance issues present",
    type: "textarea",
    section: "maintenance",
    placeholder: "None found and/or remaining, or describe the issues.",
  },
  {
    key: "maintenance_recommendation",
    label: "Maintenance recommended and/or required",
    type: "select",
    section: "maintenance",
    options: ["N/a", "Recommended", "Required"],
    help:
      "Recommended: works that would improve the roof but are not driven by the claim event. Required: works needed to make the roof serviceable.",
  },
  {
    key: "maintenance_details",
    label: "Details of recommended / required maintenance",
    type: "textarea",
    section: "maintenance",
  },
  // Summary
  {
    key: "scope_summary",
    label: "Scope of inspection",
    type: "textarea",
    section: "summary",
    placeholder: "What the inspection covered.",
  },
  // Photos (labelled evidence -- the "bonus" from the captain ruling)
  {
    key: "photos",
    label: "Photo evidence",
    type: "photos",
    section: "photos",
    help: "Attach roof photos. Each photo can carry a label / caption.",
  },
];

export interface RoofReportTemplate {
  version: number;
  pack_kind: string;
  sections: RoofReportSection[];
  fields: RoofReportField[];
  pricing: {
    single: { ex_gst: number; inc_gst: number };
    double: { ex_gst: number; inc_gst: number };
    storey_field: string;
    note: string;
  };
}

// The full template payload the trade app renders. Pure and deterministic.
export function getRoofReportTemplate(): RoofReportTemplate {
  return {
    version: ROOF_REPORT_TEMPLATE_VERSION,
    pack_kind: ROOF_REPORT_PACK_KIND,
    sections: ROOF_REPORT_SECTIONS,
    fields: ROOF_REPORT_FIELDS,
    pricing: {
      single: { ...ROOF_REPORT_PRICING.single },
      double: { ...ROOF_REPORT_PRICING.double },
      storey_field: "storeys",
      note:
        "Storey sets the fee. Single Storey $275 inc GST, Double Storey $385 inc GST (locked 2026-07-16). Access or scope beyond a plain double storey is scaled manually at release.",
    },
  };
}

// ── Field validation ──
//
// Draft saves are permissive (any subset of fields). A submit (final) must carry
// the required fields AND a recognised storey (so the fee is deterministic).
export interface RoofReportValidation {
  ok: boolean;
  errors: string[];
}

const REQUIRED_KEYS = ROOF_REPORT_FIELDS.filter((f) => f.required).map((f) =>
  f.key
);

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === "";
}

// Validate a field bag for a FINAL submit. Draft saves skip this entirely.
export function validateRoofReportForSubmit(
  fields: Record<string, unknown>,
): RoofReportValidation {
  const errors: string[] = [];
  const bag = fields || {};
  for (const key of REQUIRED_KEYS) {
    if (isBlank(bag[key])) {
      const f = ROOF_REPORT_FIELDS.find((x) => x.key === key);
      errors.push(`${f?.label || key} is required`);
    }
  }
  // Storey must resolve so the fee is never guessed.
  if (!isBlank(bag.storeys) && !normaliseStorey(bag.storeys)) {
    errors.push(
      `Number of storeys must be "${STOREY_SINGLE}" or "${STOREY_DOUBLE}"`,
    );
  }
  return { ok: errors.length === 0, errors };
}

// Keep only keys the template defines, dropping anything a client tacked on.
// This is what gets persisted, so a stray/oversized client key can never bloat
// the stored fill. Photos are handled separately by the caller (they are large).
export function sanitiseRoofReportFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(
    ROOF_REPORT_FIELDS.filter((f) => f.type !== "photos").map((f) => f.key),
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

// ── Field bag -> renderer job ──
//
// meta carries the job identity the renderer needs (ref/address/contact) that
// does not live in the trade-filled field bag. Photos are passed through as the
// renderer's photo shape (bytesBase64/url/contentType/label).
export interface RoofReportJobMeta {
  ref: string;
  address: string;
  contact?: string;
  client?: string;
  job_number?: string;
}

export interface RoofReportRenderPhoto {
  bytesBase64?: string;
  contentType?: string;
  url?: string;
  label?: string;
}

// Lightweight photo reference persisted on a draft: URL + label + contentType
// ONLY (never base64 bytes). Photo bytes are large and belong in storage
// (job_media / job_documents), never inlined in the draft's fields_json. This
// strips any bytesBase64 a client sends and caps the count so a draft save can
// never bloat the row. The renderer fetches the URL bytes itself at render time.
export interface RoofPhotoMeta {
  url?: string;
  contentType?: string;
  label?: string;
}

export function sanitiseRoofPhotosMeta(
  photos: unknown,
  cap = 20,
): RoofPhotoMeta[] {
  if (!Array.isArray(photos)) return [];
  const out: RoofPhotoMeta[] = [];
  for (const p of photos.slice(0, Math.max(0, cap))) {
    const url = typeof (p as any)?.url === "string"
      ? (p as any).url
      : undefined;
    if (!url) continue; // no URL -> nothing to persist/resolve later
    out.push({
      url,
      contentType: typeof (p as any)?.contentType === "string"
        ? (p as any).contentType
        : undefined,
      label: typeof (p as any)?.label === "string"
        ? (p as any).label
        : undefined,
    });
  }
  return out;
}

// Build the renderer job. Computes the fee from the storey answer (best-effort:
// leaves the fee undefined rather than throwing when a draft has no storey yet,
// so a preview render of an incomplete fill still works).
export function buildRoofReportJob(
  fields: Record<string, unknown>,
  meta: RoofReportJobMeta,
  photos: RoofReportRenderPhoto[] = [],
): Record<string, unknown> {
  const bag = fields || {};
  let priceEx: number | undefined;
  let priceInc: number | undefined;
  let storeyLabel: string | undefined;
  try {
    const p = roofReportPrice(bag.storeys);
    priceEx = p.ex_gst;
    priceInc = p.inc_gst;
    storeyLabel = p.storey_label;
  } catch {
    // Draft with no/invalid storey: no fee shown yet.
    storeyLabel = isBlank(bag.storeys) ? undefined : String(bag.storeys);
  }
  return {
    ref: meta.ref,
    address: meta.address,
    contact: meta.contact,
    client: meta.client,
    job_number: meta.job_number,
    inspection_date: bag.inspection_date,
    inspection_time: bag.inspection_time,
    inspected_by: bag.inspected_by,
    weather: bag.weather,
    construction_type: bag.construction_type,
    storeys: storeyLabel,
    property_condition: bag.property_condition,
    roof_type: bag.roof_type,
    roof_pitch: bag.roof_pitch,
    roof_profile_correct: bag.roof_profile_correct,
    gutters_serviceable: bag.gutters_serviceable,
    roof_condition: bag.roof_condition,
    services_penetrations: bag.services_penetrations,
    storm_openings: bag.storm_openings,
    water_leak: bag.water_leak,
    leak_cause: bag.leak_cause,
    overall_findings: bag.overall_findings,
    maintenance_issues: bag.maintenance_issues,
    maintenance_recommendation: bag.maintenance_recommendation,
    maintenance_details: bag.maintenance_details,
    scope_summary: bag.scope_summary,
    price_ex_gst: priceEx,
    price_inc_gst: priceInc,
    photos,
  };
}

// Test-only aliases (mirror the `_`-prefixed convention in sibling modules).
export const _getRoofReportTemplate = getRoofReportTemplate;
export const _roofReportPrice = roofReportPrice;
export const _normaliseStorey = normaliseStorey;
export const _validateRoofReportForSubmit = validateRoofReportForSubmit;
export const _buildRoofReportJob = buildRoofReportJob;
export const _sanitiseRoofReportFields = sanitiseRoofReportFields;
export const _sanitiseRoofPhotosMeta = sanitiseRoofPhotosMeta;
