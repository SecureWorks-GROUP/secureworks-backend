// deno-lint-ignore-file no-explicit-any
// The owner-approved price a quote send needs before the customer sees a
// price (20261109040000_scope_owner_approvals.sql). Both send-quote paths,
// /send and /send-runs, judge it before any email.
//
//   A send that names a saved revision: the price decision on that revision
//   must exist, or nothing is sent (409 owner_price_approval_required).
//   A legacy send that names no revision: refused while
//   owner_approval_saved_revision_required_v1 is on; otherwise sent as today
//   and recorded as an unapproved send (job event quote_send_price_unapproved)
//   so the count is visible.

import type { SealedSendSource } from "./quote_scope_revision_link.ts";

export const OWNER_APPROVAL_SAVED_REVISION_FLAG =
  "owner_approval_saved_revision_required_v1";

export type OwnerPriceGate =
  | { kind: "approved"; approval_id: string; scope_revision_id: string }
  | { kind: "legacy_unapproved" }
  /** The sealed-revision judgement refuses this send on its own. */
  | { kind: "not_judged" }
  | {
    kind: "refused";
    status: number;
    body: { error: string; code: string };
  };

export async function ownerPriceGate(
  sb: any,
  jobId: string,
  sealed: SealedSendSource,
): Promise<OwnerPriceGate> {
  if (sealed.kind === "refused") return { kind: "not_judged" };
  if (sealed.kind === "sealed") {
    try {
      const { data, error } = await sb.rpc("scope_price_owner_approval", {
        p_job_id: jobId,
        p_scope_revision_id: sealed.revision_id,
      });
      if (error) return unreadable();
      if (!data || typeof data !== "object" || !data.id) {
        return {
          kind: "refused",
          status: 409,
          body: {
            error:
              "The owner has not approved the price on this saved quote revision. Nothing was sent. Ask the owner to approve the price, then send again.",
            code: "owner_price_approval_required",
          },
        };
      }
      return {
        kind: "approved",
        approval_id: String(data.id),
        scope_revision_id: sealed.revision_id,
      };
    } catch {
      return unreadable();
    }
  }
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", OWNER_APPROVAL_SAVED_REVISION_FLAG).maybeSingle();
    if (error) return unreadable();
    if (data?.enabled === true) {
      return {
        kind: "refused",
        status: 409,
        body: {
          error:
            "This send names no saved quote revision, so the owner's price approval cannot be checked. Nothing was sent. Save the quote, have the owner approve its price, then send again.",
          code: "owner_price_approval_requires_saved_revision",
        },
      };
    }
    return { kind: "legacy_unapproved" };
  } catch {
    return unreadable();
  }
}

function unreadable(): OwnerPriceGate {
  return {
    kind: "refused",
    status: 503,
    body: {
      error:
        "Could not check the owner's price approval. Nothing was sent. Try again.",
      code: "owner_price_approval_unreadable",
    },
  };
}

/** After a legacy send went out: one ids-only record that it was sent with no
 * owner-approved price. Never blocks or undoes the send. */
export async function recordUnapprovedLegacySend(
  sb: any,
  jobId: string,
  detail: { path: "send" | "send-runs"; document_ids: string[] },
): Promise<void> {
  try {
    const { error } = await sb.from("job_events").insert({
      job_id: jobId,
      event_type: "quote_send_price_unapproved",
      detail_json: {
        reason: "no_saved_revision",
        path: detail.path,
        document_ids: detail.document_ids,
      },
    });
    if (error) {
      console.error(
        "[send-quote] unapproved legacy send not recorded:",
        error.code ?? "error",
      );
    }
  } catch {
    console.error("[send-quote] unapproved legacy send not recorded");
  }
}
