// deno-lint-ignore-file no-explicit-any

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const CANONICAL_BOARD_STAGES = new Set([
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  "completed",
  "archive",
  "cancelled",
]);

export interface HugoNotificationRecipient {
  userId: string;
  name: string | null;
  phone: string;
}

export interface HugoNotificationConfig {
  enabled: boolean;
  fromNumber: string | null;
  recipient: HugoNotificationRecipient | null;
  failureReason: string | null;
}

export interface HugoNotificationBoardJob {
  jobId: string;
  jobNumber: string | null;
  canonicalStage: string;
  sesFamily: string;
}

export interface HugoProviderResult {
  accepted: boolean;
  messageId: string | null;
  failureReason: string | null;
}

export interface HugoNotificationInput {
  orgId?: string;
  caseId: string;
  sourcePostIds: readonly string[];
  jobId: string;
  syntheticLivefireMarker?: string | null;
}

export interface HugoNotificationDeps {
  loadBoardJob: (
    client: any,
    jobId: string,
  ) => Promise<HugoNotificationBoardJob | null>;
  loadConfig: (client: any) => Promise<HugoNotificationConfig>;
  sendSms: (
    phone: string,
    message: string,
    fromNumber: string | null,
  ) => Promise<HugoProviderResult>;
  now?: () => string;
}

export interface HugoNotificationResult {
  attempted: boolean;
  accepted: boolean;
  reason: string;
  auditId: string | null;
  providerMessageId: string | null;
}

export function buildHugoTradeDeepLink(jobId: string): string {
  return `https://secureworks-group.github.io/secureworks-ux/trade.html#job/${jobId}`;
}

export function buildHugoNotificationMessage(
  jobId: string,
  jobNumber: string | null,
  deepLink = buildHugoTradeDeepLink(jobId),
): string {
  const label = jobNumber ? `${jobNumber} (${jobId})` : jobId;
  return `SecureWorks: New make-safe ${label}\nAssign in Trade: ${deepLink}`;
}

function isDuplicateError(error: any): boolean {
  return String(error?.code || "") === "23505" ||
    /duplicate|unique/i.test(String(error?.message || ""));
}

async function insertAudit(
  client: any,
  row: Record<string, unknown>,
): Promise<{ id: string | null; duplicate: boolean; error: any | null }> {
  const { data, error } = await client
    .from("makesafe_intake_hugo_notifications")
    .insert(row)
    .select("id")
    .single();
  if (!error) return { id: data?.id || null, duplicate: false, error: null };
  return {
    id: null,
    duplicate: isDuplicateError(error),
    error,
  };
}

async function updateAudit(
  client: any,
  auditId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await client
    .from("makesafe_intake_hugo_notifications")
    .update(patch)
    .eq("id", auditId)
    .select("id")
    .maybeSingle();
  if (!error && data?.id) return true;
  console.error(
    "[ops-api] Hugo notification audit update failed:",
    error?.message || "row not updated",
  );
  return false;
}

async function loadExistingAudit(
  client: any,
  orgId: string,
  jobId: string,
): Promise<any | null> {
  const { data, error } = await client
    .from("makesafe_intake_hugo_notifications")
    .select("id,state,provider_message_id,failure_reason")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error(
      "[ops-api] Hugo notification audit read failed:",
      error.message || error,
    );
    return null;
  }
  return data || null;
}

async function reclaimFailedAudit(
  client: any,
  auditId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await client
    .from("makesafe_intake_hugo_notifications")
    .update(patch)
    .eq("id", auditId)
    .eq("state", "failed")
    .select("id")
    .maybeSingle();
  if (!error && data?.id) return true;
  if (error) {
    console.error(
      "[ops-api] Hugo notification audit reclaim failed:",
      error.message || error,
    );
  }
  return false;
}

export async function notifyDeterministicPhysicalJob(
  client: any,
  input: HugoNotificationInput,
  deps: HugoNotificationDeps,
): Promise<HugoNotificationResult> {
  // Synthetic traffic is intentionally absent from the notification ledger. The
  // live-fire job can be present on the board until cleanup, so suppress before
  // board/config reads as well as before transport.
  if (input.syntheticLivefireMarker) {
    return {
      attempted: false,
      accepted: false,
      reason: "synthetic_livefire_suppressed",
      auditId: null,
      providerMessageId: null,
    };
  }

  const orgId = input.orgId || DEFAULT_ORG_ID;
  const now = deps.now || (() => new Date().toISOString());
  const sourcePostIds = Array.from(
    new Set(input.sourcePostIds.map((value) => String(value || "").trim())),
  ).filter(Boolean);
  const deepLink = buildHugoTradeDeepLink(input.jobId);

  const [boardResult, configResult] = await Promise.allSettled([
    deps.loadBoardJob(client, input.jobId),
    deps.loadConfig(client),
  ]);
  const board = boardResult.status === "fulfilled" ? boardResult.value : null;
  const config = configResult.status === "fulfilled" ? configResult.value : {
    enabled: false,
    fromNumber: null,
    recipient: null,
    failureReason: "recipient_config_read_failed",
  };
  const boardStage = String(board?.canonicalStage || "").trim();
  const boardObservedAt = board ? now() : null;
  const attemptedAt = now();

  let failureReason: string | null = null;
  if (!sourcePostIds.length) failureReason = "source_ids_missing";
  else if (boardResult.status === "rejected") {
    failureReason = "canonical_board_read_failed";
  } else if (!board) failureReason = "job_not_on_canonical_board";
  else if (!boardStage) {
    failureReason = "canonical_board_stage_missing";
  } else if (!CANONICAL_BOARD_STAGES.has(boardStage)) {
    failureReason = "canonical_board_stage_unsupported";
  } else if (!String(board.sesFamily || "").trim()) {
    failureReason = "canonical_board_family_missing";
  } else if (configResult.status === "rejected") {
    failureReason = "recipient_config_read_failed";
  } else if (!config.enabled) failureReason = "notification_disabled";
  else if (config.failureReason) failureReason = config.failureReason;
  else if (!config.recipient) failureReason = "hugo_recipient_not_configured";
  else if (!config.recipient.phone) {
    failureReason = "hugo_recipient_phone_missing";
  } else if (!config.fromNumber) failureReason = "sms_from_number_missing";

  const message = board
    ? buildHugoNotificationMessage(input.jobId, board.jobNumber, deepLink)
    : null;
  const recipientSet = config.recipient
    ? [{
      user_id: config.recipient.userId,
      name: config.recipient.name,
      phone: config.recipient.phone,
    }]
    : [];
  const auditRow = {
    org_id: orgId,
    case_id: input.caseId,
    source_post_ids: sourcePostIds,
    job_id: input.jobId,
    job_number: board?.jobNumber || null,
    // Preserve an unexpected stage in the audit even though it fails closed
    // above. Stage drift is evidence; replacing it with null would hide the
    // reason this notification did not send.
    board_stage: boardStage || null,
    board_observed_at: boardObservedAt,
    attempted_at: attemptedAt,
    recipient_set: recipientSet,
    deep_link: deepLink,
    message,
    state: failureReason ? "failed" : "attempting",
    failure_reason: failureReason || "provider_result_not_recorded",
  };
  const audit = await insertAudit(client, auditRow);
  let auditId = audit.id;

  if (audit.duplicate) {
    const existing = await loadExistingAudit(client, orgId, input.jobId);
    if (existing?.state === "accepted") {
      return {
        attempted: false,
        accepted: true,
        reason: "already_recorded",
        auditId: existing.id,
        providerMessageId: existing.provider_message_id || null,
      };
    }
    if (
      !failureReason && existing?.id && existing.state === "failed" &&
      await reclaimFailedAudit(client, existing.id, {
        ...auditRow,
        updated_at: attemptedAt,
      })
    ) {
      auditId = existing.id;
    } else {
      return {
        attempted: false,
        accepted: false,
        reason: existing ? "already_recorded_pending" : "audit_read_failed",
        auditId: existing?.id || null,
        providerMessageId: existing?.provider_message_id || null,
      };
    }
  } else if (audit.error || !auditId) {
    console.error(
      "[ops-api] Hugo notification audit insert failed; SMS suppressed:",
      audit.error?.message || "missing audit id",
    );
    return {
      attempted: false,
      accepted: false,
      reason: "audit_insert_failed",
      auditId: null,
      providerMessageId: null,
    };
  }
  if (failureReason || !config.recipient || !message) {
    return {
      attempted: false,
      accepted: false,
      reason: failureReason || "notification_precondition_failed",
      auditId,
      providerMessageId: null,
    };
  }

  let provider: HugoProviderResult;
  try {
    provider = await deps.sendSms(
      config.recipient.phone,
      message,
      config.fromNumber,
    );
  } catch (error) {
    provider = {
      accepted: false,
      messageId: null,
      failureReason: `ghl_fetch_failed:${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 500),
    };
  }
  const accepted = provider.accepted && Boolean(provider.messageId);
  const resultReason = accepted ? "accepted" : provider.failureReason ||
    (provider.accepted ? "provider_message_id_missing" : "provider_rejected");
  const providerAcceptedAt = accepted ? now() : null;
  const auditUpdated = await updateAudit(client, auditId!, {
    state: accepted ? "accepted" : "failed",
    provider_message_id: accepted ? provider.messageId : null,
    provider_accepted_at: providerAcceptedAt,
    failure_reason: accepted ? null : resultReason,
    updated_at: providerAcceptedAt || now(),
  });
  if (!auditUpdated) {
    return {
      attempted: true,
      accepted: false,
      reason: "audit_update_failed_after_provider_result",
      auditId,
      providerMessageId: provider.messageId,
    };
  }
  return {
    attempted: true,
    accepted,
    reason: resultReason,
    auditId,
    providerMessageId: provider.messageId,
  };
}
