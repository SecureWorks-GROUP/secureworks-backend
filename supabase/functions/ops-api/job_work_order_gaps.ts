// deno-lint-ignore-file no-explicit-any
import {
  JobWorkOrderOfficeError,
  type OfficeActor,
} from "./job_work_order_office.ts";

export async function readJobWorkOrderGaps(
  client: any,
  method: string,
  actor: OfficeActor,
): Promise<unknown> {
  if (method !== "GET") {
    throw new JobWorkOrderOfficeError(
      405,
      "method_not_allowed",
      "job_work_order_gaps is GET only",
    );
  }
  if (!actor.staff || !actor.orgId) {
    throw new JobWorkOrderOfficeError(
      403,
      "staff_required",
      "Staff access to a company is required",
    );
  }
  try {
    const { data, error } = await client.rpc("job_work_order_gaps", {
      p_org_id: actor.orgId,
    });
    if (error || data == null) throw new Error("unreadable");
    return data;
  } catch {
    throw new JobWorkOrderOfficeError(
      503,
      "gaps_unreadable",
      "The list of jobs needing a work order could not be read",
    );
  }
}
