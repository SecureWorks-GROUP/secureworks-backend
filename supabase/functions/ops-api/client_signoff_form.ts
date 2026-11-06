// Office companion to the existing client sign-off link and append-only ledger.
// No email, work-order approval, completion, split or money writer lives here.
import { decodeBase64, encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { clientSignoffForm, hasSignedClientCopy, hasOfficeClientConfirmation, validSignoffDay } from "./client_signoff_form_data.ts";
import { renderClientSignoffForm } from "./client_signoff_form_render.ts";

export const CLIENT_SIGNOFF_COPY_BUCKET = "client-signoff-copies";
export const CLIENT_SIGNOFF_COPY_MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type OfficeSignoffCaller = { userId: string; orgId: string | null; isStaff: boolean };
export class ClientSignoffFormError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function fail(code: string, message: string, status = 400): never { throw new ClientSignoffFormError(code, message, status); }
function text(value: unknown, maximum: number): string {
  const result = String(value ?? "").trim();
  if (result.length > maximum) fail("client_signoff_text_too_long", "Shorten the form text before recording it.");
  return result;
}
function checked<T>(result: { data: T; error?: unknown }, what: string): T {
  if (result.error) fail("client_signoff_unreadable", "Could not " + what + ". Nothing is confirmed; refresh before retrying.", 503);
  return result.data;
}
async function jobForOffice(client: any, caller: OfficeSignoffCaller, id: string) {
  if (!caller.isStaff) fail("client_signoff_office_only", "Only the office can record a client's confirmation.", 403);
  if (!UUID.test(id)) fail("client_signoff_job_required", "Choose the job.");
  let query = client.from("jobs").select("id,org_id,job_number,type,client_name,site_address,site_suburb").eq("id", id);
  if (caller.orgId) query = query.eq("org_id", caller.orgId);
  const job: any = checked(await query.maybeSingle(), "read this job");
  if (!job) fail("client_signoff_job_not_found", "This job was not found.", 404);
  if (!["fencing", "patio"].includes(String(job.type))) fail("client_signoff_job_type", "This client form is for fencing and patio work.", 409);
  return job;
}

export async function readOfficeClientSignoff(client: any, caller: OfficeSignoffCaller, jobId: string) {
  const job = await jobForOffice(client, caller, jobId);
  const [signoffResult, groupResult] = await Promise.all([
    client.from("job_client_signoffs").select("*").eq("job_id", job.id)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle(),
    client.from("group_work_orders").select("id,share_token,split_frozen_at").eq("job_id", job.id).neq("status", "void").maybeSingle(),
  ]);
  const row: any = checked(signoffResult, "read the latest sign-off");
  const group: any = checked(groupResult, "read the client link");
  const confirmationCounts = group ? checked(await client.rpc("group_client_signoff_counts", {p_job:job.id}), "check the current client confirmation") : null;
  let enteredName: string | null = null;
  if (row?.captured_by) {
    const person: any = checked(await client.from("users").select("name").eq("id", row.captured_by).eq("org_id", job.org_id).maybeSingle(), "read who recorded the sign-off");
    enteredName = person?.name || null;
  }
  return {
    job_id: job.id,
    form: clientSignoffForm(job),
    share_token: group?.share_token || null,
    group_id: group?.id || null,
    split_frozen: Boolean(group?.split_frozen_at),
    counts_for_group: confirmationCounts,
    can_record_copy: Boolean(caller.userId && caller.orgId && !group?.split_frozen_at),
    current: row ? {
      id: row.id, method: row.method, signed_name: row.signed_name, happy: row.happy,
      created_at: row.created_at, captured_by_actor: row.captured_by_actor, entered_by_name: enteredName,
      capture_auth_source: row.capture_auth_source || null,
      client_confirmed_on: row.client_confirmed_on || null, work_done: row.work_done || null,
      outstanding_items: row.outstanding_items || null,
      confirmation_kind: row.confirmation_kind || null, confirmation_reference: row.confirmation_reference || null,
      has_client_confirmation: hasOfficeClientConfirmation(row),
      has_signed_copy: hasSignedClientCopy(row), signed_copy_name: row.signed_copy_name || null,
    } : null,
  };
}

export function decodeClientSignedCopy(base64: unknown) {
  const source = String(base64 || "");
  if (!source || source.length > Math.ceil(CLIENT_SIGNOFF_COPY_MAX_BYTES / 3) * 4) {
    fail("client_signoff_copy_size", "Choose a signed PDF, PNG or JPEG no larger than 8 MB.");
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase64(source); } catch { fail("client_signoff_copy_invalid", "The signed copy could not be read."); }
  if (!bytes.length || bytes.length > CLIENT_SIGNOFF_COPY_MAX_BYTES) fail("client_signoff_copy_size", "The signed copy must be no larger than 8 MB.");
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === "%PDF-") return { bytes, type: "application/pdf", extension: "pdf" };
  if ([137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) return { bytes, type: "image/png", extension: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, type: "image/jpeg", extension: "jpg" };
  fail("client_signoff_copy_type", "Choose the client's signed PDF, PNG or JPEG, not another file type.");
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return "sha256:" + Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, "0")).join("");
}
async function requestRecord(client: any, id: string): Promise<any> {
  return checked(await client.from("job_client_signoffs").select("*").eq("capture_request_id", id).maybeSingle(), "check the recorded copy");
}
function replay(row: any, hash: string, jobId: string, caller: OfficeSignoffCaller) {
  if (row.capture_payload_hash !== hash || row.job_id !== jobId || row.captured_by !== caller.userId) {
    fail("client_signoff_request_changed", "This recording request was already used with different details. Refresh the job before starting a new record.", 409);
  }
  return { recorded: true, signoff_id: row.id, already_recorded: true, happy: row.happy };
}

export async function recordOfficeClientConfirmation(client: any, caller: OfficeSignoffCaller, body: Record<string, unknown>) {
  if (!caller.isStaff || !caller.userId || !caller.orgId) fail("client_signoff_session_required", "Sign in with your own office account to record who entered the client's confirmation.", 403);
  const job = await jobForOffice(client, caller, text(body.job_id, 36));
  const requestId = text(body.request_id, 36);
  if (!UUID.test(requestId)) fail("client_signoff_request_required", "Start a new client-confirmation record.");
  const name = text(body.signed_name, 120), day = text(body.client_confirmed_on, 10);
  const work = text(body.work_done, 10000), notes = text(body.outstanding_items, 10000);
  if (!name || !work || !validSignoffDay(day)) fail("client_signoff_details_required", "Enter the client's name, confirmation date and work completed.");
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (day > today) fail("client_signoff_date_future", "The confirmation date cannot be in the future.");
  if (typeof body.client_accepts !== "boolean") fail("client_signoff_acceptance_required", "Record whether the client accepted the work. Do not infer it from a signature.");
  if (body.current_client_confirmation !== true) fail("client_signoff_copy_confirmation", "Confirm this is the client's current confirmation, including changes since any earlier sign-off.");
  const kind = String(body.confirmation_kind || "");
  if (!["signed_copy", "written_confirmation"].includes(kind)) fail("client_signoff_source_required", "Choose a client-signed copy or the client's written confirmation.");
  const reference = text(body.confirmation_reference, 2000);
  if (kind === "written_confirmation" && reference.length < 5) fail("client_signoff_reference_required", "Give the reference to the client's written confirmation, including how to find it.");
  if (kind === "written_confirmation" && body.file_base64) fail("client_signoff_source_mismatch", "Choose signed copy to attach a file, or remove the file before recording a written reference.");
  const copy = kind === "signed_copy" ? decodeClientSignedCopy(body.file_base64) : null;
  const originalName = text(body.file_name, 180).replace(/[\\/\r\n]/g, "_");
  const fileName = copy ? (originalName.replace(/\.[^.]*$/, "") || "client-signed-copy") + "." + copy.extension : null;
  const fileHash = copy ? await digest(copy.bytes) : null;
  const payload = { job_id: job.id, org_id: caller.orgId, actor: caller.userId, name, day, work, notes, accepts: body.client_accepts, kind, reference, fileHash, type: copy?.type || null, fileName };
  const payloadHash = await digest(new TextEncoder().encode(JSON.stringify(payload)));
  const previous = await requestRecord(client, requestId);
  if (previous) return replay(previous, payloadHash, job.id, caller);
  const group: any = checked(await client.from("group_work_orders").select("id,split_frozen_at,signoff_required_after").eq("job_id", job.id).neq("status", "void").maybeSingle(), "check the group");
  if (group?.split_frozen_at) fail("client_signoff_split_frozen", "The group shares are frozen. The office must review and reopen them before recording a new sign-off.", 409);
  if (group?.signoff_required_after) {
    const reopened = Date.parse(String(group.signoff_required_after));
    if (!Number.isFinite(reopened) || day < new Date(reopened + 8 * 3600_000).toISOString().slice(0,10)) {
      fail("client_signoff_confirmation_stale", "The client must confirm again after the group was reopened. An earlier signed copy or written confirmation cannot unlock the new work.", 409);
    }
  }
  const path = copy ? caller.orgId + "/" + job.id + "/" + requestId + "." + copy.extension : null;
  if (copy && path) {
    const storage = client.storage.from(CLIENT_SIGNOFF_COPY_BUCKET);
    const uploaded = await storage.upload(path, copy.bytes, { contentType: copy.type, upsert: false });
  if (uploaded.error) {
    // A lost upload response can be reconciled only to these exact bytes.
    const existing = await storage.download(path);
    if (existing.error || !existing.data || await digest(new Uint8Array(await existing.data.arrayBuffer())) !== fileHash) {
      fail("client_signoff_upload_unconfirmed", "The upload could not be confirmed. Keep this form and retry the same recording request.", 503);
    }
  }
  }
  const result = await client.from("job_client_signoffs").insert({
    org_id: caller.orgId, job_id: job.id, method: "office_on_behalf",
    signed_name: name, happy: body.client_accepts, client_confirmed_on: day,
    work_done: work, outstanding_items: notes || null, confirmation_kind: kind, confirmation_reference: reference || null,
    captured_by: caller.userId, captured_by_actor: "user:" + caller.userId,
    capture_auth_source: "jwt", captured_device: kind === "signed_copy" ? "Office: client-signed copy" : "Office: client written confirmation",
    capture_request_id: requestId, capture_payload_hash: payloadHash,
    signed_copy_path: path, signed_copy_sha256: fileHash,
    signed_copy_type: copy?.type || null, signed_copy_name: fileName,
  }).select("id").single();
  if (result.error) {
    const recorded = await requestRecord(client, requestId);
    if (recorded) return replay(recorded, payloadHash, job.id, caller);
    fail("client_signoff_record_unconfirmed", "The client confirmation could not be recorded. Keep this form and retry the same request.", 503);
  }
  return { recorded: true, signoff_id: result.data.id, already_recorded: false, happy: body.client_accepts };
}

export async function readOfficeClientSignedCopy(client: any, caller: OfficeSignoffCaller, jobId: string, signoffId: string) {
  const job = await jobForOffice(client, caller, jobId);
  if (!UUID.test(signoffId)) fail("client_signoff_record_required", "Choose the recorded sign-off.");
  const row: any = checked(await client.from("job_client_signoffs").select("*").eq("job_id", job.id).eq("id", signoffId).maybeSingle(), "read the signed copy");
  if (!hasSignedClientCopy(row)) fail("client_signoff_copy_missing", "This sign-off has no verified signed copy.", 404);
  const file = await client.storage.from(CLIENT_SIGNOFF_COPY_BUCKET).download(row.signed_copy_path);
  if (file.error || !file.data || file.data.size > CLIENT_SIGNOFF_COPY_MAX_BYTES) fail("client_signoff_copy_unavailable", "The signed copy could not be read.", 503);
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (await digest(bytes) !== row.signed_copy_sha256) fail("client_signoff_copy_changed", "The stored copy does not match the recorded file. The office must review it.", 503);
  return { file_name: row.signed_copy_name, content_type: row.signed_copy_type, file_base64: encodeBase64(bytes) };
}

export async function printableClientSignoff(form: ReturnType<typeof clientSignoffForm>) {
  return { file_name: "Client-signoff-" + (form.job_number || "job").replace(/[^A-Za-z0-9_-]/g, "_") + ".pdf",
    content_type: "application/pdf", file_base64: encodeBase64(await renderClientSignoffForm(form)) };
}
