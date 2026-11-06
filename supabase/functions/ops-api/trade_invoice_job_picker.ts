// Named, owner-authorised exceptions live on the protected public profile.
// Browser profile writes cannot set this key (users_guard_self_update plus
// update_trade_profile's allowlist). Missing is off. This grants selection for
// the caller's OWN invoice only, never the general Trade App visibility tier.
export async function readInvoiceAnyJobPermission(
  client: any,
  viewer: { id: string; orgId: string },
): Promise<boolean> {
  const { data, error } = await client.from("users")
    .select("invoice_any_job:trade_details->invoiceAnyJob")
    .eq("id", viewer.id)
    .eq("org_id", viewer.orgId)
    .maybeSingle();
  if (error) {
    throw new Error("Could not check invoice job selection permission");
  }
  return data?.invoice_any_job === true;
}

// Allowlist the reply independently of DB projection and future enrichments.
// A picker result is not authority to open that job's detail or see its money.
export function presentInvoiceJobPickerRow(job: any) {
  return {
    id: job.id,
    job_number: job.job_number ?? null,
    client_name: job.client_name ?? null,
    site_suburb: job.site_suburb ?? null,
    type: job.type ?? null,
    status: job.status ?? null,
    external_ref: job.external_ref ?? null,
  };
}
