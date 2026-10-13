// Automatic repair intake (owner's word, 13 Oct 2026): a repair work order a
// named builder emails in becomes a job in the insurance repair pipeline with
// no person in between. Everything here is behind ONE flag,
// `feature_flags.repair_intake_auto_v1`, seeded off; missing, unreadable or off
// is today's behaviour exactly.
// deno-lint-ignore-file no-explicit-any
//
// Three rules live here, each pure where it decides and thin where it writes:
//
// 1. `decideRepairAutoIntake` - which repair plans may cross the guarded
//    approval unattended. It narrows the 2026-08-28 ruling ("the repair lane
//    runs SUPERVISED": an SWR- mint cannot be undone, so a human ticked every
//    one) instead of deleting it. What that ruling guarded against was a
//    MISREAD work order minting an irreversible repair card. So the automatic
//    path takes only a repair the BUILDER declared (never one inferred from
//    scope words or by elimination), from a builder on a closed list, on a
//    plan with its claim, purchase order, customer and site read, nothing
//    conflicting and one readable ex-GST value. Anything else still parks as a
//    review draft.
// 2. `matchOpenRepairJob` / `landWorkOrderOnRepairJob` - a REPAIR work order
//    for a claim that already has an open repair job lands on that job. It
//    never opens a second job or a blank draft. An order that reads as a
//    make-safe is never held back by this: it becomes a make-safe job exactly
//    as it does today (urgent work must not wait for a person to read a
//    notice), and `noteMakeSafeRaisedOnRepairClaim` leaves a notice on the
//    claim's repair job so a repair order misread as a make-safe is caught.
// 3. `orphanLifecycleOrderOpensReviewDraft` - a collection or reattendance
//    order with no original job, carrying a first-issue purchase order, opens a
//    review draft instead of an exception nobody can act on.
import {
  canonicalCompanyDedupeKey,
  canonicalExternalObligationRef,
  canonicalObligationPoCore,
} from "../_shared/makesafe_refs.ts";
import type { DeterministicCasePlan } from "./makesafe_deterministic_intake.ts";
import { insuranceRepairStage } from "./insurance_repairs_board.ts";

export const REPAIR_INTAKE_AUTO_FLAG = "repair_intake_auto_v1";
export const REPAIR_AUTO_INTAKE_VERSION = "repair-auto-intake/v1";

/** `canonicalCompanyDedupeKey` of the builders the owner named: MLB, Ambrose. */
export const REPAIR_AUTO_INTAKE_BUILDERS: ReadonlySet<string> = new Set([
  "mlb",
  "acg",
]);

/**
 * Family evidence that is the builder's own statement of a repair: Ambrose's
 * "regarding repairs required", MLB's "Rapid Repair" header, a work order PDF's
 * declared type. `repair_replacement_scope` (scope verbs) and the
 * `identified_wo_repair_complement` (repair by elimination) are inferences and
 * stay supervised.
 */
export const REPAIR_DECLARED_FAMILY_EVIDENCE: ReadonlySet<string> = new Set([
  "ambrose_declared_repair",
  "rapid_repair_signal",
  "pdf_declared_type_header",
]);

/** The review reason a parked collection draft carries, which also keeps the
 * backlog sweep from approving it. */
export const ORPHAN_LIFECYCLE_REVIEW_FIELD = "original_job_for_collection";

/**
 * Reads the flag. Missing, unreadable or thrown is OFF: a flag read fault must
 * never be why a repair card is minted with nobody's tick on it.
 */
export async function repairIntakeAutoEnabled(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", REPAIR_INTAKE_AUTO_FLAG)
      .limit(1);
    if (error) {
      console.error(
        "[ops-api] repair intake auto flag unreadable, treating as off:",
        error.message || error,
      );
      return false;
    }
    return (Array.isArray(data) ? data[0] : data)?.enabled === true;
  } catch (error) {
    console.error(
      "[ops-api] repair intake auto flag read threw, treating as off:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function money(value: string): number | null {
  const amount = Number(value.replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100) / 100
    : null;
}

// Ambrose: "TOTAL Purchase Order Price (ex GST) $2,529.00".
const AMBROSE_TOTAL_RE =
  /\btotal\s+purchase\s+order\s+price\s*\(\s*ex\.?\s*gst\s*\)\s*\$\s*([\d,]+(?:\.\d{1,2})?)/gi;
// MLB: "Subtotal $1,080.00" / "GST $108.00" / "Total $1,188.00" on three lines.
const MLB_TOTALS_RE =
  /\bsubtotal\s*\$\s*([\d,]+\.\d{2})\s*[\r\n]+\s*gst\s*\$\s*([\d,]+\.\d{2})\s*[\r\n]+\s*total\s*\$\s*([\d,]+\.\d{2})/gi;

/**
 * The ex-GST value one work order PDF states, or null. Null means "not read",
 * never zero: no total, two different totals, or an MLB block whose subtotal
 * and GST do not add up to its total.
 */
export function readWorkOrderValueExGst(
  pdfText: string | null | undefined,
): number | null {
  const text = String(pdfText || "");
  const values = new Set<number>();
  for (const match of text.matchAll(AMBROSE_TOTAL_RE)) {
    const amount = money(match[1]);
    if (amount === null) return null;
    values.add(amount);
  }
  for (const match of text.matchAll(MLB_TOTALS_RE)) {
    const subtotal = money(match[1]);
    const gst = money(match[2]);
    const total = money(match[3]);
    if (
      subtotal === null || gst === null || total === null ||
      Math.abs(subtotal + gst - total) > 0.011
    ) return null;
    values.add(subtotal);
  }
  return values.size === 1 ? [...values][0] : null;
}

/** One value across the plan's PDFs. A PDF stating no total (a schedule) is
 * ignored; two PDFs stating different totals is conflicting detail. */
export function planWorkOrderValueExGst(
  plan: Pick<DeterministicCasePlan, "pdfDocuments">,
): number | null {
  const values = new Set<number>();
  for (const document of plan.pdfDocuments || []) {
    if (document.status !== "extracted" || !document.text) continue;
    const hasTotal = new RegExp(AMBROSE_TOTAL_RE.source, "i").test(
      document.text,
    ) || new RegExp(MLB_TOTALS_RE.source, "i").test(document.text);
    if (!hasTotal) continue;
    const value = readWorkOrderValueExGst(document.text);
    if (value === null) return null;
    values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}

export interface RepairAutoIntakeStamp {
  version: typeof REPAIR_AUTO_INTAKE_VERSION;
  builder: string;
  family_evidence: string[];
  work_order_value_ex_gst: number;
}

export type RepairAutoIntakeDecision =
  | { auto: true; stamp: RepairAutoIntakeStamp }
  | { auto: false; reason: string };

/**
 * May this repair plan cross the guarded approval with nobody's tick?
 * Every "no" names its reason; the draft is still written and parks for review.
 */
export function decideRepairAutoIntake(
  plan: DeterministicCasePlan,
): RepairAutoIntakeDecision {
  const no = (reason: string): RepairAutoIntakeDecision => ({
    auto: false,
    reason,
  });
  if (String(plan.identity.jobFamily || "").toLowerCase() !== "repair") {
    return no("not_repair_family");
  }
  if (plan.identity.syntheticLivefireMarker) return no("synthetic_livefire");
  // A missing customer phone is the one gap a live plan may carry (it is the
  // planner's only "secondary" requirement, and a make-safe missing it is
  // approved today). Any other gap is a reason to wait.
  if (
    plan.state !== "confirmed_live_job" && plan.state !== "blocked_live_job"
  ) return no("plan_not_live");
  if (
    plan.blockedReasons.some((reason) => reason !== "missing:client_phone") ||
    plan.missingFields.some((field) => field !== "client_phone")
  ) return no("missing_fields");
  if (Object.keys(plan.conflictingFields || {}).length) {
    return no("conflicting_fields");
  }
  if (plan.secondaryObligation) return no("secondary_obligation");
  // An amended, reopened or cancelled instruction is a change to work a person
  // already knows about, not a clean first order.
  if (
    plan.parentRelation === "revision_of" ||
    plan.parentRelation === "reopen_of" ||
    plan.parentRelation === "cancellation_of" ||
    plan.targetRelation ||
    plan.story.some((event) =>
      event.kind === "revision" || event.kind === "reopen" ||
      event.kind === "cancellation"
    )
  ) return no("not_a_first_issue_order");
  const builder = canonicalCompanyDedupeKey(plan.identity.builderSlug);
  if (!plan.identity.companyId || !REPAIR_AUTO_INTAKE_BUILDERS.has(builder)) {
    return no("builder_not_named");
  }
  if (
    !plan.identity.externalRefCanonical || !plan.identity.builderPoCanonical ||
    !plan.identity.woPoIdentityKey
  ) return no("builder_reference_or_purchase_order_missing");
  if (!plan.identity.clientName || !plan.identity.siteAddress) {
    return no("client_or_site_missing");
  }
  const evidence = [...new Set(plan.familyEvidence || [])].sort();
  if (
    !evidence.length ||
    !evidence.every((code) => REPAIR_DECLARED_FAMILY_EVIDENCE.has(code))
  ) return no("repair_not_declared_by_builder");
  const value = planWorkOrderValueExGst(plan);
  if (value === null) return no("work_order_value_unreadable");
  return {
    auto: true,
    stamp: {
      version: REPAIR_AUTO_INTAKE_VERSION,
      builder,
      family_evidence: evidence,
      work_order_value_ex_gst: value,
    },
  };
}

/**
 * The mint-time half of the same rule, judged on the DRAFT that is about to
 * become a job rather than on anything a caller says. The stamp is written by
 * the deterministic runtime only while the flag is on, so a draft that was
 * already waiting when the flag was switched on carries none and still needs a
 * person.
 */
export function repairAutoIntakeMintStamp(input: {
  extraction: Record<string, any> | null | undefined;
  requestingCompanySlug: string | null | undefined;
  reviewedFamily: string | null | undefined;
}): RepairAutoIntakeStamp | null {
  const extraction = input.extraction || {};
  const stamp = extraction.repair_auto_intake;
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  if (extraction.deterministic_intake !== true) return null;
  if (stamp.version !== REPAIR_AUTO_INTAKE_VERSION) return null;
  if (String(extraction.makesafe_job_family || "").toLowerCase() !== "repair") {
    return null;
  }
  if (String(input.reviewedFamily || "").toLowerCase() !== "repair") {
    return null;
  }
  const builder = canonicalCompanyDedupeKey(input.requestingCompanySlug);
  if (!REPAIR_AUTO_INTAKE_BUILDERS.has(builder) || stamp.builder !== builder) {
    return null;
  }
  if (!String(extraction.builder_po_number || "").trim()) return null;
  const evidence = Array.isArray(stamp.family_evidence)
    ? stamp.family_evidence.map(String)
    : [];
  if (
    !evidence.length ||
    !evidence.every((code: string) => REPAIR_DECLARED_FAMILY_EVIDENCE.has(code))
  ) return null;
  const value = Number(stamp.work_order_value_ex_gst);
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    version: REPAIR_AUTO_INTAKE_VERSION,
    builder,
    family_evidence: evidence,
    work_order_value_ex_gst: value,
  };
}

/**
 * Fix 4. A collection or reattendance order whose original job cannot be found
 * used to become an exception with nothing to act on. When it arrives as a
 * first-issue purchase order (an instruction, not an amendment, with its PO
 * read), there is real work in it and a person must see it as a draft.
 */
export function orphanLifecycleOrderOpensReviewDraft(
  plan: DeterministicCasePlan,
): boolean {
  if (!plan.identity.builderPoCanonical) return false;
  if (!plan.story.some((event) => event.kind === "instruction")) return false;
  return !plan.story.some((event) =>
    event.kind === "revision" || event.kind === "cancellation"
  );
}

// ── Fix 3: an order for a claim that already has an open repair job ──────────

const DEAD_REPAIR_JOB_STATUSES = new Set([
  "cancelled",
  "canceled",
  "void",
  "voided",
  "superseded",
  "lost",
]);

export type RepairJobPurchaseOrderRelation = "empty" | "same" | "different";

export type OpenRepairJobMatch =
  | { kind: "none" }
  | {
    kind: "one";
    jobId: string;
    jobNumber: string | null;
    relation: RepairJobPurchaseOrderRelation;
  }
  | { kind: "many"; jobIds: string[]; jobNumbers: string[] };

function repairJobPurchaseOrders(
  metadata: Record<string, any>,
  detailExternalRef: unknown,
): Set<string> {
  const cores = [
    canonicalObligationPoCore(metadata.builder_po_number),
    canonicalObligationPoCore(metadata.builder_work_order_number, true),
    canonicalObligationPoCore(metadata.external_ref, true),
    canonicalObligationPoCore(detailExternalRef, true),
    ...(Array.isArray(metadata.builder_additional_work_orders)
      ? metadata.builder_additional_work_orders.map((entry: any) =>
        canonicalObligationPoCore(entry?.purchase_order)
      )
      : []),
  ];
  return new Set(cores.filter((core): core is string => Boolean(core)));
}

function purchaseOrderRelation(
  targetPo: string,
  metadata: Record<string, any>,
  detailExternalRef: unknown,
): RepairJobPurchaseOrderRelation {
  const held = repairJobPurchaseOrders(metadata, detailExternalRef);
  if (held.has(targetPo)) return "same";
  return held.size ? "different" : "empty";
}

/**
 * The open repair jobs on this builder and claim, read from the same
 * `makesafe_job_details` rows the obligation dedupe pages. That dedupe only
 * sees make-safe and restoration jobs (`isCanonicalSeedScopeJob`), so a repair
 * job was invisible to it and the same claim's next work order opened a new
 * draft. Only `jobs.type = 'repair'` is matched: the database lets an intake
 * case link to a make-safe or a repair job and nothing else.
 *
 * Open follows the Repairs board, not `jobs.status`, which goes stale behind
 * the board: any stage short of Complete is open.
 */
export function openRepairJobsOnClaim(
  identity: {
    builderSlug: string | null;
    externalRefCanonical: string | null;
    builderWoCanonical: string | null;
  },
  rows: readonly any[],
  prefixes: readonly string[],
): Array<{
  jobId: string;
  jobNumber: string | null;
  metadata: Record<string, any>;
  externalRef: unknown;
}> {
  const company = canonicalCompanyDedupeKey(identity.builderSlug);
  const claim = canonicalExternalObligationRef(
    identity.externalRefCanonical || identity.builderWoCanonical,
    prefixes,
  );
  if (!company || !claim) return [];
  const open = new Map<string, {
    jobId: string;
    jobNumber: string | null;
    metadata: Record<string, any>;
    externalRef: unknown;
  }>();
  for (const row of rows || []) {
    if (!row?.job_id) continue;
    const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    if (String(job?.type || "").toLowerCase() !== "repair") continue;
    const status = String(job?.status || "").trim().toLowerCase();
    if (DEAD_REPAIR_JOB_STATUSES.has(status)) continue;
    const metadata = job?.metadata && typeof job.metadata === "object"
      ? job.metadata
      : {};
    if (insuranceRepairStage({ status, metadata }) === "complete") continue;
    const rowCompany = canonicalCompanyDedupeKey(
      row.requesting_company_slug || row.requesting_company_name ||
        metadata.requesting_company?.slug || metadata.requesting_company?.name,
    );
    if (rowCompany !== company) continue;
    const claims = [
      row.external_ref,
      metadata.external_ref,
      metadata.builder_claim_ref,
      metadata.builder_work_order_number,
    ].map((value) => canonicalExternalObligationRef(value, prefixes));
    if (!claims.includes(claim)) continue;
    open.set(String(row.job_id), {
      jobId: String(row.job_id),
      jobNumber: job?.job_number ? String(job.job_number) : null,
      metadata,
      externalRef: row.external_ref,
    });
  }
  return [...open.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
}

/**
 * Which open repair job a REPAIR order lands on, and how the order's purchase
 * order relates to what that job already holds.
 */
export function matchOpenRepairJob(
  identity: {
    builderSlug: string | null;
    externalRefCanonical: string | null;
    builderWoCanonical: string | null;
    builderPoCanonical: string | null;
  },
  rows: readonly any[],
  prefixes: readonly string[],
): OpenRepairJobMatch {
  const targetPo = canonicalObligationPoCore(identity.builderPoCanonical);
  if (!targetPo) return { kind: "none" };
  const matches = new Map<
    string,
    { jobNumber: string | null; relation: RepairJobPurchaseOrderRelation }
  >();
  for (const job of openRepairJobsOnClaim(identity, rows, prefixes)) {
    matches.set(job.jobId, {
      jobNumber: job.jobNumber,
      relation: purchaseOrderRelation(targetPo, job.metadata, job.externalRef),
    });
  }
  const entries = [...matches.entries()];
  if (!entries.length) return { kind: "none" };
  // A job that already holds this purchase order is this order's own job,
  // whatever else is open on the claim.
  const same = entries.filter(([, value]) => value.relation === "same");
  const chosen = same.length === 1
    ? same[0]
    : entries.length === 1
    ? entries[0]
    : null;
  if (!chosen) {
    return {
      kind: "many",
      jobIds: entries.map(([jobId]) => jobId).sort(),
      jobNumbers: entries.map(([jobId, value]) => value.jobNumber || jobId)
        .sort(),
    };
  }
  return {
    kind: "one",
    jobId: chosen[0],
    jobNumber: chosen[1].jobNumber,
    relation: chosen[1].relation,
  };
}

export const REPAIR_WORK_ORDER_LANDED_EVENT =
  "repair_work_order_landed_on_existing_job";

export interface RepairWorkOrderLanding {
  jobId: string;
  caseId: string;
  instructionKey: string;
  claimRef: string | null;
  workOrderNumber: string | null;
  purchaseOrder: string;
  jobFamily: string | null;
  valueExGst: number | null;
  sourcePostIds: readonly string[];
  receivedAt: string | null;
  /** Staged work order PDFs, in the shape `ensureIntakeWorkOrderEvidence` takes. */
  attachments: readonly any[];
}

export interface RepairWorkOrderLandingDeps {
  attachEvidence: (
    client: any,
    jobIds: readonly string[],
    attachments: readonly any[],
  ) => Promise<void>;
}

/**
 * Records a work order on the repair job its claim already has. Every step can
 * run twice: a job with no purchase order takes this one as its own, a job that
 * already holds a different one lists this as an additional work order, and a
 * job that already holds this one is left as it is. The PDF is attached and one
 * job event is written per instruction. It sends nothing to anyone, never moves
 * the board stage and never touches `jobs.status`.
 */
export async function landWorkOrderOnRepairJob(
  client: any,
  landing: RepairWorkOrderLanding,
  deps: RepairWorkOrderLandingDeps,
): Promise<
  { relation: RepairJobPurchaseOrderRelation; eventCreated: boolean }
> {
  const { data: job, error: jobError } = await client.from("jobs")
    .select("id,job_number,type,metadata")
    .eq("id", landing.jobId)
    .maybeSingle();
  if (jobError || !job?.id) {
    throw new Error(
      `repair landing job read failed: ${
        jobError?.message || jobError || "job not found"
      }`,
    );
  }
  if (String(job.type || "").toLowerCase() !== "repair") {
    throw new Error("repair landing refused: target is not a repair job");
  }
  const metadata = job.metadata && typeof job.metadata === "object"
    ? job.metadata
    : {};
  const targetPo = canonicalObligationPoCore(landing.purchaseOrder);
  if (!targetPo) {
    throw new Error("repair landing refused: no purchase order");
  }
  const relation = purchaseOrderRelation(targetPo, metadata, null);
  let nextMetadata: Record<string, any> | null = null;
  if (relation === "empty") {
    nextMetadata = {
      ...metadata,
      builder_claim_ref: metadata.builder_claim_ref || landing.claimRef,
      builder_work_order_number: landing.workOrderNumber ||
        metadata.builder_work_order_number || null,
      builder_po_number: landing.purchaseOrder,
      ...(landing.valueExGst !== null &&
          metadata.builder_work_order_value_ex_gst == null
        ? {
          builder_work_order_value_ex_gst: landing.valueExGst,
          builder_work_order_value_source:
            "builder_work_order_pdf_not_our_quote",
        }
        : {}),
    };
  } else if (relation === "different") {
    nextMetadata = {
      ...metadata,
      builder_additional_work_orders: [
        ...(Array.isArray(metadata.builder_additional_work_orders)
          ? metadata.builder_additional_work_orders
          : []),
        {
          purchase_order: landing.purchaseOrder,
          work_order_number: landing.workOrderNumber,
          claim_ref: landing.claimRef,
          job_family: landing.jobFamily,
          value_ex_gst: landing.valueExGst,
          received_at: landing.receivedAt,
          source_post_ids: [...landing.sourcePostIds],
        },
      ],
    };
  }
  if (nextMetadata) {
    const { error } = await client.from("jobs")
      .update({ metadata: nextMetadata })
      .eq("id", landing.jobId);
    if (error) {
      throw new Error(
        `repair landing job write failed: ${error.message || error}`,
      );
    }
  }
  if (landing.attachments.length) {
    await deps.attachEvidence(client, [landing.jobId], landing.attachments);
  }
  const { data: events, error: eventsError } = await client.from("job_events")
    .select("id,detail_json")
    .eq("job_id", landing.jobId)
    .eq("event_type", REPAIR_WORK_ORDER_LANDED_EVENT);
  if (eventsError) {
    throw new Error(
      `repair landing event read failed: ${eventsError.message || eventsError}`,
    );
  }
  if (
    (events || []).some((event: any) =>
      event?.detail_json?.instruction_key === landing.instructionKey
    )
  ) return { relation, eventCreated: false };
  const { error: eventError } = await client.from("job_events").insert({
    job_id: landing.jobId,
    event_type: REPAIR_WORK_ORDER_LANDED_EVENT,
    detail_json: {
      notice: "new_work_order_on_existing_job",
      instruction_key: landing.instructionKey,
      intake_case_id: landing.caseId,
      purchase_order: landing.purchaseOrder,
      work_order_number: landing.workOrderNumber,
      claim_ref: landing.claimRef,
      job_family: landing.jobFamily,
      value_ex_gst: landing.valueExGst,
      purchase_order_relation: relation,
      received_at: landing.receivedAt,
      source_post_ids: [...landing.sourcePostIds],
    },
  });
  if (eventError) {
    throw new Error(
      `repair landing event write failed: ${eventError.message || eventError}`,
    );
  }
  return { relation, eventCreated: true };
}

// ── A make-safe raised on a claim that has an open repair job ────────────────

export const MAKE_SAFE_RAISED_ON_REPAIR_CLAIM_EVENT =
  "make_safe_raised_on_repair_claim";

/**
 * The notice on a repair job that a make-safe job was just raised on its claim.
 * The make-safe is never held for it. It exists because a repair order can be
 * misread as a make-safe (a second "additional costs" order with no repair
 * header): the misread is not prevented, it is made visible here. One event per
 * instruction; nothing is sent to anyone and the repair job is not changed.
 */
export async function noteMakeSafeRaisedOnRepairClaim(
  client: any,
  note: {
    repairJobId: string;
    makeSafeJobId: string;
    caseId: string;
    instructionKey: string;
    claimRef: string | null;
    purchaseOrder: string | null;
    jobFamily: string | null;
    sourcePostIds: readonly string[];
    receivedAt: string | null;
  },
): Promise<{ eventCreated: boolean }> {
  const { data: events, error: eventsError } = await client.from("job_events")
    .select("id,detail_json")
    .eq("job_id", note.repairJobId)
    .eq("event_type", MAKE_SAFE_RAISED_ON_REPAIR_CLAIM_EVENT);
  if (eventsError) {
    throw new Error(
      `make-safe on repair claim event read failed: ${
        eventsError.message || eventsError
      }`,
    );
  }
  if (
    (events || []).some((event: any) =>
      event?.detail_json?.instruction_key === note.instructionKey
    )
  ) return { eventCreated: false };
  const { error } = await client.from("job_events").insert({
    job_id: note.repairJobId,
    event_type: MAKE_SAFE_RAISED_ON_REPAIR_CLAIM_EVENT,
    detail_json: {
      notice: "make_safe_raised_on_same_claim",
      make_safe_job_id: note.makeSafeJobId,
      instruction_key: note.instructionKey,
      intake_case_id: note.caseId,
      claim_ref: note.claimRef,
      purchase_order: note.purchaseOrder,
      job_family: note.jobFamily,
      received_at: note.receivedAt,
      source_post_ids: [...note.sourcePostIds],
    },
  });
  if (error) {
    throw new Error(
      `make-safe on repair claim event write failed: ${error.message || error}`,
    );
  }
  return { eventCreated: true };
}
