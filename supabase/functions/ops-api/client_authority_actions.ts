// Office side of the client authority (see _shared/client_authority.ts):
//   client_authority_create  POST  opens one on a job and returns the link to text
//   client_authority_status  GET   the job's authorities, pending and signed
// Sends nothing: the link goes to the client by a separate, approved text.

import {
  authorityLink,
  CLIENT_AUTHORITY_DOC_KIND,
  CLIENT_AUTHORITY_LINK_DAYS,
  CURRENT_AUTHORITY_WORDING,
  newAuthorityToken,
  sha256Hex,
  wordingText,
} from "../_shared/client_authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export class ClientAuthorityError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function createClientAuthority(
  client: any,
  body: Record<string, unknown>,
  operator: string | null,
): Promise<Record<string, unknown>> {
  const jobId = text(body.job_id);
  if (!UUID.test(jobId)) throw new ClientAuthorityError(400, "job_id_invalid", "job_id must be the job's UUID.");
  const signerName = text(body.signer_name).slice(0, 120);
  if (!signerName) throw new ClientAuthorityError(400, "signer_name_required", "signer_name is required: the property owner who will sign.");
  const signerPhone = text(body.signer_phone).slice(0, 40) || null;

  const { data: job, error: jobErr } = await client.from("jobs")
    .select("id, job_number, site_address, client_name, client_phone")
    .eq("id", jobId).maybeSingle();
  if (jobErr) throw new ClientAuthorityError(503, "job_read_failed", `Could not read the job (${jobErr.message}).`);
  if (!job) throw new ClientAuthorityError(404, "job_not_found", "Job not found.");

  const token = newAuthorityToken();
  const wording = CURRENT_AUTHORITY_WORDING;
  const wordingSha = await sha256Hex(wordingText(wording));
  const expiresAt = new Date(Date.now() + CLIENT_AUTHORITY_LINK_DAYS * 86_400_000).toISOString();
  const fileName = `Client authority - ${job.job_number} - pending.pdf`;
  const link = authorityLink(token);

  const { data: row, error } = await client.from("job_documents").insert({
    job_id: jobId,
    type: "other",
    file_name: fileName,
    visible_to_trades: false,
    metadata: {
      kind: CLIENT_AUTHORITY_DOC_KIND,
      client_authority: "pending",
      authority_token: token,
      wording_version: wording.version,
      wording_sha256: wordingSha,
      signer_name: signerName,
      signer_phone: signerPhone,
      expires_at: expiresAt,
      created_by: operator,
    },
  }).select("id").single();
  if (error || !row) throw new ClientAuthorityError(503, "authority_create_failed", `Could not save the authority (${error?.message || "no row"}).`);

  await client.from("job_events").insert({
    job_id: jobId,
    event_type: "client_authority_created",
    detail_json: { document_id: row.id, signer_name: signerName, wording_version: wording.version, operator },
  });

  return {
    success: true,
    job_id: jobId,
    job_number: job.job_number,
    document_id: row.id,
    link,
    signer_name: signerName,
    signer_phone: signerPhone,
    wording_version: wording.version,
    expires_at: expiresAt,
    suggested_text:
      `Hi ${signerName.split(/\s+/)[0]}, this is SecureWorks about the restoration works at ${job.site_address || "your property"}. ` +
      `Before we start, please read and sign our authority form here: ${link} Thanks.`,
    note: "Nothing was sent. Text the link to the owner (after the person's yes), e.g. with sw_send_sms.",
  };
}

export async function clientAuthorityStatus(client: any, jobId: string): Promise<Record<string, unknown>> {
  if (!UUID.test(jobId)) throw new ClientAuthorityError(400, "job_id_invalid", "job_id must be the job's UUID.");
  const { data, error } = await client.from("job_documents")
    .select("id, file_name, pdf_url, storage_url, created_at, accepted_at, metadata")
    .eq("job_id", jobId)
    .eq("metadata->>kind", CLIENT_AUTHORITY_DOC_KIND)
    .order("created_at", { ascending: false });
  if (error) throw new ClientAuthorityError(503, "authority_read_failed", `Could not read authorities (${error.message}).`);
  return {
    success: true,
    job_id: jobId,
    authorities: (data || []).map((d: any) => ({
      document_id: d.id,
      status: d.metadata?.client_authority || "unknown",
      signer_name: d.metadata?.signer_name || null,
      signed_name: d.metadata?.signed_name || null,
      signed_at: d.metadata?.signed_at || null,
      expires_at: d.metadata?.expires_at || null,
      wording_version: d.metadata?.wording_version || null,
      pdf_url: d.pdf_url || null,
      created_at: d.created_at,
    })),
  };
}
