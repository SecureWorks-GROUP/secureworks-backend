// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA } from "./ses_commercial_quantity_override.ts";
import {
  remintSesInvoiceDraftAction,
  REMINT_DRAFT_DELETED_MINT_FAILED,
  REMINT_REQUIRES_DRAFT,
  REMINT_REQUIRES_LIVE_INVOICE,
} from "./ses_remint_invoice_draft.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const JOB = "job-harrisdale";
const auth = { mode: "routine" as const, user: null };

const lock = {
  schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  authorised_by: "Captain",
  authorised_at: "2026-08-19T00:00:00.000Z",
  decision_key: "harrisdale-261239-travel-25h-duct-tape-15-v1",
  reason: "travel 2.5h + duct tape $15",
  trade_reported_hours_per_trade: 2,
  sealed_billable_hours_floor: 2,
  lines: [
    {
      line_kind: "labour",
      description: "AJBR-71315 - make-safe attendance - 1 trade x 2.5 hours",
      quantity: 2.5,
      unit_price_ex_gst: 80,
    },
    {
      line_kind: "materials",
      description: "AJBR-71315 - Duct tape",
      quantity: 1,
      unit_price_ex_gst: 15,
    },
  ],
};

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    impl: {
      requireMintAuthority: async () => {
        calls.push("auth");
      },
      loadLiveInvoice: async () => ({
        xero_invoice_id: "xero-old",
        invoice_number: "INV-1245",
        status: "DRAFT",
        invoice_obligation_revision_id: "obl-old",
      }),
      loadLeftoverMutableObligation: async () => ({
        obligation_id: "parent-old",
        status: "xero_bound",
        revision_id: "obl-old",
      }),
      deleteDraft: async () => {
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
      prepareOverride: async () => {
        calls.push("prepare");
        return { revision: { id: "obl-new" } };
      },
      createDraft: async (_c: any, _a: any, args: any) => {
        calls.push("create:" + args.invoice_obligation_revision_id);
        return {
          state: "xero_draft_created",
          invoice: {
            invoice_number: "INV-1246",
            status: "DRAFT",
            total: 236.5,
          },
          send_dispatched: false,
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

Deno.test("remint DRAFT deletes, closes parent, overrides, mints, binds, never sends", async () => {
  const { calls, impl } = deps();
  const result = await remintSesInvoiceDraftAction(
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
  assertEquals(result.previous_invoice.invoice_number, "INV-1245");
  assertEquals(result.previous_invoice.status, "DELETED");
  assertEquals((result.invoice as any).invoice_number, "INV-1246");
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals((result.pack_bind as any).state, "existing_invoice_pack_bound");
  assertEquals(calls, [
    "auth",
    "delete",
    "local_deleted",
    "cycles",
    "void_linked",
    "parent_void_linked",
    "prepare",
    "create:obl-new",
    "bind",
  ]);
});

Deno.test("invalid lock never deletes", async () => {
  const { calls, impl } = deps();
  await assertRejects(
    () =>
      remintSesInvoiceDraftAction(
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

Deno.test("AUTHORISED never deletes", async () => {
  const { calls, impl } = deps({
    loadLiveInvoice: async () => ({
      xero_invoice_id: "x",
      invoice_number: "INV-1",
      status: "AUTHORISED",
    }),
  });
  const err = await assertRejects(
    () =>
      remintSesInvoiceDraftAction(
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
  assertEquals(calls.includes("delete"), false);
  assertEquals(err.message.includes(REMINT_REQUIRES_DRAFT), true);
});

Deno.test("no live invoice and no leftover refuses", async () => {
  const { impl } = deps({
    loadLiveInvoice: async () => null,
    loadLeftoverMutableObligation: async () => null,
  });
  const err = await assertRejects(
    () =>
      remintSesInvoiceDraftAction(
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
  assertEquals(err.message.includes(REMINT_REQUIRES_LIVE_INVOICE), true);
});

Deno.test("deleted DRAFT with leftover active cycle remints without deleting again", async () => {
  const { calls, impl } = deps({
    loadLiveInvoice: async () => null,
    loadLeftoverMutableObligation: async () => ({
      obligation_id: "parent-old",
      status: "cycle_only",
      revision_id: "obl-old",
    }),
  });
  const result = await remintSesInvoiceDraftAction(
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
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.includes("cycles"), true);
  assertEquals(calls.includes("create:obl-new"), true);
});

Deno.test("deleted DRAFT with leftover parent remints without deleting again", async () => {
  const { calls, impl } = deps({
    loadLiveInvoice: async () => null,
  });
  const result = await remintSesInvoiceDraftAction(
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
  assertEquals((result.invoice as any).invoice_number, "INV-1246");
  assertEquals(calls.includes("delete"), false);
  assertEquals(calls.includes("parent_void_linked"), true);
  assertEquals(calls.includes("create:obl-new"), true);
});

Deno.test("mint fail after delete is named, not silent", async () => {
  const { impl } = deps({
    createDraft: async () => {
      throw new SesActionError(409, {
        state: "refused",
        fact: "duplicate still visible",
      });
    },
  });
  const err = await assertRejects(
    () =>
      remintSesInvoiceDraftAction(
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
  assertEquals(err.message.includes(REMINT_DRAFT_DELETED_MINT_FAILED), true);
  assertEquals(err.message.includes("INV-1245"), true);
});
