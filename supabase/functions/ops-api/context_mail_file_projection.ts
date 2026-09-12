// deno-lint-ignore-file no-explicit-any
const BUCKET = "context-mail-evidence";
/** Call only AFTER caller/job authorization and document visibility filtering. Never persist the returned URLs. */
export async function projectContextMailFiles(
  client: any,
  rows: any[],
  jobId: string,
): Promise<any[]> {
  const cache = new Map<string, string | null>();
  const projected = [];
  for (const row of rows) {
    const copy = { ...row };
    for (const field of ["storage_url", "pdf_url"]) {
      const pointer = row[field];
      if (typeof pointer !== "string" || !pointer.startsWith(`${BUCKET}://`)) {
        continue;
      }
      if (
        row.job_id !== jobId ||
        !new RegExp(`^${BUCKET}://sha256/[a-f0-9]{64}$`).test(pointer)
      ) {
        throw new Error("context_mail_file_scope_invalid");
      }
      if (!cache.has(pointer)) {
        try {
          const { data, error } = await client.storage.from(BUCKET)
            .createSignedUrl(pointer.slice(BUCKET.length + 3), 300);
          cache.set(pointer, error || !data?.signedUrl ? null : data.signedUrl);
        } catch {
          cache.set(pointer, null);
        }
      }
      const url = cache.get(pointer);
      if (!url) {
        copy.file_unavailable = true;
        copy.file_unavailable_reason = "private_file_sign_failed";
      }
      copy[field] = url;
    }
    projected.push(copy);
  }
  return projected;
}
