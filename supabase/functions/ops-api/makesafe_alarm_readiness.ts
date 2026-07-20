export interface AlarmReadinessInput {
  alarmEnabled: boolean | null;
  recipientCount: number | null;
  latestHttpStatus?: number | null;
  latestAuthenticatedAt?: string | null;
  nowIso?: string;
  maxAuthenticationAgeMinutes?: number;
  settingsReadError?: string | null;
}

/** Pure read-model for alarm readiness. It never infers authentication from cron
 * existence, recipient configuration, or an arbitrary 2xx. Verification requires
 * a fresh timestamp persisted only after the protected canary route passed auth. */
export function alarmReadinessFacts(input: AlarmReadinessInput) {
  const status = Number(input.latestHttpStatus || 0) || null;
  const authenticatedAt = input.latestAuthenticatedAt || null;
  const nowMs = Date.parse(input.nowIso || new Date().toISOString());
  const authenticatedMs = authenticatedAt ? Date.parse(authenticatedAt) : NaN;
  const maxAgeMinutes = Math.max(1, input.maxAuthenticationAgeMinutes ?? 15);
  const ageMinutes = Number.isFinite(authenticatedMs) && Number.isFinite(nowMs)
    ? (nowMs - authenticatedMs) / 60_000
    : null;
  const authentication = status === 401 || status === 403
    ? {
      status: "failed" as const,
      http_status: status,
      verified_at: authenticatedAt,
      age_minutes: ageMinutes,
      reason: "alarm_invocation_unauthorised",
    }
    : authenticatedAt && ageMinutes !== null && ageMinutes >= 0 &&
        ageMinutes <= maxAgeMinutes
    ? {
      status: "verified" as const,
      http_status: status,
      verified_at: authenticatedAt,
      age_minutes: Math.round(ageMinutes * 100) / 100,
      reason: null,
    }
    : authenticatedAt
    ? {
      status: "stale" as const,
      http_status: status,
      verified_at: authenticatedAt,
      age_minutes: ageMinutes === null
        ? null
        : Math.round(ageMinutes * 100) / 100,
      reason: "alarm_authentication_proof_stale",
    }
    : {
      status: "unverified" as const,
      http_status: status,
      verified_at: null,
      age_minutes: null,
      reason: "authenticated_canary_not_observed",
    };
  const recipientsConfigured = input.recipientCount === null
    ? null
    : input.recipientCount > 0;
  return {
    ready: authentication.status === "verified" &&
      input.alarmEnabled === true && recipientsConfigured === true &&
      !input.settingsReadError,
    action: "makesafe_email_canary",
    cadence_minutes: 15,
    authentication_max_age_minutes: maxAgeMinutes,
    required_auth: "SW_API_KEY_or_service_role",
    authentication,
    latest_observed_at: authenticatedAt,
    alarm_enabled: input.alarmEnabled,
    recipients_configured: recipientsConfigured,
    recipient_count: input.recipientCount,
    settings_read_error: input.settingsReadError || null,
  };
}
