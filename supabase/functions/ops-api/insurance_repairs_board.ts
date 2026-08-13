// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client and canonical board rows are intentionally
// untyped at this boundary, matching the sibling board read-model modules.

export const INSURANCE_REPAIR_STAGES = [
  "wo_in",
  "scoping",
  "quoted",
  "variation",
  "approved",
  "materials",
  "scheduled",
  "on_site",
  "complete",
] as const;

export type InsuranceRepairStage = (typeof INSURANCE_REPAIR_STAGES)[number];

const INSURANCE_REPAIR_STAGE_SET = new Set<string>(INSURANCE_REPAIR_STAGES);

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Repair authority is additive because the three live correction vintages do
 * not all carry the same field. This deliberately mirrors the canonical SES
 * family reader: a reviewed metadata family, the correction-era ses_family,
 * or the legacy detail report_type may establish repair. Generic prose cannot.
 */
export function isInsuranceRepairFamily(row: any): boolean {
  if (token(row?.ses_family) === "repair") return true;
  if (token(row?.family) === "repair") return true;
  if (token(row?.type) === "repair") return true;
  if (token(row?.metadata?.makesafe_job_family) === "repair") return true;
  if (token(row?.metadata?.ses_family) === "repair") return true;
  return token(row?.makesafe_details?.report_type) === "repair";
}

/**
 * The Repairs tab owns a nine-stage presentation vocabulary. Existing repair
 * cards predate that field, so their lawful jobs.status is mapped without a
 * data rewrite; once a repair_stage stamp exists it wins.
 */
export function insuranceRepairStage(row: any): InsuranceRepairStage {
  const explicit = token(row?.repair_stage || row?.metadata?.repair_stage);
  if (INSURANCE_REPAIR_STAGE_SET.has(explicit)) {
    return explicit as InsuranceRepairStage;
  }

  switch (token(row?.status || row?.job_state)) {
    case "scoping":
    case "scope":
    case "assessing":
      return "scoping";
    case "quoted":
    case "quote_sent":
    case "quote":
      return "quoted";
    case "variation":
    case "variation_pending":
      return "variation";
    case "accepted":
    case "approved":
    case "approvals":
    case "awaiting_deposit":
    case "deposit":
      return "approved";
    case "order_materials":
    case "materials":
    case "ordering":
    case "awaiting_supplier":
    case "order_confirmed":
      return "materials";
    case "schedule_install":
    case "scheduled":
      return "scheduled";
    case "processing":
    case "in_progress":
    case "on_site":
    case "rectification":
      return "on_site";
    case "complete":
    case "completed":
    case "final_payment":
    case "invoiced":
    case "archived":
      return "complete";
    default:
      return "wo_in";
  }
}

/** The pipeline card shape consumed by the merged Repairs UX tab. */
export function projectInsuranceRepairPipelineRow(row: any): any {
  const projected = { ...row };
  delete projected.metadata;
  return {
    ...projected,
    source_type: row?.type || null,
    type: "repair",
    job_type: "repair",
    family: "repair",
    ses_family: "repair",
    repair_stage: insuranceRepairStage(row),
  };
}

export function excludeInsuranceRepairs(rows: readonly any[]): any[] {
  return (rows || []).filter((row) => !isInsuranceRepairFamily(row));
}

/**
 * Resolve the bounded set before the normal pipeline read. Every query is
 * narrow and errors fail loudly: an empty Repairs board is business-meaningful
 * and may not be fabricated from a PostgREST 400.
 */
export async function loadInsuranceRepairJobIds(
  client: any,
  orgId: string,
): Promise<string[]> {
  const reads = await Promise.all([
    client.from("jobs").select("id").eq("org_id", orgId).eq(
      "type",
      "repair",
    ),
    client.from("jobs").select("id").eq("org_id", orgId).eq(
      "metadata->>makesafe_job_family",
      "repair",
    ),
    client.from("jobs").select("id").eq("org_id", orgId).eq(
      "metadata->>ses_family",
      "repair",
    ),
    client.from("makesafe_job_details").select("job_id").eq(
      "report_type",
      "repair",
    ),
  ]);

  const labels = [
    "jobs.type",
    "jobs.metadata.makesafe_job_family",
    "jobs.metadata.ses_family",
    "makesafe_job_details.report_type",
  ];
  for (let i = 0; i < reads.length; i++) {
    if (reads[i]?.error) {
      throw new Error(
        `insurance repairs authority read failed (${labels[i]}): ${
          reads[i].error.message || reads[i].error
        }`,
      );
    }
  }

  const ids = new Set<string>();
  for (let i = 0; i < reads.length; i++) {
    const key = i === reads.length - 1 ? "job_id" : "id";
    for (const row of reads[i]?.data || []) {
      const id = String(row?.[key] || "");
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
