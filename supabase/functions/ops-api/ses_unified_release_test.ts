// deno-lint-ignore-file no-import-prefix require-await
/**
 * T11 (Harden SES v1, AC5/AC6/AC7): the unified authorise+send orchestration.
 *
 *   AC5  invoice authorisation fails  -> send nothing
 *   AC6  partial delivery failure     -> retain Approved + retry ONLY missing
 *                                        routes; confirmed routes never resent
 *   AC7  drift / stale / unapproved   -> hard refuse
 *   routine key                       -> denied
 *
 * Control-flow tests use injected primitives. Retry coverage uses the actual
 * createSupabaseSesEffectStore + executeSesExternalEffect wiring against a
 * mocked RPC implementation of the deployed claim/transition SQL contract; it
 * cannot redispatch through a transition the real ledger would reject.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyUnifiedReleaseFailure,
  createSupabaseUnifiedReleaseDeps,
  runUnifiedSesRelease,
  type UnifiedReleaseDeps,
  type UnifiedReleaseMember,
} from "./ses_unified_release.ts";
import {
  createSupabaseSesEffectStore,
  SesActionError,
} from "./ses_reporting_actions.ts";
import { sesRefusal } from "./ses_reporting_refusals.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesEffectState,
  type SesExternalEffect,
} from "./ses_external_effects.ts";

const HASH =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";

interface EffectLedgerBuilder {
  update(payload: Record<string, unknown>): EffectLedgerBuilder;
  eq(column: string, value: unknown): EffectLedgerBuilder;
  select(): EffectLedgerBuilder;
  maybeSingle(): Promise<{
    data: SesExternalEffect | null;
    error: { message: string } | null;
  }>;
  insert(): Promise<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
}

interface RetainApprovedBuilder {
  update(value: Record<string, unknown>): RetainApprovedBuilder;
  select(): RetainApprovedBuilder;
  eq(): RetainApprovedBuilder;
  maybeSingle(): Promise<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
}

function effectField(row: SesExternalEffect, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

// ── Pure classifier ──

Deno.test("T11 classify: some-but-not-all routes confirmed is a partial delivery", () => {
  assertEquals(
    classifyUnifiedReleaseFailure({
      refusal_code: "graph_outcome_unknown",
      confirmed_before: 0,
      confirmed_after: 2,
      required_count: 3,
    }),
    "partial_delivery",
  );
});

Deno.test("T11 classify: all routes confirmed (but execute still failed) is partial/retryable", () => {
  assertEquals(
    classifyUnifiedReleaseFailure({
      refusal_code: "graph_outcome_unknown",
      confirmed_before: 3,
      confirmed_after: 3,
      required_count: 3,
    }),
    "partial_delivery",
  );
});

Deno.test("T11 classify: a transport-uncertain code with no progress is still retryable", () => {
  assertEquals(
    classifyUnifiedReleaseFailure({
      refusal_code: "graph_outcome_unknown",
      confirmed_before: 0,
      confirmed_after: 0,
      required_count: 3,
    }),
    "partial_delivery",
  );
});

Deno.test("T11 classify: no progress + a validation code is a hard refuse", () => {
  assertEquals(
    classifyUnifiedReleaseFailure({
      refusal_code: "stale_review",
      confirmed_before: 0,
      confirmed_after: 0,
      required_count: 3,
    }),
    "hard_refuse",
  );
  assertEquals(
    classifyUnifiedReleaseFailure({
      refusal_code: "release_approval_missing",
      confirmed_before: 0,
      confirmed_after: 0,
      required_count: 3,
    }),
    "hard_refuse",
  );
});

Deno.test("T11 classify: stale or missing approval stays hard after partial progress", () => {
  for (const refusal_code of ["stale_review", "release_approval_missing"]) {
    assertEquals(
      classifyUnifiedReleaseFailure({
        refusal_code,
        confirmed_before: 0,
        confirmed_after: 2,
        required_count: 3,
      }),
      "hard_refuse",
    );
  }
});

// ── Orchestration over a stateful fake ledger ──

interface SimOptions {
  state?: string;
  contentHash?: string;
  required?: string[];
  members?: UnifiedReleaseMember[];
  invoiceFail?: boolean;
  failRoute?: string | null;
  failCode?: "graph_outcome_unknown" | "stale_review";
}

function makeSim(opts: SimOptions = {}) {
  const required = opts.required ?? ["report", "photo", "invoice"];
  const members: UnifiedReleaseMember[] = opts.members ?? [{
    job_id: "j1",
    invoice_obligation_revision_id: "o1",
    docket_revision_id: "d1",
    pricing_disposition: "priced_from_canon",
  }];
  const confirmed = new Set<string>();
  const dispatchLog: string[] = [];
  const authoriseLog: string[] = [];
  let retainCount = 0;
  let failRoute = opts.failRoute ?? null;
  const failCode = opts.failCode ?? "graph_outcome_unknown";

  const deps: UnifiedReleaseDeps = {
    loadRelease: async () => ({
      release_revision_id: "r1",
      content_hash: opts.contentHash ?? HASH,
      state: opts.state ?? "approved",
      members,
      required_route_kinds: required,
    }),
    authoriseMemberInvoice: async (member) => {
      authoriseLog.push(member.job_id);
      if (opts.invoiceFail) {
        return {
          ok: false,
          status: 409,
          refusal: sesRefusal(
            "xero_not_authorised",
            "Authorise the exact bound invoice, then resume.",
          ),
        };
      }
      return { ok: true, result: { status: "AUTHORISED" } };
    },
    // One executeRelease call = one runUnifiedSesRelease pass. It dispatches only
    // the routes not already confirmed (the exact-once ledger), so a retry can
    // never re-send a confirmed route.
    executeRelease: async () => {
      for (const kind of required) {
        if (confirmed.has(kind)) continue;
        dispatchLog.push(kind);
        if (failRoute === kind) {
          failRoute = null; // the fault clears so a retry proceeds
          return {
            kind: "failed",
            status: 409,
            refusal: sesRefusal(failCode, "Reconcile then retry."),
          };
        }
        confirmed.add(kind);
      }
      return { kind: "released", result: { state: "released" } };
    },
    readConfirmedRouteKinds: async () => [...confirmed],
    retainApproved: async () => {
      retainCount++;
    },
  };
  return {
    deps,
    confirmed,
    dispatchLog,
    authoriseLog,
    retainCount: () => retainCount,
  };
}

class RealRpcEffectLedger {
  rows = new Map<string, SesExternalEffect>();
  client = {
    from: (table: string) => {
      let updatePayload: Record<string, unknown> | null = null;
      const filters: Array<[string, unknown]> = [];
      const builder = {} as EffectLedgerBuilder;
      Object.assign(builder, {
        update: (payload: Record<string, unknown>) => {
          updatePayload = payload;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        select: () => builder,
        maybeSingle: async () => {
          if (table !== "ses_external_effects" || !updatePayload) {
            return { data: null, error: null };
          }
          const current = [...this.rows.values()].find((row) =>
            filters.every(([column, value]) =>
              String(effectField(row, column) ?? "") === String(value ?? "")
            )
          );
          if (!current) return { data: null, error: null };
          const next = { ...current, ...updatePayload } as SesExternalEffect;
          this.rows.set(next.operation_key, next);
          return { data: { ...next }, error: null };
        },
        insert: async () =>
          table === "ses_external_effect_events"
            ? { data: {}, error: null }
            : { data: null, error: { message: `unexpected insert ${table}` } },
      });
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_ses_external_effect_v1") {
        const effect = args.p_effect as Omit<SesExternalEffect, "state">;
        const current = this.rows.get(effect.operation_key);
        if (!current) {
          const reserved: SesExternalEffect = {
            ...effect,
            id: effect.operation_key,
            state: "reserved",
            lease_owner: String(args.p_lease_owner || ""),
            lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
          };
          this.rows.set(effect.operation_key, reserved);
          return {
            data: {
              effect: { ...reserved },
              claim_mode: "dispatch",
              duplicate_refused: false,
            },
            error: null,
          };
        }
        if (
          current.payload_hash !== effect.payload_hash ||
          current.effect_kind !== effect.effect_kind ||
          current.external_token !== effect.external_token
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message: "operation_key belongs to different immutable content",
            },
          };
        }
        return {
          data: {
            effect: { ...current },
            claim_mode: current.state === "confirmed"
              ? "confirmed"
              : "reconcile",
            duplicate_refused: true,
          },
          error: null,
        };
      }
      if (name !== "transition_ses_external_effect_v1") {
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      }
      const operationKey = String(args.p_operation_key || "");
      const from = String(args.p_from_state || "") as SesEffectState;
      const to = String(args.p_to_state || "") as SesEffectState;
      const current = this.rows.get(operationKey);
      if (!current || current.state !== from) {
        return {
          data: null,
          error: {
            code: "40001",
            message:
              "external effect state changed; reconcile existing operation",
          },
        };
      }
      const allowed =
        (from === "reserved" && ["dispatching", "failed"].includes(to)) ||
        (from === "dispatching" &&
          ["unknown", "confirmed", "failed"].includes(to)) ||
        (from === "unknown" && ["confirmed", "failed"].includes(to)) ||
        (from === "failed" &&
          ["unknown", "confirmed", "compensated"].includes(to)) ||
        (from === "confirmed" && to === "compensated");
      if (!allowed) {
        return {
          data: null,
          error: {
            code: "23514",
            message: `invalid external effect transition ${from} -> ${to}`,
          },
        };
      }
      const detail = (args.p_detail || {}) as Record<string, unknown>;
      const next: SesExternalEffect = {
        ...current,
        state: to,
        external_id: String(detail.external_id || current.external_id || "") ||
          null,
        provider_digest:
          (detail.provider_digest as Record<string, unknown> | undefined) ||
          current.provider_digest,
      };
      this.rows.set(operationKey, next);
      return { data: { ...next }, error: null };
    },
  };

  confirmedRouteKinds(releaseRevisionId: string): string[] {
    return [...this.rows.values()]
      .filter((row) =>
        row.release_revision_id === releaseRevisionId &&
        row.effect_kind === "route_send" && row.state === "confirmed"
      )
      .map((row) => String(row.route_kind));
  }
}

async function makeRealLedgerRetrySim() {
  const required = ["report", "photo", "invoice"] as const;
  const ledger = new RealRpcEffectLedger();
  const store = createSupabaseSesEffectStore(
    ledger.client as unknown as Parameters<
      typeof createSupabaseSesEffectStore
    >[0],
  );
  const dispatchLog: string[] = [];
  const providerByToken = new Map<string, { message_id: string }>();
  let invoiceFaultPending = true;
  let releaseState = "approved";
  let retainCount = 0;

  const effects = new Map<string, Awaited<ReturnType<typeof buildSesEffect>>>();
  for (const kind of required) {
    effects.set(
      kind,
      await buildSesEffect({
        org_id: "00000000-0000-4000-8000-000000000001",
        job_id: "10000000-0000-4000-8000-000000000001",
        effect_kind: "route_send",
        release_revision_id: "30000000-0000-4000-8000-000000000001",
        route_kind: kind,
        payload: { kind, frozen: true },
      }),
    );
  }

  const deps: UnifiedReleaseDeps = {
    loadRelease: async () => ({
      release_revision_id: "30000000-0000-4000-8000-000000000001",
      content_hash: HASH,
      state: releaseState,
      members: [{
        job_id: "10000000-0000-4000-8000-000000000001",
        invoice_obligation_revision_id: null,
        docket_revision_id: "20000000-0000-4000-8000-000000000001",
        pricing_disposition: "no_additional_charge",
      }],
      required_route_kinds: [...required],
    }),
    authoriseMemberInvoice: async () => ({
      ok: true,
      result: { skipped: true },
    }),
    executeRelease: async () => {
      releaseState = "dispatching";
      for (const kind of required) {
        const effect = effects.get(kind)!;
        const result = await executeSesExternalEffect({
          store,
          effect,
          payload: { kind, frozen: true },
          adapter: {
            async dispatch(
              _payload: { kind: string; frozen: boolean },
              context: { external_token: string },
            ) {
              dispatchLog.push(kind);
              if (kind === "invoice" && invoiceFaultPending) {
                invoiceFaultPending = false;
                throw new Error(
                  "attachment read failed before Graph accepted a draft",
                );
              }
              const sent = { message_id: `sent-${kind}` };
              providerByToken.set(context.external_token, sent);
              return sent;
            },
            reconcile(context: { external_token: string }) {
              const match = providerByToken.get(context.external_token);
              return Promise.resolve(match ? [match] : []);
            },
            identify(result: { message_id: string }) {
              return result.message_id;
            },
            digest(result: { message_id: string }) {
              return result;
            },
          },
          actor: "operator-1",
        });
        if (result.state === "refused") {
          return {
            kind: "failed",
            status: 409,
            refusal: result.refusal!,
          };
        }
      }
      releaseState = "released";
      return { kind: "released", result: { state: "released" } };
    },
    readConfirmedRouteKinds: async () =>
      ledger.confirmedRouteKinds(
        "30000000-0000-4000-8000-000000000001",
      ),
    retainApproved: async () => {
      retainCount++;
      if (releaseState !== "dispatching") {
        throw new Error(`CAS expected dispatching, got ${releaseState}`);
      }
      releaseState = "approved";
    },
  };
  return {
    deps,
    ledger,
    dispatchLog,
    releaseState: () => releaseState,
    retainCount: () => retainCount,
  };
}

Deno.test("T11 routine key is denied and nothing is authorised or sent", async () => {
  const sim = makeSim();
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "routine", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 403);
  assertEquals(sim.authoriseLog, []);
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 AC7: release content hash is required before loading or executing", async () => {
  const sim = makeSim();
  let loads = 0;
  const deps: UnifiedReleaseDeps = {
    ...sim.deps,
    loadRelease: async (id) => {
      loads++;
      return await sim.deps.loadRelease(id);
    },
  };
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        {
          release_revision_id: "r1",
          expected_release_content_hash: undefined,
        } as unknown as {
          release_revision_id: string;
          expected_release_content_hash: string;
        },
        deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 400);
  assertEquals(loads, 0);
  assertEquals(sim.authoriseLog, []);
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 AC7: a superseded release hard-refuses before authorise or send", async () => {
  const sim = makeSim({ state: "superseded" });
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  assertEquals(sim.authoriseLog, []);
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 AC7: a drifted release fingerprint hard-refuses before authorise or send", async () => {
  const sim = makeSim();
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        {
          release_revision_id: "r1",
          expected_release_content_hash: "sha256:wronghash",
        },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 409);
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  assertEquals(sim.authoriseLog, []);
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 AC7: an unapproved release state hard-refuses", async () => {
  const sim = makeSim({ state: "proposed" });
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        {
          mode: "jwt",
          user: { id: "operator-1", role: "admin", email: "op@example.test" },
        },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "release_approval_missing",
  );
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 AC5: invoice authorisation failure sends NOTHING", async () => {
  const sim = makeSim({ invoiceFail: true });
  await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  // Authorise was attempted; the release primitive was never reached.
  assertEquals(sim.authoriseLog, ["j1"]);
  assertEquals(sim.dispatchLog, []);
});

Deno.test("T11 full success releases every route", async () => {
  const sim = makeSim();
  const result = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    { release_revision_id: "r1", expected_release_content_hash: HASH },
    sim.deps,
  );
  assertEquals(result.state, "released");
  assertEquals([...sim.confirmed].sort(), ["invoice", "photo", "report"]);
});

Deno.test("T11 a no_additional_charge member is not authorised, and the release still sends", async () => {
  const sim = makeSim({
    members: [{
      job_id: "j1",
      invoice_obligation_revision_id: "o1",
      docket_revision_id: "d1",
      pricing_disposition: "no_additional_charge",
    }],
  });
  const result = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    { release_revision_id: "r1", expected_release_content_hash: HASH },
    sim.deps,
  );
  assertEquals(result.state, "released");
  assertEquals(sim.authoriseLog, []); // no invoice to authorise
});

Deno.test("T11 AC6 real ledger: unknown route redispatches while confirmed routes never resend", async () => {
  const sim = await makeRealLedgerRetrySim();
  const releaseId = "30000000-0000-4000-8000-000000000001";

  // Attempt 1: report + photo confirm, invoice fails (transport uncertain).
  const first = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    {
      release_revision_id: releaseId,
      expected_release_content_hash: HASH,
    },
    sim.deps,
  );
  assertEquals(first.state, "approved_retained");
  if (first.state === "approved_retained") {
    assertEquals(first.retryable, true);
    assertEquals(first.confirmed_route_kinds.sort(), ["photo", "report"]);
    assertEquals(first.pending_route_kinds, ["invoice"]);
  }
  // The release was put back to Approved and the real ledger persisted invoice
  // as unknown through a SQL-valid dispatching -> unknown transition.
  assertEquals(sim.retainCount(), 1);
  assertEquals(sim.releaseState(), "approved");
  const invoiceRow = [...sim.ledger.rows.values()].find((row) =>
    row.route_kind === "invoice"
  );
  assertEquals(invoiceRow?.state, "unknown");

  // Attempt 2: actual executeSesExternalEffect claims report/photo as confirmed.
  // Invoice reconciles the SAME token, finds no Draft/Sent Item, wins the legal
  // unknown -> failed CAS, then redispatches and confirms.
  const second = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    {
      release_revision_id: releaseId,
      expected_release_content_hash: HASH,
    },
    sim.deps,
  );
  assertEquals(second.state, "released");
  assertEquals(sim.releaseState(), "released");
  assertEquals(
    sim.ledger.confirmedRouteKinds(releaseId).sort(),
    ["invoice", "photo", "report"],
  );
  assertEquals(sim.dispatchLog.filter((k) => k === "report").length, 1);
  assertEquals(sim.dispatchLog.filter((k) => k === "photo").length, 1);
  assertEquals(sim.dispatchLog.filter((k) => k === "invoice").length, 2);
});

Deno.test("T11 AC7: a validation failure on the send path hard-refuses and unsticks the release", async () => {
  const sim = makeSim({ failRoute: "report", failCode: "stale_review" });
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  // Nothing confirmed, and the release was still put back to Approved.
  assert(sim.confirmed.size === 0);
  assertEquals(sim.retainCount(), 1);
});

Deno.test("T11 AC11: stale refusal stays hard after earlier routes confirmed", async () => {
  const sim = makeSim({ failRoute: "invoice", failCode: "stale_review" });
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  assertEquals([...sim.confirmed].sort(), ["photo", "report"]);
  assertEquals(sim.retainCount(), 1);
});

Deno.test("T11 AC6: a generic dispatch error is mapped only after release state returns to Approved", async () => {
  let releaseState = "approved";
  let retainCount = 0;
  const sim = makeSim();
  const deps: UnifiedReleaseDeps = {
    ...sim.deps,
    loadRelease: async () => ({
      release_revision_id: "r1",
      content_hash: HASH,
      state: releaseState,
      members: [],
      required_route_kinds: ["report"],
    }),
    executeRelease: async () => {
      releaseState = "dispatching";
      throw new Error("synthetic transport read fault");
    },
    retainApproved: async () => {
      retainCount++;
      if (releaseState !== "dispatching") throw new Error("CAS miss");
      releaseState = "approved";
    },
  };
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 500);
  assertEquals(releaseState, "approved");
  assertEquals(retainCount, 1);
  assert(
    String((error as SesActionError).refusal.fact).includes(
      "returned to Approved",
    ),
  );
});

Deno.test(
  "T11 AC6: unreadable post-failure route proofs retain Approved and never invent pending routes",
  async () => {
    let proofReads = 0;
    let retainCount = 0;
    const error = await assertRejects(
      () =>
        runUnifiedSesRelease(
          {
            mode: "jwt",
            user: {
              id: "operator-proof",
              email: "operator@example.test",
              role: "admin",
            },
          },
          {
            release_revision_id: "r-proof",
            expected_release_content_hash: HASH,
          },
          {
            loadRelease: async () => ({
              release_revision_id: "r-proof",
              content_hash: HASH,
              state: "approved",
              members: [{
                job_id: "job-proof",
                docket_revision_id: "d-proof",
                invoice_obligation_revision_id: null,
                pricing_disposition: "no_additional_charge",
              }],
              required_route_kinds: ["report", "invoice"],
            }),
            authoriseMemberInvoice: async () => ({
              ok: true as const,
              result: {},
            }),
            executeRelease: async () => ({
              kind: "failed" as const,
              status: 409,
              refusal: sesRefusal(
                "graph_outcome_unknown",
                "Reconcile then retry.",
              ),
            }),
            readConfirmedRouteKinds: async () => {
              proofReads++;
              if (proofReads === 1) return [];
              throw new SesActionError(
                503,
                sesRefusal(
                  "route_send_proof_unreadable",
                  "Retry when route proofs are readable.",
                ),
              );
            },
            retainApproved: async () => {
              retainCount++;
            },
          },
        ),
      SesActionError,
    );
    assertEquals(
      ((error as SesActionError).refusal as { code?: string }).code,
      "route_send_proof_unreadable",
    );
    assertEquals(retainCount, 1);
  },
);

Deno.test("T11 AC6: a transient failed retainApproved is retried and cannot leave dispatching", async () => {
  let retainCount = 0;
  let releaseState = "approved";
  const retainClient = {
    from(table: string) {
      assertEquals(table, "makesafe_release_revisions");
      let updateValue: Record<string, unknown> | null = null;
      const builder = {} as RetainApprovedBuilder;
      Object.assign(builder, {
        update: (value: Record<string, unknown>) => {
          updateValue = value;
          return builder;
        },
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (updateValue) {
            retainCount++;
            if (retainCount === 1) {
              return {
                data: null,
                error: { message: "transient PostgREST update failed" },
              };
            }
            releaseState = String(updateValue.state || "");
          }
          return {
            data: { id: "r1", state: releaseState },
            error: null,
          };
        },
      });
      return builder;
    },
  };
  type FactoryContext = Parameters<typeof createSupabaseUnifiedReleaseDeps>[2];
  const realDeps = createSupabaseUnifiedReleaseDeps(
    retainClient as unknown as Parameters<
      typeof createSupabaseUnifiedReleaseDeps
    >[0],
    {
      mode: "api_key",
      user: null,
    },
    {
      org_id: "org-1",
      actor: "operator-1",
      xeroGateway: {} as FactoryContext["xeroGateway"],
      mailGateway: {} as FactoryContext["mailGateway"],
      releaseXeroReader: {} as FactoryContext["releaseXeroReader"],
    },
  );
  const sim = makeSim();
  const deps: UnifiedReleaseDeps = {
    ...sim.deps,
    loadRelease: async () => ({
      release_revision_id: "r1",
      content_hash: HASH,
      state: releaseState,
      members: [],
      required_route_kinds: ["report"],
    }),
    executeRelease: async () => {
      releaseState = "dispatching";
      throw new Error("synthetic transport read fault");
    },
    retainApproved: realDeps.retainApproved,
  };
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 500);
  assertEquals(retainCount, 2);
  assertEquals(releaseState, "approved");
  assert(
    String((error as SesActionError).refusal.fact).includes(
      "returned to Approved",
    ),
  );
});

Deno.test("T11 AC6: a permanent retainApproved failure is surfaced after the checked retry", async () => {
  let retainCount = 0;
  const sim = makeSim();
  const deps: UnifiedReleaseDeps = {
    ...sim.deps,
    executeRelease: async () => {
      throw new Error("synthetic transport read fault");
    },
    retainApproved: async () => {
      retainCount++;
      throw new Error("PostgREST update failed");
    },
  };
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "api_key", user: null },
        { release_revision_id: "r1", expected_release_content_hash: HASH },
        deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 500);
  assertEquals(retainCount, 2);
  assertStringIncludes(
    String((error as SesActionError).refusal.fact),
    "Approved-state recovery could not be verified",
  );
});
