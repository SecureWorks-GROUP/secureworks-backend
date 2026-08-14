// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
/**
 * Already-created send recovery (SWMS-261116, 2026-08-14).
 *
 * The obligation is already `create_executed` with a bound Xero DRAFT that was
 * minted under a RETRY-keyed create effect. The PRIMARY create effect (no
 * artifact_hash — the identity the send path recomputes) was stranded at
 * state=unknown when a first mint tripped the portal-truth guard before any
 * invoice existed. Before the fix, execute_ses_invoice_revision re-derived that
 * primary effect and reconciled its external token, which no live invoice
 * carries, refusing xero_outcome_unknown (409) on every press — an unbreakable
 * loop. The client mislabels every 409 as "the pack changed".
 *
 * Post-fix: when the obligation is create_executed with a bound invoice id, the
 * send path adopts that exact invoice and authorises it. It never mints a second
 * invoice, and a genuinely stale review still refuses with stale_review.
 *
 * Also covers defect 2: a refused money-chain press writes a job_events row
 * carrying the refusal code and fact.
 */
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeSesInvoiceRevisionAction,
  SES_MONEY_ACTION_REFUSED_EVENT_TYPE,
  SesActionError,
  type SesXeroGateway,
  writeSesMoneyChainRefusalAudit,
} from "./ses_reporting_actions.ts";
import { sesSha256 } from "./ses_docket_envelope.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "b7abfb20-6ab3-41fb-b5af-d65491bca38c";
const OBLIGATION_ID = "61e73154-f662-5c0f-aeb5-af43fe9d5bbc";
const DOCKET_ID = "2694b696-bda7-51a0-8346-f5be64be8310";
const XERO_ID = "d0d0e746-0e9d-4b67-bc33-62cd6419019e";
const INVOICE_NUMBER = "INV-1161";
const REFERENCE = "MLB-27387PO-57525";
const TOTAL = 275;
const DEP_GEN = 18;
// The live card: readiness_revision is NULL on both the approval and the
// readiness view, so the stale-review comparison must not fire on it.
const READINESS_REV: string | null = null;
// The confirmed mint wrote this token onto the mirror. It is NOT the primary
// create-effect token the send path recomputes — that mismatch is the bug.
const CONFIRMED_MINT_TOKEN = "SES-1caed8c7-9bf3-50a8-8576-1c452c7ca1c5";

const PDF_BYTES = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2d,
  0x31,
  0x2e,
  0x34,
]); // %PDF-1.4

async function approvalContentHash(
  includesAuthorise: boolean,
): Promise<string> {
  // Exactly the object executeSesInvoiceRevisionAction recomputes and compares.
  return await sesSha256({
    action: "invoice",
    docket_revision_id: DOCKET_ID,
    invoice_obligation_revision_id: OBLIGATION_ID,
    readiness_revision: READINESS_REV,
    dependency_generation: DEP_GEN,
    includes_authorise: includesAuthorise,
  }, "SecureWorks:ses-approval-content:v1\n");
}

function obligationRow() {
  return {
    id: OBLIGATION_ID,
    job_id: JOB_ID,
    state: "create_executed",
    pricing_disposition: "priced_from_canon",
    blockers: [],
    proposal: {
      reference: REFERENCE,
      contact_name: "Major Loss Builders",
      lines: [{ description: "Make safe", quantity: 1, unit_amount: 250 }],
      totals: { inc: TOTAL },
    },
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "DRAFT",
      total: TOTAL,
      bound_at: "2026-08-07T06:43:51.099Z",
      pdf_object_key:
        `makesafe-docket-artifacts/${JOB_ID}/xero-invoice-pdfs/${XERO_ID}/INV-1161.pdf`,
      pdf_content_hash:
        "sha256:01abba60b37f24f70f6bfa513c14a62d9820a6c3837089dfdf762db9e73c3ba6",
      pdf_size_bytes: 52014,
      pdf_stored_at: "2026-08-14T05:18:08.864Z",
    },
  };
}

function mirrorRow() {
  return {
    id: "mirror-row-id",
    org_id: ORG_ID,
    job_id: JOB_ID,
    xero_invoice_id: XERO_ID,
    invoice_number: INVOICE_NUMBER,
    status: "DRAFT",
    total: TOTAL,
    reference: REFERENCE,
    reference_normalized: REFERENCE.toLowerCase().replace(/[^a-z0-9]/g, ""),
    invoice_type: "ACCREC",
    invoice_obligation_revision_id: OBLIGATION_ID,
    ses_external_token: CONFIRMED_MINT_TOKEN,
  };
}

function docketRow() {
  return {
    id: DOCKET_ID,
    job_id: JOB_ID,
    stage: "pre_xero",
    pre_xero_docs_ready: true,
    invoice_obligation_revision_id: OBLIGATION_ID,
    attendance_cycle_ids: ["cycle-1"],
    blockers: [],
    envelope: { v2: { classification: {}, items: {}, routing: {} } },
    email_drafts: {},
  };
}

/**
 * Mock Supabase client for the adopt → authorise → bind path. Every table read,
 * RPC, storage upload, and job_events insert the path performs is modelled here;
 * nothing reaches a real service.
 */
function makeClient(opts: {
  approval: Record<string, any>;
  docket?: Record<string, any>;
  gatewayState: { authorised: boolean };
  jobEvents: any[];
  mirrorStatus?: string;
  mirrorReadError?: boolean;
  mirrorUpserts?: any[];
}) {
  const docket = opts.docket || docketRow();
  const obligation = obligationRow();
  const mirror = mirrorRow();
  if (opts.mirrorStatus) mirror.status = opts.mirrorStatus;
  const effectsByKey = new Map<string, any>();

  function singleFor(table: string) {
    switch (table) {
      case "makesafe_invoice_obligation_revisions":
        return obligation;
      case "makesafe_docket_revisions_current":
        return docket;
      case "makesafe_readiness_current_v2":
        return {
          job_id: JOB_ID,
          readiness_revision: READINESS_REV,
          dependency_generation: DEP_GEN,
          ready: true,
        };
      case "makesafe_revision_approvals_current_v2":
        return opts.approval;
      case "xero_invoices":
        return mirror;
      default:
        return null;
    }
  }

  function arrayFor(table: string) {
    switch (table) {
      case "xero_invoices":
        return [mirror];
      default:
        return [];
    }
  }

  return {
    from(table: string) {
      let mutated = false;
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => {
          mutated = true;
          return builder;
        },
        upsert: (rows: any) => {
          mutated = true;
          if (table === "xero_invoices" && opts.mirrorUpserts) {
            for (const row of Array.isArray(rows) ? rows : [rows]) {
              opts.mirrorUpserts.push(row);
            }
          }
          return builder;
        },
        insert: (rows: any) => {
          if (table === "job_events") {
            for (const row of Array.isArray(rows) ? rows : [rows]) {
              opts.jobEvents.push(row);
            }
          }
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (mutated) return { data: { id: `${table}-written` }, error: null };
          if (table === "xero_invoices" && opts.mirrorReadError) {
            return { data: null, error: { message: "mirror read timeout" } };
          }
          return { data: singleFor(table), error: null };
        },
        single: async () => {
          if (mutated) return { data: { id: `${table}-written` }, error: null };
          return { data: singleFor(table), error: null };
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: arrayFor(table), error: null }).then(
            resolve,
            reject,
          ),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "begin_ses_invoice_execution_v1") {
        return {
          data: {
            invoice_obligation_revision_id: OBLIGATION_ID,
            readiness_revision: READINESS_REV,
            dependency_generation: DEP_GEN,
            state: "create_executed",
          },
          error: null,
        };
      }
      if (name === "claim_ses_external_effect_v1") {
        const effect = { ...args.p_effect, state: "reserved" };
        effectsByKey.set(String(effect.operation_key), effect);
        return {
          data: { effect, claim_mode: "dispatch", duplicate_refused: false },
          error: null,
        };
      }
      if (name === "transition_ses_external_effect_v1") {
        const key = String(args.p_operation_key);
        const current = effectsByKey.get(key) || { operation_key: key };
        const next = { ...current, state: args.p_to_state };
        effectsByKey.set(key, next);
        return { data: next, error: null };
      }
      if (name === "commit_ses_invoice_bound_docket_v1") {
        const binding = args.p_binding || {};
        return {
          data: {
            id: binding.id,
            job_id: binding.job_id,
            stage: "invoice_bound",
            invoice_obligation_revision_id:
              binding.invoice_obligation_revision_id,
            based_on_revision_id: binding.based_on_revision_id,
            output_content_hash: binding.output_content_hash,
            xero_binding: binding.xero_binding,
          },
          error: null,
        };
      }
      if (name === "record_ses_docket_review_state_v1") {
        return { data: { recorded: true }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "ok" }, error: null }),
        createSignedUrl: async () => ({
          data: null,
          error: { message: "unused" },
        }),
        download: async () => ({ data: null, error: { message: "unused" } }),
      }),
    },
  };
}

function gateway(state: { authorised: boolean }, track: {
  creates: number;
  authorises: number;
  pdfFetches: number;
}): SesXeroGateway {
  return {
    async createDraft() {
      track.creates += 1;
      throw new Error(
        "adopt must never mint a second invoice for an already-created obligation",
      );
    },
    async reconcileCreate() {
      // The stranded primary token carries no live invoice — this is exactly
      // what refused pre-fix. The adopt path must not depend on it.
      return [];
    },
    async authorise(invoice) {
      track.authorises += 1;
      state.authorised = true;
      return {
        xero_invoice_id: invoice.xero_invoice_id,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        reference: REFERENCE,
        total: TOTAL,
      };
    },
    async reconcileAuthorise(invoiceId) {
      if (!state.authorised) return [];
      return [{
        xero_invoice_id: invoiceId,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        reference: REFERENCE,
        total: TOTAL,
      }];
    },
    async fetchAuthorisedPdf() {
      track.pdfFetches += 1;
      return PDF_BYTES;
    },
  };
}

Deno.test("adopt: create_executed DRAFT + includes_authorise sends without a second mint", async () => {
  const gatewayState = { authorised: false };
  const track = { creates: 0, authorises: 0, pdfFetches: 0 };
  const jobEvents: any[] = [];
  const mirrorUpserts: any[] = [];
  const client = makeClient({
    approval: {
      action: "invoice",
      invoice_obligation_revision_id: OBLIGATION_ID,
      docket_revision_id: DOCKET_ID,
      readiness_revision: READINESS_REV,
      dependency_generation: DEP_GEN,
      approval_content_hash: await approvalContentHash(true),
      includes_authorise: true,
    },
    gatewayState,
    jobEvents,
    mirrorUpserts,
  });

  const result = await executeSesInvoiceRevisionAction(
    client as any,
    { mode: "jwt", user: { id: "op-1", email: "shaun@x", role: "owner" } },
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "shaun@x",
    },
    gateway(gatewayState, track),
  );

  assertEquals(result.state, "authorised_invoice_bound");
  // Money moved exactly once, on the invoice that already existed.
  assertEquals(track.creates, 0);
  assertEquals(track.authorises, 1);
  assertEquals((result as any).invoice.xero_invoice_id, XERO_ID);
  assertEquals((result as any).invoice.status, "AUTHORISED");
  assertEquals((result as any).invoice_create_dispatched, false);
  // Every mirror write keeps the confirmed mint's token — the primary
  // create-effect token is never recomputed over a readable mirror row.
  assertEquals(mirrorUpserts.length > 0, true);
  for (const row of mirrorUpserts) {
    assertEquals(row.xero_invoice_id, XERO_ID);
    assertEquals(row.ses_external_token, CONFIRMED_MINT_TOKEN);
  }
});

Deno.test("adopt: a mirror read fault refuses and never rewrites the confirmed token", async () => {
  const gatewayState = { authorised: false };
  const track = { creates: 0, authorises: 0, pdfFetches: 0 };
  const jobEvents: any[] = [];
  const mirrorUpserts: any[] = [];
  const client = makeClient({
    approval: {
      action: "invoice",
      invoice_obligation_revision_id: OBLIGATION_ID,
      docket_revision_id: DOCKET_ID,
      readiness_revision: READINESS_REV,
      dependency_generation: DEP_GEN,
      approval_content_hash: await approvalContentHash(true),
      includes_authorise: true,
    },
    gatewayState,
    jobEvents,
    mirrorUpserts,
    mirrorReadError: true,
  });

  const error = await assertRejects(
    () =>
      executeSesInvoiceRevisionAction(
        client as any,
        { mode: "jwt", user: { id: "op-1", email: "shaun@x", role: "owner" } },
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "shaun@x",
        },
        gateway(gatewayState, track),
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(
    (error.refusal as { code?: string }).code,
    "invoice_mirror_unreadable",
  );
  // No money touched, no mirror write with a synthesised primary token.
  assertEquals(track.creates, 0);
  assertEquals(track.authorises, 0);
  assertEquals(mirrorUpserts.length, 0);
});

Deno.test("adopt: a VOIDED bound invoice refuses before any authorise dispatch", async () => {
  const gatewayState = { authorised: false };
  const track = { creates: 0, authorises: 0, pdfFetches: 0 };
  const jobEvents: any[] = [];
  const mirrorUpserts: any[] = [];
  const client = makeClient({
    approval: {
      action: "invoice",
      invoice_obligation_revision_id: OBLIGATION_ID,
      docket_revision_id: DOCKET_ID,
      readiness_revision: READINESS_REV,
      dependency_generation: DEP_GEN,
      approval_content_hash: await approvalContentHash(true),
      includes_authorise: true,
    },
    gatewayState,
    jobEvents,
    mirrorUpserts,
    mirrorStatus: "VOIDED",
  });

  const error = await assertRejects(
    () =>
      executeSesInvoiceRevisionAction(
        client as any,
        { mode: "jwt", user: { id: "op-1", email: "shaun@x", role: "owner" } },
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "shaun@x",
        },
        gateway(gatewayState, track),
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(
    (error.refusal as { code?: string }).code,
    "bound_invoice_not_live",
  );
  assertEquals(track.creates, 0);
  assertEquals(track.authorises, 0);
  assertEquals(mirrorUpserts.length, 0);
});

Deno.test("adopt: DRAFT-only approval returns the existing draft, still no second mint", async () => {
  const gatewayState = { authorised: false };
  const track = { creates: 0, authorises: 0, pdfFetches: 0 };
  const jobEvents: any[] = [];
  const client = makeClient({
    approval: {
      action: "invoice",
      invoice_obligation_revision_id: OBLIGATION_ID,
      docket_revision_id: DOCKET_ID,
      readiness_revision: READINESS_REV,
      dependency_generation: DEP_GEN,
      approval_content_hash: await approvalContentHash(false),
      includes_authorise: false,
    },
    gatewayState,
    jobEvents,
  });

  const result = await executeSesInvoiceRevisionAction(
    client as any,
    { mode: "jwt", user: { id: "op-1", email: "shaun@x", role: "owner" } },
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "shaun@x",
    },
    gateway(gatewayState, track),
  );

  assertEquals(result.state, "xero_draft_created");
  assertEquals(track.creates, 0);
  assertEquals(track.authorises, 0);
  assertEquals((result as any).invoice.xero_invoice_id, XERO_ID);
});

Deno.test("adopt does not bypass stale_review: a moved docket still refuses stale_review", async () => {
  const gatewayState = { authorised: false };
  const track = { creates: 0, authorises: 0, pdfFetches: 0 };
  const jobEvents: any[] = [];
  // The cockpit is on a NEWER docket than the recorded approval: genuinely
  // stale. The adopt branch sits after this gate and must not rescue it.
  const client = makeClient({
    approval: {
      action: "invoice",
      invoice_obligation_revision_id: OBLIGATION_ID,
      docket_revision_id: "0000aaaa-0000-4000-8000-000000000000",
      readiness_revision: READINESS_REV,
      dependency_generation: DEP_GEN,
      approval_content_hash: await approvalContentHash(true),
      includes_authorise: true,
    },
    gatewayState,
    jobEvents,
  });

  const error = await assertRejects(
    () =>
      executeSesInvoiceRevisionAction(
        client as any,
        { mode: "jwt", user: { id: "op-1", email: "shaun@x", role: "owner" } },
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "shaun@x",
        },
        gateway(gatewayState, track),
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals((error.refusal as { code?: string }).code, "stale_review");
  // No money touched on a stale refusal.
  assertEquals(track.creates, 0);
  assertEquals(track.authorises, 0);
});

Deno.test("defect 2: a refused invoice execute writes a job_events refusal row", async () => {
  const jobEvents: any[] = [];
  const client = {
    from(table: string) {
      return {
        insert: (rows: any) => {
          if (table === "job_events") {
            for (const row of Array.isArray(rows) ? rows : [rows]) {
              jobEvents.push(row);
            }
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  await writeSesMoneyChainRefusalAudit(client as any, {
    action: "execute_ses_invoice_revision",
    body: {
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      // A secret-shaped field that must never be copied into the audit.
      access_token: "SECRET-should-not-be-audited",
    },
    status: 409,
    refusal: {
      state: "refused",
      code: "xero_outcome_unknown",
      fact: "Reconcile Xero directly by the exact SES external token.",
    },
    actor_user_id: "op-1",
  });

  assertEquals(jobEvents.length, 1);
  const event = jobEvents[0];
  assertEquals(event.job_id, JOB_ID);
  assertEquals(event.user_id, "op-1");
  assertEquals(event.event_type, SES_MONEY_ACTION_REFUSED_EVENT_TYPE);
  assertEquals(event.detail_json.refusal_code, "xero_outcome_unknown");
  assertEquals(
    event.detail_json.refusal_fact,
    "Reconcile Xero directly by the exact SES external token.",
  );
  assertEquals(event.detail_json.action, "execute_ses_invoice_revision");
  assertEquals(event.detail_json.http_status, 409);
  assertEquals(
    event.detail_json.invoice_obligation_revision_id,
    OBLIGATION_ID,
  );
  // No request body / secret leaks into the audit.
  assertEquals(
    JSON.stringify(event).includes("SECRET-should-not-be-audited"),
    false,
  );
});

Deno.test("defect 2: a non-chain action writes nothing", async () => {
  const jobEvents: any[] = [];
  const client = {
    from() {
      return {
        insert: (rows: any) => {
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            jobEvents.push(row);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  await writeSesMoneyChainRefusalAudit(client as any, {
    action: "prepare_ses_invoice_void_revision",
    body: { job_id: JOB_ID },
    status: 409,
    refusal: { state: "refused", code: "some_void_refusal", fact: "no" },
    actor_user_id: "op-1",
  });

  assertEquals(jobEvents.length, 0);
});

Deno.test("defect 2: a refused release execute audits every member job", async () => {
  const jobEvents: any[] = [];
  const memberJobs = ["job-a", "job-b"];
  const client = {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        insert: (rows: any) => {
          if (table === "job_events") {
            for (const row of Array.isArray(rows) ? rows : [rows]) {
              jobEvents.push(row);
            }
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: any, reject: any) => {
          const data = table === "makesafe_release_revision_members"
            ? memberJobs.map((job_id) => ({ job_id }))
            : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  await writeSesMoneyChainRefusalAudit(client as any, {
    action: "execute_ses_release_revision",
    body: { release_revision_id: "rel-1" },
    status: 409,
    refusal: { state: "refused", code: "release_not_ready", fact: "held" },
    actor_user_id: "op-1",
  });

  assertEquals(jobEvents.length, 2);
  assertEquals(new Set(jobEvents.map((e) => e.job_id)), new Set(memberJobs));
  assertEquals(jobEvents[0].detail_json.release_revision_id, "rel-1");
});
