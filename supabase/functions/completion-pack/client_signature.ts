// The completion pack shows a client signature only. A drawing on a service
// report, or a job_media phase signature with no client sign-off, is not
// one. on_site is the client drawing captured on site, including when a
// crew phone was the camera. share_link is the client's own link. A revoked
// row or an office waiver shows nothing, and an older drawing is not used
// in its place: the caller passes the newest sign-off only.

export function completionPackClientSignature(input: {
  signoff: {
    method?: unknown;
    signature_media_id?: unknown;
    signed_name?: unknown;
    created_at?: unknown;
  } | null;
  mediaUrl: unknown;
}): { signature_data: string; signature_name: string; signed_at: string | null } | null {
  if (!input.signoff) return null;
  const method = String(input.signoff.method || "");
  if (method !== "on_site" && method !== "share_link") return null;
  if (!input.signoff.signature_media_id) return null;
  const url = typeof input.mediaUrl === "string" ? input.mediaUrl : "";
  if (!url) return null;
  const name = typeof input.signoff.signed_name === "string"
    ? input.signoff.signed_name
    : "";
  const signedAt = input.signoff.created_at == null
    ? null
    : String(input.signoff.created_at);
  return { signature_data: url, signature_name: name, signed_at: signedAt };
}
