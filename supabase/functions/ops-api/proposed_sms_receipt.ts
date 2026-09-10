// deno-lint-ignore-file no-explicit-any
// One proposal attempt owns its claim and receipt. A request can be accepted
// even when its response is lost, so no post-request path restores pending.
export interface ProposedSmsAction {
  proposal_id: string;
  job_id: string;
  contact_id: string;
  contact_phone: string | null;
  drafted_message: string;
  action_payload: Record<string, unknown>;
}

type Outcome = "provider_accepted" | "rejected" | "unknown";
type ProviderReceipt = {
  outcome: Outcome;
  ghl_message_id: string | null;
  ghl_status: number | null;
  error: string | null;
};

async function providerReceipt(
  send: () => Promise<Response>,
): Promise<ProviderReceipt> {
  let response: Response;
  try {
    response = await send();
  } catch {
    return {
      outcome: "unknown",
      ghl_message_id: null,
      ghl_status: null,
      error: "transport_outcome_unknown",
    };
  }
  const status = response.status;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      outcome: "unknown",
      ghl_message_id: null,
      ghl_status: status,
      error: "invalid_provider_response",
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      outcome: "unknown",
      ghl_message_id: null,
      ghl_status: status,
      error: "invalid_provider_response",
    };
  }
  const row = body as Record<string, unknown>;
  const ids = [row.messageId, row.message_id, row.id].filter((value) =>
    value !== undefined && value !== null
  );
  const validIds = ids.every((value) =>
    typeof value === "string" && value.trim().length > 0 &&
    value === value.trim()
  );
  const messageId = validIds && ids.length > 0 && new Set(ids).size === 1
    ? ids[0] as string
    : null;
  const refused = row.success === false || row.dedup_blocked === true;
  if (refused && ids.length === 0) {
    return {
      outcome: "rejected",
      ghl_message_id: null,
      ghl_status: status,
      error: row.dedup_blocked === true
        ? "provider_dedup_blocked"
        : "provider_rejected",
    };
  }
  // A positive receipt proves acceptance, not delivery. Never accept arbitrary
  // truthy IDs, contradictory error bodies, or HTTP success alone.
  if (
    response.ok && row.success === true && !refused && !row.error && messageId
  ) {
    return {
      outcome: "provider_accepted",
      ghl_message_id: messageId,
      ghl_status: status,
      error: null,
    };
  }
  return {
    outcome: "unknown",
    ghl_message_id: null,
    ghl_status: status,
    error: !response.ok
      ? "http_outcome_unknown"
      : "unconfirmed_provider_receipt",
  };
}

export async function dispatchProposedSmsWithReceipt(
  client: any,
  action: ProposedSmsAction,
  send: () => Promise<Response>,
) {
  const actionId = action.proposal_id;
  if (action.action_payload?.sms_dispatch !== undefined) {
    return {
      success: false,
      action_id: actionId,
      error: "existing_dispatch_requires_reconciliation",
      auto_retry: false,
      requires_reconciliation: true,
    };
  }
  const attemptId = crypto.randomUUID();
  const bodyHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(action.drafted_message),
      ),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const attempt = {
    version: 1,
    action_id: actionId,
    attempt_id: attemptId,
    job_id: action.job_id,
    contact_id: action.contact_id,
    body_sha256: bodyHash,
    started_at: new Date().toISOString(),
    outcome: "in_flight",
    auto_retry: false,
  };
  const payload = { ...action.action_payload, sms_dispatch: attempt };
  let claim;
  try {
    let query = client.from("ai_proposed_actions").update({
      status: "approved",
      action_payload: payload,
    })
      .eq("proposal_id", actionId).eq("status", "pending").is("sent_at", null)
      .is("action_payload->sms_dispatch", null)
      .eq("job_id", action.job_id).eq("contact_id", action.contact_id).eq(
        "drafted_message",
        action.drafted_message,
      );
    // Keep the canary recipient checked by the caller bound to the claim.
    query = action.contact_phone == null
      ? query.is("contact_phone", null)
      : query.eq("contact_phone", action.contact_phone);
    claim = await query.select("proposal_id");
  } catch {
    return {
      success: false,
      action_id: actionId,
      attempt_id: attemptId,
      error: "claim_unconfirmed",
      auto_retry: false,
      requires_reconciliation: true,
    };
  }
  if (
    claim.error || !Array.isArray(claim.data) || claim.data.length !== 1 ||
    claim.data[0].proposal_id !== actionId
  ) {
    return {
      success: false,
      action_id: actionId,
      attempt_id: attemptId,
      error: "claim_unconfirmed",
      auto_retry: false,
      requires_reconciliation: true,
    };
  }

  const provider = await providerReceipt(send);
  // This is our observation time, not a provider send/delivery timestamp.
  const observedAt = new Date().toISOString();
  const receipt = { ...attempt, ...provider, observed_at: observedAt };
  const owned = (patch: Record<string, unknown>) =>
    client.from("ai_proposed_actions").update(patch)
      .eq("proposal_id", actionId).eq("status", "approved").eq(
        "job_id",
        action.job_id,
      )
      .eq("contact_id", action.contact_id)
      .eq("drafted_message", action.drafted_message)
      .eq("action_payload->sms_dispatch->>attempt_id", attemptId).select(
        "proposal_id",
      );
  const one = (result: any) =>
    !result?.error && Array.isArray(result?.data) && result.data.length === 1 &&
    result.data[0].proposal_id === actionId;
  let checkpointed = false;
  try {
    checkpointed = one(
      await owned({ action_payload: { ...payload, sms_dispatch: receipt } }),
    );
  } catch {
    /* Keep the held claim; still attempt to retain the independent receipt. */
  }
  let eventId: string | null = null;
  try {
    const event = await client.from("business_events").insert({
      event_type: provider.outcome === "provider_accepted"
        ? "proposed_action.dispatched"
        : provider.outcome === "rejected"
        ? "proposed_action.dispatch_failed"
        : "proposed_action.dispatch_unknown",
      source: "ops-api/send_proposed_sms",
      entity_type: "ai_proposed_action",
      entity_id: actionId,
      job_id: action.job_id,
      occurred_at: observedAt,
      payload: receipt,
    }).select("id");
    if (
      !event.error && Array.isArray(event.data) && event.data.length === 1 &&
      typeof event.data[0].id === "string" && event.data[0].id.trim()
    ) eventId = event.data[0].id;
  } catch {
    /* Accepted externally may still be unrecorded locally; never resend. */
  }
  const result = {
    success: false,
    action_id: actionId,
    attempt_id: attemptId,
    outcome: provider.outcome,
    ghl_message_id: provider.ghl_message_id,
    ghl_status: provider.ghl_status,
    receipt_event_id: eventId,
    auto_retry: false,
    requires_reconciliation: true,
  };
  if (!checkpointed || !eventId) {
    return { ...result, error: "dispatch_receipt_persistence_unconfirmed" };
  }
  if (provider.outcome !== "provider_accepted") {
    return { ...result, error: provider.error };
  }
  let finalized = false;
  try {
    finalized = one(await owned({ status: "sent", sent_at: observedAt }));
  } catch {
    /* Receipt remains authoritative even if proposal finalization failed. */
  }
  if (!finalized) return { ...result, error: "dispatch_finalize_unconfirmed" };
  return { ...result, success: true, requires_reconciliation: false };
}
