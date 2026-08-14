import {
  loadSesInvoiceApprovalCoordinates,
  type SesActionAuth,
  SesActionError,
  type SesInvoiceApprovalCoordinates,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import type {
  SesChannelApprovalDeps,
  SesChannelApprovalEnv,
  SesChannelApprovalRequest,
  SesChannelOperatorBinding,
} from "./ses_channel_approval.ts";
import {
  loadBoundOperatorUser,
  parseSesChannelApprovalMessage,
  parseSesChannelOperatorBindings,
  resolveSesChannelCard,
  resolveSesChannelOperatorBinding,
  SES_CHANNEL_APPROVAL_CHANNELS,
  sesChannelSenderFingerprint,
} from "./ses_channel_approval.ts";

export const SES_ECHO_CODE_CONTRACT_VERSION = "ses-echo-code/v2";
export const SES_ECHO_CODE_EXPIRY_MS = 10 * 60_000;
export const SES_ECHO_CODE_LOCKOUT_THRESHOLD = 3;
export const SES_ECHO_CODE_LOCKOUT_WINDOW_MS = 15 * 60_000;

type EchoRequest = { org_id: string; job_id: string; channel: unknown };

type EchoedApprovalCoordinates = {
  expected_docket_revision_id: string;
  expected_invoice_obligation_revision_id: string;
  expected_output_content_hash: string;
};

type SesEchoCodeApprovalDeps =
  & Omit<
    SesChannelApprovalDeps,
    "approveInvoice"
  >
  & {
    approveInvoice: (
      auth: SesActionAuth,
      args: {
        org_id: string;
        job_id: string;
        includes_authorise: boolean;
        evidence_refs: unknown[];
      } & EchoedApprovalCoordinates,
    ) => Promise<unknown>;
  };

function refuse(
  status: number,
  code: string,
  fact: string,
  recovery_action: string,
  evidence?: Record<string, unknown>,
): never {
  throw new SesActionError(status, {
    state: "refused",
    code,
    fact,
    recovery_action,
    ...(evidence ? { evidence } : {}),
  } as any);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function hmacCode(rootSecret: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(rootSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(signature)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function boundApprovalMessageHash(
  messageText: string,
  coordinates: EchoedApprovalCoordinates,
): Promise<string> {
  return `sha256:${await sha256(JSON.stringify([
    SES_ECHO_CODE_CONTRACT_VERSION,
    messageText,
    coordinates.expected_docket_revision_id,
    coordinates.expected_invoice_obligation_revision_id,
    coordinates.expected_output_content_hash,
  ]))}`;
}

function requireApprovalCoordinates(
  coordinates: Partial<EchoedApprovalCoordinates>,
): EchoedApprovalCoordinates {
  const exact = {
    expected_docket_revision_id: String(
      coordinates.expected_docket_revision_id || "",
    ).trim(),
    expected_invoice_obligation_revision_id: String(
      coordinates.expected_invoice_obligation_revision_id || "",
    ).trim(),
    expected_output_content_hash: String(
      coordinates.expected_output_content_hash || "",
    ).trim(),
  };
  if (
    !exact.expected_docket_revision_id ||
    !exact.expected_invoice_obligation_revision_id ||
    !exact.expected_output_content_hash
  ) {
    refuse(
      400,
      "exact_review_coordinates_required",
      "The channel approval transport is missing the exact inspected docket, obligation, or output-hash coordinate.",
      "Issue a fresh approval request from the current inspected pack and transport all three coordinates unchanged.",
    );
  }
  return exact;
}

function approvalCoordinatesFromRead(
  coordinates: SesInvoiceApprovalCoordinates,
): EchoedApprovalCoordinates {
  return requireApprovalCoordinates({
    expected_docket_revision_id: coordinates.docket_revision_id || "",
    expected_invoice_obligation_revision_id:
      coordinates.invoice_obligation_revision_id || "",
    expected_output_content_hash: coordinates.output_content_hash || "",
  });
}

function secureCode(): string {
  const max = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const bytes = new Uint32Array(1);
  do crypto.getRandomValues(bytes); while (bytes[0] >= max);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

function ownBinding(
  bindings: SesChannelOperatorBinding[],
  channel: string,
  userId: string,
): SesChannelOperatorBinding | null {
  const matches = bindings.filter((binding) =>
    binding.channel === channel && binding.operator_user_id === userId
  );
  return matches.length === 1 ? matches[0]! : null;
}

function requireCaptainSession(
  auth: SesActionAuth,
): asserts auth is SesActionAuth & { mode: "jwt"; user: { id: string } } {
  if (auth.mode !== "jwt" || !auth.user || auth.identity_provenance) {
    refuse(
      403,
      "echo_code_issue_requires_session",
      "Only the identified operator session may issue an approval request.",
      "Issue the request from the captain's authenticated board session.",
    );
  }
}

function requireRelay(auth: SesActionAuth): void {
  if (auth.mode !== "api_key") {
    refuse(
      403,
      "echo_code_transport_not_privileged",
      "Only the privileged relay may transport an approval message for verification.",
      "Route the message through the configured relay.",
    );
  }
}

export async function issueSesChannelApprovalAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  request: EchoRequest,
  env: SesChannelApprovalEnv,
  deps: {
    loadApprovalCoordinates?: (
      client: SesSupabaseClient,
      jobId: string,
    ) => Promise<SesInvoiceApprovalCoordinates>;
  } = {},
) {
  requireCaptainSession(auth);
  const channel = String(request.channel ?? "").toLowerCase();
  if (!SES_CHANNEL_APPROVAL_CHANNELS.includes(channel as any)) {
    refuse(
      400,
      "channel_unsupported",
      "The approval request names an unsupported channel.",
      `Use one of: ${SES_CHANNEL_APPROVAL_CHANNELS.join(", ")}.`,
    );
  }
  const bindings = parseSesChannelOperatorBindings(env.bindings_raw);
  const rootSecret = String(env.root_secret || "");
  const binding = ownBinding(bindings, channel, auth.user.id);
  if (!binding || !rootSecret) {
    refuse(
      503,
      "channel_binding_not_configured",
      "No enrolled sender binding is available for this operator and channel.",
      "Enrol the sender binding and root secret before issuing an approval request.",
    );
  }
  const job = await client.from("jobs").select("id,job_number").eq(
    "id",
    request.job_id,
  ).maybeSingle();
  if (job.error || !job.data) {
    refuse(
      409,
      "channel_card_not_found",
      "The approval request does not name one readable card.",
      "Issue the request for one existing card.",
    );
  }
  const code = secureCode();
  const messageText = `APPROVE ${String(job.data.job_number)} ${code}`;
  const loadCoordinates = deps.loadApprovalCoordinates ??
    loadSesInvoiceApprovalCoordinates;
  const approvalCoordinates = approvalCoordinatesFromRead(
    await loadCoordinates(client, request.job_id),
  );
  // Issue only a message the verifier can actually read back. A card number
  // outside the verifier's reference grammar would mint a request and transport
  // a code that could never verify.
  const issuedIntent = parseSesChannelApprovalMessage(messageText);
  if (
    issuedIntent.act !== "approve_invoice" || issuedIntent.act_ambiguous ||
    issuedIntent.card_references.length !== 1 || issuedIntent.totp_ambiguous ||
    issuedIntent.totp_code !== code
  ) {
    refuse(
      409,
      "echo_code_card_reference_unusable",
      "This card's reference cannot be expressed as one unambiguous approval message.",
      "Approve this card in the cockpit; text approval needs a card reference the verifier can read back unambiguously.",
    );
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SES_ECHO_CODE_EXPIRY_MS);
  const requestId = crypto.randomUUID();
  const rpc = await client.rpc("issue_ses_channel_approval_request", {
    p_org_id: request.org_id,
    p_job_id: request.job_id,
    p_channel: channel,
    p_sender_fingerprint: binding.sender_fingerprint,
    p_request_id: requestId,
    p_message_hash: await boundApprovalMessageHash(
      messageText,
      approvalCoordinates,
    ),
    p_code_hash: `sha256:${await hmacCode(rootSecret, code)}`,
    p_issued_at: now.toISOString(),
    p_expires_at: expiresAt.toISOString(),
  });
  if (rpc.error) {
    refuse(
      503,
      "echo_code_issue_unreadable",
      "The approval request could not be durably issued.",
      "Retry once the approval ledger is readable.",
    );
  }
  const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  if (!row?.request_id) {
    refuse(
      429,
      "echo_code_sender_locked",
      "Approval requests for this enrolled sender are temporarily locked after repeated failures.",
      "Wait 15 minutes for the cooling-off window to expire, then issue a new request.",
    );
  }
  // This is the sole code-bearing transport envelope. No read action returns
  // the code, and no log/error path includes it.
  return {
    echo_code: {
      contract: SES_ECHO_CODE_CONTRACT_VERSION,
      request_id: String(row.request_id),
      channel,
      message_text: messageText,
      expires_at: String(row.expires_at),
      ...approvalCoordinates,
    },
  };
}

export async function submitSesEchoCodeApprovalAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  request: SesChannelApprovalRequest & {
    request_id?: unknown;
    expected_docket_revision_id?: unknown;
    expected_invoice_obligation_revision_id?: unknown;
    expected_output_content_hash?: unknown;
  },
  deps: SesEchoCodeApprovalDeps,
) {
  requireRelay(auth);
  const bindings = parseSesChannelOperatorBindings(deps.env.bindings_raw);
  const rootSecret = String(deps.env.root_secret || "");
  if (!bindings.length || !rootSecret) {
    refuse(
      503,
      "channel_binding_not_configured",
      "No enrolled sender binding is configured.",
      "Enrol the sender binding before verifying an approval.",
    );
  }
  const channel = String(request.channel ?? "").toLowerCase();
  const senderFingerprint = await sesChannelSenderFingerprint(
    channel,
    request.sender_id,
  );
  const binding = resolveSesChannelOperatorBinding(
    bindings,
    channel,
    senderFingerprint,
  );
  const requestId = String(request.request_id ?? "").trim();
  if (!requestId) {
    refuse(
      400,
      "echo_code_request_id_missing",
      "The message carries no issued approval request identity.",
      "Transport the issued request id with the message.",
    );
  }
  const messageText = String(request.message_text ?? "");
  const approvalCoordinates = requireApprovalCoordinates({
    expected_docket_revision_id: String(
      request.expected_docket_revision_id || "",
    ),
    expected_invoice_obligation_revision_id: String(
      request.expected_invoice_obligation_revision_id || "",
    ),
    expected_output_content_hash: String(
      request.expected_output_content_hash || "",
    ),
  });
  const intent = parseSesChannelApprovalMessage(messageText);
  // Text SEND IT is retired, and its refusal is named rather than folded into
  // the generic message refusal: a recognised send word must be answerable as
  // "that act is not on this door", never as "your message was unreadable".
  if (intent.act === "send_it" && !intent.act_ambiguous) {
    refuse(
      409,
      "channel_send_not_supported",
      "SEND IT remains a separate act and is not coupled to echo-code approval.",
      "Use the separate SEND IT path.",
    );
  }
  if (
    intent.act !== "approve_invoice" || intent.act_ambiguous ||
    intent.card_references.length !== 1 || intent.totp_ambiguous ||
    !intent.totp_code
  ) {
    refuse(
      403,
      "echo_code_message_invalid",
      "The exact issued approval message could not be established.",
      "Use the exact one-card message from the issued transport envelope.",
    );
  }
  // Sender identity is settled BEFORE the request is touched. An unenrolled
  // sender is somebody else's act: it must not consume the captain's pending
  // request and must not move any failure counter.
  if (!binding) {
    refuse(
      403,
      "channel_sender_not_bound",
      "The message did not come from an enrolled sender identity.",
      "Use the enrolled sender identity or approve in the cockpit.",
    );
  }
  const result = await client.rpc("consume_ses_channel_approval_code", {
    p_request_id: requestId,
    p_channel: channel,
    p_sender_fingerprint: senderFingerprint,
    p_message_hash: await boundApprovalMessageHash(
      messageText,
      approvalCoordinates,
    ),
    p_code_hash: `sha256:${await hmacCode(rootSecret, intent.totp_code)}`,
    p_now: new Date(deps.now()).toISOString(),
    p_lockout_threshold: SES_ECHO_CODE_LOCKOUT_THRESHOLD,
    p_lockout_window: `${SES_ECHO_CODE_LOCKOUT_WINDOW_MS / 60000} minutes`,
  });
  if (result.error) {
    refuse(
      503,
      "echo_code_verify_unreadable",
      "The approval request could not be verified durably.",
      "Retry once the approval ledger is readable.",
    );
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  // The database consumes the request before returning a message or code
  // mismatch, so a wrong guess spends its own request. A sender that is not the
  // one this request was issued to consumes nothing and counts nothing.
  if (!row?.accepted) {
    const reason = String(row?.reason || "invalid");
    if (reason === "sender_mismatch") {
      refuse(
        403,
        "echo_code_sender_mismatch",
        "This approval request was issued to a different enrolled sender identity.",
        "Verify from the enrolled sender the request was issued to, or issue a fresh request.",
      );
    }
    if (reason === "already_used") {
      refuse(
        409,
        "echo_code_already_used",
        "This issued approval code has already been consumed and cannot authorise another message.",
        "Request a fresh approval code.",
      );
    }
    if (reason === "expired") {
      refuse(
        409,
        "echo_code_expired",
        "This issued approval code has expired.",
        "Request a fresh approval code.",
      );
    }
    refuse(
      reason === "locked" ? 429 : 403,
      reason === "locked" ? "echo_code_sender_locked" : "echo_code_invalid",
      "The issued code, enrolled sender and exact approval message did not verify together.",
      reason === "locked"
        ? "Wait 15 minutes for the cooling-off window to expire."
        : "Request a fresh approval code and use its exact message.",
    );
  }
  // The approval is recorded against the org and card bound at ISSUANCE. The
  // relay's own body carries an org too, and it must never choose a persisted
  // field on the money-approval ledger row.
  const issuedOrgId = String(row?.org_id ?? "");
  const issuedJobId = String(row?.job_id ?? "");
  if (!issuedOrgId || !issuedJobId) {
    refuse(
      503,
      "echo_code_issued_binding_unreadable",
      "The verified request did not return the org and card it was issued against.",
      "Retry once the approval ledger returns the issued binding.",
    );
  }
  const operatorUser = await loadBoundOperatorUser(client, binding);
  const card = await resolveSesChannelCard(client, intent.card_references[0]!);
  if (card.job_id !== issuedJobId) {
    refuse(
      409,
      "echo_code_card_binding_mismatch",
      "The card named in the approval message is not the card this request was issued against.",
      "Issue a fresh approval request for the card you intend to approve.",
    );
  }
  const operatorAuth: SesActionAuth = {
    mode: "jwt",
    user: operatorUser,
    identity_provenance: "bound_channel_echo_code",
  };
  const operatorAct = {
    kind: "ses_channel_echo_operator_act",
    contract: SES_ECHO_CODE_CONTRACT_VERSION,
    request_id: requestId,
    message_id: String(request.message_id ?? ""),
    message_hash: `sha256:${await sha256(messageText)}`,
    channel,
    sender_fingerprint: senderFingerprint,
    operator_user_id: binding.operator_user_id,
    operator_label: binding.label,
    act: "approve_invoice",
    card_reference: intent.card_references[0]!,
    ...approvalCoordinates,
  };
  const approval = await deps.approveInvoice(operatorAuth, {
    org_id: issuedOrgId,
    job_id: issuedJobId,
    includes_authorise: false,
    evidence_refs: [operatorAct],
    ...approvalCoordinates,
  });
  return {
    echo_code_approval: {
      contract: SES_ECHO_CODE_CONTRACT_VERSION,
      request_id: requestId,
      job_id: card.job_id,
      job_number: card.job_number,
      operator_act: operatorAct,
    },
    approval,
  };
}
