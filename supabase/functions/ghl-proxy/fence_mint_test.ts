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
  assertEquals(searches, 2);
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
  // The empty-scope cursor is only legal for a job still at its initial revision.
  assertStringIncludes(
    sql,
    "p_outcome IN ('created', 'deliberate_repeat_created') AND COALESCE(j.scope_version, 1) = 1",
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
  assertStringIncludes(sql, "WHERE c.owner_request_id = r.request_id");
  assertStringIncludes(
    sql,
    "record_fence_job_mint_failure(uuid, text, text, uuid, uuid) TO service_role",
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
