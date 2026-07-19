export interface AlarmReadinessInput {
  alarmEnabled: boolean | null;
  recipientCount: number | null;
  latestHttpStatus?: number | null;
  latestObservedAt?: string | null;
  settingsReadError?: string | null;
}

/** Pure read-model for alarm readiness. It never infers that a scheduled invocation
 * authenticated merely because the cron exists. An observed 401 is explicitly failed;
 * absent gateway evidence remains unverified, never ready. */
export function alarmReadinessFacts(input: AlarmReadinessInput) {
  const status = Number(input.latestHttpStatus || 0) || null;
  const authentication = status === 401 || status === 403
    ? {
      status: "failed" as const,
      http_status: status,
      reason: "alarm_invocation_unauthorised",
    }
    : status !== null && status >= 200 && status < 300
    ? { status: "verified" as const, http_status: status, reason: null }
    : {
      status: "unverified" as const,
      http_status: status,
      reason: "edge_http_status_not_persisted_in_intake_health",
    };
  const recipientsConfigured = input.recipientCount === null
    ? null
    : input.recipientCount > 0;
  return {
    ready: authentication.status === "verified" &&
      input.alarmEnabled === true && recipientsConfigured === true,
    action: "makesafe_email_canary",
    cadence_minutes: 15,
    required_auth: "SW_API_KEY_or_service_role",
    authentication,
    latest_observed_at: input.latestObservedAt || null,
    alarm_enabled: input.alarmEnabled,
    recipients_configured: recipientsConfigured,
    recipient_count: input.recipientCount,
    settings_read_error: input.settingsReadError || null,
  };
}
