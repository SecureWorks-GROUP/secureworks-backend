// deno-lint-ignore-file no-explicit-any
import { isSelfGeneratedMakesafeWorkOrder } from "./makesafe_builder_work_order_identity.ts";
import { insertOrReadActiveMakesafeDocument } from "./makesafe_document_idempotency.ts";
import { refreshMakesafeIdentityAfterWorkOrderAttach } from "./makesafe_work_order_identity_refresh.ts";

export const SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION =
  "captain_authorized_exact_source_persist_recovery";

export interface IntakeMint {
  id: string;
  draft_id: string;
  mint_role: string;
  case_id: string | null;
  source_post_ids: string[];
  job_id: string | null;
  state: string;
  evidence_attached_at: string | null;
  board_observed_at: string | null;
  notification_accepted_at: string | null;
}

export async function loadIntakeMints(
  client: any,
  draftId: string,
): Promise<IntakeMint[]> {
  const { data, error } = await client
    .from("makesafe_intake_job_mints")
    .select(
      "id,draft_id,mint_role,case_id,source_post_ids,job_id,state,evidence_attached_at,board_observed_at,notification_accepted_at",
    )
    .eq("draft_id", draftId)
    .order("mint_role", { ascending: true });
  if (error) {
    throw new Error(`intake mint read failed: ${error.message || error}`);
  }
  return (data || []) as IntakeMint[];
}

export async function reserveIntakeMint(
  client: any,
  input: {
    orgId: string;
    draftId: string;
    mintRole: string;
    caseId: string | null;
    sourcePostIds: readonly string[];
  },
): Promise<IntakeMint> {
  const { data, error } = await client.rpc("reserve_makesafe_intake_job_mint", {
    p_org_id: input.orgId,
    p_draft_id: input.draftId,
    p_mint_role: input.mintRole,
    p_case_id: input.caseId,
    p_source_post_ids: Array.from(new Set(input.sourcePostIds)).sort(),
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    throw new Error(
      `intake mint reservation failed: ${
        error?.message || error || "missing row"
      }`,
    );
  }
  return row as IntakeMint;
}

export async function completeIntakeMint(
  client: any,
  mintId: string,
  jobId: string,
): Promise<IntakeMint> {
  const { data, error } = await client.rpc(
    "complete_makesafe_intake_job_mint",
    {
      p_mint_id: mintId,
      p_job_id: jobId,
    },
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.id) {
    throw new Error(
      `intake mint completion failed: ${
        error?.message || error || "missing row"
      }`,
    );
  }
  return row as IntakeMint;
}

/**
 * `enforce_makesafe_intake_case_write` refuses `makesafe_intake_cases.job_id`
 * unless the job is one of these types (widened from make-safe alone by
 * `20260826000001_repair_job_type.sql`). A restoration card is `insurance` and
 * would RAISE, so the type is checked here rather than left to the trigger:
 * settlement must never fail for a family this binding does not cover.
 */
const INTAKE_CASE_LINKABLE_JOB_TYPES = new Set(["makesafe", "repair"]);

/**
 * Only these states may be promoted onto a job. `accounted_non_wo` is excluded
 * because `makesafe_intake_case_transition_allowed` permits it to reach
 * `exception` only — it is not work awaiting a card.
 */
const INTAKE_CASE_BINDABLE_STATES = new Set([
  "exception",
  "blocked_live_job",
  "confirmed_live_job",
]);

/**
 * The ONE exception reason this binding was written for: `casePayload` stamps it
 * on a case accounted ahead of its guarded job creation, and the shape checks
 * mean an unbound case can only ever be an `exception`.
 *
 * A repair draft can now wait days in the review queue for its human tick, and
 * the case can move to a different reason-coded exception in that window.
 * `cancellation` is the sharp one: `makesafe_intake_cases_cancellation_no_job_check`
 * RAISES on a cancellation case that gains a `job_id`, and the throw would land
 * AFTER `createMakesafeJob` had already run — a live job whose every re-approval
 * reproduces the failure. Any other reason would likewise be silently cleared and
 * the case promoted to live on a decision nobody made. Skip instead.
 */
const INTAKE_CASE_BINDABLE_REASON = "awaiting_job_creation";

export type IntakeCaseDecisionProvenance = "deterministic" | "human";

/**
 * `makesafe_intake_field_names_valid`, which every `blocked_reasons` write must
 * satisfy. Filtering here rather than trusting the stored array keeps a legacy
 * draft's free-text `missing_fields` from failing the whole settlement.
 */
const INTAKE_FIELD_NAME_RE = /^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/;

/**
 * Recover the plan's blocked reasons for a case that was PARKED before its job
 * existed.
 *
 * They cannot be read back off the case row: `makesafe_intake_cases_exception_
 * shape_check` forces `cardinality(blocked_reasons) = 0` on an unbound case, so
 * `casePayload` stores `[]` on every parked row whatever the plan said. The
 * coordinate that survives the park is the DRAFT — the deterministic runtime
 * writes `missing_fields: plan.blockedReasons` when it creates it — and only a
 * deterministic draft ever reaches this binding, because `intakeMintAuthority`
 * yields no `case_id` without `extraction.deterministic_intake === true`.
 *
 * Losing this would silently promote a `blocked_live_job` plan (missing portal
 * or secondary evidence — the common repair shape) to `confirmed_live_job`, and
 * the gap-fill queue and the intake exception desk both read that signal.
 */
async function readParkedPlanBlockedReasons(
  client: any,
  draftId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("makesafe_intake_drafts")
    .select("missing_fields")
    .eq("id", draftId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `intake case binding draft read failed: ${error.message || error}`,
    );
  }
  const stored = Array.isArray(data?.missing_fields) ? data.missing_fields : [];
  return [
    ...new Set(
      stored
        .map((value: unknown) => String(value ?? "").trim())
        .filter((value: string) => INTAKE_FIELD_NAME_RE.test(value)),
    ),
  ].sort() as string[];
}

/**
 * Bind each settled mint's intake case to the job that mint created.
 *
 * This is the ONE place the binding happens for every lane, because it is the
 * only shared seam that already holds both coordinates: `reserveIntakeMint`
 * persists `makesafe_intake_job_mints.case_id` from the draft's canonical
 * source authority, and `completeIntakeMint` stamps `job_id` on the same row.
 *
 * It exists because the deterministic runtime's own
 * `insertCaseAndSources(..., jobId)` runs only when the runtime itself
 * advanced the draft. Any draft a HUMAN approves from the review queue — which
 * is now every repair-family draft, under the 2026-08-28 supervised-repair
 * ruling — would otherwise keep `job_id` NULL forever: the case cannot
 * self-heal on a later sweep (its `makesafe_intake_case_sources` row already
 * makes the source a FINAL fate, so the recent lane skips it), and a caseless
 * card is refused at `prepare_ses_docket_revision` with `spine_missing_source`
 * / `spine_missing_lineage`, blocking the whole pack path.
 *
 * The write is a compare-and-set on `job_id IS NULL`, so it never re-points a
 * case that is already bound and a concurrent binder simply wins.
 */
export async function bindIntakeCasesToMintedJobs(
  client: any,
  mints: readonly IntakeMint[],
  decision: {
    draftId: string;
    actor: string;
    provenance: IntakeCaseDecisionProvenance;
  },
): Promise<string[]> {
  const jobByCaseId = new Map<string, string>();
  for (const mint of mints) {
    const caseId = String(mint.case_id || "").trim();
    const jobId = String(mint.job_id || "").trim();
    if (caseId && jobId && !jobByCaseId.has(caseId)) {
      jobByCaseId.set(caseId, jobId);
    }
  }
  if (!jobByCaseId.size) return [];

  const { data: caseRows, error: caseError } = await client
    .from("makesafe_intake_cases")
    .select("id,state,job_id,reason_code,blocked_reasons")
    .in("id", [...jobByCaseId.keys()]);
  if (caseError) {
    throw new Error(
      `intake case binding read failed: ${caseError.message || caseError}`,
    );
  }
  const unbound = (caseRows || []).filter((row: any) =>
    jobByCaseId.has(String(row?.id)) && !row?.job_id &&
    INTAKE_CASE_BINDABLE_STATES.has(String(row?.state || "")) &&
    String(row?.reason_code || "") === INTAKE_CASE_BINDABLE_REASON
  );
  if (!unbound.length) return [];

  const { data: jobRows, error: jobError } = await client
    .from("jobs")
    .select("id,type")
    .in(
      "id",
      [...new Set(unbound.map((row: any) => jobByCaseId.get(String(row.id))))],
    );
  if (jobError) {
    throw new Error(
      `intake case binding job read failed: ${jobError.message || jobError}`,
    );
  }
  const linkableJobIds = new Set(
    (jobRows || [])
      .filter((row: any) =>
        INTAKE_CASE_LINKABLE_JOB_TYPES.has(
          String(row?.type || "").trim().toLowerCase(),
        )
      )
      .map((row: any) => String(row.id)),
  );

  const blockedReasons = await readParkedPlanBlockedReasons(
    client,
    decision.draftId,
  );

  const bound: string[] = [];
  for (const row of unbound) {
    const caseId = String(row.id);
    const jobId = String(jobByCaseId.get(caseId));
    if (!linkableJobIds.has(jobId)) continue;
    const nextState = blockedReasons.length
      ? "blocked_live_job"
      : "confirmed_live_job";
    const { data, error } = await client
      .from("makesafe_intake_cases")
      .update({
        job_id: jobId,
        state: nextState,
        reason_code: null,
        blocked_reasons: blockedReasons,
        last_decision_provenance: decision.provenance,
        last_decision_actor: decision.actor,
        last_decision_reason:
          `intake approval settlement bound ${nextState} job ${jobId}`,
      })
      .eq("id", caseId)
      .is("job_id", null)
      .select("id")
      .maybeSingle();
    if (error) {
      throw new Error(
        `intake case job binding failed for case ${caseId}: ${
          error.message || error
        }`,
      );
    }
    if (data?.id) bound.push(String(data.id));
  }
  return bound;
}

export async function ensureIntakeWorkOrderEvidence(
  client: any,
  jobIds: readonly string[],
  attachments: readonly any[],
  extraction: Record<string, any>,
  deps: {
    refreshIdentity?: typeof refreshMakesafeIdentityAfterWorkOrderAttach;
  } = {},
): Promise<void> {
  const uniqueJobIds = Array.from(
    new Set(
      jobIds.map((value) => String(value || "").trim()).filter(Boolean),
    ),
  );
  const builderAttachments = attachments.filter((attachment) =>
    !isSelfGeneratedMakesafeWorkOrder(
      attachment.file_name || attachment.name || attachment.storage_url ||
        attachment.pdf_url,
    )
  );
  if (!uniqueJobIds.length || !builderAttachments.length) {
    throw new Error(
      "work-order evidence settlement requires jobs and attachments",
    );
  }
  const { data: existing, error: existingError } = await client
    .from("job_documents")
    .select("job_id,storage_url,pdf_url")
    .in("job_id", uniqueJobIds)
    .eq("type", "work_order")
    .is("superseded_at", null);
  if (existingError) {
    throw new Error(
      `work-order evidence read failed: ${
        existingError.message || existingError
      }`,
    );
  }
  const existingKeys = new Set(
    (existing || []).flatMap((row: any) => {
      const urls = [row.storage_url, row.pdf_url].filter(Boolean);
      return urls.map((url: string) => `${row.job_id}:${url}`);
    }),
  );
  for (const jobId of uniqueJobIds) {
    for (const attachment of builderAttachments) {
      const storageUrl = attachment.storage_url || attachment.pdf_url;
      const pdfUrl = attachment.pdf_url || attachment.storage_url;
      if (
        existingKeys.has(`${jobId}:${storageUrl}`) ||
        existingKeys.has(`${jobId}:${pdfUrl}`)
      ) continue;
      const fileName = attachment.file_name || attachment.name ||
        "work-order.pdf";
      try {
        await insertOrReadActiveMakesafeDocument(client, {
          key: { jobId, type: "work_order", fileName },
          row: {
            job_id: jobId,
            type: "work_order",
            file_name: fileName,
            storage_url: storageUrl,
            pdf_url: pdfUrl,
            ...(extraction?.synthetic_livefire_marker
              ? {
                data_snapshot_json: {
                  synthetic_livefire_marker:
                    extraction.synthetic_livefire_marker,
                },
              }
              : {}),
            visible_to_trades: true,
          },
          select: "id",
        });
      } catch (error) {
        throw new Error(
          `work-order evidence attach failed: ${
            (error as any)?.message || error
          }`,
        );
      }
      existingKeys.add(`${jobId}:${storageUrl}`);
      existingKeys.add(`${jobId}:${pdfUrl}`);
      await (deps.refreshIdentity ||
        refreshMakesafeIdentityAfterWorkOrderAttach)(
          client,
          { jobId, documentId: null, fileName },
        );
    }
  }
}

export async function settleApprovedIntakeDraft(
  client: any,
  input: {
    draftId: string;
    approvedJobId: string | null;
    attachments: readonly any[];
    extraction: Record<string, any>;
    requiredMintRoles?: readonly string[];
    notify: (input: {
      caseId: string;
      sourcePostIds: readonly string[];
      jobId: string;
      syntheticLivefireMarker?: string | null;
    }) => Promise<{
      accepted: boolean;
      reason: string;
      auditId: string | null;
    }>;
    notificationSuppressionReason?:
      | typeof SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION
      | null;
    verifyNotificationSuppression?: (input: {
      caseId: string;
      sourcePostIds: readonly string[];
      jobId: string;
    }) => Promise<boolean>;
    refreshIdentity?: typeof refreshMakesafeIdentityAfterWorkOrderAttach;
    /**
     * Recorded as the intake case's `last_decision_actor` /
     * `last_decision_provenance` when it binds, and copied by
     * `record_makesafe_intake_case_event` into the append-only case-event
     * ledger — so a Captain approving a parked repair draft is attributed to
     * the human, not to the deterministic runtime.
     */
    caseBindingActor?: string;
    caseBindingProvenance?: IntakeCaseDecisionProvenance;
  },
): Promise<{
  jobIds: string[];
  notificationJobIds: string[];
  notificationsAccepted: number;
}> {
  const mints = await loadIntakeMints(client, input.draftId);
  const mintRoles = new Set(mints.map((mint) => mint.mint_role));
  const missingMintRoles = (input.requiredMintRoles || []).filter(
    (role) => !mintRoles.has(role),
  );
  if (missingMintRoles.length) {
    throw new Error(
      `intake settlement lacks required mint authority: ${
        missingMintRoles.join(",")
      }`,
    );
  }
  const unboundMints = mints.filter((mint) => !mint.job_id);
  if (unboundMints.length) {
    throw new Error(
      `intake settlement has unbound mint authority: ${
        unboundMints.map((mint) => mint.mint_role).join(",")
      }`,
    );
  }
  const minted = mints.filter((mint) => mint.job_id);
  const evidenceJobIds = Array.from(
    new Set([
      ...minted.map((mint) => String(mint.job_id)),
      ...(input.approvedJobId ? [input.approvedJobId] : []),
    ]),
  );
  await ensureIntakeWorkOrderEvidence(
    client,
    evidenceJobIds,
    input.attachments,
    input.extraction,
    { refreshIdentity: input.refreshIdentity },
  );
  let notificationsAccepted = 0;
  const notificationJobIds: string[] = [];
  for (const mint of minted) {
    if (mint.state === "settled") continue;
    if (mint.notification_accepted_at) {
      const { error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settled",
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mint.id)
        .neq("state", "settled");
      if (error) {
        throw new Error(
          `accepted intake settlement repair failed: ${error.message || error}`,
        );
      }
      notificationsAccepted++;
      continue;
    }
    if (!mint.case_id || !mint.source_post_ids.length) {
      throw new Error(
        `intake mint ${mint.id} lacks canonical source authority`,
      );
    }
    if (input.notificationSuppressionReason) {
      if (
        !input.verifyNotificationSuppression ||
        !await input.verifyNotificationSuppression({
          caseId: mint.case_id,
          sourcePostIds: mint.source_post_ids,
          jobId: String(mint.job_id),
        })
      ) {
        throw new Error(
          "intake no-send settlement requires canonical board proof",
        );
      }
      const settledAt = new Date().toISOString();
      const { data, error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settled",
          evidence_attached_at: mint.evidence_attached_at || settledAt,
          board_observed_at: mint.board_observed_at || settledAt,
          last_error:
            `notification_suppressed:${input.notificationSuppressionReason}`,
          updated_at: settledAt,
        })
        .eq("id", mint.id)
        .neq("state", "settled")
        .is("notification_accepted_at", null)
        .select("id")
        .maybeSingle();
      if (error || !data?.id) {
        throw new Error(
          `intake no-send settlement fence failed: ${
            error?.message || error || "mint no longer eligible"
          }`,
        );
      }
      notificationJobIds.push(String(mint.job_id));
      continue;
    }
    const notification = await input.notify({
      caseId: mint.case_id,
      sourcePostIds: mint.source_post_ids,
      jobId: String(mint.job_id),
      syntheticLivefireMarker: input.extraction?.synthetic_livefire_marker ||
        null,
    });
    if (notification.reason === "synthetic_livefire_suppressed") {
      const settledAt = new Date().toISOString();
      const { error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settled",
          evidence_attached_at: mint.evidence_attached_at || settledAt,
          board_observed_at: mint.board_observed_at || settledAt,
          last_error: null,
          updated_at: settledAt,
        })
        .eq("id", mint.id);
      if (error) {
        throw new Error(
          `synthetic intake settlement write failed: ${error.message || error}`,
        );
      }
      continue;
    }
    if (!notification.accepted) {
      const { data, error } = await client
        .from("makesafe_intake_job_mints")
        .update({
          state: "settlement_failed",
          last_error: notification.reason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mint.id)
        .neq("state", "settled")
        .is("notification_accepted_at", null)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(
          `intake settlement failure write failed: ${error.message || error}`,
        );
      }
      if (!data?.id) {
        const current = (await loadIntakeMints(client, input.draftId))
          .find((candidate) => candidate.id === mint.id);
        if (
          current?.state === "settled" ||
          current?.notification_accepted_at
        ) {
          notificationsAccepted++;
          continue;
        }
        throw new Error(`intake settlement failure fence lost for ${mint.id}`);
      }
      throw new Error(
        `post-board Hugo settlement failed for ${mint.job_id}: ${notification.reason}`,
      );
    }
    const settledAt = new Date().toISOString();
    const { data, error } = await client
      .from("makesafe_intake_job_mints")
      .update({
        state: "settled",
        evidence_attached_at: mint.evidence_attached_at || settledAt,
        board_observed_at: mint.board_observed_at || settledAt,
        notification_accepted_at: settledAt,
        last_error: null,
        updated_at: settledAt,
      })
      .eq("id", mint.id)
      .neq("state", "settled")
      .is("notification_accepted_at", null)
      .select("id")
      .maybeSingle();
    if (error) {
      throw new Error(
        `intake settlement completion write failed: ${error?.message || error}`,
      );
    }
    if (!data?.id) {
      const current = (await loadIntakeMints(client, input.draftId))
        .find((candidate) => candidate.id === mint.id);
      if (
        current?.state !== "settled" &&
        !current?.notification_accepted_at
      ) {
        throw new Error(
          `intake settlement completion fence lost for ${mint.id}`,
        );
      }
    }
    notificationsAccepted++;
    notificationJobIds.push(String(mint.job_id));
  }

  // LAST, deliberately. The bind is the least critical step here and is
  // idempotent on retry (compare-and-set on `job_id IS NULL`), while the
  // post-board notification is never retried once the case carries its job.
  // Running it earlier put a new throwing step in front of that notification for
  // EVERY intake family: a case that cannot legally go live — two clusters on one
  // `wo_po_identity_key` refused by `uq_makesafe_intake_cases_live_identity` — would
  // fail settlement for a card that minted correctly, and the fresh-source lane
  // would report `fresh source deterministic settlement incomplete`. Placed here,
  // that refusal costs only the binding, which the next approval re-attempts.
  await bindIntakeCasesToMintedJobs(client, minted, {
    draftId: input.draftId,
    actor: input.caseBindingActor || "intake_approval_settlement",
    provenance: input.caseBindingProvenance || "deterministic",
  });

  return {
    jobIds: evidenceJobIds,
    notificationJobIds,
    notificationsAccepted,
  };
}
