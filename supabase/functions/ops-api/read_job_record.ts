// A stored business record, not a provider reconciliation or an enriched dossier.
export const JOB_RECORD_VERSION = "2026-09-09.1";
export const JOB_RECORD_MAX_BYTES = 4 * 1024 * 1024;
export const JOB_RECORD_COLUMNS = [
  "id",
  "org_id",
  "job_number",
  "type",
  "status",
  "archived",
  "legacy",
  "created_by",
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "site_suburb",
  "site_lat",
  "site_lng",
  "scope_json",
  "pricing_json",
  "notes",
  "scope_version",
  "scope_updated_at",
  "quoted_value",
  "expected_costs",
  "expected_frozen_at",
  "deposit_amount",
  "payment_terms",
  "council_required",
  "quoted_at",
  "accepted_at",
  "approvals_at",
  "deposit_at",
  "processing_at",
  "scheduled_at",
  "completed_at",
  "created_at",
  "updated_at",
  "ghl_contact_id",
  "ghl_opportunity_id",
  "xero_contact_id",
  "xero_quote_id",
  "deposit_invoice_id",
  "callback_parent_id",
  "is_callback",
  "cross_sell_source_job_id",
  "cross_sell_flags",
  "satisfaction_rating",
  "ses_money_sealed_at",
  "ses_money_seal_source",
  "ses_money_seal_version",
] as const;

export class JobRecordReadError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function jobRecordSelector(params: URLSearchParams) {
  for (const key of params.keys()) {
    if (
      !["action", "job_id", "job_number"].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      throw new JobRecordReadError(
        "INVALID_JOB_SELECTOR",
        400,
        "Use one exact job_id or job_number selector",
      );
    }
  }
  const hasId = params.has("job_id");
  if (hasId === params.has("job_number")) {
    throw new JobRecordReadError(
      "INVALID_JOB_SELECTOR",
      400,
      "Use one exact job_id or job_number selector",
    );
  }
  const field = hasId ? "id" : "job_number";
  const value = (params.get(hasId ? "job_id" : "job_number") || "").trim();
  if (
    !value || (hasId ? !UUID.test(value) : value.length > 128 ||
      [...value].some((char) => char.charCodeAt(0) < 32))
  ) {
    throw new JobRecordReadError(
      "INVALID_JOB_SELECTOR",
      400,
      "Use a complete UUID or literal job number of at most 128 characters",
    );
  }
  return { field, value };
}

const REDACTED = "[REDACTED_CREDENTIAL]";
const SECRET_KEY =
  /^(?:(?:access|refresh|id|auth|authentication|authorization|bearer|portal|share|download|session|reset|invite|invitation|verification|sas)?token|(?:x?api|service(?:role)?|private|secret|signing|encryption|client)?(?:key|secret)|password|passwd|bearer|auth|authentication|authorization|cookie|setcookie|credential|credentials|connectionstring|signedurl|signeddownloadurl)$/i;
function secretKey(key: string) {
  return SECRET_KEY.test(key.replace(/[^a-z0-9]/gi, ""));
}

// Supported known credential forms. This is deliberately not a claim to detect
// an arbitrary previously unknown password written as ordinary prose.
function containsCredential(value: string): boolean {
  if (
    /\bBearer\s+[a-z0-9._~+\/-]+=*/i.test(value) ||
    /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(value) ||
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(value) ||
    /\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|portal[_ -]?token|share[_ -]?token|auth|bearer)\s*[:=]\s*\S+/i
      .test(value)
  ) return true;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch { /* inspect the original */ }
  for (const candidate of new Set([value, decoded])) {
    for (const match of candidate.matchAll(/(?:https?:\/\/|\/)[^\s<>"']+/gi)) {
      try {
        const url = new URL(match[0], "https://stored-reference.invalid");
        if (url.username || url.password) return true;
        const query = new URLSearchParams(url.search);
        const fragment = new URLSearchParams(
          url.hash.slice(1).replace(/^\?/, ""),
        );
        for (const [key] of [...query, ...fragment]) {
          if (
            secretKey(key) ||
            /^(?:sig|signature|x-amz-.+|x-goog-.+|code)$/i.test(key)
          ) return true;
        }
        const path = decodeURIComponent(url.pathname);
        if (
          /(?:^|\/)(?:portal|share|invite|reset|access|sign|signed|download)\/[^/]+/i
            .test(path) ||
          (/\/portal(?:\/|$)/i.test(path) && (url.hash || url.search))
        ) return true;
      } catch {
        // A malformed URL with token/signed/portal markers cannot be safely interpreted.
        if (/token|secret|signature|portal|x-amz-|x-goog-/i.test(match[0])) {
          return true;
        }
      }
    }
  }
  return false;
}

export function sanitizeJobRecord(record: Record<string, unknown>) {
  const redactedPaths: string[] = [];
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > 200_000 || depth > 64) {
      throw new JobRecordReadError(
        "JOB_RECORD_CONTENT_UNAVAILABLE",
        422,
        "Stored content exceeds the supported structural limits",
      );
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (containsCredential(value)) {
        redactedPaths.push(path);
        return REDACTED;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => visit(item, `${path}/${i}`, depth + 1));
    }
    if (
      value && typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        // Do not leak credentials through object names or warning paths.
        if (containsCredential(key)) {
          throw new JobRecordReadError(
            "JOB_RECORD_CONTENT_UNAVAILABLE",
            422,
            "Stored content contains an unsafe field name",
          );
        }
        const nextPath = `${path}/${
          key.replace(/~/g, "~0").replace(/\//g, "~1")
        }`;
        if (secretKey(key) && item !== null) {
          redactedPaths.push(nextPath);
          result[key] = REDACTED;
        } else result[key] = visit(item, nextPath, depth + 1);
      }
      return result;
    }
    throw new JobRecordReadError(
      "JOB_RECORD_CONTENT_UNAVAILABLE",
      422,
      "Stored content is not supported JSON",
    );
  };
  return {
    job: visit(record, "/job", 0) as Record<string, unknown>,
    redactedPaths,
  };
}

export async function readJobRecord(
  // Supabase query builders are thenables; keeping this narrow structural surface
  // avoids coupling a SELECT-only reader to service-role mutation capabilities.
  // deno-lint-ignore no-explicit-any
  client: { from: (table: string) => any },
  params: URLSearchParams,
  orgId: string,
) {
  if (!UUID.test(orgId)) {
    throw new JobRecordReadError(
      "JOB_RECORD_ORG_REQUIRED",
      403,
      "A verified organisation is required",
    );
  }
  const selector = jobRecordSelector(params);
  let response: { data: Record<string, unknown>[] | null; error: unknown };
  try {
    response = await client.from("jobs").select(JOB_RECORD_COLUMNS.join(","))
      .eq("org_id", orgId).eq(selector.field, selector.value).limit(2);
  } catch {
    throw new JobRecordReadError(
      "JOB_RECORD_READ_FAILED",
      502,
      "The stored job record could not be read",
    );
  }
  if (response.error || !Array.isArray(response.data)) {
    throw new JobRecordReadError(
      "JOB_RECORD_READ_FAILED",
      502,
      "The stored job record could not be read",
    );
  }
  if (!response.data.length) {
    throw new JobRecordReadError(
      "JOB_NOT_FOUND",
      404,
      "Job not found in the authorised organisation",
    );
  }
  if (response.data.length !== 1) {
    throw new JobRecordReadError(
      "AMBIGUOUS_JOB_SELECTOR",
      409,
      "The exact selector matched multiple jobs",
    );
  }
  const source = response.data[0];
  if (
    source.org_id !== orgId ||
    (selector.field === "id"
      ? String(source.id).toLowerCase() !== selector.value.toLowerCase()
      : source.job_number !== selector.value)
  ) {
    throw new JobRecordReadError(
      "JOB_RECORD_IDENTITY_MISMATCH",
      502,
      "The stored record did not match the requested identity",
    );
  }
  const projection: Record<string, unknown> = {};
  for (const column of JOB_RECORD_COLUMNS) {
    if (!Object.hasOwn(source, column)) {
      throw new JobRecordReadError(
        "JOB_RECORD_PROJECTION_UNAVAILABLE",
        502,
        "The declared job projection was incomplete",
      );
    }
    projection[column] = source[column];
  }
  const { job, redactedPaths } = sanitizeJobRecord(projection);
  const fieldCoverage = (field: string) =>
    job[field] === null
      ? "stored_null"
      : redactedPaths.some((path) =>
          path === `/job/${field}` || path.startsWith(`/job/${field}/`)
        )
      ? "redacted"
      : "full";
  const result = {
    ok: true,
    contract_version: JOB_RECORD_VERSION,
    job,
    selector_used: { field: selector.field, value: selector.value },
    provenance: {
      source: "supabase.public.jobs",
      provider_live: false,
      retrieved_at: new Date().toISOString(),
      stored_updated_at: job.updated_at,
      scope_version: job.scope_version,
      scope_updated_at: job.scope_updated_at,
      organisation: orgId,
      projection_version: JOB_RECORD_VERSION,
    },
    links: {
      ghl: {
        contact_id: job.ghl_contact_id,
        opportunity_id: job.ghl_opportunity_id,
      },
      xero: { contact_id: job.xero_contact_id, quote_id: job.xero_quote_id },
      jobs: {
        deposit_invoice_id: job.deposit_invoice_id,
        callback_parent_id: job.callback_parent_id,
        cross_sell_source_job_id: job.cross_sell_source_job_id,
      },
    },
    coverage: {
      projection_complete: true,
      job_record_complete: redactedPaths.length === 0,
      content_redacted: redactedPaths.length > 0,
      scope_json: fieldCoverage("scope_json"),
      pricing_json: fieldCoverage("pricing_json"),
      related_collections: "not_fetched",
      provider_state: "not_fetched",
    },
    redacted_paths: redactedPaths,
    warnings: redactedPaths.map((path) => ({
      path,
      reason: "credential_content_redacted",
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > JOB_RECORD_MAX_BYTES) {
    throw new JobRecordReadError(
      "JOB_RECORD_TOO_LARGE",
      413,
      "Full stored content exceeds this reader delivery limit",
      {
        safe_response_bytes: bytes,
        max_response_bytes: JOB_RECORD_MAX_BYTES,
        full_delivery_supported: false,
        available_fields: JOB_RECORD_COLUMNS,
      },
    );
  }
  return result;
}
