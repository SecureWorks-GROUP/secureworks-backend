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
        : "Reconcile Drafts and Sent Items by the exact SES operation token; do not press SEND IT again.",
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
 * Exact-once execution. Only a newly inserted reservation can dispatch. Every
 * later call reconciles the original token and is structurally unable to call
 * dispatch again.
 */
export async function executeSesExternalEffect<TPayload, TResult>(args: {
  store: SesExternalEffectStore;
  effect: Omit<SesExternalEffect, "state">;
  payload: TPayload;
  adapter: SesExternalAdapter<TPayload, TResult>;
  actor: string;
}): Promise<SesExecuteEffectResult<TResult>> {
  const claim = await args.store.claim(args.effect, args.actor);
  if (claim.claim_mode === "confirmed") {
    return {
      state: "confirmed",
      effect: claim.effect,
      dispatched: false,
    };
  }

  if (claim.claim_mode === "reconcile") {
    const matches = await args.adapter.reconcile({
      external_token: claim.effect.external_token,
      operation_key: claim.effect.operation_key,
    });
    if (matches.length === 1) {
      const result = matches[0];
      const effect = await args.store.transition(
        claim.effect.operation_key,
        claim.effect.state,
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
  const preDispatchMatches = await args.adapter.reconcile({
    external_token: dispatching.external_token,
    operation_key: dispatching.operation_key,
  });
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
  try {
    await args.adapter.dispatch(args.payload, {
      external_token: dispatching.external_token,
      operation_key: dispatching.operation_key,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = await args.store.transition(
      dispatching.operation_key,
      "dispatching",
      "unknown",
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

  const matches = await args.adapter.reconcile({
    external_token: dispatching.external_token,
    operation_key: dispatching.operation_key,
  });
  if (matches.length !== 1) {
    const unknown = await args.store.transition(
      dispatching.operation_key,
      "dispatching",
      "unknown",
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
    dispatching.operation_key,
    "dispatching",
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
}
