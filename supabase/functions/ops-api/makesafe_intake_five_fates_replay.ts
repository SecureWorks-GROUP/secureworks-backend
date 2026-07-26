// SES Reporting U1: pure five-fates replay adjudicator.
//
// This module receives the side-effect-free deterministic plan plus read-only
// snapshots of the durable intake ledger. It emits only structural hashes and
// shape labels. Source subjects, bodies, addresses, names and email addresses
// never enter the report.

import type {
  DeterministicAttachment,
  DeterministicCasePlan,
  DeterministicIntakePlan,
  DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";

export const FIVE_FATES_REPLAY_VERSION =
  "ses-reporting-u1-five-fates@2026-07-26.v1";
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

export interface HistoricalShapeInput {
  source: DeterministicSourceItem;
  rawBody?: string | null;
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
  shape_key: string;
  replay_fate: IntakeFate | null;
  durable_fate: IntakeFate | null;
  correct: boolean;
  why: string[];
  replay_reason_code: string | null;
  durable_reason_code: string | null;
  five_minute_live_job: {
    applicable: boolean;
    measured: boolean;
    latency_seconds: number | null;
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
  version: string;
  generated_at: string;
  corpus: {
    sources: number;
    historical_shapes: number;
    replay_fated: number;
    durable_fated: number;
    correct: number;
    incorrect: number;
    silent_disappearances: number;
  };
  fate_counts: Record<IntakeFate, number>;
  durable_fate_counts: Record<IntakeFate, number>;
  five_minute_live_job: {
    law_seconds: 300;
    expected_clean_sources: number;
    measured: number;
    within_law: number;
    breached: number;
    unmeasured: number;
    p50_seconds: number | null;
    p95_seconds: number | null;
    max_seconds: number | null;
  };
  shape_catalogue: Array<{
    shape_key: string;
    observed_count: number;
    example_source_hash: string;
    replay_fates: Partial<Record<IntakeFate, number>>;
  }>;
  verdicts: FiveFatesVerdict[];
}

function structuralHash(value: string): string {
  // FNV-1a 64-bit represented as two 32-bit lanes. Source ids are long opaque
  // Graph coordinates; this keeps reports correlatable without publishing them.
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
    String(source.fromEmail || "").toLowerCase().split("@").pop() ||
    "";
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
  // A revision signal alone is not fate 4. It reaches that fate only after the
  // case is live-capable and attached to lineage; an unresolved revision remains
  // a reason-coded exception rather than masquerading as attached work.
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

export function buildFiveFatesReplayReport(input: {
  plan: DeterministicIntakePlan;
  sources: readonly HistoricalShapeInput[];
  caseSources: readonly DurableCaseSourceRow[];
  cases: readonly DurableCaseRow[];
  jobs: readonly DurableJobRow[];
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
  const linksBySource = new Map<string, DurableCaseSourceRow[]>();
  for (const item of input.caseSources) {
    linksBySource.set(item.post_id, [
      ...(linksBySource.get(item.post_id) || []),
      item,
    ]);
  }

  const fateCounts = emptyFateCounts();
  const durableFateCounts = emptyFateCounts();
  const shapeRows = new Map<
    string,
    {
      observed_count: number;
      example_source_hash: string;
      replay_fates: Partial<Record<IntakeFate, number>>;
    }
  >();
  const liveLatencies: number[] = [];
  const verdicts: FiveFatesVerdict[] = [];

  for (const historical of input.sources) {
    const source = historical.source;
    const sourceHash = structuralHash(source.postId);
    const shape = catalogueHistoricalEmailShape(historical);
    const replayRows = classifications.get(source.postId) || [];
    const replayCase = replayRows.length === 1
      ? planCases.get(replayRows[0].instructionKey) || null
      : null;
    const replayFate = replayCase ? fateForCase(replayCase) : null;
    if (replayFate) fateCounts[replayFate]++;

    const sourceLinks = linksBySource.get(source.postId) || [];
    const uniqueCaseIds = [...new Set(sourceLinks.map((item) => item.case_id))];
    const durableCase = uniqueCaseIds.length === 1
      ? durableCases.get(uniqueCaseIds[0]) || null
      : null;
    const durableFate = durableCase
      ? fateForCase({
        state: durableCase.state,
        parentRelation: durableCase.parent_relation || null,
        reasonCode: durableCase.reason_code,
        blockedReasons: durableCase.blocked_reasons || [],
      })
      : null;
    if (durableFate) durableFateCounts[durableFate]++;

    const why: string[] = [];
    if (replayRows.length !== 1) {
      why.push(
        replayRows.length === 0
          ? "replay_has_no_fate"
          : "replay_has_multiple_fates",
      );
    }
    if (!replayCase) why.push("replay_has_no_canonical_case");
    if (
      replayFate === "reason_coded_exception" && !replayCase?.reasonCode
    ) why.push("replay_exception_has_no_reason_code");
    if (
      replayFate === "blocked_live_job" &&
      !replayCase?.blockedReasons.length
    ) why.push("replay_blocked_job_has_no_visible_reason");

    if (uniqueCaseIds.length === 0) why.push("source_has_no_durable_fate");
    if (uniqueCaseIds.length > 1) why.push("source_has_multiple_durable_fates");
    if (uniqueCaseIds.length === 1 && !durableCase) {
      why.push("durable_source_points_to_missing_case");
    }
    if (
      durableFate === "reason_coded_exception" &&
      !durableCase?.reason_code
    ) why.push("durable_exception_has_no_reason_code");
    if (
      durableFate === "blocked_live_job" &&
      !(durableCase?.blocked_reasons || []).length
    ) why.push("durable_blocked_job_has_no_visible_reason");
    if (
      durableFate === "live_job" &&
      (!durableCase?.job_id || !jobs.has(durableCase.job_id))
    ) why.push("durable_live_fate_has_no_job");
    if (
      durableFate === "revision_or_reattendance" &&
      (!durableCase?.parent_case_id || !durableCase.job_id ||
        !jobs.has(durableCase.job_id))
    ) why.push("durable_revision_is_not_attached_to_existing_job");
    if (
      replayFate && durableFate && replayFate !== durableFate
    ) why.push("durable_fate_disagrees_with_replay");

    const cleanLiveApplicable = replayFate === "live_job";
    const job = durableCase?.job_id ? jobs.get(durableCase.job_id) : null;
    const latency = cleanLiveApplicable && durableFate === "live_job" && job
      ? secondsBetween(source.receivedAt, job.created_at)
      : null;
    if (latency !== null) liveLatencies.push(latency);
    if (cleanLiveApplicable && latency === null) {
      why.push("clean_live_job_latency_unmeasured");
    } else if (latency !== null && latency > FIVE_MINUTES_SECONDS) {
      why.push("clean_live_job_exceeded_five_minutes");
    }

    const correct = why.length === 0;
    const shapeRow = shapeRows.get(shape.key) || {
      observed_count: 0,
      example_source_hash: sourceHash,
      replay_fates: {},
    };
    shapeRow.observed_count++;
    if (replayFate) {
      shapeRow.replay_fates[replayFate] =
        (shapeRow.replay_fates[replayFate] || 0) + 1;
    }
    shapeRows.set(shape.key, shapeRow);

    verdicts.push({
      source_hash: sourceHash,
      received_at: source.receivedAt,
      shape_key: shape.key,
      replay_fate: replayFate,
      durable_fate: durableFate,
      correct,
      why,
      replay_reason_code: replayCase?.reasonCode || null,
      durable_reason_code: durableCase?.reason_code || null,
      five_minute_live_job: {
        applicable: cleanLiveApplicable,
        measured: latency !== null,
        latency_seconds: latency,
        within_law: latency === null ? null : latency <= FIVE_MINUTES_SECONDS,
      },
      correlation: {
        source_instruction_id: `source:${sourceHash}`,
        instruction_id: hashedCoordinate(
          "instruction",
          replayCase?.instructionKey || durableCase?.instruction_key,
        ),
        lineage_id: hashedCoordinate(
          "lineage",
          durableCase?.lineage_id || replayCase?.lineageClusterKey,
        ),
        case_id: hashedCoordinate("case", durableCase?.id),
        job_id: hashedCoordinate("job", durableCase?.job_id),
        parent_relation: replayCase?.parentRelation ||
          durableCase?.parent_relation || null,
      },
    });
  }

  const expectedClean =
    verdicts.filter((item) => item.five_minute_live_job.applicable).length;
  const withinLaw =
    liveLatencies.filter((value) => value <= FIVE_MINUTES_SECONDS).length;
  const shapeCatalogue = [...shapeRows.entries()].map(([shapeKey, row]) => ({
    shape_key: shapeKey,
    ...row,
  })).sort((a, b) =>
    b.observed_count - a.observed_count ||
    a.shape_key.localeCompare(b.shape_key)
  );

  return {
    ok: true,
    version: FIVE_FATES_REPLAY_VERSION,
    generated_at: input.nowIso,
    corpus: {
      sources: input.sources.length,
      historical_shapes: shapeCatalogue.length,
      replay_fated: verdicts.filter((item) => item.replay_fate !== null).length,
      durable_fated:
        verdicts.filter((item) => item.durable_fate !== null).length,
      correct: verdicts.filter((item) => item.correct).length,
      incorrect: verdicts.filter((item) => !item.correct).length,
      silent_disappearances:
        verdicts.filter((item) =>
          item.why.includes("source_has_no_durable_fate")
        ).length,
    },
    fate_counts: fateCounts,
    durable_fate_counts: durableFateCounts,
    five_minute_live_job: {
      law_seconds: FIVE_MINUTES_SECONDS,
      expected_clean_sources: expectedClean,
      measured: liveLatencies.length,
      within_law: withinLaw,
      breached: liveLatencies.length - withinLaw,
      unmeasured: expectedClean - liveLatencies.length,
      p50_seconds: percentile(liveLatencies, 0.5),
      p95_seconds: percentile(liveLatencies, 0.95),
      max_seconds: liveLatencies.length ? Math.max(...liveLatencies) : null,
    },
    shape_catalogue: shapeCatalogue,
    verdicts,
  };
}
