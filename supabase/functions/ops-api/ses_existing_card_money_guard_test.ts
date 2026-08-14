// deno-lint-ignore-file no-import-prefix no-explicit-any
/**
 * The existing-money guard AT THE TWO APPROVE ACTIONS.
 *
 * A refusal that displays but does not stop is worse than none, so these drive
 * the real exported actions through an in-memory client rather than reading the
 * source. They pin four things a source grep cannot:
 *
 *   1. Each approve action THROWS `invoice_exists_unbound`, naming the money.
 *   2. A card with a bound DRAFT is untouched at both.
 *   3. ORDERING: a caller that would ALSO fail a later authority check still
 *      surfaces the MONEY refusal, so moving the guard behind that check fails.
 *   4. Cycle scope: prior-cycle money and a no-additional-charge member are
 *      outside the guard — a prior-cycle terminal state must never silence, or
 *      answer, a current-cycle question.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveSesInvoiceRevisionAction,
  approveSesReleaseRevisionAction,
  loadSesCockpitDocket,
  SesActionError,
} from "./ses_reporting_actions.ts";
import { buildSesCockpitView } from "./ses_review_cockpit.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000099";
const JOB_ID = "208450c0-7161-4b30-9514-66226b054609";
const DOCKET_ID = "6a55da20-0000-4000-8000-000000000002";
const DOCKET_HASH = "sha256:current-docket";
const OBLIGATION_ID = "68e5432f-0000-4000-8000-000000000001";
const RELEASE_ID = "7c0f0000-0000-4000-8000-000000000003";
const USER = { id: "user-1", role: "admin", email: "captain@example.test" };

const PAID_INVOICE = {
  xero_invoice_id: "xero-850",
  invoice_number: "INV-0850",
  reference: "MLB-26565",
  status: "PAID",
  invoice_type: "ACCREC",
  job_id: JOB_ID,
  total: 882.2,
  created_at: "2026-07-01T00:00:00.000Z",
};

interface Fixture {
  invoices?: Array<Record<string, any>>;
  detail?: Record<string, any> | null;
  binding?: Record<string, any> | null;
  pricingDisposition?: string;
  operatorClass?: string | null;
}

function fixtureClient(opts: Fixture = {}) {
  const invoices = opts.invoices ?? [PAID_INVOICE];
  const detail = opts.detail === undefined
    ? { external_ref: "MLB-26565", reattend_count: 0, last_reattend_at: null }
    : opts.detail;
  const obligation = {
    id: OBLIGATION_ID,
    job_id: JOB_ID,
    state: "proposed",
    pricing_disposition: opts.pricingDisposition ?? "priced_from_canon",
    proposal: { totals: { inc: 561 } },
    duplicate_probe: { allows_create: true, ambiguity: "none" },
    blockers: [],
    ...(opts.binding ? { xero_binding: opts.binding } : {}),
  };
  const docket = {
    id: DOCKET_ID,
    job_id: JOB_ID,
    stage: "pre_xero",
    output_content_hash: DOCKET_HASH,
    invoice_obligation_revision_id: OBLIGATION_ID,
    attendance_cycle_ids: ["cycle-1"],
    pre_xero_docs_ready: true,
    envelope: {
      v2: {
        classification: {
          family: "own_template_roof",
          job_number: "SWMS-26841",
        },
        items: {},
      },
    },
    email_drafts: {},
    review_spec: {},
    blockers: [],
  };

  function rowsFor(table: string, filters: Record<string, any>): any[] {
    switch (table) {
      case "makesafe_docket_revisions_current":
      case "makesafe_docket_revisions":
        return [docket];
      case "makesafe_readiness_current_v2":
        return [{
          job_id: JOB_ID,
          readiness_revision: "ready-1",
          dependency_generation: 1,
          ready: true,
          blockers: [],
        }];
      case "makesafe_invoice_obligation_revisions":
      case "makesafe_invoice_obligation_revisions_current":
        return [obligation];
      case "makesafe_job_details":
        return detail ? [detail] : [];
      case "xero_invoices":
        if (filters.job_id) {
          return invoices.filter((row) => row.job_id === filters.job_id);
        }
        if (filters.xero_invoice_id) {
          return invoices.filter((row) =>
            row.xero_invoice_id === filters.xero_invoice_id
          );
        }
        return invoices;
      case "ses_release_operators":
        return opts.operatorClass === null
          ? []
          : [{ operator_class: opts.operatorClass ?? "captain" }];
      case "makesafe_release_revisions":
        return [{
          id: RELEASE_ID,
          state: "proposed",
          created_at: "2026-08-14T00:00:00.000Z",
          readiness_bindings: [{
            job_id: JOB_ID,
            readiness_revision: "ready-1",
            dependency_generation: 1,
          }],
        }];
      case "makesafe_release_revision_members":
        // The action reads by release id; the send-progress probe reads by
        // job_id and must find nothing so progress classifies as "none".
        return filters.release_revision_id
          ? [{
            release_revision_id: RELEASE_ID,
            ordinal: 0,
            job_id: JOB_ID,
            docket_revision_id: DOCKET_ID,
            invoice_obligation_revision_id: OBLIGATION_ID,
          }]
          : [];
      default:
        return [];
    }
  }

  return {
    from(table: string) {
      const filters: Record<string, any> = {};
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          filters[col] = val;
          return builder;
        },
        in: () => builder,
        not: () => builder,
        or: () => builder,
        like: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: rowsFor(table, filters)[0] ?? null,
            error: null,
          }),
        single: () =>
          Promise.resolve({
            data: rowsFor(table, filters)[0] ?? null,
            error: null,
          }),
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: rowsFor(table, filters), error: null })
            .then(resolve, reject),
      };
      return builder;
    },
    rpc: () =>
      Promise.resolve({
        data: null,
        error: { message: "no approval may be recorded in these tests" },
      }),
  };
}

const jwtAuth = { mode: "jwt" as const, user: USER };

async function refusalFrom(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SesActionError) return error.refusal;
    return { thrown: error };
  }
  return null;
}

function approveInvoice(client: any, auth: any = jwtAuth) {
  return approveSesInvoiceRevisionAction(client as any, auth, {
    org_id: ORG_ID,
    job_id: JOB_ID,
    includes_authorise: false,
    expected_docket_revision_id: DOCKET_ID,
    expected_invoice_obligation_revision_id: OBLIGATION_ID,
    expected_output_content_hash: DOCKET_HASH,
  });
}

function approveRelease(client: any, auth: any = jwtAuth) {
  return approveSesReleaseRevisionAction(client as any, auth, {
    org_id: ORG_ID,
    release_revision_id: RELEASE_ID,
  });
}

Deno.test("APPROVE INVOICE refuses a card whose money already exists, and names it", async () => {
  const refusal = await refusalFrom(() => approveInvoice(fixtureClient()));
  assertEquals(refusal?.code, "invoice_exists_unbound");
  assertStringIncludes(refusal.fact, "INV-0850");
  assertStringIncludes(refusal.fact, "882.20");
});

Deno.test("SEND IT refuses the same card, with the money named rather than a generic hold", async () => {
  const refusal = await refusalFrom(() => approveRelease(fixtureClient()));
  assertEquals(refusal?.code, "invoice_exists_unbound");
  assertStringIncludes(refusal.fact, "INV-0850");
  assert(
    !JSON.stringify(refusal).includes("Bind the real AUTHORISED Xero PDF"),
    "the generic route refusal must not mask the money",
  );
});

Deno.test("ORDERING: the money refusal beats a caller who would also fail the authority check", async () => {
  // An api_key caller cannot approve at all. If the guard ever moves behind
  // `canRecordSesApproval`, the authority refusal surfaces instead and this
  // fails — which is the reorder-proof a source grep cannot give.
  const refusal = await refusalFrom(() =>
    approveInvoice(fixtureClient(), { mode: "api_key" as const })
  );
  assertEquals(refusal?.code, "invoice_exists_unbound");

  const released = await refusalFrom(() =>
    approveRelease(fixtureClient({ operatorClass: null }))
  );
  assertEquals(released?.code, "invoice_exists_unbound");
});

Deno.test("a card with a bound DRAFT is UNAFFECTED at both actions", async () => {
  const binding = {
    xero_invoice_id: "xero-1115",
    invoice_number: "INV-1115",
    status: "DRAFT",
    total: 464.75,
  };
  for (
    const run of [
      () => approveInvoice(fixtureClient({ binding })),
      () => approveRelease(fixtureClient({ binding })),
    ]
  ) {
    const refusal = await refusalFrom(run);
    assert(
      refusal?.code !== "invoice_exists_unbound",
      "a bound card must never hit the money guard",
    );
  }
});

Deno.test("PRIOR-CYCLE money does not refuse a re-attendance's current cycle", async () => {
  const client = fixtureClient({
    detail: {
      external_ref: "MLB-26565",
      reattend_count: 1,
      last_reattend_at: "2026-08-01T00:00:00.000Z",
    },
    invoices: [PAID_INVOICE], // created 2026-07-01, before the boundary
  });
  const refusal = await refusalFrom(() => approveInvoice(client));
  assert(
    refusal?.code !== "invoice_exists_unbound",
    "an earlier cycle's legitimate invoice is not this cycle's money",
  );
});

Deno.test("CURRENT-cycle money on a re-attendance still refuses", async () => {
  const client = fixtureClient({
    detail: {
      external_ref: "MLB-26565",
      reattend_count: 1,
      last_reattend_at: "2026-08-01T00:00:00.000Z",
    },
    invoices: [{ ...PAID_INVOICE, created_at: "2026-08-03T00:00:00.000Z" }],
  });
  const refusal = await refusalFrom(() => approveInvoice(client));
  assertEquals(refusal?.code, "invoice_exists_unbound");
});

Deno.test("an UNKNOWN cycle still refuses — this question fails closed", async () => {
  const client = fixtureClient({
    detail: {
      external_ref: "MLB-26565",
      reattend_count: 1,
      last_reattend_at: null,
    },
    invoices: [{ ...PAID_INVOICE, created_at: null }],
  });
  const refusal = await refusalFrom(() => approveInvoice(client));
  assertEquals(refusal?.code, "invoice_exists_unbound");
});

Deno.test("a no_additional_charge member is outside the HARD STOP at SEND IT", async () => {
  const refusal = await refusalFrom(() =>
    approveRelease(
      fixtureClient({ pricingDisposition: "no_additional_charge" }),
    )
  );
  assert(
    refusal?.code !== "invoice_exists_unbound",
    "a member that mints nothing cannot double-bill",
  );
});

Deno.test("...and that exemption does NOT reach the cockpit", async () => {
  // Half of the pair that stops the exemption drifting back into the shared
  // producer: taking the refusal off a mint-adjacent surface is a card becoming
  // more approvable, which this control may never do. The other half is the
  // money guard at APPROVE INVOICE, pinned by the priced-disposition tests
  // above — a no-charge card cannot prove it, because that action refuses on
  // the disposition first.
  const docket = await loadSesCockpitDocket(
    fixtureClient({ pricingDisposition: "no_additional_charge" }) as any,
    JOB_ID,
  );
  const cockpit = buildSesCockpitView(docket);
  assert(
    cockpit.verdict.blockers.some((blocker) =>
      blocker.code === "invoice_exists_unbound"
    ),
    "the cockpit must still name the unbound money on a no-charge card",
  );
  assertEquals(cockpit.verdict.clean, false);
  assertEquals(cockpit.controls.send_it.enabled, false);
});

Deno.test("APPROVE INVOICE refuses a no-charge card on the DISPOSITION, not the money", async () => {
  // Named for what actually fires. Asserting only "something refused" here
  // would pass with the money guard deleted, which is no proof at all.
  const refusal = await refusalFrom(() =>
    approveInvoice(
      fixtureClient({ pricingDisposition: "no_additional_charge" }),
    )
  );
  assertEquals(refusal?.code, undefined);
  assertStringIncludes(refusal.fact, "no additional charge");
});
