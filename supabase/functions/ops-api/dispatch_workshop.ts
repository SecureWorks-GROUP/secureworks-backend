import { ContextMailError } from "./context_mail.ts";

export async function readDispatchJobWorkshop(
  client: { rpc: Function },
  params: { job_id?: string; po_id?: string },
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  if (auth.mode === "jwt") {
    if (!auth.user?.id) throw new ContextMailError(401, "named operator required");
    if (auth.user.orgId && auth.user.orgId !== expectedOrgId) {
      throw new ContextMailError(403, "operator organisation mismatch");
    }
  }
  if (!params.job_id) throw new ContextMailError(400, "job_id is required");
  const { data, error } = await client.rpc("read_dispatch_job_workshop", {
    p_org_id: expectedOrgId,
    p_job_id: params.job_id,
    p_po_id: params.po_id || null,
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}
