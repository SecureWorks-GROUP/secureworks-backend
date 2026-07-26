// SES Reporting U1: pure five-fates replay diagnostics.
//
// This is not an oracle. Planner output, the planner-family durable ledger and
// independent corpus expectations are deliberately reported as three separate
// facts. The module never turns planner/ledger agreement into "correct".

import type {
  AdapterId,
  DeterministicAttachment,
  DeterministicCasePlan,
  DeterministicIntakePlan,
  DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";

export const FIVE_FATES_REPLAY_VERSION =
  "ses-reporting-u1-five-fates@2026-07-26.v2";
export const FIVE_MINUTES_SECONDS = 300;

export type IntakeFate =
  | "live_job"
  | "blocked_live_job"
  | "reason_coded_exception"
  | "revision_or_reattendance"
  | "accounted_non_work";

export interface DurableCaseSourceRow {
  post_id: string;
  case_id: string;
  created_at?: string | null;
  received_at?: string | null;
}

export interface DurableCaseRow {
  id: string;
  instruction_key: string;
  lineage_id: string | null;
  parent_case_id?: string | null;
  parent_relation?: DeterministicCasePlan["parentRelation"];
  state: DeterministicCasePlan["state"];
  reason_code: DeterministicCasePlan["reasonCode"];
  blocked_reasons?: readonly string[] | null;
  job_id: string | null;
  created_at?: string | null;
  received_at?: string | null;
}

export interface DurableJobRow {
  id: string;
  created_at?: string | null;
  status?: string | null;
}

export interface DurableSourceExceptionRow {
  post_id: string;
  change_type: string;
  exclusion_reason?: string | null;
  observed_at?: string | null;
}

export interface HistoricalShapeInput {
  source: DeterministicSourceItem;
  rawBody?: string | null;
  adapterId?: AdapterId | null;
  adapterVersion?: string | null;
}

export interface IndependentShapeExpectation {
  shape_id: string;
  count: number;
  builder: string;
  tail: boolean;
  expected_fate: IntakeFate;
  fate_reason: string;
  independent_handling_assessment: "handled" | "partial" | "unhandled";
  identifies: string;
  example_source_hash: string;
}

export interface HugoBoardObservation {
  observed_at: string;
  method: "shared_server_read_model_with_production_hugo_profile";
  contract_version: string;
  viewer_profile_hash: string;
  visible_job_ids: readonly string[];
  permissions: {
    sees_all_makesafes: boolean;
    can_allocate: boolean;
  };
}

export interface HistoricalEmailShape {
  key: string;
  direction: "inbound" | "own_outbound";
  sender_family:
    | "ajs"
    | "prime"
    | "prime_notifications"
    | "secureworks_own_copy"
    | "other";
  subject_form:
    | "new_work_order"
    | "builder_reference"
    | "reply"
    | "forward"
    | "cancellation"
    | "appointment_or_access"
    | "report_or_assessment"
    | "quote"
    | "invoice"
    | "completion_or_evidence"
    | "other";
  identity_form: "wo_and_po" | "wo" | "claim_or_ref" | "none";
  body_form: "html" | "plain" | "empty";
  attachment_form:
    | "none"
    | "pdf"
    | "image"
    | "pdf_and_image"
    | "other";
  attachment_count: "0" | "1" | "2_plus";
  link_form: "link" | "no_link";
}

export interface FiveFatesVerdict {
  source_hash: string;
  received_at: string;
  diagnostic_axis_shape: string;
  planner_fate: IntakeFate | null;
  planner_adapter_id: AdapterId | null;
  durable_fate: IntakeFate | null;
  planner_self_consistent: boolean;
  durable_present: boolean;
  durable_matches_planner: boolean | null;
  diagnostics: string[];
  planner_reason_code: string | null;
  durable_reason_code: string | null;
  independent_ground_truth: {
    shape_id: string;
    expected_fate: IntakeFate;
    expected_volume: number;
    handling_assessment: "handled" | "partial" | "unhandled";
    planner_matches: boolean;
    durable_matches: boolean | null;
  } | null;
  five_minute_hugo_visibility: {
    applicable: boolean;
    measured: boolean;
    hugo_visible_at_observation: boolean;
    job_created_latency_seconds: number | null;
    visibility_upper_bound_seconds: number | null;
    within_law: boolean | null;
  };
  correlation: {
    source_instruction_id: string;
    instruction_id: string | null;
    lineage_id: string | null;
    case_id: string | null;
    job_id: string | null;
    parent_relation: DeterministicCasePlan["parentRelation"];
  };
}

export interface FiveFatesReplayReport {
  ok: true;
  proof_status: "not_proved";
  version: string;
  generated_at: string;
  corpus: {
    sources: number;
    planner_fated: number;
    planner_self_consistent: number;
    durable_fated: number;
    durable_missing: number;
    durable_matches_planner: number;
    diagnostic_axis_shapes: number;
  };
  planner_fate_counts: Record<IntakeFate, number>;
  durable_fate_counts: Record<IntakeFate, number>;
  independent_ground_truth: {
    authority: "independent_corpus_swarm";
    catalogue_shapes: number;
    shapes_with_exactly_one_expected_fate: number;
    examples_found: number;
    examples_missing: number;
    planner_matches: number;
    durable_matches: number;
    durable_missing: number;
    catalogue_baseline_unhandled_shapes: number;
    candidate_closed_baseline_unhandled_shapes: number;
    expected_volume_fate_counts: Record<IntakeFate, number>;
    checks: Array<{
      shape_id: string;
      expected_fate: IntakeFate;
      expected_volume: number;
      example_source_hash: string;
      planner_fate: IntakeFate | null;
      planner_adapter_id: AdapterId | null;
      planner_reason_code: string | null;
      candidate_path_closed: boolean;
      durable_fate: IntakeFate | null;
      planner_matches: boolean;
      durable_matches: boolean | null;
      handling_assessment: "handled" | "partial" | "unhandled";
    }>;
  };
  pdf_extraction_diagnostics: {
    documents: number;
    extracted: number;
    quarantined: number;
    deferred: number;
    run_extraction_cap: number;
    sources_with_run_extraction_cap: number;
  };
  five_minute_hugo_visibility: {
    law_seconds: 300;
    measurement: "email_received_to_hugo_projection_observed_upper_bound";
    ground_truth_live_examples: number;
    measured: number;
    within_law: number;
    breached: number;
    unmeasured: number;
    visible_at_observation: number;
    p50_seconds: number | null;
    p95_seconds: number | null;
    max_seconds: number | null;
    board_observation: Omit<HugoBoardObservation, "visible_job_ids">;
  };
  proof_gaps: string[];
  diagnostic_axis_catalogue: Array<{
    shape_key: string;
    observed_count: number;
    example_source_hash: string;
    planner_fates: Partial<Record<IntakeFate, number>>;
  }>;
  verdicts: FiveFatesVerdict[];
}

export function structuralHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ (code >>> 8), 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${
    (h2 >>> 0).toString(16).padStart(8, "0")
  }`;
}

function hashedCoordinate(kind: string, value: string | null | undefined) {
  return value ? `${kind}:${structuralHash(value)}` : null;
}

function attachmentForm(
  attachments: readonly DeterministicAttachment[],
): HistoricalEmailShape["attachment_form"] {
  if (!attachments.length) return "none";
  const pdf = attachments.some((item) =>
    /pdf/i.test(item.contentType || "") || /\.pdf$/i.test(item.name || "")
  );
  const image = attachments.some((item) =>
    /^image\//i.test(item.contentType || "") ||
    /\.(?:png|jpe?g|gif|webp)$/i.test(item.name || "")
  );
  if (pdf && image) return "pdf_and_image";
  if (pdf) return "pdf";
  if (image) return "image";
  return "other";
}

function senderFamily(
  source: DeterministicSourceItem,
): HistoricalEmailShape["sender_family"] {
  if (source.direction === "own_outbound") return "secureworks_own_copy";
  const domain =
    String(source.fromEmail || "").toLowerCase().split("@").pop() || "";
  if (domain === "ajs.build" || domain.endsWith(".ajs.build")) return "ajs";
  if (domain === "notifications.primeeco.tech") return "prime_notifications";
  if (domain === "primeeco.tech" || domain.endsWith(".primeeco.tech")) {
    return "prime";
  }
  return "other";
}

function subjectForm(subject: string): HistoricalEmailShape["subject_form"] {
  if (/^\s*(?:re|aw)\s*:/i.test(subject)) return "reply";
  if (/^\s*(?:fw|fwd|wg)\s*:/i.test(subject)) return "forward";
  if (/\b(?:cancelled|canceled|cancellation|withdrawn)\b/i.test(subject)) {
    return "cancellation";
  }
  if (/\bnew\s+work\s+order\b/i.test(subject)) return "new_work_order";
  if (/\b(?:our|client|claim|job)\s+ref(?:erence)?\s*:/i.test(subject)) {
    return "builder_reference";
  }
  if (/\b(?:appointment|access|attend|booked|scheduled)\b/i.test(subject)) {
    return "appointment_or_access";
  }
  if (/\b(?:report|assessment|inspection)\b/i.test(subject)) {
    return "report_or_assessment";
  }
  if (/\b(?:quote|quotation)\b/i.test(subject)) return "quote";
  if (/\binvoice\b/i.test(subject)) return "invoice";
  if (/\b(?:complete|completion|photo|evidence|works done)\b/i.test(subject)) {
    return "completion_or_evidence";
  }
  return "other";
}

export function catalogueHistoricalEmailShape(
  input: HistoricalShapeInput,
): HistoricalEmailShape {
  const source = input.source;
  const subject = source.subject || "";
  const body = source.body || "";
  const rawBody = input.rawBody ?? body;
  const haystack = `${subject}\n${body}`;
  const hasWo =
    /\b(?:work\s*order|works\s*order|w\s*[./]?\s*o)\s*(?:(?:number|no\.?)\s*[:#-]?|[:#-])/i
      .test(haystack);
  const hasPo =
    /\b(?:purchase\s*order|p\s*[./]?\s*o)\s*(?:(?:number|no\.?)\s*[:#-]?|[:#-])/i
      .test(haystack);
  const hasClaim = /\b(?:our|client|claim|job|external)\s+ref(?:erence)?\s*:/i
    .test(haystack) || /\b(?:MLB|AJBR|AJS|RR)[-\s#]*\d{3,}\b/i.test(haystack);
  const identityForm: HistoricalEmailShape["identity_form"] = hasWo && hasPo
    ? "wo_and_po"
    : hasWo
    ? "wo"
    : hasClaim
    ? "claim_or_ref"
    : "none";
  const bodyForm: HistoricalEmailShape["body_form"] = !rawBody
    ? "empty"
    : /<\/?(?:html|body|div|p|table|span|br)\b/i.test(rawBody)
    ? "html"
    : "plain";
  const count = source.attachments.length;
  const shape: HistoricalEmailShape = {
    direction: source.direction === "own_outbound" ? "own_outbound" : "inbound",
    sender_family: senderFamily(source),
    subject_form: subjectForm(subject),
    identity_form: identityForm,
    body_form: bodyForm,
    attachment_form: attachmentForm(source.attachments),
    attachment_count: count === 0 ? "0" : count === 1 ? "1" : "2_plus",
    link_form: source.links.length > 0 || /https?:\/\//i.test(body)
      ? "link"
      : "no_link",
    key: "",
  };
  shape.key = [
    shape.direction,
    shape.sender_family,
    shape.subject_form,
    shape.identity_form,
    shape.body_form,
    shape.attachment_form,
    shape.attachment_count,
    shape.link_form,
  ].join("|");
  return shape;
}

function fateForCase(
  intakeCase: Pick<
    DeterministicCasePlan,
    "state" | "parentRelation" | "reasonCode" | "blockedReasons"
  >,
): IntakeFate | null {
  if (intakeCase.state === "exception") return "reason_coded_exception";
  if (intakeCase.state === "accounted_non_wo") return "accounted_non_work";
  if (
    intakeCase.parentRelation === "revision_of" ||
    intakeCase.parentRelation === "reopen_of"
  ) return "revision_or_reattendance";
  if (intakeCase.state === "confirmed_live_job") return "live_job";
  if (intakeCase.state === "blocked_live_job") return "blocked_live_job";
  return null;
}

function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function secondsBetween(start: string, end: string | null | undefined) {
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 1000);
}

function emptyFateCounts(): Record<IntakeFate, number> {
  return {
    live_job: 0,
    blocked_live_job: 0,
    reason_coded_exception: 0,
    revision_or_reattendance: 0,
    accounted_non_work: 0,
  };
}

const INTAKE_FATES: ReadonlySet<string> = new Set(
  Object.keys(emptyFateCounts()),
);

// The one-fate-per-shape property is the whole point of the independent ground
// truth, so it is derived here rather than assumed from the catalogue length. A
// duplicated shape_id or an unrecognised expected_fate must lower this number for
// every caller, not only the ones that go through the CLI loader.
function shapesWithExactlyOneExpectedFate(
  shapes: readonly IndependentShapeExpectation[],
): number {
  const fatesById = new Map<string, Set<string>>();
  for (const shape of shapes) {
    const id = String(shape?.shape_id ?? "");
    const fates = fatesById.get(id) || new Set<string>();
    fates.add(String(shape?.expected_fate ?? ""));
    fatesById.set(id, fates);
  }
  let counted = 0;
  for (const [id, fates] of fatesById) {
    if (!id) continue;
    if (fates.size !== 1) continue;
    const [fate] = [...fates];
    if (INTAKE_FATES.has(fate)) counted++;
  }
  return counted;
}

export function buildFiveFatesReplayReport(input: {
  plan: DeterministicIntakePlan;
  sources: readonly HistoricalShapeInput[];
  caseSources: readonly DurableCaseSourceRow[];
  cases: readonly DurableCaseRow[];
  jobs: readonly DurableJobRow[];
  sourceExceptions: readonly DurableSourceExceptionRow[];
  independentShapes: readonly IndependentShapeExpectation[];
  hugoBoard: HugoBoardObservation;
  nowIso: string;
}): FiveFatesReplayReport {
  const planCases = new Map(input.plan.cases.map((item) => [
    item.instructionKey,
    item,
  ]));
  const classifications = new Map<
    string,
    typeof input.plan.sourceClassifications
  >();
  for (const item of input.plan.sourceClassifications) {
    classifications.set(item.postId, [
      ...(classifications.get(item.postId) || []),
      item,
    ]);
  }
  const durableCases = new Map(input.cases.map((item) => [item.id, item]));
  const jobs = new Map(input.jobs.map((item) => [item.id, item]));
  const sourceExceptionByPost = new Map(
    input.sourceExceptions.map((item) => [item.post_id, item]),
  );
  const visibleJobIds = new Set(input.hugoBoard.visible_job_ids);
  const linksBySource = new Map<string, DurableCaseSourceRow[]>();
  for (const item of input.caseSources) {
    linksBySource.set(item.post_id, [
      ...(linksBySource.get(item.post_id) || []),
      item,
    ]);
  }
  const independentBySource = new Map(
    input.independentShapes.map((item) => [item.example_source_hash, item]),
  );

  const plannerFateCounts = emptyFateCounts();
  const durableFateCounts = emptyFateCounts();
  const axisRows = new Map<
    string,
    {
      observed_count: number;
      example_source_hash: string;
      planner_fates: Partial<Record<IntakeFate, number>>;
    }
  >();
  const visibilityLatencies: number[] = [];
  const verdicts: FiveFatesVerdict[] = [];

  for (const historical of input.sources) {
    const source = historical.source;
    const sourceHash = structuralHash(source.postId);
    const shape = catalogueHistoricalEmailShape(historical);
    const plannerRows = classifications.get(source.postId) || [];
    const plannerCase = plannerRows.length === 1
      ? planCases.get(plannerRows[0].instructionKey) || null
      : null;
    const plannerFate = plannerCase ? fateForCase(plannerCase) : null;
    if (plannerFate) plannerFateCounts[plannerFate]++;

    const sourceLinks = linksBySource.get(source.postId) || [];
    const uniqueCaseIds = [...new Set(sourceLinks.map((item) => item.case_id))];
    const durableCase = uniqueCaseIds.length === 1
      ? durableCases.get(uniqueCaseIds[0]) || null
      : null;
    const sourceException = sourceExceptionByPost.get(source.postId) || null;
    const durableFate = durableCase
      ? fateForCase({
        state: durableCase.state,
        parentRelation: durableCase.parent_relation || null,
        reasonCode: durableCase.reason_code,
        blockedReasons: durableCase.blocked_reasons || [],
      })
      : sourceException
      ? "reason_coded_exception"
      : null;
    if (durableFate) durableFateCounts[durableFate]++;

    const diagnostics: string[] = [];
    if (plannerRows.length !== 1) {
      diagnostics.push(
        plannerRows.length === 0
          ? "planner_has_no_fate"
          : "planner_has_multiple_fates",
      );
    }
    if (!plannerCase) diagnostics.push("planner_has_no_canonical_case");
    if (
      plannerFate === "reason_coded_exception" && !plannerCase?.reasonCode
    ) diagnostics.push("planner_exception_has_no_reason_code");
    if (
      plannerFate === "blocked_live_job" &&
      !plannerCase?.blockedReasons.length
    ) diagnostics.push("planner_blocked_job_has_no_visible_reason");
    if (uniqueCaseIds.length === 0 && !sourceException) {
      diagnostics.push("source_has_no_durable_fate");
    }
    if (uniqueCaseIds.length > 1) {
      diagnostics.push("source_has_multiple_durable_fates");
    }
    if (uniqueCaseIds.length === 1 && !durableCase) {
      diagnostics.push("durable_source_points_to_missing_case");
    }
    if (
      durableFate === "reason_coded_exception" &&
      !(durableCase?.reason_code || sourceException?.exclusion_reason)
    ) diagnostics.push("durable_exception_has_no_reason_code");
    if (
      durableFate === "blocked_live_job" &&
      !(durableCase?.blocked_reasons || []).length
    ) diagnostics.push("durable_blocked_job_has_no_visible_reason");
    if (
      durableFate === "live_job" &&
      (!durableCase?.job_id || !jobs.has(durableCase.job_id))
    ) diagnostics.push("durable_live_fate_has_no_job");
    if (plannerFate && durableFate && plannerFate !== durableFate) {
      diagnostics.push("durable_fate_disagrees_with_planner");
    }

    const independent = independentBySource.get(sourceHash) || null;
    const job = durableCase?.job_id ? jobs.get(durableCase.job_id) : null;
    const hugoVisible = Boolean(
      durableCase?.job_id && visibleJobIds.has(durableCase.job_id),
    );
    const visibilityApplicable = independent?.expected_fate === "live_job";
    const jobCreatedLatency = visibilityApplicable && job
      ? secondsBetween(source.receivedAt, job.created_at)
      : null;
    const visibilityUpperBound = visibilityApplicable && hugoVisible
      ? secondsBetween(source.receivedAt, input.hugoBoard.observed_at)
      : null;
    if (visibilityUpperBound !== null) {
      visibilityLatencies.push(visibilityUpperBound);
    }
    if (visibilityApplicable && !hugoVisible) {
      diagnostics.push("ground_truth_live_example_not_hugo_visible");
    }
    if (
      visibilityUpperBound !== null &&
      visibilityUpperBound > FIVE_MINUTES_SECONDS
    ) diagnostics.push("hugo_visibility_upper_bound_exceeded_five_minutes");

    const axisRow = axisRows.get(shape.key) || {
      observed_count: 0,
      example_source_hash: sourceHash,
      planner_fates: {},
    };
    axisRow.observed_count++;
    if (plannerFate) {
      axisRow.planner_fates[plannerFate] =
        (axisRow.planner_fates[plannerFate] || 0) + 1;
    }
    axisRows.set(shape.key, axisRow);

    verdicts.push({
      source_hash: sourceHash,
      received_at: source.receivedAt,
      diagnostic_axis_shape: shape.key,
      planner_fate: plannerFate,
      planner_adapter_id: historical.adapterId || null,
      durable_fate: durableFate,
      planner_self_consistent: plannerRows.length === 1 && plannerCase !== null,
      durable_present: durableFate !== null,
      durable_matches_planner: plannerFate && durableFate
        ? plannerFate === durableFate
        : null,
      diagnostics,
      planner_reason_code: plannerCase?.reasonCode || null,
      durable_reason_code: durableCase?.reason_code ||
        sourceException?.exclusion_reason || null,
      independent_ground_truth: independent
        ? {
          shape_id: independent.shape_id,
          expected_fate: independent.expected_fate,
          expected_volume: independent.count,
          handling_assessment: independent.independent_handling_assessment,
          planner_matches: plannerFate === independent.expected_fate,
          durable_matches: durableFate
            ? durableFate === independent.expected_fate
            : null,
        }
        : null,
      five_minute_hugo_visibility: {
        applicable: visibilityApplicable,
        measured: visibilityUpperBound !== null,
        hugo_visible_at_observation: hugoVisible,
        job_created_latency_seconds: jobCreatedLatency,
        visibility_upper_bound_seconds: visibilityUpperBound,
        within_law: visibilityUpperBound === null
          ? null
          : visibilityUpperBound <= FIVE_MINUTES_SECONDS,
      },
      correlation: {
        source_instruction_id: `source:${sourceHash}`,
        instruction_id: hashedCoordinate(
          "instruction",
          plannerCase?.instructionKey || durableCase?.instruction_key,
        ),
        lineage_id: hashedCoordinate(
          "lineage",
          durableCase?.lineage_id || plannerCase?.lineageClusterKey,
        ),
        case_id: hashedCoordinate("case", durableCase?.id),
        job_id: hashedCoordinate("job", durableCase?.job_id),
        parent_relation: plannerCase?.parentRelation ||
          durableCase?.parent_relation || null,
      },
    });
  }

  const verdictBySource = new Map(
    verdicts.map((item) => [item.source_hash, item]),
  );
  const independentChecks = input.independentShapes.map((shape) => {
    const verdict = verdictBySource.get(shape.example_source_hash) || null;
    return {
      shape_id: shape.shape_id,
      expected_fate: shape.expected_fate,
      expected_volume: shape.count,
      example_source_hash: shape.example_source_hash,
      planner_fate: verdict?.planner_fate || null,
      planner_adapter_id: verdict?.planner_adapter_id || null,
      planner_reason_code: verdict?.planner_reason_code || null,
      candidate_path_closed: Boolean(
        verdict?.planner_fate &&
          (verdict.planner_adapter_id ||
            shape.expected_fate === "accounted_non_work"),
      ),
      durable_fate: verdict?.durable_fate || null,
      planner_matches: verdict?.planner_fate === shape.expected_fate,
      durable_matches: verdict?.durable_fate
        ? verdict.durable_fate === shape.expected_fate
        : null,
      handling_assessment: shape.independent_handling_assessment,
    };
  });
  const groundTruthLive = verdicts.filter((item) =>
    item.independent_ground_truth?.expected_fate === "live_job"
  );
  const withinLaw =
    visibilityLatencies.filter((value) => value <= FIVE_MINUTES_SECONDS).length;
  const documents = input.sources.flatMap((item) =>
    item.source.pdfDocuments || []
  );
  const capSources = new Set(
    input.sources.filter((item) =>
      (item.source.pdfDocuments || []).some((document) =>
        document.reason === "run_extraction_cap"
      )
    ).map((item) => item.source.postId),
  );
  const expectedVolumeFates = emptyFateCounts();
  for (const shape of input.independentShapes) {
    if (!INTAKE_FATES.has(String(shape.expected_fate))) continue;
    expectedVolumeFates[shape.expected_fate] += shape.count;
  }
  const diagnosticAxisCatalogue = [...axisRows.entries()].map(([
    shapeKey,
    row,
  ]) => ({
    shape_key: shapeKey,
    ...row,
  })).sort((a, b) =>
    b.observed_count - a.observed_count ||
    a.shape_key.localeCompare(b.shape_key)
  );
  const boardObservation = {
    observed_at: input.hugoBoard.observed_at,
    method: input.hugoBoard.method,
    contract_version: input.hugoBoard.contract_version,
    viewer_profile_hash: input.hugoBoard.viewer_profile_hash,
    permissions: input.hugoBoard.permissions,
  } as const;

  return {
    ok: true,
    proof_status: "not_proved",
    version: FIVE_FATES_REPLAY_VERSION,
    generated_at: input.nowIso,
    corpus: {
      sources: input.sources.length,
      planner_fated:
        verdicts.filter((item) => item.planner_fate !== null).length,
      planner_self_consistent:
        verdicts.filter((item) => item.planner_self_consistent).length,
      durable_fated:
        verdicts.filter((item) => item.durable_fate !== null).length,
      durable_missing:
        verdicts.filter((item) => item.durable_fate === null).length,
      durable_matches_planner:
        verdicts.filter((item) => item.durable_matches_planner === true).length,
      diagnostic_axis_shapes: diagnosticAxisCatalogue.length,
    },
    planner_fate_counts: plannerFateCounts,
    durable_fate_counts: durableFateCounts,
    independent_ground_truth: {
      authority: "independent_corpus_swarm",
      catalogue_shapes: input.independentShapes.length,
      shapes_with_exactly_one_expected_fate: shapesWithExactlyOneExpectedFate(
        input.independentShapes,
      ),
      examples_found:
        independentChecks.filter((item) => item.planner_fate !== null)
          .length,
      examples_missing:
        independentChecks.filter((item) => item.planner_fate === null)
          .length,
      planner_matches: independentChecks.filter((item) => item.planner_matches)
        .length,
      durable_matches:
        independentChecks.filter((item) => item.durable_matches === true)
          .length,
      durable_missing:
        independentChecks.filter((item) => item.durable_fate === null).length,
      catalogue_baseline_unhandled_shapes:
        independentChecks.filter((item) =>
          item.handling_assessment === "unhandled"
        ).length,
      candidate_closed_baseline_unhandled_shapes:
        independentChecks.filter((item) =>
          item.handling_assessment === "unhandled" &&
          item.candidate_path_closed
        ).length,
      expected_volume_fate_counts: expectedVolumeFates,
      checks: independentChecks,
    },
    pdf_extraction_diagnostics: {
      documents: documents.length,
      extracted: documents.filter((item) => item.status === "extracted").length,
      quarantined:
        documents.filter((item) => item.status === "quarantined").length,
      deferred: documents.filter((item) => item.status === "deferred").length,
      run_extraction_cap:
        documents.filter((item) => item.reason === "run_extraction_cap").length,
      sources_with_run_extraction_cap: capSources.size,
    },
    five_minute_hugo_visibility: {
      law_seconds: FIVE_MINUTES_SECONDS,
      measurement: "email_received_to_hugo_projection_observed_upper_bound",
      ground_truth_live_examples: groundTruthLive.length,
      measured: visibilityLatencies.length,
      within_law: withinLaw,
      breached: visibilityLatencies.length - withinLaw,
      unmeasured: groundTruthLive.length - visibilityLatencies.length,
      visible_at_observation:
        groundTruthLive.filter((item) =>
          item.five_minute_hugo_visibility.hugo_visible_at_observation
        ).length,
      p50_seconds: percentile(visibilityLatencies, 0.5),
      p95_seconds: percentile(visibilityLatencies, 0.95),
      max_seconds: visibilityLatencies.length
        ? Math.max(...visibilityLatencies)
        : null,
      board_observation: boardObservation,
    },
    proof_gaps: [
      "No supervised clean-email probe has measured first Hugo visibility within 300 seconds.",
      "The independent corpus contains seven unhandled shapes and no deployed-path closure evidence.",
      "Historical board observation provides only a current visibility upper bound, not the first-visible timestamp.",
      "A bounded PDF budget still defers older recent sources when more than 50 eligible PDFs arrive in one run.",
      "Production deployment drift remains unresolved and no production mutation was authorised in U1 replay.",
    ],
    diagnostic_axis_catalogue: diagnosticAxisCatalogue,
    verdicts,
  };
}
