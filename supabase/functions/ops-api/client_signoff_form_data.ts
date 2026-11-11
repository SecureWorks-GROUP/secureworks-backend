// One price-free form for the existing client link and the office's paper copy.
export type ClientSignoffForm = {
  job_number: string;
  address: string;
  client_name: string;
};

export const SIGNED_CLIENT_COPY_COLUMNS =
  "org_id,captured_by,captured_by_actor,capture_auth_source,capture_request_id,capture_payload_hash,signed_copy_path,signed_copy_sha256,signed_copy_type,signed_copy_name,client_confirmed_on,work_done,outstanding_items,confirmation_kind,confirmation_reference";

export function clientSignoffForm(job: Record<string, unknown>): ClientSignoffForm {
  const address = String(job.site_address || "").trim();
  const suburb = String(job.site_suburb || "").trim();
  const hasSuburb = suburb && address.toLowerCase().includes(suburb.toLowerCase());
  return {
    job_number: String(job.job_number || ""),
    address: [address, hasSuburb ? "" : suburb].filter(Boolean).join(", "),
    client_name: String(job.client_name || ""),
  };
}

export function validSignoffDay(value: unknown): boolean {
  const day = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(day + "T00:00:00Z");
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

/** An office entry names its real source; a waiver is not client confirmation. */
export function hasOfficeClientConfirmation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const identified = Boolean(row.org_id && row.job_id && row.captured_by) &&
    row.capture_auth_source === "jwt" &&
    row.captured_by_actor === "user:" + String(row.captured_by) &&
    validSignoffDay(row.client_confirmed_on) &&
    String(row.signed_name || "").trim().length > 0 &&
    String(row.work_done || "").trim().length > 0;
  if (!identified) return false;
  if (row.confirmation_kind === "written_confirmation") {
    return String(row.confirmation_reference || "").trim().length >= 5;
  }
  return hasSignedClientCopy(row);
}

/** File integrity and ownership. Acceptance and currentness are separate. */
export function hasSignedClientCopy(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const prefix = String(row.org_id || "") + "/" + String(row.job_id || "") + "/";
  const path = String(row.signed_copy_path || "");
  return row.confirmation_kind === "signed_copy" && Boolean(row.org_id && row.job_id) &&
    path.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg)$/.test(path.slice(prefix.length)) &&
    /^sha256:[0-9a-f]{64}$/.test(String(row.signed_copy_sha256 || "")) &&
    ["application/pdf", "image/png", "image/jpeg"].includes(String(row.signed_copy_type));
}
