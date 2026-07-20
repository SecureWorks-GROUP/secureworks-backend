import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeFenceMintCaller,
  executeFenceJobMint,
  type FenceMintCanonical,
  type FenceMintDeps,
  FenceMintError,
  type FenceMintInput,
  type FenceMintOpportunity,
  type FenceMintProgress,
  fenceMintStamp,
  validateFenceMintInput,
} from "./fence_mint.ts";

const FENCE_PIPELINE_ID = "I9t8njpuR0Dm7B2NDcvI";
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const ORG = "00000000-0000-0000-0000-000000000001";

function input(
  requestId = REQUEST_A,
  patch: Record<string, unknown> = {},
): FenceMintInput {
  return validateFenceMintInput({
    requestId,
    organisationId: ORG,
    intent: "RESOLVED_NO_JOB",
    contactId: "contact-1",
    firstName: "Test",
    lastName: "Client",
    email: "test@example.com",
    phone: "0400000000",
    address: "1 Test Street",
    suburb: "Perth",
    ...patch,
  });
}

function canonical(outcome = "created"): FenceMintCanonical {
  return {
    jobId: "job-1",
    jobNumber: "SWF-26001",
    contactId: "contact-1",
    opportunityId: "opp-1",
    mappingOutcome: outcome,
    scopeVersion: 1,
    updatedAt: "2026-07-21T00:00:00Z",
    scopeHash: outcome === "created"
      ? "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
      : null,
    requiresLoad: outcome !== "created",
  };
}

function progress(patch: Partial<FenceMintProgress> = {}): FenceMintProgress {
  return {
    ownerRequestId: REQUEST_A,
    state: "reserved",
    joined: false,
    executor: true,
    contactId: null,
    opportunityId: null,
    attemptCount: 1,
    canonical: null,
    ...patch,
  };
}

function deps(overrides: Partial<FenceMintDeps> = {}): FenceMintDeps {
  return {
    fencePipelineId: FENCE_PIPELINE_ID,
    reserve: async () => progress(),
    bindIdentity: async ({ ownerRequestId, contact, opportunity }) =>
      progress({
        ownerRequestId,
        state: "contact_resolved",
        contactId: contact.id,
        opportunityId: opportunity?.id || null,
      }),
    recordOpportunity: async ({ ownerRequestId, opportunity }) =>
      progress({
        ownerRequestId,
        state: "opportunity_created",
        contactId: opportunity.contactId,
        opportunityId: opportunity.id,
      }),
    complete: async () => canonical(),
    awaitCanonical: async () => null,
    getContact: async (id) => ({ id, firstName: "Test", lastName: "Client" }),
    findContacts: async () => [],
    createContact: async () => ({ id: "contact-1" }),
    getOpportunity: async (id) => ({
      id,
      contactId: "contact-1",
      pipelineId: FENCE_PIPELINE_ID,
    }),
    findStampedOpportunity: async () => null,
    createStampedOpportunity: async (
      { ownerRequestId, contact, cleanName },
    ) => ({
      id: "opp-1",
      contactId: contact.id,
      pipelineId: FENCE_PIPELINE_ID,
      name: `${cleanName} ${fenceMintStamp(ownerRequestId)}`,
    }),
    ...overrides,
  };
}

Deno.test("mint requires user JWT, allowed role and exact organisation", async () => {
  authorizeFenceMintCaller({
    mode: "user_jwt",
    authUserId: "user-1",
    profile: { id: "user-1", org_id: ORG, role: "sales" },
    organisationId: ORG,
  });

  await assertRejects(
    async () =>
      authorizeFenceMintCaller({
        mode: "user_jwt",
        authUserId: "user-1",
        profile: { id: "user-1", org_id: "other-org", role: "sales" },
        organisationId: ORG,
      }),
    FenceMintError,
    "different organisation",
  );
  await assertRejects(
    async () =>
      authorizeFenceMintCaller({
        mode: "user_jwt",
        authUserId: "user-1",
        profile: { id: "user-1", org_id: ORG, role: "installer" },
        organisationId: ORG,
      }),
    FenceMintError,
    "cannot mint",
  );
  await assertRejects(
    async () =>
      authorizeFenceMintCaller({
        mode: "shared_key",
        authUserId: null,
        profile: null,
        organisationId: ORG,
      }),
    FenceMintError,
    "authenticated Supabase user",
  );
});

Deno.test("mint rejects scope/pricing payloads and unbounded existing-job evidence", async () => {
  const scopeError = await assertRejects(
    async () => input(REQUEST_A, { scopeJson: { huge: true } }),
    FenceMintError,
  );
  assertEquals(scopeError.code, "mint_payload_not_allowed");

  const evidenceError = await assertRejects(
    async () =>
      input(REQUEST_A, {
        expectedExistingJobIds: Array.from(
          { length: 101 },
          (_, i) => `job-${i}`,
        ),
      }),
    FenceMintError,
  );
  assertEquals(evidenceError.code, "invalid_existing_job_evidence");

  const nonUuidError = await assertRejects(
    async () => input(REQUEST_A, { expectedExistingJobIds: ["not-a-job-uuid"] }),
    FenceMintError,
  );
  assertEquals(nonUuidError.code, "invalid_existing_job_evidence");

  const normalised = input(REQUEST_A, {
    expectedExistingJobIds: [
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ],
  });
  assertEquals(normalised.expectedExistingJobIds, [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ]);
});

Deno.test("two devices with distinct request IDs serialize to one canonical job and one GHL create", async () => {
  let owner: string | null = null;
  let result: FenceMintCanonical | null = null;
  let creates = 0;
  const shared = deps({
    reserve: async ({ input: request }) => {
      if (!owner) {
        owner = request.requestId;
        return progress({ ownerRequestId: owner, executor: true });
      }
      return progress({ ownerRequestId: owner, joined: true, executor: false });
    },
    createStampedOpportunity: async ({ ownerRequestId, contact }) => {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        id: "opp-1",
        contactId: contact.id,
        pipelineId: FENCE_PIPELINE_ID,
        name: fenceMintStamp(ownerRequestId),
      };
    },
    complete: async () => {
      result = canonical();
      return result;
    },
    awaitCanonical: async () => {
      for (let i = 0; i < 20 && !result; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return result;
    },
  });

  const [first, second] = await Promise.all([
    executeFenceJobMint({
      input: input(REQUEST_A),
      actorId: "user-1",
      deps: shared,
    }),
    executeFenceJobMint({
      input: input(REQUEST_B),
      actorId: "user-1",
      deps: shared,
    }),
  ]);

  assertEquals(first.jobId, "job-1");
  assertEquals(second.jobId, "job-1");
  assertEquals(second.mapping.outcome, "concurrent_request_reused");
  assertEquals(creates, 1);
});

Deno.test("same completed request and lost HTTP response replay return the canonical job without GHL IO", async () => {
  let ghlCalls = 0;
  const replayDeps = deps({
    reserve: async () =>
      progress({ state: "complete", canonical: canonical(), executor: false }),
    getContact: async () => {
      ghlCalls++;
      return { id: "contact-1" };
    },
    createStampedOpportunity: async () => {
      ghlCalls++;
      return {} as FenceMintOpportunity;
    },
  });

  const replay = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: replayDeps,
  });
  assertEquals(replay.jobId, "job-1");
  assertEquals(replay.mapping.outcome, "idempotent_replay");
  assertEquals(ghlCalls, 0);
});

Deno.test("lost GHL create response reconciles the stamped opportunity before replacement create", async () => {
  let creates = 0;
  let searches = 0;
  let committed: FenceMintOpportunity | null = null;
  const lostResponseDeps = deps({
    findStampedOpportunity: async () => {
      searches++;
      return committed;
    },
    createStampedOpportunity: async ({ ownerRequestId }) => {
      creates++;
      committed = {
        id: "opp-lost-response",
        contactId: "contact-1",
        pipelineId: FENCE_PIPELINE_ID,
        name: fenceMintStamp(ownerRequestId),
      };
      throw new Error("connection reset after upstream commit");
    },
    recordOpportunity: async ({ opportunity }) => {
      assertEquals(opportunity.id, "opp-lost-response");
      return progress({
        state: "opportunity_created",
        contactId: "contact-1",
        opportunityId: opportunity.id,
      });
    },
  });

  const minted = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: lostResponseDeps,
  });
  assertEquals(minted.jobId, "job-1");
  assertEquals(creates, 1);
  // A first attempt never pre-scans: the stamp embeds this requestId, so nothing
  // could already exist. Only the lost-response catch reconciles.
  assertEquals(searches, 1);
});

Deno.test("stale opportunity contact mapping stops before bind or mutation", async () => {
  let binds = 0;
  const staleDeps = deps({
    getOpportunity: async (id) => ({
      id,
      contactId: "other-contact",
      pipelineId: FENCE_PIPELINE_ID,
    }),
    bindIdentity: async () => {
      binds++;
      return progress();
    },
  });
  const error = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A, { opportunityId: "opp-stale" }),
        actorId: "user-1",
        deps: staleDeps,
      }),
    FenceMintError,
  );
  assertEquals(error.code, "opportunity_contact_conflict");
  assertEquals(binds, 0);
});

Deno.test("conflicting database mappings remain typed and create no opportunity", async () => {
  let creates = 0;
  const conflictDeps = deps({
    bindIdentity: async () => {
      throw new FenceMintError(
        409,
        "contact_opportunity_job_conflict",
        "conflicting mapping",
      );
    },
    createStampedOpportunity: async () => {
      creates++;
      return {} as FenceMintOpportunity;
    },
  });
  const error = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(),
        actorId: "user-1",
        deps: conflictDeps,
      }),
    FenceMintError,
  );
  assertEquals(error.code, "contact_opportunity_job_conflict");
  assertEquals(creates, 0);
});

Deno.test("Supabase reservation failure produces no GHL side effect", async () => {
  let ghlCalls = 0;
  const failedDeps = deps({
    reserve: async () => {
      throw new FenceMintError(
        503,
        "mint_persistence_failed",
        "reserve failed",
      );
    },
    getContact: async () => {
      ghlCalls++;
      return { id: "contact-1" };
    },
  });
  const error = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(),
        actorId: "user-1",
        deps: failedDeps,
      }),
    FenceMintError,
  );
  assertEquals(error.code, "mint_persistence_failed");
  assertEquals(ghlCalls, 0);
});

Deno.test("GHL failure leaves the reserved ledger retryable and creates no job", async () => {
  let completes = 0;
  const failedDeps = deps({
    createStampedOpportunity: async () => {
      throw new FenceMintError(
        502,
        "ghl_opportunity_create_failed",
        "GHL unavailable",
      );
    },
    findStampedOpportunity: async () => null,
    complete: async () => {
      completes++;
      return canonical();
    },
  });
  const error = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(),
        actorId: "user-1",
        deps: failedDeps,
      }),
    FenceMintError,
  );
  assertEquals(error.code, "ghl_opportunity_create_failed");
  assertEquals(completes, 0);
});

Deno.test("partial retry with recorded opportunity skips contact and GHL round trips", async () => {
  let ghlCalls = 0;
  const partialDeps = deps({
    reserve: async () =>
      progress({
        state: "opportunity_created",
        executor: true,
        contactId: "contact-1",
        opportunityId: "opp-1",
      }),
    bindIdentity: async () =>
      progress({
        state: "opportunity_created",
        executor: false,
        contactId: "contact-1",
        opportunityId: "opp-1",
      }),
    getContact: async () => {
      ghlCalls++;
      return { id: "contact-1" };
    },
    findStampedOpportunity: async () => {
      ghlCalls++;
      return null;
    },
    createStampedOpportunity: async () => {
      ghlCalls++;
      return {} as FenceMintOpportunity;
    },
  });
  const minted = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: partialDeps,
  });
  assertEquals(minted.jobNumber, "SWF-26001");
  assertEquals(ghlCalls, 0);
});

Deno.test("existing cloud job reuse returns revision token and does not transfer scope_json", async () => {
  const existing = canonical("existing_contact_job_reused");
  const existingDeps = deps({
    bindIdentity: async () =>
      progress({ state: "complete", canonical: existing, executor: false }),
  });
  const reused = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: existingDeps,
  });
  assertEquals(reused.jobId, "job-1");
  assertEquals(reused.revision.requiresLoad, true);
  assertEquals(reused.revision.scopeHash, null);
  assertEquals("scopeJson" in reused, false);
});

Deno.test("bind-time convergence stops execution and replays the canonical owner", async () => {
  let creates = 0;
  let records = 0;
  let completes = 0;
  let polled: string | null = null;
  const convergedDeps = deps({
    // Both devices reserved under different identity keys, so both are told to
    // execute. Only the contact lock taken at bind time converges them.
    reserve: async ({ input: request }) =>
      progress({ ownerRequestId: request.requestId, executor: true }),
    bindIdentity: async () =>
      progress({
        ownerRequestId: REQUEST_B,
        state: "contact_resolved",
        joined: true,
        executor: false,
        contactId: "contact-1",
      }),
    awaitCanonical: async ({ ownerRequestId }) => {
      polled = ownerRequestId;
      return canonical();
    },
    createStampedOpportunity: async () => {
      creates++;
      return {} as FenceMintOpportunity;
    },
    recordOpportunity: async () => {
      records++;
      return progress();
    },
    complete: async () => {
      completes++;
      return canonical();
    },
  });

  const minted = await executeFenceJobMint({
    input: input(REQUEST_A),
    actorId: "user-1",
    deps: convergedDeps,
  });

  assertEquals(minted.jobId, "job-1");
  assertEquals(minted.mapping.outcome, "concurrent_request_reused");
  assertEquals(polled, REQUEST_B);
  assertEquals(creates, 0);
  assertEquals(records, 0);
  assertEquals(completes, 0);
});

Deno.test("bind-time convergence with an unfinished owner fails retryably, never as a second executor", async () => {
  let creates = 0;
  const stillRunningDeps = deps({
    bindIdentity: async () =>
      progress({
        ownerRequestId: REQUEST_B,
        state: "reserved",
        joined: true,
        executor: false,
        contactId: "contact-1",
      }),
    awaitCanonical: async () => null,
    createStampedOpportunity: async () => {
      creates++;
      return {} as FenceMintOpportunity;
    },
  });

  const error = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: stillRunningDeps,
      }),
    FenceMintError,
  );
  assertEquals(error.code, "mint_in_progress");
  assertEquals(creates, 0);
});

Deno.test("replay of a job whose scope moved on requires a load and carries no empty-scope cursor", async () => {
  const replayed = deps({
    reserve: async () =>
      progress({
        state: "complete",
        executor: false,
        canonical: {
          ...canonical("created"),
          scopeVersion: 5,
          scopeHash: null,
          requiresLoad: true,
        },
      }),
  });
  const result = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: replayed,
  });
  assertEquals(result.revision.requiresLoad, true);
  assertEquals(result.revision.scopeHash, null);
  assertEquals(result.revision.scopeVersion, 5);
});

Deno.test("migration derives replay freshness from the job, not the stored outcome", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  // The empty-scope cursor is only legal for a job whose scope is genuinely
  // still empty. scope_version alone is inert: save_scope never bumps it.
  assertStringIncludes(sql, "COALESCE(j.scope_json, '{}'::jsonb) = '{}'::jsonb");
  assertStringIncludes(sql, "AND j.scope_updated_at IS NULL");
  const jobJson = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public._fence_mint_job_json("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public._fence_mint_sorted_uuids("),
  );
  // Freshness must not rest on scope_version alone.
  assertEquals(
    /COALESCE\(j\.scope_version, 1\) = 1\s*\n\s*THEN '44136fa/.test(jobJson),
    false,
  );
  assertEquals(
    /'requiresLoad', p_outcome NOT IN \('created', 'deliberate_repeat_created'\)/
      .test(sql),
    false,
  );
  // The existing-job reuse branch must return before any later guard can leave
  // a conflict decision on a ledger row that already carries a job_id.
  assertStringIncludes(
    sql,
    "updated_at = now() WHERE request_id = v_request.request_id;\n    RETURN public._fence_mint_progress(v_request.request_id, false);",
  );
});

Deno.test("edge stamp recovery is contact scoped, fails closed and classes non-conflict codes correctly", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const recovery = source.slice(
    source.indexOf("findStampedOpportunity: async"),
    source.indexOf("createStampedOpportunity: async"),
  );
  // Recovery must not depend on GHL free-text search matching the stamp.
  assertEquals(/\bq:\s*fenceMintStamp/.test(recovery), false);
  assertStringIncludes(recovery, "contactId,");
  assertStringIncludes(recovery, "!paged.exhausted");
  assertStringIncludes(recovery, "mint_reconciliation_unproven");
  // Input and ledger-integrity failures must not be flattened into 409.
  assertStringIncludes(source, "invalid_mint_request: 400");
  assertStringIncludes(source, "mint_request_not_found: 500");
  assertStringIncludes(source, "mint_owner_not_found: 500");
  assertStringIncludes(source, "canonical_job_missing: 500");
  assertStringIncludes(source, "MINT_CONFLICT_STATUS[conflictCode] ?? 409");
});

Deno.test("takeover executor records failure on the owner row it actually drove", async () => {
  const stamped: string[] = [];
  await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: deps({
          // Expired-lease takeover: this caller joins REQUEST_B's ledger row but
          // is elected executor and runs every RPC against it.
          reserve: async () =>
            progress({
              ownerRequestId: REQUEST_B,
              joined: true,
              executor: true,
            }),
          bindIdentity: async ({ ownerRequestId, contact }) =>
            progress({
              ownerRequestId,
              state: "contact_resolved",
              contactId: contact.id,
            }),
          createStampedOpportunity: () => {
            throw new FenceMintError(502, "ghl_request_failed", "GHL exploded");
          },
          recordFailure: async ({ requestId }) => {
            stamped.push(requestId);
          },
        }),
      }),
    FenceMintError,
  );
  assertEquals(stamped, [REQUEST_B]);
});

Deno.test("bind-time joiner never stamps failure on the still-active owner", async () => {
  const stamped: string[] = [];
  await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: deps({
          bindIdentity: async ({ contact }) =>
            progress({
              ownerRequestId: REQUEST_B,
              state: "contact_resolved",
              joined: true,
              executor: false,
              contactId: contact.id,
            }),
          awaitCanonical: () => {
            throw new Error("network timeout while polling owner");
          },
          recordFailure: async ({ requestId }) => {
            stamped.push(requestId);
          },
        }),
      }),
    FenceMintError,
  );
  // The owner's lease must survive a joiner's transient poll failure.
  assertEquals(stamped, [REQUEST_A]);
});

Deno.test("opportunity pagination only claims exhaustion on a proven short page", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const paging = source.slice(
    source.indexOf("async function fetchOpportunityPages"),
    source.indexOf("return { opportunities, pagesScanned, total, exhausted }"),
  );
  // A stalled cursor or a missing cursor on a full page proves nothing.
  assertStringIncludes(paging, "if (rows.length < limit) { exhausted = true; break }");
  assertStringIncludes(
    paging,
    "if (newRows === 0 || !nextStartAfter || !nextStartAfterId) break",
  );
  assertEquals(
    /newRows === 0[^\n]*exhausted = true/.test(paging),
    false,
  );
});

Deno.test("failure telemetry is scoped to the owning tenant and an entitled caller", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  // Another tenant's requestId must not be able to expire a live lease.
  assertStringIncludes(sql, "AND r.org_id = p_org_id");
  assertStringIncludes(sql, "r.requested_by = p_actor_id");
  assertStringIncludes(
    sql,
    "AND public._fence_mint_root_owner(c.request_id) = r.request_id",
  );
  assertStringIncludes(
    sql,
    "record_fence_job_mint_failure(uuid, text, text, uuid, uuid, uuid) TO service_role",
  );
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "p_org_id: input.organisationId,");
  assertStringIncludes(source, "p_actor_id: authUserId,");
});

Deno.test("reserve classes an opportunity collision as a conflict, not a server error", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const reserve = sql.slice(
    sql.indexOf("FUNCTION public.reserve_fence_job_mint"),
    sql.indexOf("FUNCTION public.get_fence_job_mint_progress"),
  );
  // Only a real request row justifies replaying progress; its absence means the
  // opportunity reservation index rejected the insert.
  assertStringIncludes(
    reserve,
    "IF EXISTS (SELECT 1 FROM public.fence_job_mint_requests WHERE request_id = p_request_id) THEN",
  );
  assertStringIncludes(reserve, "'code', 'opportunity_mapping_conflict'");
});

Deno.test("complete preserves the bound existing job even after its status moves on", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const complete = sql.slice(
    sql.indexOf("FUNCTION public.complete_fence_job_mint"),
    sql.indexOf("FUNCTION public.record_fence_job_mint_failure"),
  );
  // A retry must reuse the bound job rather than fall through to a fresh mint.
  assertStringIncludes(complete, "ELSIF v_request.job_id IS NOT NULL THEN");
  assertStringIncludes(
    complete,
    "WHERE id = v_request.job_id AND org_id = v_request.org_id FOR UPDATE",
  );
  // Broken identity ends the branch typed, never by re-binding a new job.
  assertStringIncludes(complete, "'code', 'bound_job_identity_conflict'");
  assertStringIncludes(complete, "'code', 'bound_job_missing'");
  const boundBranch = complete.slice(
    complete.indexOf("ELSIF v_request.job_id IS NOT NULL THEN"),
    complete.indexOf("SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_jobs"),
  );
  assertEquals(/next_job_number|INSERT INTO public\.jobs/.test(boundBranch), false);
});

Deno.test("migration contract has narrow projections, uniqueness and no outbound communication", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  assertEquals(/SELECT\s+\*/i.test(sql), false);
  assertEquals(/RETURNING\s+\*/i.test(sql), false);
  assertStringIncludes(sql, "uq_jobs_org_type_ghl_opportunity");
  assertStringIncludes(sql, "fence_job_mint_locks");
  assertStringIncludes(sql, "'communication_sent', false");
  assertEquals(/send_quote|send_sms|send_email/i.test(sql), false);
});

Deno.test("an unproven stamp scan fails closed without creating a duplicate opportunity", async () => {
  let creates = 0;
  let recordedFailure: string | null = null;
  const failure = await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: deps({
          // An ambiguous retry (a prior attempt is on record) is the only state
          // that reaches recovery at all.
          reserve: async () => progress({ attemptCount: 2 }),
          bindIdentity: async () =>
            progress({
              state: "contact_resolved",
              contactId: "contact-1",
              attemptCount: 2,
            }),
          findStampedOpportunity: () => {
            throw new FenceMintError(
              503,
              "mint_contact_scope_unsupported",
              "GHL ignored the contact scope filter",
            );
          },
          createStampedOpportunity: async () => {
            creates++;
            return {
              id: "opp-dupe",
              contactId: "contact-1",
              pipelineId: FENCE_PIPELINE_ID,
              name: fenceMintStamp(REQUEST_A),
            };
          },
          recordFailure: async ({ code }) => {
            recordedFailure = code;
          },
        }),
      }),
    FenceMintError,
  );
  // An absence that was never proven must never authorise a create.
  assertEquals(creates, 0);
  assertEquals(failure.status, 503);
  assertEquals(failure.code, "mint_contact_scope_unsupported");
  assertEquals(recordedFailure, "mint_contact_scope_unsupported");
});

Deno.test("progress resolves multi-hop ownership chains with cycle and depth guards", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const progressFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public._fence_mint_progress("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_fence_job_mint("),
  );
  // A bind-time join can repoint an owner that other requests already point at,
  // so ownership must be followed to its root rather than exactly one hop.
  assertStringIncludes(progressFn, "FOR v_hop IN 1..8 LOOP");
  assertStringIncludes(progressFn, "EXIT WHEN v_owner.owner_request_id IS NULL");
  assertStringIncludes(progressFn, "v_owner_id := v_owner.owner_request_id");
  // A cycle or an over-deep chain is ledger corruption, never "still in progress".
  assertStringIncludes(progressFn, "IF v_owner_id = ANY(v_seen) THEN");
  assertStringIncludes(progressFn, "'code', 'mint_owner_chain_corrupt'");
  assertEquals(
    progressFn.includes("WHERE request_id = v_request.owner_request_id"),
    false,
  );
});

Deno.test("delegated failure writes are bounded to a still-active child attempt", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.record_fence_job_mint_failure("),
  );
  // 'joined' is terminal, so a state-only bound never expires. The grant must
  // name the exact executing request and require the owner to still record it as
  // the elected lease holder.
  assertStringIncludes(fn, "WHERE c.request_id = p_executing_request_id");
  // Ownership must be matched against the resolved chain root: bind can repoint
  // an intermediate owner, so a two hop takeover executes on a root that is not
  // the executing row's direct owner_request_id.
  assertStringIncludes(
    fn,
    "AND public._fence_mint_root_owner(c.request_id) = r.request_id",
  );
  assertEquals(fn.includes("AND c.owner_request_id = r.request_id"), false);
  assertStringIncludes(
    fn,
    "AND r.lease_holder_request_id = p_executing_request_id",
  );
  // Keying the grant on an unexpired lease silently dropped the write whenever a
  // legitimate execution outran the 90s lease, so the real typed conflict never
  // reached joiners. Election identity, not expiry, bounds the grant.
  assertEquals(
    fn.includes("AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at > now()"),
    false,
  );
  assertEquals(
    fn.includes("AND c.state IN ('reserved', 'joined', 'contact_resolved', 'opportunity_created')"),
    false,
  );
  assertStringIncludes(fn, "AND r.org_id = p_org_id");
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "p_executing_request_id: executingRequestId ?? null,");
});

Deno.test("a dropped failure write is error-level only for an elected executor", async () => {
  const seen: Array<{ requestId: string; executing?: boolean }> = [];
  const record = async (
    args: { requestId: string; executing?: boolean },
  ) => {
    seen.push({ requestId: args.requestId, executing: args.executing });
  };

  await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: deps({
          reserve: async () =>
            progress({ ownerRequestId: REQUEST_B, joined: true, executor: true }),
          bindIdentity: async ({ ownerRequestId, contact }) =>
            progress({
              ownerRequestId,
              state: "contact_resolved",
              contactId: contact.id,
            }),
          createStampedOpportunity: () => {
            throw new FenceMintError(502, "ghl_request_failed", "GHL exploded");
          },
          recordFailure: record,
        }),
      }),
    FenceMintError,
  );

  await assertRejects(
    () =>
      executeFenceJobMint({
        input: input(REQUEST_A),
        actorId: "user-1",
        deps: deps({
          reserve: () => {
            throw new FenceMintError(
              409,
              "idempotency_key_reused",
              "requestId belongs to another caller",
            );
          },
          recordFailure: record,
        }),
      }),
    FenceMintError,
  );

  // The executor's dropped stamp is a real signal; a caller that never owned or
  // executed the row is routinely denied and must not be logged as an error.
  assertEquals(seen[0].executing, true);
  assertEquals(seen[1].executing === true, false);

  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(
    source,
    "if (executing && outcome === 'denied') console.error(line)",
  );
  assertStringIncludes(source, "else console.log(line)");
});

Deno.test("first execution never scans, an ambiguous retry recovers the committed stamp", async () => {
  let searches = 0;
  let creates = 0;
  const firstAttempt = deps({
    findStampedOpportunity: async () => {
      searches++;
      return null;
    },
    createStampedOpportunity: async ({ ownerRequestId, contact }) => {
      creates++;
      return {
        id: "opp-1",
        contactId: contact.id,
        pipelineId: FENCE_PIPELINE_ID,
        name: fenceMintStamp(ownerRequestId),
      };
    },
  });
  await executeFenceJobMint({
    input: input(REQUEST_A),
    actorId: "user-1",
    deps: firstAttempt,
  });
  // The unverified contact-scoped listing must stay off the hot path entirely.
  assertEquals(searches, 0);
  assertEquals(creates, 1);

  let retrySearches = 0;
  let retryCreates = 0;
  const retry = await executeFenceJobMint({
    input: input(REQUEST_A),
    actorId: "user-1",
    deps: deps({
      reserve: async () => progress({ attemptCount: 3 }),
      bindIdentity: async ({ contact }) =>
        progress({
          state: "contact_resolved",
          contactId: contact.id,
          attemptCount: 3,
        }),
      findStampedOpportunity: async ({ ownerRequestId }) => {
        retrySearches++;
        return {
          id: "opp-committed",
          contactId: "contact-1",
          pipelineId: FENCE_PIPELINE_ID,
          name: fenceMintStamp(ownerRequestId),
        };
      },
      createStampedOpportunity: async () => {
        retryCreates++;
        throw new Error("must not create a duplicate on an ambiguous retry");
      },
      recordOpportunity: async ({ opportunity }) => {
        assertEquals(opportunity.id, "opp-committed");
        return progress({
          state: "opportunity_created",
          contactId: "contact-1",
          opportunityId: opportunity.id,
          attemptCount: 3,
        });
      },
    }),
  });
  assertEquals(retrySearches, 1);
  assertEquals(retryCreates, 0);
  assertEquals(retry.jobId, "job-1");
});

Deno.test("a takeover executor can be re-elected after a failed attempt", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const reserve = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_fence_job_mint("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.get_fence_job_mint_progress("),
  );
  // A takeover caller is recorded as 'joined'. Without re-election its retry
  // could never execute again and the requestId would be unmintable forever.
  assertStringIncludes(reserve, "ELSIF v_existing.state = 'joined' THEN");
  assertStringIncludes(reserve, "v_root_id := public._fence_mint_root_owner(p_request_id);");
  assertStringIncludes(
    reserve,
    "IF FOUND AND v_root.state IN ('reserved', 'contact_resolved', 'opportunity_created')",
  );
  assertStringIncludes(reserve, "v_executor := true;");
});

Deno.test("a completed opportunity re-entry replays the canonical job instead of conflicting", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const reserve = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_fence_job_mint("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.get_fence_job_mint_progress("),
  );
  // A completed mint keeps its opportunity reserved. A later requestId for the
  // same lead must resolve to that canonical job, never mint a duplicate and
  // never dead-end on an unresolvable 409.
  assertStringIncludes(reserve, "IF FOUND AND v_reserved.state = 'complete'");
  assertStringIncludes(
    reserve,
    "(p_contact_id IS NULL OR v_reserved.contact_id IS NULL OR v_reserved.contact_id = p_contact_id)",
  );
  assertStringIncludes(
    reserve,
    "RETURN public._fence_mint_progress(v_reserved.request_id, true, false)",
  );
  // Nothing here was concurrent, so the branch is flagged explicitly rather than
  // presenting as a live two-device race.
  assertStringIncludes(reserve, "jsonb_build_object('completedReentry', true)");
  // An identity mismatch remains a real conflict.
  assertStringIncludes(reserve, "'code', 'opportunity_mapping_conflict'");
});

Deno.test("stamp matching tolerates absent shape fields rather than discarding a real match", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // pipelineId/contactId are not proven to be returned by /opportunities/search.
  // Treating an absent field as a mismatch would hide a committed opportunity
  // and authorise the exact duplicate this guard exists to prevent.
  assertStringIncludes(
    source,
    "(!opportunity.contactId || opportunity.contactId === contactId)",
  );
  assertStringIncludes(
    source,
    "(!opportunity.pipelineId || opportunity.pipelineId === PIPELINES.fencing)",
  );
  // A row with no contact id is a shape variation, not proof the filter dropped.
  assertStringIncludes(
    source,
    "if (args.contactId && rowContactId && rowContactId !== args.contactId)",
  );
});

Deno.test("a saved scope makes a replay require a load rather than a blank cursor", async () => {
  const replayed = await executeFenceJobMint({
    input: input(REQUEST_A),
    actorId: "user-1",
    deps: deps({
      reserve: async () =>
        progress({
          state: "complete",
          executor: false,
          canonical: {
            ...canonical("idempotent_replay"),
            scopeVersion: 1,
            scopeHash: null,
            requiresLoad: true,
          },
        }),
    }),
  });
  // scope_version stays 1 through normal saves, so it can never be the signal
  // that lets a client resume from an empty scope.
  assertEquals(replayed.revision.scopeHash, null);
  assertEquals(replayed.revision.requiresLoad, true);
});

Deno.test("a newly created job is not stamped as having saved scope", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const complete = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_fence_job_mint("),
  );
  // The mint's own INSERT must leave scope_updated_at NULL. Stamping it at
  // creation contradicts the freshness predicate in the same transaction, so
  // every brand-new mint would return requiresLoad:true and a null scopeHash -
  // the inverse of the contract - and would also destroy the column's value as
  // a "scope has been saved" signal.
  assertStringIncludes(complete, "scope_json, scope_version, scope_updated_at");
  assertStringIncludes(complete, "'{}'::jsonb, 1, NULL");
  assertEquals(complete.includes("'{}'::jsonb, 1, now()"), false);
});

Deno.test("a freshly created job returns the empty-scope cursor without a load", async () => {
  const created = canonical("created");
  const result = await executeFenceJobMint({
    input: input(),
    actorId: "user-1",
    deps: deps({ complete: async () => created }),
  });
  assertEquals(result.mapping.outcome, "created");
  assertEquals(
    result.revision.scopeHash,
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
  assertEquals(result.revision.requiresLoad, false);
});

Deno.test("completed re-entry is reported distinctly from a concurrent race", async () => {
  const reused = await executeFenceJobMint({
    input: input(REQUEST_B),
    actorId: "user-1",
    deps: deps({
      reserve: async () =>
        progress({
          ownerRequestId: REQUEST_A,
          state: "complete",
          joined: true,
          completedReentry: true,
          executor: false,
          canonical: canonical("existing_opportunity_reused"),
        }),
    }),
  });
  // Re-entering a long-completed lead must never read as a live two-device race.
  assertEquals(reused.mapping.outcome, "completed_opportunity_reused");
  assertEquals(reused.mapping.canonicalOutcome, "existing_opportunity_reused");

  const raced = await executeFenceJobMint({
    input: input(REQUEST_B),
    actorId: "user-1",
    deps: deps({
      reserve: async () =>
        progress({
          ownerRequestId: REQUEST_A,
          state: "complete",
          joined: true,
          executor: false,
          canonical: canonical("existing_opportunity_reused"),
        }),
    }),
  });
  assertEquals(raced.mapping.outcome, "concurrent_request_reused");
});

Deno.test("every lease election records the elected holder", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const reserve = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_fence_job_mint("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.get_fence_job_mint_progress("),
  );
  // The delegated-write grant is keyed on election identity, so an election that
  // forgets to record its holder would silently strip a real executor's grant.
  const elections = reserve.split("v_executor := true;").length - 1;
  assertEquals(elections, 3);
  const holderWrites =
    reserve.split("lease_holder_request_id = p_request_id").length - 1;
  assertEquals(holderWrites, 3);
  // The first reserved row elects itself at insert time.
  assertStringIncludes(reserve, "attempt_count, lease_expires_at, lease_holder_request_id");
  assertStringIncludes(reserve, "1, now() + interval '90 seconds', p_request_id");
});

Deno.test("a dropped failure write is reported rather than read as success", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  // The RPC must report whether the stamp landed, and the old void signature has
  // to be dropped before the return type can change.
  assertStringIncludes(
    sql,
    "DROP FUNCTION IF EXISTS public.record_fence_job_mint_failure(uuid, text, text, uuid, uuid, uuid);",
  );
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.record_fence_job_mint_failure("),
  );
  assertStringIncludes(fn, ") RETURNS text");
  assertStringIncludes(fn, "RETURN 'applied';");
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "fence_mint_failure_write_dropped");
});

Deno.test("benign failure-write races are not reported as operator errors", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260721000001_fence_job_mint.sql",
      import.meta.url,
    ),
  );
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.record_fence_job_mint_failure("),
  );
  // A boolean conflated a stranded executor with two expected races: the root
  // completing concurrently (the outer UPDATE excludes state 'complete'), and a
  // competing takeover that legitimately overwrote lease_holder_request_id.
  assertStringIncludes(fn, "RETURN 'already_complete';");
  assertStringIncludes(fn, "RETURN 'lease_revoked';");
  assertStringIncludes(fn, "RETURN 'no_row';");
  assertStringIncludes(fn, "RETURN 'denied';");
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Only a rejected write from the elected executor strands joiners, so that is
  // the sole error-level case.
  assertStringIncludes(
    source,
    "if (executing && outcome === 'denied') console.error(line)",
  );
  assertEquals(source.includes("if (executing) console.error(line)"), false);
});

Deno.test("the recovery scan is bounded by wall clock inside the mint lease", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Page count alone does not bound elapsed time. A scan that outruns the 90s
  // lease lets a second executor be elected while this one still reconciles.
  assertStringIncludes(source, "if (Date.now() - startedAt >= budgetMs) break");
  assertStringIncludes(source, "budgetMs: 30000,");
  // Budget exhaustion must leave the absence unproven, never authorise a create.
  assertStringIncludes(source, "if (!exact.length && !paged.exhausted)");
});
