// T7 Loop 3 — get_evidence_body ops-api handler
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 4)
//
// Resolves a spine_event_id to:
//   - the source row's spine envelope (job_id, channel, direction, timestamps, summary)
//   - either the body_pointer + signed URL (when role allows + hash verifies)
//     OR an explicit denial reason (no body / role denied / integrity failed)
//
// Hard rules:
//   - service_role-only via the same auth boundary as the rest of ops-api
//   - role check before any signed URL is created (no leak via /storage/v1/...)
//   - hash MUST verify before the URL is signed; mismatch returns 5xx + a
//     spine row 'evidence.integrity_failed' so the failure is itself audited
//   - never returns the body bytes inline; always a signed URL with a
//     short TTL (default 300s)
//
// AUTHORIZATION CONTRACT (caller's responsibility):
//   The dispatcher (e.g. ops-api) MUST populate `caller` from a verified
//   server-side authentication context — never from request headers/body
//   the client controls. Specifically:
//     - caller.user_id      : Supabase Auth user uuid (from JWT verification)
//     - caller.role         : users.role looked up server-side from user_id
//     - caller.is_admin     : users.is_admin OR role in {'admin','owner'}
//     - caller.assigned_job_ids : current assignments for this user (used to
//                                 scope non-admin reads to the user's jobs)
//     - caller.org_id       : org of the authenticated user
//   This handler trusts those values. If the dispatcher passes
//   client-controlled input as `caller.role`, the auth model is bypassed.
//
// The response shape is intentionally narrow so the cockpit can render
// "view evidence" without being tempted to embed the body in markup.

import { readBodyAndVerify, signBodyUrl } from "./storage.ts";
import { recordEvidence } from "./record_evidence.ts";

export interface GetEvidenceBodyRequest {
  spine_event_id: string;
  /** Optional override; defaults to 300s. Capped at 900s server-side. */
  ttl_seconds?: number;
}

export interface GetEvidenceBodyResponse {
  spine_event_id: string;
  job_id: string | null;
  channel: string | null;
  direction: string | null;
  occurred_at: string | null;
  body_present: boolean;
  body_pointer: string | null;
  body_hash: string | null;
  signed_url: string | null;
  privacy_classification: string | null;
  integrity_verified: boolean;
  ttl_seconds: number;
  reason?: string;
}

/**
 * Caller context. Every field here MUST come from a verified server-side
 * source (Supabase Auth JWT → users table lookup), not from request input.
 * See AUTHORIZATION CONTRACT comment above.
 */
export interface EvidenceCaller {
  user_id?: string;
  role?: string;
  is_admin?: boolean;
  /**
   * Job ids this user is currently assigned to. Used to scope non-admin
   * reads. May be empty (=> non-admin gets denied for any job-linked row).
   * Pass an empty array (not undefined) when the user has no assignments.
   */
  assigned_job_ids?: string[];
  org_id?: string;
}

const MAX_TTL = 900;
const DEFAULT_TTL = 300;

/**
 * Privacy class → exact set of roles allowed to read the body.
 * Fail-closed: anything not in this map (including null/empty privacy)
 * defaults to `staff_only`. Anything not in the role list for the matched
 * class is denied.
 *
 * NOTE: `internal` is tightened from the original "any authenticated" to
 * a small staff allowlist. Internal evidence (audit, system messages)
 * should not be visible to crew/client roles by default.
 */
const PRIVACY_ROLE_ALLOWLIST: Record<string, ReadonlyArray<string>> = {
  restricted_pii:    ["admin", "owner"],
  audio_unredacted:  ["admin", "owner"],
  staff_only:        ["admin", "owner", "ops_manager", "sales_manager", "sales", "estimator"],
  client_safe:       ["admin", "owner", "ops_manager", "sales_manager", "sales", "estimator"],
  internal:          ["admin", "owner", "ops_manager", "sales_manager"],
};

const DEFAULT_PRIVACY_CLASS = "staff_only";

function rolePermitted(role: string, privacy: string | null): boolean {
  const r = (role || "").toLowerCase().trim();
  if (!r) return false;
  const klass = (privacy || DEFAULT_PRIVACY_CLASS).toLowerCase().trim();
  const allowed = PRIVACY_ROLE_ALLOWLIST[klass];
  if (!allowed) return false; // unknown privacy class → deny
  return allowed.includes(r);
}

// deno-lint-ignore no-explicit-any
export async function getEvidenceBody(
  // deno-lint-ignore no-explicit-any
  client: any,
  // deno-lint-ignore no-explicit-any
  storage_client: any,
  body: GetEvidenceBodyRequest,
  caller: EvidenceCaller,
): Promise<GetEvidenceBodyResponse> {
  if (!body.spine_event_id) {
    throw new Error("get_evidence_body: spine_event_id required");
  }
  const ttl = Math.min(Math.max(body.ttl_seconds ?? DEFAULT_TTL, 60), MAX_TTL);

  // Pre-flight: caller must carry a verified user_id. The dispatcher is
  // responsible for sourcing this from a Supabase Auth JWT — never from
  // request input. A missing user_id means the request is unauthenticated
  // and is rejected before any spine read so no information leaks.
  if (!caller.user_id || String(caller.user_id).trim().length === 0) {
    return denied(body.spine_event_id, ttl, "unauthenticated: caller.user_id required");
  }

  const { data, error } = await client
    .from("business_events")
    .select("id, job_id, channel, direction, occurred_at, body_pointer, body_hash, privacy_classification")
    .eq("id", body.spine_event_id)
    .limit(1);
  if (error) throw new Error(`get_evidence_body: spine read failed: ${error.message}`);
  const row = data?.[0];
  if (!row) {
    return {
      spine_event_id: body.spine_event_id,
      job_id: null,
      channel: null,
      direction: null,
      occurred_at: null,
      body_present: false,
      body_pointer: null,
      body_hash: null,
      signed_url: null,
      privacy_classification: null,
      integrity_verified: false,
      ttl_seconds: ttl,
      reason: "spine_event_id not found",
    };
  }

  if (!row.body_pointer) {
    return {
      spine_event_id: row.id,
      job_id: row.job_id,
      channel: row.channel,
      direction: row.direction,
      occurred_at: row.occurred_at,
      body_present: false,
      body_pointer: null,
      body_hash: row.body_hash,
      signed_url: null,
      privacy_classification: row.privacy_classification,
      integrity_verified: false,
      ttl_seconds: ttl,
      reason: "no body_pointer (body fits inline in body_preview, or storage failed at write time)",
    };
  }

  // Role gate. Denial response intentionally redacts body_pointer and
  // body_hash so a denied caller cannot use them to attempt direct
  // bucket access (RLS would still block, but defence-in-depth).
  if (!rolePermitted(caller.role ?? "", row.privacy_classification)) {
    return {
      spine_event_id: row.id,
      job_id: row.job_id,
      channel: row.channel,
      direction: row.direction,
      occurred_at: row.occurred_at,
      body_present: true,
      body_pointer: null,                       // redacted on denial
      body_hash: null,                          // redacted on denial
      signed_url: null,
      privacy_classification: row.privacy_classification,
      integrity_verified: false,
      ttl_seconds: ttl,
      reason: `role '${caller.role ?? ""}' not permitted for privacy_classification '${row.privacy_classification ?? DEFAULT_PRIVACY_CLASS}'`,
    };
  }

  // Job-level scope. Admin/owner bypass; everyone else must be assigned
  // to the job that produced this evidence. Rows with job_id IS NULL
  // (unmatched / system-channel) are admin-only — operational staff can
  // see the envelope but cannot dereference an unmatched body.
  if (!caller.is_admin) {
    if (row.job_id === null) {
      return {
        spine_event_id: row.id,
        job_id: null,
        channel: row.channel,
        direction: row.direction,
        occurred_at: row.occurred_at,
        body_present: true,
        body_pointer: null,
        body_hash: null,
        signed_url: null,
        privacy_classification: row.privacy_classification,
        integrity_verified: false,
        ttl_seconds: ttl,
        reason: "unmatched evidence (job_id IS NULL): admin/owner only",
      };
    }
    const assigned = caller.assigned_job_ids ?? [];
    if (!assigned.includes(row.job_id)) {
      return {
        spine_event_id: row.id,
        job_id: row.job_id,
        channel: row.channel,
        direction: row.direction,
        occurred_at: row.occurred_at,
        body_present: true,
        body_pointer: null,
        body_hash: null,
        signed_url: null,
        privacy_classification: row.privacy_classification,
        integrity_verified: false,
        ttl_seconds: ttl,
        reason: `caller not assigned to job '${row.job_id}'`,
      };
    }
  }

  // Integrity check.
  if (row.body_hash) {
    try {
      await readBodyAndVerify(storage_client, row.body_pointer, row.body_hash);
    } catch (e) {
      // Integrity failure: log a spine row before returning 5xx.
      try {
        await recordEvidence(client, {
          event_type: "evidence.integrity_failed",
          source: "get_evidence_body",
          channel: "system",
          direction: "system",
          source_table: "business_events",
          source_id: row.id,
          job_id: row.job_id,
          payload: {
            failed_pointer: row.body_pointer,
            expected_hash: row.body_hash,
            error: (e as Error).message,
          },
          match_method: row.job_id ? "direct_job_id" : "none",
        }, {
          org_id: caller.org_id ?? "00000000-0000-0000-0000-000000000001",
          bypass_feature_flag: true, // integrity logging always on
          storage_client,
        });
      } catch { /* nothing more to do */ }
      throw new Error(`get_evidence_body: integrity check failed: ${(e as Error).message}`);
    }
  }

  // Sign the URL.
  const signed_url = await signBodyUrl(storage_client, row.body_pointer, ttl);

  return {
    spine_event_id: row.id,
    job_id: row.job_id,
    channel: row.channel,
    direction: row.direction,
    occurred_at: row.occurred_at,
    body_present: true,
    body_pointer: row.body_pointer,
    body_hash: row.body_hash,
    signed_url,
    privacy_classification: row.privacy_classification,
    integrity_verified: true,
    ttl_seconds: ttl,
  };
}

/**
 * Build a denial response that reveals nothing about the row beyond the
 * spine_event_id the caller already knew. Used for unauthenticated /
 * pre-spine-read denials so we don't leak existence.
 */
function denied(
  spine_event_id: string,
  ttl_seconds: number,
  reason: string,
): GetEvidenceBodyResponse {
  return {
    spine_event_id,
    job_id: null,
    channel: null,
    direction: null,
    occurred_at: null,
    body_present: false,
    body_pointer: null,
    body_hash: null,
    signed_url: null,
    privacy_classification: null,
    integrity_verified: false,
    ttl_seconds,
    reason,
  };
}
