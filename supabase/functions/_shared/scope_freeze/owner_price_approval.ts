// deno-lint-ignore-file no-explicit-any
// The owner-approved price a quote send needs before the customer sees a
// price (20261109040000_scope_owner_approvals.sql). Every quote send path,
// send-quote /send and /send-runs and ops-api Quick Quote, judges it before
// any email.
//
//   A send that names a saved revision: the price decision on that revision
//   must exist, or nothing is sent (409 owner_price_approval_required).
//   A legacy send that names no revision: refused while
//   owner_approval_saved_revision_required_v1 is on; otherwise sent as today,
//   recorded before the email (claimUnapprovedLegacySend) and marked sent
//   after it (markUnapprovedLegacySendSent), so the count is visible and a
//   send that went out is never unaccounted.

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

export type UnapprovedSendPath = "send" | "send-runs" | "quick-quote";

/** The one record key per send: a quote document, or one Quick Quote call. */
export function unapprovedSendKeyForDocument(documentId: string): string {
  return `quote_document:${documentId}`;
}
export function unapprovedSendKeyForQuickQuote(callId: string): string {
  return `quick_quote:${callId}`;
}

type UnapprovedSend = {
  send_key: string;
  job_id: string;
  path: UnapprovedSendPath;
  document_id: string | null;
};

/** Before the email: the durable record of a send that names no saved
 * revision (quote_send_price_unapproved_sends). Idempotent on its key. When it
 * cannot be written, the caller sends nothing. */
export async function claimUnapprovedLegacySend(
  sb: any,
  send: UnapprovedSend,
): Promise<{ ok: true } | { ok: false; status: 503; body: { error: string; code: string } }> {
  try {
    const { data, error } = await sb.rpc("record_quote_send_price_unapproved", {
      p_send_key: send.send_key,
      p_job_id: send.job_id,
      p_path: send.path,
      p_document_id: send.document_id,
      p_state: "claimed",
    });
    if (!error && data?.recorded === true) return { ok: true };
    console.error(
      "[owner-price] unapproved send record refused:",
      error?.code ?? "not_recorded",
    );
  } catch {
    console.error("[owner-price] unapproved send record unreachable");
  }
  return {
    ok: false,
    status: 503,
    body: {
      error:
        "Could not record this send, which names no saved quote revision. Nothing was sent. Try again.",
      code: "owner_price_unapproved_send_unrecorded",
    },
  };
}

/** After the provider took the email, or on a replay of a published document:
 * moves an existing record to sent. Never invents a record and never blocks;
 * a record left claimed still accounts for the send. */
export async function markUnapprovedLegacySendSent(
  sb: any,
  send: UnapprovedSend,
): Promise<boolean> {
  try {
    const { data, error } = await sb.rpc("record_quote_send_price_unapproved", {
      p_send_key: send.send_key,
      p_job_id: send.job_id,
      p_path: send.path,
      p_document_id: send.document_id,
      p_state: "sent",
    });
    if (!error && data?.recorded === true) return true;
    if (error) {
      console.error("[owner-price] unapproved send not marked sent:", error.code ?? "error");
    }
  } catch {
    console.error("[owner-price] unapproved send not marked sent");
  }
  return false;
}

/** Everything a send path needs before its email, in one call: the price
 * gate, then (for a send naming no saved revision while the switch allows
 * it) the durable record. go carries the record to mark sent after the
 * provider took the email. */
export async function ownerPriceBeforeSend(
  sb: any,
  input: {
    job_id: string;
    sealed: SealedSendSource;
    path: UnapprovedSendPath;
    send_key: string;
    document_id: string | null;
  },
): Promise<
  | { kind: "go"; unapproved: UnapprovedSend | null }
  | { kind: "refused"; status: number; body: { error: string; code: string } }
> {
  const gate = await ownerPriceGate(sb, input.job_id, input.sealed);
  if (gate.kind === "refused") return gate;
  if (gate.kind === "not_judged") {
    return {
      kind: "refused",
      status: 409,
      body: {
        error: "The named quote revision could not be proved. Nothing was sent.",
        code: "owner_price_approval_not_judged",
      },
    };
  }
  if (gate.kind === "approved") return { kind: "go", unapproved: null };
  const unapproved: UnapprovedSend = {
    send_key: input.send_key,
    job_id: input.job_id,
    path: input.path,
    document_id: input.document_id,
  };
  const audit = await claimUnapprovedLegacySend(sb, unapproved);
  if (!audit.ok) return { kind: "refused", status: audit.status, body: audit.body };
  return { kind: "go", unapproved };
}
