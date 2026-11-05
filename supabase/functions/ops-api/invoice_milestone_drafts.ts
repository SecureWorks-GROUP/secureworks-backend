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
export const councilBillingTerms = (days: number, name: string) =>
  days === 0
    ? `Due on the day council step "${name}" is completed.`
    : `Due ${days} calendar ${
      days === 1 ? "day" : "days"
    } after council step "${name}" is completed.`;
export function acceptedBillingMilestones(raw: any) {
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
    envelope.milestones.length < 1 || envelope.milestones.length > 20 ||
    raw?.payment_schedule?.version !== 1 || !Array.isArray(payments) ||
    payments.length < 2
  ) return fail();
  const ids = new Set<string>();
  let sum = 0;
  for (const p of payments) {
    const amount = cents(p?.amount_inc_gst);
    if (
      typeof p?.id !== "string" || !p.id.trim() || ids.has(p.id) ||
      amount === null || typeof p.label !== "string" ||
      typeof p.printed_terms !== "string"
    ) return fail();
    ids.add(p.id);
    sum += amount;
  }
  if (sum !== cents(raw.totalIncGST)) return fail();
  const selected = new Set<string>();
  const triggers = new Set<string>();
  for (const stage of envelope.milestones) {
    if (
      !stage || typeof stage.id !== "string" || !stage.id.trim() ||
      stage.id.length > 100 || selected.has(stage.id) ||
      stage.due_rule?.kind !== "days_after_trigger" ||
      !Number.isInteger(stage.due_rule.days) || stage.due_rule.days < 0 ||
      stage.due_rule.days > 365 || typeof stage.label !== "string" ||
      !stage.label.trim() || /deposit/i.test(stage.label) ||
      cents(stage.amount_inc_gst) === null
    ) return fail();
    let key: string;
    let terms: string;
    if (stage.trigger?.kind === "install_scheduled") {
      key = "install_scheduled";
      terms = billingTerms(stage.due_rule.days);
    } else if (
      stage.trigger?.kind === "council_step_completed" &&
      UUID.test(String(stage.trigger.submission_id || "")) &&
      UUID.test(String(stage.trigger.step_id || "")) &&
      typeof stage.trigger.step_name === "string" &&
      stage.trigger.step_name.trim() && stage.trigger.step_name.length <= 500 &&
      !/[\u0000-\u001f\u007f]/u.test(stage.trigger.step_name)
    ) {
      key = `council:${stage.trigger.submission_id}:${stage.trigger.step_id}`;
      terms = councilBillingTerms(stage.due_rule.days, stage.trigger.step_name);
    } else return fail();
    if (triggers.has(key) || stage.printed_terms !== terms) return fail();
    const index = payments.findIndex((p: any) => p.id === stage.id);
    const payment = payments[index];
    if (
      index <= 0 || payment.label !== stage.label ||
      payment.printed_terms !== stage.printed_terms ||
      cents(payment.amount_inc_gst) !== cents(stage.amount_inc_gst)
    ) return fail();
    selected.add(stage.id);
    triggers.add(key);
  }
  return { ok: true as const, stages: envelope.milestones };
}
export function acceptedInstallMilestone(raw: any) {
  const parsed = acceptedBillingMilestones(raw);
  if (!parsed.ok) return parsed;
  const stage = parsed.stages.find((s: any) =>
    s.trigger.kind === "install_scheduled"
  );
  return stage
    ? { ok: true as const, stage, amountCents: cents(stage.amount_inc_gst)! }
    : { ok: false as const, reason: "installation_billing_terms_missing" };
}
/** Accounting API pagination metadata is authoritative; a short page alone is not completeness. */
export function completeInvoicePage(result: any): boolean {
  const p = result?.pagination;
  const count = result?.Invoices?.length;
  return Array.isArray(result?.Invoices) && count < 100 && p?.page === 1 &&
    p.pageSize === 100 && Number.isInteger(p.pageCount) && p.pageCount >= 0 &&
    p.pageCount <= 1 && p.itemCount === count;
}
export interface DraftDeps {
  search(reference: string, contactId: string): Promise<any[]>;
  inventory(contactId: string): Promise<any[]>;
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
function admissionConflict(error: any): string | null {
  const message = String(error?.message || "");
  if (message.includes("earlier accepted revision")) {
    return "previous_revision_invoice_claim_requires_review";
  }
  if (
    message.includes("Accepted replacement quote") ||
    message.includes("accepted document changed")
  ) return "accepted_replacement_requires_review";
  return null;
}
async function admissionHold(client: any, review: any, reason: string) {
  const result = await client.rpc("record_invoice_milestone_admission_hold", {
    p_review_id: review.id,
    p_org_id: review.org_id,
    p_reason: reason,
  });
  if (result.error) throw new Error("Invoice admission hold could not persist");
  return { review_id: review.id, state: "held", reason };
}
/** A bounded exact-count read never treats a truncated evidence set as complete. */
async function siblingInvoiceEvidence(client: any, expected: any) {
  const evidence: Record<string, any[]> = {};
  for (
    const table of [
      "invoice_milestone_draft_claims",
      "quote_invoice_deposit_receipts",
    ]
  ) {
    const result = await client.from(table).select("*", { count: "exact" }).eq(
      "org_id",
      expected.org_id,
    ).eq("xero_contact_id", expected.xero_contact_id).neq(
      "job_id",
      expected.job_id,
    )
      .limit(100);
    const data = rows(result, "Other job invoice evidence");
    if (
      !Array.isArray(data) || !Number.isInteger(result.count) ||
      result.count < 0 || result.count >= 100 || result.count !== data.length
    ) {
      throw new Error("Other job invoice evidence incomplete");
    }
    evidence[table] = data;
  }
  return evidence;
}
async function invoiceInventorySafe(
  client: any,
  deps: DraftDeps,
  review: any,
  expected: any,
  claims: any[],
) {
  try {
    const mirrors = rows(
      await client.from("xero_invoices").select("xero_invoice_id").eq(
        "org_id",
        expected.org_id,
      ).eq("job_id", expected.job_id).eq("invoice_type", "ACCREC"),
      "Invoice mirror inventory",
    ) || [];
    const receipts = rows(
      await client.from("quote_invoice_deposit_receipts").select("*").eq(
        "org_id",
        expected.org_id,
      ).eq("job_id", expected.job_id).eq(
        "quote_revision_id",
        expected.quote_revision_id,
      ),
      "Accepted deposit receipts",
    ) || [];
    const inventory = await deps.inventory(expected.xero_contact_id);
    if (!Array.isArray(inventory) || inventory.length >= 100) {
      throw new Error("Provider inventory incomplete");
    }
    const ids = new Set<string>([
      ...inventory.map((i: any) => String(i.InvoiceID || "")),
      ...mirrors.map((i: any) => String(i.xero_invoice_id || "")),
    ]);
    let siblings: Record<string, any[]> | undefined;
    for (const invoiceId of ids) {
      if (!UUID.test(invoiceId)) {
        throw new Error("Provider inventory identity missing");
      }
      const invoice = await deps.read(invoiceId);
      if (invoice?.InvoiceID !== invoiceId || invoice.Type !== "ACCREC") {
        throw new Error("Provider inventory mismatch");
      }
      if (["VOIDED", "DELETED"].includes(invoice.Status)) continue;
      const known = claims.find((c: any) =>
        c.provider_invoice_id === invoiceId &&
        c.quote_revision_id === expected.quote_revision_id
      );
      const compared = known || expected;
      if (
        (known || invoice.Reference === expected.reference) &&
        matchesDraft({ ...invoice, Status: "DRAFT" }, compared) &&
        ["DRAFT", "AUTHORISED", "PAID"].includes(invoice.Status)
      ) continue;
      const receipt = receipts.find((r: any) =>
        r.provider_invoice_id === invoiceId
      );
      if (
        receipt &&
        receipt.accepted_document_id === review.accepted_document_id &&
        receipt.xero_contact_id === expected.xero_contact_id &&
        invoice.Contact?.ContactID === receipt.xero_contact_id &&
        invoice.CurrencyCode === "AUD" &&
        cents(invoice.Total) === receipt.amount_cents &&
        invoice.Reference === receipt.reference &&
        ["AUTHORISED", "PAID"].includes(invoice.Status)
      ) continue;
      // Only immutable evidence from a different job can explain a repeat
      // customer's invoice. Current-job history keeps the existing review gates.
      siblings ||= await siblingInvoiceEvidence(client, expected);
      const sibling = (r: any) =>
        r.org_id === expected.org_id &&
        r.xero_contact_id === expected.xero_contact_id &&
        UUID.test(String(r.job_id || "")) && r.job_id !== expected.job_id &&
        UUID.test(String(r.quote_revision_id || "")) &&
        r.provider_invoice_id === invoiceId;
      const siblingClaims = siblings.invoice_milestone_draft_claims.filter(
        sibling,
      );
      const siblingReceipts = siblings.quote_invoice_deposit_receipts.filter(
        sibling,
      );
      if (
        siblingClaims.length + siblingReceipts.length !== 1 ||
        siblings.invoice_milestone_draft_claims.some((c: any) =>
          c.state !== "draft_confirmed" &&
          (c.provider_invoice_id === invoiceId ||
            c.reference === invoice.Reference)
        )
      ) return "existing_invoice_requires_review";
      const siblingClaim = siblingClaims[0];
      if (
        siblingClaim?.state === "draft_confirmed" &&
        matchesDraft({ ...invoice, Status: "DRAFT" }, siblingClaim) &&
        ["DRAFT", "AUTHORISED", "PAID"].includes(invoice.Status)
      ) continue;
      const siblingReceipt = siblingReceipts[0];
      if (
        siblingReceipt &&
        UUID.test(String(siblingReceipt.accepted_document_id || "")) &&
        invoice.Contact?.ContactID === siblingReceipt.xero_contact_id &&
        invoice.CurrencyCode === "AUD" &&
        cents(invoice.Total) === siblingReceipt.amount_cents &&
        invoice.Reference === siblingReceipt.reference &&
        ["AUTHORISED", "PAID"].includes(invoice.Status)
      ) continue;
      return "existing_invoice_requires_review";
    }
    return null;
  } catch {
    return "invoice_inventory_unavailable";
  }
}
export async function processInstallDrafts(
  client: any,
  deps: DraftDeps,
  jobId: string,
  orgId: string,
  triggerKind: "scheduled" | "council_step_complete" | "all" = "scheduled",
) {
  let reviewQuery = client.from("invoice_milestone_reviews").select("*").eq(
    "job_id",
    jobId,
  ).eq("org_id", orgId);
  if (triggerKind !== "all") {
    reviewQuery = reviewQuery.eq("trigger_kind", triggerKind);
  }
  const reviews = rows(await reviewQuery, "Invoice reviews") || [];
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
        "id,quote_revision_id,job_id,job_contact_id,run_label,accepted_at,sent_at,superseded_at",
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
      doc.job_contact_id || doc.run_label != null ||
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
        "id,quote_revision_id,accepted_at,sent_at,superseded_at",
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
    if (
      documents.some((d: any) =>
        d.accepted_at &&
        (d.id !== doc.id || d.quote_revision_id !== revision.id)
      ) ||
      !(new Date(doc.accepted_at).getTime() >=
          new Date(revision.sent_at).getTime() &&
        new Date(doc.accepted_at).getTime() >= new Date(doc.sent_at).getTime())
    ) {
      outcomes.push(
        await admissionHold(
          client,
          review,
          "accepted_replacement_requires_review",
        ),
      );
      continue;
    }
    const parsed = acceptedBillingMilestones(
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
    const stage = parsed.stages.find((s: any) =>
      review.trigger_kind === "scheduled"
        ? s.trigger.kind === "install_scheduled"
        : s.trigger.kind === "council_step_completed" &&
          s.trigger.submission_id === review.source?.submission_id &&
          s.trigger.step_id === review.source?.step_id
    );
    if (!stage) {
      outcomes.push({
        review_id: review.id,
        state: "held",
        reason: "accepted_trigger_binding_missing",
      });
      continue;
    }
    if (stage.trigger.kind === "council_step_completed") {
      const council = rows(
        await client.from("quote_invoice_council_bindings").select("*").eq(
          "quote_revision_id",
          revision.id,
        ).eq("stage_id", stage.id).eq("org_id", orgId).eq("job_id", jobId)
          .maybeSingle(),
        "Frozen council step",
      );
      const submission = rows(
        await client.from("council_submissions").select("id,job_id,steps").eq(
          "id",
          stage.trigger.submission_id,
        ).eq("job_id", jobId).maybeSingle(),
        "Council completion",
      );
      const exact = Array.isArray(submission?.steps)
        ? submission.steps.filter((s: any) =>
          s.step_id === stage.trigger.step_id
        )
        : [];
      if (
        council?.state !== "eligible" ||
        council.submission_id !== stage.trigger.submission_id ||
        council.step_id !== stage.trigger.step_id ||
        council.step_name !== stage.trigger.step_name || exact.length !== 1 ||
        exact[0].name !== stage.trigger.step_name ||
        exact[0].status !== "complete" ||
        exact[0].completion_source !== "explicit_status_update"
      ) {
        outcomes.push({
          review_id: review.id,
          state: "held",
          reason: "council_completion_or_release_binding_missing",
        });
        continue;
      }
    }
    const amountCents = cents(stage.amount_inc_gst)!;
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
    const jobClaims = rows(
      await client.from("invoice_milestone_draft_claims").select("*").eq(
        "org_id",
        orgId,
      ).eq("job_id", jobId),
      "Prior invoice claims",
    ) || [];
    if (jobClaims.some((c: any) => c.quote_revision_id !== revision.id)) {
      outcomes.push(
        await admissionHold(
          client,
          review,
          "previous_revision_invoice_claim_requires_review",
        ),
      );
      continue;
    }
    const hash = await digest(payload);
    const reference = `SW-BILL-${
      (await digest({ orgId, jobId, revision: revision.id, stage: stage.id }))
        .slice(0, 40)
    }`;
    const sameClaim = jobClaims.find((c: any) =>
      c.quote_revision_id === revision.id && c.stage_id === stage.id
    );
    if (sameClaim && sameClaim.state !== "prepared") {
      outcomes.push(sameClaim);
      continue;
    }
    const inventoryHold = await invoiceInventorySafe(client, deps, review, {
      ...payload,
      reference,
    }, jobClaims);
    if (inventoryHold) {
      outcomes.push(await admissionHold(client, review, inventoryHold));
      continue;
    }
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
    const insertHold = admissionConflict(inserted.error);
    if (insertHold) {
      outcomes.push(
        await admissionHold(
          client,
          review,
          insertHold,
        ),
      );
      continue;
    }
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
    const acquisition = await client.from("invoice_milestone_draft_claims")
      .update({
        state: "dispatching",
        hold_reason: "dispatch_outcome_pending",
      }).eq("id", claim.id).eq("state", "prepared").select().maybeSingle();
    const dispatchHold = admissionConflict(acquisition.error);
    if (dispatchHold) {
      outcomes.push(
        await admissionHold(
          client,
          review,
          dispatchHold,
        ),
      );
      continue;
    }
    const acquired = rows(acquisition, "Invoice dispatch claim");
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
