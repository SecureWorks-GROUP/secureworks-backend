/**
 * T11 (Harden SES v1, trace T11 / AC5 / AC6 / AC7): ONE unified authorise+send
 * orchestration over the EXISTING guarded primitives.
 *
 * The operator approves one exact DRAFT pack. This action implements the
 * Captain's code-only Option B ordering, treating that approval as
 * pre-ratification of only its deterministic AUTHORISED derivative:
 *
 *   validate the approved DRAFT fingerprint
 *     -> authorise each priced member's DRAFT invoice
 *     -> verify and bind the deterministic AUTHORISED derivative
 *     -> mint and approve the final AUTHORISED release
 *     -> dispatch that frozen final release
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
 * It REIMPLEMENTS neither authorise, nor send, nor the exact-once ledger. It
 * composes the guarded actions and verifies the derivative at both the docket
 * and route-envelope boundaries. Routine keys are denied
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
  approveSesInvoiceRevisionAction,
  approveSesReleaseRevisionAction,
  assertSesReleaseRevisionIsCurrent,
  bindAuthorisedInvoicePdfToDocket,
  buildSesReleaseRevisionPlanForDockets,
  commitSesReleaseRevisionPlanAction,
  executeSesInvoiceRevisionAction,
  executeSesReleaseRevisionAction,
  loadSesCockpitDocket,
  loadStoredSesXeroInvoicePdfBytes,
  ratifySesAuthorisedDerivativeDocketAction,
  SesActionError,
  type SesXeroInvoiceResult,
} from "./ses_reporting_actions.ts";
import type { SesReviewRoute } from "./ses_review_cockpit.ts";
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
  readiness_revision?: string;
  dependency_generation?: number;
}

export interface UnifiedReleaseSnapshot {
  release_revision_id: string;
  content_hash: string;
  state: string;
  members: UnifiedReleaseMember[];
  required_route_kinds: string[];
}

export interface UnifiedReleaseMaterialisation {
  release: UnifiedReleaseSnapshot;
  invoice_authorisations: Array<{ job_id: string; result: unknown }>;
  source_release_revision_id: string;
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
  /** Compare-and-set and verify Approved from `dispatching` (AC6). */
  retainApproved(releaseRevisionId: string): Promise<void>;
  /**
   * Human-JWT-only Option B path. The inspected DRAFT release is never approved
   * or dispatched: it pre-ratifies a verified AUTHORISED derivative, which this
   * hook materialises as a distinct final release after the invoice bind.
   */
  materializeAuthorisedDerivative?(
    release: UnifiedReleaseSnapshot,
  ): Promise<UnifiedReleaseMaterialisation>;
}

export type UnifiedReleaseOutcome =
  | {
    state: "released";
    release_revision_id: string;
    source_release_revision_id?: string;
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
 * Only an explicitly transport-uncertain failure is retryable. Route progress
 * never downgrades stale/drift/recipient/signoff/approval impossibilities into
 * a soft retry.
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
    expected_release_content_hash: string;
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
  const expectedHash = str(args.expected_release_content_hash);
  if (!expectedHash) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "expected_release_content_hash required; execute the exact release revision that was inspected.",
    });
  }
  let release = await deps.loadRelease(args.release_revision_id);
  if (!release) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The approved release revision no longer exists.",
    });
  }
  // AC7: validate the frozen fingerprint before any side effect.
  if (expectedHash !== release.content_hash) {
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
  const selectedState = String(release.state || "").toLowerCase();
  const canAttemptSupersededOptionBRecovery = selectedState === "superseded" &&
    auth.mode === "jwt" && !!auth.user &&
    !!deps.materializeAuthorisedDerivative;
  if (selectedState === "superseded" && !canAttemptSupersededOptionBRecovery) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Re-open the current release and approve and send its exact revision; this release was superseded by a newer revision.",
        {
          fact:
            "The selected release revision is superseded and is no longer executable.",
          evidence: { release_revision_id: release.release_revision_id },
        },
      ),
    );
  }
  let activeReleaseRevisionId = args.release_revision_id;
  let sourceReleaseRevisionId: string | undefined;
  let invoiceAuthorisations: Array<{ job_id: string; result: unknown }> = [];
  const releaseState = String(release.state || "").toLowerCase();
  if (releaseState === "proposed" || canAttemptSupersededOptionBRecovery) {
    if (auth.mode !== "jwt" || !auth.user) {
      throw new SesActionError(403, {
        state: "refused",
        fact:
          "A proposed DRAFT release can be approved and sent only by the identified human operator who inspected it.",
      });
    }
    if (!deps.materializeAuthorisedDerivative) {
      throw new SesActionError(
        409,
        sesRefusal(
          "release_approval_missing",
          "Use the real unified APPROVE & SEND action to materialise the verified AUTHORISED derivative.",
        ),
      );
    }
    const materialized = await deps.materializeAuthorisedDerivative(release);
    release = materialized.release;
    activeReleaseRevisionId = release.release_revision_id;
    sourceReleaseRevisionId = materialized.source_release_revision_id;
    invoiceAuthorisations = materialized.invoice_authorisations;
  }
  // Only an explicitly approved (or already in-flight) AUTHORISED release may
  // be dispatched. A proposed release reaches here only after Option B minted
  // and separately approved its post-authorisation derivative.
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
  if (!sourceReleaseRevisionId) {
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
      invoiceAuthorisations.push({
        job_id: member.job_id,
        result: authd.result,
      });
    }
  }

  // Dispatch the frozen release via the existing execute primitive.
  const confirmedBefore = await deps.readConfirmedRouteKinds(
    activeReleaseRevisionId,
  );
  let exec: UnifiedReleaseExecuteResult;
  try {
    exec = await deps.executeRelease(activeReleaseRevisionId);
  } catch (error) {
    await retainApprovedOrThrow(
      deps,
      activeReleaseRevisionId,
      error,
    );
    throw asUnifiedReleaseError(error);
  }
  if (exec.kind === "released") {
    return {
      state: "released",
      release_revision_id: activeReleaseRevisionId,
      ...(sourceReleaseRevisionId
        ? { source_release_revision_id: sourceReleaseRevisionId }
        : {}),
      invoice_authorisations: invoiceAuthorisations,
      release: exec.result,
    };
  }

  // Failed: classify partial-vs-hard from route-proof progress + the code.
  let confirmedAfter: string[];
  try {
    confirmedAfter = await deps.readConfirmedRouteKinds(
      activeReleaseRevisionId,
    );
  } catch (error) {
    await retainApprovedOrThrow(
      deps,
      activeReleaseRevisionId,
      error,
    );
    throw asUnifiedReleaseError(error);
  }
  const classification = classifyUnifiedReleaseFailure({
    refusal_code: (exec.refusal as SesRefusal)?.code,
    confirmed_before: confirmedBefore.length,
    confirmed_after: confirmedAfter.length,
    required_count: release.required_route_kinds.length,
  });
  // AC6: never leave the release stuck at `dispatching`. Retain Approved so the
  // board shows a retryable release; a retry re-runs only the missing routes.
  await retainApprovedOrThrow(
    deps,
    activeReleaseRevisionId,
    exec.refusal,
  );

  if (classification === "partial_delivery") {
    const confirmedSet = new Set(confirmedAfter);
    const pending = release.required_route_kinds.filter(
      (kind) => !confirmedSet.has(kind),
    );
    return {
      state: "approved_retained",
      release_revision_id: activeReleaseRevisionId,
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

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 400);
}

function asUnifiedReleaseError(error: unknown): SesActionError {
  if (error instanceof SesActionError) return error;
  if (isSesRefusal(error)) return new SesActionError(409, error);
  return new SesActionError(500, {
    state: "refused",
    fact:
      `The unified release failed unexpectedly and was returned to Approved: ${
        errorMessage(error)
      }`,
  });
}

async function retainApprovedOrThrow(
  deps: UnifiedReleaseDeps,
  releaseRevisionId: string,
  originalFailure: unknown,
): Promise<void> {
  try {
    await deps.retainApproved(releaseRevisionId);
    return;
  } catch (firstRetentionError) {
    // A transient PostgREST failure must not strand the row in dispatching.
    // Retry the same idempotent CAS once; the real implementation verifies the
    // resulting state, so success here is evidence, not an ignored write.
    try {
      await deps.retainApproved(releaseRevisionId);
      return;
    } catch (retentionError) {
      throw new SesActionError(500, {
        state: "refused",
        fact:
          `The release failed and its Approved-state recovery could not be verified. Original failure: ${
            errorMessage(originalFailure)
          }. First recovery failure: ${
            errorMessage(firstRetentionError)
          }. Recovery failure: ${errorMessage(retentionError)}`,
      });
    }
  }
}

interface StoredUnifiedRoute {
  route_kind: SesReviewRoute["route_kind"];
  recipients: string[];
  cc?: string[];
  subject: string;
  body: string;
  attachment_hashes: string[];
}

interface AuthorisedRouteSubstitution {
  draft_invoice: SesXeroInvoiceResult;
  authorised_invoice: SesXeroInvoiceResult;
  draft_pdf_content_hash: string;
  authorised_pdf_content_hash: string;
}

const OPTION_B_RECOVERY_CONTRACT = "ses-unified-option-b-recovery/v1" as const;

interface OptionBRecoveryCapsule {
  kind: typeof OPTION_B_RECOVERY_CONTRACT;
  source_release_revision_id: string;
  source_release_content_hash: string;
  job_id: string;
  source_docket_revision_id: string;
  invoice_obligation_revision_id: string;
  draft_invoice: SesXeroInvoiceResult;
  draft_pdf: {
    pdf_object_key: string;
    pdf_content_hash: string;
    pdf_size_bytes: number;
  };
}

type BoundAuthorisedInvoiceResult = Awaited<
  ReturnType<typeof bindAuthorisedInvoicePdfToDocket>
>;

interface OptionBAuthorisedMemberResult {
  state: string;
  invoice: SesXeroInvoiceResult;
  docket_revision: Record<string, unknown>;
  draft_pdf_content_hash: string | null;
  authorised_pdf_content_hash: string;
  authorised_derivative:
    | BoundAuthorisedInvoiceResult["authorised_derivative"]
    | null;
  invoice_create_dispatched: boolean;
  invoice_authorise_dispatched: boolean;
  send_dispatched: boolean;
  recovery?: boolean;
}

function optionBRecoveryCapsule(value: unknown): OptionBRecoveryCapsule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const invoice = candidate.draft_invoice &&
      typeof candidate.draft_invoice === "object" &&
      !Array.isArray(candidate.draft_invoice)
    ? candidate.draft_invoice as Record<string, unknown>
    : null;
  const pdf = candidate.draft_pdf && typeof candidate.draft_pdf === "object" &&
      !Array.isArray(candidate.draft_pdf)
    ? candidate.draft_pdf as Record<string, unknown>
    : null;
  if (
    candidate.kind !== OPTION_B_RECOVERY_CONTRACT ||
    !str(candidate.source_release_revision_id) ||
    !str(candidate.source_release_content_hash) ||
    !str(candidate.job_id) ||
    !str(candidate.source_docket_revision_id) ||
    !str(candidate.invoice_obligation_revision_id) ||
    !invoice ||
    String(invoice.status || "").toUpperCase() !== "DRAFT" ||
    !str(invoice.xero_invoice_id) ||
    !str(invoice.invoice_number) ||
    !str(invoice.reference) ||
    !Number.isFinite(Number(invoice.total)) ||
    !pdf ||
    !str(pdf.pdf_object_key) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(pdf.pdf_content_hash || "")) ||
    !Number.isFinite(Number(pdf.pdf_size_bytes)) ||
    Number(pdf.pdf_size_bytes) <= 0
  ) {
    return null;
  }
  return candidate as unknown as OptionBRecoveryCapsule;
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * Build the only allowed post-authorisation route derivative. Recipients, CC,
 * bodies, route set and every non-invoice artifact remain byte-for-byte frozen;
 * only the exact DRAFT PDF hash and the deterministic status/number text in the
 * subject may change.
 */
export function deriveSesAuthorisedReleaseRoutes(
  sourceRoutes: StoredUnifiedRoute[],
  substitutions: AuthorisedRouteSubstitution[],
): SesReviewRoute[] {
  const seenDraftHashes = new Set<string>();
  const derived = sourceRoutes.map((route) => {
    let subject = String(route.subject || "");
    const attachmentHashes = (route.attachment_hashes || []).map((hash) => {
      const substitution = substitutions.find((item) =>
        item.draft_pdf_content_hash === hash
      );
      if (!substitution) return hash;
      seenDraftHashes.add(hash);
      return substitution.authorised_pdf_content_hash;
    });
    for (const substitution of substitutions) {
      const draftNumber = String(
        substitution.draft_invoice.invoice_number || "",
      );
      const authorisedNumber = String(
        substitution.authorised_invoice.invoice_number || "",
      );
      if (draftNumber) {
        subject = subject.replaceAll(draftNumber, authorisedNumber);
      }
    }
    subject = subject.replaceAll("Xero draft", "Xero invoice");
    return {
      route_kind: route.route_kind,
      recipients: [...(route.recipients || [])],
      cc: [...(route.cc || [])],
      subject,
      body: String(route.body || ""),
      attachment_hashes: attachmentHashes,
      ready: true,
    };
  });
  const missing = substitutions.filter((item) =>
    !seenDraftHashes.has(item.draft_pdf_content_hash)
  );
  if (missing.length > 0) {
    throw new SesActionError(
      409,
      sesRefusal(
        "authorised_derivative_mismatch",
        "Do not send. Re-open the DRAFT pack: its exact invoice PDF was not frozen into the reviewed release.",
        {
          fact:
            "The proposed release routes do not contain every approved DRAFT PDF hash.",
          evidence: {
            missing_draft_pdf_content_hashes: missing.map((item) =>
              item.draft_pdf_content_hash
            ),
          },
        },
      ),
    );
  }
  return derived;
}

/** Fail closed if canonical post-bind preparation changed anything else. */
export function assertSesAuthorisedReleaseRouteDerivative(
  expected: SesReviewRoute[],
  actual: Array<Record<string, unknown>>,
): void {
  const actualShape = actual.map((route) => ({
    route_kind: route.route_kind,
    recipients: route.recipients || [],
    cc: route.cc || [],
    subject: route.subject,
    body: route.body,
    attachment_hashes: route.attachment_hashes || [],
  }));
  const expectedShape = expected.map((route) => ({
    route_kind: route.route_kind,
    recipients: route.recipients,
    cc: route.cc || [],
    subject: route.subject,
    body: route.body,
    attachment_hashes: route.attachment_hashes,
  }));
  if (!sameJson(actualShape, expectedShape)) {
    throw new SesActionError(
      409,
      sesRefusal(
        "authorised_derivative_mismatch",
        "Do not send. The post-authorisation release changed beyond the verified invoice status, number, and AUTHORISED PDF hash.",
        {
          fact:
            "The canonical AUTHORISED release envelope is not the deterministic derivative of the approved DRAFT release.",
        },
      ),
    );
  }
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
  const loadReleaseSnapshot = async (
    releaseRevisionId: string,
  ): Promise<UnifiedReleaseSnapshot | null> => {
    const releaseResp = await client.from("makesafe_release_revisions")
      .select("id,content_hash,state,readiness_bindings")
      .eq("id", releaseRevisionId)
      .maybeSingle();
    if (releaseResp.error || !releaseResp.data) return null;
    // A superseded row is normally non-executable, but a proposed Option B
    // source can be superseded by a partly-prepared multi-member derivative
    // that shares a no-charge member. Return its immutable snapshot so the
    // unified layer can attempt the narrowly proven already-bound recovery.
    // Every other state still passes the ordinary currentness guard here.
    if (String(releaseResp.data.state || "").toLowerCase() !== "superseded") {
      try {
        await assertSesReleaseRevisionIsCurrent(client, releaseRevisionId);
      } catch (error) {
        if (error instanceof SesActionError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }
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
    const readinessByJobId = new Map<string, {
      readiness_revision: string;
      dependency_generation: number;
    }>();
    for (
      const binding of Array.isArray(releaseResp.data.readiness_bindings)
        ? releaseResp.data.readiness_bindings
        : []
    ) {
      readinessByJobId.set(String(binding.job_id || ""), {
        readiness_revision: String(binding.readiness_revision || ""),
        dependency_generation: Number(binding.dependency_generation),
      });
    }
    if (obligationIds.length > 0) {
      const oblResp = await client.from(
        "makesafe_invoice_obligation_revisions",
      ).select("id,pricing_disposition").in("id", obligationIds);
      if (oblResp.error) return null;
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
        const readiness = readinessByJobId.get(String(row.job_id || ""));
        return {
          job_id: String(row.job_id || ""),
          invoice_obligation_revision_id: obligationId,
          docket_revision_id: String(row.docket_revision_id || ""),
          pricing_disposition: obligationId
            ? dispositionById.get(obligationId) ?? null
            : null,
          readiness_revision: readiness?.readiness_revision || "",
          dependency_generation: readiness?.dependency_generation,
        };
      }),
      required_route_kinds: (routesResp.data || [])
        .filter((row: Record<string, unknown>) => row.required !== false)
        .map((row: Record<string, unknown>) => String(row.route_kind || ""))
        .filter((kind: string) => kind.length > 0),
    };
  };

  const requireExistingCurrentDerivative = async (
    plan: Awaited<
      ReturnType<typeof buildSesReleaseRevisionPlanForDockets>
    >,
  ): Promise<void> => {
    const expectedId = String(plan.release.id || "");
    const [releaseResp, membersResp, routesResp] = await Promise.all([
      client.from("makesafe_release_revisions")
        .select(
          "id,content_hash,state,dependency_generation,readiness_bindings",
        )
        .eq("id", expectedId).maybeSingle(),
      client.from("makesafe_release_revision_members")
        .select(
          "ordinal,job_id,docket_revision_id,invoice_obligation_revision_id,attendance_cycle_ids",
        )
        .eq("release_revision_id", expectedId).order("ordinal"),
      client.from("makesafe_release_revision_routes")
        .select(
          "ordinal,route_kind,recipients,cc,subject,body,body_hash,attachment_hashes,envelope_hash,required",
        )
        .eq("release_revision_id", expectedId).order("ordinal"),
    ]);
    const release = releaseResp.data as Record<string, unknown> | null;
    const expectedRelease = {
      id: expectedId,
      content_hash: String(plan.release.content_hash || ""),
      dependency_generation: Number(plan.release.dependency_generation),
      readiness_bindings: plan.release.readiness_bindings,
    };
    const actualRelease = release
      ? {
        id: String(release.id || ""),
        content_hash: String(release.content_hash || ""),
        dependency_generation: Number(release.dependency_generation),
        readiness_bindings: release.readiness_bindings,
      }
      : null;
    const actualMembers = (membersResp.data || []).map(
      (row: Record<string, unknown>) => ({
        ordinal: Number(row.ordinal),
        job_id: String(row.job_id || ""),
        docket_revision_id: String(row.docket_revision_id || ""),
        invoice_obligation_revision_id: row.invoice_obligation_revision_id ||
          null,
        attendance_cycle_ids: row.attendance_cycle_ids || [],
      }),
    );
    const actualRoutes = (routesResp.data || []).map(
      (row: Record<string, unknown>) => ({
        ordinal: Number(row.ordinal),
        route_kind: row.route_kind,
        recipients: row.recipients || [],
        cc: row.cc || [],
        subject: row.subject,
        body_hash: row.body_hash,
        attachment_hashes: row.attachment_hashes || [],
        body: row.body,
        envelope_hash: row.envelope_hash,
        required: row.required,
      }),
    );
    const releaseMatches = sameJson(actualRelease, expectedRelease);
    const membersMatch = sameJson(actualMembers, plan.members);
    const routesMatch = sameJson(actualRoutes, plan.routes);
    if (
      releaseResp.error || membersResp.error || routesResp.error ||
      !release || !["proposed", "approved"].includes(String(release.state)) ||
      !releaseMatches || !membersMatch || !routesMatch
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "stale_review",
          "Open the current release. A superseded DRAFT source may resume only the exact derivative that was already prepared before interruption; it can never mint or replace a release.",
          {
            fact:
              `The expected interrupted derivative is absent, non-current, or differs from its persisted coordinates (release=${releaseMatches}, members=${membersMatch}, routes=${routesMatch}).`,
            evidence: {
              expected_release_revision_id: expectedId,
              release_matches: releaseMatches,
              members_match: membersMatch,
              routes_match: routesMatch,
            },
          },
        ),
      );
    }
    await assertSesReleaseRevisionIsCurrent(client, expectedId);
  };

  const assertNoCompetingReleaseForPlan = async (
    plan: Awaited<
      ReturnType<typeof buildSesReleaseRevisionPlanForDockets>
    >,
    allowedReleaseRevisionIds: string[],
  ): Promise<void> => {
    const expectedId = String(plan.release.id || "");
    const docketRevisionIds = plan.members.map((member) =>
      String(member.docket_revision_id || "")
    );
    const overlaps = await client.from("makesafe_release_revision_members")
      .select("release_revision_id,docket_revision_id")
      .in("docket_revision_id", docketRevisionIds);
    if (overlaps.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact:
          "Current AUTHORISED-docket releases could not be read, so the derived release is not committed.",
      });
    }
    const allowedIds = new Set([
      expectedId,
      ...allowedReleaseRevisionIds.map((id) => String(id || "")),
    ]);
    const competingIds = [
      ...new Set<string>(
        (overlaps.data || []).map((row: Record<string, unknown>) =>
          String(row.release_revision_id || "")
        ).filter((id: string) => id && !allowedIds.has(id)),
      ),
    ];
    if (competingIds.length === 0) return;
    const active = await client.from("makesafe_release_revisions")
      .select("id,state")
      .in("id", competingIds)
      .in("state", ["proposed", "approved", "dispatching", "released"]);
    if (active.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact:
          "Competing AUTHORISED-docket release states could not be read, so the derived release is not committed.",
      });
    }
    const activeIds = (active.data || []).map((row: Record<string, unknown>) =>
      String(row.id || "")
    ).filter(Boolean);
    if (activeIds.length > 0) {
      throw new SesActionError(
        409,
        sesRefusal(
          "stale_review",
          "Open the current release. An independent correction was prepared from the AUTHORISED docket, so the older DRAFT source routes cannot replace it.",
          { evidence: { current_release_revision_ids: activeIds } },
        ),
      );
    }
  };

  const loadOptionBRecoveryCapsule = async (
    sourceRelease: UnifiedReleaseSnapshot,
    member: UnifiedReleaseMember,
  ): Promise<OptionBRecoveryCapsule> => {
    const approvals = await client.from("makesafe_revision_approvals")
      .select("id,evidence_refs")
      .eq("action", "invoice")
      .eq("decision", "approved")
      .eq("includes_authorise", true)
      .eq("job_id", member.job_id)
      .eq("docket_revision_id", member.docket_revision_id)
      .eq(
        "invoice_obligation_revision_id",
        member.invoice_obligation_revision_id,
      );
    if (approvals.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact:
          "The pre-money Option B recovery coordinates could not be read, so the AUTHORISED derivative is not resumed.",
      });
    }
    const capsules = (approvals.data || []).flatMap(
      (row: Record<string, unknown>) =>
        (Array.isArray(row.evidence_refs) ? row.evidence_refs : [])
          .map((value: unknown) => optionBRecoveryCapsule(value))
          .filter((
            capsule: OptionBRecoveryCapsule | null,
          ): capsule is OptionBRecoveryCapsule => !!capsule),
    ).filter((capsule: OptionBRecoveryCapsule) =>
      capsule.source_release_revision_id ===
        sourceRelease.release_revision_id &&
      capsule.source_release_content_hash === sourceRelease.content_hash &&
      capsule.job_id === member.job_id &&
      capsule.source_docket_revision_id === member.docket_revision_id &&
      capsule.invoice_obligation_revision_id ===
        member.invoice_obligation_revision_id
    );
    const uniqueCapsules = [
      ...new Map<string, OptionBRecoveryCapsule>(
        capsules.map((capsule: OptionBRecoveryCapsule) => [
          JSON.stringify(capsule),
          capsule,
        ]),
      ).values(),
    ];
    if (uniqueCapsules.length !== 1) {
      throw new SesActionError(
        409,
        sesRefusal(
          "authorised_derivative_mismatch",
          "Do not send. The already-AUTHORISED member has no single exact pre-money recovery capsule for this frozen DRAFT release.",
        ),
      );
    }
    return uniqueCapsules[0];
  };

  const recoverOptionBBoundMember = async (
    sourceRelease: UnifiedReleaseSnapshot,
    member: UnifiedReleaseMember,
    currentDocketRevisionId: string,
  ): Promise<OptionBAuthorisedMemberResult> => {
    const [docketResp, obligationResp] = await Promise.all([
      client.from("makesafe_docket_revisions")
        .select(
          "id,job_id,based_on_revision_id,stage,output_content_hash,invoice_obligation_revision_id,xero_binding",
        )
        .eq("id", currentDocketRevisionId).maybeSingle(),
      client.from("makesafe_invoice_obligation_revisions")
        .select("id,job_id,xero_binding")
        .eq("id", member.invoice_obligation_revision_id).maybeSingle(),
    ]);
    const docket = docketResp.data as Record<string, unknown> | null;
    const obligation = obligationResp.data as Record<string, unknown> | null;
    const xero = obligation?.xero_binding as
      | Record<string, unknown>
      | undefined;
    if (
      docketResp.error || obligationResp.error || !docket || !obligation ||
      docket.stage !== "invoice_bound" ||
      String(docket.job_id || "") !== member.job_id ||
      String(docket.based_on_revision_id || "") !==
        member.docket_revision_id ||
      String(docket.invoice_obligation_revision_id || "") !==
        member.invoice_obligation_revision_id ||
      String(obligation.job_id || "") !== member.job_id ||
      String(xero?.status || "").toUpperCase() !== "AUTHORISED"
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "stale_review",
          "Re-open the exact DRAFT release. The current docket is not its proven AUTHORISED child, so recovery is refused.",
        ),
      );
    }
    const capsule = await loadOptionBRecoveryCapsule(sourceRelease, member);
    const draftPdf = await loadStoredSesXeroInvoicePdfBytes(
      client,
      capsule.draft_pdf,
    );
    const authorisedInvoice: SesXeroInvoiceResult = {
      xero_invoice_id: String(xero!.xero_invoice_id || ""),
      invoice_number: String(xero!.invoice_number || ""),
      status: String(xero!.status || ""),
      reference: String(xero!.reference || ""),
      total: Number(xero!.total),
    };
    if (
      authorisedInvoice.xero_invoice_id !==
        capsule.draft_invoice.xero_invoice_id ||
      authorisedInvoice.reference !== capsule.draft_invoice.reference ||
      !Number.isFinite(authorisedInvoice.total) ||
      Math.round(authorisedInvoice.total * 100) !==
        Math.round(Number(capsule.draft_invoice.total) * 100)
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "authorised_derivative_mismatch",
          "Do not send. The current AUTHORISED invoice identity differs from the approved DRAFT recovery coordinates.",
        ),
      );
    }
    const rebound = await bindAuthorisedInvoicePdfToDocket(
      client,
      {
        org_id: ctx.org_id,
        job_id: member.job_id,
        invoice_obligation_revision_id: member.invoice_obligation_revision_id ||
          "",
        based_on_revision_id: member.docket_revision_id,
        actor: ctx.actor,
        invoice: authorisedInvoice,
        authorised_derivative: {
          draft_invoice: capsule.draft_invoice,
          draft_pdf: draftPdf,
        },
        existing_only: true,
      },
      ctx.xeroGateway,
    );
    if (
      String(rebound.docket_revision.id || "") !== currentDocketRevisionId ||
      !rebound.authorised_derivative
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "authorised_derivative_mismatch",
          "Do not send. Recovery did not re-prove the exact current AUTHORISED docket.",
        ),
      );
    }
    return {
      state: "authorised_invoice_already_bound",
      invoice: authorisedInvoice,
      docket_revision: rebound.docket_revision,
      draft_pdf_content_hash: capsule.draft_pdf.pdf_content_hash,
      authorised_pdf_content_hash: rebound.pdf_content_hash,
      authorised_derivative: rebound.authorised_derivative,
      invoice_create_dispatched: false,
      invoice_authorise_dispatched: false,
      send_dispatched: false,
      recovery: true,
    };
  };
  return {
    loadRelease: loadReleaseSnapshot,
    async materializeAuthorisedDerivative(sourceRelease) {
      if (auth.mode !== "jwt" || !auth.user) {
        throw new SesActionError(403, {
          state: "refused",
          fact:
            "Only the identified human operator may pre-ratify and materialise the AUTHORISED derivative.",
        });
      }
      const sourceRoutesResp = await client.from(
        "makesafe_release_revision_routes",
      ).select(
        "route_kind,recipients,cc,subject,body,attachment_hashes,ordinal",
      ).eq("release_revision_id", sourceRelease.release_revision_id)
        .order("ordinal");
      if (sourceRoutesResp.error || !(sourceRoutesResp.data || []).length) {
        throw new SesActionError(409, {
          state: "refused",
          fact:
            "The proposed DRAFT release routes could not be read, so its pre-ratification cannot be materialised.",
        });
      }
      const pricedMembers = sourceRelease.members.filter((member) =>
        String(member.pricing_disposition || "").toLowerCase() !==
          "no_additional_charge"
      );
      const noChargeMembers = sourceRelease.members.filter((member) =>
        String(member.pricing_disposition || "").toLowerCase() ===
          "no_additional_charge"
      );
      const recoveringSupersededSource = String(sourceRelease.state || "")
        .toLowerCase() === "superseded";
      // Validate every unchanged member before the first money side effect.
      // A mixed release must never authorise its priced member and then bind
      // old frozen routes to a newer no-charge docket selected by job ID.
      const reviewedByJobId = new Map(
        await Promise.all(sourceRelease.members.map(async (member) => {
          const reviewed = await loadSesCockpitDocket(client, member.job_id, {
            fetchInvoicePdfBytes: (invoiceId) =>
              ctx.xeroGateway.fetchAuthorisedPdf(invoiceId),
          });
          return [member.job_id, reviewed] as const;
        })),
      );
      const assertMemberCoordinates = (
        members: UnifiedReleaseMember[],
        currentByJobId: typeof reviewedByJobId,
        expectedDocketByJobId: Map<string, string>,
        compareSourceReadiness = true,
      ) => {
        for (const member of members) {
          const reviewed = currentByJobId.get(member.job_id)!;
          const expectedReadiness = String(member.readiness_revision || "");
          const expectedGeneration = Number(member.dependency_generation);
          const expectedDocket = expectedDocketByJobId.get(member.job_id) ||
            member.docket_revision_id;
          if (
            !reviewed || !expectedReadiness ||
            !Number.isFinite(expectedGeneration) ||
            reviewed.docket_revision_id !== expectedDocket ||
            reviewed.invoice_obligation_revision_id !==
              member.invoice_obligation_revision_id ||
            (compareSourceReadiness &&
              (reviewed.readiness_revision !== expectedReadiness ||
                reviewed.dependency_generation !== expectedGeneration))
          ) {
            throw new SesActionError(
              409,
              sesRefusal(
                "stale_review",
                "Re-open the exact release. A member changed after review, so its old frozen routes cannot be combined with the current docket.",
                {
                  evidence: {
                    job_id: member.job_id,
                    reviewed_docket_revision_id: expectedDocket,
                    current_docket_revision_id: reviewed?.docket_revision_id ||
                      null,
                  },
                },
              ),
            );
          }
        }
      };
      const sourceDocketByJobId = new Map(
        sourceRelease.members.map((member) => [
          member.job_id,
          member.docket_revision_id,
        ]),
      );
      assertMemberCoordinates(
        noChargeMembers,
        reviewedByJobId,
        sourceDocketByJobId,
      );
      if (pricedMembers.length === 0) {
        if (recoveringSupersededSource) {
          throw new SesActionError(
            409,
            sesRefusal(
              "stale_review",
              "Open the current release. A superseded document-only release is never an Option B recovery source.",
            ),
          );
        }
        await approveSesReleaseRevisionAction(client, auth, {
          org_id: ctx.org_id,
          release_revision_id: sourceRelease.release_revision_id,
          evidence_refs: [{
            kind: "unified_approve_send",
            source_release_revision_id: sourceRelease.release_revision_id,
            source_release_content_hash: sourceRelease.content_hash,
          }],
        });
        const approved = await loadReleaseSnapshot(
          sourceRelease.release_revision_id,
        );
        if (!approved) {
          throw new SesActionError(409, {
            state: "refused",
            fact: "The approved no-charge release could not be re-read.",
          });
        }
        return {
          release: approved,
          invoice_authorisations: [],
          source_release_revision_id: sourceRelease.release_revision_id,
        };
      }

      // The invoice-bound RPC deliberately refuses any bind after release
      // approval. Prove that ordering before the first money side effect: the
      // reviewed DRAFT release remains proposed and has no release decision.
      const priorReleaseApprovals = await client.from(
        "makesafe_revision_approvals",
      ).select("id,release_revision_id,docket_revision_id")
        .eq("action", "release")
        .eq("decision", "approved")
        .in(
          "docket_revision_id",
          pricedMembers.map((member) => member.docket_revision_id),
        )
        .limit(1);
      if (priorReleaseApprovals.error) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            "Release-approval ordering could not be read, so AUTHORISED binding is refused before Xero.",
        });
      }
      if ((priorReleaseApprovals.data || []).length > 0) {
        throw new SesActionError(
          409,
          sesRefusal(
            "stale_review",
            "Prepare a fresh DRAFT release. This docket already has a release approval and cannot use the code-only post-authorisation bind order.",
            {
              fact:
                "AUTHORISING now would bind an AUTHORISED docket after release approval, which is forbidden.",
            },
          ),
        );
      }

      const invoiceAuthorisations: Array<{
        job_id: string;
        result: unknown;
      }> = [];
      const substitutions: AuthorisedRouteSubstitution[] = [];
      const boundDocketByJobId = new Map<string, string>();
      for (const member of pricedMembers) {
        const reviewed = reviewedByJobId.get(member.job_id)!;
        let authorised: OptionBAuthorisedMemberResult;
        if (
          reviewed.docket_revision_id === member.docket_revision_id &&
          reviewed.invoice_obligation_revision_id ===
            member.invoice_obligation_revision_id
        ) {
          if (recoveringSupersededSource) {
            throw new SesActionError(
              409,
              sesRefusal(
                "stale_review",
                "Open the current release. A superseded DRAFT source may resume only an already-bound exact AUTHORISED child; it can never authorise money.",
              ),
            );
          }
          const draftBinding = reviewed.xero_binding;
          if (
            !draftBinding ||
            String(draftBinding.status || "").toUpperCase() !== "DRAFT" ||
            !draftBinding.pdf_content_hash ||
            !draftBinding.pdf_object_key ||
            !Number.isFinite(Number(draftBinding.pdf_size_bytes))
          ) {
            throw new SesActionError(
              409,
              sesRefusal(
                "xero_not_authorised",
                "Reload the real Xero DRAFT PDF before APPROVE & SEND; no frozen DRAFT derivative recovery coordinate is available.",
              ),
            );
          }
          const draftRevision = await client.from(
            "makesafe_invoice_obligation_revisions",
          ).select("id,job_id,xero_binding")
            .eq("id", member.invoice_obligation_revision_id).maybeSingle();
          const draftInvoice = draftRevision.data?.xero_binding as
            | SesXeroInvoiceResult
            | undefined;
          if (
            draftRevision.error || !draftRevision.data || !draftInvoice ||
            String(draftRevision.data.job_id || "") !== member.job_id ||
            String(draftInvoice.status || "").toUpperCase() !== "DRAFT" ||
            draftInvoice.xero_invoice_id !== draftBinding.xero_invoice_id ||
            draftInvoice.invoice_number !== draftBinding.invoice_number ||
            !String(draftInvoice.reference || "").trim() ||
            !Number.isFinite(Number(draftInvoice.total))
          ) {
            throw new SesActionError(
              409,
              sesRefusal(
                "authorised_derivative_mismatch",
                "Do not authorise. The stored DRAFT invoice identity is incomplete or differs from the exact PDF on screen.",
              ),
            );
          }
          const recoveryCapsule: OptionBRecoveryCapsule = {
            kind: OPTION_B_RECOVERY_CONTRACT,
            source_release_revision_id: sourceRelease.release_revision_id,
            source_release_content_hash: sourceRelease.content_hash,
            job_id: member.job_id,
            source_docket_revision_id: member.docket_revision_id,
            invoice_obligation_revision_id:
              member.invoice_obligation_revision_id || "",
            draft_invoice: {
              xero_invoice_id: draftInvoice.xero_invoice_id,
              invoice_number: draftInvoice.invoice_number,
              status: "DRAFT",
              reference: draftInvoice.reference,
              total: Number(draftInvoice.total),
            },
            draft_pdf: {
              pdf_object_key: draftBinding.pdf_object_key,
              pdf_content_hash: draftBinding.pdf_content_hash,
              pdf_size_bytes: Number(draftBinding.pdf_size_bytes),
            },
          };
          await approveSesInvoiceRevisionAction(client, auth, {
            org_id: ctx.org_id,
            job_id: member.job_id,
            includes_authorise: true,
            expected_docket_revision_id: reviewed.docket_revision_id,
            expected_invoice_obligation_revision_id:
              reviewed.invoice_obligation_revision_id || "",
            expected_output_content_hash: reviewed.docket_output_content_hash ||
              "",
            expected_draft_pdf_content_hash: draftBinding.pdf_content_hash,
            evidence_refs: [{
              kind: "unified_approve_send_draft_release",
              release_revision_id: sourceRelease.release_revision_id,
              release_content_hash: sourceRelease.content_hash,
            }, recoveryCapsule],
          });
          authorised = await executeSesInvoiceRevisionAction(
            client,
            auth,
            {
              org_id: ctx.org_id,
              job_id: member.job_id,
              invoice_obligation_revision_id:
                member.invoice_obligation_revision_id || "",
              actor: ctx.actor,
            },
            ctx.xeroGateway,
          ) as OptionBAuthorisedMemberResult;
        } else {
          authorised = await recoverOptionBBoundMember(
            sourceRelease,
            member,
            reviewed.docket_revision_id,
          );
        }
        const derivative = authorised.authorised_derivative;
        const authorisedInvoice = authorised.invoice as SesXeroInvoiceResult;
        if (
          !derivative ||
          !authorisedInvoice ||
          !authorised.draft_pdf_content_hash ||
          !authorised.authorised_pdf_content_hash
        ) {
          throw new SesActionError(
            409,
            sesRefusal(
              "authorised_derivative_mismatch",
              "Do not send. The AUTHORISED docket was bound without complete deterministic-derivative proof.",
            ),
          );
        }
        substitutions.push({
          draft_invoice: {
            xero_invoice_id: derivative.xero_invoice_id,
            invoice_number: derivative.draft_invoice_number,
            status: "DRAFT",
            reference: derivative.reference,
            total: Number(derivative.total),
          },
          authorised_invoice: authorisedInvoice,
          draft_pdf_content_hash: String(authorised.draft_pdf_content_hash),
          authorised_pdf_content_hash: String(
            authorised.authorised_pdf_content_hash,
          ),
        });
        const boundDocket = authorised.docket_revision;
        if (!recoveringSupersededSource) {
          await ratifySesAuthorisedDerivativeDocketAction(client, auth, {
            based_on_docket_revision_id: member.docket_revision_id,
            docket_revision_id: String(boundDocket.id || ""),
            expected_output_content_hash: String(
              boundDocket.output_content_hash || "",
            ),
            bound_pdf_content_hash: String(
              authorised.authorised_pdf_content_hash,
            ),
            derivative,
          });
        }
        boundDocketByJobId.set(
          member.job_id,
          String(boundDocket.id || ""),
        );
        invoiceAuthorisations.push({
          job_id: member.job_id,
          result: authorised,
        });
      }

      const expectedRoutes = deriveSesAuthorisedReleaseRoutes(
        (sourceRoutesResp.data || []) as StoredUnifiedRoute[],
        substitutions,
      );
      // Re-read after every provider/network operation and prove the exact
      // coordinates that will be committed. This closes the check-then-use
      // window where a no-charge/current-readiness docket could advance while
      // Xero was authorising the priced member.
      const currentDockets = await Promise.all(
        sourceRelease.members.map((member) =>
          loadSesCockpitDocket(client, member.job_id, {
            fetchInvoicePdfBytes: (invoiceId) =>
              ctx.xeroGateway.fetchAuthorisedPdf(invoiceId),
          })
        ),
      );
      const currentByJobId = new Map(
        currentDockets.map((docket) => [docket.job_id, docket]),
      );
      assertMemberCoordinates(
        noChargeMembers,
        currentByJobId,
        sourceDocketByJobId,
      );
      // Binding an AUTHORISED invoice deliberately invalidates readiness and
      // creates a new dependency generation. Prove the exact bound docket and
      // obligation here, then freeze the new readiness coordinates into the
      // final plan below. Comparing these members to the source DRAFT
      // generation would make the real Option B path authorise money and then
      // always stale-refuse.
      assertMemberCoordinates(
        pricedMembers,
        currentByJobId,
        boundDocketByJobId,
        false,
      );
      const exactPlan = await buildSesReleaseRevisionPlanForDockets({
        org_id: ctx.org_id,
        dockets: currentDockets,
        routes: expectedRoutes,
        created_by: ctx.actor,
      });
      const finalPlan = recoveringSupersededSource
        ? await (async () => {
          // A superseded source is only a retry handle for a derivative whose
          // prepare already committed before interruption. Require that exact
          // persisted release to remain current; never commit or supersede.
          await requireExistingCurrentDerivative(exactPlan);
          return exactPlan;
        })()
        : await (async () => {
          // Provider calls and the AUTHORISED bind are outside the release
          // transaction. Re-prove the immutable source immediately before
          // committing its derivative so a corrected release minted during
          // Xero authorisation cannot be overwritten by stale source routes.
          await assertNoCompetingReleaseForPlan(exactPlan, [
            sourceRelease.release_revision_id,
          ]);
          const sourceReread = await client.from(
            "makesafe_release_revisions",
          ).select("id,content_hash,state")
            .eq("id", sourceRelease.release_revision_id).maybeSingle();
          if (
            sourceReread.error || !sourceReread.data ||
            String(sourceReread.data.content_hash || "") !==
              sourceRelease.content_hash ||
            String(sourceReread.data.state || "") !== "proposed"
          ) {
            throw new SesActionError(
              409,
              sesRefusal(
                "stale_review",
                "Open the current release. The reviewed DRAFT source changed while its AUTHORISED derivative was being materialised, so stale frozen routes cannot be committed.",
              ),
            );
          }
          await assertSesReleaseRevisionIsCurrent(
            client,
            sourceRelease.release_revision_id,
          );
          return await commitSesReleaseRevisionPlanAction(client, exactPlan, {
            allowed_superseded_release_revision_ids: [
              sourceRelease.release_revision_id,
            ],
          });
        })();
      assertSesAuthorisedReleaseRouteDerivative(
        expectedRoutes,
        finalPlan.routes,
      );
      const finalReleaseRevisionId = String(finalPlan.release.id || "");
      await approveSesReleaseRevisionAction(client, auth, {
        org_id: ctx.org_id,
        release_revision_id: finalReleaseRevisionId,
        evidence_refs: [{
          kind: "deterministic_authorised_derivative",
          source_release_revision_id: sourceRelease.release_revision_id,
          source_release_content_hash: sourceRelease.content_hash,
          substitutions: substitutions.map((item) => ({
            draft_pdf_content_hash: item.draft_pdf_content_hash,
            authorised_pdf_content_hash: item.authorised_pdf_content_hash,
            draft_invoice_number: item.draft_invoice.invoice_number,
            authorised_invoice_number: item.authorised_invoice.invoice_number,
          })),
        }],
      });
      // Re-read the exact approved derivative before retiring the DRAFT retry
      // handle. After the source CAS succeeds there are no further fallible
      // materialisation reads, so a transient final-read failure cannot strand
      // an already-AUTHORISED invoice behind a superseded source.
      const finalRelease = await loadReleaseSnapshot(finalReleaseRevisionId);
      if (!finalRelease || finalRelease.state !== "approved") {
        throw new SesActionError(409, {
          state: "refused",
          fact:
            "The verified AUTHORISED derivative release approval could not be re-read; nothing was sent.",
        });
      }
      const sourceSuperseded = await client.from("makesafe_release_revisions")
        .update({ state: "superseded", updated_at: new Date().toISOString() })
        .eq("id", sourceRelease.release_revision_id)
        .eq("state", "proposed")
        .select("id,state").maybeSingle();
      let sourceState = String(sourceSuperseded.data?.state || "");
      if (sourceSuperseded.error || sourceState !== "superseded") {
        const sourceReread = await client.from("makesafe_release_revisions")
          .select("id,state")
          .eq("id", sourceRelease.release_revision_id).maybeSingle();
        sourceState = String(sourceReread.data?.state || "");
        if (sourceReread.error || sourceState !== "superseded") {
          throw new SesActionError(
            409,
            sesRefusal(
              "stale_review",
              "Reload the release state. The verified AUTHORISED derivative was approved, but the DRAFT preview could not be retired safely.",
            ),
          );
        }
      }
      return {
        release: finalRelease,
        invoice_authorisations: invoiceAuthorisations,
        source_release_revision_id: sourceRelease.release_revision_id,
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
      if (resp.error) {
        throw new SesActionError(
          503,
          sesRefusal(
            "route_send_proof_unreadable",
            "Retry the same frozen release after its exact route-proof ledger is readable; no confirmed route will be sent again.",
            {
              fact:
                "Confirmed route proofs could not be read, so the operator recovery state cannot honestly label routes pending.",
            },
          ),
        );
      }
      const kinds: string[] = (resp.data || [])
        .map((row: Record<string, unknown>) => String(row.route_kind || ""))
        .filter((kind: string) => kind.length > 0);
      return [...new Set<string>(kinds)];
    },
    async retainApproved(releaseRevisionId) {
      // CAS: only a `dispatching` release is put back to `approved`; a fully
      // released or already-approved row is left untouched. Verify the result;
      // never report approved_retained from an ignored PostgREST error or a
      // zero-row CAS.
      const updateResp = await client.from("makesafe_release_revisions")
        .update({ state: "approved", updated_at: new Date().toISOString() })
        .eq("id", releaseRevisionId).eq("state", "dispatching")
        .select("id,state").maybeSingle();
      if (updateResp.error) {
        throw new Error(
          `retain Approved update failed: ${updateResp.error.message}`,
        );
      }
      if (String(updateResp.data?.state || "").toLowerCase() === "approved") {
        return;
      }
      const verifyResp = await client.from("makesafe_release_revisions")
        .select("id,state").eq("id", releaseRevisionId).maybeSingle();
      if (verifyResp.error) {
        throw new Error(
          `retain Approved verification failed: ${verifyResp.error.message}`,
        );
      }
      const state = String(verifyResp.data?.state || "").toLowerCase();
      if (state !== "approved") {
        throw new Error(
          `retain Approved verification found release state '${
            state || "missing"
          }'`,
        );
      }
    },
  };
}

export async function unifiedSesReleaseAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    expected_release_content_hash: string;
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
