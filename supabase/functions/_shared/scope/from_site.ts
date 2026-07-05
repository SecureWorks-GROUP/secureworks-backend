// M0 · U3 — Sales-scope records + the "quoted from site" proof contract.
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U3). Contract §2a call 4 +
// call 1. Interface locks agreed with Deckhand B (scoreboard views):
//   * from_site proof is written INTO the quote.sent business_events payload,
//     server-side: payload.from_site='true' + payload.from_site_evidence (jsonb).
//     No dedicated column or table. B's view reads payload->>'from_site'='true'.
//   * sandbox validation events self-mark payload.is_test='true' (B excludes them).
//
// STRICT (call 4, not softened): a quote counts as "from site" ONLY when the
// send verifiably originates from the scoping tool's on-site sign-off flow, in
// the SAME tool session as the sign-off, by the ASSIGNED scoper. Enforced
// server-side against a real `scope.signed_off` business_event — never
// client-asserted. A caller can pass a session id, but it must match a
// server-recorded sign-off event by the assigned scoper, so it cannot be faked.
//
// Because no scope sign-off event existed before this unit, U3 also emits
// `scope.signed_off` at freeze time (see ops-api freeze_scope) carrying the
// tool_session_id + scoper. Until the scoping-tool client passes a session id
// at both freeze and send, no quote is flagged — which is exactly what STRICT
// means (nothing counts until proven). The from_site_estimated heuristic labels
// history for context only and NEVER counts.

// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

/** assignment_type for a sales scope visit. Distinct from ops' 'scope' value
 *  (which every reporting consumer matches by exact equality), so it can never
 *  leak into ops scope counts. */
export const SALES_SCOPE_ASSIGNMENT_TYPE = "sales_scope";

/** The on-site sign-off event emitted at scope freeze. */
export const SCOPE_SIGNOFF_EVENT_TYPE = "scope.signed_off";

/** Kill-switch: from_site stamping is inert until this flag is ON (Marnin-gated
 *  at CP4). Absent flag => OFF (fail-closed), so no migration/seed is required. */
export const FROM_SITE_FLAG = "from_site_proof_v1";

/** In-session sanity bound: a from-site send happens right after the on-site
 *  sign-off, in the same session — minutes, not hours. Distinct from the 4h
 *  ESTIMATED window below. */
export const FROM_SITE_IN_SESSION_WINDOW_MIN = 30;

/** Historical estimate heuristic (context only, NEVER counts). */
export const FROM_SITE_ESTIMATE_WINDOW_HOURS = 4;

const SCOPING_TOOL_BASE: Record<string, string> = {
  patio: "https://secureworks-group.github.io/patio/",
  fencing: "https://secureworks-group.github.io/fence-designer/",
};

/**
 * The scoping-tool deep-link the sales dash opens on an iPad from the calendar
 * appointment (Marnin, GATE 1). Deterministic from job type + id — the
 * sales_scope record carries its job_id, from which this resolves 1:1. Mirrors
 * the only existing builder (ghl-proxy `action==='link'`).
 */
export function scopingToolDeepLink(jobType: string | null | undefined, jobId: string): string {
  const tool = jobType === "fencing" ? "fencing" : "patio";
  return `${SCOPING_TOOL_BASE[tool]}?jobId=${jobId}`;
}

/** The evidence trail written to payload.from_site_evidence. */
export interface FromSiteEvidence {
  tool_session_id: string;
  scoper_user_id: string;
  scope_signoff_event_id: string;
  signoff_at: string | null;
  verified_at: string;
  verifier: "server";
}

/** Payload for the scope.signed_off event emitted at freeze. */
export function buildScopeSignoffPayload(args: {
  scopeRevisionId: string;
  jobId: string;
  scoperUserId: string | null;
  toolSessionId: string | null;
  signoffAt: string;
}): Record<string, unknown> {
  return {
    scope_revision_id: args.scopeRevisionId,
    job_id: args.jobId,
    scoper_user_id: args.scoperUserId ?? null,
    tool_session_id: args.toolSessionId ?? null,
    signoff_at: args.signoffAt,
  };
}

/**
 * Server-side proof gate. Returns the evidence to stamp, or null when the send
 * does not qualify (office resend, wrong scoper, different/absent session, or
 * no sign-off). Verifies against real `scope.signed_off` events:
 *   - SAME SESSION:   event.payload.tool_session_id === toolSessionId
 *   - ASSIGNED SCOPER: event.payload.scoper_user_id === assignedScoperId
 *   - IN SESSION:     send occurs within the window AFTER the sign-off
 * None of these can be satisfied by a client merely asserting from_site:true.
 */
export async function verifyFromSiteProof(
  supabase: SupabaseLike,
  args: {
    jobId: string;
    assignedScoperId: string | null | undefined;
    toolSessionId: string | null | undefined;
    sendAtIso: string;
    windowMinutes?: number;
  },
): Promise<FromSiteEvidence | null> {
  const { jobId, assignedScoperId, toolSessionId, sendAtIso } = args;
  if (!jobId || !assignedScoperId || !toolSessionId) return null;
  const windowMinutes = args.windowMinutes ?? FROM_SITE_IN_SESSION_WINDOW_MIN;

  const { data, error } = await supabase
    .from("business_events")
    .select("id, occurred_at, payload")
    .eq("event_type", SCOPE_SIGNOFF_EVENT_TYPE)
    .eq("job_id", jobId)
    .order("occurred_at", { ascending: false })
    .limit(20);
  if (error || !Array.isArray(data)) return null;

  const sendMs = Date.parse(sendAtIso);
  for (const ev of data) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (String(p.tool_session_id ?? "") !== String(toolSessionId)) continue; // same session
    if (String(p.scoper_user_id ?? "") !== String(assignedScoperId)) continue; // assigned scoper
    const signoffAt = (p.signoff_at as string | undefined) ?? ev.occurred_at ?? null;
    const signoffMs = Date.parse(String(signoffAt));
    if (Number.isFinite(sendMs) && Number.isFinite(signoffMs)) {
      const deltaMin = (sendMs - signoffMs) / 60000;
      if (deltaMin < -1 || deltaMin > windowMinutes) continue; // in-session sanity
    }
    return {
      tool_session_id: String(toolSessionId),
      scoper_user_id: String(assignedScoperId),
      scope_signoff_event_id: String(ev.id),
      signoff_at: signoffAt,
      verified_at: new Date().toISOString(),
      verifier: "server",
    };
  }
  return null;
}

/**
 * Historical ESTIMATE (never counts). True when a frozen scope sign-off for the
 * job occurred within FROM_SITE_ESTIMATE_WINDOW_HOURS BEFORE the quote was sent.
 * Pure — the labeller supplies the sign-off timestamps it already has.
 */
export function isFromSiteEstimated(
  quoteSentIso: string,
  signoffTimestamps: Array<string | null | undefined>,
  windowHours: number = FROM_SITE_ESTIMATE_WINDOW_HOURS,
): boolean {
  const sentMs = Date.parse(quoteSentIso);
  if (!Number.isFinite(sentMs)) return false;
  const winMs = windowHours * 3600_000;
  return signoffTimestamps.some((ts) => {
    const s = Date.parse(String(ts));
    return Number.isFinite(s) && s <= sentMs && sentMs - s <= winMs;
  });
}

/** Sandbox recipients that cannot reach a real client — used to force the
 *  no-real-send guard even if the caller forgets the is_test flag. */
export function isSandboxRecipient(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return (
    e.endsWith("@sandbox.secureworks.test") ||
    e.includes("+m0sandbox@") ||
    e.endsWith("@example.com")
  );
}

/** True when this send must be treated as a sandbox validation send: it must
 *  NOT reach a real client and every event it emits self-marks is_test. */
export function isSandboxSend(
  isTestFlag: unknown,
  recipientEmail: string | null | undefined,
): boolean {
  return isTestFlag === true || isTestFlag === "true" || isSandboxRecipient(recipientEmail);
}
