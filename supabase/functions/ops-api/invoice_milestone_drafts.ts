/** Accepted, explicitly opted-in installation billing. DRAFT only; claims never auto-retry. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 &&
    Number.isSafeInteger(Math.round(v * 100)) &&
    Math.abs(v * 100 - Math.round(v * 100)) < 0.00001
    ? Math.round(v * 100)
    : null;
export const billingTerms = (days: number) =>
  days === 0
    ? "Due on the day installation is booked."
    : `Due ${days} calendar ${
      days === 1 ? "day" : "days"
    } after installation is booked.`;
export function acceptedInstallMilestone(raw: any) {
  const envelope = raw?.billing_milestones;
  if (!envelope) {
    return { ok: false as const, reason: "machine_billing_terms_missing" };
  }
  const fail = () => ({
    ok: false as const,
    reason: "machine_billing_terms_invalid",
  });
  const payments = raw?.payment_schedule?.payments;
  if (
    raw?.pricing_complete !== true || envelope.version !== 1 ||
    envelope.currency !== "AUD" || !Array.isArray(envelope.milestones) ||
    envelope.milestones.length !== 1 || raw?.payment_schedule?.version !== 1 ||
    !Array.isArray(payments) || payments.length < 2
  ) return fail();
  const stage = envelope.milestones[0];
  if (
    !stage || typeof stage.id !== "string" || !stage.id.trim() ||
    stage.id.length > 100 || stage.trigger?.kind !== "install_scheduled" ||
    stage.due_rule?.kind !== "days_after_trigger" ||
    !Number.isInteger(stage.due_rule.days) || stage.due_rule.days < 0 ||
    stage.due_rule.days > 365 || typeof stage.label !== "string" ||
    !stage.label.trim() || /deposit/i.test(stage.label) ||
    stage.printed_terms !== billingTerms(stage.due_rule.days) ||
    cents(stage.amount_inc_gst) === null
  ) return fail();
  const ids = new Set<string>();
  let sum = 0;
  let selected = -1;
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    const amount = cents(p?.amount_inc_gst);
    if (
      typeof p?.id !== "string" || !p.id.trim() || ids.has(p.id) ||
      amount === null || typeof p.label !== "string" ||
      typeof p.printed_terms !== "string"
    ) return fail();
    ids.add(p.id);
    sum += amount;
    if (p.id === stage.id) {
      selected = i;
      if (
        p.label !== stage.label || p.printed_terms !== stage.printed_terms ||
        amount !== cents(stage.amount_inc_gst)
      ) return fail();
    }
  }
  if (selected <= 0 || sum !== cents(raw.totalIncGST)) return fail();
  return {
    ok: true as const,
    stage,
    amountCents: cents(stage.amount_inc_gst)!,
  };
}
export interface DraftDeps {
  search(reference: string, contactId: string): Promise<any[]>;
  read(invoiceId: string): Promise<any>;
  create(payload: any, claim: any): Promise<any>;
}
function rows(result: any, label: string) {
  if (result.error) throw new Error(`${label} unavailable`);
  return result.data;
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function matchesDraft(invoice: any, claim: any) {
  return UUID.test(String(invoice?.InvoiceID || "")) &&
    invoice.Type === "ACCREC" && invoice.Status === "DRAFT" &&
    invoice.Contact?.ContactID === claim.xero_contact_id &&
    invoice.Reference === claim.reference && invoice.CurrencyCode === "AUD" &&
    cents(invoice.Total) === claim.amount_cents &&
    invoice.LineAmountTypes === "Inclusive" &&
    Array.isArray(invoice.LineItems) && invoice.LineItems.length === 1 &&
    cents(invoice.LineItems[0].UnitAmount) === claim.amount_cents &&
    invoice.LineItems[0].Quantity === 1 &&
    invoice.LineItems[0].Description === claim.label &&
    String(invoice.DueDateString || invoice.DueDate || "").slice(0, 10) ===
      claim.due_date;
}
async function writeClaim(client: any, claim: any, patch: any) {
  const result = await client.from("invoice_milestone_draft_claims").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", claim.id).eq("org_id", claim.org_id).select().single();
  return rows(result, "Invoice claim checkpoint");
}
async function confirm(client: any, deps: DraftDeps, claim: any, invoice: any) {
  if (!matchesDraft(invoice, claim)) {
    return writeClaim(client, claim, {
      state: "unknown",
      hold_reason: "provider_readback_mismatch",
      provider_invoice_id: UUID.test(String(invoice?.InvoiceID || ""))
        ? invoice.InvoiceID
        : claim.provider_invoice_id,
    });
  }
  // The exact provider identity is saved before the generic mirror; either failure retains the claim.
  await writeClaim(client, claim, {
    provider_invoice_id: invoice.InvoiceID,
    state: "dispatching",
    hold_reason: "mirror_confirmation_pending",
  });
  const mirror = await client.from("xero_invoices").upsert({
    org_id: claim.org_id,
    job_id: claim.job_id,
    quote_revision_id: claim.quote_revision_id,
    xero_invoice_id: invoice.InvoiceID,
    xero_contact_id: claim.xero_contact_id,
    invoice_type: "ACCREC",
    status: "DRAFT",
    reference: claim.reference,
    total: invoice.Total,
    sub_total: invoice.SubTotal,
    total_tax: invoice.TotalTax,
    amount_due: invoice.AmountDue ?? invoice.Total,
    amount_paid: invoice.AmountPaid ?? 0,
    invoice_number: invoice.InvoiceNumber,
    invoice_date: String(invoice.DateString || new Date().toISOString()).slice(
      0,
      10,
    ),
    due_date: claim.due_date,
    synced_at: new Date().toISOString(),
  }, { onConflict: "org_id,xero_invoice_id" });
  rows(mirror, "Invoice mirror");
  return writeClaim(client, claim, {
    state: "draft_confirmed",
    provider_invoice_id: invoice.InvoiceID,
    hold_reason: null,
  });
}
/** Recovery can bind an existing draft but never calls create, even after an empty search. */
export async function reconcileMilestoneDraft(
  client: any,
  deps: DraftDeps,
  claim: any,
) {
  if (claim.state === "draft_confirmed") return claim;
  try {
    const found = claim.provider_invoice_id
      ? [await deps.read(claim.provider_invoice_id)]
      : await deps.search(claim.reference, claim.xero_contact_id);
    if (found.length !== 1) {
      return writeClaim(client, claim, {
        state: "unknown",
        hold_reason: found.length
          ? "multiple_provider_matches"
          : "unknown_outcome_no_retry",
      });
    }
    return await confirm(
      client,
      deps,
      claim,
      await deps.read(found[0].InvoiceID),
    );
  } catch {
    return writeClaim(client, claim, {
      state: "unknown",
      hold_reason: "reconciliation_unavailable_no_retry",
    });
  }
}
export async function processInstallDrafts(
  client: any,
  deps: DraftDeps,
  jobId: string,
  orgId: string,
) {
  const reviews = rows(
    await client.from("invoice_milestone_reviews").select("*").eq(
      "job_id",
      jobId,
    ).eq("org_id", orgId).eq("trigger_kind", "scheduled"),
    "Invoice reviews",
  ) || [];
  const outcomes = [];
  for (const review of reviews) {
    if (
      !review.accepted_document_id || !review.accepted_quote_revision_id ||
      review.job_contact_id
    ) {
      outcomes.push({
        review_id: review.id,
        state: "held",
        reason: "single_accepted_payer_binding_required",
      });
      continue;
    }
    const doc = rows(
      await client.from("job_documents").select(
        "id,quote_revision_id,job_id,job_contact_id,accepted_at,sent_at,superseded_at",
      ).eq("id", review.accepted_document_id).eq("job_id", jobId).maybeSingle(),
      "Accepted document",
    );
    const binding = rows(
      await client.from("quote_invoice_billing_bindings").select("*").eq(
        "quote_revision_id",
        review.accepted_quote_revision_id,
      ).eq("org_id", orgId).eq("job_id", jobId).maybeSingle(),
      "Frozen payer",
    );
    const revision = rows(
      await client.from("quote_revisions").select(
        "id,job_id,job_document_id,sent_at,pricing_snapshot_json",
      ).eq("id", review.accepted_quote_revision_id).eq("job_id", jobId)
        .maybeSingle(),
      "Accepted revision",
    );
    if (
      !doc?.accepted_at || !doc.sent_at || doc.superseded_at ||
      doc.job_contact_id ||
      doc.quote_revision_id !== review.accepted_quote_revision_id ||
      !revision?.sent_at || revision.job_document_id !== doc.id ||
      binding?.state !== "eligible" ||
      !UUID.test(String(binding?.xero_contact_id || ""))
    ) {
      outcomes.push({
        review_id: review.id,
        state: "held",
        reason: binding?.hold_reason || "accepted_revision_or_payer_unbound",
      });
      continue;
    }
    const documents = rows(
      await client.from("job_documents").select(
        "id,accepted_at,sent_at,superseded_at",
      ).eq("job_id", jobId).eq("type", "quote"),
      "Accepted payer set",
    ) || [];
    if (
      documents.filter((d: any) =>
        d.accepted_at && d.sent_at && !d.superseded_at
      ).length !== 1
    ) {
      outcomes.push({
        review_id: review.id,
        state: "held",
        reason: "multiple_accepted_documents_require_review",
      });
      continue;
    }
    const parsed = acceptedInstallMilestone(
      revision.pricing_snapshot_json?.raw,
    );
    if (!parsed.ok) {
      outcomes.push({
        review_id: review.id,
        state: "held",
        reason: parsed.reason,
      });
      continue;
    }
    const { stage, amountCents } = parsed;
    const event = new Date(review.created_at);
    if (!Number.isFinite(event.getTime())) {
      throw new Error("Billing trigger date invalid");
    }
    const perth = new Date(event.getTime() + 8 * 3600000).toISOString().slice(
      0,
      10,
    );
    const due = new Date(`${perth}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + stage.due_rule.days);
    const payload = {
      org_id: orgId,
      job_id: jobId,
      quote_revision_id: revision.id,
      stage_id: stage.id,
      xero_contact_id: binding.xero_contact_id,
      amount_cents: amountCents,
      label: stage.label,
      printed_terms: stage.printed_terms,
      due_date: due.toISOString().slice(0, 10),
      currency: "AUD",
    };
    const hash = await digest(payload);
    const reference = `SW-BILL-${
      (await digest({ orgId, jobId, revision: revision.id, stage: stage.id }))
        .slice(0, 40)
    }`;
    const inserted = await client.from("invoice_milestone_draft_claims").upsert(
      {
        ...payload,
        review_id: review.id,
        reference,
        payload_hash: hash,
        state: "prepared",
      },
      {
        onConflict: "org_id,job_id,quote_revision_id,stage_id",
        ignoreDuplicates: true,
      },
    );
    rows(inserted, "Invoice claim");
    let claim = rows(
      await client.from("invoice_milestone_draft_claims").select("*").eq(
        "org_id",
        orgId,
      ).eq("job_id", jobId).eq("quote_revision_id", revision.id).eq(
        "stage_id",
        stage.id,
      ).single(),
      "Invoice claim",
    );
    if (claim.payload_hash !== hash) {
      outcomes.push({
        id: claim.id,
        state: "held",
        reason: "frozen_payload_changed",
      });
      continue;
    }
    if (claim.state !== "prepared") {
      outcomes.push(claim);
      continue;
    }
    const acquired = rows(
      await client.from("invoice_milestone_draft_claims").update({
        state: "dispatching",
        hold_reason: "dispatch_outcome_pending",
      }).eq("id", claim.id).eq("state", "prepared").select().maybeSingle(),
      "Invoice dispatch claim",
    );
    if (!acquired) {
      outcomes.push({ id: claim.id, state: "dispatching" });
      continue;
    }
    claim = acquired;
    try {
      const existing = await deps.search(reference, binding.xero_contact_id);
      if (existing.length > 1) throw new Error("Multiple provider matches");
      if (existing.length === 1) {
        outcomes.push(
          await confirm(
            client,
            deps,
            claim,
            await deps.read(existing[0].InvoiceID),
          ),
        );
        continue;
      }
      const made = await deps.create({
        job_id: jobId,
        xero_contact_id: binding.xero_contact_id,
        line_items: [{
          description: stage.label,
          quantity: 1,
          unit_price: amountCents / 100,
        }],
        line_amount_types: "Inclusive",
        due_date: payload.due_date,
        reference,
        xero_status: "DRAFT",
        send_email: false,
      }, claim);
      if (
        made?.success !== true || made?.xero_provider_status !== "DRAFT" ||
        made?.xero_provider_type !== "ACCREC" || made?.emailed !== false ||
        made?.email_status !== "not_requested"
      ) throw new Error("Provider create did not confirm a draft-only outcome");
      const id = made?.xero_invoice_id;
      if (!UUID.test(String(id || ""))) {
        throw new Error("Unknown provider identity");
      }
      await writeClaim(client, claim, { provider_invoice_id: id });
      outcomes.push(
        await confirm(
          client,
          deps,
          { ...claim, provider_invoice_id: id },
          await deps.read(id),
        ),
      );
    } catch {
      outcomes.push(
        await writeClaim(client, claim, {
          state: "unknown",
          hold_reason: "provider_or_persistence_outcome_unknown_no_retry",
        }),
      );
    }
  }
  return {
    ok: true,
    job_id: jobId,
    drafts: outcomes,
    send_requires_staff: true,
    automatic_send: false,
  };
}
