// deno-lint-ignore-file no-explicit-any
// Privileged Phase-1 comparison loader. Default board reads never import data
// through this path; every compare-mode join is complete-or-throw.
import { fetchAllRowsInChunks } from "./makesafe_compact_reads.ts";
import { checkMakesafeBoardParity } from "./makesafe_board_read_model.ts";
import {
  computeAttendanceCycleSetHash,
  computeMakesafeReadinessRevision,
  type ReadinessDependencyEnvelope,
  readinessDependencyErrors,
  type Sha256Revision,
  type VersionedDependency,
} from "./makesafe_readiness_revision.ts";
import {
  canonicalizeMakesafeDocumentRole,
  type BlockerFact,
  type CancellationDimension,
  diffV1V2State,
  EMPTY_CANCELLATION,
  EMPTY_TERMINAL_PROOF,
  MAKESAFE_BOARD_V2_CONTRACT_VERSION,
  MAKESAFE_STATE_CONTRACT_VERSION,
  type MakesafeFamilyRule,
  type MakesafeStateInput,
  type MakesafeStateV2,
  projectMakesafeStateV2,
  type ReadinessDimension,
  type TerminalProofDimension,
  type V1V2Diff,
  type VersionedCycleFact,
} from "./makesafe_state_projection.ts";

export interface MakesafeComparisonHealth {
  complete: true;
  requested_job_count: number;
  projected_job_count: number;
  differing_job_count: number;
  projection_input_error_job_count: number;
  duplicate_job_ids: string[];
}

export interface MakesafeComparisonResult {
  rows: any[];
  projection_health: MakesafeComparisonHealth;
}

export interface MakesafeV2FactSet {
  projectionConfig: {
    default_contract_version: "v1" | "v2";
    compare_enabled: boolean;
    authority_flipped: boolean;
  };
  jobFamilies: any[];
  identities: any[];
  cycles: any[];
  cases: any[];
  assignments: any[];
  serviceReports: any[];
  documents: any[];
  media: any[];
  portalCaptures: any[];
  familyRules: any[];
  readiness: any[];
  holds: any[];
  cancellations: any[];
  terminalProofs: any[];
  packCycles: any[];
  packs: any[];
  approvals: any[];
  details: any[];
  dockets: any[];
}

const SELECTS = {
  identities:
    "id,job_id,authority_kind,effective_case_id,source_instruction_id,source_version,source_content_hash,lineage_id,lineage_version,lineage_correction_hash,lineage_supersession_hash,intake_state,family_state,family_rule_key,evidence_refs,revision_hash",
  cycles:
    "id,job_id,cycle_number,opened_at,closed_at,makesafe_fact_version,makesafe_content_hash",
  cases:
    "id,job_id,instruction_key,lineage_id,state,state_version,source_version,source_content_hash,lineage_version,lineage_correction_hash,lineage_supersession_hash,updated_at",
  assignments:
    "id,job_id,status,attendance_cycle_id,cycle_attribution,makesafe_fact_version,makesafe_content_hash",
  serviceReports:
    "id,job_id,status,attendance_cycle_id,cycle_attribution,makesafe_fact_version,makesafe_content_hash",
  documents:
    "id,job_id,type,attendance_cycle_id,cycle_attribution,makesafe_fact_version,makesafe_content_hash",
  media:
    "id,job_id,type,phase,attendance_cycle_id,cycle_attribution,makesafe_fact_version,makesafe_content_hash",
  portalCaptures:
    "id,job_id,attendance_cycle_id,role,status,makesafe_fact_version,makesafe_content_hash",
  familyRules:
    "id,family_code,family_kind,matrix_revision,matrix_content_hash,completion_photo_floor,required_document_types,required_portal_roles",
  readiness:
    "job_id,dependency_generation,readiness_revision,attendance_cycle_set_hash,ready,invalidated_at,invalidation_reason,dependency_envelope",
  holds:
    "id,job_id,attendance_cycle_id,blocker_code,owner_role,recovery_action,recovery_instruction,evidence_refs,created_at,lifted_at,note",
  cancellations:
    "id,job_id,attendance_cycle_set_hash,state,reason_code,note,decided_by,decided_at",
  terminalProofs:
    "id,job_id,kind,attendance_cycle_ids,attendance_cycle_set_hash,readiness_revision,release_revision_id,closeout_revision_id,evidence_refs,proven_at",
  packCycles: "id,pack_id,job_id,attendance_cycle_id,cycle_attribution",
  packs:
    "id,job_id,status,review_state,needs_money_review,last_render_hash,makesafe_fact_version,makesafe_content_hash",
  approvals:
    "id,job_id,action,decision,readiness_revision,dependency_generation,docket_revision_id,release_revision_id,decided_at",
  jobFamilies: "id,metadata",
  details:
    "job_id,substatus,cycle_number,report_type,reopen_reason,reattend_count,last_reattend_at,last_reattend_reason,cancel_reason,cancel_note,cancelled_by,cancelled_at,report_received_at,report_sent_at,invoice_ready_at,invoice_notes,safety_requirements,special_instructions,external_links,billing_rules,updated_at",
  dockets:
    "id,job_id,source_instruction_id,lineage_id,attendance_cycle_ids,current_attendance_cycle_id,readiness_revision,input_content_hash,output_content_hash,state,pre_xero_docs_ready,envelope,review_spec,release_payload,committed_at",
} as const;

async function loadByIds(
  client: any,
  table: string,
  columns: string,
  ids: string[],
  label: string,
  uniqueKey = "id",
  filterColumn = "job_id",
): Promise<any[]> {
  return await fetchAllRowsInChunks<any>(
    ids,
    (chunk) => client.from(table).select(columns).in(filterColumn, chunk),
    label,
    uniqueKey,
  );
}

export async function loadMakesafeV2Facts(
  client: any,
  jobIds: string[],
  familyCodes: string[],
): Promise<MakesafeV2FactSet> {
  const { data: projectionConfig, error: configError } = await client
    .from("makesafe_state_projection_config")
    .select("default_contract_version,compare_enabled,authority_flipped")
    .eq("singleton", true)
    .maybeSingle();
  if (configError) {
    throw new Error(
      `makesafe-state.v2 projection config failed: ${configError.message}`,
    );
  }
  if (!projectionConfig || projectionConfig.compare_enabled !== true) {
    throw new Error("makesafe-state.v2 comparison is not enabled");
  }
  const [
    jobFamilies,
    identities,
    cycles,
    cases,
    assignments,
    serviceReports,
    documents,
    media,
    portalCaptures,
    readiness,
    holds,
    cancellations,
    terminalProofs,
    packCycles,
    packs,
    approvals,
    details,
    dockets,
  ] = await Promise.all([
    loadByIds(
      client,
      "jobs",
      SELECTS.jobFamilies,
      jobIds,
      "makesafe-state.v2 job family identity",
      "id",
      "id",
    ),
    loadByIds(
      client,
      "makesafe_state_identity_current_v2",
      SELECTS.identities,
      jobIds,
      "makesafe-state.v2 selected identity",
      "job_id",
    ),
    loadByIds(
      client,
      "makesafe_attendance_cycles",
      SELECTS.cycles,
      jobIds,
      "makesafe-state.v2 attendance cycles",
    ),
    loadByIds(
      client,
      "makesafe_intake_cases",
      SELECTS.cases,
      jobIds,
      "makesafe-state.v2 intake identity",
    ),
    loadByIds(
      client,
      "job_assignments",
      SELECTS.assignments,
      jobIds,
      "makesafe-state.v2 assignments",
    ),
    loadByIds(
      client,
      "job_service_reports",
      SELECTS.serviceReports,
      jobIds,
      "makesafe-state.v2 service reports",
    ),
    loadByIds(
      client,
      "job_documents",
      SELECTS.documents,
      jobIds,
      "makesafe-state.v2 documents",
    ),
    loadByIds(
      client,
      "job_media",
      SELECTS.media,
      jobIds,
      "makesafe-state.v2 media",
    ),
    loadByIds(
      client,
      "makesafe_portal_capture_revisions",
      SELECTS.portalCaptures,
      jobIds,
      "makesafe-state.v2 portal captures",
    ),
    loadByIds(
      client,
      "makesafe_readiness_current_v2",
      SELECTS.readiness,
      jobIds,
      "makesafe-state.v2 readiness",
      "job_id",
    ),
    loadByIds(
      client,
      "makesafe_status_holds",
      SELECTS.holds,
      jobIds,
      "makesafe-state.v2 holds",
    ),
    loadByIds(
      client,
      "makesafe_cancellation_current_v2",
      SELECTS.cancellations,
      jobIds,
      "makesafe-state.v2 cancellations",
      "job_id",
    ),
    loadByIds(
      client,
      "makesafe_terminal_proofs_current_v2",
      SELECTS.terminalProofs,
      jobIds,
      "makesafe-state.v2 terminal proofs",
      "job_id",
    ),
    loadByIds(
      client,
      "makesafe_report_pack_cycles",
      SELECTS.packCycles,
      jobIds,
      "makesafe-state.v2 pack cycles",
    ),
    loadByIds(
      client,
      "makesafe_report_packs",
      SELECTS.packs,
      jobIds,
      "makesafe-state.v2 packs",
    ),
    loadByIds(
      client,
      "makesafe_revision_approvals",
      SELECTS.approvals,
      jobIds,
      "makesafe-state.v2 approvals",
    ),
    loadByIds(
      client,
      "makesafe_job_details",
      SELECTS.details,
      jobIds,
      "makesafe-state.v2 job details",
      "job_id",
    ),
    loadByIds(
      client,
      "makesafe_docket_revisions_current",
      SELECTS.dockets,
      jobIds,
      "makesafe-state.v2 dockets",
      "job_id",
    ),
  ]);
  const effectiveFamilyCodes = familyCodes.length ? familyCodes : identities
    .map((row) => String(row?.family_rule_key || "").trim())
    .filter(Boolean);
  const loadedJobIds = new Set(
    jobFamilies.map((row) => String(row?.id || "")).filter(Boolean),
  );
  const missingJobIds = [...new Set(jobIds)].filter((id) =>
    id && !loadedJobIds.has(id)
  );
  if (missingJobIds.length) {
    throw new Error(
      `makesafe-state.v2 job identity join incomplete: ${
        missingJobIds.join(",")
      }`,
    );
  }
  const familyRules = effectiveFamilyCodes.length
    ? await fetchAllRowsInChunks<any>(
      effectiveFamilyCodes,
      (chunk) =>
        client.from("makesafe_family_rules_current_v2")
          .select(SELECTS.familyRules)
          .in("family_code", chunk),
      "makesafe-state.v2 family rules",
      "family_code",
    )
    : [];
  return {
    projectionConfig,
    jobFamilies,
    identities,
    cycles,
    cases,
    assignments,
    serviceReports,
    documents,
    media,
    portalCaptures,
    familyRules,
    readiness,
    holds,
    cancellations,
    terminalProofs,
    packCycles,
    packs,
    approvals,
  };
}

function groupBy(rows: any[], key: string): Map<string, any[]> {
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const value = String(row?.[key] || "");
    if (!value) continue;
    grouped.set(value, [...(grouped.get(value) || []), row]);
  }
  return grouped;
}

function oneBy(rows: any[], key: string): Map<string, any> {
  const grouped = groupBy(rows, key);
  const result = new Map<string, any>();
  for (const [id, values] of grouped) {
    if (values.length === 1) result.set(id, values[0]);
  }
  return result;
}

function versionedFact(row: any): VersionedCycleFact {
  const rawRole = row?.role || row?.type || null;
  return {
    id: String(row?.id || ""),
    attendance_cycle_id: row?.attendance_cycle_id || null,
    version: Number.isSafeInteger(Number(row?.makesafe_fact_version))
      ? Number(row.makesafe_fact_version)
      : null,
    content_hash: row?.makesafe_content_hash || null,
    status: row?.status || null,
    role: rawRole,
  };
}

function versionedDependencies(rows: any[]): VersionedDependency[] {
  return rows.map((row) => ({
    id: String(row?.id || ""),
    version: Number(row?.makesafe_fact_version || 0),
    content_hash: String(row?.makesafe_content_hash || "") as Sha256Revision,
  }));
}

function readinessOf(row: any): ReadinessDimension {
  if (!row) {
    return {
      state: "absent",
      ready: false,
      readiness_revision: null,
      dependency_generation: 0,
      attendance_cycle_set_hash: null,
      invalidated_at: null,
      invalidation_reason: null,
    };
  }
  return {
    state: row.ready ? "ready" : row.readiness_revision ? "invalid" : "absent",
    ready: row.ready === true,
    readiness_revision: row.readiness_revision || null,
    dependency_generation: Number(row.dependency_generation || 0),
    attendance_cycle_set_hash: row.attendance_cycle_set_hash || null,
    invalidated_at: row.invalidated_at || null,
    invalidation_reason: row.invalidation_reason || null,
  };
}

function cancellationOf(row: any): CancellationDimension {
  if (!row) return EMPTY_CANCELLATION();
  return {
    state: row.state,
    reason_code: row.reason_code || null,
    note: row.note || null,
    decided_by: row.decided_by || null,
    decided_at: row.decided_at || null,
    decision_id: row.id || null,
  };
}

function terminalProofOf(row: any): TerminalProofDimension {
  if (!row) return EMPTY_TERMINAL_PROOF();
  return {
    state: "valid",
    proof_id: row.id || null,
    kind: row.kind || null,
    attendance_cycle_ids: Array.isArray(row.attendance_cycle_ids)
      ? row.attendance_cycle_ids
      : [],
    readiness_revision: row.readiness_revision || null,
    release_revision_id: row.release_revision_id || null,
    closeout_revision_id: row.closeout_revision_id || null,
    proven_at: row.proven_at || null,
    evidence_refs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
  };
}

function operatorBlockerOf(row: any): BlockerFact | null {
  if (!row?.blocker_code || row?.lifted_at) return null;
  return {
    code: row.blocker_code,
    source: "operator",
    severity: "hard",
    attendance_cycle_id: row.attendance_cycle_id || null,
    reason: row.note || row.blocker_code,
    held_since: row.created_at,
    owner_role: row.owner_role,
    recovery_action: row.recovery_action,
    recovery_instruction: row.recovery_instruction,
    evidence_refs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
  } as BlockerFact;
}

function familyRuleOf(row: any): MakesafeFamilyRule | null {
  if (!row) return null;
  const completionPhotoFloor = Number(row.completion_photo_floor);
  return {
    code: row.family_code,
    kind: row.family_kind,
    matrix_revision: row.matrix_revision,
    matrix_content_hash: row.matrix_content_hash,
    completion_photo_floor:
      Number.isSafeInteger(completionPhotoFloor) && completionPhotoFloor >= 0
        ? completionPhotoFloor
        : undefined,
    required_document_types: Array.isArray(row.required_document_types)
      ? row.required_document_types
      : [],
    required_portal_roles: Array.isArray(row.required_portal_roles)
      ? row.required_portal_roles
      : [],
  };
}

function hasDuplicateIds(rows: any[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = String(row?.id || "");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

export async function buildMakesafeV2Comparison(
  canonicalRows: any[],
  facts: MakesafeV2FactSet,
  computedAt: string,
): Promise<MakesafeComparisonResult> {
  const duplicateJobIds = hasDuplicateIds(canonicalRows);
  if (duplicateJobIds.length) {
    throw new Error(
      `makesafe-state.v2 duplicate canonical job ids: ${
        duplicateJobIds.join(",")
      }`,
    );
  }
  const cycles = groupBy(facts.cycles, "job_id");
  const identities = oneBy(facts.identities, "job_id");
  const assignments = groupBy(facts.assignments, "job_id");
  const serviceReports = groupBy(facts.serviceReports, "job_id");
  const documents = groupBy(facts.documents, "job_id");
  const media = groupBy(facts.media, "job_id");
  const portalCaptures = groupBy(facts.portalCaptures, "job_id");
  const readiness = oneBy(facts.readiness, "job_id");
  const holds = groupBy(facts.holds, "job_id");
  const cancellations = oneBy(facts.cancellations, "job_id");
  const terminalProofs = oneBy(facts.terminalProofs, "job_id");
  const packCycles = groupBy(facts.packCycles, "job_id");
  const packs = groupBy(facts.packs, "job_id");
  const approvals = groupBy(facts.approvals, "job_id");
  const rules = oneBy(facts.familyRules, "family_code");
  const jobFamilies = oneBy(facts.jobFamilies, "id");
  let differing = 0;
  let inputErrors = 0;

  const rows = await Promise.all(canonicalRows.map(async (row) => {
    const jobId = String(row?.id || "");
    const jobFamily = jobFamilies.get(jobId);
    const identityRevision = identities.get(jobId) || null;
    const cycleRows = cycles.get(jobId) || [];
    const cycleIds = cycleRows.map((cycle) => String(cycle.id)).sort();
    const currentCycleId = row?.attendance_cycle_id || null;
    const cycleSetHash = cycleIds.length
      ? await computeAttendanceCycleSetHash(cycleIds)
      : null;
    const familyRule = familyRuleOf(
      rules.get(String(identityRevision?.family_rule_key || "")),
    );
    const requiredDocumentTypes = new Set(
      (familyRule?.required_document_types || []).map((type) =>
        canonicalizeMakesafeDocumentRole(type) || `unmapped:${String(type)}`
      ),
    );
    const assignmentRows = assignments.get(jobId) || [];
    const reportRows = serviceReports.get(jobId) || [];
    const documentRows = (documents.get(jobId) || [])
      .map((item) => ({
        ...item,
        role: canonicalizeMakesafeDocumentRole(item?.type),
      }))
      .filter((item) =>
        item.role !== null && requiredDocumentTypes.has(item.role)
      );
    const mediaRows = media.get(jobId) || [];
    const completionMediaRows = mediaRows.filter((item) =>
      String(item?.phase || "").toLowerCase() === "after" ||
      String(item?.type || "").toLowerCase().includes("completion")
    );
    const portalRows = portalCaptures.get(jobId) || [];
    const packCycleRows = packCycles.get(jobId) || [];
    const currentPackIds = new Set(
      packCycleRows
        .filter((binding) =>
          binding.attendance_cycle_id === currentCycleId &&
          binding.cycle_attribution === "bound"
        )
        .map((binding) => String(binding.pack_id)),
    );
    const currentPacks = (packs.get(jobId) || []).filter((pack) =>
      currentPackIds.has(String(pack.id))
    );
    const pack = currentPacks.length === 1 ? currentPacks[0] : null;
    const packArtifactHash = pack?.makesafe_content_hash ||
      pack?.last_render_hash || null;
    const approvalRows = approvals.get(jobId) || [];
    const currentReadiness = readiness.get(jobId);
    const readinessEnvelope = currentReadiness?.dependency_envelope || null;
    const projectionInputErrors: MakesafeStateInput["projection_input_errors"] =
      [];
    if (currentReadiness?.readiness_revision) {
      if (
        !readinessEnvelope || typeof readinessEnvelope !== "object" ||
        Array.isArray(readinessEnvelope)
      ) {
        projectionInputErrors.push({
          reason:
            "The current readiness pointer has no dependency envelope to verify.",
          evidence_refs: [jobId, currentReadiness.readiness_revision],
        });
      } else {
        const currentFacts = (rows: any[]) =>
          versionedDependencies(
            rows.filter((item) => item.attendance_cycle_id === currentCycleId),
          );
        const observedEnvelope: ReadinessDependencyEnvelope = {
          source_instruction: {
            id: identityRevision?.source_instruction_id || null,
            version: identityRevision?.source_version ?? null,
            content_hash: identityRevision?.source_content_hash || null,
          },
          lineage: {
            lineage_id: identityRevision?.lineage_id || null,
            case_id: identityRevision?.effective_case_id ||
              identityRevision?.id || null,
            version: identityRevision?.lineage_version ?? null,
            correction_hash: identityRevision?.lineage_correction_hash || null,
            supersession_hash: identityRevision?.lineage_supersession_hash ||
              null,
          },
          attendance: {
            attendance_cycle_ids: cycleIds,
            current_attendance_cycle_id: currentCycleId,
            attendance_cycle_set_hash: cycleSetHash,
            cycles: versionedDependencies(cycleRows),
          },
          current_cycle: {
            assignments: currentFacts(assignmentRows),
            service_reports: currentFacts(reportRows),
            documents: currentFacts(documentRows),
            completion_photos: currentFacts(completionMediaRows),
            portal_captures: currentFacts(portalRows),
          },
          family: {
            code: familyRule?.code || null,
            matrix_revision: familyRule?.matrix_revision || null,
            matrix_content_hash:
              (familyRule?.matrix_content_hash as Sha256Revision) || null,
          },
          pricing: {
            disposition: readinessEnvelope?.pricing?.disposition || null,
            revision: readinessEnvelope?.pricing?.revision || null,
          },
          invoice_obligation: {
            id: readinessEnvelope?.invoice_obligation?.id || null,
            revision: readinessEnvelope?.invoice_obligation?.revision || null,
          },
          docket: {
            revision_id: pack?.id || null,
            artifact_hash: packArtifactHash as Sha256Revision | null,
            manifest_hash: readinessEnvelope?.docket?.manifest_hash || null,
          },
        };
        const dependencyErrors = readinessDependencyErrors(observedEnvelope);
        if (dependencyErrors.length) {
          projectionInputErrors.push({
            reason: `The loaded readiness dependency set is incomplete: ${
              dependencyErrors.join("; ")
            }`,
            evidence_refs: [jobId, currentReadiness.readiness_revision],
          });
        }
        try {
          const observedRevision = await computeMakesafeReadinessRevision(
            observedEnvelope,
          );
          if (observedRevision !== currentReadiness.readiness_revision) {
            projectionInputErrors.push({
              reason:
                "The loaded dependency facts do not reproduce the current readiness revision.",
              evidence_refs: [
                jobId,
                currentReadiness.readiness_revision,
                observedRevision,
              ],
            });
          }
        } catch (error) {
          projectionInputErrors.push({
            reason:
              `The loaded readiness dependency set cannot be canonicalized: ${
                error instanceof Error ? error.message : String(error)
              }`,
            evidence_refs: [jobId, currentReadiness.readiness_revision],
          });
        }
      }
    }
    const currentApprovals = approvalRows.filter((item) =>
      item.decision === "approved" &&
      item.readiness_revision === currentReadiness?.readiness_revision &&
      Number(item.dependency_generation) ===
        Number(currentReadiness?.dependency_generation) &&
      (item.action === "pack_review"
        ? !!pack && item.docket_revision_id === pack.id
        : !item.docket_revision_id || item.docket_revision_id === pack?.id)
    );
    const staleApproval = approvalRows.some((item) =>
      item.decision === "approved" && !currentApprovals.includes(item)
    );
    const cycleAttributionError = [
        ...assignmentRows,
        ...reportRows,
        ...documentRows,
        ...completionMediaRows,
        ...packCycleRows.filter((fact) =>
          fact.attendance_cycle_id === currentCycleId
        ),
      ].some((fact) =>
        !fact.attendance_cycle_id || fact.cycle_attribution !== "bound"
      ) || portalRows.some((fact) => !fact.attendance_cycle_id)
      ? "One or more operational facts lack exact attendance-cycle attribution."
      : currentPacks.length > 1
      ? "More than one report pack claims the current attendance cycle."
      : null;
    const input: MakesafeStateInput = {
      computed_at: computedAt,
      projection_input_errors: projectionInputErrors,
      identity: {
        authority_kind: identityRevision?.authority_kind || null,
        authority_revision_id: identityRevision?.id || null,
        source_instruction_id: identityRevision?.source_instruction_id || null,
        lineage_id: identityRevision?.lineage_id || null,
        case_id: identityRevision?.effective_case_id || null,
        job_id: jobId || null,
        job_number: row?.job_number || null,
        property_id: jobFamily?.metadata?.property_id || null,
        attendance_cycle_ids: cycleIds,
        current_attendance_cycle_id: currentCycleId,
      },
      current_attendance_cycle_set_hash: cycleSetHash as Sha256Revision | null,
      source_version: identityRevision?.source_version ?? null,
      source_content_hash: identityRevision?.source_content_hash || null,
      lineage_version: identityRevision?.lineage_version ?? null,
      lineage_correction_hash: identityRevision?.lineage_correction_hash ||
        null,
      lineage_supersession_hash: identityRevision?.lineage_supersession_hash ||
        null,
      substatus_raw: row?.substatus || null,
      job_created_at: null,
      company_contact_present: !!(
        row?.contact?.phone || row?.contact?.client_name
      ),
      intake_exception: !!identityRevision &&
        ["exception", "blocked_live_job"].includes(
          identityRevision.intake_state,
        ),
      cycle_attribution_error: cycleAttributionError,
      family_rule: familyRule,
      attendance_cycles: cycleRows.map((cycle) => ({
        id: String(cycle.id || ""),
        attendance_cycle_id: cycle.id || null,
        version: Number.isSafeInteger(Number(cycle.makesafe_fact_version))
          ? Number(cycle.makesafe_fact_version)
          : null,
        content_hash: cycle.makesafe_content_hash || null,
        status: cycle.closed_at ? "closed" : "open",
      })),
      assignments: assignmentRows.map(versionedFact),
      service_reports: reportRows.map(versionedFact),
      documents: documentRows.map(versionedFact),
      completion_photos: completionMediaRows.map(versionedFact),
      portal_captures: portalRows.map(versionedFact),
      readiness: readinessOf(currentReadiness),
      operator_blockers: (holds.get(jobId) || [])
        .map(operatorBlockerOf)
        .filter((item): item is BlockerFact => !!item),
      cancellation: cancellationOf(cancellations.get(jobId)),
      terminal_proof: terminalProofOf(terminalProofs.get(jobId)),
      workflow: {
        pricing_disposition_revision: readinessEnvelope?.pricing?.revision ||
          null,
        invoice_obligation_id: readinessEnvelope?.invoice_obligation?.id ||
          null,
        invoice_obligation_revision:
          readinessEnvelope?.invoice_obligation?.revision || null,
        docket_revision_id: pack?.id || null,
        docket_artifact_hash: packArtifactHash,
        draft_assembled: !!pack,
        docs_reviewed: currentApprovals.some((item) =>
          item.action === "pack_review" && item.decision === "approved"
        ),
        invoice_approved: currentApprovals.some((item) =>
          item.action === "invoice" && item.decision === "approved"
        ),
        release_approved: currentApprovals.some((item) =>
          item.action === "release" && item.decision === "approved"
        ),
        released: pack?.status === "sent",
        money_review_required: pack?.needs_money_review === true,
        stale_approval: staleApproval,
      },
    };
    const state: MakesafeStateV2 = projectMakesafeStateV2(input);
    const diff: V1V2Diff = diffV1V2State(row, state);
    if (!diff.equal) differing += 1;
    if (
      state.diagnostics.some((item) => item.code === "projection_input_error")
    ) inputErrors += 1;
    return {
      ...row,
      state_v2: state,
      v1_v2_diff: diff,
      state_facts: {
        job: {
          id: row?.id || null,
          type: row?.type || null,
          status: row?.status || null,
          substatus: row?.substatus || null,
        },
        identity: identityRevision,
        cycles: cycleRows,
        assignments: assignmentRows,
        service_reports: reportRows,
        documents: documents.get(jobId) || [],
        media: mediaRows,
        portal_captures: portalRows,
        cases: facts.cases.filter((item) => String(item?.job_id) === jobId),
        holds: holds.get(jobId) || [],
        cancellations: cancellations.get(jobId)
          ? [cancellations.get(jobId)]
          : [],
        terminal_proofs: terminalProofs.get(jobId)
          ? [terminalProofs.get(jobId)]
          : [],
        pack_cycles: packCycles.get(jobId) || [],
        packs: packs.get(jobId) || [],
        approvals: approvals.get(jobId) || [],
        family_rule: familyRule
          ? rules.get(String(identityRevision?.family_rule_key || "")) || null
          : null,
        job_family: jobFamily || null,
        job_details: details.find((item) => String(item?.job_id) === jobId) ||
          null,
        docket: dockets.find((item) => String(item?.job_id) === jobId) ||
          null,
        readiness: currentReadiness
          ? currentReadiness
          : null,
      },
    };
  }));
  return {
    rows,
    projection_health: {
      complete: true,
      requested_job_count: canonicalRows.length,
      projected_job_count: rows.length,
      differing_job_count: differing,
      projection_input_error_job_count: inputErrors,
      duplicate_job_ids: [],
    },
  };
}

export async function attachMakesafeStateV2Comparison(
  client: any,
  canonicalRows: any[],
  computedAt: string,
  factLoader: typeof loadMakesafeV2Facts = loadMakesafeV2Facts,
): Promise<MakesafeComparisonResult> {
  const jobIds = canonicalRows.map((row) => String(row?.id || "")).filter(
    Boolean,
  );
  const facts = await factLoader(client, jobIds, []);
  const result = await buildMakesafeV2Comparison(
    canonicalRows,
    facts,
    computedAt,
  );
  if (result.rows.length !== canonicalRows.length) {
    throw new Error(
      `makesafe-state.v2 incomplete projection: expected ${canonicalRows.length}, got ${result.rows.length}`,
    );
  }
  return result;
}

export async function buildPrivilegedMakesafeV2BoardComparison(
  client: any,
  canonicalRows: any[],
  generatedAt: string,
) {
  const comparison = await attachMakesafeStateV2Comparison(
    client,
    canonicalRows,
    generatedAt,
  );
  const { ops, ...parity } = checkMakesafeBoardParity(comparison.rows);
  if (!parity.ok) {
    throw new Error(
      `make-safe board parity failed: ${parity.errors.join("; ")}`,
    );
  }
  return {
    contract_version: MAKESAFE_BOARD_V2_CONTRACT_VERSION,
    state_contract_version: MAKESAFE_STATE_CONTRACT_VERSION,
    projection: "ops",
    generated_at: generatedAt,
    ...ops,
    projection_health: comparison.projection_health,
    parity,
  };
}
