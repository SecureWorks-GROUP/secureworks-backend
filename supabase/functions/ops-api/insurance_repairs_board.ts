// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client and canonical board rows are intentionally
// untyped at this boundary, matching the sibling board read-model modules.

import { extractBuilderWorkOrderIdentity } from "./makesafe_builder_work_order_identity.ts";

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

function cleanRef(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

interface BuilderRefParts {
  work_order: string | null;
  purchase_order: string | null;
}

/**
 * Split a stored builder reference into its two instruction numbers using the
 * sealed identity grammar in `makesafe_builder_work_order_identity.ts` — the one
 * owner of what a fused "WO+PO" string looks like. No second grammar lives here.
 *
 * `projectMakesafeJobIdentity` is the sibling read model over the same metadata
 * keys, and it is deliberately NOT delegated to: it refuses to split a fused
 * value (its own stated contract) and drops `builder_work_order_number` whenever
 * ANY purchase order is present, which would blank the work-order slot on the
 * captain's worked Pingelly card (bare MLB-24645 stamped beside PO-59875).
 * Splitting is strictly stronger — it answers the fused case AND keeps the bare
 * one — and nothing is invented: both halves are read out of the stored string.
 */
function splitBuilderRef(value: unknown): BuilderRefParts {
  const text = cleanRef(value);
  if (!text) return { work_order: null, purchase_order: null };
  const identity = extractBuilderWorkOrderIdentity({ externalRef: text });
  if (identity.builder_po_number && identity.builder_claim_ref) {
    return {
      work_order: identity.builder_claim_ref,
      purchase_order: identity.builder_po_number,
    };
  }
  return { work_order: text, purchase_order: null };
}

function detailCompanyRow(detail: any): any {
  const embedded = detail?.makesafe_companies;
  if (Array.isArray(embedded)) return embedded[0] || null;
  return embedded && typeof embedded === "object" ? embedded : null;
}

/**
 * The pipeline card shape consumed by the merged Repairs UX tab.
 *
 * A repair operator reconciles the card against the builder's paperwork, so the
 * card must carry BOTH instruction numbers (captain requirement, 2026-08-31):
 * the builder's work-order reference (e.g. MLB-24645) and the purchase order
 * (e.g. PO-59875). Those live in `jobs.metadata`, which this projection
 * deliberately strips — so they are lifted onto named card fields first.
 *
 * `metadata.external_ref` outranks `builder_work_order_number` for the
 * work-order slot because one live vintage fuses WO and PO into the latter
 * ("MLB-25147PO-56236" on SWMS-261029) while `external_ref` carries the bare
 * reference. Preference alone is not the defence though: EVERY candidate goes
 * through `splitBuilderRef`, so a fused value can never reach the work-order
 * slot whichever key supplied it, and the purchase order it carries is read
 * rather than lost. `external_ref` is fused on live rows too — SWMS-261118
 * carries "MLB-26344PO-57087".
 *
 * `makesafe_job_details` is the fallback store for both the reference and the
 * issuing company: `jobs.metadata` is ~91% populated while the detail row's
 * `external_ref` is 100%, and a legacy or backfilled repair card admitted by
 * `makesafe_job_details.report_type='repair'` may carry no metadata at all.
 * Company resolves detail-first, matching the make-safe board.
 *
 * Absent fields project null; the card simply has nothing to show for them, and
 * nothing is ever fabricated on a reconciliation surface.
 */
export function projectInsuranceRepairPipelineRow(
  row: any,
  detail?: any,
): any {
  const projected = { ...row };
  delete projected.metadata;
  const meta = row?.metadata && typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
    ? row.metadata
    : {};
  const detailRow =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? detail
      : {};
  const company =
    meta.requesting_company && typeof meta.requesting_company === "object"
      ? meta.requesting_company
      : null;
  const detailCompany = detailCompanyRow(detailRow);
  const candidates = [
    splitBuilderRef(meta.external_ref),
    splitBuilderRef(detailRow.external_ref),
    splitBuilderRef(meta.builder_work_order_number),
    splitBuilderRef(meta.builder_claim_ref),
  ];
  const workOrderRef =
    candidates.map((part) => part.work_order).find((value) => value !== null) ??
      null;
  const purchaseOrder = cleanRef(meta.builder_po_number) ??
    candidates.map((part) => part.purchase_order).find((value) =>
      value !== null
    ) ?? null;
  return {
    ...projected,
    source_type: row?.type || null,
    type: "repair",
    job_type: "repair",
    family: "repair",
    ses_family: "repair",
    repair_stage: insuranceRepairStage(row),
    builder_work_order_ref: workOrderRef,
    builder_po_number: purchaseOrder,
    builder_company_name: cleanRef(detailRow.requesting_company_name) ??
      cleanRef(detailCompany?.name) ?? cleanRef(company?.name),
    builder_company_slug: cleanRef(detailRow.requesting_company_slug) ??
      cleanRef(detailCompany?.slug) ?? cleanRef(company?.slug),
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

/** PostgREST GET URL budget: repair ids are UUIDs, so keep `.in()` bounded. */
const REPAIR_DETAIL_ID_CHUNK = 50;

export const INSURANCE_REPAIR_DETAIL_SELECT =
  "job_id, external_ref, requesting_company_slug, requesting_company_name, " +
  "makesafe_companies:requesting_company_id(slug, name)";

/**
 * The detail-store half of the card's builder identity. Kept separate from the
 * id read because a repair card admitted by `jobs.type` or the metadata family
 * has no row in that `report_type='repair'` query, yet may still hold the only
 * populated `external_ref` and issuing company in `makesafe_job_details`.
 *
 * Fails loud for the same reason the id read does: a card silently missing an
 * instruction number is a false reconciliation surface, and a PostgREST 400
 * degrades to `data: null` rather than throwing.
 */
export async function loadInsuranceRepairJobDetails(
  client: any,
  jobIds: readonly string[],
): Promise<Map<string, any>> {
  const details = new Map<string, any>();
  const ids = [
    ...new Set((jobIds || []).map((id) => String(id || "")).filter(Boolean)),
  ];
  for (let i = 0; i < ids.length; i += REPAIR_DETAIL_ID_CHUNK) {
    const chunk = ids.slice(i, i + REPAIR_DETAIL_ID_CHUNK);
    const { data, error } = await client
      .from("makesafe_job_details")
      .select(INSURANCE_REPAIR_DETAIL_SELECT)
      .in("job_id", chunk);
    if (error) {
      throw new Error(
        `insurance repairs detail read failed: ${error.message || error}`,
      );
    }
    for (const row of data || []) {
      const id = String(row?.job_id || "");
      if (id) details.set(id, row);
    }
  }
  return details;
}
