// deno-lint-ignore-file no-explicit-any
// Context reconciliation from a job (CTX-N1, 20261020165000): two read-only
// doors behind the ops-api staff front door.
//
//   GET ?action=context_job_mail&job_id=|job_number=[&limit=n][&roles=supplier,staff]
//     -> RPC context_job_mail(p_job, p_limit, p_roles): the email rows Context
//        places on the job (certain or candidate, by person or ladder, why),
//        each naming the other jobs it sits on. A consumer such as Dispatch
//        reads supplier mail it has no po_communications row for from here.
//   GET ?action=recon_job_items&job_id=|job_number=
//     -> RPC context_recon_job_items(p_job): the queued rows that offer the
//        job, defects included, each with the evidence hash a decision echoes
//        (recon_record_decision's shown_hash) and every job offered.
//
// Neither writes. A failed read is a failed read, never an empty list: the
// database error is answered as 502 read_failed. A job number is matched whole
// against the stored number, never by pattern.

export class ContextJobReconError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const CONTEXT_JOB_RECON_ACTIONS = [
  "context_job_mail",
  "recon_job_items",
] as const;

// metadata.party_roles.counterpart_role values the classifier writes.
export const CONTEXT_MAIL_ROLES = [
  "customer",
  "supplier",
  "staff",
  "crew",
  "council",
  "insurer_builder",
  "unknown",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_NUMBER = /^[A-Za-z0-9-]{1,40}$/;

function bad(message: string): never {
  throw new ContextJobReconError("invalid_request", 400, message);
}

function readFailed(what: string, error: unknown): never {
  const e = error as { code?: unknown; message?: unknown };
  console.error(
    `[context_job_recon] ${what} failed:`,
    String(e?.code ?? ""),
    String(e?.message ?? error),
  );
  throw new ContextJobReconError(
    "read_failed",
    502,
    `The ${what} could not be read. Nothing is shown rather than an empty list.`,
  );
}

export function contextMailArgs(params: URLSearchParams) {
  const raw = params.get("limit");
  let limit = 100;
  if (raw !== null) {
    if (!/^\d{1,3}$/.test(raw)) bad("limit must be a whole number");
    limit = Number(raw);
    if (limit < 1 || limit > 500) bad("limit must be between 1 and 500");
  }
  let roles: string[] | null = null;
  const rawRoles = params.get("roles");
  if (rawRoles !== null && rawRoles.trim() !== "") {
    roles = [...new Set(rawRoles.split(",").map((r) => r.trim()))];
    for (const role of roles) {
      if (!(CONTEXT_MAIL_ROLES as readonly string[]).includes(role)) {
        bad(`unknown role ${role}`);
      }
    }
  }
  return { p_limit: limit, p_roles: roles };
}

// The job the call names: job_id, or a job number matched whole.
export async function resolveContextJob(
  client: any,
  params: URLSearchParams,
): Promise<{ id: string; job_number: string | null }> {
  const id = params.get("job_id") ?? params.get("jobId");
  const number = params.get("job_number");
  if (id) {
    if (!UUID.test(id)) bad("job_id must be a uuid");
    const { data, error } = await client.from("jobs").select("id, job_number")
      .eq("id", id).limit(1);
    if (error) readFailed("job", error);
    if (!data || data.length === 0) {
      throw new ContextJobReconError(
        "job_not_found",
        404,
        "That job was not found.",
      );
    }
    return data[0];
  }
  if (number) {
    if (!JOB_NUMBER.test(number)) bad("job_number is not a job number");
    const { data, error } = await client.from("jobs").select("id, job_number")
      .eq("job_number", number).limit(2);
    if (error) readFailed("job", error);
    if (!data || data.length === 0) {
      throw new ContextJobReconError(
        "job_not_found",
        404,
        "That job was not found.",
      );
    }
    if (data.length > 1) {
      throw new ContextJobReconError(
        "job_number_ambiguous",
        409,
        "More than one job carries that number. Use job_id.",
      );
    }
    return data[0];
  }
  return bad("job_id or job_number is required");
}

export async function contextJobMail(client: any, params: URLSearchParams) {
  const args = contextMailArgs(params);
  const job = await resolveContextJob(client, params);
  const { data, error } = await client.rpc("context_job_mail", {
    p_job: job.id,
    ...args,
  });
  if (error) readFailed("job mail", error);
  const mail = Array.isArray(data) ? data : [];
  return {
    job_id: job.id,
    job_number: job.job_number,
    mail,
    // A candidate row may belong to another job; the consumer marks it so.
    candidate_count:
      mail.filter((m: any) => m?.placement === "candidate").length,
    limit: args.p_limit,
    roles: args.p_roles,
  };
}

export async function reconJobItems(client: any, params: URLSearchParams) {
  const job = await resolveContextJob(client, params);
  const { data, error } = await client.rpc("context_recon_job_items", {
    p_job: job.id,
  });
  if (error) readFailed("job items", error);
  return {
    job_id: job.id,
    job_number: job.job_number,
    items: Array.isArray(data) ? data : [],
  };
}
