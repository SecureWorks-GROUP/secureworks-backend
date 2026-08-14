/**
 * T11 (Harden SES v1, trace T11 / AC5 / AC6 / AC7): ONE unified authorise+send
 * orchestration over the EXISTING guarded primitives.
 *
 * Today authorise and send are two operator calls (`execute_ses_invoice_revision`
 * then `execute_ses_release_revision`), and a partial send leaves the release
 * `dispatching`. This action stitches them into the Captain's atomic shape for a
 * single explicitly-approved exact release revision:
 *
 *   validate the frozen fingerprint
 *     -> authorise each priced member's DRAFT invoice (reuse execute_ses_invoice_revision)
 *     -> dispatch the frozen release (reuse execute_ses_release_revision)
 *     -> record/reconcile the per-route typed effects (the existing ledger does this)
 *
 * Behaviour it guarantees:
 *   - AC5: if invoice authorisation fails, NOTHING is sent (the release primitive
 *     is never reached).
 *   - AC6: on partial delivery failure the release is RETAINED as Approved (never
 *     left `dispatching`), and a retry re-runs ONLY the missing routes through the
 *     existing exact-once `(release_revision_id, route_kind)` effect ledger.
 *     Confirmed routes are never re-sent.
 *   - AC7: content drift / stale or unapproved revision is a HARD refuse; a word
 *     for docket A can never release docket B or a stale revision.
 *
 * It REIMPLEMENTS neither authorise, nor send, nor the exact-once ledger. It is
 * thin orchestration over injected primitives, so its control flow (which is the
 * only new logic) is unit-testable without the full DB. Routine keys are denied
 * (mirrors the underlying execute deny; the action is also absent from the
 * central routine allow-list).
 */
import type {
  SesActionAuth,
  SesMailGateway,
  SesReleaseXeroReader,
  SesSupabaseClient,
  SesXeroGateway,
} from "./ses_reporting_actions.ts";
import {
  executeSesInvoiceRevisionAction,
  executeSesReleaseRevisionAction,
  SesActionError,
} from "./ses_reporting_actions.ts";
import {
  isSesRefusal,
  type SesRefusal,
  sesRefusal,
} from "./ses_reporting_refusals.ts";

type Refusal = SesRefusal | { state: "refused"; fact: string };

export interface UnifiedReleaseMember {
  job_id: string;
  invoice_obligation_revision_id: string | null;
  docket_revision_id: string;
  /** `no_additional_charge` members have no invoice to authorise. */
  pricing_disposition: string | null;
}

export interface UnifiedReleaseSnapshot {
  release_revision_id: string;
  content_hash: string;
  state: string;
  members: UnifiedReleaseMember[];
  required_route_kinds: string[];
}

export type UnifiedReleaseExecuteResult =
  | { kind: "released"; result: unknown }
  | { kind: "failed"; status: number; refusal: Refusal };

export interface UnifiedReleaseDeps {
  loadRelease(
    releaseRevisionId: string,
  ): Promise<UnifiedReleaseSnapshot | null>;
  authoriseMemberInvoice(
    member: UnifiedReleaseMember,
  ): Promise<
    | { ok: true; result: unknown }
    | { ok: false; status: number; refusal: Refusal }
  >;
  executeRelease(
    releaseRevisionId: string,
  ): Promise<UnifiedReleaseExecuteResult>;
  readConfirmedRouteKinds(releaseRevisionId: string): Promise<string[]>;
  /** Compare-and-set the release back to Approved from `dispatching` (AC6). */
  retainApproved(releaseRevisionId: string): Promise<void>;
}

export type UnifiedReleaseOutcome =
  | {
    state: "released";
    release_revision_id: string;
    invoice_authorisations: Array<{ job_id: string; result: unknown }>;
    release: unknown;
  }
  | {
    state: "approved_retained";
    release_revision_id: string;
    partial_delivery: true;
    retryable: true;
    confirmed_route_kinds: string[];
    pending_route_kinds: string[];
    refusal: Refusal;
  };

/**
 * A release-execute failure that DID deliver, or MIGHT have delivered, some
 * routes is retryable (retain Approved, re-run only the missing routes). A
 * failure that dispatched nothing and is not a transport-uncertain outcome is a
 * hard refuse (stale/drift/recipient/signoff/approval).
 */
const UNIFIED_DELIVERY_RETRYABLE_CODES = new Set([
  "graph_outcome_unknown",
  "route_send_proof_unreadable",
]);

/**
 * PURE classifier over route-proof progress + the refusal code. Kept pure so the
 * partial-vs-hard decision (the heart of AC6/AC7) is unit-tested directly.
 */
export function classifyUnifiedReleaseFailure(input: {
  refusal_code?: string | null;
  confirmed_before: number;
  confirmed_after: number;
  required_count: number;
}): "partial_delivery" | "hard_refuse" {
  const progressed = input.confirmed_after > input.confirmed_before;
  const allConfirmed = input.required_count > 0 &&
    input.confirmed_after >= input.required_count;
  if (progressed || allConfirmed) return "partial_delivery";
  if (
    input.refusal_code &&
    UNIFIED_DELIVERY_RETRYABLE_CODES.has(input.refusal_code)
  ) {
    return "partial_delivery";
  }
  return "hard_refuse";
}

function str(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The orchestration proper, over injected primitives. Returns `released` (full
 * success) or `approved_retained` (partial delivery, retryable); throws
 * `SesActionError` for AC5 invoice-authorise failure, AC7 drift/stale/unapproved,
 * and routine-key denial.
 */
export async function runUnifiedSesRelease(
  auth: SesActionAuth,
  args: {
    release_revision_id: string;
    expected_release_content_hash?: string | null;
  },
  deps: UnifiedReleaseDeps,
): Promise<UnifiedReleaseOutcome> {
  // Mirror execute_ses_release_revision: the automation routine can never send.
  if (auth.mode === "routine") {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The make-safe automation key cannot execute a unified authorise-and-send release.",
    });
  }
  if (!args.release_revision_id) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "release_revision_id required",
    });
  }
  const release = await deps.loadRelease(args.release_revision_id);
  if (!release) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The approved release revision no longer exists.",
    });
  }
  // AC7: validate the frozen fingerprint before any side effect.
  const expectedHash = str(args.expected_release_content_hash);
  if (expectedHash && expectedHash !== release.content_hash) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Re-open the current release and SEND IT the exact revision on screen; its content changed since it was inspected.",
        {
          fact:
            "The echoed release content hash does not match the stored release revision.",
          evidence: {
            expected: expectedHash,
            actual: release.content_hash,
          },
        },
      ),
    );
  }
  // Only an explicitly approved (or already in-flight) release may be released.
  if (
    !["approved", "dispatching", "released"].includes(
      String(release.state || "").toLowerCase(),
    )
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "release_approval_missing",
        "Approve the exact release revision (approve_ses_release_revision) before the unified release.",
        {
          fact:
            `The release revision is in state '${release.state}', not an approved state.`,
        },
      ),
    );
  }

  // AC5: authorise each priced member's DRAFT invoice FIRST. If any fails, the
  // release primitive is never called, so nothing is sent.
  const invoiceAuthorisations: Array<{ job_id: string; result: unknown }> = [];
  for (const member of release.members) {
    if (
      String(member.pricing_disposition || "").toLowerCase() ===
        "no_additional_charge"
    ) {
      continue;
    }
    const authd = await deps.authoriseMemberInvoice(member);
    if (!authd.ok) {
      throw new SesActionError(authd.status, authd.refusal);
    }
    invoiceAuthorisations.push({ job_id: member.job_id, result: authd.result });
  }

  // Dispatch the frozen release via the existing execute primitive.
  const confirmedBefore = await deps.readConfirmedRouteKinds(
    args.release_revision_id,
  );
  const exec = await deps.executeRelease(args.release_revision_id);
  if (exec.kind === "released") {
    return {
      state: "released",
      release_revision_id: args.release_revision_id,
      invoice_authorisations: invoiceAuthorisations,
      release: exec.result,
    };
  }

  // Failed: classify partial-vs-hard from route-proof progress + the code.
  const confirmedAfter = await deps.readConfirmedRouteKinds(
    args.release_revision_id,
  );
  const classification = classifyUnifiedReleaseFailure({
    refusal_code: (exec.refusal as SesRefusal)?.code,
    confirmed_before: confirmedBefore.length,
    confirmed_after: confirmedAfter.length,
    required_count: release.required_route_kinds.length,
  });
  // AC6: never leave the release stuck at `dispatching`. Retain Approved so the
  // board shows a retryable release; a retry re-runs only the missing routes.
  await deps.retainApproved(args.release_revision_id);

  if (classification === "partial_delivery") {
    const confirmedSet = new Set(confirmedAfter);
    const pending = release.required_route_kinds.filter(
      (kind) => !confirmedSet.has(kind),
    );
    return {
      state: "approved_retained",
      release_revision_id: args.release_revision_id,
      partial_delivery: true,
      retryable: true,
      confirmed_route_kinds: confirmedAfter,
      pending_route_kinds: pending,
      refusal: exec.refusal,
    };
  }
  // AC7 hard refuse: propagate the release primitive's own refusal.
  throw new SesActionError(exec.status, exec.refusal);
}

/**
 * Real-wiring factory: build `UnifiedReleaseDeps` bound to the live client and
 * the guarded execute primitives. index.ts calls `unifiedSesReleaseAction` with
 * the same gateways `execute_ses_invoice_revision` and
 * `execute_ses_release_revision` use, so this adds NO new money or send engine.
 */
export function createSupabaseUnifiedReleaseDeps(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  ctx: {
    org_id: string;
    actor: string;
    xeroGateway: SesXeroGateway;
    mailGateway: SesMailGateway;
    releaseXeroReader: SesReleaseXeroReader;
  },
): UnifiedReleaseDeps {
  const failureFromError = (
    error: unknown,
  ): { status: number; refusal: Refusal } => {
    // Extract the ACTUAL refusal (with its `.code`) so the failure classifier
    // can read the transport-uncertain codes. `sesActionErrorResponse` wraps the
    // refusal under `body.refusal`, which would hide `.code` from the classifier.
    if (error instanceof SesActionError) {
      return { status: error.status, refusal: error.refusal };
    }
    if (isSesRefusal(error)) {
      return { status: 409, refusal: error };
    }
    throw error;
  };
  return {
    async loadRelease(releaseRevisionId) {
      const releaseResp = await client.from("makesafe_release_revisions")
        .select("id,content_hash,state").eq("id", releaseRevisionId)
        .maybeSingle();
      if (releaseResp.error || !releaseResp.data) return null;
      const [membersResp, routesResp] = await Promise.all([
        client.from("makesafe_release_revision_members")
          .select(
            "job_id,docket_revision_id,invoice_obligation_revision_id,ordinal",
          )
          .eq("release_revision_id", releaseRevisionId).order("ordinal"),
        client.from("makesafe_release_revision_routes")
          .select("route_kind,required,ordinal")
          .eq("release_revision_id", releaseRevisionId).order("ordinal"),
      ]);
      if (membersResp.error || routesResp.error) return null;
      const members = membersResp.data || [];
      const obligationIds = [
        ...new Set(
          members
            .map((row: Record<string, unknown>) =>
              str(row.invoice_obligation_revision_id)
            )
            .filter((id: string | null): id is string => !!id),
        ),
      ];
      const dispositionById = new Map<string, string>();
      if (obligationIds.length > 0) {
        const oblResp = await client.from(
          "makesafe_invoice_obligation_revisions",
        ).select("id,pricing_disposition").in("id", obligationIds);
        for (const row of oblResp.data || []) {
          dispositionById.set(
            String(row.id),
            String(row.pricing_disposition || ""),
          );
        }
      }
      return {
        release_revision_id: releaseRevisionId,
        content_hash: String(releaseResp.data.content_hash || ""),
        state: String(releaseResp.data.state || ""),
        members: members.map((row: Record<string, unknown>) => {
          const obligationId = str(row.invoice_obligation_revision_id);
          return {
            job_id: String(row.job_id || ""),
            invoice_obligation_revision_id: obligationId,
            docket_revision_id: String(row.docket_revision_id || ""),
            pricing_disposition: obligationId
              ? dispositionById.get(obligationId) ?? null
              : null,
          };
        }),
        required_route_kinds: (routesResp.data || [])
          .filter((row: Record<string, unknown>) => row.required !== false)
          .map((row: Record<string, unknown>) => String(row.route_kind || ""))
          .filter((kind: string) => kind.length > 0),
      };
    },
    async authoriseMemberInvoice(member) {
      if (!member.invoice_obligation_revision_id) {
        return {
          ok: false,
          status: 409,
          refusal: sesRefusal(
            "invoice_approval_missing",
            "Prepare and approve the invoice obligation for this member before the unified release.",
            {
              fact:
                "A priced release member has no invoice obligation revision to authorise.",
              evidence: { job_id: member.job_id },
            },
          ),
        };
      }
      try {
        const result = await executeSesInvoiceRevisionAction(
          client,
          auth,
          {
            org_id: ctx.org_id,
            job_id: member.job_id,
            invoice_obligation_revision_id:
              member.invoice_obligation_revision_id,
            actor: ctx.actor,
          },
          ctx.xeroGateway,
        );
        return { ok: true, result };
      } catch (error) {
        return { ok: false, ...failureFromError(error) };
      }
    },
    async executeRelease(releaseRevisionId) {
      try {
        const result = await executeSesReleaseRevisionAction(
          client,
          auth,
          {
            org_id: ctx.org_id,
            release_revision_id: releaseRevisionId,
            actor: ctx.actor,
          },
          ctx.mailGateway,
          ctx.releaseXeroReader,
        );
        return { kind: "released", result };
      } catch (error) {
        const mapped = failureFromError(error);
        return {
          kind: "failed",
          status: mapped.status,
          refusal: mapped.refusal,
        };
      }
    },
    async readConfirmedRouteKinds(releaseRevisionId): Promise<string[]> {
      const resp = await client.from("ses_release_route_proofs")
        .select("route_kind").eq("release_revision_id", releaseRevisionId);
      if (resp.error) return [];
      const kinds: string[] = (resp.data || [])
        .map((row: Record<string, unknown>) => String(row.route_kind || ""))
        .filter((kind: string) => kind.length > 0);
      return [...new Set<string>(kinds)];
    },
    async retainApproved(releaseRevisionId) {
      // CAS: only a `dispatching` release is put back to `approved`; a fully
      // released or already-approved row is left untouched.
      await client.from("makesafe_release_revisions")
        .update({ state: "approved", updated_at: new Date().toISOString() })
        .eq("id", releaseRevisionId).eq("state", "dispatching");
    },
  };
}

export async function unifiedSesReleaseAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    expected_release_content_hash?: string | null;
    actor: string;
  },
  ctx: {
    xeroGateway: SesXeroGateway;
    mailGateway: SesMailGateway;
    releaseXeroReader: SesReleaseXeroReader;
  },
): Promise<UnifiedReleaseOutcome> {
  const deps = createSupabaseUnifiedReleaseDeps(client, auth, {
    org_id: args.org_id,
    actor: args.actor,
    xeroGateway: ctx.xeroGateway,
    mailGateway: ctx.mailGateway,
    releaseXeroReader: ctx.releaseXeroReader,
  });
  return await runUnifiedSesRelease(
    auth,
    {
      release_revision_id: args.release_revision_id,
      expected_release_content_hash: args.expected_release_content_hash,
    },
    deps,
  );
}
