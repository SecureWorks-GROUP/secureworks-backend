// deno-lint-ignore-file no-import-prefix no-explicit-any
/**
 * Option B create_ses_invoice_draft acceptance: mint DRAFT without human click,
 * full ACCREC dup guard first, authorise/send still blocked, PO-sibling allow.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSesInvoiceDraftAction,
  executeSesInvoiceRevisionAction,
  SesActionError,
  type SesXeroGateway,
} from "./ses_reporting_actions.ts";
import { resolveExistingInvoice } from "./makesafe_send_pack.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000099";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const OBLIGATION_ID = "00000000-0000-4000-8000-0000000000aa";

const proposal = {
  schema: "secureworks.makesafe.invoice-proposal/v1" as const,
  invoice_obligation_id: "obligation-1",
  invoice_obligation_revision_id: OBLIGATION_ID,
  job_id: JOB_ID,
  attendance_cycle_ids: ["cycle-1"],
  pricing_disposition: "priced_from_canon" as const,
  pricing_canon_version: "test-canon",
  company: "Major Loss Builders",
  reference: "MLB-24732",
  contact_name: "Major Loss Builders",
  currency: "AUD" as const,
  lines: [{
    description: "Make-safe attendance",
    quantity: 1,
    unit_price: 300,
    account_code: "210",
    evidence: { source: "test" },
  }],
  totals: { ex: 300, inc: 330 },
  guard_result: { hard_failures: [], warnings: [] },
  duplicate_probe: {
    allows_create: true,
    match_tier: null,
    ambiguity: "none",
  },
  xero: null,
};

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_ID,
    obligation_id: "obligation-1",
    job_id: JOB_ID,
    state: "proposed",
    pricing_disposition: "priced_from_canon",
    blockers: [],
    proposal,
    xero_binding: null,
    reference: "MLB-24732",
    ...overrides,
  };
}

function mintClient(opts: {
  revision?: Record<string, unknown>;
} = {}) {
  const revision = opts.revision || revisionRow();
  const effects = new Map<string, Record<string, any>>();
  return {
    from(table: string) {
      let mode = "select";
      let updatePayload: any = null;
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        range: async () => ({ data: [], error: null }),
        update: (payload: any) => {
          mode = "update";
          updatePayload = payload;
          return builder;
        },
        upsert: () => {
          mode = "upsert";
          return builder;
        },
        maybeSingle: async () => {
          if (
            mode === "update" &&
            (table === "makesafe_invoice_obligation_revisions" ||
              table === "makesafe_invoice_obligation_revisions_current")
          ) {
            Object.assign(revision, updatePayload || {});
            return { data: { id: revision.id }, error: null };
          }
          if (mode === "upsert" && table === "xero_invoices") {
            return { data: { id: "mirror-1" }, error: null };
          }
          if (
            table === "makesafe_invoice_obligation_revisions" ||
            table === "makesafe_invoice_obligation_revisions_current"
          ) {
            return { data: revision, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: [], error: null }).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "claim_ses_external_effect_v1") {
        const effect = { ...args.p_effect, state: "reserved" };
        effects.set(effect.operation_key, effect);
        return {
          data: {
            effect,
            claim_mode: "dispatch",
            duplicate_refused: false,
          },
          error: null,
        };
      }
      if (name === "transition_ses_external_effect_v1") {
        const current = effects.get(args.p_operation_key) || {
          operation_key: args.p_operation_key,
          state: args.p_from_state,
        };
        const next = {
          ...current,
          state: args.p_to_state,
          ...(args.p_detail || {}),
        };
        effects.set(args.p_operation_key, next);
        return { data: next, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
      }),
    },
  };
}

function draftGateway(
  created?: Partial<{
    xero_invoice_id: string;
    invoice_number: string;
    status: string;
    reference: string;
    total: number;
  }>,
): SesXeroGateway & { createCalls: number; authoriseCalls: number } {
  let createCalls = 0;
  let authoriseCalls = 0;
  const invoice = {
    xero_invoice_id: "xero-draft-1",
    invoice_number: "INV-9001",
    status: "DRAFT",
    reference: "MLB-24732 | token",
    total: 330,
    ...created,
  };
  return {
    get createCalls() {
      return createCalls;
    },
    get authoriseCalls() {
      return authoriseCalls;
    },
    async createDraft() {
      createCalls++;
      return invoice;
    },
    async reconcileCreate() {
      return createCalls > 0 ? [invoice] : [];
    },
    async authorise() {
      authoriseCalls++;
      throw new Error("draft mint must not authorise");
    },
    async reconcileAuthorise() {
      return [];
    },
    async fetchAuthorisedPdf() {
      // Preferred mint shape: store the real Xero DRAFT PDF for the Invoice tab.
      // Minimal valid PDF magic so storeSesXeroInvoicePdfBytes accepts it.
      return new TextEncoder().encode("%PDF-1.4 draft fixture");
    },
  } as any;
}

const apiKeyAuth = {
  mode: "api_key" as const,
  user: null,
};

Deno.test("A: create_ses_invoice_draft mints DRAFT with api_key and no approval", async () => {
  const gateway = draftGateway();
  const client = mintClient();
  const result = await createSesInvoiceDraftAction(
    client as any,
    apiKeyAuth,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "skill@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [] },
  );
  assertEquals(result.state, "xero_draft_created");
  assertEquals(result.invoice_create_dispatched, true);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice.status, "DRAFT");
  assertEquals(gateway.createCalls, 1);
  assertEquals(gateway.authoriseCalls, 0);
  // Invoice tab preferred shape: real Xero DRAFT PDF stored at mint.
  assertEquals(typeof result.draft_pdf?.content_hash, "string");
  assertStringIncludes(String(result.draft_pdf?.content_hash || ""), "sha256:");
  assertEquals(typeof result.draft_pdf?.object_key, "string");
  assertStringIncludes(
    String(result.draft_pdf?.object_key || ""),
    "xero-invoice-pdfs/",
  );
});

Deno.test("A7: an unfetchable Xero PDF never fails the mint or invents one", async () => {
  const gateway = draftGateway();
  gateway.fetchAuthorisedPdf = () => {
    throw new Error("Xero PDF endpoint returned 503");
  };
  const client = mintClient();
  const revision = await client.from("makesafe_invoice_obligation_revisions")
    .select("*").eq("id", OBLIGATION_ID).maybeSingle();
  const result = await createSesInvoiceDraftAction(
    client as any,
    apiKeyAuth,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "skill@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [] },
  );
  // The DRAFT is still minted and bound; only the PDF pointer is absent, which
  // the Invoice tab reports as "not available yet" rather than substituting a
  // local tax-invoice render.
  assertEquals(result.state, "xero_draft_created");
  assertEquals(result.draft_pdf, null);
  assertEquals(gateway.authoriseCalls, 0);
  const binding = (revision.data as any).xero_binding || {};
  assertEquals(binding.xero_invoice_id, "xero-draft-1");
  assertEquals(binding.status, "DRAFT");
  assertEquals("pdf_object_key" in binding, false);
  assertEquals("pdf_content_hash" in binding, false);
});

Deno.test("A2: a plain user JWT can never mint a Xero DRAFT", async () => {
  const gateway = draftGateway();
  let fetchCalled = false;
  const err = await assertRejects(
    () =>
      createSesInvoiceDraftAction(
        mintClient() as any,
        {
          mode: "jwt",
          user: { id: "user-1", email: "installer@test", role: "trade" },
        },
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "installer@test",
        },
        gateway,
        {
          fetchAllAccrecInvoices: async () => {
            fetchCalled = true;
            return [];
          },
        },
      ),
    SesActionError,
  );
  assertEquals(err.status, 403);
  assertEquals(gateway.createCalls, 0);
  assertEquals(fetchCalled, false);
});

Deno.test("A3: an admin-owner JWT may mint", async () => {
  const gateway = draftGateway();
  const result = await createSesInvoiceDraftAction(
    mintClient() as any,
    {
      mode: "jwt",
      user: { id: "user-2", email: "captain@test", role: "admin" },
    },
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "captain@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [] },
  );
  assertEquals(result.state, "xero_draft_created");
  assertEquals(gateway.createCalls, 1);
});

Deno.test("A4: a superseded or void-linked revision never mints a draft", async () => {
  for (const state of ["superseded", "void_linked"]) {
    const gateway = draftGateway();
    const err = await assertRejects(
      () =>
        createSesInvoiceDraftAction(
          mintClient({ revision: revisionRow({ state }) }) as any,
          apiKeyAuth,
          {
            org_id: ORG_ID,
            job_id: JOB_ID,
            invoice_obligation_revision_id: OBLIGATION_ID,
            actor: "skill@test",
          },
          gateway,
          { fetchAllAccrecInvoices: async () => [] },
        ),
      SesActionError,
    );
    assertEquals(err.status, 409);
    assertStringIncludes(err.message, "no longer current");
    assertEquals(gateway.createCalls, 0);
  }
});

Deno.test("A5: re-mint over this obligation's own DRAFT repairs a missing binding", async () => {
  const revision = revisionRow({ xero_binding: null });
  const client = mintClient({ revision });
  const gateway = draftGateway();
  const mirrored = {
    xero_invoice_id: "xero-draft-1",
    invoice_number: "INV-9001",
    status: "DRAFT",
    reference: "MLB-24732",
    job_id: JOB_ID,
    invoice_type: "ACCREC",
    invoice_obligation_revision_id: OBLIGATION_ID,
    ses_external_token: "SES-existing-token",
  };
  const result = await createSesInvoiceDraftAction(
    client as any,
    apiKeyAuth,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "skill@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [mirrored] },
  );
  assertEquals(result.skipped, true);
  assertEquals(gateway.createCalls, 0);
  assertEquals(revision.state, "create_executed");
  assertEquals(
    (revision.xero_binding as any)?.xero_invoice_id,
    "xero-draft-1",
  );
});

Deno.test("A6: an AUTHORISED invoice on this obligation refuses instead of skipping", async () => {
  const gateway = draftGateway();
  const authorised = {
    xero_invoice_id: "xero-auth-1",
    invoice_number: "INV-AUTH",
    status: "AUTHORISED",
    reference: "MLB-24732",
    job_id: JOB_ID,
    invoice_type: "ACCREC",
    invoice_obligation_revision_id: OBLIGATION_ID,
  };
  const err = await assertRejects(
    () =>
      createSesInvoiceDraftAction(
        mintClient() as any,
        apiKeyAuth,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "skill@test",
        },
        gateway,
        { fetchAllAccrecInvoices: async () => [authorised] },
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "INV-AUTH");
  assertStringIncludes(err.message, "AUTHORISED");
  assertEquals(gateway.createCalls, 0);
});

Deno.test("F1: live ACCREC on same job_id refuses second mint without createDraft", async () => {
  const gateway = draftGateway();
  const live = {
    xero_invoice_id: "xero-existing",
    invoice_number: "INV-0812",
    status: "DRAFT",
    reference: "MLB-99999",
    job_id: JOB_ID,
    invoice_type: "ACCREC",
  };
  const err = await assertRejects(
    () =>
      createSesInvoiceDraftAction(
        mintClient() as any,
        apiKeyAuth,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "skill@test",
        },
        gateway,
        { fetchAllAccrecInvoices: async () => [live] },
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "INV-0812");
  assertStringIncludes(err.message, "DRAFT");
  assertStringIncludes(err.message, "job_id");
  assertEquals(gateway.createCalls, 0);
});

Deno.test("F2: VOIDED only does not block mint", async () => {
  const gateway = draftGateway();
  const voided = {
    xero_invoice_id: "xero-void",
    invoice_number: "INV-OLD",
    status: "VOIDED",
    reference: "MLB-24732",
    job_id: JOB_ID,
    invoice_type: "ACCREC",
  };
  const result = await createSesInvoiceDraftAction(
    mintClient() as any,
    apiKeyAuth,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "skill@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [voided] },
  );
  assertEquals(result.state, "xero_draft_created");
  assertEquals(gateway.createCalls, 1);
});

Deno.test("F3: PO-sibling different PO must NOT block; identical full ref blocks", async () => {
  // Sibling other job has PO-suffixed ref; our card is base MLB-24732.
  const sibling = {
    xero_invoice_id: "xero-sibling",
    invoice_number: "INV-SIBLING",
    status: "AUTHORISED",
    reference: "MLB-24732PO-55712",
    job_id: "other-job",
    invoice_type: "ACCREC",
  };
  assertEquals(
    resolveExistingInvoice([sibling], JOB_ID, "MLB-24732"),
    null,
    "PO-sibling must not block base ref",
  );

  const gateway = draftGateway();
  const result = await createSesInvoiceDraftAction(
    mintClient() as any,
    apiKeyAuth,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "skill@test",
    },
    gateway,
    { fetchAllAccrecInvoices: async () => [sibling] },
  );
  assertEquals(result.state, "xero_draft_created");
  assertEquals(gateway.createCalls, 1);

  const identical = {
    ...sibling,
    reference: "MLB-24732",
    invoice_number: "INV-DUP",
  };
  const gateway2 = draftGateway();
  const err = await assertRejects(
    () =>
      createSesInvoiceDraftAction(
        mintClient() as any,
        apiKeyAuth,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "skill@test",
        },
        gateway2,
        { fetchAllAccrecInvoices: async () => [identical] },
      ),
    SesActionError,
  );
  assertStringIncludes(err.message, "INV-DUP");
  assertEquals(gateway2.createCalls, 0);
});

Deno.test("F4: dup guard runs before createDraft (create never called on hit)", async () => {
  let fetchCalled = false;
  let createCalled = false;
  const gateway = draftGateway();
  const origCreate = gateway.createDraft.bind(gateway);
  gateway.createDraft = async (payload, context) => {
    createCalled = true;
    return origCreate(payload, context);
  };
  await assertRejects(() =>
    createSesInvoiceDraftAction(
      mintClient() as any,
      apiKeyAuth,
      {
        org_id: ORG_ID,
        job_id: JOB_ID,
        invoice_obligation_revision_id: OBLIGATION_ID,
        actor: "skill@test",
      },
      gateway,
      {
        fetchAllAccrecInvoices: async () => {
          fetchCalled = true;
          return [{
            xero_invoice_id: "x",
            invoice_number: "INV-1",
            status: "AUTHORISED",
            reference: "MLB-24732",
            job_id: "other",
            invoice_type: "ACCREC",
          }];
        },
      },
    )
  );
  assertEquals(fetchCalled, true);
  assertEquals(createCalled, false);
});

Deno.test("B: execute without approval still refuses after mint path exists", async () => {
  const gateway = draftGateway();
  const client = {
    from(table: string) {
      if (table === "makesafe_invoice_obligation_revisions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: revisionRow({ state: "create_executed" }),
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "makesafe_revision_approvals_current_v2") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
    async rpc() {
      return { data: null, error: { message: "unused" } };
    },
  };
  const err = await assertRejects(
    () =>
      executeSesInvoiceRevisionAction(
        client as any,
        { mode: "api_key", user: null },
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "executor",
        },
        gateway,
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message.toLowerCase(), "approve");
});

Deno.test("shared resolveExistingInvoice: job_id always blocks regardless of PO", () => {
  const hit = resolveExistingInvoice(
    [{
      job_id: JOB_ID,
      status: "DRAFT",
      reference: "MLB-24732PO-99999",
      invoice_number: "INV-J",
      xero_invoice_id: "x1",
    }],
    JOB_ID,
    "MLB-24732",
  );
  assertEquals(hit?.match_method, "job_id");
  assertEquals(hit?.invoice_number, "INV-J");
});
