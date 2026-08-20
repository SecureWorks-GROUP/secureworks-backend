// deno-lint-ignore-file no-explicit-any
/**
 * Captain-lock DRAFT remint without a U4 SES docket.
 *
 * The standing remint (`remint_ses_invoice_draft`) still requires a live
 * invoice or leftover obligation, then prepare_ses_invoice_obligation →
 * create_ses_invoice_draft. Assessment cards whose wrong Make-Safe drafts
 * were DELETED have neither a leftover obligation nor a docket, so that
 * path refuses. This recovery voids or deletes a current-cycle DRAFT when
 * one is still live, then mints one new DRAFT at the locked figure and
 * binds it to the same card.
 *
 * DRAFT only. Never authorise, send, or email. A second live ACCREC still
 * refuses. AUTHORISED / SUBMITTED / PAID refuse. DELETED rows and a card
 * with no live ACCREC are recoverable.
 */
import {
  parseSesCommercialQuantityOverride,
  SesCommercialQuantityOverrideError,
} from "./ses_commercial_quantity_override.ts";
import { canonicalMakesafeInvoiceContactName } from "./makesafe_invoice_contact.ts";
import { resolveExistingInvoice } from "./makesafe_send_pack.ts";
import { composeInvoiceReferenceWithPo } from "./ses_invoice_reference_grain.ts";
import { SesActionError, type SesActionAuth } from "./ses_reporting_actions.ts";
import type {
  SesLeftoverObligation,
  SesLiveInvoice,
} from "./ses_remint_invoice_draft.ts";

export const CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT =
  "captain_lock_remint_requires_draft";
export const CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE = "invoice_duplicate_live";
export const CAPTAIN_LOCK_REMINT_AUTHORITY_REQUIRED =
  "captain_lock_authority_required";
export const CAPTAIN_LOCK_REMINT_DRAFT_DELETED_MINT_FAILED =
  "captain_lock_remint_draft_deleted_mint_failed";

export type CaptainLockLiveInvoice = SesLiveInvoice & {
  reference?: string | null;
  total?: number | null;
};

export type CaptainLockCardContext = {
  builder_reference: string;
  purchase_order: string | null;
  contact_name: string;
};

export type CaptainLockMintedDraft = {
  xero_invoice_id?: string | null;
  invoice_number?: string | null;
  status?: string | null;
  total?: number | null;
  reference?: string | null;
  invoice?: Record<string, unknown>;
};

export type RemintSesCaptainLockDraftDeps = {
  requireMintAuthority: (
    client: any,
    auth: SesActionAuth,
  ) => Promise<void>;
  loadCardContext: (
    client: any,
    jobId: string,
  ) => Promise<CaptainLockCardContext>;
  loadLiveInvoices: (
    client: any,
    jobId: string,
  ) => Promise<CaptainLockLiveInvoice[]>;
  loadLeftoverMutableObligation: (
    client: any,
    jobId: string,
  ) => Promise<SesLeftoverObligation | null>;
  fetchAllAccrecInvoices: (client: any) => Promise<any[]>;
  deleteDraft: (
    client: any,
    invoice: CaptainLockLiveInvoice,
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
  createDraft: (
    client: any,
    args: {
      job_id: string;
      contact_name: string;
      reference: string;
      decision_key: string;
      line_items: Array<{
        description: string;
        quantity: number;
        unit_price: number;
        account_code: string;
      }>;
    },
  ) => Promise<CaptainLockMintedDraft>;
  bindInvoice?: (
    client: any,
    args: { job_id: string; invoice_number: string; actor: string },
  ) => Promise<Record<string, unknown> | null>;
};

function liveStatus(status: string): string {
  return String(status || "").toUpperCase();
}

function isLiveMoneyStatus(status: string): boolean {
  const st = liveStatus(status);
  return st !== "" && st !== "VOIDED" && st !== "DELETED";
}

function mintedInvoiceNumber(minted: CaptainLockMintedDraft): string {
  const inv = minted.invoice || minted;
  return String(
    minted.invoice_number ||
      (inv as any)?.invoice_number ||
      (inv as any)?.InvoiceNumber ||
      "",
  ).trim();
}

async function closePreviousObligation(
  deps: RemintSesCaptainLockDraftDeps,
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

function refuseDuplicateLive(
  hit: { invoice_number?: string | null; status?: string | null },
): never {
  throw new SesActionError(409, {
    state: "refused",
    code: CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE,
    fact:
      `${CAPTAIN_LOCK_REMINT_DUPLICATE_LIVE}: a live ACCREC already matches this card (${
        hit.invoice_number || "unknown"
      }, ${liveStatus(String(hit.status || ""))}). Do not mint a second invoice.`,
    recovery_action:
      "Resolve or use the existing live invoice; captain-lock remint never creates a second live ACCREC.",
  });
}

export async function remintSesCaptainLockDraftAction(
  client: any,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    actor: string;
    commercial_quantity_override: unknown;
  },
  deps: RemintSesCaptainLockDraftDeps,
) {
  await deps.requireMintAuthority(client, auth);
  const jobId = String(args.job_id || "").trim();
  if (!jobId) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "remint_ses_captain_lock_draft requires job_id.",
    });
  }

  let lock;
  try {
    lock = parseSesCommercialQuantityOverride(
      args.commercial_quantity_override,
    );
  } catch (error) {
    if (error instanceof SesCommercialQuantityOverrideError) {
      throw new SesActionError(error.httpStatus, {
        state: "refused",
        fact: error.message,
      });
    }
    throw error;
  }
  if (lock.authority_kind !== "captain_lock") {
    throw new SesActionError(400, {
      state: "refused",
      code: CAPTAIN_LOCK_REMINT_AUTHORITY_REQUIRED,
      fact:
        `${CAPTAIN_LOCK_REMINT_AUTHORITY_REQUIRED}: remint_ses_captain_lock_draft requires commercial_quantity_override.authority_kind=captain_lock.`,
    });
  }

  const context = await deps.loadCardContext(client, jobId);
  const composed = composeInvoiceReferenceWithPo(
    context.builder_reference,
    context.purchase_order,
  );
  const reference = composed.reference;
  if (!reference) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This card has no builder reference, so the duplicate-invoice guard cannot run.",
    });
  }
  const contactName = canonicalMakesafeInvoiceContactName(
    reference,
    context.contact_name,
  );
  if (!contactName) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The builder Xero contact could not be resolved from this card's reference.",
    });
  }

  const liveOnJob = await deps.loadLiveInvoices(client, jobId);
  if (liveOnJob.length > 1) {
    refuseDuplicateLive(liveOnJob[0]);
  }
  const live = liveOnJob[0] || null;
  if (live && liveStatus(live.status) !== "DRAFT") {
    throw new SesActionError(409, {
      state: "refused",
      code: CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT,
      fact:
        `${CAPTAIN_LOCK_REMINT_REQUIRES_DRAFT}: only a current-cycle DRAFT can be reminted this way (saw ${liveStatus(live.status)} on ${live.invoice_number}). AUTHORISED, sent, or paid money stays on the void path.`,
    });
  }

  let accrecRows: any[];
  try {
    accrecRows = await deps.fetchAllAccrecInvoices(client);
  } catch (error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The full live ACCREC duplicate-invoice scan failed (${
        (error as Error)?.message || "unknown error"
      }).`,
    });
  }
  const existingBefore = resolveExistingInvoice(accrecRows, jobId, reference);
  if (existingBefore) {
    const existingId = String(existingBefore.xero_invoice_id || "");
    const liveId = String(live?.xero_invoice_id || "");
    const sameDraftWeWillDelete = !!live && !!existingId && existingId === liveId &&
      liveStatus(live.status) === "DRAFT";
    if (!sameDraftWeWillDelete) {
      refuseDuplicateLive(existingBefore);
    }
  }

  const leftover = await deps.loadLeftoverMutableObligation(client, jobId);
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

  let accrecAfter: any[];
  try {
    accrecAfter = await deps.fetchAllAccrecInvoices(client);
  } catch (error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The post-delete live ACCREC duplicate-invoice scan failed (${
        (error as Error)?.message || "unknown error"
      }).`,
    });
  }
  const existingAfter = resolveExistingInvoice(accrecAfter, jobId, reference);
  if (existingAfter) {
    refuseDuplicateLive(existingAfter);
  }

  const lineItems = lock.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit_price: line.unit_price_ex_gst,
    account_code: "210",
  }));

  let minted: CaptainLockMintedDraft;
  try {
    minted = await deps.createDraft(client, {
      job_id: jobId,
      contact_name: contactName,
      reference,
      decision_key: lock.decision_key,
      line_items: lineItems,
    });
  } catch (error) {
    const fact = error instanceof SesActionError
      ? error.refusal.fact
      : (error as Error).message;
    throw new SesActionError(409, {
      state: "refused",
      code: CAPTAIN_LOCK_REMINT_DRAFT_DELETED_MINT_FAILED,
      fact:
        `${CAPTAIN_LOCK_REMINT_DRAFT_DELETED_MINT_FAILED}: ${previousInvoice.invoice_number} is DELETED but the locked DRAFT was not minted (${fact}). Retry remint_ses_captain_lock_draft with the same lock; do not mint a second card.`,
    });
  }

  const mintedStatus = liveStatus(
    String(minted.status || minted.invoice?.status || "DRAFT"),
  );
  if (mintedStatus && mintedStatus !== "DRAFT") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        `Captain-lock remint minted ${minted.invoice_number || "an invoice"} as ${mintedStatus}, not DRAFT. Do not authorise or send.`,
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
    invoice: minted.invoice || {
      xero_invoice_id: minted.xero_invoice_id,
      invoice_number: minted.invoice_number,
      status: minted.status || "DRAFT",
      total: minted.total,
      reference: minted.reference || reference,
    },
    reference,
    reference_grain: composed.grain,
    purchase_order: composed.purchase_order,
    pack_bind: packBind,
    send_dispatched: false,
    invoice_authorise_dispatched: false,
  };
}

export function makeDefaultCaptainLockRemintDeps(
  hooks: {
    requireMintAuthority: RemintSesCaptainLockDraftDeps["requireMintAuthority"];
    createDraft: RemintSesCaptainLockDraftDeps["createDraft"];
    fetchAllAccrecInvoices: RemintSesCaptainLockDraftDeps["fetchAllAccrecInvoices"];
    deleteDraftOnXero: (
      invoice: CaptainLockLiveInvoice,
      actor: string,
    ) => Promise<{ status: string }>;
    bindInvoice?: RemintSesCaptainLockDraftDeps["bindInvoice"];
  },
): RemintSesCaptainLockDraftDeps {
  return {
    requireMintAuthority: hooks.requireMintAuthority,
    async loadCardContext(client, jobId) {
      const job = await client.from("jobs")
        .select("id,metadata")
        .eq("id", jobId)
        .maybeSingle();
      if (job.error) {
        throw new SesActionError(503, {
          state: "refused",
          fact: `The job row could not be read (${job.error.message}).`,
        });
      }
      if (!job.data) {
        throw new SesActionError(404, {
          state: "refused",
          fact: "Job not found for captain-lock remint.",
        });
      }
      const detail = await client.from("makesafe_job_details")
        .select("external_ref")
        .eq("job_id", jobId)
        .maybeSingle();
      if (detail.error) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            `The make-safe detail row could not be read (${detail.error.message}).`,
        });
      }
      if (!detail.data) {
        throw new SesActionError(409, {
          state: "refused",
          fact: "This job has no make-safe detail row to remint against.",
        });
      }
      const metadata = job.data.metadata && typeof job.data.metadata === "object"
        ? job.data.metadata as Record<string, unknown>
        : {};
      const builder_reference = String(detail.data.external_ref || "").trim();
      const purchase_order = metadata.builder_po_number == null
        ? null
        : String(metadata.builder_po_number).trim() || null;
      return {
        builder_reference,
        purchase_order,
        contact_name: canonicalMakesafeInvoiceContactName(
          builder_reference,
          null,
        ),
      };
    },
    async loadLiveInvoices(client, jobId) {
      const res = await client.from("xero_invoices")
        .select(
          "xero_invoice_id,invoice_number,status,invoice_obligation_revision_id,reference,total",
        )
        .eq("job_id", jobId)
        .eq("invoice_type", "ACCREC")
        .order("updated_at", { ascending: false });
      if (res.error) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            `The live invoice read failed (${res.error.message}).`,
        });
      }
      const rows = Array.isArray(res.data) ? res.data : [];
      return rows.filter((row: any) => isLiveMoneyStatus(row.status)).map(
        (row: any) => ({
          xero_invoice_id: String(row.xero_invoice_id),
          invoice_number: String(row.invoice_number || ""),
          status: String(row.status || ""),
          invoice_obligation_revision_id:
            row.invoice_obligation_revision_id || null,
          reference: row.reference || null,
          total: row.total ?? null,
        }),
      );
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
    fetchAllAccrecInvoices: hooks.fetchAllAccrecInvoices,
    deleteDraft: async (_client, invoice, actor) =>
      hooks.deleteDraftOnXero(invoice, actor),
    async markLocalInvoiceDeleted(client, xeroInvoiceId) {
      const { error } = await client.from("xero_invoices")
        .update({ status: "DELETED" })
        .eq("xero_invoice_id", xeroInvoiceId);
      if (error) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            `The local DRAFT mirror could not be marked DELETED (${error.message}).`,
        });
      }
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
    createDraft: hooks.createDraft,
    bindInvoice: hooks.bindInvoice,
  };
}
