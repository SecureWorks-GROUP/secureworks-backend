import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";

export type SesEffectKind =
  | "invoice_create"
  | "invoice_authorise"
  | "invoice_void"
  | "route_send"
  | "document_store"
  /** Ops-visibility ordinary mail to the work-order mailer (report|photo only). */
  | "mailer_ops_send"
  /** Captain's one Docs Ready SMS — exact-once per job per attendance cycle. */
  | "docs_ready_sms"
  /** KPI trade chase — exact-once per job per local day, internal trade phone only. */
  | "trade_chase_sms";
export type SesEffectState =
  | "reserved"
  | "dispatching"
  | "unknown"
  | "confirmed"
  | "failed"
  | "compensated";

export interface SesExternalEffect {
  id?: string;
  operation_key: string;
  org_id: string;
  job_id?: string | null;
  effect_kind: SesEffectKind;
  invoice_obligation_revision_id?: string | null;
  release_revision_id?: string | null;
  docket_revision_id?: string | null;
  route_kind?: "report" | "photo" | "invoice" | "report_invoice" | null;
  artifact_hash?: string | null;
  payload_hash: string;
  external_token: string;
  state: SesEffectState;
  /** Claim lease returned by claim_ses_external_effect_v1. */
  lease_owner?: string | null;
  /** Claim lease returned by claim_ses_external_effect_v1. */
  lease_expires_at?: string | null;
  external_id?: string | null;
  provider_digest?: Record<string, unknown>;
}

export interface SesEffectClaim {
  effect: SesExternalEffect;
  claim_mode: "dispatch" | "reconcile" | "confirmed";
  duplicate_refused: boolean;
}

export interface SesExternalEffectStore {
  claim(
    effect: Omit<SesExternalEffect, "state">,
    leaseOwner: string,
  ): Promise<SesEffectClaim>;
  transition(
    operationKey: string,
    from: SesEffectState,
    to: SesEffectState,
    eventKind: string,
    detail: Record<string, unknown>,
    actor: string,
  ): Promise<SesExternalEffect>;
  /**
   * Atomically lease an exact-token-absent route for redispatch. Implemented
   * by the real store as a conditional unknown|failed -> dispatching update;
   * a concurrent loser receives null and is structurally unable to send.
   */
  claimRedispatch?(
    effect: SesExternalEffect,
    leaseOwner: string,
    actor: string,
  ): Promise<SesExternalEffect | null>;
}

export interface SesExternalAdapter<TPayload, TResult> {
  dispatch(
    payload: TPayload,
    context: { external_token: string; operation_key: string },
  ): Promise<TResult>;
  reconcile(
    context: { external_token: string; operation_key: string },
  ): Promise<TResult[]>;
  identify(result: TResult): string;
  digest(result: TResult): Record<string, unknown>;
}

export interface SesExecuteEffectResult<TResult> {
  state: "confirmed" | "refused";
  effect: SesExternalEffect;
  result?: TResult;
  refusal?: SesRefusal;
  dispatched: boolean;
}

/**
 * A provider mutation was accepted, but the provider's read surface has not
 * exposed the exact operation proof yet. Callers must retain the operation as
 * outcome-unknown; treating this as an empty reconciliation result would allow
 * a second dispatch under the same frozen operation.
 */
export class SesExternalOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SesExternalOutcomeUnknownError";
  }
}

export async function buildSesEffect(args: {
  org_id: string;
  job_id?: string | null;
  effect_kind: SesEffectKind;
  invoice_obligation_revision_id?: string | null;
  release_revision_id?: string | null;
  docket_revision_id?: string | null;
  route_kind?: "report" | "photo" | "invoice" | "report_invoice" | null;
  artifact_hash?: string | null;
  payload: unknown;
}): Promise<Omit<SesExternalEffect, "state">> {
  // mailer_ops_send is keyed by job + report|photo + the caller's attempt hash
  // (no release revision). The attempt hash is the retry coordinate that
  // `release_revision_id` gives route_send: exact-once holds for one attempt,
  // and a deliberate new attempt mints a new operation_key instead of being
  // stranded behind a stuck `unknown` row. It must stay free of re-resolved
  // send content (see mailerOpsAttemptHash) — content drift belongs in
  // payload_hash, which reconciles the original effect rather than minting a
  // second email. Include job_id in the identity ONLY for that kind so
  // existing operation keys for invoice/release effects stay bit-stable.
  const identity = args.effect_kind === "mailer_ops_send"
    ? {
      effect_kind: args.effect_kind,
      job_id: args.job_id || null,
      invoice_obligation_revision_id: null,
      release_revision_id: null,
      docket_revision_id: null,
      route_kind: args.route_kind || null,
      artifact_hash: args.artifact_hash || null,
    }
    : {
      effect_kind: args.effect_kind,
      invoice_obligation_revision_id: args.invoice_obligation_revision_id ||
        null,
      release_revision_id: args.release_revision_id || null,
      docket_revision_id: args.docket_revision_id || null,
      route_kind: args.route_kind || null,
      artifact_hash: args.artifact_hash || null,
    };
  const identityHash = await sesSha256(
    identity,
    "SecureWorks:ses-external-effect-identity:v1\n",
  );
  const payloadHash = await sesSha256(
    args.payload,
    "SecureWorks:ses-external-effect-payload:v1\n",
  );
  return {
    operation_key: `ses:${args.effect_kind}:${
      stableUuidFromSha256(identityHash)
    }`,
    org_id: args.org_id,
    job_id: args.job_id || null,
    effect_kind: args.effect_kind,
    invoice_obligation_revision_id: args.invoice_obligation_revision_id || null,
    release_revision_id: args.release_revision_id || null,
    docket_revision_id: args.docket_revision_id || null,
    route_kind: args.route_kind || null,
    artifact_hash: args.artifact_hash || null,
    payload_hash: payloadHash,
    external_token: `SES-${stableUuidFromSha256(identityHash)}`,
  };
}

function unknownRefusal(
  kind: SesEffectKind,
  underlyingError?: string,
): SesRefusal {
  const detail = String(underlyingError || "").trim().slice(0, 400);
  const evidence = detail ? { underlying_error: detail } : undefined;
  if (kind === "route_send" || kind === "mailer_ops_send") {
    return sesRefusal(
      "graph_outcome_unknown",
      kind === "mailer_ops_send"
        ? "Reconcile admin@ Sent Items by the exact SES operation token; do not redispatch this mailer ops send."
        : "Retry the same frozen release. The exact SES operation token is reconciled before any missing route is redispatched, and a confirmed route is never sent again.",
      {
        ...(evidence ? { evidence } : {}),
        ...(detail
          ? {
            fact:
              `Microsoft Graph accepted or may have accepted the message, but its exact sent outcome is not yet proven. Underlying error: ${detail}`,
          }
          : {}),
      },
    );
  }
  if (kind === "invoice_void") {
    return sesRefusal(
      "xero_outcome_unknown",
      "Reconcile the exact invoice status in Xero; never issue the void a second time.",
      evidence ? { evidence } : {},
    );
  }
  return sesRefusal(
    "xero_outcome_unknown",
    "Reconcile Xero directly by the exact SES external token; do not create another invoice.",
    evidence ? { evidence } : {},
  );
}

/**
 * Record provider truth that was observed outside the current dispatch path.
 *
 * This is intentionally separate from executeSesExternalEffect: a legacy Xero
 * invoice may already be AUTHORISED before SES owns its effect ledger. Recovery
 * can reconcile that exact live identity and close the corresponding effect as
 * observed, but it must never call the provider's authorise operation again.
 */
export async function recordSesObservedExternalEffect(args: {
  store: SesExternalEffectStore;
  effect: Omit<SesExternalEffect, "state">;
  external_id: string;
  provider_digest?: Record<string, unknown>;
  actor: string;
}): Promise<SesExternalEffect> {
  const externalId = String(args.external_id || "").trim();
  if (!externalId) {
    throw new Error("observed external effect requires an external id");
  }
  if (args.effect.effect_kind !== "invoice_authorise") {
    throw new Error(
      "provider-observed reconciliation is reserved for invoice_authorise",
    );
  }
  const claim = await args.store.claim(
    args.effect,
    `${args.actor}:observed:${crypto.randomUUID()}`,
  );
  if (claim.effect.payload_hash !== args.effect.payload_hash) {
    throw new Error(
      "the observed external effect payload differs from the immutable ledger effect",
    );
  }
  if (claim.effect.state === "confirmed" || claim.claim_mode === "confirmed") {
    const priorExternalId = String(claim.effect.external_id || "").trim();
    if (priorExternalId && priorExternalId !== externalId) {
      throw new Error(
        "the confirmed external effect names a different provider identity",
      );
    }
    return claim.effect;
  }
  if (
    !["reserved", "dispatching", "unknown", "failed"].includes(
      claim.effect.state,
    )
  ) {
    throw new Error(
      `the observed external effect is in an unrecoverable state: ${claim.effect.state}`,
    );
  }
  return await args.store.transition(
    claim.effect.operation_key,
    claim.effect.state,
    "confirmed",
    "provider_observed_without_dispatch",
    {
      external_id: externalId,
      provider_digest: args.provider_digest || {},
    },
    args.actor,
  );
}

/**
 * Exact-once execution. A confirmed effect is structurally unable to dispatch
 * again. An uncertain route_send first wins an atomic per-operation lease,
 * because exact-token reconciliation may itself finish and send a checkpointed
 * Graph Draft; only that owner may reconcile or redispatch. Changed payload
 * hashes hard-refuse before either path. Money effects and ordinary mailer
 * sends remain read-only reconcile after their first dispatch attempt.
 */
export async function executeSesExternalEffect<TPayload, TResult>(args: {
  store: SesExternalEffectStore;
  effect: Omit<SesExternalEffect, "state">;
  payload: TPayload;
  adapter: SesExternalAdapter<TPayload, TResult>;
  actor: string;
}): Promise<SesExecuteEffectResult<TResult>> {
  const retainOutcomeUnknown = (
    active: SesExternalEffect,
    error: SesExternalOutcomeUnknownError,
  ): SesExecuteEffectResult<TResult> => {
    const message = String(error.message || "provider outcome unknown")
      .trim()
      .slice(0, 500);

    // SesExternalOutcomeUnknownError means Graph accepted a recovered Draft's
    // /send, but Sent Items has not exposed proof yet. Keep the already-durable
    // dispatching lease as the fence: unknown/failed are the redispatch entry
    // states, so transitioning there would let a later request fresh-send when
    // both Drafts and Sent Items are temporarily empty. A future
    // generation-safe reconciler may settle this lease; application retries
    // must remain read-only/refusing until then.
    return {
      state: "refused",
      effect: { ...active, failure: { message } } as SesExternalEffect,
      refusal: unknownRefusal(active.effect_kind, message),
      dispatched: true,
    };
  };

  const dispatchFrom = async (
    active: SesExternalEffect,
  ): Promise<SesExecuteEffectResult<TResult>> => {
    const uncertaintyState: SesEffectState = active.state === "unknown"
      ? "failed"
      : "unknown";
    try {
      await args.adapter.dispatch(args.payload, {
        external_token: active.external_token,
        operation_key: active.operation_key,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknown = await args.store.transition(
        active.operation_key,
        active.state,
        uncertaintyState,
        "dispatch_outcome_unknown",
        {
          failure: { message },
        },
        args.actor,
      );
      return {
        state: "refused",
        effect: { ...unknown, failure: { message } } as SesExternalEffect,
        refusal: unknownRefusal(unknown.effect_kind, message),
        dispatched: true,
      };
    }

    let matches: TResult[];
    try {
      matches = await args.adapter.reconcile({
        external_token: active.external_token,
        operation_key: active.operation_key,
      });
    } catch (error) {
      if (error instanceof SesExternalOutcomeUnknownError) {
        return retainOutcomeUnknown(active, error);
      }
      throw error;
    }
    if (matches.length !== 1) {
      const unknown = await args.store.transition(
        active.operation_key,
        active.state,
        uncertaintyState,
        "post_dispatch_reconcile_failed",
        { match_count: matches.length },
        args.actor,
      );
      return {
        state: "refused",
        effect: unknown,
        refusal: unknownRefusal(
          unknown.effect_kind,
          `post_dispatch_reconcile match_count=${matches.length}`,
        ),
        dispatched: true,
      };
    }
    const result = matches[0];
    const confirmed = await args.store.transition(
      active.operation_key,
      active.state,
      "confirmed",
      "provider_confirmed",
      {
        external_id: args.adapter.identify(result),
        provider_digest: args.adapter.digest(result),
      },
      args.actor,
    );
    return {
      state: "confirmed",
      effect: confirmed,
      result,
      dispatched: true,
    };
  };

  const claim = await args.store.claim(
    args.effect,
    `${args.actor}:${crypto.randomUUID()}`,
  );
  if (claim.effect.payload_hash !== args.effect.payload_hash) {
    return {
      state: "refused",
      effect: claim.effect,
      refusal: sesRefusal(
        "external_effect_payload_drift",
        "Reload the exact frozen operation payload and reconcile that stored operation; never dispatch changed caller bytes under its idempotency key.",
        {
          evidence: {
            operation_key: claim.effect.operation_key,
            stored_payload_hash: claim.effect.payload_hash,
            caller_payload_hash: args.effect.payload_hash,
          },
        },
      ),
      dispatched: false,
    };
  }
  if (claim.claim_mode === "confirmed") {
    return {
      state: "confirmed",
      effect: claim.effect,
      dispatched: false,
    };
  }

  if (claim.claim_mode === "reconcile") {
    const redispatchableRoute = claim.effect.effect_kind === "route_send" &&
      (claim.effect.state === "unknown" || claim.effect.state === "failed");
    if (redispatchableRoute) {
      // Graph reconciliation may finish a checkpointed Draft by uploading its
      // missing frozen attachments and sending it. It is therefore an external
      // dispatch, not a read-only probe, and must sit behind the same atomic
      // unknown|failed -> dispatching lease as a token-absent redispatch.
      if (!args.store.claimRedispatch) {
        return {
          state: "refused",
          effect: claim.effect,
          refusal: unknownRefusal(claim.effect.effect_kind),
          dispatched: false,
        };
      }
      const retry = await args.store.claimRedispatch(
        claim.effect,
        `${args.actor}:${crypto.randomUUID()}`,
        args.actor,
      );
      if (!retry) {
        return {
          state: "refused",
          effect: claim.effect,
          refusal: unknownRefusal(claim.effect.effect_kind),
          dispatched: false,
        };
      }
      let matches: TResult[];
      try {
        matches = await args.adapter.reconcile({
          external_token: retry.external_token,
          operation_key: retry.operation_key,
        });
      } catch (error) {
        if (error instanceof SesExternalOutcomeUnknownError) {
          return retainOutcomeUnknown(retry, error);
        }
        throw error;
      }
      if (matches.length === 1) {
        const result = matches[0];
        const effect = await args.store.transition(
          retry.operation_key,
          "dispatching",
          "confirmed",
          "reconciled_under_redispatch_lease",
          {
            external_id: args.adapter.identify(result),
            provider_digest: args.adapter.digest(result),
          },
          args.actor,
        );
        return { state: "confirmed", effect, result, dispatched: false };
      }
      if (matches.length > 1) {
        const unknown = await args.store.transition(
          retry.operation_key,
          "dispatching",
          "unknown",
          "redispatch_reconcile_ambiguous",
          { match_count: matches.length },
          args.actor,
        );
        return {
          state: "refused",
          effect: unknown,
          refusal: unknownRefusal(
            unknown.effect_kind,
            `redispatch reconcile match_count=${matches.length}`,
          ),
          dispatched: false,
        };
      }
      return await dispatchFrom(retry);
    }

    // A route already carrying a dispatching lease belongs to another active
    // or crashed worker. Reconciliation can send a checkpointed Graph draft,
    // so a non-owner must make no provider call. Unknown/failed is the only
    // application-level redispatch entry and acquires a fresh atomic lease
    // above; confirmed was handled before this branch.
    if (claim.effect.effect_kind === "route_send") {
      return {
        state: "refused",
        effect: claim.effect,
        refusal: unknownRefusal(claim.effect.effect_kind),
        dispatched: false,
      };
    }

    const matches = await args.adapter.reconcile({
      external_token: claim.effect.external_token,
      operation_key: claim.effect.operation_key,
    });
    if (matches.length === 1) {
      const result = matches[0];
      const confirmable = claim.effect.state === "reserved"
        ? await args.store.transition(
          claim.effect.operation_key,
          "reserved",
          "dispatching",
          "reconcile_reserved_effect",
          {},
          args.actor,
        )
        : claim.effect;
      const effect = await args.store.transition(
        confirmable.operation_key,
        confirmable.state,
        "confirmed",
        "reconciled",
        {
          external_id: args.adapter.identify(result),
          provider_digest: args.adapter.digest(result),
        },
        args.actor,
      );
      return { state: "confirmed", effect, result, dispatched: false };
    }
    return {
      state: "refused",
      effect: claim.effect,
      refusal: unknownRefusal(claim.effect.effect_kind),
      dispatched: false,
    };
  }

  const dispatching = await args.store.transition(
    claim.effect.operation_key,
    "reserved",
    "dispatching",
    "dispatch_started",
    {},
    args.actor,
  );
  let preDispatchMatches: TResult[];
  try {
    preDispatchMatches = await args.adapter.reconcile({
      external_token: dispatching.external_token,
      operation_key: dispatching.operation_key,
    });
  } catch (error) {
    if (error instanceof SesExternalOutcomeUnknownError) {
      return retainOutcomeUnknown(dispatching, error);
    }
    throw error;
  }
  if (preDispatchMatches.length === 1) {
    const result = preDispatchMatches[0];
    const confirmed = await args.store.transition(
      dispatching.operation_key,
      "dispatching",
      "confirmed",
      "pre_dispatch_reconciled",
      {
        external_id: args.adapter.identify(result),
        provider_digest: args.adapter.digest(result),
      },
      args.actor,
    );
    return {
      state: "confirmed",
      effect: confirmed,
      result,
      dispatched: false,
    };
  }
  if (preDispatchMatches.length > 1) {
    const unknown = await args.store.transition(
      dispatching.operation_key,
      "dispatching",
      "unknown",
      "pre_dispatch_reconcile_ambiguous",
      { match_count: preDispatchMatches.length },
      args.actor,
    );
    return {
      state: "refused",
      effect: unknown,
      refusal: unknownRefusal(unknown.effect_kind),
      dispatched: false,
    };
  }
  return await dispatchFrom(dispatching);
}
