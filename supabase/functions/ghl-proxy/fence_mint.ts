import {
  cleanIdentity,
  contactDisplayIdentity,
  normalizeIdentity,
  stableJsonStringify,
} from "./hardening_helpers.ts";
import { rethrowIfGhlRateLimited } from "./provider_reads.ts";

export const FENCE_MINT_ROLES = new Set([
  "admin",
  "estimator",
  "sales",
  "ops_manager",
  "division_ops",
]);
export const FENCE_MINT_INTENTS = new Set([
  "RESOLVED_NO_JOB",
  "DELIBERATE_REPEAT",
]);

export type FenceMintIntent = "RESOLVED_NO_JOB" | "DELIBERATE_REPEAT";

export type FenceMintInput = {
  requestId: string;
  organisationId: string;
  intent: FenceMintIntent;
  contactId: string | null;
  opportunityId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  suburb: string;
  expectedExistingJobIds: string[];
  repeatReason: string | null;
  // SQ-23: the new job is another option of this existing job's quote. Only
  // with DELIBERATE_REPEAT, and only one of expectedExistingJobIds. Not in the
  // mint fingerprint: the link is a separate idempotent step after the mint.
  quoteOptionOfJobId: string | null;
  optionLabel: string | null;
};

export type FenceMintContact = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  city?: string | null;
};

export type FenceMintOpportunity = {
  id: string;
  contactId: string;
  pipelineId: string;
  name?: string | null;
};

export type FenceMintCanonical = {
  jobId: string;
  jobNumber: string;
  contactId: string;
  opportunityId: string;
  mappingOutcome: string;
  scopeVersion: number;
  updatedAt: string;
  scopeHash: string | null;
  requiresLoad: boolean;
};

export type FenceMintProgress = {
  ownerRequestId: string;
  state: "reserved" | "contact_resolved" | "opportunity_created" | "complete";
  joined: boolean;
  // True only when this requestId re-entered a lead a prior mint already
  // completed against. Distinct from a concurrent join, which is a live race.
  completedReentry?: boolean;
  executor: boolean;
  contactId: string | null;
  opportunityId: string | null;
  // Attempts recorded against the executing ledger row. 1 means no outbound
  // create has ever been attempted for this mint.
  attemptCount: number;
  canonical: FenceMintCanonical | null;
};

export type FenceMintDeps = {
  fencePipelineId: string;
  reserve: (
    args: {
      input: FenceMintInput;
      actorId: string;
      fingerprint: string;
      identityKey: string;
    },
  ) => Promise<FenceMintProgress>;
  bindIdentity: (
    args: {
      ownerRequestId: string;
      contact: FenceMintContact;
      opportunity: FenceMintOpportunity | null;
    },
  ) => Promise<FenceMintProgress>;
  recordOpportunity: (
    args: { ownerRequestId: string; opportunity: FenceMintOpportunity },
  ) => Promise<FenceMintProgress>;
  complete: (args: { ownerRequestId: string }) => Promise<FenceMintCanonical>;
  awaitCanonical: (
    args: { ownerRequestId: string },
  ) => Promise<FenceMintCanonical | null>;
  getContact: (contactId: string) => Promise<FenceMintContact>;
  findContacts: (input: FenceMintInput) => Promise<FenceMintContact[]>;
  createContact: (input: FenceMintInput) => Promise<FenceMintContact>;
  getOpportunity: (opportunityId: string) => Promise<FenceMintOpportunity>;
  findStampedOpportunity: (
    args: { ownerRequestId: string; contactId: string },
  ) => Promise<FenceMintOpportunity | null>;
  createStampedOpportunity: (
    args: {
      ownerRequestId: string;
      contact: FenceMintContact;
      cleanName: string;
    },
  ) => Promise<FenceMintOpportunity>;
  recordFailure?: (
    args: {
      requestId: string;
      code: string;
      message: string;
      executingRequestId?: string;
      executing?: boolean;
    },
  ) => Promise<void>;
  now?: () => number;
};

export class FenceMintError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FenceMintError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function boundedString(value: unknown, field: string, max: number): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new FenceMintError(
      400,
      "invalid_request",
      `${field} must be a string`,
    );
  }
  const result = value.trim();
  if (result.length > max) {
    throw new FenceMintError(400, "invalid_request", `${field} is too long`);
  }
  return result;
}

function optionalId(value: unknown, field: string): string | null {
  const result = boundedString(value, field, 160);
  return result || null;
}

export function validateFenceMintInput(rawBody: unknown): FenceMintInput {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new FenceMintError(
      400,
      "invalid_request",
      "JSON object body required",
    );
  }
  const body = rawBody as Record<string, unknown>;
  for (
    const forbidden of [
      "scopeJson",
      "scope_json",
      "pricingJson",
      "pricing_json",
      "quote",
      "pdf",
      "message",
    ]
  ) {
    if (forbidden in body) {
      throw new FenceMintError(
        400,
        "mint_payload_not_allowed",
        `${forbidden} is not accepted by the identity mint command`,
      );
    }
  }

  const requestId = boundedString(
    body.requestId ?? body.request_id,
    "requestId",
    64,
  ).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(requestId)
  ) {
    throw new FenceMintError(
      400,
      "invalid_request_id",
      "requestId must be a client-persisted UUID",
    );
  }

  const organisationId = boundedString(
    body.organisationId ?? body.organisation_id,
    "organisationId",
    64,
  );
  if (!organisationId) {
    throw new FenceMintError(
      400,
      "organisation_required",
      "organisationId is required",
    );
  }

  const intent = boundedString(body.intent, "intent", 40) as FenceMintIntent;
  if (!FENCE_MINT_INTENTS.has(intent)) {
    throw new FenceMintError(
      400,
      "invalid_mint_intent",
      "intent must be RESOLVED_NO_JOB or DELIBERATE_REPEAT",
    );
  }

  const contactId = optionalId(body.contactId ?? body.contact_id, "contactId");
  const opportunityId = optionalId(
    body.opportunityId ?? body.opportunity_id,
    "opportunityId",
  );
  if (opportunityId && !contactId) {
    throw new FenceMintError(
      400,
      "contact_required_for_opportunity",
      "contactId is required when opportunityId is supplied",
    );
  }

  const email = boundedString(body.email, "email", 320).toLowerCase();
  const phone = boundedString(body.phone, "phone", 80);
  if (!contactId && !email && !phone) {
    throw new FenceMintError(
      400,
      "contact_identity_required",
      "contactId, email or phone is required",
    );
  }

  const rawExpected = body.expectedExistingJobIds ??
    body.expected_existing_job_ids ?? [];
  if (
    !Array.isArray(rawExpected) ||
    rawExpected.length > 100 ||
    rawExpected.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new FenceMintError(
      400,
      "invalid_existing_job_evidence",
      "expectedExistingJobIds must be an array of job IDs",
    );
  }
  const expectedExistingJobIds = [
    ...new Set(rawExpected.map((id: string) => id.trim().toLowerCase())),
  ].sort();
  if (
    expectedExistingJobIds.some((id) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    )
  ) {
    throw new FenceMintError(
      400,
      "invalid_existing_job_evidence",
      "expectedExistingJobIds must be job UUIDs",
    );
  }
  const repeatReason = optionalId(
    body.repeatReason ?? body.repeat_reason,
    "repeatReason",
  );
  if (
    intent === "DELIBERATE_REPEAT" && (!repeatReason || repeatReason.length < 3)
  ) {
    throw new FenceMintError(
      400,
      "repeat_reason_required",
      "DELIBERATE_REPEAT requires repeatReason",
    );
  }

  const rawOptionOf = body.quoteOptionOfJobId ?? body.quote_option_of_job_id;
  const quoteOptionOfJobId = rawOptionOf == null || rawOptionOf === ""
    ? null
    : boundedString(rawOptionOf, "quoteOptionOfJobId", 64).toLowerCase();
  if (quoteOptionOfJobId) {
    if (intent !== "DELIBERATE_REPEAT") {
      throw new FenceMintError(
        400,
        "quote_option_requires_repeat",
        "quoteOptionOfJobId is only accepted with DELIBERATE_REPEAT",
      );
    }
    if (!expectedExistingJobIds.includes(quoteOptionOfJobId)) {
      throw new FenceMintError(
        400,
        "quote_option_not_existing_job",
        "quoteOptionOfJobId must be one of expectedExistingJobIds",
      );
    }
  }
  const optionLabel = quoteOptionOfJobId
    ? (boundedString(body.optionLabel ?? body.option_label, "optionLabel", 120) || null)
    : null;

  return {
    requestId,
    organisationId,
    intent,
    contactId,
    opportunityId,
    quoteOptionOfJobId,
    optionLabel,
    firstName: boundedString(
      body.firstName ?? body.first_name,
      "firstName",
      120,
    ),
    lastName: boundedString(body.lastName ?? body.last_name, "lastName", 120),
    email,
    phone,
    address: boundedString(body.address, "address", 300),
    suburb: boundedString(body.suburb, "suburb", 160),
    expectedExistingJobIds,
    repeatReason,
  };
}

export function authorizeFenceMintCaller(args: {
  mode: string;
  authUserId: string | null;
  profile: { id?: unknown; org_id?: unknown; role?: unknown } | null;
  organisationId: string;
}) {
  const { mode, authUserId, profile, organisationId } = args;
  if (mode !== "user_jwt" || !authUserId || !profile) {
    throw new FenceMintError(
      401,
      "user_jwt_required",
      "mint_fence_job requires an authenticated Supabase user",
    );
  }
  if (String(profile.id || "") !== authUserId) {
    throw new FenceMintError(
      403,
      "caller_identity_mismatch",
      "Authenticated caller does not match the user profile",
    );
  }
  if (String(profile.org_id || "") !== organisationId) {
    throw new FenceMintError(
      403,
      "org_mismatch",
      "Request belongs to a different organisation",
    );
  }
  const role = String(profile.role || "");
  if (!FENCE_MINT_ROLES.has(role)) {
    throw new FenceMintError(
      403,
      "role_not_allowed",
      "Caller role cannot mint fencing jobs",
    );
  }
}

export function fenceMintIdentityKey(input: FenceMintInput): string {
  if (input.contactId) return `ghl:${normalizeIdentity(input.contactId)}`;
  const phone = normalizeIdentity(input.phone);
  const email = input.email.toLowerCase();
  if (phone && email) return `phone:${phone}|email:${email}`;
  if (phone) return `phone:${phone}`;
  return `email:${email}`;
}

export async function fenceMintFingerprint(
  input: FenceMintInput,
): Promise<string> {
  const material = {
    requestId: input.requestId,
    organisationId: input.organisationId,
    intent: input.intent,
    contactId: input.contactId,
    opportunityId: input.opportunityId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: normalizeIdentity(input.phone),
    address: input.address,
    suburb: input.suburb,
    expectedExistingJobIds: input.expectedExistingJobIds,
    repeatReason: input.repeatReason,
    type: "fencing",
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJsonStringify(material)),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function fenceMintStamp(requestId: string): string {
  return `[SW-MINT:${requestId}]`;
}

export function stampedFenceOpportunityName(
  cleanName: string,
  requestId: string,
): string {
  return `${cleanName} ${fenceMintStamp(requestId)}`.trim();
}

export function opportunityHasFenceMintStamp(
  opportunity: { name?: unknown },
  requestId: string,
): boolean {
  return typeof opportunity?.name === "string" &&
    opportunity.name.includes(fenceMintStamp(requestId));
}

function canonicalResponse(
  canonical: FenceMintCanonical,
  args: {
    requestId: string;
    replayed: boolean;
    joined: boolean;
    completedReentry?: boolean;
    timingMs: Record<string, number>;
  },
) {
  return {
    success: true,
    requestId: args.requestId,
    jobId: canonical.jobId,
    jobNumber: canonical.jobNumber,
    contactId: canonical.contactId,
    opportunityId: canonical.opportunityId,
    mapping: {
      outcome: args.completedReentry
        ? "completed_opportunity_reused"
        : args.replayed
        ? "idempotent_replay"
        : args.joined
        ? "concurrent_request_reused"
        : canonical.mappingOutcome,
      canonicalOutcome: canonical.mappingOutcome,
    },
    revision: {
      scopeVersion: canonical.scopeVersion,
      scopeHash: canonical.scopeHash,
      updatedAt: canonical.updatedAt,
      requiresLoad: canonical.requiresLoad,
    },
    timingMs: args.timingMs,
  };
}

export async function executeFenceJobMint(args: {
  input: FenceMintInput;
  actorId: string;
  deps: FenceMintDeps;
}) {
  const { input, actorId, deps } = args;
  const now = deps.now || (() => performance.now());
  const started = now();
  let lap = started;
  const timingMs: Record<string, number> = {};
  const mark = (name: string) => {
    const current = now();
    timingMs[name] = Math.max(0, Math.round((current - lap) * 10) / 10);
    lap = current;
  };

  let ownerRequestId = input.requestId;
  // Tracks whether this caller is the one actually executing RPCs against
  // ownerRequestId. A takeover executor drives another request's ledger row, so
  // its failures belong on that row, not on its own joined row.
  let executing = false;
  try {
    const fingerprint = await fenceMintFingerprint(input);
    const progress = await deps.reserve({
      input,
      actorId,
      fingerprint,
      identityKey: fenceMintIdentityKey(input),
    });
    ownerRequestId = progress.ownerRequestId;
    executing = progress.executor;
    mark("reserve");

    if (progress.canonical) {
      timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
      return canonicalResponse(progress.canonical, {
        requestId: input.requestId,
        replayed: progress.ownerRequestId === input.requestId &&
          progress.state === "complete",
        joined: progress.joined,
        completedReentry: progress.completedReentry,
        timingMs,
      });
    }
    if (!progress.executor) {
      const canonical = await deps.awaitCanonical({ ownerRequestId });
      mark("await_owner");
      if (!canonical) {
        throw new FenceMintError(
          409,
          "mint_in_progress",
          "The canonical fence mint is still in progress; retry with the same requestId",
        );
      }
      timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
      return canonicalResponse(canonical, {
        requestId: input.requestId,
        replayed: false,
        joined: true,
        timingMs,
      });
    }

    let contact: FenceMintContact;
    if (progress.contactId) {
      contact = { id: progress.contactId };
    } else if (input.contactId) {
      contact = await deps.getContact(input.contactId);
    } else {
      const matches = await deps.findContacts(input);
      const ids = [
        ...new Set(
          matches.map((candidate) => cleanIdentity(candidate.id)).filter(
            Boolean,
          ) as string[],
        ),
      ];
      if (ids.length > 1) {
        throw new FenceMintError(
          409,
          "contact_identity_conflict",
          "Email and phone resolve to different GHL contacts",
          { contactIds: ids },
        );
      }
      contact = matches[0] || await deps.createContact(input);
    }
    if (!cleanIdentity(contact?.id)) {
      throw new FenceMintError(
        502,
        "ghl_contact_missing",
        "GHL did not return a contact identity",
      );
    }
    mark("contact");

    let suppliedOpportunity: FenceMintOpportunity | null = null;
    if (input.opportunityId) {
      suppliedOpportunity = await deps.getOpportunity(input.opportunityId);
      if (suppliedOpportunity.contactId !== contact.id) {
        throw new FenceMintError(
          409,
          "opportunity_contact_conflict",
          "Opportunity belongs to a different GHL contact",
        );
      }
      if (suppliedOpportunity.pipelineId !== deps.fencePipelineId) {
        throw new FenceMintError(
          409,
          "opportunity_pipeline_conflict",
          "Opportunity is not in the fencing pipeline",
        );
      }
    }
    mark("opportunity_verify");

    const preBindOwnerRequestId = ownerRequestId;
    const bound = await deps.bindIdentity({
      ownerRequestId,
      contact,
      opportunity: suppliedOpportunity,
    });
    ownerRequestId = bound.ownerRequestId;
    mark("bind_identity");
    if (bound.canonical) {
      timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
      return canonicalResponse(bound.canonical, {
        requestId: input.requestId,
        replayed: false,
        joined: progress.joined,
        timingMs,
      });
    }
    if (bound.ownerRequestId !== preBindOwnerRequestId) {
      executing = false;
      // Callers that reserved under different identity keys (email vs phone)
      // only converge on the contact lock at bind time. The caller that loses
      // ownership stops executing and replays the canonical owner's result.
      const canonical = await deps.awaitCanonical({ ownerRequestId });
      mark("await_owner");
      if (!canonical) {
        throw new FenceMintError(
          409,
          "mint_in_progress",
          "The canonical fence mint is still in progress; retry with the same requestId",
        );
      }
      timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
      return canonicalResponse(canonical, {
        requestId: input.requestId,
        replayed: false,
        joined: true,
        timingMs,
      });
    }

    let opportunity: FenceMintOpportunity;
    if (bound.opportunityId) {
      opportunity = {
        id: bound.opportunityId,
        contactId: contact.id,
        pipelineId: deps.fencePipelineId,
      };
    } else if (suppliedOpportunity) {
      opportunity = suppliedOpportunity;
    } else {
      const cleanName = `${
        contactDisplayIdentity({
          firstName: contact.firstName ?? input.firstName,
          lastName: contact.lastName ?? input.lastName,
          phone: contact.phone ?? input.phone,
          email: contact.email ?? input.email,
          address: contact.address1 ?? input.address,
        })
      } — Fencing`;
      // The stamp embeds this requestId, so a first execution cannot possibly
      // find one already created. Reconciliation is confined to ambiguous
      // retries, where a prior attempt's response may have been lost. This keeps
      // the unverified contact-scoped listing off the normal create path.
      const ambiguousRetry =
        (bound.attemptCount ?? progress.attemptCount ?? 1) > 1;
      opportunity = (ambiguousRetry
        ? await deps.findStampedOpportunity({
          ownerRequestId,
          contactId: contact.id,
        })
        : null) as FenceMintOpportunity;
      if (!opportunity) {
        try {
          opportunity = await deps.createStampedOpportunity({
            ownerRequestId,
            contact,
            cleanName,
          });
        } catch (createError) {
          // Lost-response recovery: creation may have committed in GHL. Reconcile
          // the request stamp before ever attempting a replacement create.
          opportunity = await deps.findStampedOpportunity({
            ownerRequestId,
            contactId: contact.id,
          }) as FenceMintOpportunity;
          if (!opportunity) throw createError;
        }
      }
    }
    if (!opportunity?.id) {
      throw new FenceMintError(
        502,
        "ghl_opportunity_missing",
        "GHL did not return an opportunity identity",
      );
    }
    if (opportunity.contactId !== contact.id) {
      throw new FenceMintError(
        409,
        "opportunity_contact_conflict",
        "Stamped opportunity belongs to a different contact",
      );
    }
    mark("opportunity");

    const recorded = await deps.recordOpportunity({
      ownerRequestId,
      opportunity,
    });
    mark("record_opportunity");
    if (recorded.canonical) {
      timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
      return canonicalResponse(recorded.canonical, {
        requestId: input.requestId,
        replayed: false,
        joined: progress.joined,
        timingMs,
      });
    }

    const canonical = await deps.complete({ ownerRequestId });
    mark("complete");
    timingMs.total = Math.max(0, Math.round((now() - started) * 10) / 10);
    return canonicalResponse(canonical, {
      requestId: input.requestId,
      replayed: false,
      joined: progress.joined,
      timingMs,
    });
  } catch (error) {
    rethrowIfGhlRateLimited(error);
    const errorMessage = (error as Error)?.message || "Fence mint failed";
    const looksLikeGhlFailure =
      /^(GHL\s|fetch failed|network)|timeout|aborted|connection reset/i.test(
        errorMessage,
      );
    const typed = error instanceof FenceMintError ? error : new FenceMintError(
      looksLikeGhlFailure ? 502 : 503,
      looksLikeGhlFailure ? "ghl_request_failed" : "fence_mint_failed",
      errorMessage,
    );
    try {
      if (typed.code !== "mint_in_progress") {
        // Stamp the ledger row this caller actually executed against. A plain
        // joiner records on its own row, so it can never expire the lease of a
        // still-active owner it merely polled.
        await deps.recordFailure?.({
          requestId: executing ? ownerRequestId : input.requestId,
          code: typed.code,
          message: typed.message,
          executingRequestId: input.requestId,
          executing,
        });
      }
    } catch (_) {
      // Failure telemetry must never replace the original typed failure.
    }
    throw typed;
  }
}

/**
 * SQ-23: link a minted fence job as another option of an existing job's
 * quote (link_fence_quote_option, 20261019210000). Idempotent. A refusal is
 * returned, not thrown: the job already exists, and the caller may retry the
 * link with the link_quote_option action.
 */
export async function linkFenceQuoteOption(args: {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: any }>;
  jobId: string;
  optionOfJobId: string;
  label: string | null;
  actorId: string;
}): Promise<{ ok: true; groupId: string } | { ok: false; code: string }> {
  let data: unknown = null;
  let error: any = null;
  try {
    ({ data, error } = await args.rpc("link_fence_quote_option", {
      p_job_id: args.jobId,
      p_option_of_job_id: args.optionOfJobId,
      p_label: args.label,
      p_actor_id: args.actorId,
    }));
  } catch (thrown) {
    error = { message: String((thrown as Error)?.message || thrown) };
  }
  if (error) {
    const message = String(error.message || "");
    const known = message.match(/quote_option_[a-z_]+/);
    return { ok: false, code: known ? known[0] : "quote_option_link_failed" };
  }
  const groupId = Array.isArray(data) ? data[0] : data;
  if (typeof groupId !== "string" || !groupId) {
    return { ok: false, code: "quote_option_link_failed" };
  }
  return { ok: true, groupId };
}

/** Normalised site key for the same-site check: letters and digits, lower case. */
// The street address as words: lower case, every run of punctuation or space
// one space, so "1/23 Smith St" (unit 1 of 23) never equals "123 Smith St".
// Only an exact match counts; a near match lets the save through as before.
export function fenceSiteKey(address: unknown): string {
  return String(address ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function suburbKey(suburb: unknown): string {
  return String(suburb ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * SQ-23 route A guard: the open fence jobs (draft or quoted, not superseded) a
 * new job for this GHL contact at this site would sit beside. The caller
 * refuses with choose_existing_or_option unless the scoper confirmed a
 * repeat. Jobs at another site are not counted: a new site is new work.
 */
export function openSameSiteFenceJobs(
  jobs: Array<{ id: string; job_number?: string | null; status?: string | null; site_address?: string | null; site_suburb?: string | null; superseded_at?: string | null }>,
  address: unknown,
  suburb?: unknown,
) {
  const site = fenceSiteKey(address);
  if (!site) return [];
  const area = suburbKey(suburb);
  return jobs.filter((j) => {
    if (j.superseded_at) return false;
    if (!["draft", "quoted"].includes(String(j.status || "draft"))) return false;
    if (fenceSiteKey(j.site_address) !== site) return false;
    // Same street in two suburbs is two sites; a missing suburb is not a clash.
    const theirs = suburbKey(j.site_suburb);
    return !area || !theirs || area === theirs;
  }).map((j) => ({ id: j.id, jobNumber: j.job_number ?? null, status: j.status ?? null }));
}
