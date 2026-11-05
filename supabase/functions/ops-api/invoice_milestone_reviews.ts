/** Office preparation queue only. A held intent is never an invoice. */
export async function readInvoiceMilestoneReviews(
  client: any,
  jobId: string,
  orgId: string,
) {
  const { data: job, error: jobError } = await client.from("jobs")
    .select("id").eq("id", jobId).eq("org_id", orgId).maybeSingle();
  if (jobError) throw new Error("Invoice review job lookup failed");
  if (!job) return { ok: false, code: "job_not_found", status_code: 404 };
  const { data, error } = await client.from("invoice_milestone_reviews")
    .select(
      "id,job_id,accepted_document_id,job_contact_id,accepted_quote_revision_id,milestone_key,trigger_kind,state,hold_reasons,source,created_at",
    )
    .eq("job_id", jobId).eq("org_id", orgId).order("created_at", {
      ascending: false,
    });
  if (error) throw new Error("Invoice milestone reviews could not be read");
  return {
    ok: true,
    job_id: jobId,
    reviews: data ?? [],
    preparation_only: true,
    automatic_xero_drafts: false,
    send_requires_staff: true,
  };
}
