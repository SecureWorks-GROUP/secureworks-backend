// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA } from "./ses_commercial_quantity_override.ts";
import {
  CAPTAIN_LOCK_REMINT_AUTHORITY_REQUIRED,
  CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE,
  CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT,
  remintSesCaptainLockDraftAction,
} from "./ses_captain_lock_draft_remint.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const JOB = "eb4c142b-98ab-4d10-8626-03d162d079fc";
const auth = { mode: "routine" as const, user: null };

const lock = {
  schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  authorised_by: "Captain",
  authorised_at: "2026-08-20T00:00:00.000Z",
  decision_key: "mlb-25206-assessment-165-v1",
  reason: "Captain lock: work-order assessment figure $165",
  trade_reported_hours_per_trade: 0,
  sealed_billable_hours_floor: 0,
  authority_kind: "captain_lock",
  lines: [{
    line_kind: "labour",
    description: "MLB-25206PO-54048 - assessment report and quote",
    quantity: 1,
    unit_price_ex_gst: 150,
  }],
};

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let draftDeleted = false;
  const deletedRow = {
    xero_invoice_id: "xero-0817",
    invoice_number: "INV-0817",
    status: "DELETED",
    job_id: JOB,
    reference: "MLB-25206 - Make-Safe",
    total: 280.5,
  };
  return {
    calls,
    impl: {
      requireMintAuthority: async () => {
        calls.push("auth");
      },
      loadCardContext: async () => ({
        builder_reference: "MLB-25206",
        purchase_order: "PO-54048",
        contact_name: "Major Loss Builders",
      }),
      loadLiveInvoices: async () => [],
      loadLeftoverMutableObligation: async () => null,
      fetchAllAccrecInvoices: async () => {
        calls.push(draftDeleted ? "scan_after_delete" : "scan");
        return draftDeleted ? [deletedRow] : [deletedRow];
      },
      deleteDraft: async () => {
        draftDeleted = true;
        calls.push("delete");
        return { status: "DELETED" };
      },
      markLocalInvoiceDeleted: async () => {
        calls.push("local_deleted");
      },
      deactivateObligationCycles: async () => {
        calls.push("cycles");
      },
      markObligationVoidLinked: async () => {
        calls.push("void_linked");
      },
      markParentObligationVoidLinked: async () => {
        calls.push("parent_void_linked");
      },
      createDraft: async (_c: any, args: any) => {
        calls.push("create:" + args.reference);
        assertEquals(args.line_items[0].unit_price, 150);
        assertEquals(args.contact_name, "Major Loss Builders");
        return {
          state: "xero_draft_created",
          invoice_number: "INV-2001",
          status: "DRAFT",
          total: 165,
          reference: args.reference,
          invoice: {
            invoice_number: "INV-2001",
            status: "DRAFT",
            total: 165,
            reference: args.reference,
          },
        };
      },
      bindInvoice: async () => {
        calls.push("bind");
        return { state: "existing_invoice_pack_bound" };
      },
      ...overrides,
    },
  };
}

Deno.test("DELETED previous DRAFT remints at the locked figure with no leftover and never sends", async () => {
  const { calls, impl } = deps();
  const result = await remintSesCaptainLockDraftAction(
    {},
    auth,
    {
      org_id: "org",
      job_id: JOB,
      actor: "captain-chat",
      commercial_quantity_override: lock,
    },
    impl as any,
  );
  assertEquals(result.state, "xero_draft_reminted");
  assertEquals(result.previous_invoice.invoice_number, "already-deleted");
  assertEquals((result.invoice as any).invoice_number, "INV-2001");
  assertEquals((result.invoice as any).status, "DRAFT");
  assertEquals((result.invoice as any).total, 165);
  assertEquals(result.reference, "MLB-25206PO-54048");
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals((result.pack_bind as any).state, "existing_invoice_pack_bound");
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.includes("create:MLB-25206PO-54048"), true);
  assertEquals(calls.includes("bind"), true);
});

Deno.test("no live ACCREC remints the locked DRAFT onto the existing card", async () => {
  const { impl } = deps({
    fetchAllAccrecInvoices: async () => [],
  });
  const result = await remintSesCaptainLockDraftAction(
    {},
    auth,
    {
      org_id: "org",
      job_id: JOB,
      actor: "captain-chat",
      commercial_quantity_override: lock,
    },
    impl as any,
  );
  assertEquals(result.state, "xero_draft_reminted");
  assertEquals((result.invoice as any).invoice_number, "INV-2001");
  assertEquals(result.send_dispatched, false);
});

Deno.test("live DRAFT is deleted then one locked DRAFT is minted and bound", async () => {
  const state = { deleted: false };
  const liveDraft = {
    xero_invoice_id: "xero-0817",
    invoice_number: "INV-0817",
    status: "DRAFT",
    invoice_obligation_revision_id: null,
  };
  const { calls, impl } = deps({
    loadLiveInvoices: async () => state.deleted ? [] : [liveDraft],
    fetchAllAccrecInvoices: async () => {
      return state.deleted
        ? [{
          xero_invoice_id: "xero-0817",
          invoice_number: "INV-0817",
          status: "DELETED",
          job_id: JOB,
          reference: "MLB-25206 - Make-Safe",
        }]
        : [{
          ...liveDraft,
          job_id: JOB,
          reference: "MLB-25206 - Make-Safe",
        }];
    },
    deleteDraft: async () => {
      state.deleted = true;
      return { status: "DELETED" };
    },
  });
  const result = await remintSesCaptainLockDraftAction(
    {},
    auth,
    {
      org_id: "org",
      job_id: JOB,
      actor: "captain-chat",
      commercial_quantity_override: lock,
    },
    impl as any,
  );
  assertEquals(result.previous_invoice.invoice_number, "INV-0817");
  assertEquals(result.previous_invoice.status, "DELETED");
  assertEquals((result.invoice as any).invoice_number, "INV-2001");
  assertEquals(state.deleted, true);
  assertEquals(calls.includes("local_deleted"), true);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
});

Deno.test("two live ACCREC on the card refuse and never delete or mint", async () => {
  const { calls, impl } = deps({
    loadLiveInvoices: async () => [
      {
        xero_invoice_id: "xero-0817",
        invoice_number: "INV-0817",
        status: "DRAFT",
      },
      {
        xero_invoice_id: "xero-0999",
        invoice_number: "INV-0999",
        status: "DRAFT",
      },
    ],
  });
  const err = await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: lock,
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(err.message.includes(CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE), true);
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.some((c) => c.startsWith("create:")), false);
});

Deno.test("DELETED previous plus another live ACCREC on the same card refuses", async () => {
  const { calls, impl } = deps({
    loadLiveInvoices: async () => [],
    fetchAllAccrecInvoices: async () => [
      {
        xero_invoice_id: "xero-0817",
        invoice_number: "INV-0817",
        status: "DELETED",
        job_id: JOB,
        reference: "MLB-25206PO-54048",
      },
      {
        xero_invoice_id: "xero-live",
        invoice_number: "INV-0999",
        status: "AUTHORISED",
        job_id: JOB,
        reference: "MLB-25206PO-54048",
        total: 165,
      },
    ],
  });
  const err = await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: lock,
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(err.message.includes(CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE), true);
  assertEquals(calls.some((c) => c.startsWith("create:")), false);
});

Deno.test("PAID money never deletes or mints", async () => {
  const { calls, impl } = deps({
    loadLiveInvoices: async () => [{
      xero_invoice_id: "xero-paid",
      invoice_number: "INV-2",
      status: "PAID",
    }],
  });
  const err = await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: lock,
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(err.message.includes(CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT), true);
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.some((c) => c.startsWith("create:")), false);
});

Deno.test("AUTHORISED money never deletes or mints", async () => {
  const { calls, impl } = deps({
    loadLiveInvoices: async () => [{
      xero_invoice_id: "xero-auth",
      invoice_number: "INV-1",
      status: "AUTHORISED",
    }],
  });
  const err = await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: lock,
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(err.message.includes(CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT), true);
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.some((c) => c.startsWith("create:")), false);
});

Deno.test("staff_lock authority is refused before any money write", async () => {
  const { calls, impl } = deps();
  const err = await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: {
            ...lock,
            authority_kind: "staff_lock",
          },
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(
    err.message.includes(CAPTAIN_LOCK_REMINT_AUTHORITY_REQUIRED),
    true,
  );
  assertEquals(calls.includes("delete"), false);
});

Deno.test("invalid lock never deletes", async () => {
  const { calls, impl } = deps();
  await assertRejects(
    () =>
      remintSesCaptainLockDraftAction(
        {},
        auth,
        {
          org_id: "org",
          job_id: JOB,
          actor: "captain-chat",
          commercial_quantity_override: { authorised_by: "Captain" },
        },
        impl as any,
      ),
    SesActionError,
  );
  assertEquals(calls.includes("delete"), false);
});
