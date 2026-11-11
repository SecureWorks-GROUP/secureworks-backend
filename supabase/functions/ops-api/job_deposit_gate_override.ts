// deno-lint-ignore-file no-explicit-any
// RQ-19.e: the owner's and the office's override of the deposit gate, with a
// reason recorded (owner, 10 Nov 2026). Three staff doors:
//   job_deposit_gate                   GET   the gate on one job, and any override
//   override_job_deposit_gate          POST  {job_id, reason}
//   revoke_job_deposit_gate_override   POST  {job_id, reason}
// An override is a person's act: only a signed-in admin, owner or ops manager
// of the job's own company records or revokes one (checked again in the
// database), never the ops key, an agent or a routine. The record is
// job_deposit_gate_overrides (20261111110000); nothing here sends, invoices or
// changes a job's status.
import { readDepositGate } from "./job_start_deposits.ts";

export class DepositGateOverrideError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get body() {
    return { success: false, error: this.message, code: this.code, ...this.extra };
  }
}

export type DepositGateOverridePerson = {
  /** True only for a signed-in session (never the ops key or an agent). */
  session: boolean;
  userId: string | null;
  role: string | null;
};

const STAFF_ROLES = new Set(["admin", "owner", "ops_manager"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobIdOf(input: unknown): string {
  const id = typeof input === "string" ? input.trim() : "";
  if (!UUID_RE.test(id)) {
    throw new DepositGateOverrideError(400, "job_id_required", "job_id must be a job's id");
  }
  return id;
}

function requirePerson(person: DepositGateOverridePerson): string {
  if (
    !person.session || !person.userId ||
    !STAFF_ROLES.has(String(person.role ?? "").toLowerCase())
  ) {
    throw new DepositGateOverrideError(
      403,
      "deposit_gate_override_needs_person",
      "Only the owner or the office, signed in, can override the deposit gate.",
    );
  }
  return person.userId;
}

// The database raises DG<status> <code>; anything else is a plain failure.
function fromDatabase(error: any): never {
  const text = String(error?.message ?? "");
  const m = /DG(400|403|404|409) ([a-z_]+)/.exec(text);
  if (m) {
    const messages: Record<string, string> = {
      deposit_gate_job_not_found: "That job was not found.",
      deposit_gate_override_not_allowed:
        "Only the owner or the office of this job's company can do this.",
      deposit_gate_override_reason_required:
        "Give a reason of at least 10 characters.",
      deposit_gate_revoke_reason_required: "Give a reason for taking it off.",
      deposit_gate_override_exists: "This job already has an override.",
      deposit_gate_override_not_live: "This job has no override to take off.",
    };
    throw new DepositGateOverrideError(
      Number(m[1]),
      m[2],
      messages[m[2]] ?? "The override was not recorded.",
    );
  }
  throw new DepositGateOverrideError(
    500,
    "deposit_gate_override_failed",
    "The override could not be recorded. Nothing was changed.",
  );
}

export async function readJobDepositGate(client: any, params: URLSearchParams) {
  const jobId = jobIdOf(params.get("job_id"));
  return { success: true, ...(await readDepositGate(client, jobId)) };
}

export async function overrideJobDepositGate(
  client: any,
  body: any,
  person: DepositGateOverridePerson,
) {
  const userId = requirePerson(person);
  const jobId = jobIdOf(body?.job_id);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10) {
    throw new DepositGateOverrideError(
      400,
      "deposit_gate_override_reason_required",
      "Give a reason of at least 10 characters.",
    );
  }
  // Only a held gate takes an override, and the record keeps why it was held.
  const gate = await readDepositGate(client, jobId);
  if (gate.gate === "open") {
    throw new DepositGateOverrideError(
      409,
      "deposit_gate_not_held",
      "This job is not held by the deposit gate, so it needs no override.",
      { gate },
    );
  }
  if (gate.gate === "overridden") {
    throw new DepositGateOverrideError(
      409,
      "deposit_gate_override_exists",
      "This job already has an override.",
      { gate },
    );
  }
  if (!gate.override_readable) {
    throw new DepositGateOverrideError(
      503,
      "deposit_gate_override_unreadable",
      "The override record could not be read. Nothing was changed.",
    );
  }
  const { data, error } = await client.rpc("grant_job_deposit_gate_override", {
    p_job_id: jobId,
    p_user_id: userId,
    p_reason: reason,
    p_unpaid_reasons: [gate.reason, ...gate.reasons].filter(Boolean),
  });
  if (error || !data) fromDatabase(error);
  return { success: true, override: data, held_for: gate.reasons };
}

export async function revokeJobDepositGateOverride(
  client: any,
  body: any,
  person: DepositGateOverridePerson,
) {
  const userId = requirePerson(person);
  const jobId = jobIdOf(body?.job_id);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    throw new DepositGateOverrideError(
      400,
      "deposit_gate_revoke_reason_required",
      "Give a reason for taking it off.",
    );
  }
  const { data, error } = await client.rpc("revoke_job_deposit_gate_override", {
    p_job_id: jobId,
    p_user_id: userId,
    p_reason: reason,
  });
  if (error || !data) fromDatabase(error);
  return { success: true, override: data };
}
