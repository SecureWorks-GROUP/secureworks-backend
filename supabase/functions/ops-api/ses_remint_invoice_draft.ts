// deno-lint-ignore-file no-explicit-any
/**
 * Captain-locked DRAFT remint (ruling 2026-08-19).
 *
 * Validate the lock first. Delete the DRAFT in Xero and on the local mirror.
 * Close the parent obligation (the mutable-job unique index lives there, not
 * on the revision). Then prepare + mint + bind. AUTHORISED refuses.
 *
 * If the previous remint already deleted the Xero DRAFT but left the parent
 * open, remint continues from that leftover — it does not require a live
 * invoice. If mint fails after delete, the refusal says so.
 */
import {
  parseSesCommercialQuantityOverride,
  SesCommercialQuantityOverrideError,
} from "./ses_commercial_quantity_override.ts";
import { SesActionError, type SesActionAuth } from "./ses_reporting_actions.ts";

export const REMINT_REQUIRES_DRAFT = "remint_requires_draft";
export const REMINT_REQUIRES_LIVE_INVOICE = "remint_requires_live_invoice";
export const REMINT_DRAFT_DELETED_MINT_FAILED =
  "remint_draft_deleted_mint_failed";

export type SesLiveInvoice = {
  xero_invoice_id: string;
  invoice_number: string;
  status: string;
  invoice_obligation_revision_id?: string | null;
};

export type SesLeftoverObligation = {
  obligation_id: string;
  status: string;
  revision_id?: string | null;
};

export type RemintSesInvoiceDraftDeps = {
  requireMintAuthority: (
    client: any,
    auth: SesActionAuth,
  ) => Promise<void>;
  loadLiveInvoice: (client: any, jobId: string) => Promise<SesLiveInvoice | null>;
  loadLeftoverMutableObligation: (
    client: any,
    jobId: string,
  ) => Promise<SesLeftoverObligation | null>;
  deleteDraft: (
    client: any,
    invoice: SesLiveInvoice,
    actor: string,
  ) => Promise<{ status: string }>;
  markLocalInvoiceDeleted: (
    client: any,
    xeroInvoiceId: string,
  ) => Promise<void>;
  deactivateObligationCycles: (
    client: any,
    jobId: string,
  ) => Promise<void>;
  markObligationVoidLinked: (
    client: any,
    obligationRevisionId: string,
  ) => Promise<void>;
  markParentObligationVoidLinked: (
    client: any,
    obligationId: string,
  ) => Promise<void>;
  prepareOverride: (
    client: any,
    auth: SesActionAuth,
    args: {
      org_id: string;
      job_id: string;
      created_by: string;
      commercial_quantity_override: unknown;
    },
  ) => Promise<{ revision?: { id?: string }; obligation?: { id?: string } }>;
  createDraft: (
    client: any,
    auth: SesActionAuth,
    args: {
      org_id: string;
      job_id: string;
      invoice_obligation_revision_id?: string;
      actor: string;
    },
  ) => Promise<Record<string, unknown>>;
  bindInvoice?: (
    client: any,
    args: { job_id: string; invoice_number: string; actor: string },
  ) => Promise<Record<string, unknown> | null>;
};

function liveStatus(status: string): string {
  return String(status || "").toUpperCase();
}

function mintedInvoiceNumber(minted: Record<string, unknown>): string {
  const inv = (minted as any).invoice || minted;
  return String(inv?.invoice_number || inv?.InvoiceNumber || "").trim();
}

async function closePreviousObligation(
  deps: RemintSesInvoiceDraftDeps,
  client: any,
  leftover: SesLeftoverObligation | null,
  jobId: string,
  revisionId?: string | null,
) {
  await deps.deactivateObligationCycles(client, jobId);
  const closedRevision = String(revisionId || leftover?.revision_id || "")
    .trim();
  if (closedRevision) {
    await deps.markObligationVoidLinked(client, closedRevision);
  }
  const obligationId = String(leftover?.obligation_id || "").trim();
  if (obligationId) {
    await deps.markParentObligationVoidLinked(client, obligationId);
  }
}

export async function remintSesInvoiceDraftAction(
  client: any,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    actor: string;
    commercial_quantity_override: unknown;
  },
  deps: RemintSesInvoiceDraftDeps,
) {
  await deps.requireMintAuthority(client, auth);
  const jobId = String(args.job_id || "").trim();
  if (!jobId) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "remint_ses_invoice_draft requires job_id.",
    });
  }

  try {
    parseSesCommercialQuantityOverride(args.commercial_quantity_override);
  } catch (error) {
    if (error instanceof SesCommercialQuantityOverrideError) {
      throw new SesActionError(error.httpStatus, {
        state: "refused",
        fact: error.message,
      });
    }
    throw error;
  }

  const live = await deps.loadLiveInvoice(client, jobId);
  const leftover = await deps.loadLeftoverMutableObligation(client, jobId);
  if (live && liveStatus(live.status) !== "DRAFT") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `${REMINT_REQUIRES_DRAFT}: only a DRAFT can be reminted this way (saw ${liveStatus(live.status)} on ${live.invoice_number}). AUTHORISED money stays on the void path.`,
    });
  }
  if (!live && !leftover) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `${REMINT_REQUIRES_LIVE_INVOICE}: there is no live invoice to remint; use create_ses_invoice_draft.`,
    });
  }

  let previousInvoice = {
    xero_invoice_id: live?.xero_invoice_id || "",
    invoice_number: live?.invoice_number || "already-deleted",
    status: "DELETED",
  };
  if (live) {
    const deleted = await deps.deleteDraft(client, live, args.actor);
    await deps.markLocalInvoiceDeleted(client, live.xero_invoice_id);
    previousInvoice = {
      xero_invoice_id: live.xero_invoice_id,
      invoice_number: live.invoice_number,
      status: deleted.status || "DELETED",
    };
  }

  await closePreviousObligation(
    deps,
    client,
    leftover,
    jobId,
    live?.invoice_obligation_revision_id,
  );

  let minted: Record<string, unknown>;
  try {
    const prepared = await deps.prepareOverride(client, auth, {
      org_id: args.org_id,
      job_id: jobId,
      created_by: args.actor,
      commercial_quantity_override: args.commercial_quantity_override,
    });
    const obligationRevisionId = String(prepared?.revision?.id || "").trim() ||
      undefined;
    minted = await deps.createDraft(client, auth, {
      org_id: args.org_id,
      job_id: jobId,
      invoice_obligation_revision_id: obligationRevisionId,
      actor: args.actor,
    });
    (minted as any)._obligation_revision_id = obligationRevisionId || null;
  } catch (error) {
    const fact = error instanceof SesActionError
      ? error.refusal.fact
      : (error as Error).message;
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `${REMINT_DRAFT_DELETED_MINT_FAILED}: ${previousInvoice.invoice_number} is DELETED in Xero but the new DRAFT was not minted (${fact}). The parent obligation is closed; retry remint or call create_ses_invoice_draft with the same lock.`,
    });
  }

  const newNumber = mintedInvoiceNumber(minted);
  let packBind: Record<string, unknown> | null = null;
  if (newNumber && deps.bindInvoice) {
    try {
      packBind = await deps.bindInvoice(client, {
        job_id: jobId,
        invoice_number: newNumber,
        actor: args.actor,
      });
    } catch (error) {
      packBind = {
        ok: false,
        fact: (error as Error).message,
      };
    }
  }

  return {
    state: "xero_draft_reminted",
    previous_invoice: previousInvoice,
    invoice: (minted as any).invoice || minted,
    obligation_revision_id: (minted as any)._obligation_revision_id || null,
    pack_bind: packBind,
    send_dispatched: false,
    invoice_authorise_dispatched: false,
  };
}

export function makeDefaultRemintDeps(
  hooks: {
    requireMintAuthority: RemintSesInvoiceDraftDeps["requireMintAuthority"];
    prepareOverride: RemintSesInvoiceDraftDeps["prepareOverride"];
    createDraft: RemintSesInvoiceDraftDeps["createDraft"];
    deleteDraftOnXero: (
      invoice: SesLiveInvoice,
      actor: string,
    ) => Promise<{ status: string }>;
    bindInvoice?: RemintSesInvoiceDraftDeps["bindInvoice"];
  },
): RemintSesInvoiceDraftDeps {
  return {
    requireMintAuthority: hooks.requireMintAuthority,
    async loadLiveInvoice(client, jobId) {
      const res = await client.from("xero_invoices")
        .select(
          "xero_invoice_id,invoice_number,status,invoice_obligation_revision_id",
        )
        .eq("job_id", jobId)
        .order("updated_at", { ascending: false });
      const rows = Array.isArray(res.data) ? res.data : [];
      const live = rows.find((row: any) => {
        const st = liveStatus(row.status);
        return st !== "VOIDED" && st !== "DELETED";
      });
      return live
        ? {
          xero_invoice_id: String(live.xero_invoice_id),
          invoice_number: String(live.invoice_number || ""),
          status: String(live.status || ""),
          invoice_obligation_revision_id:
            live.invoice_obligation_revision_id || null,
        }
        : null;
    },
    async loadLeftoverMutableObligation(client, jobId) {
      const res = await client.from("makesafe_invoice_obligations")
        .select("id,status")
        .eq("job_id", jobId)
        .in("status", ["open", "reserved", "xero_bound"]);
      const parent = (Array.isArray(res.data) ? res.data : [])[0];
      const cycles = await client.from("makesafe_invoice_obligation_cycles")
        .select("obligation_id,obligation_revision_id")
        .eq("job_id", jobId)
        .eq("active", true);
      const cycle = (Array.isArray(cycles.data) ? cycles.data : [])[0];
      if (!parent && !cycle) return null;
      let revisionId = cycle?.obligation_revision_id || null;
      if (parent && !revisionId) {
        const rev = await client.from("makesafe_invoice_obligation_revisions")
          .select("id")
          .eq("obligation_id", parent.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        revisionId = rev?.data?.id || null;
      }
      return {
        obligation_id: String(parent?.id || cycle?.obligation_id || ""),
        status: String(parent?.status || "cycle_only"),
        revision_id: revisionId,
      };
    },
    deleteDraft: async (_client, invoice, actor) =>
      hooks.deleteDraftOnXero(invoice, actor),
    async markLocalInvoiceDeleted(client, xeroInvoiceId) {
      await client.from("xero_invoices")
        .update({ status: "DELETED" })
        .eq("xero_invoice_id", xeroInvoiceId);
    },
    async deactivateObligationCycles(client, jobId) {
      await client.from("makesafe_invoice_obligation_cycles")
        .update({ active: false })
        .eq("job_id", jobId)
        .eq("active", true);
    },
    async markObligationVoidLinked(client, obligationRevisionId) {
      const revision = await client.from("makesafe_invoice_obligation_revisions")
        .update({ state: "void_linked" })
        .eq("id", obligationRevisionId)
        .select("obligation_id")
        .maybeSingle();
      const obligationId = String(revision?.data?.obligation_id || "").trim();
      if (obligationId) {
        await client.from("makesafe_invoice_obligations")
          .update({ status: "void_linked" })
          .eq("id", obligationId);
      }
    },
    async markParentObligationVoidLinked(client, obligationId) {
      await client.from("makesafe_invoice_obligations")
        .update({ status: "void_linked" })
        .eq("id", obligationId);
    },
    prepareOverride: hooks.prepareOverride,
    createDraft: hooks.createDraft,
    bindInvoice: hooks.bindInvoice,
  };
}
