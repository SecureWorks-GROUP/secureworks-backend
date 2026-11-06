import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { scopeJobDraftsAction } from "./scope_job_drafts.ts";
import { releaseScopeJobDraftsOnAcceptance } from "../_shared/scope_freeze/release_scope_job_drafts.ts";

// Generated identifiers and synthetic money only, no operational records.
const job = crypto.randomUUID();
const revision = crypto.randomUUID();
const org = crypto.randomUUID();
const body = { job_id: job, scope_revision_id: revision };
const actor = { staff: true, orgId: org };

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
        assertEquals(name, action);
        assertEquals(args, {
          p_job_id: job,
          p_scope_revision_id: revision,
          p_org_id: org,
        });
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
    assertEquals(await result.json(), stored);
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
  options: { source: string | null; unreadable?: boolean; released?: boolean },
) {
  const calls: Array<{ action: string; args: unknown }> = [];
  const events: unknown[] = [];
  return {
    calls,
    events,
    rpc: (action: string, args: unknown) => {
      calls.push({ action, args });
      return { data: { released: true }, error: null };
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
  await releaseScopeJobDraftsOnAcceptance(client, job);
  assertEquals(client.calls, [{
    action: "release_scope_job_drafts",
    args: {
      p_job_id: job,
      p_scope_revision_id: accepted,
      p_legacy: false,
    },
  }]);
  // PostgreSQL refuses when this id differs from the prepared revision.
  const fault = acceptanceClient({ source: revision, unreadable: true });
  await releaseScopeJobDraftsOnAcceptance(fault, job);
  assertEquals(fault.calls, []);
  assertEquals(fault.events.length, 1);
  const done = acceptanceClient({ source: revision, released: true });
  await releaseScopeJobDraftsOnAcceptance(done, job);
  assertEquals(done.calls, []);
});
