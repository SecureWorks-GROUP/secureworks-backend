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
 * The orchestration is driven over INJECTED primitives (the real wiring reuses
 * execute_ses_invoice_revision, execute_ses_release_revision and the exact-once
 * effect ledger unchanged), so its control flow is exercised hermetically. The
 * final test walks the intended flow end to end: an already-approved exact
 * release -> unified release -> per-route proofs on a stateful fake ledger.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyUnifiedReleaseFailure,
  runUnifiedSesRelease,
  type UnifiedReleaseDeps,
  type UnifiedReleaseMember,
} from "./ses_unified_release.ts";
import { SesActionError } from "./ses_reporting_actions.ts";
import { sesRefusal } from "./ses_reporting_refusals.ts";

const HASH =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";

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

Deno.test("T11 routine key is denied and nothing is authorised or sent", async () => {
  const sim = makeSim();
  const error = await assertRejects(
    () =>
      runUnifiedSesRelease(
        { mode: "routine", user: null },
        { release_revision_id: "r1" },
        sim.deps,
      ),
    SesActionError,
  );
  assertEquals((error as SesActionError).status, 403);
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
        { mode: "api_key", user: null },
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

Deno.test("T11 AC6: partial delivery retains Approved and a retry re-runs ONLY the missing route", async () => {
  const sim = makeSim({ failRoute: "invoice" });

  // Attempt 1: report + photo confirm, invoice fails (transport uncertain).
  const first = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    { release_revision_id: "r1", expected_release_content_hash: HASH },
    sim.deps,
  );
  assertEquals(first.state, "approved_retained");
  if (first.state === "approved_retained") {
    assertEquals(first.retryable, true);
    assertEquals(first.confirmed_route_kinds.sort(), ["photo", "report"]);
    assertEquals(first.pending_route_kinds, ["invoice"]);
  }
  // The release was put back to Approved (never left dispatching).
  assertEquals(sim.retainCount(), 1);

  // Attempt 2 (retry): only the missing invoice route dispatches.
  const second = await runUnifiedSesRelease(
    { mode: "api_key", user: null },
    { release_revision_id: "r1", expected_release_content_hash: HASH },
    sim.deps,
  );
  assertEquals(second.state, "released");
  assertEquals([...sim.confirmed].sort(), ["invoice", "photo", "report"]);
  // Confirmed routes were NEVER resent: report/photo dispatched exactly once,
  // invoice dispatched twice (the failed attempt then the retry).
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
