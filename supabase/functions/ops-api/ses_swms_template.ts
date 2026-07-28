import type { SesAssemblerInputV1 } from "./ses_docket_envelope.ts";

// Port of the approved SecureWorks reporting-skill templates:
// general-makesafe.py, roof-makesafe.py and hardie-fence.py. The upstream file
// hashes below bind provenance to those sealed sources; job-specific values are
// derived only from the canonical work-order and current-cycle trade report.
export const SES_SWMS_GENERATION_PLAN_VERSION =
  "secureworks.swms-generation-plan/v1";
export const SES_SWMS_TEMPLATE_VERSION =
  "secureworks.swms-template/2026-06-30-v1";
export const SES_SWMS_DOC_CODE = "SW-WHS-SAF-400";

export type SesSwmsTemplateKind =
  | "general_makesafe"
  | "roof_makesafe"
  | "hardie_fence";

export interface SesSwmsStep {
  number: string;
  activity: string;
  hazards: string;
  initial_risk: "Low" | "Medium" | "High" | "Extreme";
  controls: string;
  residual_risk: "Low" | "Medium" | "High" | "Extreme";
  responsible: string;
}

export interface SesSwmsTemplate {
  kind: SesSwmsTemplateKind;
  label: string;
  source_sha256: string;
  legislation: string[];
  ppe: Array<{ label: string; required: boolean }>;
  licences: string[];
  hrcw_ticked: string[];
  hrcw_note: string;
  steps: SesSwmsStep[];
  emergency: Array<[string, string]>;
  record_keeping: string;
}

export interface SesSwmsGenerationPlan {
  contract_version: typeof SES_SWMS_GENERATION_PLAN_VERSION;
  template_version: typeof SES_SWMS_TEMPLATE_VERSION;
  template: SesSwmsTemplate;
  output_file_name: string;
  job: {
    builder_reference: string;
    job_number: string | null;
    address: string;
    builder_label: string;
    task_activity: string;
    site_contact: string;
    works_date: string;
    arrival: string;
    crew: string;
    authorised_date: string;
    revision: string;
  };
  provenance: {
    source_instruction_id: string;
    source_content_hash: string;
    work_order_pointers: string[];
    trade_report_id: string;
    trade_report_submitted_at: string;
    attendance_cycle_id: string;
    hrcw_categories: string[];
    source_hazard_terms: string[];
    job_fact_sources: Record<string, string>;
  };
}

export interface SesSwmsGenerationBlocker {
  ok: false;
  reason_code:
    | "swms_generation_trade_report_missing"
    | "swms_generation_facts_missing"
    | "swms_generation_template_unavailable";
  reason: string;
  recovery_action: string;
  facts: Record<string, unknown>;
}

export type SesSwmsGenerationPlanResult =
  | { ok: true; plan: SesSwmsGenerationPlan }
  | SesSwmsGenerationBlocker;

export const SES_SWMS_HRCW_ITEMS = [
  "Risk of a person falling more than 2 metres",
  "Work on a telecommunication tower",
  "Demolition of a load-bearing structure",
  "Likely to involve disturbing asbestos",
  "Work on/near pressurised gas mains or piping",
  "Work in or near a confined space",
  "Work in/near a shaft or trench deeper than 1.5m or a tunnel",
  "Use of explosives",
  "Temporary load-bearing support for structural alterations/repairs",
  "Work in/near water or liquid with a risk of drowning",
  "Work on/near energised electrical installations or services",
  "Work that may have a contaminated or flammable atmosphere",
  "Tilt-up or precast concrete elements",
  "Diving work",
  "Work in an area with movement of powered mobile plant",
  "Work in areas with artificial extremes of temperature",
  "Work on/near chemical, fuel or refrigerant lines",
  "Work on/adjacent to a road or traffic corridor in use by traffic",
] as const;

const COMMON_PPE = [
  { label: "Hard Hat", required: true },
  { label: "High-Vis Clothing", required: true },
  { label: "Safety Glasses", required: true },
  { label: "Cut-Resistant Gloves", required: true },
  { label: "Safety Boots", required: true },
];

const GENERAL_TEMPLATE: SesSwmsTemplate = {
  kind: "general_makesafe",
  label: "GENERAL MAKE-SAFE",
  source_sha256:
    "6ca1f2a7d338b210a8e61127ffba3cf1b4eb8de3389dc811f7d5403fc5fc2ed6",
  legislation: [
    "Work Health and Safety Act 2020 (WA)",
    "Work Health and Safety (General) Regulations 2022 (WA)",
    "Code of Practice - How to manage work health and safety risks (WA)",
    "Code of Practice - Construction work (WA)",
    "Code of Practice - Hazardous manual tasks (WA)",
    "Safe Work Australia - guidance on temporary fencing and boundary make-safe",
  ],
  ppe: [
    ...COMMON_PPE,
    { label: "Other: Sunscreen / UV protection", required: true },
    { label: "Hearing Protection", required: false },
    { label: "Face Shield", required: false },
    { label: "Other", required: false },
  ],
  licences: [
    "Construction Induction (White Card) - all workers",
    "Competent person experienced in make-safe / temporary works",
    "First Aid (HLTAID011) - minimum one person on site",
    "Hazardous manual tasks training",
  ],
  hrcw_ticked: [],
  hrcw_note:
    "This task does not clearly trigger a High Risk Construction Work category under the WHS (General) Regulations 2022 (WA). This document is the standard safe-work record for the builder / insurer. If work at height above 2 metres, asbestos disturbance, or temporary load-bearing support is found, stop work and use the matching sealed HRCW template.",
  steps: [
    {
      number: "1",
      activity: "Site set-up, access and pre-start",
      hazards:
        "Vehicle / pedestrian movement; manual handling of equipment; uneven ground and garden beds",
      initial_risk: "Medium",
      controls:
        "Pre-start toolbox talk and site walk; cordon the work area; keep the resident and public clear; check the weather; team-lift loads over 20kg; clear a safe access path.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "2",
      activity: "Assess the damage and isolate the hazard",
      hazards:
        "Unstable or damaged structure or materials; sharp edges; slips and trips; unknown services, glass or nails",
      initial_risk: "Medium",
      controls:
        "Eliminate or isolate the hazard first. Barricade or exclude the public before working. Identify services, glass and sharp material. Stop if the work involves height above 2 metres, suspected asbestos, or load-bearing support.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "3",
      activity: "Make safe / secure the hazard",
      hazards:
        "Manual handling of panels, boards or props; pinch / crush; struck-by; cuts",
      initial_risk: "Medium",
      controls:
        "Use a two-person lift, keep loads close and bend the knees; secure temporary fencing, board-up or propping to sound structure; clamp and ballast temporary fencing; keep fingers clear; check stability before leaving.",
      residual_risk: "Low",
      responsible: "All workers",
    },
    {
      number: "4",
      activity: "Housekeeping and handover",
      hazards:
        "Residual debris or sharp material; trips; public access to the damaged area",
      initial_risk: "Medium",
      controls:
        "Clear and bag debris; remove trip and laceration hazards; confirm the temporary make-safe is stable; exclude the public from remaining hazards; advise that the works are temporary; photograph and document.",
      residual_risk: "Low",
      responsible: "All workers",
    },
  ],
  emergency: [
    ["Emergency Services", "000 (Police / Fire / Ambulance)"],
    [
      "Nearest Hospital",
      "Confirm the nearest public emergency department before work starts.",
    ],
    [
      "First Aid",
      "First-aid kit in the work vehicle. Minimum one HLTAID011-qualified person on site.",
    ],
    [
      "Assembly / Muster Point",
      "Front verge / driveway, clear of the damaged area.",
    ],
    [
      "Stop-Work Authority",
      "Any worker may stop work if the structure is more unstable than expected, a hidden hazard is found, or conditions become unsafe. Notify the lead trade and reassess before resuming.",
    ],
    ["Site Supervisor / Contact", "Marnin (Director) - SecureWorks Group"],
  ],
  record_keeping:
    "Kept accessible on site until the work is complete; retained for at least 2 years if a notifiable incident occurs.",
};

const ROOF_TEMPLATE: SesSwmsTemplate = {
  kind: "roof_makesafe",
  label: "ROOF MAKE-SAFE",
  source_sha256:
    "cdd4f880b2c0e3e0e80fd9c192e3e05caa292862ed94a7abf645caf58e693382",
  legislation: [
    "Work Health and Safety Act 2020 (WA)",
    "Work Health and Safety (General) Regulations 2022 (WA)",
    "Code of Practice - Managing the risk of falls at workplaces (WA)",
    "Code of Practice - Construction work (WA)",
    "Code of Practice - How to manage work health and safety risks (WA)",
    "Code of Practice - Hazardous manual tasks (WA)",
    "AS/NZS 1891.1 - Industrial fall-arrest systems and devices",
    "AS/NZS 1892 - Portable ladders",
  ],
  ppe: [
    ...COMMON_PPE,
    { label: "Other: Fall-arrest harness and lanyard", required: true },
    { label: "Other: Sunscreen / UV protection", required: true },
    { label: "Hearing Protection", required: false },
    { label: "Face Shield", required: false },
    { label: "Other", required: false },
  ],
  licences: [
    "Construction Induction (White Card) - all workers",
    "Working at Heights training - all workers",
    "Competent person experienced in roof access and temporary weatherproofing",
    "First Aid (HLTAID011) - minimum one person on site",
    "Hazardous manual tasks training",
    "Ladder and fall-arrest equipment inspected and within service date",
  ],
  hrcw_ticked: ["Risk of a person falling more than 2 metres"],
  hrcw_note:
    "This task involves roof access and work at height greater than 2 metres, which is High Risk Construction Work under the WHS (General) Regulations 2022 (WA). If energised solar equipment or overhead services are present, apply electrical controls / isolation. If roof sheeting is fibre-cement or suspected asbestos, stop before disturbing it.",
  steps: [
    {
      number: "1",
      activity: "Site set-up, access and pre-start",
      hazards:
        "Vehicle / pedestrian movement; manual handling; uneven ground; wind or rain making the roof unsafe",
      initial_risk: "Medium",
      controls:
        "Pre-start toolbox talk and site walk; do not access the roof in high wind or rain; cordon the area below; keep the resident and public clear; set the ladder on firm level ground at the correct angle and tie it off; team-lift loads over 20kg.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "2",
      activity: "Access the roof and set up fall protection",
      hazards:
        "Fall from height above 2 metres; ladder slip; fragile or storm-damaged roof areas; slips",
      initial_risk: "High",
      controls:
        "Minimise time on the roof and work from the ladder / edge where possible. Use a fall-arrest harness anchored to a rated point; maintain three points of contact; identify and avoid fragile or damaged sections; never work alone at height.",
      residual_risk: "Medium",
      responsible: "All workers",
    },
    {
      number: "3",
      activity: "Install temporary tarping / sheeting / flashing",
      hazards:
        "Fall from height; manual handling; sharp damaged roof material; wind catching materials",
      initial_risk: "High",
      controls:
        "Stay anchored; pass materials up instead of carrying large loads on the ladder; work back toward the access point; secure edges progressively; keep hands clear of sharp edges; do not over-reach.",
      residual_risk: "Medium",
      responsible: "All workers",
    },
    {
      number: "4",
      activity: "Weight and secure temporary weatherproofing",
      hazards:
        "Wind uplift; manual handling of battens / weights; roof trip hazards",
      initial_risk: "Medium",
      controls:
        "Batten and weight the covering so it cannot lift; fix to sound structure only; keep the area tidy; confirm stability before descending.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "5",
      activity: "Descent, housekeeping and handover",
      hazards: "Fall on descent; falling tools / debris; public access",
      initial_risk: "Medium",
      controls:
        "Maintain three points of contact and remain anchored until clear of the edge; lower tools and offcuts; clear debris; advise that weatherproofing is temporary; photograph and document.",
      residual_risk: "Low",
      responsible: "All workers",
    },
  ],
  emergency: [
    ["Emergency Services", "000 (Police / Fire / Ambulance)"],
    [
      "Nearest Hospital",
      "Confirm the nearest public emergency department before work starts.",
    ],
    [
      "First Aid",
      "First-aid kit in the work vehicle. Minimum one HLTAID011-qualified person on site.",
    ],
    [
      "Assembly / Muster Point",
      "Front verge / driveway, clear of the building and falling-object zone.",
    ],
    [
      "Fall from Height",
      "Call 000 immediately. Do not delay rescue of a suspended worker. Provide first aid and do not move a suspected spinal injury unless in immediate danger.",
    ],
    [
      "Stop-Work Authority",
      "Any worker may stop work if weather deteriorates, a roof section is fragile, fall protection is inadequate, or conditions become unsafe.",
    ],
    ["Site Supervisor / Contact", "Marnin (Director) - SecureWorks Group"],
  ],
  record_keeping:
    "Kept accessible on site until the high-risk construction work is complete; retained for at least 2 years if a notifiable incident occurs.",
};

const HARDIE_TEMPLATE: SesSwmsTemplate = {
  kind: "hardie_fence",
  label: "HARDIE / FIBRE-CEMENT FENCE MAKE-SAFE",
  source_sha256:
    "1e03e0fbe4d97f7d810a87836314cda24836df57dcb21fe976ced13fcffbc99a",
  legislation: [
    "Work Health and Safety Act 2020 (WA)",
    "Work Health and Safety (General) Regulations 2022 (WA)",
    "Code of Practice - How to manage and control asbestos in the workplace (WA)",
    "Code of Practice - How to safely remove asbestos (WA)",
    "Code of Practice - Construction work (WA)",
    "Code of Practice - How to manage work health and safety risks (WA)",
    "Code of Practice - Hazardous manual tasks (WA)",
    "Safe Work Australia - guidance on temporary fencing and boundary make-safe",
  ],
  ppe: [
    ...COMMON_PPE,
    { label: "Respiratory Protection (P2)", required: true },
    { label: "Disposable Coveralls (Type 5)", required: true },
    { label: "Other: Sunscreen / UV protection", required: true },
    { label: "Hearing Protection", required: false },
    { label: "Face Shield", required: false },
  ],
  licences: [
    "Construction Induction (White Card) - all workers",
    "Asbestos awareness training - all workers",
    "Competent person experienced in temporary fencing installation",
    "First Aid (HLTAID011) - minimum one person on site",
    "Hazardous manual tasks training",
    "Licensed asbestos removalist if removal exceeds make-safe (>10 sqm non-friable, or any friable)",
  ],
  hrcw_ticked: ["Likely to involve disturbing asbestos"],
  hrcw_note:
    "Existing fibre-cement fence sheeting is presumed asbestos-containing material until confirmed otherwise. Do not cut, drill, snap or water-blast it. If friable asbestos is found, or removal beyond make-safe is required, stop and engage a licensed asbestos removalist.",
  steps: [
    {
      number: "1",
      activity: "Site set-up, access and pre-start",
      hazards:
        "Vehicle / pedestrian movement; manual handling; uneven ground; suspected asbestos materials",
      initial_risk: "Medium",
      controls:
        "Pre-start toolbox talk and site walk; presume fibre-cement sheeting contains asbestos until confirmed; cordon the area; keep the resident and public clear; team-lift loads over 20kg.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "2",
      activity: "Assess and make safe damaged fibre-cement fence",
      hazards:
        "Asbestos fibre release; cracked or broken sheets; sharp edges; manual handling",
      initial_risk: "High",
      controls:
        "Do not cut, drill, snap or water-blast. Keep sheets intact where possible; lightly mist to suppress fibres; wear P2 RPE, disposable coveralls and gloves; lift rather than drag; contain loose fragments; engage a licensed removalist where required.",
      residual_risk: "Medium",
      responsible: "All workers",
    },
    {
      number: "3",
      activity: "Position and install temporary fencing",
      hazards:
        "Heavy panels / ballast; pinch / crush; struck-by if a panel falls",
      initial_risk: "Medium",
      controls:
        "Use two-person lifts; seat panels firmly before release; fit clamps; keep fingers clear of clamps and joins.",
      residual_risk: "Low",
      responsible: "All workers",
    },
    {
      number: "4",
      activity: "Secure and stabilise temporary boundary",
      hazards:
        "Panel instability / wind load; pinch hazards; trips on feet / blocks",
      initial_risk: "Medium",
      controls:
        "Clamp panels and ballast the run; ensure stability against wind; position feet to minimise trip hazards; check before leaving.",
      residual_risk: "Low",
      responsible: "Lead trade",
    },
    {
      number: "5",
      activity: "Decontamination, housekeeping and handover",
      hazards: "Residual ACM fragments; sharp material; public access",
      initial_risk: "Medium",
      controls:
        "Contain and isolate stacked sheets; do not dry sweep potential ACM dust; use wet-wipe / HEPA methods; bag fragments in labelled asbestos waste; decontaminate; advise that material is presumed asbestos awaiting licensed disposal.",
      residual_risk: "Low",
      responsible: "All workers",
    },
  ],
  emergency: [
    ["Emergency Services", "000 (Police / Fire / Ambulance)"],
    [
      "Nearest Hospital",
      "Confirm the nearest public emergency department before work starts.",
    ],
    [
      "First Aid",
      "First-aid kit in the work vehicle. Minimum one HLTAID011-qualified person on site.",
    ],
    [
      "Assembly / Muster Point",
      "Front verge / driveway, clear of the boundary fence.",
    ],
    [
      "Suspected Asbestos Disturbance",
      "Stop work, clear and isolate the area, prevent spread, notify the supervisor, and decontaminate. Do not resume until controlled.",
    ],
    [
      "Stop-Work Authority",
      "Any worker may stop work if asbestos is disturbed, a panel is unstable, or conditions become unsafe.",
    ],
    ["Site Supervisor / Contact", "Marnin (Director) - SecureWorks Group"],
  ],
  record_keeping:
    "Kept accessible on site until the high-risk construction work is complete; retained for at least 2 years if a notifiable incident occurs.",
};

export const SES_SWMS_TEMPLATES: Record<SesSwmsTemplateKind, SesSwmsTemplate> =
  {
    general_makesafe: GENERAL_TEMPLATE,
    roof_makesafe: ROOF_TEMPLATE,
    hardie_fence: HARDIE_TEMPLATE,
  };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function slug(value: unknown): string {
  return firstText(value)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "not-recorded";
}

function formatDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${String(parsed.getUTCDate()).padStart(2, "0")}/${
    String(parsed.getUTCMonth() + 1).padStart(2, "0")
  }/${parsed.getUTCFullYear()}`;
}

function isValidDateValue(value: string): boolean {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function templateKind(
  input: SesAssemblerInputV1,
  taskActivity: string,
): { ok: true; kind: SesSwmsTemplateKind } | SesSwmsGenerationBlocker {
  const categories = new Set(input.hrcw.categories);
  const hazardText = [
    ...input.hrcw.source_hazard_terms,
    input.source.instruction_text || "",
    taskActivity,
  ].join(" ").toLowerCase();
  const asbestos = categories.has("asbestos") ||
    /\b(asbestos|acm|hardie|super\s*six|fibre[-\s]?cement)\b/.test(hazardText);
  const workAtHeight = categories.has("work_at_height") ||
    /\b(work(?:ing)? at height|height[^.]{0,20}(?:2\s*m|two metres)|roof access|fall arrest)\b/
      .test(hazardText);
  const structural = categories.has("structural") ||
    /\b(temporary load[-\s]?bearing support|structural support)\b/.test(
      hazardText,
    );
  const other = categories.has("other_registered_hrcw");

  if (
    input.hrcw.hrcw &&
    !asbestos &&
    !workAtHeight &&
    !structural &&
    !other
  ) {
    return {
      ok: false,
      reason_code: "swms_generation_facts_missing",
      reason:
        "The job is marked as HRCW, but the real hazard category is missing from the canonical work-order and trade-report facts.",
      recovery_action:
        "Complete the HRCW category from the work order or field trade report and re-run U4; staff do not need to attach a SWMS.",
      facts: {
        hrcw: true,
        hrcw_categories: [...categories].sort(),
        source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
      },
    };
  }

  if (structural || other || (asbestos && workAtHeight)) {
    return {
      ok: false,
      reason_code: "swms_generation_template_unavailable",
      reason:
        "The job facts require an HRCW control set that is not covered by one sealed SecureWorks SWMS template.",
      recovery_action:
        "Captain must seal the matching structural, other-HRCW, or combined-hazard template; U4 will then generate it automatically.",
      facts: {
        hrcw_categories: [...categories].sort(),
        source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
        detected_asbestos: asbestos,
        detected_work_at_height: workAtHeight,
        detected_structural: structural,
        detected_other_registered_hrcw: other,
      },
    };
  }

  if (asbestos) {
    if (
      !/\b(fence|fencing|hardie|super\s*six|fibre[-\s]?cement)\b/.test(
        hazardText,
      )
    ) {
      return {
        ok: false,
        reason_code: "swms_generation_template_unavailable",
        reason:
          "Asbestos is evidenced, but the sealed asbestos template is specific to fibre-cement fence make-safe work.",
        recovery_action:
          "Captain must seal the applicable asbestos-work template; U4 will then generate it automatically.",
        facts: {
          hrcw_categories: [...categories].sort(),
          source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
        },
      };
    }
    return { ok: true, kind: "hardie_fence" };
  }

  if (workAtHeight) {
    if (!/\b(roof|tarp|flashing|tile|weatherproof)\b/.test(hazardText)) {
      return {
        ok: false,
        reason_code: "swms_generation_template_unavailable",
        reason:
          "Work at height is evidenced, but the sealed height template is specific to roof make-safe work.",
        recovery_action:
          "Captain must seal the applicable work-at-height template; U4 will then generate it automatically.",
        facts: {
          hrcw_categories: [...categories].sort(),
          source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
        },
      };
    }
    return { ok: true, kind: "roof_makesafe" };
  }

  if (input.hrcw.source_hazard_terms.length > 0) {
    return {
      ok: false,
      reason_code: "swms_generation_template_unavailable",
      reason:
        "The source names an HRCW hazard, but it does not map to a sealed SecureWorks SWMS control set.",
      recovery_action:
        "Captain must classify the real hazard against a sealed SWMS template; U4 will then generate it automatically.",
      facts: {
        hrcw_categories: [...categories].sort(),
        source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
      },
    };
  }

  return { ok: true, kind: "general_makesafe" };
}

export function buildSesSwmsGenerationPlan(
  input: SesAssemblerInputV1,
): SesSwmsGenerationPlanResult {
  const report = record(input.cycle_facts.trade_report);
  if (!Object.keys(report).length) {
    return {
      ok: false,
      reason_code: "swms_generation_trade_report_missing",
      reason:
        "U4 cannot generate the job-specific SWMS until the current-cycle field trade report is submitted.",
      recovery_action:
        "Submit the current-cycle field trade report and photos, then re-run U4; staff do not need to attach a SWMS.",
      facts: {
        attendance_cycle_id: input.attendance.current_attendance_cycle_id,
        work_order_pointers: [...input.source.attachment_pointers].sort(),
      },
    };
  }

  const checklist = record(report.checklist_json);
  const taskActivity = firstText(
    checklist.works_completed,
    checklist.works,
    checklist.work_done,
    checklist.scope,
    checklist.damage_description,
    report.notes,
    input.source.instruction_text,
  );
  const builderReference = firstText(input.source.builder_reference);
  const address = [
    firstText(input.source.site_address),
    firstText(input.source.site_suburb),
  ].filter(Boolean).join(", ");
  const submittedAt = firstText(report.submitted_at);
  const worksDateRaw = firstText(
    checklist.attendance_date,
    checklist.date_of_works,
  );
  const arrival = firstText(checklist.arrival_time, checklist.arrived_at);
  const crew = firstText(checklist.crew_name, checklist.crew);
  const siteContact = firstText(
    checklist.site_contact,
    checklist.contact_name,
    checklist.client_name,
  );
  const missing = [
    !builderReference ? "builder_reference" : "",
    !address ? "site_address" : "",
    !taskActivity ? "trade_report_task_activity" : "",
    !isValidDateValue(worksDateRaw) ? "works_date" : "",
    !arrival ? "arrival_time" : "",
    !crew ? "crew" : "",
    !siteContact ? "site_contact" : "",
    !isValidDateValue(submittedAt) ? "trade_report_submitted_at" : "",
  ].filter(Boolean);
  if (missing.length) {
    return {
      ok: false,
      reason_code: "swms_generation_facts_missing",
      reason: `U4 cannot generate the job-specific SWMS because ${
        missing.join(", ")
      } is missing from the work order or current-cycle trade report.`,
      recovery_action:
        "Complete the named work-order or trade-report facts and re-run U4; staff do not need to attach a SWMS.",
      facts: { missing_facts: missing },
    };
  }

  const selected = templateKind(input, taskActivity);
  if (!selected.ok) return selected;

  const worksDate = formatDate(worksDateRaw);
  const authorisedDate = formatDate(submittedAt);
  const tradeReportId = firstText(report.id) ||
    `current-cycle:${input.attendance.current_attendance_cycle_id}`;

  const template = SES_SWMS_TEMPLATES[selected.kind];
  return {
    ok: true,
    plan: {
      contract_version: SES_SWMS_GENERATION_PLAN_VERSION,
      template_version: SES_SWMS_TEMPLATE_VERSION,
      template,
      output_file_name: `SWMS - ${slug(builderReference)} - ${
        slug(address)
      }.pdf`,
      job: {
        builder_reference: builderReference,
        job_number: input.identity.job_number,
        address,
        builder_label: input.classification.builder_label,
        task_activity: taskActivity,
        site_contact: siteContact,
        works_date: worksDate,
        arrival,
        crew,
        authorised_date: authorisedDate,
        revision: `Rev 1 - ${authorisedDate}`,
      },
      provenance: {
        source_instruction_id: input.identity.source_instruction_id,
        source_content_hash: input.identity.source_content_hash,
        work_order_pointers: [...input.source.attachment_pointers].sort(),
        trade_report_id: tradeReportId,
        trade_report_submitted_at: submittedAt,
        attendance_cycle_id: input.attendance.current_attendance_cycle_id,
        hrcw_categories: [...input.hrcw.categories].sort(),
        source_hazard_terms: [...input.hrcw.source_hazard_terms].sort(),
        job_fact_sources: {
          builder_reference: "work_order",
          address: "work_order",
          task_activity: taskActivity === input.source.instruction_text
            ? "work_order"
            : "trade_report",
          site_contact: "trade_report",
          works_date: "trade_report",
          arrival: "trade_report",
          crew: "trade_report",
        },
      },
    },
  };
}
