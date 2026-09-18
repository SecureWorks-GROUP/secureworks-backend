// deno-lint-ignore-file no-explicit-any
import { fetchAttachment } from "../send-outlook-email/index.ts";
export async function resolveDispatchAttachments(
  requested: any[],
  documents: any[],
  media: any[],
  loader = fetchAttachment,
) {
  if (!Array.isArray(requested) || requested.length > 25) {
    throw new Error("Invalid attachments");
  }
  const seen = new Set<string>(), result = [];
  for (const requestedItem of requested) {
    const id = String(requestedItem.id || "");
    if (seen.has(id)) throw new Error("Duplicate attachment");
    seen.add(id);
    const row = [...documents, ...media].find((r: any) => r.id === id);
    if (!row) throw new Error("Attachment does not belong to this job");
    const url = row.pdf_url || row.storage_url || row.url;
    const name = row.file_name || row.name ||
      `${row.type || "document"}-${row.id}`;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("Authoritative attachment pointer unavailable");
    }
    const file = await loader(url, name);
    const bytes = Uint8Array.from(
      atob(file.contentBytes),
      (c) => c.charCodeAt(0),
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    result.push({ id, name, source_ref: url, revision: `sha256:${digest}` });
  }
  return result;
}
