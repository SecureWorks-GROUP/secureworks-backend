// DB-bound deterministic make-safe intake runtime.
// deno-lint-ignore-file no-explicit-any
//
// Reads the complete bounded source window before planning. Dry-run performs no
// writes or storage mutations. Live mode is reachable only through the DB-backed
// cutover switch and never falls back to AI.

import {
  buildDeterministicIntakePlan,
  DETERMINISTIC_INTAKE_VERSION,
  type DeterministicAttachment,
  type DeterministicCasePlan,
  type DeterministicCompanyProfile,
  type DeterministicIntakePlan,
  type DeterministicSourceItem,
  selectIntakeMode,
} from "./makesafe_deterministic_intake.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SES_MAILBOX = "ses@secureworkswa.com.au";

export interface DeterministicRuntimeOptions {
  dryRun?: boolean;
  days?: number;
  onlyUnscanned?: boolean;
  nowIso?: string;
  maxCases?: number;
  approveDraft?: (client: any, body: any) => Promise<any>;
}

// An edge invocation has a hard wall clock. Each run commits a bounded slice of
// cases and stamps them as it goes, so a timeout never discards accounting for
// drafts and jobs that already exist.
const DEFAULT_MAX_CASES_PER_RUN = 25;
// Repeat failures must not spend the commit budget, but they still cost time, so
// one run stops after this many attempts regardless of how many committed.
const MAX_ATTEMPT_MULTIPLIER = 4;
// PostgREST caps an unranged response at 1000 rows, so batched source reads page
// below that cap rather than silently truncating.
const SOURCE_PAGE_SIZE = 500;

export interface DeterministicRuntimeReport {
  ok: true;
  mode: "deterministic";
  dry_run: boolean;
  ai_enabled: false;
  ai_calls: 0;
  generated_at: string;
  days: number;
  totals: DeterministicIntakePlan["totals"] & {
    case_rows_created: number;
    source_rows_created: number;
    drafts_created: number;
    jobs_created: number;
    resumed: number;
    write_failures: number;
    cases_attempted: number;
    cases_deferred: number;
    cases_failed: number;
    job_creation_deferred: number;
  };
  // True when the run spent its attempt ceiling without committing a single case.
  // Repeat failures crowding out advanceable work is then visible, not silent.
  attempt_cap_reached_without_commit: boolean;
  by_builder_and_outcome: Record<string, Record<string, number>>;
  by_builder_and_reason: Record<string, Record<string, number>>;
  // Non-PII failure classification. Keys are message classes, never source content.
  write_failure_reasons: Record<string, number>;
  // Storage read/write blockers observed this run, in first-seen order. These are
  // bucket-level failures, not credential problems, and every distinct one is kept.
  storage_blockers: string[];
}

// Maps a thrown failure onto a small fixed vocabulary. Nothing derived from
// source bodies, subjects, or identity values is retained.
function classifyWriteFailure(error: unknown): string {
  const code = (error as any)?.code;
  const message = String((error as any)?.message || error || "");
  if (/attachment staging failed/i.test(message)) return "attachment_staging";
  if (/lineage parent is not persisted/i.test(message)) {
    return "lineage_parent_pending";
  }
  if (/approval returned no job id/i.test(message)) return "approval_no_job";
  if (/no job link; reconciliation required/i.test(message)) {
    return "approved_draft_unlinked";
  }
  if (/draft insert failed/i.test(message)) return "draft_insert";
  if (/case insert failed/i.test(message)) return "case_insert";
  if (/case update failed/i.test(message)) return "case_update";
  if (/transition is not allowed/i.test(message)) {
    return "case_transition_not_allowed";
  }
  if (/source accounting failed/i.test(message)) return "source_accounting";
  if (/lineage parent read failed/i.test(message)) return "lineage_parent_read";
  if (code) return `postgres_${String(code)}`;
  return "unclassified";
}

export async function loadDeterministicIntakeMode(
  client: any,
): Promise<"legacy" | "deterministic"> {
  const { data, error } = await client.from("makesafe_cron_settings")
    .select("intake_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    // Pre-migration safe only for the known missing-column shape. Any network,
    // auth, timeout, or other read failure aborts the scan: it must never turn a
    // configured deterministic deployment into a silent legacy/AI fallback.
    if (
      String(error.code || "") === "42703" ||
      /intake_mode.*(?:does not exist|schema cache|column)/i.test(
        error.message || "",
      )
    ) return "legacy";
    throw new Error(`intake mode read failed: ${error.message || error}`);
  }
  return selectIntakeMode(data?.intake_mode);
}

async function fetchAll(
  queryFactory: (from: number, to: number) => Promise<any>,
): Promise<any[]> {
  const rows: any[] = [];
  const size = 500;
  for (let from = 0;; from += size) {
    const result = await queryFactory(from, from + size - 1);
    if (result.error) {
      throw new Error(result.error.message || String(result.error));
    }
    const page = result.data || [];
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows;
}

// Graph post ids are long. Keep PostgREST .in() URLs comfortably below gateway
// limits rather than batching by a row-count that is safe only for UUIDs.
function chunk<T>(values: readonly T[], size = 25): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size) as T[]);
  }
  return result;
}

function linksFromBody(
  postId: string,
  body: string | null,
): Array<{ url: string; label: null; sourcePostId: string }> {
  const found = new Set<string>();
  for (const match of String(body || "").matchAll(/https:\/\/[^\s<>"']+/gi)) {
    found.add(match[0].replace(/[),.;]+$/, ""));
  }
  return [...found].map((url) => ({ url, label: null, sourcePostId: postId }));
}

async function readInputs(
  client: any,
  options: Required<
    Pick<DeterministicRuntimeOptions, "days" | "onlyUnscanned" | "nowIso">
  >,
): Promise<
  {
    sources: DeterministicSourceItem[];
    profiles: DeterministicCompanyProfile[];
  }
> {
  const since = new Date(Date.parse(options.nowIso) - options.days * 86_400_000)
    .toISOString();
  const columns = [
    "post_id",
    "internet_message_id",
    "conversation_id",
    "thread_id",
    "subject",
    "body_content",
    "body_preview",
    "from_email",
    "from_name",
    "received_at",
    "makesafe_scanned_at",
  ].join(",");
  const emails = await fetchAll(async (from, to) => {
    let query = client.from("emails").select(columns)
      .eq("mailbox", SES_MAILBOX)
      .is("pii_purged_at", null)
      .gte("received_at", since)
      .order("received_at", { ascending: true })
      .range(from, to);
    if (options.onlyUnscanned) query = query.is("makesafe_scanned_at", null);
    return await query;
  });
  const postIds = emails.map((row) => row.post_id).filter(Boolean);
  const attachmentRows: any[] = [];
  for (const ids of chunk(postIds)) {
    const { data, error } = await client.from("email_attachments")
      .select("id,email_id,name,content_type,storage_path,status,size_bytes")
      .in("email_id", ids);
    if (error) {
      throw new Error(
        `email_attachments read failed: ${error.message || error}`,
      );
    }
    attachmentRows.push(...(data || []));
  }
  const attachmentsByPost = new Map<string, DeterministicAttachment[]>();
  for (const row of attachmentRows) {
    const attachment: DeterministicAttachment = {
      id: row.id,
      sourcePostId: row.email_id,
      name: row.name || null,
      contentType: row.content_type || null,
      storagePath: row.storage_path || null,
      status: row.status || null,
      sizeBytes: row.size_bytes || null,
    };
    attachmentsByPost.set(row.email_id, [
      ...(attachmentsByPost.get(row.email_id) || []),
      attachment,
    ]);
  }
  const { data: companies, error: companyError } = await client.from(
    "makesafe_companies",
  )
    .select("id,slug,name,sender_patterns,parsing_rules")
    .eq("active", true);
  if (companyError) {
    throw new Error(
      `makesafe_companies read failed: ${companyError.message || companyError}`,
    );
  }
  const profiles = (companies || []).map((row: any) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    senderPatterns: Array.isArray(row.sender_patterns)
      ? row.sender_patterns
      : [],
    parsingRules: row.parsing_rules || null,
  }));
  const sources = emails.map((row: any): DeterministicSourceItem => {
    const body = row.body_content || row.body_preview || "";
    return {
      postId: row.post_id,
      internetMessageId: row.internet_message_id || null,
      conversationId: row.conversation_id || null,
      threadId: row.thread_id || null,
      fromEmail: row.from_email || null,
      fromName: row.from_name || null,
      subject: row.subject || null,
      body,
      receivedAt: row.received_at,
      attachments: attachmentsByPost.get(row.post_id) || [],
      links: linksFromBody(row.post_id, body),
    };
  });
  return { sources, profiles };
}

function byBuilderOutcome(
  plan: DeterministicIntakePlan,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  const caseByInstruction = new Map(
    plan.cases.map((c) => [c.instructionKey, c]),
  );
  for (const item of plan.sourceClassifications) {
    const builder =
      caseByInstruction.get(item.instructionKey)?.identity.builderSlug ||
      "unknown";
    result[builder] ||= {};
    result[builder][item.outcome] = (result[builder][item.outcome] || 0) + 1;
  }
  return result;
}

function byBuilderReason(
  plan: DeterministicIntakePlan,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const intakeCase of plan.cases) {
    const builder = intakeCase.identity.builderSlug || "unknown";
    const reason = intakeCase.reasonCode ||
      (intakeCase.state === "blocked_live_job"
        ? "blocked_secondary"
        : "confirmed");
    result[builder] ||= {};
    result[builder][reason] = (result[builder][reason] || 0) +
      intakeCase.sourcePostIds.length;
  }
  return result;
}

function sourceRole(plan: DeterministicCasePlan, postId: string): string {
  const eventKinds = plan.story.filter((event) => event.sourcePostId === postId)
    .map((event) => event.kind);
  if (eventKinds.includes("cancellation")) return "cancellation_notice";
  if (eventKinds.includes("revision")) return "revision_notice";
  if (postId !== plan.primarySourcePostId) return "resend";
  return "original";
}

function inferredParentRelation(
  plan: DeterministicCasePlan,
): DeterministicCasePlan["parentRelation"] {
  if (plan.parentRelation) return plan.parentRelation;
  if (plan.reasonCode === "cancellation") return "cancellation_of";
  if (plan.story.some((event) => event.kind === "reopen")) return "reopen_of";
  if (plan.story.some((event) => event.kind === "revision")) {
    return "revision_of";
  }
  return null;
}

function resolvedState(plan: DeterministicCasePlan, jobId: string | null) {
  return jobId
    ? plan.state
    : plan.state === "accounted_non_wo"
    ? "accounted_non_wo"
    : "exception";
}

function casePayload(
  plan: DeterministicCasePlan,
  jobId: string | null,
  parent: { id: string; lineage_id: string; cycle: number } | null,
): Record<string, any> {
  const state = resolvedState(plan, jobId);
  const reason = jobId
    ? plan.reasonCode
    : plan.reasonCode || (plan.state === "accounted_non_wo"
      ? "non_makesafe"
      : plan.state === "confirmed_live_job" || plan.state === "blocked_live_job"
      // The adapter parsed fine; the case is only accounted ahead of the guarded
      // job creation, so it must not be reported as an adapter failure.
      ? "awaiting_job_creation"
      : "adapter_parse_failure");
  return {
    org_id: DEFAULT_ORG_ID,
    instruction_key: plan.instructionKey,
    ...(parent
      ? {
        parent_case_id: parent.id,
        parent_relation: inferredParentRelation(plan),
      }
      : {}),
    company_id: plan.identity.companyId,
    company_slug_raw: plan.identity.builderSlug,
    company_key: plan.identity.companyKey,
    external_ref_raw: plan.identity.externalRefRaw,
    external_ref_canonical: plan.identity.externalRefCanonical,
    builder_wo_raw: plan.identity.builderWoRaw,
    builder_wo_canonical: plan.identity.builderWoCanonical,
    builder_po_raw: plan.identity.builderPoRaw,
    builder_po_canonical: plan.identity.builderPoCanonical,
    deliverable_ref_raw: plan.identity.deliverableRefRaw,
    deliverable_ref_canonical: plan.identity.deliverableRefCanonical,
    wo_po_identity_key: plan.identity.woPoIdentityKey,
    normaliser_version: plan.identity.normaliserVersion,
    raw_identity_json: {
      builder_slug: plan.identity.builderSlug,
      external_ref: plan.identity.externalRefRaw,
      builder_wo: plan.identity.builderWoRaw,
      builder_po: plan.identity.builderPoRaw,
      deliverable: plan.identity.deliverableRefRaw,
    },
    field_provenance: plan.identity.companyId
      ? {
        deterministic_adapter_v1: {
          method: "deterministic",
          rule: plan.adapterVersion,
          sourcePostId: plan.primarySourcePostId,
        },
      }
      : {},
    client_name: plan.identity.clientName,
    client_phone: plan.identity.clientPhone,
    client_email: plan.identity.clientEmail,
    site_address: plan.identity.siteAddress,
    site_suburb: plan.identity.siteSuburb,
    missing_fields: plan.missingFields,
    conflicting_fields: plan.conflictingFields,
    state,
    reason_code: state === "exception" || state === "accounted_non_wo"
      ? reason
      : null,
    blocked_reasons: state === "blocked_live_job" ? plan.blockedReasons : [],
    job_id: jobId,
    is_authoritative: true,
    // Guarded approval passes suppress_manager_notification for this provenance,
    // so the manager SMS side effect really is suppressed for deterministic cases.
    side_effects_suppressed: true,
    last_decision_provenance: "deterministic",
    last_decision_actor: DETERMINISTIC_INTAKE_VERSION,
    last_decision_reason: jobId
      ? `deterministic ${state}`
      : `deterministic ${reason}`,
    received_at: plan.story[0]?.occurredAt || new Date().toISOString(),
    adapter_id: plan.adapterId,
    adapter_version: plan.adapterVersion,
    manifest_version: plan.manifestVersion,
    story_json: plan.story,
    evidence_map: plan.evidenceMap,
    recovery_cursor: plan.recoveryCursor,
    source_fingerprint: plan.instructionFingerprint,
  };
}

async function stageAttachments(
  client: any,
  plan: DeterministicCasePlan,
  sources: Map<string, DeterministicSourceItem>,
  onStorageBlocker: (blocker: string) => void,
): Promise<any[]> {
  const result: any[] = [];
  const attachments = plan.sourcePostIds.flatMap((id) =>
    sources.get(id)?.attachments || []
  )
    .filter((a) =>
      a.status === "uploaded" && a.storagePath &&
      (/pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || ""))
    );
  for (const attachment of attachments) {
    const safeName = (attachment.name || "work-order.pdf").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    ).slice(-80);
    const path = `makesafe-deterministic/${
      encodeURIComponent(plan.instructionFingerprint)
    }/${encodeURIComponent(attachment.id)}/${safeName}`;
    const { data: blob, error: downloadError } = await client.storage.from(
      "makesafe-emails",
    ).download(attachment.storagePath!);
    if (downloadError || !blob) {
      onStorageBlocker("makesafe-emails_download_failed");
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { error: uploadError } = await client.storage.from("job-documents")
      .upload(path, bytes, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (uploadError) {
      onStorageBlocker("job-documents_upload_failed");
      continue;
    }
    const { data: publicUrl } = client.storage.from("job-documents")
      .getPublicUrl(path);
    result.push({
      name: attachment.name,
      file_name: attachment.name,
      storage_url: path,
      pdf_url: publicUrl?.publicUrl || null,
      is_work_order: true,
      deterministic_artifact_key: `pdf:${plan.instructionKey}:${attachment.id}`,
    });
  }
  return result;
}

async function findCase(
  client: any,
  instructionKey: string,
): Promise<any | null> {
  const { data } = await client.from("makesafe_intake_cases")
    .select("id,instruction_key,lineage_id,cycle,state,job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("instruction_key", instructionKey)
    .maybeSingle();
  return data || null;
}

async function readPersistedCases(
  client: any,
  cases: readonly DeterministicCasePlan[],
): Promise<Map<string, any>> {
  const rows = new Map<string, any>();
  for (const keys of chunk(cases.map((c) => c.instructionKey), 200)) {
    const { data, error } = await client.from("makesafe_intake_cases")
      .select("id,instruction_key,lineage_id,cycle,state,job_id")
      .eq("org_id", DEFAULT_ORG_ID)
      .in("instruction_key", keys);
    // Failing open would silently degrade the run ordering back to a plain
    // head-of-list slice, so a partial read aborts instead.
    if (error) {
      throw new Error(
        `deterministic case state read failed: ${error.message || error}`,
      );
    }
    for (const row of data || []) rows.set(row.instruction_key, row);
  }
  return rows;
}

// Which sources a case has already accounted. New evidence arriving on a case is
// the only reason a previously stuck case can advance, so it is the signal that
// keeps repeat failures from re-occupying the priority head of every run.
async function readPersistedSourcePostIds(
  client: any,
  caseIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const byCase = new Map<string, Set<string>>();
  for (const ids of chunk(caseIds, 200)) {
    // A truncated page would look like unaccounted evidence and put stuck cases
    // back at the head of every run, so the read is paged to exhaustion.
    for (let from = 0;; from += SOURCE_PAGE_SIZE) {
      const { data, error } = await client.from("makesafe_intake_case_sources")
        .select("case_id,post_id")
        .eq("org_id", DEFAULT_ORG_ID)
        .in("case_id", ids)
        .order("case_id", { ascending: true })
        .order("post_id", { ascending: true })
        .range(from, from + SOURCE_PAGE_SIZE - 1);
      if (error) {
        throw new Error(
          `deterministic case source read failed: ${error.message || error}`,
        );
      }
      const rows = data || [];
      for (const row of rows) {
        const set = byCase.get(row.case_id) || new Set<string>();
        set.add(row.post_id);
        byCase.set(row.case_id, set);
      }
      if (rows.length < SOURCE_PAGE_SIZE) break;
    }
  }
  return byCase;
}

async function findIdentityParent(
  client: any,
  plan: DeterministicCasePlan,
): Promise<any | null> {
  if (!inferredParentRelation(plan) || !plan.identity.companyKey) return null;
  let query = client.from("makesafe_intake_cases")
    .select("id,instruction_key,lineage_id,cycle,state,job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("company_key", plan.identity.companyKey)
    .in("state", ["confirmed_live_job", "blocked_live_job"])
    .order("received_at", { ascending: false })
    .limit(1);
  if (plan.identity.woPoIdentityKey) {
    query = query.eq("wo_po_identity_key", plan.identity.woPoIdentityKey);
  } else if (plan.identity.externalRefCanonical) {
    query = query.eq(
      "external_ref_canonical",
      plan.identity.externalRefCanonical,
    );
  } else return null;
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`lineage parent read failed: ${error.message || error}`);
  }
  return data || null;
}

async function findDraft(
  client: any,
  deterministicKey: string,
): Promise<any | null> {
  const { data } = await client.from("makesafe_intake_drafts")
    .select("id,status,approved_job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("deterministic_key", deterministicKey)
    .maybeSingle();
  return data || null;
}

async function ensureDraftAndJob(
  client: any,
  plan: DeterministicCasePlan,
  sourceMap: Map<string, DeterministicSourceItem>,
  approveDraft: (client: any, body: any) => Promise<any>,
  onStorageBlocker: (blocker: string) => void,
): Promise<
  {
    jobId: string;
    draftCreated: boolean;
    jobCreated: boolean;
    resumed: boolean;
  }
> {
  const key = plan.recoveryCursor.sideEffectKeys.draft;
  let draft = await findDraft(client, key);
  let draftCreated = false;
  if (!draft) {
    const primary = sourceMap.get(plan.primarySourcePostId)!;
    const attachments = await stageAttachments(
      client,
      plan,
      sourceMap,
      onStorageBlocker,
    );
    if (
      !attachments.length && plan.identity.jobFamily !== "roof_report" &&
      plan.identity.jobFamily !== "assessment_report_quote"
    ) {
      throw new Error("deterministic work-order attachment staging failed");
    }
    const extraction = {
      deterministic_intake: true,
      deterministic_version: DETERMINISTIC_INTAKE_VERSION,
      makesafe_job_family: plan.identity.jobFamily,
      builder_claim_ref: plan.identity.externalRefCanonical,
      builder_work_order_number: plan.identity.builderWoCanonical,
      builder_po_number: plan.identity.builderPoCanonical,
      portal_links: primary.links,
      story: plan.story,
      evidence_map: plan.evidenceMap,
      recovery_cursor: plan.recoveryCursor,
      builder_email_subject: primary.subject,
      builder_email_received_at: primary.receivedAt,
    };
    const { data, error } = await client.from("makesafe_intake_drafts").insert({
      org_id: DEFAULT_ORG_ID,
      mailbox: SES_MAILBOX,
      graph_message_id: `deterministic:${plan.instructionFingerprint}`,
      received_at: primary.receivedAt,
      from_email: primary.fromEmail,
      from_name: primary.fromName || null,
      subject: primary.subject,
      body_preview: null,
      requesting_company_slug: plan.identity.builderSlug,
      requesting_company_name: plan.identity.builderSlug,
      external_ref: plan.identity.builderWoCanonical ||
        plan.identity.externalRefCanonical,
      client_name: plan.identity.clientName,
      client_phone: plan.identity.clientPhone,
      client_email: plan.identity.clientEmail,
      site_address: plan.identity.siteAddress,
      site_suburb: plan.identity.siteSuburb,
      description: plan.identity.jobFamily,
      confidence: "high",
      missing_fields: plan.blockedReasons,
      extraction_json: extraction,
      attachments_json: attachments,
      report_type: plan.identity.jobFamily === "roof_report"
        ? "roof_report"
        : plan.identity.jobFamily === "assessment_report_quote"
        ? "assessment_report"
        : null,
      status: "needs_review",
      deterministic_key: key,
    }).select("id,status,approved_job_id").single();
    if (error) {
      draft = await findDraft(client, key);
      if (!draft) {
        throw new Error(
          `deterministic draft insert failed: ${error.message || error}`,
        );
      }
    } else {
      draft = data;
      draftCreated = true;
    }
  }
  if (draft.approved_job_id) {
    return {
      jobId: draft.approved_job_id,
      draftCreated,
      jobCreated: false,
      resumed: true,
    };
  }
  if (draft.status === "approved") {
    const refreshed = await findDraft(client, key);
    if (refreshed?.approved_job_id) {
      return {
        jobId: refreshed.approved_job_id,
        draftCreated,
        jobCreated: false,
        resumed: true,
      };
    }
    throw new Error(
      "approved deterministic draft has no job link; reconciliation required",
    );
  }
  const approved = await approveDraft(client, {
    draft_id: draft.id,
    approved_by: DETERMINISTIC_INTAKE_VERSION,
    review_notes:
      "Deterministic adapter approval through the existing guarded intake gate. No allocation, invoice, send or money action.",
  });
  const jobId = approved?.job?.id;
  if (!jobId) throw new Error("guarded approval returned no job id");
  return { jobId, draftCreated, jobCreated: true, resumed: !draftCreated };
}

// Mirrors makesafe_intake_case_transition_allowed in migration 20260720000001.
// An upgrade is attempted only along an edge the database already accepts.
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  confirmed_live_job: ["blocked_live_job"],
  blocked_live_job: ["confirmed_live_job", "exception"],
  exception: ["confirmed_live_job", "blocked_live_job", "accounted_non_wo"],
  accounted_non_wo: ["exception"],
};

async function insertCaseAndSources(
  client: any,
  plan: DeterministicCasePlan,
  jobId: string | null,
  sourceMap: Map<string, DeterministicSourceItem>,
  knownExisting?: any | null,
  skipSources = false,
): Promise<
  {
    caseRow: any;
    caseCreated: boolean;
    caseUpgraded: boolean;
    sourceCreated: number;
    resumed: boolean;
  }
> {
  let existing = knownExisting !== undefined
    ? knownExisting
    : await findCase(client, plan.instructionKey);
  let caseCreated = false;
  let caseUpgraded = false;
  if (!existing) {
    const parent = plan.parentInstructionKey
      ? await findCase(client, plan.parentInstructionKey)
      : await findIdentityParent(client, plan);
    if (plan.parentInstructionKey && !parent) {
      throw new Error("lineage parent is not persisted yet; retry child later");
    }
    const { data, error } = await client.from("makesafe_intake_cases")
      .insert(casePayload(plan, jobId, parent))
      .select("id,instruction_key,lineage_id,cycle,state,job_id")
      .single();
    if (error) {
      existing = await findCase(client, plan.instructionKey);
      if (!existing) {
        throw new Error(
          `deterministic case insert failed: ${error.message || error}`,
        );
      }
    } else {
      existing = data;
      caseCreated = true;
    }
  } else {
    // A resumed case is re-decided against the current plan. Late evidence (a work
    // order PDF that landed after the instruction email) must be able to promote a
    // reason-coded exception into a live job rather than staying stuck forever.
    const desired = casePayload(plan, jobId, null);
    const nextState = desired.state as string;
    if (
      nextState !== existing.state &&
      (ALLOWED_TRANSITIONS[existing.state as string] || []).includes(nextState)
    ) {
      const {
        org_id: _org,
        instruction_key: _key,
        received_at: _received,
        ...mutable
      } = desired;
      const { data, error } = await client.from("makesafe_intake_cases")
        .update({ ...mutable, job_id: jobId ?? existing.job_id ?? null })
        .eq("org_id", DEFAULT_ORG_ID)
        .eq("instruction_key", plan.instructionKey)
        .select("id,instruction_key,lineage_id,cycle,state,job_id")
        .single();
      if (error) {
        throw new Error(
          `deterministic case update failed: ${error.message || error}`,
        );
      }
      existing = data;
      caseUpgraded = true;
    }
  }
  let sourceCreated = 0;
  for (const postId of skipSources ? [] : plan.sourcePostIds) {
    const source = sourceMap.get(postId)!;
    const refs = source.attachments.map((a) => a.id);
    const { error } = await client.from("makesafe_intake_case_sources").insert({
      org_id: DEFAULT_ORG_ID,
      case_id: existing.id,
      post_id: postId,
      role: sourceRole(plan, postId),
      internet_message_id: source.internetMessageId || null,
      conversation_id: source.conversationId || null,
      thread_id: source.threadId || null,
      attachment_refs: refs,
      raw_identity_json: {},
      evidence: {
        adapter_id: plan.adapterId,
        instruction_key: plan.instructionKey,
      },
      provenance: "deterministic",
      received_at: source.receivedAt,
    });
    if (!error) sourceCreated++;
    else if (
      String(error.code) !== "23505" &&
      !/duplicate|unique/i.test(error.message || "")
    ) {
      throw new Error(
        `deterministic source accounting failed: ${error.message || error}`,
      );
    }
  }
  return {
    caseRow: existing,
    caseCreated,
    caseUpgraded,
    sourceCreated,
    resumed: !caseCreated,
  };
}

async function writeHealth(
  client: any,
  nowIso: string,
  writeFailures: number,
  draftsCreated: number,
  jobsCreated: number,
): Promise<void> {
  const { error } = await client.from("makesafe_intake_health").upsert({
    id: true,
    extraction_status: writeFailures > 0 ? "degraded" : "ok",
    degraded_reason: writeFailures > 0 ? "deterministic_write_failure" : null,
    degraded_since: writeFailures > 0 ? nowIso : null,
    last_scan_at: nowIso,
    ...(writeFailures === 0 ? { last_successful_extraction_at: nowIso } : {}),
    last_scan_drafts_created: draftsCreated,
    last_scan_auto_filed: jobsCreated,
    intake_mode: "deterministic",
    last_scan_model_calls: 0,
    updated_at: nowIso,
  }, { onConflict: "id" });
  if (error) {
    throw new Error(
      `deterministic health write failed: ${error.message || error}`,
    );
  }
}

export async function runDeterministicIntake(
  client: any,
  options: DeterministicRuntimeOptions = {},
): Promise<DeterministicRuntimeReport> {
  const dryRun = options.dryRun !== false;
  const days = Math.max(1, Math.min(options.days ?? 60, 180));
  const nowIso = options.nowIso || new Date().toISOString();
  const onlyUnscanned = options.onlyUnscanned === true;
  const input = await readInputs(client, { days, onlyUnscanned, nowIso });
  const plan = buildDeterministicIntakePlan(input.sources, input.profiles);
  const report: DeterministicRuntimeReport = {
    ok: true,
    mode: "deterministic",
    dry_run: dryRun,
    ai_enabled: false,
    ai_calls: 0,
    generated_at: nowIso,
    days,
    totals: {
      ...plan.totals,
      case_rows_created: 0,
      source_rows_created: 0,
      drafts_created: 0,
      jobs_created: 0,
      resumed: 0,
      write_failures: 0,
      cases_attempted: 0,
      cases_deferred: 0,
      cases_failed: 0,
      job_creation_deferred: 0,
    },
    attempt_cap_reached_without_commit: false,
    by_builder_and_outcome: byBuilderOutcome(plan),
    by_builder_and_reason: byBuilderReason(plan),
    write_failure_reasons: {},
    storage_blockers: [],
  };
  if (dryRun) return report;
  if (!options.approveDraft) {
    throw new Error(
      "deterministic live mode requires the guarded approval callback",
    );
  }
  const sourceMap = new Map(
    input.sources.map((source) => [source.postId, source]),
  );
  const onStorageBlocker = (blocker: string) => {
    if (!report.storage_blockers.includes(blocker)) {
      report.storage_blockers.push(blocker);
    }
  };
  const maxCases = Math.max(1, options.maxCases ?? DEFAULT_MAX_CASES_PER_RUN);
  // A case can only advance if it is new, if it carries evidence the case row has
  // not accounted yet, or if its persisted state no longer matches what this plan
  // would write for the job it already has. Everything else is stuck until more
  // evidence arrives, including a case whose job creation failed on an earlier run:
  // its sources were accounted before that attempt, so it is not mistaken for
  // fresh work and cannot re-occupy the priority head of every subsequent run.
  const persisted = await readPersistedCases(client, plan.cases);
  const persistedSources = await readPersistedSourcePostIds(
    client,
    [...persisted.values()].map((row) => row.id),
  );
  const canAdvance = (casePlan: DeterministicCasePlan) => {
    const row = persisted.get(casePlan.instructionKey);
    if (!row) return true;
    if (
      !row.job_id &&
      (casePlan.state === "confirmed_live_job" ||
        casePlan.state === "blocked_live_job")
    ) {
      return true;
    }
    const known = persistedSources.get(row.id) || new Set<string>();
    if (casePlan.sourcePostIds.some((postId) => !known.has(postId))) return true;
    return row.state !== resolvedState(casePlan, row.job_id || null);
  };
  const advanceable = new Map<DeterministicCasePlan, boolean>();
  for (const c of plan.cases) advanceable.set(c, canAdvance(c));
  const ordered = [
    ...plan.cases.filter((c) => advanceable.get(c)),
    ...plan.cases.filter((c) => !advanceable.get(c)),
  ];
  // The budget counts cases that actually committed, so a failure never spends a
  // commit slot. Attempts still carry their own ceiling so one run stays bounded.
  const maxAttempts = maxCases * MAX_ATTEMPT_MULTIPLIER;
  let attempted = 0;
  let committed = 0;
  for (const casePlan of ordered) {
    if (committed >= maxCases || attempted >= maxAttempts) break;
    attempted++;
    try {
      const existing = persisted.get(casePlan.instructionKey) || null;
      const stateBeforeRun: string | null = existing?.state ?? null;
      let jobId: string | null = existing?.job_id || null;
      // Account the case and its sources before any job-creating work. Nothing is
      // left outside the accounting invariant when the job attempt fails, and the
      // failed attempt becomes visible to the next run's ordering.
      let saved = await insertCaseAndSources(
        client,
        casePlan,
        jobId,
        sourceMap,
        existing,
      );
      let resumedCase = saved.resumed;
      if (saved.caseCreated) report.totals.case_rows_created++;
      report.totals.source_rows_created += saved.sourceCreated;
      const wantsJob = !jobId &&
        (casePlan.state === "confirmed_live_job" ||
          casePlan.state === "blocked_live_job");
      // Never create a guarded job the case row cannot then be moved to: the
      // update would be skipped and the job left with no case linkage. This is a
      // deferral, not a write failure - the case itself committed. The edge is
      // judged against the state the case held before this run, so accounting it
      // through the permitted exception hop cannot launder a forbidden edge into
      // an allowed one.
      const transitionAllowed = !stateBeforeRun ||
        stateBeforeRun === casePlan.state ||
        (ALLOWED_TRANSITIONS[stateBeforeRun] || []).includes(casePlan.state);
      if (wantsJob && !transitionAllowed) {
        report.totals.job_creation_deferred++;
      }
      if (wantsJob && transitionAllowed) {
        const live = await ensureDraftAndJob(
          client,
          casePlan,
          sourceMap,
          options.approveDraft,
          onStorageBlocker,
        );
        jobId = live.jobId;
        if (live.draftCreated) report.totals.drafts_created++;
        if (live.jobCreated) report.totals.jobs_created++;
        resumedCase = resumedCase || live.resumed;
        // Sources were already accounted by the pre-job hop above, so this call
        // only moves the case onto its job.
        saved = await insertCaseAndSources(
          client,
          casePlan,
          jobId,
          sourceMap,
          saved.caseRow,
          true,
        );
      }
      committed++;
      // One case counts once, however many of its artefacts already existed.
      if (resumedCase) report.totals.resumed++;
      // Stamp per case, not once at the end, so a wall-clock timeout keeps the
      // accounting for every case this run already committed.
      //
      // Sources of a case still awaiting evidence stay unstamped: the next run must
      // be able to re-read the original instruction alongside the late work order in
      // order to promote the case. A case that already produced a live job is not
      // awaiting anything, so it settles even when downgraded to an exception.
      const settled = saved.caseRow.state !== "exception" || Boolean(jobId);
      if (!settled) continue;
      for (const ids of chunk(casePlan.sourcePostIds)) {
        const { error } = await client.from("emails")
          .update({ makesafe_scanned_at: nowIso })
          .in("post_id", ids);
        if (error) report.totals.write_failures++;
      }
    } catch (error) {
      // No source contents or PII are logged; only a fixed failure class. The
      // exception/case remains visible on replay and the deterministic natural keys
      // make the next run resumable.
      const reason = classifyWriteFailure(error);
      report.write_failure_reasons[reason] =
        (report.write_failure_reasons[reason] || 0) + 1;
      report.totals.write_failures++;
      report.totals.cases_failed++;
    }
  }
  report.totals.cases_attempted = attempted;
  report.totals.cases_deferred = plan.cases.length - attempted;
  report.attempt_cap_reached_without_commit = attempted >= maxAttempts &&
    committed === 0;
  await writeHealth(
    client,
    nowIso,
    report.totals.write_failures,
    report.totals.drafts_created,
    report.totals.jobs_created,
  );
  return report;
}
