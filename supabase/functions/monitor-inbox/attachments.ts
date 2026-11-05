// Which email attachments the old monitor-inbox path files onto a job.
//
// Deploy note: the Dispatch Tweak 1 change here went live with the 5 Nov
// redeploy PR (the #1319 deploy run stopped on a migration clash, #1334).
//
// It files PDFs (as job documents) and pictures (as job_media 'receipt'
// photos), up to 10 MB, and nothing else. It never files an INLINE
// attachment: those are the pictures inside the email's body, mostly
// signature logos and social icons. Before this rule, one supplier thread put
// 12 signature images on SWP-261382 as receipt photos (Shaun, 4 Nov 2026).
// Those rows are left as they are; this only stops new ones.
//
// Outlook (Microsoft Graph) marks each attachment with `isInline`. A PDF the
// sender attached is never inline, so no real document is lost.

export type GraphAttachment = {
  name?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
  size?: number | null;
  isInline?: boolean | null;
};

// Graph refuses larger attachments in this call anyway; kept as before.
export const MAX_ATTACHMENT_BYTES = 10_000_000;

/** 'pdf' or 'image' when the attachment is filed onto the job, else null
 * (no content, too big, inline in the email body, or another file type). */
export function storableAttachmentKind(
  att: GraphAttachment,
): "pdf" | "image" | null {
  if (!att.contentBytes || Number(att.size ?? 0) > MAX_ATTACHMENT_BYTES) {
    return null;
  }
  if (att.isInline === true) return null;
  const isPdf = (att.contentType || "").includes("pdf") ||
    (att.name || "").endsWith(".pdf");
  if (isPdf) return "pdf";
  if ((att.contentType || "").startsWith("image/")) return "image";
  return null;
}
