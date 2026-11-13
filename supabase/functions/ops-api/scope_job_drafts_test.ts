import { deepStrictEqual as assertEquals } from "node:assert/strict";
import {
  prepareScopeDraftsAfterFreeze,
  scopeJobDraftsAction,
} from "./scope_job_drafts.ts";
import {
  releaseScopeJobDraftsOnAcceptance,
  releasesScopeDraftOnStatus,
} from "../_shared/scope_freeze/release_scope_job_drafts.ts";
import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";

// Generated identifiers and synthetic money only, no operational records.
const job = crypto.randomUUID();
const revision = crypto.randomUUID();
const org = crypto.randomUUID();
const body = { job_id: job, scope_revision_id: revision };
const actor = { staff: true, orgId: org };
const singlePayer = {
  job_id: job,
  scope_revision_id: revision,
  outcome: "single_payer",
  parties: [],
};

Deno.test("scope freeze handoff: persisted draft or explicit hold accompanies the saved revision", async () => {
  const stored = {
    work_order: { id: crypto.randomUUID(), labour_total_ex_gst: 27.41 },
  };
  const result = await prepareScopeDraftsAfterFreeze(
    {
      rpc: (name: string, args: unknown) => {
        assertEquals(args, {
          p_job_id: job,
          p_scope_revision_id: revision,
          p_org_id: org,
        });
        if (name === "register_scope_payer_parties") {
          return { data: singlePayer, error: null };
        }
        assertEquals(name, "prepare_scope_job_drafts");
        return { data: stored, error: null };
      },
    },
    body,
    actor,
  );
  assertEquals(result, {
    status: 200,
    data: { ...stored, payer_parties: singlePayer },
  });
  assertEquals(
    await prepareScopeDraftsAfterFreeze(
      { rpc: () => ({ error: { message: "scope_drafts_work_order_sealed" } }) },
      body,
      actor,
    ),
    { status: 409, data: { code: "scope_drafts_work_order_sealed" } },
  );
  assertEquals(
    await prepareScopeDraftsAfterFreeze(
      {
        rpc: () => {
          throw new Error("private provider detail");
        },
      },
      body,
      actor,
    ),
    { status: 503, data: { code: "scope_drafts_unavailable" } },
  );
});

Deno.test("scope drafts: staff/org/method and input checks write nothing", async () => {
  const client = {
    rpc: () => {
      throw new Error("must not reach persistence");
    },
  };
  for (
    const caller of [{ staff: false, orgId: org }, { staff: true, orgId: null }]
  ) {
    assertEquals(
      (await scopeJobDraftsAction(
        client,
        "prepare_scope_job_drafts",
        "POST",
        body,
        caller,
      )).status,
      403,
    );
  }
  assertEquals(
    (await scopeJobDraftsAction(
      client,
      "prepare_scope_job_drafts",
      "GET",
      body,
      actor,
    )).status,
    405,
  );
  for (
    const extra of [{ accepted: true }, { org_id: org }, { ex_gst: 1 }, {
      pricing_json: {},
    }]
  ) {
    assertEquals(
      (await scopeJobDraftsAction(client, "prepare_scope_job_drafts", "POST", {
        ...body,
        ...extra,
      }, actor)).status,
      400,
    );
  }
});

Deno.test("scope drafts: retained response and server organisation pass through without recalculation", async () => {
  const stored = {
    ...body,
    invoices: [{
      id: crypto.randomUUID(),
      payer_id: "__client__",
      ex_gst: null,
    }],
    amounts_confirmed: false,
    xero_writes: false,
    sent: false,
    payment_links: false,
  };
  for (const action of ["prepare_scope_job_drafts", "read_scope_job_drafts"]) {
    const client = {
      rpc: (name: string, args: unknown) => {
        assertEquals(args, {
          p_job_id: job,
          p_scope_revision_id: revision,
          p_org_id: org,
        });
        if (
          action === "prepare_scope_job_drafts" &&
          name === "register_scope_payer_parties"
        ) return { data: singlePayer, error: null };
        assertEquals(name, action);
        return { data: stored, error: null };
      },
    };
    const result = await scopeJobDraftsAction(
      client,
      action,
      "POST",
      body,
      actor,
    );
    assertEquals(result.status, 200);
    assertEquals(
      await result.json(),
      action === "read_scope_job_drafts"
        ? {
          ...stored,
          capabilities: {
            approve_price: false,
            approve_work_order: false,
            authority: null,
            reason: "approver_identity_missing",
          },
        }
        : { ...stored, payer_parties: singlePayer },
    );
  }
});

Deno.test("scope drafts: a prepare registers each sealed payer as a job party, after the drafts are saved", async () => {
  const registered = {
    job_id: job,
    scope_revision_id: revision,
    outcome: "registered",
    parties: [
      {
        payer_id: "__client__",
        source_party_key: "primary",
        outcome: "party_adopted",
      },
      { payer_id: "nb-1", source_party_key: "nb-1", outcome: "party_inserted" },
    ],
  };
  const calls: string[] = [];
  const result = await scopeJobDraftsAction(
    {
      rpc: (name: string) => {
        calls.push(name);
        return name === "register_scope_payer_parties"
          ? { data: registered, error: null }
          : { data: { work_order: null }, error: null };
      },
    },
    "prepare_scope_job_drafts",
    "POST",
    body,
    actor,
  );
  assertEquals(result.status, 200);
  assertEquals((await result.json()).payer_parties, registered);
  assertEquals(calls, [
    "prepare_scope_job_drafts",
    "register_scope_payer_parties",
  ]);
});

Deno.test("scope drafts: a payer registration refusal or fault keeps the saved drafts and names the code", async () => {
  for (
    const [fault, code] of [
      [
        { error: { message: "scope_payer_parties_legacy_unmatched" } },
        "scope_payer_parties_legacy_unmatched",
      ],
      [
        { error: { message: "party_adopt_ambiguous" } },
        "party_adopt_ambiguous",
      ],
      [
        { error: { message: "provider detail must remain private" } },
        "scope_payer_parties_unavailable",
      ],
      [{ data: null, error: null }, "scope_payer_parties_unavailable"],
      ["throw", "scope_payer_parties_unavailable"],
    ] as const
  ) {
    const stored = { work_order: { id: crypto.randomUUID() } };
    const result = await scopeJobDraftsAction(
      {
        rpc: (name: string) => {
          if (name !== "register_scope_payer_parties") {
            return { data: stored, error: null };
          }
          if (fault === "throw") throw new Error("private provider detail");
          return fault;
        },
      },
      "prepare_scope_job_drafts",
      "POST",
      body,
      actor,
    );
    assertEquals(result.status, 200);
    assertEquals(await result.json(), {
      ...stored,
      payer_parties: { outcome: "refused", code },
    });
  }
});

Deno.test("scope drafts: a refused prepare registers no payer", async () => {
  const calls: string[] = [];
  const result = await scopeJobDraftsAction(
    {
      rpc: (name: string) => {
        calls.push(name);
        return {
          data: null,
          error: { message: "scope_drafts_revision_stale" },
        };
      },
    },
    "prepare_scope_job_drafts",
    "POST",
    body,
    actor,
  );
  assertEquals(result.status, 409);
  assertEquals(calls, ["prepare_scope_job_drafts"]);
});

Deno.test("scope drafts: the read says what the signed-in caller may approve, from the database rule only", async () => {
  const approver = crypto.randomUUID();
  for (
    const [authority, error, expected] of [
      ["approver_list", null, {
        approve_price: true,
        approve_work_order: true,
        authority: "approver_list",
        reason: null,
      }],
      ["owner", null, {
        approve_price: true,
        approve_work_order: true,
        authority: "owner",
        reason: null,
      }],
      [null, null, {
        approve_price: false,
        approve_work_order: false,
        authority: null,
        reason: "approver_required",
      }],
      [null, { code: "57014" }, {
        approve_price: false,
        approve_work_order: false,
        authority: null,
        reason: "approvers_unreadable",
      }],
    ] as const
  ) {
    const calls: string[] = [];
    const client = {
      rpc: (name: string, args: unknown) => {
        calls.push(name);
        if (name === "owner_approval_authority") {
          assertEquals(args, { p_user: approver });
          return Promise.resolve({ data: authority, error });
        }
        return Promise.resolve({ data: { ...body }, error: null });
      },
    };
    const result = await scopeJobDraftsAction(
      client,
      "read_scope_job_drafts",
      "POST",
      body,
      { ...actor, approver: { userId: approver, via: "session" } },
    );
    assertEquals(result.status, 200);
    assertEquals((await result.json()).capabilities, expected);
    assertEquals(calls, ["read_scope_job_drafts", "owner_approval_authority"]);
  }
});

Deno.test("scope drafts: missing, stale, wrong-org and read faults stay distinct", async () => {
  for (
    const [message, status, code] of [
      ["scope_drafts_not_found", 404, "scope_drafts_not_found"],
      ["scope_drafts_revision_stale", 409, "scope_drafts_revision_stale"],
      ["scope_drafts_job_forbidden", 403, "scope_drafts_job_forbidden"],
      ["provider detail must remain private", 503, "scope_drafts_unavailable"],
    ] as const
  ) {
    const result = await scopeJobDraftsAction(
      { rpc: () => ({ data: null, error: { message } }) },
      "read_scope_job_drafts",
      "POST",
      body,
      actor,
    );
    assertEquals(result.status, status);
    assertEquals(await result.json(), { code });
  }
});

function acceptanceClient(
  options: {
    source: string | null;
    unreadable?: boolean;
    released?: boolean;
    release?: unknown;
  },
) {
  const calls: Array<{ action: string; args: unknown }> = [];
  const events: unknown[] = [];
  return {
    calls,
    events,
    rpc: (action: string, args: unknown) => {
      calls.push({ action, args });
      return { data: options.release ?? { released: true }, error: null };
    },
    from: (table: string) => {
      const data = table === "scope_job_draft_sets"
        ? {
          scope_revision_id: revision,
          released_at: options.released ? "fixture-time" : null,
        }
        : table === "job_documents"
        ? [{ id: "fixture-document" }]
        : table === "quote_revisions"
        ? [{
          job_document_id: "fixture-document",
          scope_revision_id: options.source,
        }]
        : table === "jobs"
        ? { expected_costs: { scope_revision_id: revision } }
        : [];
      const result = {
        data,
        error: options.unreadable && table === "quote_revisions"
          ? { message: "fixture read fault" }
          : null,
        count: Array.isArray(data) ? data.length : undefined,
      };
      const query = {
        select: (..._args: unknown[]) => query,
        eq: (..._args: unknown[]) => query,
        not: (..._args: unknown[]) => query,
        in: (..._args: unknown[]) => query,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        insert: (event: unknown) => {
          events.push(event);
          return Promise.resolve({ error: null });
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return query;
    },
  };
}

Deno.test("scope drafts: acceptance uses the accepted source, never silently substitutes the prepared source", async () => {
  const accepted = crypto.randomUUID();
  const client = acceptanceClient({ source: accepted });
  assertEquals(await releaseScopeJobDraftsOnAcceptance(client, job), {
    state: "released",
  });
  // Ruling 14: the taken quote options are applied to the same revision first.
  assertEquals(client.calls, [{
    action: "apply_quote_options_to_scope_drafts",
    args: { p_job_id: job, p_scope_revision_id: accepted },
  }, {
    action: "release_scope_job_drafts",
    args: {
      p_job_id: job,
      p_scope_revision_id: accepted,
      p_legacy: false,
    },
  }]);
  // PostgreSQL refuses when this id differs from the prepared revision.
  const fault = acceptanceClient({ source: revision, unreadable: true });
  assertEquals(await releaseScopeJobDraftsOnAcceptance(fault, job), {
    state: "release_unavailable",
  });
  assertEquals(fault.calls, []);
  assertEquals(fault.events.length, 1);
  const done = acceptanceClient({ source: revision, released: true });
  assertEquals(await releaseScopeJobDraftsOnAcceptance(done, job), {
    state: "already_released",
  });
  assertEquals(done.calls, []);
});

Deno.test("scope drafts: acceptance with an owner approval missing is retained and held, not a fault", async () => {
  const accepted = crypto.randomUUID();
  const client = acceptanceClient({
    source: accepted,
    release: {
      released: false,
      held: true,
      reason: "owner_approval_required",
      acceptance_recorded: true,
      missing: ["price_approval", "work_order_approval"],
    },
  });
  assertEquals(await releaseScopeJobDraftsOnAcceptance(client, job), {
    state: "held_for_owner_approval",
    missing: ["price_approval", "work_order_approval"],
  });
  assertEquals(client.calls.map((c) => c.action), ["apply_quote_options_to_scope_drafts", "release_scope_job_drafts"]);
  // The database writes the held audit; the helper adds no fault event.
  assertEquals(client.events, []);
});

// TK-S28: acceptance releases the draft whatever open status it left the job
// in. A card moved straight to Deposit or Scheduled, or moved on by the
// deposit after a held release, used to keep a draft nobody could approve.
Deno.test("scope drafts: every open status past acceptance asks for the release; nothing else does", () => {
  for (const status of JOB_WORK_ORDER_OPEN_STATUSES) {
    assertEquals(
      releasesScopeDraftOnStatus(status, JOB_WORK_ORDER_OPEN_STATUSES),
      status !== "partially_accepted",
      status,
    );
  }
  for (
    const status of [
      "draft",
      "quoted",
      "cancelled",
      "lost",
      "complete",
      "invoiced",
      "get_review",
      "",
      null,
      undefined,
      42,
    ]
  ) {
    assertEquals(
      releasesScopeDraftOnStatus(status, JOB_WORK_ORDER_OPEN_STATUSES),
      false,
      String(status),
    );
  }
});

Deno.test("scope drafts: the open statuses that release match the database list", async () => {
  // release_scope_job_drafts (20261110200000) reads job_work_order_open_statuses();
  // the TypeScript set that decides when to ask must be the same list.
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261012130000_job_work_orders.sql",
      import.meta.url,
    ),
  );
  const body = sql.slice(
    sql.indexOf("FUNCTION public.job_work_order_open_statuses()"),
  );
  const list = body.slice(body.indexOf("ARRAY["), body.indexOf("]::text[]"));
  const database = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assertEquals([...JOB_WORK_ORDER_OPEN_STATUSES].sort(), database);
  const release = await Deno.readTextFile(
    new URL(
      "../../migrations/20261110200000_scope_draft_release_open_status.sql",
      import.meta.url,
    ),
  );
  assertEquals(
    release.includes(
      "j.status = 'partially_accepted'\n    OR NOT (j.status = ANY (public.job_work_order_open_statuses()))",
    ),
    true,
  );
});

Deno.test("scope drafts: the office status writer asks for the release on every open status, not only accepted", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const start = source.indexOf("async function updateJobStatus(");
  const writer = source.slice(
    start,
    source.indexOf("\nasync function ", start + 10),
  );
  assertEquals(
    writer.includes(
      "status === 'accepted' ||\n    ((data?.type === 'fencing' || data?.type === 'patio') &&\n      releasesScopeDraftOnStatus(status, JOB_WORK_ORDER_OPEN_STATUSES))\n  ) {\n    await releaseScopeJobDraftsOnAcceptance(client, jId)",
    ),
    true,
  );
  assertEquals(
    /if \(status === 'accepted'\) \{\s*const \{ releaseScopeJobDraftsOnAcceptance \}/
      .test(writer),
    false,
  );
});
